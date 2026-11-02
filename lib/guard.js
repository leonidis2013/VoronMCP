/*
 * The safety rules between Claude and the printer. They are checked here in VoronMCP
 * before anything is sent to Moonraker, so they hold whatever Claude asks for.
 *
 * G-code:
 *  - blocked commands (FORCE_MOVE, SET_KINEMATIC_POSITION, M302, RUN_SHELL_COMMAND by
 *    default) are never sent
 *  - restarts, SAVE_CONFIG and M112 go through their own tools, which back up and check first
 *  - heater targets above your limits are refused (hotend, bed, anything else)
 *  - while a print is running or paused, only live tuning is allowed: speed and flow factor,
 *    pressure advance, velocity and accel limits, small Z offset steps, fans, temperatures
 *    within your limits, messages, excluding an object, and read-only queries
 * Config files:
 *  - only plain config files in Moonraker's config folder, no folders above it
 *  - protected files (moonraker.conf by default) can be read but not changed
 *  - no new [gcode_shell_command] sections (they run commands on the printer's computer)
 *  - the SAVE_CONFIG block at the end of printer.cfg is only changed when asked for on purpose
 */
'use strict';

const DEFAULT_BLOCKED = ['FORCE_MOVE', 'SET_KINEMATIC_POSITION', 'M302', 'RUN_SHELL_COMMAND'];
const DEFAULT_PROTECTED = ['moonraker.conf'];
const DEFAULT_LIMITS = { hotend: 300, bed: 120, other: 80 };
const CMD_RE = /^[A-Z][A-Z0-9_]{0,60}$/;
const MAX_LINES = 200;
const SAVE_MARK = '#*# <---------------------- SAVE_CONFIG ---------------------->';

// these have their own tool, so they are refused in run_gcode with a pointer to it
const OWN_TOOL = {
  M112: 'emergency_stop', FIRMWARE_RESTART: 'restart_klipper (mode firmware_restart)', RESTART: 'restart_klipper',
  SAVE_CONFIG: 'save_config (it backs up printer.cfg first)', SDCARD_PRINT_FILE: 'print_control (action start)'
};
// allowed while a print is running or paused
const LIVE_OK = new Set([
  'M220', 'M221', 'SET_PRESSURE_ADVANCE', 'SET_VELOCITY_LIMIT', 'M204', 'SET_GCODE_OFFSET', 'M106', 'M107', 'SET_FAN_SPEED',
  'M104', 'M140', 'SET_HEATER_TEMPERATURE', 'M117', 'M118', 'RESPOND', 'SET_DISPLAY_TEXT', 'SET_LED', 'SET_RETRACTION',
  'EXCLUDE_OBJECT', 'M105', 'M114', 'M115', 'STATUS', 'HELP', 'GET_POSITION', 'GET_RETRACTION', 'QUERY_ENDSTOPS', 'QUERY_FILAMENT_SENSOR',
  'DUMP_TMC', 'QUERY_ADC', 'ACCELEROMETER_QUERY', 'TEMPERATURE_WAIT', 'SET_IDLE_TIMEOUT', 'PAUSE', 'RESUME', 'M400'
]);
const MAX_Z_ADJUST = 0.1; // mm per call while printing

function cleanCommands(list) {
  const arr = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\s,]+/);
  return [...new Set(arr.map((s) => String(s).trim().toUpperCase()).filter((s) => CMD_RE.test(s)))].slice(0, 60);
}
function cleanFiles(list) {
  const arr = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\s,]+/);
  return [...new Set(arr.map((s) => String(s).trim().replace(/^\/+/, '')).filter((s) => s && checkPath(s) == null))].slice(0, 40);
}
function cleanLimits(v) {
  const o = Object.assign({}, DEFAULT_LIMITS);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const n = Number(v[k]);
      if (Number.isFinite(n) && n >= 0 && n <= 500) o[k] = Math.round(n);
    }
  }
  return o;
}

