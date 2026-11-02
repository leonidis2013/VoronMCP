'use strict';
/* node test/run.js  -  no test framework needed */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const Guard = R('lib/guard'), Mcp = R('lib/mcp'), Tools = R('lib/tools'), Demo = R('lib/demo'), Backups = R('lib/backups'), Moonraker = R('lib/moonraker'), Log = R('lib/klippylog');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'vm-' + p + '-'));
const LEVEL = {
  read: { level: 'read' },
  build: { level: 'build', edit: true },
  hands: { level: 'hands', edit: true, hands: true },
  full: { level: 'full', edit: true, hands: true, delete: true }
};

function toolsAt(level, mr) {
  const a = Object.assign({ blocked: Guard.DEFAULT_BLOCKED, protectedFiles: Guard.DEFAULT_PROTECTED, limits: Guard.DEFAULT_LIMITS }, LEVEL[level]);
  mr = mr || Demo.client();
  const backups = Backups.create({ dir: tmp('bk'), keep: 3 });
  const changes = [];
  const t = Tools.create({ mr, backups, access: () => a, onChange: (info) => { changes.push(info); return 'review'; }, reviewInfo: () => ({ waiting: [] }), printerName: () => 'Test' });
  return { t, mr, backups, a, changes };
}
const parse = (r) => { assert.ok(!r.isError, r.text); return JSON.parse(r.text); };
const names = (t, level) => t.list(Object.assign({ blocked: [] }, LEVEL[level])).map((x) => x.name);

// ---------- guard ----------
test('guard: G-code parsing, blocked commands, own tools, temperature limits', () => {
  const p = Guard.parseLine('  SET_HEATER_TEMPERATURE HEATER=extruder TARGET=245 ; comment');
  assert.strictEqual(p.cmd, 'SET_HEATER_TEMPERATURE'); assert.strictEqual(p.params.HEATER, 'extruder'); assert.strictEqual(p.params.TARGET, '245');
  assert.deepStrictEqual(Guard.parseLine('G1 X10 Y20 F3000').params, { X: '10', Y: '20', F: '3000' });
  assert.strictEqual(Guard.parseLine('RESPOND MSG="hello world"').params.MSG, 'hello world');
  assert.strictEqual(Guard.parseLine('# just a comment'), null);
  const ok = Guard.checkGcode('G28\nQUAD_GANTRY_LEVEL\n; comment only\nPID_CALIBRATE HEATER=extruder TARGET=245');
  assert.ok(!ok.error && ok.lines.length === 3);
  assert.ok(/blocked/.test(Guard.checkGcode('FORCE_MOVE STEPPER=stepper_x DISTANCE=10 VELOCITY=5').error));
  assert.ok(/blocked/.test(Guard.checkGcode('g28\nset_kinematic_position z=0').error), 'lowercase too');
  assert.ok(/blocked/.test(Guard.checkGcode('RUN_SHELL_COMMAND CMD=backup').error));
  assert.ok(/restart_klipper/.test(Guard.checkGcode('FIRMWARE_RESTART').error));
  assert.ok(/save_config/.test(Guard.checkGcode('SAVE_CONFIG').error));
  assert.ok(/emergency_stop/.test(Guard.checkGcode('M112').error));
  assert.ok(/above the hotend limit/.test(Guard.checkGcode('M109 S310').error));
  assert.ok(/above the bed limit/.test(Guard.checkGcode('M140 S130').error));
  assert.ok(/above the other limit/.test(Guard.checkGcode('SET_HEATER_TEMPERATURE HEATER=chamber TARGET=90').error));
  assert.ok(/above the hotend limit/.test(Guard.checkGcode('PID_CALIBRATE HEATER=extruder TARGET=320').error));
  assert.ok(!Guard.checkGcode('M104 S280', { limits: { hotend: 280, bed: 110, other: 60 } }).error);
  assert.ok(Guard.checkGcode('M104 S281', { limits: { hotend: 280, bed: 110, other: 60 } }).error);
  assert.ok(/no G-code/.test(Guard.checkGcode('; nothing').error));
  assert.ok(/At most/.test(Guard.checkGcode(new Array(201).fill('G4 P1').join('\n')).error));
  assert.ok(!Guard.checkGcode('FORCE_MOVE STEPPER=x DISTANCE=1 VELOCITY=1', { blocked: [] }).error, 'the blocked list is the person\'s');
  assert.deepStrictEqual(Guard.cleanCommands('force_move, m302  bad-name'), ['FORCE_MOVE', 'M302']);
});

test('guard: while printing only live tuning gets through', () => {
  const P = { printing: true, printState: 'printing' };
  assert.ok(!Guard.checkGcode('SET_PRESSURE_ADVANCE ADVANCE=0.045\nM220 S90\nM221 S98\nSET_GCODE_OFFSET Z_ADJUST=-0.02 MOVE=1\nM106 S200\nM104 S250\nEXCLUDE_OBJECT NAME=part_2\nGET_POSITION', P).error);
  assert.ok(/only live tuning/.test(Guard.checkGcode('G28', P).error));
  assert.ok(/only live tuning/.test(Guard.checkGcode('G1 X10', P).error));
  assert.ok(/only live tuning/.test(Guard.checkGcode('BED_MESH_CALIBRATE', P).error));
  assert.ok(/at most 0.1 mm/.test(Guard.checkGcode('SET_GCODE_OFFSET Z_ADJUST=0.3', P).error));
  assert.ok(/only takes Z_ADJUST/.test(Guard.checkGcode('SET_GCODE_OFFSET Z=0.2', P).error));
  assert.ok(/ruin it/.test(Guard.checkGcode('M104 S0', P).error));
  assert.ok(Guard.movesOrHeats(Guard.checkGcode('G28').lines) && !Guard.movesOrHeats(Guard.checkGcode('GET_POSITION').lines));
});

test('guard: config files, protected files, shell commands, the SAVE_CONFIG block', () => {
  assert.strictEqual(Guard.checkPath('printer.cfg'), null);
  assert.strictEqual(Guard.checkPath('macros/print start.cfg'), null);
  ['../etc/passwd.cfg', '/printer.cfg', '.secret.cfg', 'a//b.cfg', 'run.sh', 'x\\y.cfg'].forEach((p) => assert.ok(Guard.checkPath(p), p));
  const base = '[printer]\nmax_accel: 10000\n\n' + Guard.SAVE_MARK + '\n#*# [probe]\n#*# z_offset = -0.5\n';
  assert.strictEqual(Guard.checkConfigWrite('printer.cfg', base, base.replace('10000', '8000')), null);
  assert.ok(/SAVE_CONFIG block/.test(Guard.checkConfigWrite('printer.cfg', base, base.replace('-0.5', '-0.6'))));
  assert.strictEqual(Guard.checkConfigWrite('printer.cfg', base, base.replace('-0.5', '-0.6'), { allowSaveBlock: true }), null);
  assert.ok(/SAVE_CONFIG block/.test(Guard.checkConfigWrite('printer.cfg', base, '[printer]\nmax_accel: 10000\n')), 'removing it counts');
  assert.ok(/protected/.test(Guard.checkConfigWrite('moonraker.conf', 'a', 'b')));
  assert.strictEqual(Guard.checkConfigWrite('moonraker.conf', 'a', 'b', { protectedFiles: [] }), null);
  assert.ok(/gcode_shell_command/.test(Guard.checkConfigWrite('x.cfg', null, '[gcode_shell_command backup]\ncommand: rm -rf ~')));
  assert.strictEqual(Guard.checkConfigWrite('x.cfg', '[gcode_shell_command a]\ncommand: ls\n', '[gcode_shell_command a]\ncommand: ls -l\n'), null, 'an existing one may be edited');
  assert.deepStrictEqual(Guard.cleanLimits({ hotend: '290', bed: 'x', other: 900 }), { hotend: 290, bed: 120, other: 80 });
});

