/*
 * A pretend Voron 2.4 behind a pretend Moonraker, for `node server.js --demo` and the tests.
 * It answers the same calls as lib/moonraker.js, from memory: config files, a klippy.log
 * with a struggling CAN toolhead, live objects, history, the console, the temperature store.
 */
'use strict';
const Guard = require('./guard.js');

const PRINTER_CFG = `# Voron 2.4 350 (demo)
[include mainsail.cfg]
[include ebb36.cfg]
[include macros.cfg]

[mcu]
canbus_uuid: 1a2b3c4d5e6f
# Octopus in USB-to-CAN bridge mode

[printer]
kinematics: corexy
max_velocity: 300
max_accel: 10000
minimum_cruise_ratio: 0.5
square_corner_velocity: 5.0
max_z_velocity: 15
max_z_accel: 350

[stepper_x]
step_pin: PF13
dir_pin: PF12
enable_pin: !PF14
rotation_distance: 40
microsteps: 32
full_steps_per_rotation: 400
endstop_pin: EBBCan:PB6
position_min: 0
position_endstop: 350
position_max: 350
homing_speed: 50
homing_retract_dist: 5
homing_positive_dir: true

[tmc2209 stepper_x]
uart_pin: PC4
interpolate: false
run_current: 0.8
sense_resistor: 0.110
stealthchop_threshold: 0

[stepper_y]
step_pin: PG0
dir_pin: PG1
enable_pin: !PF15
rotation_distance: 40
microsteps: 32
full_steps_per_rotation: 400
endstop_pin: PG9
position_min: 0
position_endstop: 350
position_max: 350
homing_speed: 50
homing_retract_dist: 5
homing_positive_dir: true

[tmc2209 stepper_y]
uart_pin: PD11
interpolate: false
run_current: 0.8
sense_resistor: 0.110
stealthchop_threshold: 0

[stepper_z]
step_pin: PF11
dir_pin: PG3
enable_pin: !PG5
rotation_distance: 40
gear_ratio: 80:16
microsteps: 32
endstop_pin: probe:z_virtual_endstop
position_max: 330
position_min: -5
homing_speed: 8
second_homing_speed: 3
homing_retract_dist: 3

[tmc2209 stepper_z]
uart_pin: PC6
interpolate: false
run_current: 0.8
sense_resistor: 0.110
stealthchop_threshold: 0

[heater_bed]
heater_pin: PA1
sensor_type: Generic 3950
sensor_pin: PF3
max_power: 0.6
min_temp: 0
max_temp: 120

[quad_gantry_level]
gantry_corners:
	-60,-10
	410,420
points:
	50,25
	50,275
	300,275
	300,25
speed: 300
horizontal_move_z: 10
retries: 5
retry_tolerance: 0.0075
max_adjust: 10

[bed_mesh]
speed: 300
horizontal_move_z: 5
mesh_min: 40, 40
mesh_max: 310, 310
probe_count: 7, 7
algorithm: bicubic

[input_shaper]
shaper_type_x: mzv
shaper_freq_x: 62.4
shaper_type_y: mzv
shaper_freq_y: 41.8

[idle_timeout]
timeout: 1800

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [heater_bed]
#*# control = pid
#*# pid_kp = 48.211
#*# pid_ki = 2.161
#*# pid_kd = 268.778
#*#
#*# [probe]
#*# z_offset = -0.512
#*#
#*# [bed_mesh default]
#*# version = 1
#*# points =
#*# 	0.041, 0.022, 0.010, 0.004, 0.012, 0.031, 0.060
#*# 	0.022, 0.008, -0.004, -0.010, -0.002, 0.015, 0.041
#*# 	0.012, -0.002, -0.015, -0.021, -0.012, 0.004, 0.030
#*# 	0.010, -0.005, -0.020, -0.025, -0.016, 0.001, 0.028
#*# 	0.015, 0.000, -0.012, -0.018, -0.010, 0.006, 0.034
#*# 	0.030, 0.014, 0.002, -0.004, 0.004, 0.022, 0.050
#*# 	0.055, 0.035, 0.022, 0.016, 0.025, 0.044, 0.078
#*# x_count = 7
#*# y_count = 7
#*# mesh_x_pps = 2
#*# mesh_y_pps = 2
#*# algo = bicubic
#*# tension = 0.2
#*# min_x = 40.0
#*# max_x = 310.0
#*# min_y = 40.0
#*# max_y = 310.0
`;
const EBB_CFG = `# EBB36 CAN toolhead (demo)
[mcu EBBCan]
canbus_uuid: 61755fe321ac

[temperature_sensor EBB_NTC]
sensor_type: Generic 3950
sensor_pin: EBBCan:PA2

[adxl345]
cs_pin: EBBCan:PB12
spi_software_sclk_pin: EBBCan:PB10
spi_software_mosi_pin: EBBCan:PB11
spi_software_miso_pin: EBBCan:PB2
axes_map: x,y,z

[resonance_tester]
accel_chip: adxl345
probe_points: 175, 175, 20

[extruder]
step_pin: EBBCan:PD0
dir_pin: EBBCan:PD1
enable_pin: !EBBCan:PD2
rotation_distance: 22.6789511
gear_ratio: 50:10
microsteps: 16
full_steps_per_rotation: 200
nozzle_diameter: 0.400
filament_diameter: 1.75
heater_pin: EBBCan:PB13
sensor_type: ATC Semitec 104NT-4-R025H42G
sensor_pin: EBBCan:PA3
min_temp: 10
max_temp: 300
max_power: 1.0
min_extrude_temp: 170
control: pid
pid_kp: 26.213
pid_ki: 1.304
pid_kd: 131.721
pressure_advance: 0.04
pressure_advance_smooth_time: 0.040

[tmc2209 extruder]
uart_pin: EBBCan:PA15
run_current: 0.65
stealthchop_threshold: 999999

[probe]
pin: EBBCan:PB5
x_offset: 0
y_offset: 0
speed: 10.0
samples: 3
samples_result: median
sample_retract_dist: 2.0
samples_tolerance: 0.006
samples_tolerance_retries: 3

[fan]
pin: EBBCan:PA0

[heater_fan hotend_fan]
pin: EBBCan:PA1
heater: extruder
heater_temp: 50.0
`;
const MACROS_CFG = `[gcode_macro PRINT_START]
description: Heat, home, level and mesh before a print
gcode:
  {% set BED = params.BED|default(100)|float %}
  {% set EXTRUDER = params.EXTRUDER|default(240)|float %}
  M140 S{BED}
  G28
  M190 S{BED}
  QUAD_GANTRY_LEVEL
  G28 Z
  BED_MESH_CALIBRATE ADAPTIVE=1
  M109 S{EXTRUDER}

[gcode_macro PRINT_END]
description: Park, cool down, motors off
gcode:
  M400
  G91
  G1 E-2 F2700
  G1 Z10 F3000
  G90
  G0 X175 Y340 F12000
  TURN_OFF_HEATERS
  M107
  M84
`;
const MOONRAKER_CONF = `[server]
host: 0.0.0.0
port: 7125

[authorization]
trusted_clients:
  192.168.1.0/24

[octoprint_compat]

[history]

[update_manager]
`;

