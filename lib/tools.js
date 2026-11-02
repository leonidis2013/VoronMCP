/*
 * The tools Claude sees. Reading is always on; the rest only shows up at the permission
 * level that allows it, and every one of them goes through the rules in guard.js.
 *
 *   read  (Look only)  status, CAN/MCU link health, klippy.log analysis, config files, macros,
 *                      temperatures, bed mesh, drivers, print history, console, webcam snapshot
 *   edit  (Help build) change config files (backed up, keep or revert), restart Klipper, SAVE_CONFIG
 *   hands (Hands on)   run G-code, control prints, emergency stop
 *   delete (Full)      delete files, restart services
 */
'use strict';
const crypto = require('crypto');
const Guard = require('./guard.js');
const Log = require('./klippylog.js');

class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };

// ---------- small helpers ----------
const MAX_TEXT = 60000;
function fit(obj) {
  let text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n... (cut: ' + (text.length - MAX_TEXT) + ' more characters. Ask for less, for example with a filter, a line range or a lower limit.)';
  return text;
}
const str = (v, max = 300) => (v == null ? '' : String(v)).trim().slice(0, max);
function int(v, def, min, max) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
const RO = { readOnlyHint: true, openWorldHint: false };
const LOG_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const OBJ_RE = /^[A-Za-z0-9_ .-]{1,100}$/;

async function objectList(ctx) {
  const c = ctx.cache;
  if (c.objects && Date.now() - c.objects.at < 30000) return c.objects.v;
  const r = await ctx.mr.get('/printer/objects/list');
  c.objects = { at: Date.now(), v: (r && r.objects) || [] };
  return c.objects.v;
}
async function configfile(ctx) {
  const c = ctx.cache;
  if (c.cf && Date.now() - c.cf.at < 5000) return c.cf.v;
  const st = await ctx.mr.query({ configfile: 'settings,config,save_config_pending,save_config_pending_items,warnings' });
  c.cf = { at: Date.now(), v: st.configfile || {} };
  return c.cf.v;
}
async function printState(ctx) {
  try {
    const st = await ctx.mr.query({ print_stats: 'state,filename', webhooks: 'state,state_message' });
    const ps = st.print_stats || {}, wh = st.webhooks || {};
    return { state: ps.state || '', file: ps.filename || '', printing: ['printing', 'paused'].includes(ps.state), klippy: wh.state || '', message: wh.state_message || '' };
  } catch (e) {
    // Klipper not ready: nothing is printing
    return { state: '', file: '', printing: false, klippy: 'unavailable', message: e.message };
  }
}
async function needIdle(ctx, what) {
  const p = await printState(ctx);
  if (p.printing) fail('A print is ' + p.state + ' (' + p.file + '). ' + what + ' would end it. Wait until it is done, or ask the person to cancel it first.');
  return p;
}
const mcuNames = (objs) => objs.filter((o) => o === 'mcu' || o.startsWith('mcu '));
const canNames = (objs) => objs.filter((o) => o.startsWith('canbus_stats'));

function sectionsWith(settings, test) { return Object.keys(settings || {}).filter(test); }
function lineDiff(a, b) {
  const x = String(a == null ? '' : a).split('\n'), y = String(b == null ? '' : b).split('\n');
  const sx = new Map(); x.forEach((l) => sx.set(l, (sx.get(l) || 0) + 1));
  let added = 0; const addedLines = [];
  y.forEach((l) => { const n = sx.get(l) || 0; if (n > 0) sx.set(l, n - 1); else { added++; if (addedLines.length < 20) addedLines.push(l); } });
  let removed = 0; const removedLines = [];
  for (const [l, n] of sx) { if (n > 0) { removed += n; if (removedLines.length < 20) removedLines.push(l); } }
  return { added, removed, addedLines, removedLines };
}

// ---------- link health checks ----------
function mcuNotes(name, mcu, hostVersion) {
  const notes = [];
  const s = mcu.last_stats || {};
  if (s.bytes_invalid > 0) notes.push(s.bytes_invalid + ' invalid bytes since Klipper started: corrupted frames (wiring, termination or a connector)');
  if (s.srtt > 0.01) notes.push('round trip is ' + r1(s.srtt * 1000) + ' ms (usually under 1 ms)');
  if (s.rto > 0.1) notes.push('retransmit timeout is ' + Math.round(s.rto * 1000) + ' ms (normal is 25 ms)');
  if (s.mcu_awake > 0.5) notes.push('the MCU is busy ' + Math.round(s.mcu_awake * 100) + '% of the time');
  if (hostVersion && mcu.mcu_version && mcu.mcu_version !== hostVersion) notes.push('its firmware (' + mcu.mcu_version + ') is not the same build as Klipper on the host (' + hostVersion + '). After updating Klipper, rebuild and flash this board, or Klipper may refuse to start or behave oddly');
  return notes;
}

// ---------- temperatures ----------
function tempSummary(series, nowSec) {
  const t = (series.temperatures || []).filter((v) => typeof v === 'number');
  if (!t.length) return null;
  const out = { now: r1(t[t.length - 1]), samples: t.length, min: r1(Math.min(...t)), max: r1(Math.max(...t)) };
  const targets = series.targets || [];
  const powers = series.powers || series.speeds || [];
  if (targets.length) {
    out.target = r1(targets[targets.length - 1]);
    // the steady stretch at the current target: how well does the heater hold it?
    let i = targets.length - 1;
    while (i > 0 && targets[i - 1] === targets[targets.length - 1]) i--;
    const tail = t.slice(Math.max(i + 30, t.length - 600)); // skip the first 30 s after a target change, use up to 10 min
    if (out.target > 0 && tail.length >= 30) {
      const errs = tail.map((v) => v - out.target);
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / errs.length);
      out.steady = { seconds: tail.length, avgError: r3(mean), stdDev: r3(sd), peakToPeak: r3(Math.max(...tail) - Math.min(...tail)) };
      if (out.steady.peakToPeak > 2) out.steady.note = 'swings ' + out.steady.peakToPeak + ' °C at a steady target: consider PID_CALIBRATE (or check the thermistor wiring, a fan blowing on the block, or the heater cartridge)';
      else out.steady.note = 'holding steady';
    }
  }
  if (powers.length) {
    const p = powers.slice(-120).filter((v) => typeof v === 'number');
    if (p.length) out.avgPowerLast2min = r3(p.reduce((a, b) => a + b, 0) / p.length);
    if (out.avgPowerLast2min > 0.9 && out.target > 0) out.powerNote = 'running near full power: the heater may be too weak for this target, or losing heat (missing silicone sock, strong part cooling)';
  }
  return out;
}

// ---------- bed mesh ----------
function meshStats(matrix) {
  const pts = (matrix || []).flat().filter((v) => typeof v === 'number');
  if (!pts.length) return null;
  const min = Math.min(...pts), max = Math.max(...pts), mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
  const rows = matrix.length, cols = matrix[0].length;
  const corners = { front_left: matrix[0][0], front_right: matrix[0][cols - 1], back_left: matrix[rows - 1][0], back_right: matrix[rows - 1][cols - 1] };
  const center = matrix[Math.floor(rows / 2)][Math.floor(cols / 2)];
  return { points: rows + 'x' + cols, range_mm: r3(max - min), mean_mm: r3(mean), std_dev_mm: r3(sd), center_mm: r3(center), corners_mm: Object.fromEntries(Object.entries(corners).map(([k, v]) => [k, r3(v)])) };
}

// ---------- console ----------
// The console's times come from the printer's clock, which may not match this machine's,
// so new lines are found by position: everything after the last line seen before the command.
async function consoleMark(ctx) {
  try { const r = await ctx.mr.get('/server/gcode_store', { count: 1 }); const e = ((r && r.gcode_store) || []).slice(-1)[0]; return e ? { time: e.time, message: e.message } : { none: true }; } catch (e) { return null; }
}
async function consoleSince(ctx, mark, count) {
  try {
    const r = await ctx.mr.get('/server/gcode_store', { count: count || 300 });
    let list = (r && r.gcode_store) || [];
    if (mark && !mark.none) {
      let i = -1;
      for (let j = list.length - 1; j >= 0; j--) if (list[j].time === mark.time && list[j].message === mark.message) { i = j; break; }
      list = i >= 0 ? list.slice(i + 1) : list.slice(-40);
    } else if (!mark) list = list.slice(-40);
    return list.map((e) => (e.type === 'command' ? '> ' : '') + String(e.message).slice(0, 2000));
  } catch (e) { return []; }
}