// ---------- klippy.log ----------
test('klippy.log: sessions, events with context, link trend and verdicts', () => {
  const a = Log.analyze(Demo.makeLog(), { sessions: 5, context: 1 });
  assert.strictEqual(a.sessionsInFile, 2);
  const [latest, earlier] = a.sessions;
  assert.ok(earlier.endedInShutdown && earlier.eventCounts.timer_too_close === 1 && earlier.eventCounts.mcu_shutdown === 1);
  const mcuShut = earlier.events.find((e) => e.kind === 'mcu_shutdown');
  assert.strictEqual(mcuShut.mcu, 'EBBCan'); assert.ok(mcuShut.before.includes('Timer too close'), 'lines around it');
  assert.ok(mcuShut.at && /^2026-/.test(mcuShut.at), 'wall-clock time from Start printer line');
  const ebb = earlier.link.EBBCan;
  assert.ok(ebb.bytes_retransmit.increase > 8000 && /struggling|steady/.test(ebb.verdict), ebb.verdict);
  assert.ok(ebb.worstWindows[0].retransmitBytes > 5000 && ebb.max_rto_ms >= 160);
  assert.strictEqual(earlier.link.mcu.verdict, 'Clean');
  assert.ok(earlier.link['can:EBBCan'].tx_error === 3 && /termination/.test(earlier.link['can:EBBCan'].verdict));
  assert.ok(latest.eventCounts.tmc_error === 1 && latest.events[0].driver === 'stepper_z');
  assert.ok(latest.prints.some((p) => /Finished/.test(p.text)));
  assert.strictEqual(Log.analyze(Demo.makeLog(), { sessions: 1 }).sessions.length, 1);
  const s = Log.parseStats('Stats 12.5: gcodein=0  mcu: mcu_awake=0.003 bytes_retransmit=9 srtt=0.001 canbus_stats EBBCan: bus_state=active rx_error=0');
  assert.strictEqual(s.t, 12.5); assert.strictEqual(s.sections.mcu.bytes_retransmit, 9); assert.strictEqual(s.sections['canbus_stats EBBCan'].bus_state, 'active');
  const tl = Log.tail('a\nStats 1: x=1\nb\nTimer too close\nc\n', { match: 'timer', before: 2, after: 1 });
  assert.strictEqual(tl.text, '3: b\n4: Timer too close\n5: c', 'Stats lines left out of the context');
  assert.ok(Log.tail('x', { match: '(' }).error);
});

// ---------- MCP ----------
test('mcp: handshake, discover, tools, images, errors', async () => {
  const m = Mcp.create({ serverInfo: { name: 'voronmcp', version: '1' }, instructions: 'hi', listTools: () => [{ name: 'a', inputSchema: {} }, { name: 'img', inputSchema: {} }], callTool: async (n) => (n === 'img' ? { content: [{ type: 'image', data: 'AA==', mimeType: 'image/jpeg' }] } : { text: 'ok' }) });
  const i = await m.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(i.result.protocolVersion, '2025-06-18');
  const d = await m.handle({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} });
  assert.ok(d.result.supportedVersions.includes('2026-07-28'));
  const c = await m.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'a' } });
  assert.strictEqual(c.result.content[0].text, 'ok');
  const im = await m.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'img' } });
  assert.strictEqual(im.result.content[0].type, 'image', 'tools can return pictures');
  assert.strictEqual((await m.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
  assert.strictEqual(await m.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

// ---------- tools ----------
test('tools: each level adds its tools', () => {
  const { t } = toolsAt('read');
  const r = names(t, 'read'), b = names(t, 'build'), h = names(t, 'hands'), f = names(t, 'full');
  assert.ok(r.includes('get_overview') && r.includes('get_link_health') && r.includes('analyze_log') && r.includes('get_webcam_snapshot'));
  assert.ok(!r.includes('save_config_file') && !r.includes('run_gcode'));
  assert.ok(b.includes('save_config_file') && b.includes('restart_klipper') && b.includes('save_config') && !b.includes('run_gcode'));
  assert.ok(h.includes('run_gcode') && h.includes('print_control') && h.includes('emergency_stop') && !h.includes('delete_file'));
  assert.ok(f.includes('delete_file') && f.includes('restart_service'));
  assert.ok(t.all().every((x) => x.description && x.inputSchema && x.inputSchema.type === 'object'), 'every tool is described');
});

test('tools: overview and link health find the toolhead\'s problems', async () => {
  const { t } = toolsAt('read');
  const ov = parse(await t.call('get_overview', {}));
  assert.strictEqual(ov.klipper.state, 'ready');
  const ebb = ov.mcus.find((m) => m.name === 'mcu EBBCan');
  assert.ok(ebb.bytes_retransmit > 1000 && ebb.notes.some((n) => /not the same build/.test(n)), 'firmware mismatch noticed');
  assert.strictEqual(ov.voronmcp.access.level, 'read');
  const lh = parse(await t.call('get_link_health', {}));
  assert.ok(lh.can_interfaces[0].notes.some((n) => /txqueuelen is 10/.test(n)));
  assert.ok(lh.log_trend[0].link.EBBCan && lh.how_to_read);
  const lh2 = parse(await t.call('get_link_health', { sessions: 2 }));
  assert.ok(lh2.log_trend[1].link_events.some((e) => e.kind === 'timer_too_close'), 'the earlier shutdown');
});

test('tools: the other read tools answer from the printer', async () => {
  const { t } = toolsAt('read');
  assert.ok(parse(await t.call('analyze_log', { sessions: 2 })).sessions.length === 2);
  assert.ok(/Timer too close/.test(parse(await t.call('read_log', { match: 'shutdown:' })).text));
  assert.ok((await t.call('read_log', { file: '../etc/passwd' })).isError, 'only log names');
  assert.ok(parse(await t.call('list_config_files', {})).files.find((f) => f.file === 'moonraker.conf').protected);
  const tmps = parse(await t.call('get_temperatures', {}));
  assert.ok(/PID_CALIBRATE/.test(tmps.last_20_minutes.heater_bed.steady.note), 'a swinging bed is noticed');
  const mesh = parse(await t.call('get_bed_mesh', {}));
  assert.ok(mesh.loaded.range_mm > 0.09 && mesh.loaded.range_mm < 0.11 && !mesh.probed_matrix);
  assert.ok(parse(await t.call('get_bed_mesh', { include_matrix: true })).probed_matrix.length === 7);
  assert.ok(parse(await t.call('get_drivers', {})).drivers.length === 4);
  const hist = parse(await t.call('get_print_history', {}));
  assert.strictEqual(hist.recent_status_counts.klippy_shutdown, 2);
  assert.strictEqual(parse(await t.call('get_print_history', { status: 'completed' })).jobs.length, 2);
  const mac = parse(await t.call('get_macros', { name: 'print_start' }));
  assert.ok(mac.defined_in === 'macros.cfg' && /QUAD_GANTRY_LEVEL/.test(mac.gcode));
  assert.ok((await t.call('get_macros', { name: 'nope' })).isError);
  assert.ok(parse(await t.call('get_config_settings', { section: 'stepper_' })).sections.stepper_z);
  assert.ok(parse(await t.call('get_config_settings', {})).sections.includes('printer'));
  assert.strictEqual(parse(await t.call('search_config', { pattern: 'canbus_uuid' })).matches, 2);
  assert.ok((await t.call('search_config', { pattern: '(', regex: true })).isError);
  assert.ok(parse(await t.call('query_printer_objects', {})).objects.includes('toolhead'));
  assert.ok(parse(await t.call('query_printer_objects', { objects: { toolhead: 'homed_axes' } })).toolhead.homed_axes === '');
  assert.ok((await t.call('query_printer_objects', { objects: ['configfile'] })).isError, 'configfile is too big to dump');
  assert.ok(parse(await t.call('get_system', {})).software.klipper.behind === 14);
  assert.ok(parse(await t.call('get_gcode_files', {})).files.length === 2);
  assert.strictEqual(parse(await t.call('get_gcode_files', { file: 'Voron_Cube_ABS_0.2mm.gcode' })).slicer, 'OrcaSlicer');
  const snap = await t.call('get_webcam_snapshot', {});
  assert.ok(!snap.isError && snap.content[0].type === 'image' && snap.content[0].mimeType === 'image/jpeg');
  const con = parse(await t.call('get_console', {}));
  assert.ok(con.lines.some((l) => /Ready/.test(l.message)));
});

test('tools: config changes are read first, exact, backed up and reviewed', async () => {
  const { t, mr, backups, changes } = toolsAt('build');
  const edit = { file: 'printer.cfg', edits: [{ find: 'max_accel: 10000', replace: 'max_accel: 8000' }], reason: 'quieter' };
  assert.ok(/Read printer.cfg/.test((await t.call('save_config_file', edit)).text), 'must read first');
  const rd = parse(await t.call('read_config_file', { file: 'printer.cfg', from_line: 1, to_line: 3, line_numbers: true }));
  assert.ok(rd.has_save_config_block && /^ {3}1 {2}# Voron/.test(rd.content));
  // someone edits it in Mainsail meanwhile
  mr._files.config['printer.cfg'] += '\n# edited elsewhere\n';
  assert.ok(/changed since you read it/.test((await t.call('save_config_file', edit)).text));
  await t.call('read_config_file', { file: 'printer.cfg' });
  assert.ok(/not in printer.cfg/.test((await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel:10000', replace: 'x' }], reason: 'r' })).text));
  assert.ok(/appears \d+ times/.test((await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: 'homing_speed: 50', replace: 'homing_speed: 60' }], reason: 'r' })).text));
  const ok = parse(await t.call('save_config_file', edit));
  assert.ok(ok.saved && ok.lines_added === 1 && ok.lines_removed === 1 && ok.review === 'review' && ok.backup);
  assert.ok(/max_accel: 8000/.test(mr._files.config['printer.cfg']));
  assert.strictEqual(changes[0].before.content.includes('max_accel: 10000'), true);
  assert.ok(backups.list().some((b) => b.id === 'printer.cfg' && b.reason === 'before-change'));
  // a second edit right away works (VoronMCP knows what it wrote)
  assert.ok(parse(await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 8000', replace: 'max_accel: 9000' }], reason: 'r' })).saved);
  // refusals
  assert.ok(/SAVE_CONFIG block/.test((await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: '#*# z_offset = -0.512', replace: '#*# z_offset = -0.6' }], reason: 'r' })).text));
  assert.ok(/protected/.test((await t.call('save_config_file', { file: 'moonraker.conf', content: 'x', reason: 'r' })).text));
  assert.ok(/gcode_shell_command/.test((await t.call('save_config_file', { file: 'evil.cfg', create: true, content: '[gcode_shell_command x]\ncommand: rm -rf ~', reason: 'r' })).text));
  assert.ok(/already exists/.test((await t.call('save_config_file', { file: 'macros.cfg', create: true, content: 'x', reason: 'r' })).text));
  assert.ok(/There is no/.test((await t.call('save_config_file', { file: 'nope.cfg', content: 'x', reason: 'r' })).text));
  const made = parse(await t.call('save_config_file', { file: 'tuning/pa.cfg', create: true, content: '[gcode_macro PA_TEST]\ngcode:\n  M117 hi\n', reason: 'r' }));
  assert.ok(made.created && /does not include tuning\/pa.cfg/.test(made.include));
  assert.ok(!parse(await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 9000', replace: 'max_accel: 9000' }], reason: 'r' })).saved, 'nothing to change');
});

test('tools: restart reports config errors, SAVE_CONFIG is backed up and reviewed', async () => {
  const { t, mr, changes } = toolsAt('hands');
  await t.call('read_config_file', { file: 'printer.cfg' });
  parse(await t.call('save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_velocity: 300', replace: 'max_velocity: fast' }], reason: 'oops' }));
  const bad = parse(await t.call('restart_klipper', { reason: 'apply' }));
  assert.ok(bad.klipper_state === 'error' && /max_velocity/.test(bad.message) && /config error/.test(bad.next));
  mr._files.config['printer.cfg'] = changes[0].before.content; // as a revert would
  const good = parse(await t.call('restart_klipper', { reason: 'apply' }));
  assert.strictEqual(good.klipper_state, 'ready');
  assert.ok(/Nothing is waiting/.test((await t.call('save_config', { reason: 'r' })).text));
  parse(await t.call('run_gcode', { script: 'PID_CALIBRATE HEATER=extruder TARGET=245' }));
  const sc = parse(await t.call('save_config', { reason: 'keep PID' }));
  assert.ok(sc.saved_items.extruder && sc.klipper_state === 'ready' && sc.review === 'review');
  const rv = changes[changes.length - 1];
  assert.ok(rv.id === 'printer.cfg' && /pid_kp = 26.401/.test(rv.after.content) && !/pid_kp = 26.401/.test(rv.before.content));
});