function makeLog() {
  const out = [];
  let t = 1000;
  const start = (real) => { out.push('Starting Klippy...', 'Args: [\'/home/pi/klipper/klippy/klippy.py\', \'/home/pi/printer_data/config/printer.cfg\']', 'Git version: \'v0.12.0-396-g4a1f2b3c\'', 'Start printer at Sat Oct 31 19:00:00 2026 (' + real + ' ' + t.toFixed(1) + ')', 'Loaded MCU \'mcu\' 120 commands (v0.12.0-396-g4a1f2b3c)', 'Loaded MCU \'EBBCan\' 118 commands (v0.12.0-301-g9e8d7c6b)', 'Configured MCU \'EBBCan\' (1024 moves)'); };
  const stats = (n, retr0, step, spikeAt) => {
    let r = retr0;
    for (let i = 0; i < n; i++) {
      t += 1;
      r += (spikeAt && i > spikeAt && i < spikeAt + 40) ? 220 : step;
      out.push('Stats ' + t.toFixed(1) + ': gcodein=0  mcu: mcu_awake=0.004 mcu_task_avg=0.000011 mcu_task_stddev=0.000010 bytes_write=' + (90000 + i * 1200) + ' bytes_read=' + (210000 + i * 900) + ' bytes_retransmit=9 bytes_invalid=0 send_seq=' + (9000 + i * 40) + ' receive_seq=' + (9000 + i * 40) + ' retransmit_seq=2 srtt=0.001 rttvar=0.000 rto=0.025 ready_bytes=0 upcoming_bytes=0 freq=180000000 EBBCan: mcu_awake=0.012 mcu_task_avg=0.000021 mcu_task_stddev=0.000016 bytes_write=' + (40000 + i * 950) + ' bytes_read=' + (80000 + i * 400) + ' bytes_retransmit=' + r + ' bytes_invalid=0 send_seq=' + (3000 + i * 30) + ' receive_seq=' + (3000 + i * 30) + ' retransmit_seq=' + (40 + Math.floor(r / 64)) + ' srtt=' + (spikeAt && i > spikeAt && i < spikeAt + 40 ? '0.004' : '0.001') + ' rttvar=0.001 rto=' + (spikeAt && i > spikeAt && i < spikeAt + 40 ? '0.160' : '0.025') + ' ready_bytes=0 upcoming_bytes=0 freq=64000000 canbus_stats EBBCan: bus_state=active rx_error=0 tx_error=' + (spikeAt && i > spikeAt + 20 ? 3 : 0) + ' tx_retries=0 heater_bed: target=100 temp=99.8 pwm=0.412 sysload=0.42 cputime=812.5 memavail=612340 print_time=' + (t + 2).toFixed(3) + ' buffer_time=2.0 print_stall=0 extruder: target=245 temp=244.9 pwm=0.512');
    }
  };
  start(1793494800.0);
  out.push('Starting SD card print (position 0)');
  stats(400, 40, 1, 300);
  out.push('Timer too close', 'MCU \'EBBCan\' shutdown: Timer too close', 'This often indicates the host computer is overloaded. Check', 'for other processes consuming excessive CPU time, high swap', 'usage, disk errors, overheating, unstable voltage, or', 'similar system problems on the host computer.', 'Transition to shutdown state: MCU \'EBBCan\' shutdown: Timer too close', 'Exiting SD card print (position 1843210)', 'Once the underlying issue is corrected, use the', '"FIRMWARE_RESTART" command to reset the firmware, reload the', 'config, and restart the host software.');
  t = 2000;
  start(1793581200.0);
  out.push('TMC \'stepper_z\' reports error: GSTAT:      00000001 reset=1(Reset)');
  stats(240, 12, 2, 0);
  out.push('Starting SD card print (position 0)');
  stats(60, 512, 3, 0);
  out.push('Finished SD card print');
  return out.join('\n') + '\n';
}