/** One G-code line -> { cmd, params (UPPER key -> string), raw } or null for an empty line. */
function parseLine(line) {
  let s = String(line).trim();
  if (!s) return null;
  // comments: ';' anywhere, '#' at the start (Klipper style)
  if (s.startsWith('#')) return null;
  const sc = s.indexOf(';');
  if (sc >= 0) s = s.slice(0, sc).trim();
  if (!s) return null;
  // line numbers (N123 G1 ...) and checksums are not used through Moonraker, but strip them anyway
  s = s.replace(/^N\d+\s+/i, '').replace(/\*\d+$/, '');
  const m = /^(\S+)\s*(.*)$/.exec(s);
  if (!m) return null;
  const cmd = m[1].toUpperCase();
  const rest = m[2];
  const params = {};
  if (/^[GMT]\d+(\.\d+)?$/.test(cmd) && !/=/.test(rest)) {
    // classic: G1 X10 Y20 F3000
    rest.split(/\s+/).filter(Boolean).forEach((t) => { params[t[0].toUpperCase()] = t.slice(1); });
  } else {
    // extended: SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200, values may be quoted
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|(\S*))/g;
    let x;
    while ((x = re.exec(rest))) params[x[1].toUpperCase()] = x[3] != null ? x[3] : x[4] != null ? x[4] : x[5];
  }
  return { cmd, params, raw: s };
}

function heaterKind(name) {
  const n = String(name || '').toLowerCase();
  if (/^extruder\d*$/.test(n)) return 'hotend';
  if (n === 'heater_bed') return 'bed';
  return 'other';
}

/** Target temperature a line asks for: { heater, kind, target } or null. */
function heaterTarget(p) {
  const { cmd, params } = p;
  if (cmd === 'M104' || cmd === 'M109') return { heater: params.T ? 'extruder' + (params.T === '0' ? '' : params.T) : 'extruder', kind: 'hotend', target: Number(params.S || 0) };
  if (cmd === 'M140' || cmd === 'M190') return { heater: 'heater_bed', kind: 'bed', target: Number(params.S || 0) };
  if (cmd === 'SET_HEATER_TEMPERATURE') return { heater: params.HEATER || '', kind: heaterKind(params.HEATER), target: Number(params.TARGET || 0) };
  if (cmd === 'PID_CALIBRATE' || cmd === 'MPC_CALIBRATE') return { heater: params.HEATER || '', kind: heaterKind(params.HEATER), target: Number(params.TARGET || 0) };
  return null;
}

/**
 * Checks a G-code script. Returns { lines: [parsed], error: null } or { error: reason }.
 * opts: { blocked: [...], limits: {...}, printing: bool, macros: Set of macro names (upper) }
 */
function checkGcode(script, opts) {
  opts = opts || {};
  const blocked = opts.blocked || DEFAULT_BLOCKED;
  const limits = opts.limits || DEFAULT_LIMITS;
  const text = String(script == null ? '' : script);
  if (!text.trim()) return { error: 'There is no G-code to run' };
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > MAX_LINES) return { error: 'At most ' + MAX_LINES + ' lines at a time' };
  const lines = [];
  for (const l of rawLines) {
    const p = parseLine(l);
    if (!p) continue;
    if (!/^[A-Z0-9_]+$/.test(p.cmd)) return { error: '"' + p.cmd.slice(0, 40) + '" does not look like a G-code command' };
    if (OWN_TOOL[p.cmd]) return { error: p.cmd + ' is not run through run_gcode. Use ' + OWN_TOOL[p.cmd] + ' instead' };
    if (blocked.includes(p.cmd)) return { error: p.cmd + ' is a blocked command in VoronMCP (it can damage the printer or bypass its safety checks). The person can run it from Mainsail or Fluidd if they really mean to' };
    const h = heaterTarget(p);
    if (h) {
      if (!Number.isFinite(h.target) || h.target < 0) return { error: p.cmd + ': the target temperature is not a number' };
      const max = limits[h.kind];
      if (h.target > max) return { error: p.cmd + ' asks for ' + h.target + ' °C on ' + (h.heater || h.kind) + ', above the ' + h.kind + ' limit of ' + max + ' °C set in VoronMCP' };
    }
    if (opts.printing) {
      if (!LIVE_OK.has(p.cmd) && !/^(GET_|QUERY_)/.test(p.cmd)) return { error: 'A print is ' + (opts.printState || 'running') + ', so only live tuning is allowed (speed and flow factor, pressure advance, limits, small Z offset steps, fans, temperatures, messages, EXCLUDE_OBJECT and queries). ' + p.cmd + ' has to wait until the print is done' };
      if (p.cmd === 'SET_GCODE_OFFSET') {
        const keys = Object.keys(p.params).filter((k) => k !== 'MOVE' && k !== 'MOVE_SPEED');
        if (keys.some((k) => k !== 'Z_ADJUST')) return { error: 'While printing, SET_GCODE_OFFSET only takes Z_ADJUST (babystepping)' };
        const v = Number(p.params.Z_ADJUST);
        if (!Number.isFinite(v) || Math.abs(v) > MAX_Z_ADJUST) return { error: 'While printing, Z_ADJUST may move at most ' + MAX_Z_ADJUST + ' mm at a time' };
      }
      if (h && h.target === 0 && h.kind !== 'other') return { error: 'Turning the ' + h.kind + ' off during a print would ruin it. Use print_control to cancel instead' };
    }
    lines.push(p);
  }
  if (!lines.length) return { error: 'There is no G-code to run (only comments)' };
  return { lines, error: null };
}