test('tools: G-code runs with console output, and the guard holds', async () => {
  const { t } = toolsAt('hands');
  const r = parse(await t.call('run_gcode', { script: 'G28\nQUAD_GANTRY_LEVEL' }));
  assert.ok(r.finished && r.console.includes('> G28') && r.console.some((l) => /Probed points range/.test(l)));
  assert.ok(!r.console.some((l) => /Klipper state/.test(l)), 'only what this command printed');
  assert.ok(/blocked/.test((await t.call('run_gcode', { script: 'FORCE_MOVE STEPPER=stepper_z DISTANCE=-5 VELOCITY=5' })).text));
  assert.ok(/limit/.test((await t.call('run_gcode', { script: 'M190 S140' })).text));
  const e = await t.call('run_gcode', { script: 'NOT_A_MACRO' });
  assert.ok(e.isError && /Unknown command/.test(e.text) && /> NOT_A_MACRO/.test(e.text), 'Klipper\'s error and the console come back');
  // printing: live tuning only, no restarts, cancel needs confirm
  parse(await t.call('print_control', { action: 'start', file: 'Voron_Cube_ABS_0.2mm.gcode' }));
  assert.ok(/already printing/.test((await t.call('print_control', { action: 'start', file: 'Voron_Cube_ABS_0.2mm.gcode' })).text));
  assert.ok(/only live tuning/.test((await t.call('run_gcode', { script: 'G28' })).text));
  assert.ok(parse(await t.call('run_gcode', { script: 'SET_PRESSURE_ADVANCE ADVANCE=0.05\nM220 S90' })).finished);
  assert.ok(/end it/.test((await t.call('restart_klipper', { reason: 'r' })).text));
  assert.ok(/end it/.test((await t.call('save_config', { reason: 'r' })).text));
  assert.ok(parse(await t.call('print_control', { action: 'pause' })).paused);
  assert.ok(parse(await t.call('print_control', { action: 'resume' })).resumed);
  assert.ok(/confirm: true/.test((await t.call('print_control', { action: 'cancel' })).text));
  assert.ok(parse(await t.call('print_control', { action: 'cancel', confirm: true })).cancelled);
  assert.ok(parse(await t.call('emergency_stop', { reason: 'test' })).stopped);
  assert.ok(/Klipper is shutdown/.test((await t.call('run_gcode', { script: 'G28' })).text));
  assert.strictEqual(parse(await t.call('restart_klipper', { mode: 'firmware_restart', reason: 'after stop' })).klipper_state, 'ready');
});

test('tools: deleting needs Full, and never printer.cfg', async () => {
  const lo = toolsAt('hands');
  assert.ok(/not allowed/.test((await lo.t.call('delete_file', { root: 'config', file: 'macros.cfg', reason: 'r' })).text));
  const { t, mr, changes } = toolsAt('full');
  assert.ok(/never deleted/.test((await t.call('delete_file', { root: 'config', file: 'printer.cfg', reason: 'r' })).text));
  assert.ok(/protected/.test((await t.call('delete_file', { root: 'config', file: 'moonraker.conf', reason: 'r' })).text));
  const d = parse(await t.call('delete_file', { root: 'config', file: 'macros.cfg', reason: 'r' }));
  assert.ok(d.backup && !mr._files.config['macros.cfg'] && changes[0].after === null);
  assert.ok(parse(await t.call('delete_file', { root: 'gcodes', file: 'stealthburner_main_body.gcode', reason: 'r' })).deleted);
  assert.ok(/Known:/.test((await t.call('restart_service', { service: 'sshd', reason: 'r' })).text), 'only services Moonraker manages');
  assert.ok(parse(await t.call('restart_service', { service: 'crowsnest', reason: 'r' })).restarting);
});