const TOOLS = [
  {
    name: 'get_overview', title: 'Printer overview', annotations: RO,
    description: 'Start here. Klipper and Moonraker state and versions, what the printer is doing (print progress, temperatures, homed axes, QGL), each MCU with its firmware version and link numbers, CAN interfaces, the Pi\'s temperature and throttling, config warnings, SAVE_CONFIG items waiting, changes waiting for the person\'s keep-or-revert, and what this connection may do.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const out = { printer: ctx.printerName ? ctx.printerName() : undefined };
      const si = await ctx.mr.get('/server/info');
      out.moonraker = { version: si.moonraker_version, klippy_state: si.klippy_state, warnings: si.warnings && si.warnings.length ? si.warnings : undefined, failed_components: si.failed_components && si.failed_components.length ? si.failed_components : undefined };
      try { const pi = await ctx.mr.get('/printer/info'); out.klipper = { state: pi.state, message: pi.state === 'ready' ? undefined : pi.state_message, version: pi.software_version, hostname: pi.hostname }; } catch (e) { out.klipper = { error: e.message }; }
      if (si.klippy_state === 'ready') {
        const objs = await objectList(ctx);
        const want = { print_stats: 'state,filename,print_duration,total_duration,filament_used,message,info', virtual_sdcard: 'progress,is_active', toolhead: 'homed_axes,max_velocity,max_accel,minimum_cruise_ratio,square_corner_velocity,position', extruder: 'temperature,target,power,pressure_advance,smooth_time', heater_bed: 'temperature,target,power', idle_timeout: 'state', configfile: 'save_config_pending,save_config_pending_items,warnings', system_stats: '', gcode_move: 'speed_factor,extrude_factor,homing_origin' };
        if (objs.includes('quad_gantry_level')) want.quad_gantry_level = 'applied';
        if (objs.includes('z_tilt')) want.z_tilt = 'applied';
        if (objs.includes('bed_mesh')) want.bed_mesh = 'profile_name';
        mcuNames(objs).forEach((m) => { want[m] = 'mcu_version,last_stats'; });
        canNames(objs).forEach((m) => { want[m] = ''; });
        const st = await ctx.mr.query(want);
        const ps = st.print_stats || {};
        out.print = { state: ps.state, file: ps.filename || undefined, progress_pct: st.virtual_sdcard ? r1((st.virtual_sdcard.progress || 0) * 100) : undefined, print_minutes: r1((ps.print_duration || 0) / 60), filament_mm: Math.round(ps.filament_used || 0), layer: ps.info && ps.info.current_layer != null ? ps.info.current_layer + '/' + ps.info.total_layer : undefined, message: ps.message || undefined, speed_factor: st.gcode_move ? r3(st.gcode_move.speed_factor) : undefined, flow_factor: st.gcode_move ? r3(st.gcode_move.extrude_factor) : undefined, z_offset: st.gcode_move && st.gcode_move.homing_origin ? r3(st.gcode_move.homing_origin[2]) : undefined };
        out.idle = st.idle_timeout ? st.idle_timeout.state : undefined;
        out.toolhead = st.toolhead ? { homed: st.toolhead.homed_axes || 'none', max_velocity: st.toolhead.max_velocity, max_accel: st.toolhead.max_accel, minimum_cruise_ratio: st.toolhead.minimum_cruise_ratio, square_corner_velocity: st.toolhead.square_corner_velocity, position: (st.toolhead.position || []).map(r3) } : undefined;
        out.temps = { hotend: st.extruder ? { now: r1(st.extruder.temperature), target: st.extruder.target, power: r3(st.extruder.power), pressure_advance: st.extruder.pressure_advance, smooth_time: st.extruder.smooth_time } : undefined, bed: st.heater_bed ? { now: r1(st.heater_bed.temperature), target: st.heater_bed.target, power: r3(st.heater_bed.power) } : undefined };
        out.leveling = { quad_gantry_level_applied: st.quad_gantry_level ? !!st.quad_gantry_level.applied : undefined, z_tilt_applied: st.z_tilt ? !!st.z_tilt.applied : undefined, bed_mesh_profile: st.bed_mesh ? st.bed_mesh.profile_name || '(none loaded)' : undefined };
        out.mcus = mcuNames(objs).map((m) => { const x = st[m] || {}, s = x.last_stats || {}; const notes = mcuNotes(m, x, out.klipper && out.klipper.version); return { name: m, firmware: x.mcu_version, bytes_retransmit: s.bytes_retransmit, bytes_invalid: s.bytes_invalid, srtt_ms: s.srtt != null ? r3(s.srtt * 1000) : undefined, rto_ms: s.rto != null ? r1(s.rto * 1000) : undefined, mcu_awake: r3(s.mcu_awake), freq_mhz: s.freq ? r1(s.freq / 1e6) : undefined, notes: notes.length ? notes : undefined }; });
        const cans = canNames(objs).map((m) => Object.assign({ name: m }, st[m]));
        if (cans.length) out.canbus_stats = cans;
        const cf = st.configfile || {};
        if (cf.save_config_pending) out.save_config_pending = Object.keys(cf.save_config_pending_items || {});
        if (cf.warnings && cf.warnings.length) out.config_warnings = cf.warnings.slice(0, 20).map((w) => w.message || w);
        out.host_load = st.system_stats;
      }
      try {
        const sys = (await ctx.mr.get('/machine/system_info')).system_info || {};
        if (sys.canbus && Object.keys(sys.canbus).length) out.can_interfaces = sys.canbus;
        out.host = { model: sys.cpu_info && (sys.cpu_info.model || sys.cpu_info.processor), os: sys.distribution && (sys.distribution.name + ' ' + (sys.distribution.version || '')).trim() };
        const ps = await ctx.mr.get('/machine/proc_stats');
        out.host.cpu_temp = r1(ps.cpu_temp);
        if (ps.throttled_state && ps.throttled_state.flags && ps.throttled_state.flags.length) out.host.throttled = ps.throttled_state.flags;
        if (ps.system_memory) out.host.memory_free_mb = Math.round((ps.system_memory.available || 0) / 1024);
      } catch (e) { /* not every host reports this */ }
      out.voronmcp = Object.assign({ access: ctx.describeAccess() }, ctx.reviewInfo ? ctx.reviewInfo() : {});
      return out;
    }
  },
  {
    name: 'get_link_health', title: 'CAN and MCU link health', annotations: RO,
    description: 'The link between the host and each MCU (main board and CAN toolhead): live retransmit and invalid byte counts, round trip and timeout, MCU load, firmware versions, canbus_stats errors and bus state, the CAN interface\'s bitrate and txqueuelen, each MCU\'s connection settings from the config, and the retransmit trend from klippy.log for this Klipper session (worst minutes, rate per hour) with plain-words verdicts. Use this first for "Timer too close", "Lost communication with MCU" or random shutdowns.',
    inputSchema: { type: 'object', properties: { sessions: { type: 'integer', default: 1, description: 'How many Klipper sessions of klippy.log to read for the trend (1 = since the last start)' } } },
    async run(args, ctx) {
      const out = {};
      const pi = await ctx.mr.get('/printer/info').catch(() => ({}));
      out.klipper = { state: pi.state, version: pi.software_version };
      if (pi.state === 'ready') {
        const objs = await objectList(ctx);
        const want = {};
        mcuNames(objs).forEach((m) => { want[m] = 'mcu_version,mcu_build_versions,last_stats'; });
        canNames(objs).forEach((m) => { want[m] = ''; });
        const st = await ctx.mr.query(want);
        out.live = mcuNames(objs).map((m) => { const x = st[m] || {}, s = x.last_stats || {}; const notes = mcuNotes(m, x, pi.software_version); return { name: m, firmware: x.mcu_version, build: x.mcu_build_versions, stats: s, notes: notes.length ? notes : ['no problems in the live numbers'] }; });
        const cans = canNames(objs).map((m) => Object.assign({ name: m }, st[m]));
        if (cans.length) out.canbus_stats = cans.map((c) => Object.assign(c, { note: (c.rx_error || c.tx_error) ? 'CAN errors counted: check termination and wiring' : c.bus_state && c.bus_state !== 'active' ? 'bus is ' + c.bus_state + ': wiring or termination' : 'clean' }));
        else out.canbus_stats = 'No canbus_stats objects (Klipper adds them for CAN MCUs in newer versions).';
        try {
          const cf = await configfile(ctx);
          out.mcu_config = Object.fromEntries(sectionsWith(cf.settings, (k) => k === 'mcu' || k.startsWith('mcu ')).map((k) => [k, cf.settings[k]]));
        } catch (e) { /* fine */ }
      }
      try {
        const sys = (await ctx.mr.get('/machine/system_info')).system_info || {};
        const can = sys.canbus || {};
        out.can_interfaces = Object.entries(can).map(([name, c]) => {
          const notes = [];
          if (c.tx_queue_len != null && c.tx_queue_len < 128) notes.push('txqueuelen is ' + c.tx_queue_len + '; Klipper recommends 128 or more (set it in /etc/network/interfaces.d/can0 or a udev rule) or messages can be dropped under load');
          if (c.bitrate && c.bitrate !== 1000000) notes.push('bitrate is ' + c.bitrate + '; 1000000 is the usual choice for a Voron toolhead (every node on the bus must match)');
          return Object.assign({ name }, c, { notes: notes.length ? notes : ['looks right'] });
        });
        if (!out.can_interfaces.length) out.can_interfaces = 'Moonraker reports no CAN interface on the host. If the toolhead uses a USB-to-CAN bridge in the main board\'s firmware (Klipper "USB to CAN bus bridge" mode), the interface may still show up as can0 once Klipper starts.';
      } catch (e) { out.can_interfaces = 'Could not read: ' + e.message; }
      try {
        const text = await ctx.mr.download('logs', 'klippy.log');
        const a = Log.analyze(text, { sessions: int(args.sessions, 1, 1, 5), context: 0, maxEvents: 20 });
        out.log_trend = a.sessions.map((s) => ({ started: s.started, busy_seconds: s.busySeconds, ended_in_shutdown: s.endedInShutdown, link: s.link || 'No Stats lines yet (Klipper logs them while it is busy)', link_events: s.events.filter((e) => ['lost_mcu', 'timeout_mcu', 'timer_too_close', 'missed_scheduling', 'timer_in_past', 'stepper_too_far_in_past', 'can_error', 'mcu_shutdown', 'shutdown', 'mcu_connect'].includes(e.kind)).map((e) => ({ kind: e.kind, at: e.at, line: e.line, text: e.text })) }));
      } catch (e) { out.log_trend = 'Could not read klippy.log: ' + e.message; }
      out.how_to_read = 'bytes_retransmit counts bytes the host had to send again; a few hundred over a long print is normal, steady growth during moves is not. bytes_invalid should stay 0. Rising srtt/rto means the host or bus answered slowly (also check the Pi\'s load, throttling and SD card). Common CAN fixes: 120 ohm termination at both ends only (60 ohm measured across CANH-CANL with power off), twisted pair CANH/CANL, txqueuelen 128+, firmly crimped connectors in the umbilical, and matching firmware on every board.';
      return out;
    }
  },
  {
    name: 'analyze_log', title: 'Analyze klippy.log', annotations: RO,
    description: 'Reads a Klipper log and returns, per Klipper session (newest first): when it started, Klipper version, every error and shutdown with the lines around it (Timer too close, Lost communication, MCU shutdown, TMC errors, heater faults, ADC out of range, homing and probe errors, config errors, internal errors), counts per kind, prints started and finished, and the MCU link numbers over the session. Use read_log to see more of the raw log around a line.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', default: 'klippy.log', description: 'A file in Moonraker\'s logs folder; list_log_files names them (rotated logs like klippy.log.2026-10-31)' },
      sessions: { type: 'integer', default: 3, description: 'Latest Klipper sessions to report (1-10)' },
      context: { type: 'integer', default: 2, description: 'Lines shown before and after each event (0-6)' }
    } },
    async run(args, ctx) {
      const file = str(args.file, 80) || 'klippy.log';
      if (!LOG_RE.test(file)) fail('Give a log file name like klippy.log');
      const text = await ctx.mr.download('logs', file);
      return Object.assign({ file, bytes: text.length }, Log.analyze(text, { sessions: int(args.sessions, 3, 1, 10), context: int(args.context, 2, 0, 6) }));
    }
  },
  {
    name: 'read_log', title: 'Read a log', annotations: RO,
    description: 'The raw lines of a log in Moonraker\'s logs folder (klippy.log, moonraker.log, crowsnest.log and rotated logs): the latest lines, or the lines matching a regular expression with lines around them. Stats lines are left out of the latest lines unless asked for. Each line starts with its line number.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', default: 'klippy.log' },
      lines: { type: 'integer', default: 150, description: 'How many lines (1-1000)' },
      match: { type: 'string', description: 'Regular expression (case-insensitive) to find lines' },
      before: { type: 'integer', default: 0 }, after: { type: 'integer', default: 0 },
      include_stats: { type: 'boolean', default: false }
    } },
    async run(args, ctx) {
      const file = str(args.file, 80) || 'klippy.log';
      if (!LOG_RE.test(file)) fail('Give a log file name like klippy.log');
      const text = await ctx.mr.download('logs', file);
      const r = Log.tail(text, { lines: int(args.lines, 150, 1, 1000), match: args.match ? str(args.match, 300) : null, before: int(args.before, 0, 0, 20), after: int(args.after, 0, 0, 20), skipStats: !args.include_stats });
      if (r.error) fail(r.error);
      return Object.assign({ file }, r);
    }
  },
  {
    name: 'list_log_files', title: 'Log files', annotations: RO,
    description: 'The files in Moonraker\'s logs folder with their size and when they last changed.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const list = (await ctx.mr.get('/server/files/list', { root: 'logs' })) || [];
      return { files: list.map((f) => ({ file: f.path || f.filename, size_kb: Math.round((f.size || 0) / 1024), modified: iso(f.modified) })).sort((a, b) => String(b.modified).localeCompare(String(a.modified))) };
    }
  },
  {
    name: 'list_config_files', title: 'Config files', annotations: RO,
    description: 'Every file in Klipper\'s config folder (printer.cfg, included files, macros, moonraker.conf, KAMP and so on) with size and last change. Protected files can be read but not changed.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const list = (await ctx.mr.get('/server/files/list', { root: 'config' })) || [];
      const prot = ctx.protectedFiles();
      return { files: list.map((f) => { const p = f.path || f.filename; return { file: p, size: f.size, modified: iso(f.modified), protected: prot.includes(p) || undefined }; }).filter((f) => !/(^|\/)\./.test(f.file)).sort((a, b) => a.file.localeCompare(b.file)) };
    }
  },
  {
    name: 'read_config_file', title: 'Read a config file', annotations: RO,
    description: 'The text of a file in the config folder, with line numbers if asked. Read a file with this before changing it with save_config_file (VoronMCP refuses to save over a file that changed since you read it).',
    inputSchema: { type: 'object', required: ['file'], properties: {
      file: { type: 'string', description: 'Path inside the config folder, for example printer.cfg or macros/print_start.cfg' },
      from_line: { type: 'integer' }, to_line: { type: 'integer' },
      line_numbers: { type: 'boolean', default: false }
    } },
    async run(args, ctx) {
      const file = str(args.file, 200).replace(/^\/+/, '');
      if (!file || file.length > 200 || file.split('/').some((x) => !x || x === '..' || x === '.') || file.includes('\\')) fail('Give a path inside the config folder, like printer.cfg');
      let text;
      try { text = await ctx.mr.download('config', file); } catch (x) { if (x.status === 404) fail('There is no ' + file + ' in the config folder. list_config_files shows what there is.'); throw x; }
      ctx.reads.set(file, sha(text));
      const lines = text.split('\n');
      const from = int(args.from_line, 1, 1, lines.length || 1), to = int(args.to_line, lines.length, from, lines.length);
      const part = lines.slice(from - 1, to);
      const body = args.line_numbers ? part.map((l, i) => String(from + i).padStart(4) + '  ' + l).join('\n') : part.join('\n');
      const { block } = Guard.splitSaveBlock(text);
      return { file, lines: lines.length, showing: from === 1 && to === lines.length ? 'all' : from + '-' + to, version: sha(text), protected: ctx.protectedFiles().includes(file) || undefined, has_save_config_block: block ? true : undefined, content: body };
    }
  },
  {
    name: 'search_config', title: 'Search the config', annotations: RO,
    description: 'Finds text or a regular expression in every config file (or the ones whose path contains "files"), with file, line number and the line. Good for "where is X defined" and "what includes what".',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, regex: { type: 'boolean', default: false }, files: { type: 'string', description: 'Only paths containing this text' }, limit: { type: 'integer', default: 100 } } },
    async run(args, ctx) {
      const pat = str(args.pattern, 300);
      if (!pat) fail('Give something to look for');
      let re;
      try { re = args.regex ? new RegExp(pat, 'i') : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { fail('Not a valid regular expression: ' + e.message); }
      const list = ((await ctx.mr.get('/server/files/list', { root: 'config' })) || []).map((f) => f.path || f.filename)
        .filter((p) => /\.(cfg|conf)$/i.test(p) && !/(^|\/)\./.test(p) && (!args.files || p.includes(str(args.files, 100))));
      const limit = int(args.limit, 100, 1, 500), hits = [];
      for (const p of list.slice(0, 200)) {
        let text; try { text = await ctx.mr.download('config', p); } catch (e) { continue; }
        text.split('\n').forEach((l, i) => { if (hits.length < limit && re.test(l)) hits.push({ file: p, line: i + 1, text: l.slice(0, 300) }); });
        if (hits.length >= limit) break;
      }
      return { pattern: pat, searched: list.length, matches: hits.length, hits };
    }
  },
  {
    name: 'get_config_settings', title: 'Effective config settings', annotations: RO,
    description: 'The settings Klipper actually loaded (after includes and SAVE_CONFIG), as parsed values with defaults filled in, for one section or every section whose name starts with the text given (for example stepper_z, extruder, tmc2209, printer, quad_gantry_level, input_shaper). Without a section: the list of sections, config warnings and SAVE_CONFIG items waiting.',
    inputSchema: { type: 'object', properties: { section: { type: 'string' }, raw: { type: 'boolean', default: false, description: 'Also the values as written in the file' } } },
    async run(args, ctx) {
      const cf = await configfile(ctx);
      const settings = cf.settings || {}, rawc = cf.config || {};
      const sec = str(args.section, 100).toLowerCase();
      const common = { save_config_pending: cf.save_config_pending ? cf.save_config_pending_items : undefined, warnings: cf.warnings && cf.warnings.length ? cf.warnings : undefined };
      if (!sec) return Object.assign({ sections: Object.keys(settings).sort() }, common);
      const keys = Object.keys(settings).filter((k) => k === sec || k.startsWith(sec));
      if (!keys.length) fail('No section starts with "' + sec + '". get_config_settings without a section lists them.');
      // macro bodies are long; get_macros shows them
      return Object.assign({ sections: Object.fromEntries(keys.map((k) => [k, args.raw ? { settings: settings[k], as_written: rawc[k] } : settings[k]])) }, common);
    }
  },
  {
    name: 'get_macros', title: 'G-code macros', annotations: RO,
    description: 'The gcode_macro sections: names with their description, or (with name) one macro\'s full G-code template and its current variables. PRINT_START, PRINT_END, CANCEL_PRINT, PAUSE and RESUME are the usual places print problems hide.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Macro name, for example PRINT_START' } } },
    async run(args, ctx) {
      const cf = await configfile(ctx);
      const s = cf.settings || {};
      const macros = Object.keys(s).filter((k) => k.startsWith('gcode_macro '));
      const name = str(args.name, 80).toLowerCase();
      if (!name) return { count: macros.length, macros: macros.map((k) => ({ name: k.slice(12).toUpperCase(), description: s[k].description || undefined, rename_existing: s[k].rename_existing || undefined })).sort((a, b) => a.name.localeCompare(b.name)) };
      const key = 'gcode_macro ' + name;
      if (!s[key]) fail('There is no macro ' + name.toUpperCase() + '. get_macros without a name lists them.');
      let vars;
      try { vars = ((await ctx.mr.query({ [key]: '' }))[key]) || undefined; } catch (e) { vars = undefined; }
      const where = await findSection(ctx, key);
      return { name: name.toUpperCase(), defined_in: where || undefined, description: s[key].description, rename_existing: s[key].rename_existing, variables: vars && Object.keys(vars).length ? vars : undefined, gcode: (cf.config && cf.config[key] && cf.config[key].gcode) || s[key].gcode };
    }
  },
  {
    name: 'query_printer_objects', title: 'Query Klipper objects', annotations: RO,
    description: 'Klipper\'s live status objects as Moonraker reports them. Without objects: the list of object names. With objects: their status, all fields or the ones named, for example { "motion_report": "live_velocity", "probe": null, "tmc2209 stepper_x": null }.',
    inputSchema: { type: 'object', properties: { objects: { description: 'Array of object names, or { name: "field,field" | null }' } } },
    async run(args, ctx) {
      if (!args.objects) return { objects: await objectList(ctx) };
      let q = args.objects;
      if (typeof q === 'string') q = [q];
      const names = Array.isArray(q) ? q : Object.keys(q);
      if (!names.length || names.length > 30) fail('Ask for 1 to 30 objects');
      if (names.some((n) => !OBJ_RE.test(String(n)))) fail('Object names look like toolhead, extruder or "tmc2209 stepper_x"');
      if (names.includes('configfile')) fail('configfile is large: use get_config_settings or read_config_file instead');
      return await ctx.mr.query(q);
    }
  },
  {
    name: 'get_temperatures', title: 'Temperatures and fans', annotations: RO,
    description: 'Every heater, temperature sensor and fan now, and from Moonraker\'s temperature store (about the last 20 minutes, once a second): min, max, and for heaters at a steady target how well they hold it (average error, standard deviation, peak to peak) and average power, with a note when a PID tune looks due or a heater is running out of power.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const objs = await objectList(ctx);
      const names = objs.filter((o) => /^(extruder\d*|heater_bed|heater_generic |temperature_sensor |temperature_fan |fan$|fan_generic |heater_fan |controller_fan )/.test(o));
      const st = names.length ? await ctx.mr.query(names) : {};
      const now = Object.fromEntries(names.map((n) => { const v = st[n] || {}; return [n, { temperature: r1(v.temperature), target: v.target, power: r3(v.power), speed: r3(v.speed), rpm: v.rpm != null ? Math.round(v.rpm) : undefined }]; }));
      let history = {};
      try {
        const store = await ctx.mr.get('/server/temperature_store', { include_monitors: 'false' });
        for (const [k, series] of Object.entries(store || {})) { const s = tempSummary(series); if (s) history[k] = s; }
      } catch (e) { history = 'Not available: ' + e.message; }
      return { now, last_20_minutes: history };
    }
  },
  {
    name: 'get_bed_mesh', title: 'Bed mesh', annotations: RO,
    description: 'The loaded bed mesh and stored profiles: range, standard deviation, center and corner heights, mesh size and area, and whether QGL is applied. With include_matrix: the probed points too.',
    inputSchema: { type: 'object', properties: { include_matrix: { type: 'boolean', default: false } } },
    async run(args, ctx) {
      const objs = await objectList(ctx);
      if (!objs.includes('bed_mesh')) fail('This printer has no [bed_mesh] section');
      const want = { bed_mesh: '' };
      if (objs.includes('quad_gantry_level')) want.quad_gantry_level = 'applied';
      const st = await ctx.mr.query(want);
      const bm = st.bed_mesh || {};
      const profiles = {};
      for (const [name, p] of Object.entries(bm.profiles || {})) profiles[name] = Object.assign({ stats: meshStats(p.points) }, args.include_matrix ? { points: p.points } : {}, { params: p.mesh_params });
      return { loaded_profile: bm.profile_name || null, mesh_min: bm.mesh_min, mesh_max: bm.mesh_max, loaded: meshStats(bm.probed_matrix), probed_matrix: args.include_matrix ? bm.probed_matrix : undefined, quad_gantry_level_applied: st.quad_gantry_level ? !!st.quad_gantry_level.applied : undefined, profiles,
        how_to_read: 'Values are mm from the probe\'s zero. On a Voron 2.4 a range under about 0.2 mm after QGL is typical for a 350 bed; a range much larger, or one corner far off, points at a warped bed, a loose bed mount, or a gantry that is not square (check the frame and gantry before blaming the bed). Meshes taken cold and hot differ: compare like with like.' };
    }
  },
  {
    name: 'get_drivers', title: 'Stepper drivers (TMC)', annotations: RO,
    description: 'Each TMC driver: run and hold current, live driver status flags (overtemperature, short to ground, open load, stall), temperature where the chip reports it, and its config section with the stepper\'s microsteps and rotation distance. Use DUMP_TMC through run_gcode (Hands on) for every register.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const objs = await objectList(ctx);
      const tmcs = objs.filter((o) => /^tmc\d+ /.test(o));
      if (!tmcs.length) return { drivers: [], note: 'No TMC drivers found' };
      const st = await ctx.mr.query(tmcs);
      const cf = await configfile(ctx).catch(() => ({ settings: {} }));
      return { drivers: tmcs.map((t) => {
        const v = st[t] || {}, stepper = t.split(' ').slice(1).join(' ');
        const drv = v.drv_status || {};
        const flags = Object.keys(drv).filter((k) => /^(ot|otpw|s2g|s2ga|s2gb|s2vs|s2vsa|s2vsb|ola|olb|uv_cp|stallguard|reset)$/.test(k) && drv[k]);
        const sc = (cf.settings || {})[stepper] || {};
        return { driver: t, run_current: v.run_current, hold_current: v.hold_current, temperature: v.temperature, status_flags: flags.length ? flags : 'none', drv_status: v.drv_status, config: (cf.settings || {})[t], microsteps: sc.microsteps, rotation_distance: sc.rotation_distance, full_steps_per_rotation: sc.full_steps_per_rotation };
      }) };
    }
  },
  {
    name: 'get_print_history', title: 'Print history', annotations: RO,
    description: 'Recent print jobs from Moonraker\'s history (file, status, start, print and total time, filament), the totals, and how many finished versus were cancelled or stopped by an error. A run of "klippy_shutdown" or "error" endings is a reliability problem worth reading the log for.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, status: { type: 'string', description: 'Only this status: completed, cancelled, error, klippy_shutdown, klippy_disconnect, interrupted' } } },
    async run(args, ctx) {
      const limit = int(args.limit, 20, 1, 200);
      const r = await ctx.mr.get('/server/history/list', { limit: Math.min(200, limit * 3), order: 'desc' });
      let jobs = (r && r.jobs) || [];
      const tally = {}; jobs.forEach((j) => { tally[j.status] = (tally[j.status] || 0) + 1; });
      if (args.status) jobs = jobs.filter((j) => j.status === str(args.status, 40));
      let totals = null;
      try { totals = (await ctx.mr.get('/server/history/totals')).job_totals; } catch (e) { /* older Moonraker */ }
      return { total_in_history: r && r.count, recent_status_counts: tally, totals: totals ? { jobs: totals.total_jobs, print_hours: r1((totals.total_print_time || 0) / 3600), filament_m: r1((totals.total_filament_used || 0) / 1000), longest_print_hours: r1((totals.longest_print || 0) / 3600) } : undefined,
        jobs: jobs.slice(0, limit).map((j) => ({ file: j.filename, status: j.status, started: iso(j.start_time), ended: iso(j.end_time), print_minutes: r1((j.print_duration || 0) / 60), total_minutes: r1((j.total_duration || 0) / 60), filament_m: r1((j.filament_used || 0) / 1000), slicer: j.metadata && j.metadata.slicer, layer_height: j.metadata && j.metadata.layer_height, exists: j.exists })) };
    }
  },
  {
    name: 'get_console', title: 'Console', annotations: RO,
    description: 'The latest lines of the G-code console (what Mainsail or Fluidd show): commands sent and Klipper\'s answers, including errors (lines starting "!!") and calibration results such as SHAPER_CALIBRATE recommendations, PROBE_ACCURACY and PID_CALIBRATE values.',
    inputSchema: { type: 'object', properties: { count: { type: 'integer', default: 60 }, errors_only: { type: 'boolean', default: false }, match: { type: 'string', description: 'Only lines containing this text' } } },
    async run(args, ctx) {
      const r = await ctx.mr.get('/server/gcode_store', { count: int(args.count, 60, 1, 1000) });
      let list = (r && r.gcode_store) || [];
      if (args.errors_only) list = list.filter((e) => /^!!|error/i.test(e.message));
      if (args.match) { const m = str(args.match, 100).toLowerCase(); list = list.filter((e) => String(e.message).toLowerCase().includes(m)); }
      return { lines: list.map((e) => ({ time: iso(e.time), type: e.type, message: String(e.message).slice(0, 3000) })) };
    }
  },
  {
    name: 'get_gcode_files', title: 'G-code files', annotations: RO,
    description: 'The newest G-code files on the printer, or (with file) one file\'s slicer metadata: slicer and version, layer height, nozzle, first layer temperatures, estimated time, filament, object height.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, limit: { type: 'integer', default: 25 } } },
    async run(args, ctx) {
      if (args.file) {
        const m = await ctx.mr.get('/server/files/metadata', { filename: str(args.file, 300) });
        delete m.thumbnails;
        return m;
      }
      const list = (await ctx.mr.get('/server/files/list', { root: 'gcodes' })) || [];
      return { count: list.length, files: list.sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, int(args.limit, 25, 1, 200)).map((f) => ({ file: f.path || f.filename, size_mb: r1((f.size || 0) / 1048576), modified: iso(f.modified) })) };
    }
  },
  {
    name: 'get_system', title: 'Host system', annotations: RO,
    description: 'The printer\'s computer: model, OS, CPU temperature, throttling (under-voltage on a Pi causes odd MCU timing problems), memory, SD card, services and their state, CAN interfaces, and which software (Klipper, Moonraker, Mainsail/Fluidd, crowsnest...) has updates waiting or local changes.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const out = {};
      const sys = (await ctx.mr.get('/machine/system_info')).system_info || {};
      out.cpu = sys.cpu_info; out.os = sys.distribution; out.sd_card = sys.sd_info && Object.keys(sys.sd_info).length ? sys.sd_info : undefined;
      out.services = sys.service_state; out.can_interfaces = sys.canbus; out.virtualization = sys.virtualization;
      try {
        const ps = await ctx.mr.get('/machine/proc_stats');
        out.cpu_temp = r1(ps.cpu_temp); out.throttled = ps.throttled_state; out.memory_kb = ps.system_memory; out.uptime_hours = r1((ps.system_uptime || 0) / 3600);
        out.cpu_usage = ps.system_cpu_usage;
        if (ps.throttled_state && ps.throttled_state.flags && ps.throttled_state.flags.some((f) => /Under-Voltage/i.test(f))) out.note = 'Under-voltage seen: use a proper 5 V supply for the Pi. It causes timing errors that look like CAN problems.';
      } catch (e) { /* fine */ }
      try {
        const u = await ctx.mr.get('/machine/update/status', { refresh: 'false' });
        out.software = Object.fromEntries(Object.entries(u.version_info || {}).map(([k, v]) => [k, k === 'system' ? { packages_to_update: v.package_count } : { version: v.version, remote_version: v.remote_version, behind: Array.isArray(v.commits_behind) ? v.commits_behind.length : undefined, dirty: v.is_dirty || undefined, valid: v.is_valid === false ? false : undefined, detached: v.detached || undefined }]));
      } catch (e) { out.software = 'Update manager not available'; }
      return out;
    }
  },
  {
    name: 'get_webcam_snapshot', title: 'Webcam snapshot', annotations: RO,
    description: 'A picture from the printer\'s webcam, to look at a print (spaghetti, layer shifts, warping, first layer) or the toolhead. Only cameras on the printer\'s own host are fetched.',
    inputSchema: { type: 'object', properties: { camera: { type: 'string', description: 'Camera name when there is more than one' } } },
    async run(args, ctx) {
      const r = await ctx.mr.get('/server/webcams/list');
      const cams = ((r && r.webcams) || []).filter((c) => c.enabled !== false && c.snapshot_url);
      if (!cams.length) fail('No webcam with a snapshot address is set up in Moonraker (Mainsail/Fluidd > Settings > Webcams).');
      const want = str(args.camera, 60).toLowerCase();
      const cam = want ? cams.find((c) => String(c.name).toLowerCase() === want) : cams[0];
      if (!cam) fail('No camera called ' + want + '. Cameras: ' + cams.map((c) => c.name).join(', '));
      const img = await ctx.mr.fetchImage(cam.snapshot_url);
      if (!/^image\//.test(img.type)) fail('The camera did not send an image (' + img.type + ')');
      return { content: [{ type: 'image', data: img.buf.toString('base64'), mimeType: img.type }, { type: 'text', text: 'Snapshot from ' + cam.name + ' at ' + new Date().toISOString() + (cams.length > 1 ? '. Other cameras: ' + cams.filter((c) => c !== cam).map((c) => c.name).join(', ') : '') }] };
    }
  },

  // ---------- Help build: change config ----------
  {
    name: 'save_config_file', title: 'Change or create a config file', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Writes a file in the config folder. Either give exact edits (each find text must appear exactly once; best for printer.cfg) or the whole new content. Read the file with read_config_file first: a file that changed since you read it is refused. The old version is backed up and the person is asked in VoronMCP to keep or revert. Changes take effect after restart_klipper. The SAVE_CONFIG block at the end of printer.cfg is left alone unless allow_save_config_block is true; protected files and new [gcode_shell_command] sections are refused.',
    inputSchema: { type: 'object', required: ['file', 'reason'], properties: {
      file: { type: 'string', description: 'Path inside the config folder' },
      edits: { type: 'array', items: { type: 'object', required: ['find', 'replace'], properties: { find: { type: 'string' }, replace: { type: 'string' } } }, description: 'Exact replacements, applied in order' },
      content: { type: 'string', description: 'The whole new file (instead of edits)' },
      create: { type: 'boolean', default: false, description: 'The file is new' },
      allow_save_config_block: { type: 'boolean', default: false },
      reason: { type: 'string', description: 'What this change is for (shown to the person)' }
    } },
    async run(args, ctx) {
      const file = str(args.file, 200).replace(/^\/+/, '');
      const pe = Guard.checkPath(file);
      if (pe) fail(pe);
      if (ctx.protectedFiles().map((x) => x.toLowerCase()).includes(file.toLowerCase())) fail('Refused: ' + file + ' is protected in VoronMCP (it can be read but not changed here). The person can unprotect it on the Permissions page, or edit it in Mainsail or Fluidd.');
      let current = null;
      try { current = await ctx.mr.download('config', file); } catch (e) { if (e.status !== 404) throw e; }
      if (args.create && current != null) fail(file + ' already exists. Read it and change it with edits instead.');
      if (!args.create && current == null) fail('There is no ' + file + '. Say create: true to make a new file.');
      if (current != null) {
        const seen = ctx.reads.get(file);
        if (!seen) fail('Read ' + file + ' with read_config_file first, so you change what is really there.');
        if (seen !== sha(current)) { ctx.reads.delete(file); fail(file + ' changed since you read it (someone edited it, or SAVE_CONFIG ran). Read it again and redo the change.'); }
      }
      let next;
      if (Array.isArray(args.edits) && args.edits.length) {
        if (current == null) fail('Edits need an existing file; give content for a new one');
        if (args.content != null) fail('Give edits or content, not both');
        if (args.edits.length > 50) fail('At most 50 edits at a time');
        next = current;
        args.edits.forEach((e, i) => {
          const find = String(e.find == null ? '' : e.find), rep = String(e.replace == null ? '' : e.replace);
          if (!find) fail('Edit ' + (i + 1) + ' has nothing to find');
          const n = next.split(find).length - 1;
          if (n === 0) fail('Edit ' + (i + 1) + ': the text to find is not in ' + file + ' (it has to match exactly, spaces included). Nothing was saved.');
          if (n > 1) fail('Edit ' + (i + 1) + ': the text to find appears ' + n + ' times in ' + file + '. Include more of the surrounding lines so it is unique. Nothing was saved.');
          next = next.replace(find, () => rep);
        });
      } else if (typeof args.content === 'string') next = args.content;
      else fail('Give edits or content');
      if (current === next) return { saved: false, note: 'Nothing changed: the file already says that.' };
      const why = Guard.checkConfigWrite(file, current, next, { protectedFiles: ctx.protectedFiles(), allowSaveBlock: !!args.allow_save_config_block });
      if (why) fail('Refused: ' + why + '.');
      let backup = null;
      if (current != null) backup = ctx.backups.save('config', file, { alias: file, content: current }, 'before-change');
      await ctx.mr.upload('config', file, next);
      const check = await ctx.mr.download('config', file);
      if (check !== next) fail('Moonraker saved the file, but reading it back gave something different. Check ' + file + ' in Mainsail or Fluidd.');
      ctx.reads.set(file, sha(next));
      ctx.cache.cf = null;
      const review = ctx.onChange ? ctx.onChange({ kind: 'config', id: file, alias: file, before: current == null ? null : { alias: file, content: current }, after: { alias: file, content: next }, backup, note: str(args.reason, 300) }) : null;
      const d = lineDiff(current, next);
      let includeNote;
      if (current == null && file !== 'printer.cfg' && /\.cfg$/.test(file)) {
        try {
          const main = await ctx.mr.download('config', 'printer.cfg');
          const inc = [...main.matchAll(/^\s*\[include\s+([^\]]+)\]/gm)].map((m) => m[1].trim());
          const covered = inc.some((p) => p === file || (p.includes('*') && new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(file)));
          if (!covered) includeNote = 'printer.cfg does not include ' + file + ' yet. Add [include ' + file + '] to printer.cfg if Klipper should load it.';
        } catch (e) { /* fine */ }
      }
      const ps = await printState(ctx);
      return { saved: true, file, created: current == null, lines_added: d.added, lines_removed: d.removed, version: sha(next), backup: backup || undefined, review: review || undefined, include: includeNote,
        next: ps.printing ? 'Klipper keeps the old settings until it restarts; a print is running, so restart after it finishes.' : 'Takes effect after restart_klipper. Then check the state it reports: a config error means fix or revert the change.' };
    }
  },
  {
    name: 'restart_klipper', title: 'Restart Klipper', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Restarts Klipper so config changes take effect (mode restart), or restarts it and the MCUs (mode firmware_restart, after an MCU shutdown or "Lost communication"). Heaters go off and the printer is no longer homed. Refused while a print is running or paused. Waits for Klipper to come back and reports its state, including any config error with the message Klipper gives.',
    inputSchema: { type: 'object', required: ['reason'], properties: { mode: { type: 'string', enum: ['restart', 'firmware_restart'], default: 'restart' }, reason: { type: 'string' } } },
    async run(args, ctx) {
      await needIdle(ctx, 'Restarting');
      const mode = args.mode === 'firmware_restart' ? 'firmware_restart' : 'restart';
      await ctx.mr.post(mode === 'restart' ? '/printer/restart' : '/printer/firmware_restart', undefined, { timeoutMs: 20000 });
      ctx.cache.objects = null; ctx.cache.cf = null;
      return await waitReady(ctx, mode);
    }
  },
  {
    name: 'save_config', title: 'SAVE_CONFIG', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Runs SAVE_CONFIG to write calibration results that are waiting (PID values, probe z_offset, input shaper, bed mesh profiles) into the SAVE_CONFIG block of printer.cfg, then Klipper restarts. printer.cfg is backed up first and the change goes through keep or revert. Refused while printing, or when nothing is waiting.',
    inputSchema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
    async run(args, ctx) {
      await needIdle(ctx, 'SAVE_CONFIG restarts Klipper, which');
      ctx.cache.cf = null;
      const cf = await configfile(ctx);
      if (!cf.save_config_pending) fail('Nothing is waiting to be saved (no calibration results since Klipper started).');
      const items = cf.save_config_pending_items;
      const before = await ctx.mr.download('config', 'printer.cfg');
      const backup = ctx.backups.save('config', 'printer.cfg', { alias: 'printer.cfg', content: before }, 'before-save-config');
      try { await ctx.mr.gcode('SAVE_CONFIG', 30000); } catch (e) { if (e.status) throw e; /* the request often ends as Klipper restarts */ }
      ctx.cache.objects = null; ctx.cache.cf = null;
      const state = await waitReady(ctx, 'restart');
      const after = await ctx.mr.download('config', 'printer.cfg');
      ctx.reads.delete('printer.cfg');
      const review = after !== before && ctx.onChange ? ctx.onChange({ kind: 'config', id: 'printer.cfg', alias: 'printer.cfg', before: { alias: 'printer.cfg', content: before }, after: { alias: 'printer.cfg', content: after }, backup, note: 'SAVE_CONFIG: ' + str(args.reason, 250) }) : null;
      return Object.assign({ saved_items: items, backup, review: review || undefined }, state);
    }
  },

  // ---------- Hands on: G-code and prints ----------
  {
    name: 'run_gcode', title: 'Run G-code', needs: 'hands',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Runs G-code on the printer (one or more lines, Klipper commands and macros included), waits up to wait_seconds for it to finish and returns the console output, including errors. This moves and heats the real printer: before homing, moving, heating or calibrating, make sure the person is at the printer and the bed is clear, and say what will happen and how long it takes. Calibrations: G28, QUAD_GANTRY_LEVEL, PROBE_ACCURACY, PID_CALIBRATE HEATER=extruder TARGET=245, SHAPER_CALIBRATE, BED_MESH_CALIBRATE, Z_ENDSTOP_CALIBRATE and the like. Blocked commands, temperatures above the limits, restarts and SAVE_CONFIG are refused (they have their own tools); while a print runs only live tuning is accepted.',
    inputSchema: { type: 'object', required: ['script'], properties: { script: { type: 'string', description: 'G-code, one command per line' }, wait_seconds: { type: 'integer', default: 120, description: 'How long to wait for it to finish (5-900). Longer commands keep running; follow them with get_console.' } } },
    async run(args, ctx) {
      const ps = await printState(ctx);
      if (ps.klippy && ps.klippy !== 'ready') fail('Klipper is ' + ps.klippy + (ps.message ? ': ' + ps.message : '') + '. Fix that first (restart_klipper).');
      const chk = Guard.checkGcode(args.script, { blocked: ctx.blocked(), limits: ctx.limits(), printing: ps.printing, printState: ps.state });
      if (chk.error) fail('Refused: ' + chk.error + '.');
      const script = chk.lines.map((l) => l.raw).join('\n');
      const mark = await consoleMark(ctx);
      const wait = int(args.wait_seconds, 120, 5, 900) * 1000;
      let error = null, done = false;
      const run = ctx.mr.gcode(script, 60 * 60e3).then(() => { done = true; }, (e) => { done = true; error = e; });
      await Promise.race([run, sleep(wait)]);
      await sleep(300);
      const output = await consoleSince(ctx, mark, 300);
      if (error) fail('Klipper answered with an error: ' + error.message + (output.length ? '\nConsole:\n' + output.join('\n') : ''));
      return { finished: done, script: chk.lines.map((l) => l.raw), console: output.length ? output : undefined,
        note: done ? undefined : 'Still running after ' + wait / 1000 + ' s. It keeps going on the printer; check get_console or get_overview for the result.' };
    }
  },
  {
    name: 'print_control', title: 'Start, pause, resume or cancel a print', needs: 'hands',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Starts a G-code file, or pauses, resumes or cancels the current print (through the printer\'s PAUSE, RESUME and CANCEL_PRINT macros). Cancelling needs confirm: true and should only happen when the person asked for it. Starting needs the bed clear and the person aware.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['start', 'pause', 'resume', 'cancel'] }, file: { type: 'string', description: 'G-code file to start' }, confirm: { type: 'boolean' } } },
    async run(args, ctx) {
      const ps = await printState(ctx);
      const a = String(args.action || '');
      if (a === 'start') {
        if (ps.klippy !== 'ready') fail('Klipper is ' + (ps.klippy || 'not ready') + (ps.message ? ': ' + ps.message : '') + '. Fix that before starting a print.');
        if (ps.printing) fail('A print is already ' + ps.state + ' (' + ps.file + ')');
        const file = str(args.file, 300);
        if (!file) fail('Name the G-code file to start (get_gcode_files lists them)');
        await ctx.mr.post('/printer/print/start', undefined, { query: { filename: file }, timeoutMs: 30000 });
        return { started: file };
      }
      if (!ps.printing) fail('Nothing is printing (state: ' + (ps.state || 'unknown') + ')');
      if (a === 'pause') { if (ps.state === 'paused') return { note: 'Already paused' }; await ctx.mr.post('/printer/print/pause', undefined, { timeoutMs: 120000 }); return { paused: ps.file }; }
      if (a === 'resume') { if (ps.state !== 'paused') fail('The print is not paused'); await ctx.mr.post('/printer/print/resume', undefined, { timeoutMs: 120000 }); return { resumed: ps.file }; }
      if (a === 'cancel') { if (args.confirm !== true) fail('Cancelling ends the print for good. Say confirm: true, and only when the person asked for it.'); await ctx.mr.post('/printer/print/cancel', undefined, { timeoutMs: 120000 }); return { cancelled: ps.file }; }
      fail('action is start, pause, resume or cancel');
    }
  },
  {
    name: 'emergency_stop', title: 'Emergency stop', needs: 'hands',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Stops the printer at once (M112): heaters and motors off, any print lost, Klipper goes to shutdown and needs restart_klipper (firmware_restart) afterwards. Only for something going wrong right now: a crash, a runaway heater, smoke, a toolhead collision.',
    inputSchema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
    async run(args, ctx) {
      await ctx.mr.post('/printer/emergency_stop', undefined, { timeoutMs: 8000 });
      return { stopped: true, next: 'Klipper is in shutdown. After the cause is fixed, use restart_klipper with mode firmware_restart.' };
    }
  },

  // ---------- Full: delete and services ----------
  {
    name: 'delete_file', title: 'Delete a file', needs: 'delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Deletes a config file (backed up first, goes through keep or revert; printer.cfg and protected files are refused) or a G-code file (not backed up; never the one printing). Ask the person first.',
    inputSchema: { type: 'object', required: ['root', 'file', 'reason'], properties: { root: { type: 'string', enum: ['config', 'gcodes'] }, file: { type: 'string' }, reason: { type: 'string' } } },
    async run(args, ctx) {
      const file = str(args.file, 300).replace(/^\/+/, '');
      if (args.root === 'gcodes') {
        if (!file || file.includes('..') || !/\.(gcode|g|gco|ufp)$/i.test(file)) fail('Give a G-code file name');
        const ps = await printState(ctx);
        if (ps.printing && ps.file === file) fail('That file is printing');
        await ctx.mr.remove('gcodes', file);
        return { deleted: file, root: 'gcodes' };
      }
      if (args.root !== 'config') fail('root is config or gcodes');
      const pe = Guard.checkPath(file);
      if (pe) fail(pe);
      if (file === 'printer.cfg') fail('printer.cfg is never deleted here');
      if (ctx.protectedFiles().includes(file)) fail(file + ' is protected');
      let current;
      try { current = await ctx.mr.download('config', file); } catch (e) { if (e.status === 404) fail('There is no ' + file); throw e; }
      const backup = ctx.backups.save('config', file, { alias: file, content: current }, 'before-delete');
      await ctx.mr.remove('config', file);
      ctx.reads.delete(file);
      const review = ctx.onChange ? ctx.onChange({ kind: 'config', id: file, alias: file, before: { alias: file, content: current }, after: null, backup, note: str(args.reason, 300) }) : null;
      return { deleted: file, root: 'config', backup, review: review || undefined, note: 'If printer.cfg includes it, Klipper will not start until the [include] is removed too.' };
    }
  },
  {
    name: 'restart_service', title: 'Restart a service', needs: 'delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Restarts a service on the printer\'s computer through Moonraker (klipper, moonraker, crowsnest, KlipperScreen, ...; get_system lists them). Refused while printing. Restarting moonraker drops VoronMCP\'s connection for a few seconds.',
    inputSchema: { type: 'object', required: ['service', 'reason'], properties: { service: { type: 'string' }, reason: { type: 'string' } } },
    async run(args, ctx) {
      await needIdle(ctx, 'Restarting a service');
      const svc = str(args.service, 60);
      const sys = (await ctx.mr.get('/machine/system_info')).system_info || {};
      const known = sys.available_services || Object.keys(sys.service_state || {});
      if (!known.includes(svc)) fail('Moonraker does not manage a service called ' + svc + '. Known: ' + known.join(', '));
      try { await ctx.mr.post('/machine/services/restart', undefined, { query: { service: svc }, timeoutMs: 30000 }); } catch (e) { if (e.status) throw e; }
      ctx.cache.objects = null; ctx.cache.cf = null;
      return { restarting: svc, next: 'Give it a few seconds, then get_overview.' };
    }
  }
];