/** Moves or heats? (so Claude is reminded the person should be near the printer) */
function movesOrHeats(lines) {
  return lines.some((p) => /^(G0|G1|G2|G3|G28|G29|G32|QUAD_GANTRY_LEVEL|Z_TILT_ADJUST|BED_MESH_CALIBRATE|PROBE.*|SHAPER_CALIBRATE|TEST_RESONANCES|PID_CALIBRATE|MPC_CALIBRATE|CALIBRATE_Z|Z_ENDSTOP_CALIBRATE|MANUAL_PROBE|SCREWS_TILT_CALCULATE|M109|M190|M104|M140|SET_HEATER_TEMPERATURE)$/.test(p.cmd) || (heaterTarget(p) && heaterTarget(p).target > 0));
}

/** A path in the config folder: null when fine, otherwise the reason. */
function checkPath(p) {
  const s = String(p == null ? '' : p);
  if (!s) return 'Give a file name';
  if (s.length > 200) return 'That name is too long';
  if (s.startsWith('/') || s.includes('\\') || s.includes('\0')) return 'Use a path inside the config folder, like printer.cfg or macros/start.cfg';
  const parts = s.split('/');
  if (parts.length > 5) return 'That path is too deep';
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return 'That path is not allowed (no "..", hidden files or empty folder names)';
  if (!/^[A-Za-z0-9_. -]+$/.test(parts.join(''))) return 'Use letters, digits, dashes, dots, spaces and underscores in file names';
  if (!/\.(cfg|conf|txt|json|ini|md)$/i.test(s)) return 'Only config files can be written (.cfg, .conf, .txt, .json, .ini, .md)';
  return null;
}

const sectionNames = (text) => [...String(text || '').matchAll(/^\s*\[([^\]\n]+)\]/gm)].map((m) => m[1].trim().toLowerCase().replace(/\s+/g, ' '));
function splitSaveBlock(text) {
  const t = String(text || '');
  const i = t.indexOf(SAVE_MARK);
  return i < 0 ? { body: t, block: '' } : { body: t.slice(0, i), block: t.slice(i) };
}

/**
 * Checks a config file change. Returns null when it is fine, otherwise the reason.
 * opts: { protectedFiles, allowSaveBlock }
 */
function checkConfigWrite(file, before, after, opts) {
  opts = opts || {};
  const e = checkPath(file);
  if (e) return e;
  const prot = opts.protectedFiles || DEFAULT_PROTECTED;
  if (prot.map((x) => x.toLowerCase()).includes(String(file).toLowerCase())) return file + ' is protected in VoronMCP (it can be read but not changed here). The person can unprotect it on the Permissions page, or edit it in Mainsail or Fluidd';
  if (typeof after !== 'string') return 'There is no file content';
  if (Buffer.byteLength(after) > 1024 * 1024) return 'A config file of more than 1 MB is not written here';
  if (after.includes('\0')) return 'The content has a null character';
  const had = new Set(sectionNames(before));
  const added = sectionNames(after).filter((s) => !had.has(s));
  const shell = added.find((s) => /^gcode_shell_command\b/.test(s));
  if (shell) return 'Adding a [' + shell + '] section is not allowed here: it lets G-code run commands on the printer\'s computer. The person can add it themselves if they want it';
  if (before != null && !opts.allowSaveBlock) {
    const a = splitSaveBlock(before).block, b = splitSaveBlock(after).block;
    if (a.trim() !== b.trim()) return 'This change touches the SAVE_CONFIG block at the end of ' + file + ' (values Klipper saved from calibration: PID, probe offset, input shaper, bed mesh). Leave that block as it is, or say allow_save_config_block: true if changing it is really what the person asked for';
  }
  return null;
}

module.exports = {
  DEFAULT_BLOCKED, DEFAULT_PROTECTED, DEFAULT_LIMITS, SAVE_MARK, MAX_Z_ADJUST,
  cleanCommands, cleanFiles, cleanLimits, parseLine, checkGcode, movesOrHeats, heaterTarget, checkPath, checkConfigWrite, splitSaveBlock, sectionNames
};