test('tools: big answers are cut to size', () => {
  const s = Tools.fit('x'.repeat(70000));
  assert.ok(s.length < 61000 && /cut:/.test(s));
});

test('backups: file paths with folders, newest kept, read back', () => {
  const b = Backups.create({ dir: tmp('bk2'), keep: 2 });
  b.save('config', 'macros/print start.cfg', { alias: 'macros/print start.cfg', content: 'one' }, 'before-change');
  b.save('config', 'macros/print start.cfg', { alias: 'macros/print start.cfg', content: 'two' }, 'before-change');
  b.save('config', 'macros/print start.cfg', { alias: 'macros/print start.cfg', content: 'three' }, 'before-change');
  const list = b.list();
  assert.strictEqual(list.length, 2, 'pruned to two');
  assert.ok(list.every((x) => x.id === 'macros/print start.cfg'));
  assert.ok(['two', 'three'].includes(b.read('config', list[0].id, list[0].file).config.content));
  assert.strictEqual(b.read('config', 'x.cfg', '../../etc/passwd'), null);
  assert.throws(() => b.save('automation', 'x', {}, 'r'));
});

// ---------- a fake Moonraker over real HTTP, backed by the demo printer ----------
async function fakeMoonraker(opts = {}) {
  const demo = Demo.client();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
    if (opts.key && req.headers['x-api-key'] !== opts.key) return send(401, { error: { code: 401, message: 'Unauthorized' } });
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try {
      const fm = /^\/server\/files\/(config|logs|gcodes)\/(.+)$/.exec(u.pathname);
      if (fm && req.method === 'GET') { const text = await demo.download(fm[1], decodeURIComponent(fm[2])); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(text); }
      if (fm && req.method === 'DELETE') return send(200, { result: await demo.remove(fm[1], decodeURIComponent(fm[2])) });
      if (u.pathname === '/server/files/upload') {
        const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
        const file = form.get('file');
        const p = (form.get('path') ? form.get('path') + '/' : '') + file.name;
        seen.push({ upload: { root: form.get('root'), path: p } });
        return send(201, { result: await demo.upload(form.get('root'), p, await file.text()) });
      }
      const query = Object.fromEntries(u.searchParams);
      if (req.method === 'GET') return send(200, { result: await demo.get(u.pathname, query) });
      if (req.method === 'POST') return send(200, { result: await demo.post(u.pathname, body.length ? JSON.parse(body) : undefined, { query }) });
      send(405, { error: { message: 'no' } });
    } catch (e) { send(e.status || 500, { error: { code: e.status || 500, message: e.message } }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + server.address().port, demo, seen, close: () => new Promise((r) => server.close(r)) };
}

test('moonraker client: queries, files, uploads, errors, API key, webcam host', async () => {
  const f = await fakeMoonraker({ key: 'k123' });
  try {
    const mr = Moonraker.create({ getUrl: () => f.url + '/', getKey: () => 'k123' });
    const st = await mr.query({ toolhead: 'homed_axes,max_accel', extruder: null });
    assert.strictEqual(st.toolhead.max_accel, 10000); assert.ok('temperature' in st.extruder);
    assert.ok(f.seen.some((s) => /objects\/query\?toolhead=homed_axes%2Cmax_accel&extruder$/.test(s.url)), 'bare keys for whole objects');
    assert.ok(f.seen.every((s) => s.key === 'k123'));
    assert.ok(/^\[include mainsail.cfg\]/m.test(await mr.download('config', 'printer.cfg')));
    await mr.upload('config', 'macros/new one.cfg', '[gcode_macro X]\ngcode:\n  M117 x\n');
    assert.ok(f.seen.some((s) => s.upload && s.upload.root === 'config' && s.upload.path === 'macros/new one.cfg'), 'folder and name sent apart');
    assert.ok(/M117 x/.test(await mr.download('config', 'macros/new one.cfg')), 'and read back, spaces and all');
    await mr.remove('config', 'macros/new one.cfg');
    await assert.rejects(mr.download('config', 'macros/new one.cfg'), (e) => e.status === 404);
    await mr.post('/printer/print/start', undefined, { query: { filename: 'Voron_Cube_ABS_0.2mm.gcode' } });
    assert.strictEqual((await mr.query(['print_stats'])).print_stats.state, 'printing');
    await assert.rejects(mr.gcode('NOT_A_THING'), (e) => /Unknown command/.test(e.message) && e.status === 400);
    const noKey = Moonraker.create({ getUrl: () => f.url, getKey: () => '' });
    await assert.rejects(noKey.get('/server/info'), (e) => /trusted_clients/.test(e.message) && e.status === 401);
    await assert.rejects(mr.fetchImage('http://example.com/snap.jpg'), /another machine/);
    const freeP = await freePort();
    const gone = Moonraker.create({ getUrl: () => 'http://127.0.0.1:' + freeP, getKey: () => '' });
    await assert.rejects(gone.get('/server/info'), /refused the connection/);
    await assert.rejects(Moonraker.create({ getUrl: () => '' }).get('/server/info'), /not set up/);
  } finally { await f.close(); }
});

function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function req(port, method, p, body, headers) {
  if (process.env.DEBUG) console.log('  ->', method, p);
  const res = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, j, text };
}

// ---------- security ----------
const Net = R('lib/netsec'), OAuth = R('lib/oauth'), Secrets = R('lib/secrets');
const b64sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');

test('security: private addresses, client address, rate limits', () => {
  ['10.1.2.3', '192.168.1.5', '172.20.0.1', '127.0.0.1', '::1', '::ffff:192.168.0.9', '100.101.1.1', 'fd12::1', 'fe80::1'].forEach((ip) => assert.ok(Net.isPrivate(ip), ip));
  ['8.8.8.8', '172.32.0.1', '2606:4700::1', '', 'nonsense'].forEach((ip) => assert.ok(!Net.isPrivate(ip), ip));
  const req = (h, peer) => ({ headers: h, socket: { remoteAddress: peer || '172.17.0.1' } });
  assert.strictEqual(Net.clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), true), '5.6.7.8', 'the proxy-added (last) entry, not the made-up first one');
  assert.strictEqual(Net.clientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }), true), '9.9.9.9');
  assert.strictEqual(Net.clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), false), '172.17.0.1', 'ignored off the public port');
  assert.ok(Net.cameThroughProxy(req({ forwarded: 'for=1.2.3.4' })) && !Net.cameThroughProxy(req({})));
  const l = Net.limiter({ max: 3, windowMs: 60000, lockMs: 60000 });
  assert.ok(!l.hit('a') && !l.hit('a') && l.hit('a'), 'third failure locks');
  assert.ok(l.locked('a') > 0 && !l.locked('b'));
  const h = Net.inlineHashes('<style>a{}</style><script>x()</script>');
  assert.ok(/^'sha256-/.test(h.scripts[0]) && h.styles.length === 1);
});

test('security: master key moves tokens off the volume', () => {
  const d = tmp('key'), kf = path.join(d, 'secret.key');
  const a = Secrets.create(kf);
  const blob = a.enc('api-key'), check = a.makeCheck();
  assert.ok(blob.startsWith('enc1:') && fs.existsSync(kf));
  const b = Secrets.create(kf, { masterKey: 'correct horse battery staple' });
  const moved = b.migrate({ ha: blob, check });
  assert.ok(moved.ha.startsWith('enc2:') && b.dec(moved.ha) === 'api-key' && b.checkOk(moved.check));
  assert.ok(b.dropFileKey() && !fs.existsSync(kf));
  const wrong = Secrets.create(kf, { masterKey: 'wrong' });
  assert.strictEqual(wrong.dec(moved.ha), '', 'wrong master key decrypts nothing');
  assert.ok(!wrong.checkOk(moved.check), 'and the mismatch is detected');
});