async function waitReady(ctx, mode) {
  const t0 = Date.now();
  let si = null, last = '';
  await sleep(1500);
  while (Date.now() - t0 < 45000) {
    try { si = await ctx.mr.get('/server/info', null, { timeoutMs: 4000 }); last = si.klippy_state; } catch (e) { last = 'unreachable'; }
    if (last && !['startup', 'unreachable', 'disconnected'].includes(last)) break;
    await sleep(1500);
  }
  let info = {};
  try { info = await ctx.mr.get('/printer/info'); } catch (e) { /* fine */ }
  const out = { mode, klipper_state: info.state || last, seconds: Math.round((Date.now() - t0) / 1000) };
  if (out.klipper_state !== 'ready') {
    out.message = info.state_message || 'Klipper did not come back as ready';
    out.next = /config|option|section|pin/i.test(out.message) ? 'This is a config error. Fix the file it names (read_config_file, save_config_file) and restart again, or ask the person to revert your change in VoronMCP.' : 'Read analyze_log for the reason.';
  }
  return out;
}

/** Which file defines a section: the person usually wants to edit there, not in printer.cfg. */
async function findSection(ctx, section) {
  try {
    const list = ((await ctx.mr.get('/server/files/list', { root: 'config' })) || []).map((f) => f.path || f.filename).filter((p) => /\.cfg$/i.test(p) && !/(^|\/)\./.test(p));
    const re = new RegExp('^\\s*\\[' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+') + '\\s*\\]', 'im');
    for (const p of list.slice(0, 200)) { let t; try { t = await ctx.mr.download('config', p); } catch (e) { continue; } if (re.test(t)) return p; }
  } catch (e) { /* fine */ }
  return null;
}