function parseCfg(text) {
  const settings = {}, config = {};
  let sec = null, key = null;
  const body = Guard.splitSaveBlock(text).body;
  const save = Guard.splitSaveBlock(text).block.split('\n').map((l) => l.replace(/^#\*# ?/, '')).join('\n');
  for (const part of [body, save]) {
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+#.*$/, '');
      if (/^\s*#/.test(raw) || !line.trim()) { if (key && /^\s+/.test(raw) && raw.trim() && !raw.trim().startsWith('#')) { /* continued */ } continue; }
      const m = /^\[([^\]]+)\]/.exec(line);
      if (m) { sec = m[1].trim().toLowerCase(); if (sec.startsWith('include ')) { sec = null; continue; } settings[sec] = settings[sec] || {}; config[sec] = config[sec] || {}; key = null; continue; }
      if (!sec) continue;
      if (/^\s+/.test(raw) && key) { config[sec][key] += '\n' + raw.trim(); settings[sec][key] = config[sec][key]; continue; }
      const kv = /^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$/.exec(line.trim());
      if (kv) { key = kv[1].toLowerCase(); config[sec][key] = kv[2]; const n = Number(kv[2]); settings[sec][key] = kv[2] !== '' && Number.isFinite(n) ? n : kv[2]; }
    }
  }
  return { settings, config };
}

function client() {
  const files = { config: { 'printer.cfg': PRINTER_CFG, 'ebb36.cfg': EBB_CFG, 'macros.cfg': MACROS_CFG, 'mainsail.cfg': '[virtual_sdcard]\npath: ~/printer_data/gcodes\n\n[pause_resume]\n\n[display_status]\n\n[gcode_macro CANCEL_PRINT]\ndescription: Cancel the actual running print\nrename_existing: CANCEL_PRINT_BASE\ngcode:\n  TURN_OFF_HEATERS\n  CANCEL_PRINT_BASE\n', 'moonraker.conf': MOONRAKER_CONF },
    logs: { 'klippy.log': makeLog(), 'moonraker.log': 'Starting Moonraker...\nMoonraker version: v0.9.3-12\n' },
    gcodes: { 'Voron_Cube_ABS_0.2mm.gcode': '; generated by OrcaSlicer 2.2.0\nG28\n', 'stealthburner_main_body.gcode': '; generated by PrusaSlicer 2.8.1\n' } };
  const st = {
    klippy: 'ready', message: 'Printer is ready', homed: '', qgl: false, ext: [24.8, 0], bed: [23.9, 0], print: { state: 'standby', file: '' }, progress: 0, pending: {},
    store: [], speed: 1, flow: 1, pa: 0.04
  };
  const gstore = [];
  const say = (message, type) => { gstore.push({ message, time: Date.now() / 1000, type: type || 'response' }); if (gstore.length > 1000) gstore.shift(); };
  say('Klipper state: Ready');
  const err = (message, status) => Object.assign(new Error(message), { status: status || 400 });

  function cf() { const all = Object.entries(files.config).filter(([k]) => k.endsWith('.cfg') && k !== 'printer.cfg').map(([, v]) => v).join('\n') + '\n' + files.config['printer.cfg']; return parseCfg(all); }
  function objects() {
    const c = cf();
    const names = ['webhooks', 'configfile', 'print_stats', 'virtual_sdcard', 'toolhead', 'gcode_move', 'idle_timeout', 'system_stats', 'motion_report', 'extruder', 'heater_bed', 'quad_gantry_level', 'bed_mesh', 'mcu', 'mcu EBBCan', 'canbus_stats EBBCan', 'fan', 'heater_fan hotend_fan', 'temperature_sensor EBB_NTC', 'probe', 'pause_resume'];
    Object.keys(c.settings).filter((k) => /^(tmc\d+|gcode_macro) /.test(k)).forEach((k) => names.push(k));
    return names;
  }
  function status(name) {
    const c = cf();
    switch (name) {
      case 'webhooks': return { state: st.klippy, state_message: st.message };
      case 'configfile': return { settings: c.settings, config: c.config, save_config_pending: Object.keys(st.pending).length > 0, save_config_pending_items: st.pending, warnings: [] };
      case 'print_stats': return { state: st.print.state, filename: st.print.file, print_duration: st.print.state === 'standby' ? 0 : 1834, total_duration: 1900, filament_used: 2310, message: '', info: { current_layer: st.print.file ? 42 : null, total_layer: st.print.file ? 150 : null } };
      case 'virtual_sdcard': return { progress: st.progress, is_active: st.print.state === 'printing' };
      case 'toolhead': return { homed_axes: st.homed, max_velocity: 300, max_accel: 10000, minimum_cruise_ratio: 0.5, square_corner_velocity: 5, position: st.homed ? [175, 175, 10, 0] : [0, 0, 0, 0], estimated_print_time: 1000 };
      case 'gcode_move': return { speed_factor: st.speed, extrude_factor: st.flow, homing_origin: [0, 0, 0, 0] };
      case 'idle_timeout': return { state: st.print.state === 'printing' ? 'Printing' : 'Idle' };
      case 'system_stats': return { sysload: 0.42, cputime: 812.5, memavail: 612340 };
      case 'motion_report': return { live_velocity: 0, live_position: [0, 0, 0, 0] };
      case 'extruder': return { temperature: st.ext[0], target: st.ext[1], power: st.ext[1] ? 0.48 : 0, pressure_advance: st.pa, smooth_time: 0.04, can_extrude: st.ext[0] > 170 };
      case 'heater_bed': return { temperature: st.bed[0], target: st.bed[1], power: st.bed[1] ? 0.41 : 0 };
      case 'quad_gantry_level': return { applied: st.qgl };
      case 'bed_mesh': { const pts = [[0.041, 0.022, 0.010, 0.004, 0.012, 0.031, 0.060], [0.022, 0.008, -0.004, -0.010, -0.002, 0.015, 0.041], [0.012, -0.002, -0.015, -0.021, -0.012, 0.004, 0.030], [0.010, -0.005, -0.020, -0.025, -0.016, 0.001, 0.028], [0.015, 0.000, -0.012, -0.018, -0.010, 0.006, 0.034], [0.030, 0.014, 0.002, -0.004, 0.004, 0.022, 0.050], [0.055, 0.035, 0.022, 0.016, 0.025, 0.044, 0.078]];
        return { profile_name: 'default', mesh_min: [40, 40], mesh_max: [310, 310], probed_matrix: pts, profiles: { default: { points: pts, mesh_params: { x_count: 7, y_count: 7, algo: 'bicubic', min_x: 40, max_x: 310, min_y: 40, max_y: 310 } } } }; }
      case 'mcu': return { mcu_version: 'v0.12.0-396-g4a1f2b3c', mcu_build_versions: 'gcc: (15:13.2.rel1-2) 13.2.1 binutils: (2.42-1) 2.42', last_stats: { mcu_awake: 0.004, mcu_task_avg: 0.000011, mcu_task_stddev: 0.00001, bytes_write: 380000, bytes_read: 420000, bytes_retransmit: 9, bytes_invalid: 0, send_seq: 9800, receive_seq: 9800, retransmit_seq: 2, srtt: 0.001, rttvar: 0, rto: 0.025, ready_bytes: 0, upcoming_bytes: 0, freq: 180000000 } };
      case 'mcu EBBCan': return { mcu_version: 'v0.12.0-301-g9e8d7c6b', mcu_build_versions: 'gcc: (15:13.2.rel1-2) 13.2.1 binutils: (2.42-1) 2.42', last_stats: { mcu_awake: 0.012, mcu_task_avg: 0.000021, mcu_task_stddev: 0.000016, bytes_write: 320000, bytes_read: 180000, bytes_retransmit: 1172, bytes_invalid: 0, send_seq: 4200, receive_seq: 4200, retransmit_seq: 61, srtt: 0.0012, rttvar: 0.0004, rto: 0.025, ready_bytes: 0, upcoming_bytes: 0, freq: 64000000 } };
      case 'canbus_stats EBBCan': return { rx_error: 0, tx_error: 0, tx_retries: 0, bus_state: 'active' };
      case 'fan': return { speed: 0, rpm: null };
      case 'heater_fan hotend_fan': return { speed: st.ext[0] > 50 ? 1 : 0, rpm: st.ext[0] > 50 ? 7400 : 0 };
      case 'temperature_sensor EBB_NTC': return { temperature: 31.4, measured_min_temp: 22.1, measured_max_temp: 48.7 };
      case 'probe': return { last_query: false, last_z_result: -0.508 };
      case 'pause_resume': return { is_paused: st.print.state === 'paused' };
      default:
        if (/^tmc\d+ /.test(name)) { const s = c.settings[name] || {}; return { run_current: s.run_current, hold_current: s.run_current, drv_status: name.includes('stepper_z') ? { cs_actual: 20, stst: 1, otpw: 0 } : { cs_actual: 25, stst: 1 }, temperature: null, phase_offset_position: 0, mcu_phase_offset: 0 }; }
        if (name.startsWith('gcode_macro ')) return {};
        return undefined;
    }
  }
  function tempStore() {
    const n = 1200, mk = (fn) => Array.from({ length: n }, (_, i) => Math.round(fn(i) * 100) / 100);
    return {
      extruder: { temperatures: mk((i) => (st.ext[1] ? st.ext[1] + Math.sin(i / 9) * 0.3 : 24.8)), targets: mk(() => st.ext[1]), powers: mk(() => (st.ext[1] ? 0.48 : 0)) },
      heater_bed: { temperatures: mk((i) => 100 + Math.sin(i / 40) * 1.6), targets: mk(() => 100), powers: mk((i) => 0.4 + Math.sin(i / 40) * 0.3) },
      'temperature_sensor EBB_NTC': { temperatures: mk((i) => 31 + Math.sin(i / 100)) }
    };
  }

  function restart(firmware) {
    st.homed = ''; st.qgl = false; st.ext[1] = 0; st.bed[1] = 0; st.klippy = 'startup'; st.message = 'Printer is restarting';
    st.print = { state: 'standby', file: '' }; st.progress = 0;
    setTimeout(() => {
      // a broken section makes the pretend Klipper stop with a config error, like the real one
      const bad = /^\s*\[[^\]\n]*$/m.test(files.config['printer.cfg']) || /\bmax_velocity:\s*[a-z]/i.test(files.config['printer.cfg']);
      if (bad) { st.klippy = 'error'; st.message = 'Error loading config: Unable to parse option \'max_velocity\' in section \'printer\''; say('!! ' + st.message); }
      else { st.klippy = 'ready'; st.message = 'Printer is ready'; say('Klipper state: Ready'); }
    }, firmware ? 1200 : 600);
  }

  function runLine(line) {
    const p = Guard.parseLine(line);
    if (!p) return;
    say(p.raw, 'command');
    if (st.klippy !== 'ready') throw err('Klipper is not ready');
    const c = cf();
    switch (p.cmd) {
      case 'G28': st.homed = 'xyz'; say('// homed'); return;
      case 'QUAD_GANTRY_LEVEL': if (!st.homed) throw err('Must home axis first'); st.qgl = true; say('// Gantry-relative probe points:\n// 0: 4.152 1: 4.161 2: 4.158 3: 4.149'); say('// Retries: 0/5 Probed points range: 0.004102 tolerance: 0.007500'); return;
      case 'BED_MESH_CALIBRATE': if (!st.homed) throw err('Must home axis first'); say('// Mesh Bed Leveling Complete'); st.pending['bed_mesh default'] = { version: 1 }; return;
      case 'PROBE_ACCURACY': say('// probe accuracy results: maximum -0.505000, minimum -0.512500, range 0.007500, average -0.508750, median -0.508750, standard deviation 0.002165'); return;
      case 'PID_CALIBRATE': say('// PID parameters: pid_Kp=26.401 pid_Ki=1.320 pid_Kd=132.003'); say('// The SAVE_CONFIG command will update the printer config file with these parameters and restart the printer.'); st.pending[String(p.params.HEATER || 'extruder').toLowerCase()] = { control: 'pid', pid_kp: '26.401', pid_ki: '1.320', pid_kd: '132.003' }; return;
      case 'SHAPER_CALIBRATE': say('// Recommended shaper_type_x = mzv, shaper_freq_x = 63.2 Hz'); say('// Recommended shaper_type_y = mzv, shaper_freq_y = 42.6 Hz'); st.pending.input_shaper = { shaper_type_x: 'mzv', shaper_freq_x: '63.2', shaper_type_y: 'mzv', shaper_freq_y: '42.6' }; return;
      case 'M104': case 'M109': st.ext[1] = Number(p.params.S || 0); return;
      case 'M140': case 'M190': st.bed[1] = Number(p.params.S || 0); return;
      case 'SET_HEATER_TEMPERATURE': if (String(p.params.HEATER).toLowerCase() === 'heater_bed') st.bed[1] = Number(p.params.TARGET || 0); else st.ext[1] = Number(p.params.TARGET || 0); return;
      case 'TURN_OFF_HEATERS': st.ext[1] = 0; st.bed[1] = 0; return;
      case 'SET_PRESSURE_ADVANCE': if (p.params.ADVANCE != null) st.pa = Number(p.params.ADVANCE); say('// pressure_advance: ' + st.pa.toFixed(6) + '\n// pressure_advance_smooth_time: 0.040000'); return;
      case 'M220': st.speed = Number(p.params.S || 100) / 100; return;
      case 'M221': st.flow = Number(p.params.S || 100) / 100; return;
      case 'SAVE_CONFIG': {
        const items = st.pending;
        let txt = files.config['printer.cfg'];
        if (!txt.includes(Guard.SAVE_MARK)) txt += '\n' + Guard.SAVE_MARK + '\n#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.\n#*#\n';
        for (const [sec, vals] of Object.entries(items)) { if (sec.startsWith('bed_mesh')) continue; txt += '#*# [' + sec + ']\n' + Object.entries(vals).map(([k, v]) => '#*# ' + k + ' = ' + v).join('\n') + '\n#*#\n'; }
        files.config['printer.cfg'] = txt; st.pending = {}; restart(false); return;
      }
      case 'G0': case 'G1': if (!st.homed) throw err('Must home axis first'); return;
      case 'G90': case 'G91': case 'M400': case 'M84': case 'M107': case 'M106': case 'M117': case 'GET_POSITION': case 'STATUS': case 'SET_VELOCITY_LIMIT': case 'SET_GCODE_OFFSET': case 'DUMP_TMC': case 'QUERY_ENDSTOPS': case 'Z_ENDSTOP_CALIBRATE': return;
      default:
        if (c.settings['gcode_macro ' + p.cmd.toLowerCase()]) { say('// running ' + p.cmd); return; }
        throw err('Unknown command:"' + p.cmd + '"');
    }
  }

  async function get(path, query) {
    if (path === '/server/info') return { klippy_connected: st.klippy !== 'disconnected', klippy_state: st.klippy, components: ['file_manager', 'history', 'update_manager'], failed_components: [], warnings: [], moonraker_version: 'v0.9.3-12' };
    if (path === '/printer/info') return { state: st.klippy, state_message: st.message, hostname: 'voron24', software_version: 'v0.12.0-396-g4a1f2b3c', klipper_path: '~/klipper', python_path: '~/klippy-env/bin/python', log_file: '~/printer_data/logs/klippy.log', config_file: '~/printer_data/config/printer.cfg' };
    if (st.klippy === 'startup' && path.startsWith('/printer/objects')) throw err('Klippy host not connected', 503);
    if (path === '/printer/objects/list') return { objects: objects() };
    if (path === '/printer/objects/query') { const out = {}; for (const [k, v] of Object.entries(query || {})) { const s = status(k); if (s === undefined) continue; if (v) { const f = String(v).split(','); out[k] = Object.fromEntries(f.filter((x) => x in s).map((x) => [x, s[x]])); } else out[k] = s; } return { eventtime: Date.now() / 1000, status: out }; }
    if (path === '/server/files/list') { const root = (query && query.root) || 'gcodes'; return Object.entries(files[root] || {}).map(([p, t]) => ({ path: p, size: t.length, modified: 1793500000 + p.length * 1000, permissions: 'rw' })); }
    if (path === '/server/files/metadata') { const f = query.filename; if (!files.gcodes[f]) throw err('Metadata not available for <' + f + '>', 404); return { filename: f, slicer: f.includes('Cube') ? 'OrcaSlicer' : 'PrusaSlicer', slicer_version: '2.2.0', layer_height: 0.2, first_layer_height: 0.25, nozzle_diameter: 0.4, first_layer_extr_temp: 250, first_layer_bed_temp: 105, estimated_time: 2760, filament_total: 4120.5, object_height: 30 }; }
    if (path === '/server/history/list') return { count: 4, jobs: [
      { job_id: '000004', filename: 'Voron_Cube_ABS_0.2mm.gcode', status: 'completed', start_time: 1793584800, end_time: 1793587600, print_duration: 2760, total_duration: 2800, filament_used: 4120, exists: true, metadata: { slicer: 'OrcaSlicer', layer_height: 0.2 } },
      { job_id: '000003', filename: 'stealthburner_main_body.gcode', status: 'klippy_shutdown', start_time: 1793494900, end_time: 1793495300, print_duration: 380, total_duration: 400, filament_used: 620, exists: true, metadata: { slicer: 'PrusaSlicer', layer_height: 0.2 } },
      { job_id: '000002', filename: 'stealthburner_main_body.gcode', status: 'klippy_shutdown', start_time: 1793400000, end_time: 1793401800, print_duration: 1700, total_duration: 1800, filament_used: 2300, exists: true, metadata: {} },
      { job_id: '000001', filename: 'Voron_Cube_ABS_0.2mm.gcode', status: 'completed', start_time: 1793300000, end_time: 1793302800, print_duration: 2760, total_duration: 2800, filament_used: 4120, exists: true, metadata: {} }] };
    if (path === '/server/history/totals') return { job_totals: { total_jobs: 4, total_time: 7800, total_print_time: 7600, total_filament_used: 11160, longest_job: 2800, longest_print: 2760 } };
    if (path === '/server/gcode_store') return { gcode_store: gstore.slice(-Number((query && query.count) || 100)) };
    if (path === '/server/temperature_store') return tempStore();
    if (path === '/server/webcams/list') return { webcams: [{ name: 'chamber', enabled: true, service: 'mjpegstreamer', snapshot_url: '/webcam/?action=snapshot', stream_url: '/webcam/?action=stream' }] };
    if (path === '/machine/system_info') return { system_info: { cpu_info: { cpu_count: 4, model: 'Raspberry Pi 4 Model B Rev 1.4', processor: 'ARMv7', total_memory: 3884000 }, sd_info: { manufacturer: 'SanDisk', product_name: 'SN32G', capacity: '29.7 GiB' }, distribution: { name: 'Debian GNU/Linux 12 (bookworm)', version: '12' }, available_services: ['klipper', 'moonraker', 'crowsnest'], service_state: { klipper: { active_state: 'active', sub_state: 'running' }, moonraker: { active_state: 'active', sub_state: 'running' }, crowsnest: { active_state: 'active', sub_state: 'running' } }, virtualization: { virt_type: 'none' }, canbus: { can0: { tx_queue_len: 10, bitrate: 1000000, driver: 'gs_usb' } } } };
    if (path === '/machine/proc_stats') return { cpu_temp: 54.2, throttled_state: { bits: 0, flags: [] }, system_memory: { total: 3884000, available: 2900000, used: 984000 }, system_uptime: 302400, system_cpu_usage: { cpu: 11.2 } };
    if (path === '/machine/update/status') return { busy: false, version_info: { system: { package_count: 14 }, klipper: { version: 'v0.12.0-396', remote_version: 'v0.12.0-410', commits_behind: new Array(14).fill({}), is_dirty: false, is_valid: true }, moonraker: { version: 'v0.9.3-12', remote_version: 'v0.9.3-12', commits_behind: [], is_dirty: false, is_valid: true }, mainsail: { version: 'v2.13.2', remote_version: 'v2.13.2' } } };
    throw err('Not found: ' + path, 404);
  }

  async function post(path, body, o) {
    const q = (o && o.query) || {};
    if (path === '/printer/restart') { restart(false); return 'ok'; }
    if (path === '/printer/firmware_restart') { restart(true); return 'ok'; }
    if (path === '/printer/emergency_stop') { st.klippy = 'shutdown'; st.message = 'Shutdown due to M112 command'; st.ext[1] = 0; st.bed[1] = 0; st.print.state = st.print.state === 'standby' ? 'standby' : 'error'; say('!! Shutdown due to M112 command'); return 'ok'; }
    if (path === '/printer/gcode/script') { for (const l of String(body.script).split('\n')) runLine(l); return 'ok'; }
    if (path === '/printer/print/start') { if (!files.gcodes[q.filename]) throw err('File not found: ' + q.filename, 404); st.print = { state: 'printing', file: q.filename }; st.progress = 0.27; st.ext[1] = 250; st.bed[1] = 105; return 'ok'; }
    if (path === '/printer/print/pause') { st.print.state = 'paused'; return 'ok'; }
    if (path === '/printer/print/resume') { st.print.state = 'printing'; return 'ok'; }
    if (path === '/printer/print/cancel') { st.print.state = 'cancelled'; st.ext[1] = 0; st.bed[1] = 0; return 'ok'; }
    if (path === '/machine/services/restart') { if (q.service === 'klipper') restart(false); return 'ok'; }
    throw err('Not found: ' + path, 404);
  }

  const fileOf = (root, p) => { const r = files[root]; if (!r || !(p in r)) throw err('File ' + p + ' does not exist', 404); return r[p]; };

  return {
    configured: () => true, base: () => 'http://demo-printer:7125', reset: () => {},
    get, post, del: async () => 'ok',
    download: async (root, p) => fileOf(root, p),
    upload: async (root, p, text) => { files[root][p] = String(text); return { item: { path: p, root } }; },
    remove: async (root, p) => { fileOf(root, p); delete files[root][p]; return { item: { path: p, root } }; },
    query: async (objs) => { const q = {}; if (Array.isArray(objs)) objs.forEach((o) => { q[o] = ''; }); else Object.entries(objs || {}).forEach(([k, v]) => { q[k] = v == null ? '' : String(v); }); return (await get('/printer/objects/query', q)).status; },
    gcode: (script) => post('/printer/gcode/script', { script }),
    // a 1x1 grey JPEG stands in for the webcam
    fetchImage: async () => ({ buf: Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), type: 'image/jpeg' }),
    _files: files, _state: st
  };
}

module.exports = { client, parseCfg, makeLog };