function oauthWith(extra) {
  let store = {};
  const events = [];
  const o = OAuth.create(Object.assign({ load: () => store, save: (db) => { store = JSON.parse(JSON.stringify(db)); }, base: () => 'https://vm.example.com', event: (t, d) => events.push(t) }, extra || {}));
  return { o, events, store: () => store };
}
async function signIn(o, opts) {
  opts = opts || {};
  const reg = o.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const cid = reg.body.client_id, verifier = crypto.randomBytes(32).toString('base64url');
  const a = await o.authorize({ response_type: 'code', client_id: cid, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 'xyz', resource: 'https://vm.example.com/mcp' }, '203.0.113.5');
  assert.strictEqual(a.status, 200, JSON.stringify(a));
  const data = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(a.html)[1]);
  const shown = /<div class="code"[^>]*>([A-Z0-9-]+)<\/div>/.exec(a.html)[1];
  const p = o.listPending()[0];
  assert.strictEqual(p.code, shown, 'the home page shows the same code as the sign-in page');
  assert.strictEqual(o.status(data.id, data.s).body.status, 'waiting');
  assert.strictEqual(o.status(data.id, 'wrong-secret').status, 404, 'only the sign-in page can poll');
  assert.ok(o.decide(p.id, true, opts.scope || 'read', '192.168.1.5', opts.span || 'none').ok);
  const red = new URL(o.status(data.id, data.s).body.redirect);
  assert.strictEqual(red.searchParams.get('state'), 'xyz'); assert.strictEqual(red.searchParams.get('iss'), 'https://vm.example.com');
  return { cid, verifier, code: red.searchParams.get('code') };
}

test('oauth: approval at home, PKCE, one-time codes, rotation, theft detection', async () => {
  const { o, events } = oauthWith();
  assert.strictEqual(o.resourceMetadata().resource, 'https://vm.example.com/mcp');
  assert.deepStrictEqual(o.serverMetadata().code_challenge_methods_supported, ['S256']);
  // bad requests
  assert.strictEqual(o.register({ redirect_uris: ['http://evil.example/cb'] }).status, 400, 'plain http redirect refused');
  const reg = o.register({ client_name: 'x', redirect_uris: ['https://claude.ai/cb'] });
  const noPkce = await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb', state: 's' }, 'ip');
  assert.ok(noPkce.status === 302 && /error=invalid_request/.test(noPkce.location), 'PKCE required');
  const wrongRedirect = await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.ok(wrongRedirect.status === 400 && wrongRedirect.html, 'never redirects to an unregistered address');
  assert.strictEqual((await o.authorize({ response_type: 'code', client_id: 'nobody', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }, 'ip')).status, 400);
  // the happy path
  const s1 = await signIn(o, { scope: 'build' });
  const badPkce = await o.token({ grant_type: 'authorization_code', client_id: s1.cid, code: s1.code, code_verifier: 'wrong'.repeat(10), redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.strictEqual(badPkce.body.error, 'invalid_grant');
  const s2 = await signIn(o, { scope: 'build' });
  const t = await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: 'https://vm.example.com/mcp' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  const g = o.verify(t.body.access_token, '1.2.3.4');
  assert.ok(g && g.scope === 'build');
  assert.strictEqual(o.verify('hca_made_up'), null);
  // codes work once; using one twice cuts off what it made
  const again = await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier });
  assert.strictEqual(again.body.error, 'invalid_grant');
  assert.strictEqual(o.verify(t.body.access_token), null, 'reused code revoked the connection');
  // refresh rotation and reuse detection
  const s3 = await signIn(o);
  const t3 = (await o.token({ grant_type: 'authorization_code', client_id: s3.cid, code: s3.code, code_verifier: s3.verifier })).body;
  const r1 = (await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t3.refresh_token })).body;
  assert.ok(r1.access_token && r1.refresh_token !== t3.refresh_token, 'refresh token rotates');
  assert.ok(o.verify(r1.access_token));
  const stolen = await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t3.refresh_token });
  assert.strictEqual(stolen.body.error, 'invalid_grant');
  assert.strictEqual(o.verify(r1.access_token), null, 'old refresh token used again: whole connection revoked');
  assert.ok(events.includes('connection-revoked'));
  // another client cannot use someone else's refresh token
  const s4 = await signIn(o);
  const t4 = (await o.token({ grant_type: 'authorization_code', client_id: s4.cid, code: s4.code, code_verifier: s4.verifier })).body;
  assert.strictEqual((await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t4.refresh_token })).body.error, 'invalid_grant');
  // revoke from home
  const c = o.connections().find((x) => x.scope === 'read');
  assert.ok(o.revokeGrant(c.id) && !o.verify(t4.access_token));
  // tokens are stored only as hashes
  assert.ok(!JSON.stringify(oauthWith().store()).includes('hca_'));
});

test('oauth: access time ends a connection, and can be extended', async () => {
  const { o, events } = oauthWith();
  const s1 = await signIn(o, { span: '1h' });
  const t = (await o.token({ grant_type: 'authorization_code', client_id: s1.cid, code: s1.code, code_verifier: s1.verifier })).body;
  const c = o.connections()[0];
  assert.ok(c.expiresAt > Date.now() + 3590e3 && c.expiresAt <= Date.now() + 3600e3, 'one hour');
  assert.ok(t.expires_in <= 3600);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 3600e3; // two hours later
    assert.strictEqual(o.verify(t.access_token), null, 'no longer works');
    assert.strictEqual((await o.token({ grant_type: 'refresh_token', client_id: s1.cid, refresh_token: t.refresh_token })).body.error, 'invalid_grant', 'cannot refresh past it either');
  } finally { Date.now = realNow; }
  assert.ok(events.includes('connection-revoked'));
  // extending
  const s2 = await signIn(o, { span: '1h' });
  const t2 = (await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier })).body;
  const g2 = o.connections().find((x) => x.expiresAt);
  assert.ok(o.setSpan(g2.id, 'none') && o.connections().find((x) => x.id === g2.id).expiresAt === null);
  try { Date.now = () => realNow() + 2 * 3600e3; assert.ok((await o.token({ grant_type: 'refresh_token', client_id: s2.cid, refresh_token: t2.refresh_token })).body.access_token, 'extended connection refreshes'); } finally { Date.now = realNow; }
  // an unknown access time is refused
  const reg = o.register({ client_name: 'x', redirect_uris: ['https://claude.ai/cb'] });
  await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: 'f'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.ok(!o.decide(o.listPending()[0].id, true, 'read', 'ip', '99y').ok);
});