const INSTRUCTIONS = [
  'VoronMCP connects you to the person\'s Klipper 3D printer (a Voron 2.4 with a CAN toolhead) for tuning, troubleshooting and improving reliability.',
  'Start with get_overview. For shutdowns, "Timer too close", "Lost communication with MCU" or anything flaky: get_link_health, then analyze_log, then read_log around the lines it names. Check get_system for under-voltage and throttling too: they look like CAN problems.',
  'For print quality: get_temperatures (PID), get_bed_mesh, get_config_settings (extruder pressure_advance, input_shaper, printer limits), get_macros (PRINT_START), get_print_history and get_webcam_snapshot to look at a print.',
  'Changing config (Help build): find where a section is defined (get_macros and search_config say which file), read the file with read_config_file, change only what is needed with save_config_file edits, then restart_klipper and check the state it reports. Never change the SAVE_CONFIG block at the end of printer.cfg unless asked; calibration values there are written by save_config.',
  'Every change is backed up. When change review is on, it goes live at once and the person is asked in VoronMCP to keep or revert it; get_overview lists changes waiting and recent reverts. If a change of yours was reverted, do not make it again: ask the person what they want instead.',
  'Hands on (run_gcode, print_control): this moves and heats a real machine. Before homing, moving, heating or calibrating, check the person is at the printer and the bed is clear, say what will happen and roughly how long it takes, and wait for their yes. While a print runs only live tuning is accepted. Blocked commands, temperature limits and protected files are enforced by VoronMCP; do not try to work around them, tell the person instead.',
  'Calibration results (SHAPER_CALIBRATE, PID_CALIBRATE, PROBE_CALIBRATE, Z_ENDSTOP_CALIBRATE, BED_MESH_CALIBRATE) are reported in the console (get_console) and kept with save_config. Explain the numbers and what they mean for this printer.',
  'Explain findings in plain words, most likely cause first, with what to check by hand (wiring, termination resistors, connectors in the umbilical, belts, the frame) when software cannot see it.'
].join(' ');