test('oauth: client metadata documents (how claude.ai identifies itself)', async () => {
  const doc = { client_id: 'https://claude.ai/oauth/claude-client', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };
  const { o } = oauthWith({ fetchDoc: async (u) => (u === doc.client_id ? doc : { client_id: 'https://other.example/x', redirect_uris: ['https://x/cb'] }) });
  const c = await o.resolveClient(doc.client_id);
  assert.ok(c && c.name === 'Claude' && c.kind === 'metadata');
  assert.strictEqual(await o.resolveClient('https://evil.example/claimed'), null, 'document must name itself');
  assert.strictEqual(await o.resolveClient('http://claude.ai/x'), null, 'https only');
  const a = await o.authorize({ response_type: 'code', client_id: doc.client_id, redirect_uri: doc.redirect_uris[0], code_challenge: 'b'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.strictEqual(a.status, 200);
  assert.ok(OAuth.redirectMatches('http://localhost/cb', 'http://localhost:4567/cb'), 'loopback port may change');
  assert.ok(!OAuth.redirectMatches('https://a.example/cb', 'https://a.example/cb2'));
});

test('server: exposed mode keeps the settings page private and the public port narrow', async () => {
  const port = await freePort(), pub = await freePort(), dir = tmp('exp');
  // an exposed install as it would be saved (PIN 2468, public address set)
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ controlPinHash: 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync('2468', salt, 32).toString('hex'), publicUrl: 'https://vm.example.com', security: { mode: 'exposed' }, setup: { completed: true, marks: {} } }));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json'), VORONMCP_NO_UPDATE_CHECK: '1' });
  delete env.VORONMCP_TEST_INSECURE_PUBLIC;
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'vm.example.com' }, extra || {});
  try {
    for (let i = 0; i < 50 && !/Public port/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    // the private port refuses anything that came through a proxy
    assert.strictEqual((await req(port, 'GET', '/', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/api/state')).status, 200, 'still fine from this network');
    const page = await fetch('http://127.0.0.1:' + port + '/');
    assert.ok(/script-src 'sha256-/.test(page.headers.get('content-security-policy')) && !/unsafe-inline'[^;]*script/.test(page.headers.get('content-security-policy')), 'strict CSP on the page');
    // the public port: nothing of the settings page, https and the right host only
    assert.strictEqual((await req(pub, 'GET', '/', undefined, H())).status, 404);
    assert.strictEqual((await req(pub, 'GET', '/api/state', undefined, H())).status, 404);
    assert.strictEqual((await req(pub, 'POST', '/api/access', { enabled: true }, H())).status, 404);
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-proto': 'http' }))).status, 403, 'https only');
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-host': 'evil.example' }))).status, 421, 'right host only');
    const prm = await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H());
    assert.strictEqual(prm.j.resource, 'https://vm.example.com/mcp');
    const r401 = await fetch('http://127.0.0.1:' + pub + '/mcp', { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: '{}' });
    assert.strictEqual(r401.status, 401);
    assert.ok(/resource_metadata="https:\/\/vm\.example\.com\/\.well-known\/oauth-protected-resource"/.test(r401.headers.get('www-authenticate')));
    assert.ok(r401.headers.get('strict-transport-security'));
    // the plain access token does not work from outside unless allowed
    const tok = (await req(port, 'POST', '/api/token', {}, { 'x-pin': '2468' })).j.token;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    assert.strictEqual((await req(pub, 'POST', '/mcp', init, H({ authorization: 'Bearer ' + tok }))).status, 401);
    assert.strictEqual((await req(pub, 'POST', '/mcp/' + tok, init, H())).status, 404, 'no token-in-the-address on the public port');
    // wrong tokens get an address locked out
    for (let i = 0; i < 10; i++) await req(pub, 'POST', '/mcp', init, H({ 'x-forwarded-for': '198.51.100.7', authorization: 'Bearer hca_guess' + i }));
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-for': '198.51.100.7' }))).status, 429);
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-for': '198.51.100.8' }))).status, 200, 'others unaffected');
    // PIN guessing locks out too
    for (let i = 0; i < 5; i++) await req(port, 'POST', '/api/access', { enabled: true }, { 'x-pin': '000' + i });
    assert.strictEqual((await req(port, 'POST', '/api/access', { enabled: true }, { 'x-pin': '2468' })).status, 429, 'locked even with the right PIN');
    // events recorded, local mode switches the public port off
    const st = (await req(port, 'GET', '/api/state')).j.security;
    assert.ok(st.events.some((e) => e.type === 'address-locked') && st.events.some((e) => e.type === 'pin-lockout') && st.events.some((e) => e.type === 'admin-refused'));
  } finally { proc.kill(); }
});

const Totp = R('lib/totp'), QR = R('lib/qr');
test('authenticator codes: RFC 6238 values, clock drift, no replay; QR codes', () => {
  const key = Buffer.from('12345678901234567890');
  [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']].forEach(([t, w]) => assert.strictEqual(Totp.hotp(key, Math.floor(t / 30), 8), w));
  const sec = Totp.base32Encode(key), now = 1793000000000, c = Totp.counterAt(now);
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c), null, now), c);
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c - 1), null, now), c - 1, 'previous 30 s still accepted');
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c - 2), null, now), null, 'older is not');
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c), c, now), null, 'a used code never works again');
  assert.strictEqual(Totp.verify(sec, 'abcdef', null, now), null);
  assert.ok(/^otpauth:\/\/totp\/VoronMCP:x\?secret=[A-Z2-7]+&issuer=VoronMCP/.test(Totp.uri(Totp.newSecret(), 'x', 'VoronMCP')));
  const q = QR.encode(Totp.uri(Totp.newSecret(), 'voronmcp.example.com', 'VoronMCP'));
  assert.ok(q.size === q.version * 4 + 17 && q.modules[0][0] && q.modules[0][6] && !q.modules[1][1], 'finder pattern in the corner');
  assert.ok(/^<svg[\s\S]*<\/svg>$/.test(QR.svg('hello')));
});

test('server: approving with an authenticator code from outside', async () => {
  const port = await freePort(), pub = await freePort(), dir = tmp('totp');
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ controlPinHash: 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync('2468', salt, 32).toString('hex'), publicUrl: 'https://vm.example.com', security: { mode: 'exposed' }, setup: { completed: true, marks: {} } }));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json'), VORONMCP_NO_UPDATE_CHECK: '1' });
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20', 'x-forwarded-host': 'vm.example.com' }, extra || {});
  const PIN = { 'x-pin': '2468' };
  const codeFor = (secret, offset) => Totp.hotp(Totp.base32Decode(secret.replace(/\s/g, '')), Totp.counterAt(Date.now()) + (offset || 0));
  async function newRequest(ip) {
    const reg = (await req(pub, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, H({ 'x-forwarded-for': ip }))).j;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 's' });
    const page = (await req(pub, 'GET', '/oauth/authorize?' + q, undefined, H({ 'x-forwarded-for': ip }))).text;
    const d = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(page)[1]);
    return { d, page, cid: reg.client_id, verifier };
  }
  try {
    for (let i = 0; i < 50 && !/Public port/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    // not set up: no code box, and the endpoint refuses
    const r0 = await newRequest('203.0.113.20');
    assert.ok(!r0.d.totp && !/id="c"/.test(r0.page));
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r0.d.id, s: r0.d.s, code: '123456', scope: 'read' }, H())).status, 403);
    // set up at home: needs the PIN, then a code from the app to switch on
    assert.strictEqual((await req(port, 'POST', '/api/totp', { action: 'setup' })).status, 401);
    const setup = (await req(port, 'POST', '/api/totp', { action: 'setup' }, PIN)).j;
    assert.ok(setup.ok && /<svg/.test(setup.svg) && /^otpauth:\/\/totp\//.test(setup.uri));
    assert.ok(!(await req(port, 'POST', '/api/totp', { action: 'confirm', code: '000000' }, PIN)).j.ok);
    assert.ok((await req(port, 'POST', '/api/totp', { action: 'confirm', code: codeFor(setup.secret) }, PIN)).j.ok);
    assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes(setup.secret.replace(/\s/g, '')), 'the secret is stored encrypted');
    // now the sign-in page has the code box; approve with a code, then sign in
    const r1 = await newRequest('203.0.113.21');
    assert.ok(r1.d.totp && /id="c"/.test(r1.page));
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r1.d.id, s: r1.d.s, code: codeFor(setup.secret, 1), scope: 'hands' }, H())).status, 400, 'above the code limit (Help build)');
    const ok = await req(pub, 'POST', '/oauth/approve', { id: r1.d.id, s: r1.d.s, code: codeFor(setup.secret, 1), scope: 'build' }, H());
    assert.ok(ok.j.ok, JSON.stringify(ok.j));
    const st = (await req(pub, 'GET', '/oauth/status?id=' + r1.d.id + '&s=' + r1.d.s, undefined, H())).j;
    assert.strictEqual(st.status, 'approved');
    const code = new URL(st.redirect).searchParams.get('code');
    const tok = await req(pub, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: r1.cid, code, code_verifier: r1.verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }, H());
    assert.ok(tok.j.access_token);
    // the same code cannot approve a second request
    const r2 = await newRequest('203.0.113.22');
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r2.d.id, s: r2.d.s, code: codeFor(setup.secret, 1), scope: 'read' }, H())).status, 401, 'replay refused');
    // five wrong codes cancel a request, and pause code approvals for the hour
    for (let i = 0; i < 4; i++) await req(pub, 'POST', '/oauth/approve', { id: r2.d.id, s: r2.d.s, code: '00000' + i, scope: 'read' }, H({ 'x-forwarded-for': '198.51.100.' + (30 + i) }));
    assert.ok((await req(pub, 'GET', '/oauth/status?id=' + r2.d.id + '&s=' + r2.d.s, undefined, H())).j.status === 'denied', 'request cancelled');
    const r3 = await newRequest('203.0.113.23');
    const paused = await req(pub, 'POST', '/oauth/approve', { id: r3.d.id, s: r3.d.s, code: codeFor(setup.secret), scope: 'read' }, H({ 'x-forwarded-for': '198.51.100.50' }));
    assert.strictEqual(paused.status, 429, 'paused for the hour, even with the right code');
    const sec = (await req(port, 'GET', '/api/state')).j.security;
    assert.ok(sec.totp.enabled && sec.totp.paused && sec.events.some((e) => e.type === 'codes-paused') && sec.events.some((e) => e.via === 'authenticator code'));
    // approving at home still works while paused
    const pend = sec.pending.find((p) => p.ip === '203.0.113.23');
    assert.ok((await req(port, 'POST', '/api/connections/decide', { id: pend.id, approve: true, scope: 'read' }, PIN)).j.ok);
  } finally { proc.kill(); }
});

async function startServer(name, saved, extraEnv) {
  const port = await freePort(), pub = await freePort(), dir = tmp(name);
  if (saved) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(saved));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json'), VORONMCP_NO_UPDATE_CHECK: '1' }, extraEnv || {});
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !/VoronMCP v/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  return { port, pub, dir, proc, log: () => log };
}
async function mcpCall(port, auth, name, args) {
  const r = await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, auth);
  assert.ok(r.j && r.j.result, JSON.stringify(r.j));
  const text = r.j.result.content[0].text;
  if (r.j.result.isError) return { error: text };
  try { return JSON.parse(text); } catch (e) { return { text }; }
}

test('server: a real printer connection, keep or revert, restore from a backup', async () => {
  const f = await fakeMoonraker({ key: 'secret-key-1' });
  const S = await startServer('rev', null, { VORONMCP_REVIEW_TICK_MS: '200' });
  const { port } = S;
  try {
    assert.ok((await req(port, 'POST', '/api/printer', { url: 'not a url' })).status === 400);
    assert.ok((await req(port, 'POST', '/api/printer', { url: f.url, apiKey: 'secret-key-1', name: 'My Voron' })).j.ok);
    assert.ok(!fs.readFileSync(path.join(S.dir, 'config.json'), 'utf8').includes('secret-key-1'), 'the API key is stored encrypted');
    assert.ok((await req(port, 'POST', '/api/printer-test', {})).j.ok);
    let st = (await req(port, 'GET', '/api/state')).j;
    assert.ok(st.printer.status.ok && st.printer.status.klippy === 'ready' && st.printer.hasKey && st.printer.name === 'My Voron');
    assert.ok(st.printer.status.temps.hotend.length === 2 && st.printer.status.print.state === 'standby');
    assert.strictEqual(st.access.level, 'read', 'starts at Look only');
    const tok = (await req(port, 'POST', '/api/token', {})).j.token, auth = { authorization: 'Bearer ' + tok };
    assert.ok(/not allowed|Unknown tool/.test(JSON.stringify((await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_config_file', arguments: {} } }, auth)).j)));
    assert.ok((await req(port, 'POST', '/api/access', { local: 'full' })).j.ok);
    // change printer.cfg twice: one review, Revert goes back to the original
    const original = f.demo._files.config['printer.cfg'];
    await mcpCall(port, auth, 'read_config_file', { file: 'printer.cfg' });
    const r1 = await mcpCall(port, auth, 'save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 10000', replace: 'max_accel: 8000' }], reason: 'test' });
    assert.ok(/keep or revert/.test(r1.review), 'Claude is told about the review');
    await mcpCall(port, auth, 'save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 8000', replace: 'max_accel: 7000' }], reason: 'test' });
    st = (await req(port, 'GET', '/api/state')).j;
    const w = st.reviews.filter((x) => x.status === 'waiting');
    assert.ok(w.length === 1 && w[0].changes === 2 && w[0].action === 'changed' && w[0].id === 'printer.cfg');
    assert.ok(w[0].before.content === original && /max_accel: 7000/.test(w[0].after.content) && w[0].note === 'test');
    const rev = (await req(port, 'POST', '/api/review', { rid: w[0].rid, keep: false })).j;
    assert.ok(rev.ok && /Restart Klipper/.test(rev.note));
    assert.strictEqual(f.demo._files.config['printer.cfg'], original, 'reverted to the original');
    assert.ok(!(await req(port, 'POST', '/api/review', { rid: w[0].rid, keep: true })).j.ok, 'answered once only');
    const ov = await mcpCall(port, auth, 'get_overview', {});
    assert.strictEqual(ov.voronmcp.recently_reverted[0].file, 'printer.cfg', 'Claude sees the revert');
    // after a revert Claude has to read again
    assert.ok(/Read printer.cfg/.test((await mcpCall(port, auth, 'save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 10000', replace: 'max_accel: 9000' }], reason: 't' })).error));
    // created, then reverted: gone again
    await mcpCall(port, auth, 'save_config_file', { file: 'extra.cfg', create: true, content: '# new\n', reason: 'new' });
    const ci = (await req(port, 'GET', '/api/state')).j.reviews.find((x) => x.status === 'waiting' && x.id === 'extra.cfg');
    assert.strictEqual(ci.action, 'created');
    assert.ok((await req(port, 'POST', '/api/review', { rid: ci.rid, keep: false })).j.ok);
    assert.ok(!('extra.cfg' in f.demo._files.config));
    // deleted, then reverted: back again
    await mcpCall(port, auth, 'delete_file', { root: 'config', file: 'macros.cfg', reason: 'test' });
    const di = (await req(port, 'GET', '/api/state')).j.reviews.find((x) => x.status === 'waiting' && x.id === 'macros.cfg');
    assert.ok((await req(port, 'POST', '/api/review', { rid: di.rid, keep: false })).j.ok);
    assert.ok(/PRINT_START/.test(f.demo._files.config['macros.cfg']));
    // keep
    await mcpCall(port, auth, 'read_config_file', { file: 'printer.cfg' });
    await mcpCall(port, auth, 'save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 10000', replace: 'max_accel: 9500' }], reason: 'keep me' });
    const ki = (await req(port, 'GET', '/api/state')).j.reviews.find((x) => x.status === 'waiting');
    assert.ok((await req(port, 'POST', '/api/review', { rid: ki.rid, keep: true })).j.ok);
    assert.ok(/max_accel: 9500/.test(f.demo._files.config['printer.cfg']));
    // the backups page lists and restores
    const bks = (await req(port, 'GET', '/api/backups')).j.backups;
    const first = bks.filter((b) => b.id === 'printer.cfg').pop();
    assert.ok(first && first.reason === 'before-change');
    const dl = await fetch('http://127.0.0.1:' + port + '/api/backup?kind=config&id=printer.cfg&file=' + first.file);
    assert.ok(dl.ok && /max_accel: 10000/.test(await dl.text()), 'download gives the file itself');
    assert.ok((await req(port, 'POST', '/api/restore', { kind: 'config', id: 'printer.cfg', file: first.file })).j.ok);
    assert.ok(/max_accel: 10000/.test(f.demo._files.config['printer.cfg']));
    // no answer in time: decided for you
    assert.ok((await req(port, 'POST', '/api/review', { timeoutMin: 15, ifNoAnswer: 'revert' })).j.ok);
    assert.ok(!(await req(port, 'POST', '/api/review', { timeoutMin: 7 })).j.ok, 'only the offered times');
  } finally { S.proc.kill(); await f.close(); }
});