/**
 * base: { mr (Moonraker client), backups, access() -> { level, edit, hands, delete, blocked, protectedFiles, limits }, onChange(info, who), reviewInfo(), printerName() }
 */
function create(base) {
  const cache = {};
  const reads = new Map(); // file -> version last read by Claude (shared by every connection)
  const ctx = Object.assign({ cache, reads }, base);
  delete ctx.onChange; // bound per call, with who is asking
  const describe = (a) => ({ level: a.level, can_change_config_and_restart: !!a.edit, can_run_gcode_and_control_prints: !!a.hands, can_delete_and_restart_services: !!a.delete, blocked_gcode: a.blocked, protected_files: a.protectedFiles, temperature_limits_c: a.limits, from_outside: a.remote || undefined });
  const enabled = (t, access) => !t.needs || !!(access || base.access())[t.needs];

  function list(access) { return TOOLS.filter((t) => enabled(t, access)); }

  async function call(name, args, access, who) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) return { isError: true, text: 'Unknown tool ' + name };
    if (!enabled(t, access)) return { isError: true, text: name + ' is not allowed for this connection. The person can change that in VoronMCP.' };
    const a = access || base.access();
    const c = Object.assign(Object.create(ctx), {
      describeAccess: () => describe(a),
      blocked: () => a.blocked || Guard.DEFAULT_BLOCKED, limits: () => a.limits || Guard.DEFAULT_LIMITS, protectedFiles: () => a.protectedFiles || Guard.DEFAULT_PROTECTED
    }, base.onChange ? { onChange: (info) => base.onChange(info, who) } : {});
    try {
      const r = await t.run(args || {}, c);
      if (r && Array.isArray(r.content)) return { isError: false, content: r.content };
      return { isError: false, text: fit(r == null ? 'Done' : r) };
    } catch (e) {
      return { isError: true, text: e instanceof ToolError ? e.message : (e && e.message) || String(e) };
    }
  }

  function forget(file) { if (file) reads.delete(file); else reads.clear(); cache.objects = null; cache.cf = null; }

  return { list, call, all: () => TOOLS, ctx, forget, INSTRUCTIONS };
}

module.exports = { create, INSTRUCTIONS, TOOLS, fit, lineDiff, tempSummary, meshStats };