test('server: an unanswered change is reverted when its time runs out', async () => {
  const f = await fakeMoonraker();
  const S = await startServer('auto', { printer: { url: '' }, access: { local: 'build' }, review: { enabled: true, timeoutMin: 15, ifNoAnswer: 'revert' } }, { VORONMCP_REVIEW_TICK_MS: '150' });
  try {
    await req(S.port, 'POST', '/api/printer', { url: f.url });
    const auth = { authorization: 'Bearer ' + (await req(S.port, 'POST', '/api/token', {})).j.token };
    const original = f.demo._files.config['printer.cfg'];
    await mcpCall(S.port, auth, 'read_config_file', { file: 'printer.cfg' });
    const r = await mcpCall(S.port, auth, 'save_config_file', { file: 'printer.cfg', edits: [{ find: 'max_accel: 10000', replace: 'max_accel: 1' }], reason: 't' });
    assert.ok(/within 15 minutes it is reverted automatically/.test(r.review));
    // pretend 15 minutes passed: stop the server, pull the deadline in, start it again
    await new Promise((r2) => setTimeout(r2, 600));
    const st = JSON.parse(fs.readFileSync(path.join(S.dir, 'state.json'), 'utf8'));
    assert.ok(st.reviews[0].autoAt > Date.now() + 14 * 60e3);
    S.proc.kill();
    st.reviews[0].autoAt = Date.now() - 1000;
    fs.writeFileSync(path.join(S.dir, 'state.json'), JSON.stringify(st));
    const env = Object.assign({}, process.env, { PORT: String(S.port), PUBLIC_PORT: String(S.pub), CONFIG: path.join(S.dir, 'config.json'), VORONMCP_NO_UPDATE_CHECK: '1', VORONMCP_REVIEW_TICK_MS: '150' });
    await new Promise((r2) => setTimeout(r2, 200));
    S.proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: 'ignore' });
    for (let i = 0; i < 40 && f.demo._files.config['printer.cfg'] !== original; i++) await new Promise((r2) => setTimeout(r2, 100));
    assert.strictEqual(f.demo._files.config['printer.cfg'], original, 'put back by itself');
  } finally { S.proc.kill(); await f.close(); }
});

test('server: levels on this network and from outside', async () => {
  const S = await startServer('lvl', { access: { local: 'hands', outsideMax: 'build' } });
  try {
    const a = (await req(S.port, 'GET', '/api/state')).j.access;
    assert.strictEqual(a.local, 'hands'); assert.strictEqual(a.outsideMax, 'build');
    const list = async () => { const tok = (await req(S.port, 'POST', '/api/token', {})).j.token; return (await req(S.port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer ' + tok })).j.result.tools.map((t) => t.name); };
    assert.ok((await list()).includes('run_gcode') && !(await list()).includes('delete_file'));
    assert.ok((await req(S.port, 'POST', '/api/access', { local: 'full' })).j.ok);
    assert.ok((await list()).includes('delete_file'));
    assert.ok(!(await req(S.port, 'POST', '/api/access', { outsideMax: 'full' })).j.ok, 'Full is never allowed from outside');
    assert.ok(!(await req(S.port, 'POST', '/api/access', { local: 'god' })).j.ok);
    assert.ok((await req(S.port, 'POST', '/api/access', { blocked: 'force_move m302 g28', protectedFiles: ['moonraker.conf', 'crowsnest.conf', '../x.cfg'], limits: { hotend: 285 } })).j.ok);
    const b = (await req(S.port, 'GET', '/api/state')).j.access;
    assert.deepStrictEqual(b.blocked, ['FORCE_MOVE', 'M302', 'G28']);
    assert.deepStrictEqual(b.protectedFiles, ['moonraker.conf', 'crowsnest.conf']);
    assert.deepStrictEqual(b.limits, { hotend: 285, bed: 120, other: 80 });
    assert.ok((await req(S.port, 'POST', '/api/access', { local: 'read' })).j.ok);
    assert.ok(!(await list()).includes('save_config_file'));
  } finally { S.proc.kill(); }
});

test('server: token, origin, access switch, PIN, emergency stop without it', async () => {
  const f = await fakeMoonraker();
  const salt = crypto.randomBytes(16);
  const S = await startServer('page', { controlPinHash: 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync('2468', salt, 32).toString('hex') });
  const PIN = { 'x-pin': '2468' };
  try {
    assert.strictEqual((await req(S.port, 'POST', '/api/printer', { url: f.url })).status, 401, 'settings need the PIN');
    assert.ok((await req(S.port, 'POST', '/api/printer', { url: f.url }, PIN)).j.ok);
    await req(S.port, 'POST', '/api/printer-test', {});
    const tok = (await req(S.port, 'POST', '/api/token', {}, PIN)).j.token;
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.strictEqual((await req(S.port, 'POST', '/mcp', list)).status, 401);
    assert.strictEqual((await req(S.port, 'POST', '/mcp', list, { authorization: 'Bearer wrong' })).status, 401);
    assert.strictEqual((await req(S.port, 'POST', '/mcp/' + tok, list)).status, 200, 'token in the address works on this network');
    assert.strictEqual((await req(S.port, 'POST', '/mcp', list, { authorization: 'Bearer ' + tok, origin: 'http://evil.example' })).status, 403, 'web pages cannot use it');
    assert.strictEqual((await req(S.port, 'GET', '/mcp', undefined, { authorization: 'Bearer ' + tok })).status, 405);
    assert.ok((await req(S.port, 'POST', '/api/access', { enabled: false }, PIN)).j.ok);
    assert.strictEqual((await req(S.port, 'POST', '/mcp', list, { authorization: 'Bearer ' + tok })).status, 503, 'off switch');
    assert.ok((await req(S.port, 'POST', '/api/access', { enabled: true }, PIN)).j.ok);
    // page buttons: restart needs the PIN, emergency stop does not
    assert.strictEqual((await req(S.port, 'POST', '/api/printer-action', { action: 'restart' })).status, 401);
    assert.ok((await req(S.port, 'POST', '/api/printer-action', { action: 'estop' })).j.ok);
    assert.strictEqual(f.demo._state.klippy, 'shutdown');
    assert.ok((await req(S.port, 'POST', '/api/printer-action', { action: 'firmware_restart' }, PIN)).j.ok);
    for (let i = 0; i < 30 && f.demo._state.klippy !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(f.demo._state.klippy, 'ready');
    // no restart from the page while printing
    await f.demo.post('/printer/print/start', undefined, { query: { filename: 'Voron_Cube_ABS_0.2mm.gcode' } });
    const r = (await req(S.port, 'POST', '/api/printer-action', { action: 'restart' }, PIN)).j;
    assert.ok(!r.ok && /printing/.test(r.error));
    const act = (await req(S.port, 'GET', '/api/state')).j.activity;
    assert.ok(act.some((x) => /emergency stop/.test(x.tool)));
    const page = await fetch('http://127.0.0.1:' + S.port + '/');
    assert.ok(/<title>VoronMCP<\/title>/.test(await page.text()));
  } finally { S.proc.kill(); await f.close(); }
});

// ---------- run ----------
module.exports = { fakeMoonraker };
if (require.main === module) process.on('beforeExit', () => { if (!process.exitCode) { console.log('A test stopped without finishing (nothing left to wait for)'); process.exit(1); } });
if (require.main === module) (async () => {
  let failed = 0;
  const only = process.env.ONLY;
  for (const t of tests.filter((x) => !only || x.name.startsWith(only))) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  const n = tests.filter((x) => !only || x.name.startsWith(only)).length;
  console.log('\n' + (n - failed) + ' of ' + n + ' passed');
  process.exit(failed ? 1 : 0);
})();
