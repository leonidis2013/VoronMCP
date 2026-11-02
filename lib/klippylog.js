/*
 * Reads klippy.log: Klipper's own record of every start, error, shutdown and (about once a
 * second while it is busy) a "Stats" line with each MCU's link numbers. That is where CAN
 * trouble shows first: bytes_retransmit climbing on the toolhead board, a rising srtt or
 * rto, then "Timer too close" or "Lost communication with MCU".
 *
 * Everything here works on the text alone, so it is tested without a printer.
 */
'use strict';

// what to look for, most serious first. kind is shown to Claude; mcu/heater/driver are pulled out where the line names one
const EVENTS = [
  { kind: 'shutdown', re: /Transition to shutdown state:\s*(.*)$/ },
  { kind: 'mcu_shutdown', re: /MCU '([^']+)' shutdown:\s*(.*)$/, mcu: 1 },
  { kind: 'lost_mcu', re: /Lost communication with MCU '([^']+)'/, mcu: 1 },
  { kind: 'timeout_mcu', re: /Timeout with MCU '([^']+)'/, mcu: 1 },
  { kind: 'timer_too_close', re: /Timer too close/ },
  { kind: 'missed_scheduling', re: /Missed scheduling of next/ },
  { kind: 'timer_in_past', re: /Rescheduled timer in the past/ },
  { kind: 'stepper_too_far_in_past', re: /Stepper too far in past/ },
  { kind: 'move_queue_overflow', re: /Move queue overflow/ },
  { kind: 'can_error', re: /(Unable to open CAN port|Got error -?\d+ in can write|canbus.*(?:error|fail)|Unable to connect to CAN|No CAN device)/i },
  { kind: 'mcu_connect', re: /mcu '([^']+)': (Unable to connect|Timeout on connect|Wait for identify_response)/i, mcu: 1 },
  { kind: 'tmc_error', re: /TMC '([^']+)' reports error:\s*(.*)$/, driver: 1 },
  { kind: 'tmc_uart', re: /Unable to read tmc uart '([^']+)'/, driver: 1 },
  { kind: 'heater_not_heating', re: /Heater (\S+) not heating at expected rate/, heater: 1 },
  { kind: 'adc_out_of_range', re: /ADC out of range/ },
  { kind: 'thermocouple_fault', re: /(Thermocouple reader fault|MAX318\d\d.*fault)/i },
  { kind: 'homing_error', re: /(No trigger on \S+ after full movement|Endstop \S+ still triggered after retract|Error during homing move:\s*(.*))/ },
  { kind: 'probe_error', re: /(Probe triggered prior to movement|Probe samples exceed (?:tolerance|samples_tolerance)|Retries exceeded|Probe failed)/i },
  { kind: 'qgl_error', re: /(Too many retries|Quad gantry level|Z tilt).*(?:error|exceed|fail)/i },
  { kind: 'move_out_of_range', re: /Move out of range:\s*(.*)$/ },
  { kind: 'must_home', re: /Must home axis first/ },
  { kind: 'config_error', re: /(Config error|Option '[^']+' (?:is not valid|in section '[^']+' must be specified)|Unknown pin chip name|Section '[^']+' is not a valid config section|Unable to parse option)/ },
  { kind: 'template_error', re: /Error (?:evaluating|loading) template/ },
  { kind: 'internal_error', re: /(Internal error on command|Unhandled exception|Traceback \(most recent call last\))/ },
  { kind: 'filament_runout', re: /(Filament Sensor \S+: runout|runout event detected)/i },
];
const SERIOUS = new Set(['shutdown', 'mcu_shutdown', 'lost_mcu', 'timeout_mcu', 'timer_too_close', 'missed_scheduling', 'timer_in_past', 'stepper_too_far_in_past', 'move_queue_overflow', 'can_error', 'tmc_error', 'heater_not_heating', 'adc_out_of_range', 'thermocouple_fault', 'internal_error']);

/** "Stats 123.4: gcodein=0  mcu: mcu_awake=0.003 ... EBBCan: ..." -> { t, sections: { name: { key: number|string } } } */
function parseStats(line) {
  const m = /^Stats ([\d.]+):\s*(.*)$/.exec(line);
  if (!m) return null;
  const sections = { '': {} };
  let cur = '', pending = [];
  for (const tok of m[2].split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const k = tok.slice(0, eq), v = tok.slice(eq + 1), n = Number(v);
      sections[cur][k] = v !== '' && Number.isFinite(n) ? n : v;
      pending = [];
    } else if (tok.endsWith(':')) {
      cur = pending.concat([tok.slice(0, -1)]).join(' ');
      pending = [];
      if (!sections[cur]) sections[cur] = {};
    } else pending.push(tok);
  }
  return { t: Number(m[1]), sections };
}
const isMcu = (s) => s && typeof s.bytes_retransmit === 'number';
const isCanStats = (name, s) => s && (typeof s.rx_error === 'number' || typeof s.tx_error === 'number' || s.bus_state != null) && !isMcu(s);
const canName = (name) => String(name).replace(/^canbus_stats[ _]/, '');

/** "Start printer at Sat Nov  1 12:00:00 2026 (1730484000.0 3456.7)" -> { real, mono } */
function parseStart(line) {
  const m = /^Start printer at .*\(([\d.]+) ([\d.]+)\)/.exec(line);
  return m ? { real: Number(m[1]), mono: Number(m[2]) } : null;
}

/**
 * Splits the log into sessions (one per Klipper start) and reads each one.
 * opts: { sessions: how many of the latest to keep (default 3), context: lines around each event (default 2),
 *         maxEvents: per session (default 60), windowS: seconds per retransmit window (default 60) }
 */
function analyze(text, opts) {
  opts = Object.assign({ sessions: 3, context: 2, maxEvents: 60, windowS: 60 }, opts || {});
  const lines = String(text || '').split(/\r?\n/);
  const sessions = [];
  let s = null;
  const startSession = (i, line) => {
    s = { startLine: i + 1, startText: line.slice(0, 160), start: null, version: '', lines: 0, events: [], counts: {}, stats: { first: null, last: null, n: 0, series: {} }, prints: [], configError: null, endState: '' };
    sessions.push(s);
  };
  startSession(0, '(start of file)');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Starting Klippy\.\.\.|^=+ Log rollover at/.test(line)) { if (s.lines > 0 || s.events.length) startSession(i, line); else { s.startLine = i + 1; s.startText = line.slice(0, 160); } continue; }
    s.lines++;
    const st = parseStart(line);
    if (st) { s.start = st; continue; }
    if (!s.version) { const v = /^Git version: '?([^']+)'?/.exec(line) || /^Klipper version:? ?'?([^']+)'?/i.exec(line); if (v) s.version = v[1].trim(); }
    if (line.startsWith('Stats ')) { addStats(s, parseStats(line), opts.windowS); continue; }
    if (/Starting SD card print|Finished SD card print|Exiting SD card print|Stopping SD card print/.test(line)) { s.prints.push({ line: i + 1, text: line.trim().slice(0, 160), at: lastT(s) }); continue; }
    for (const ev of EVENTS) {
      const m = ev.re.exec(line);
      if (!m) continue;
      s.counts[ev.kind] = (s.counts[ev.kind] || 0) + 1;
      if (ev.kind === 'config_error' && !s.configError) s.configError = line.trim().slice(0, 400);
      if (s.events.length < opts.maxEvents && (s.counts[ev.kind] <= 5 || SERIOUS.has(ev.kind) && s.counts[ev.kind] <= 15)) {
        const e = { kind: ev.kind, line: i + 1, text: line.trim().slice(0, 300), at: lastT(s) };
        if (ev.mcu) e.mcu = m[ev.mcu];
        if (ev.driver) e.driver = m[ev.driver];
        if (ev.heater) e.heater = m[ev.heater];
        if (opts.context > 0) {
          e.before = lines.slice(Math.max(0, i - opts.context), i).filter((x) => !x.startsWith('Stats ')).map((x) => x.slice(0, 200));
          e.after = lines.slice(i + 1, i + 1 + opts.context).filter((x) => !x.startsWith('Stats ')).map((x) => x.slice(0, 200));
        }
        s.events.push(e);
      }
      break;
    }
    if (/^Once the underlying issue is corrected/.test(line)) s.endState = 'shutdown';
  }
  // drop the empty stretch before the first "Starting Klippy" line
  const real = sessions.filter((x) => x.lines > 0);
  const keep = real.slice(-Math.max(1, opts.sessions));
  return {
    totalLines: lines.length,
    sessionsInFile: real.length,
    sessions: keep.map((x) => finish(x, opts.windowS)).reverse() // newest first
  };
}

function lastT(s) { return s.stats.last ? s.stats.last.t : null; }

function addStats(s, st, windowS) {
  if (!st) return;
  s.stats.n++;
  if (!s.stats.first) s.stats.first = st;
  s.stats.last = st;
  for (const [name, v] of Object.entries(st.sections)) {
    if (isMcu(v)) {
      const ser = s.stats.series[name] || (s.stats.series[name] = { kind: 'mcu', samples: [], maxSrtt: 0, maxRto: 0, maxRttvar: 0, maxAwake: 0, maxTaskAvg: 0, maxTaskStddev: 0, freq: v.freq, windows: [] });
      ser.maxSrtt = Math.max(ser.maxSrtt, v.srtt || 0); ser.maxRto = Math.max(ser.maxRto, v.rto || 0); ser.maxRttvar = Math.max(ser.maxRttvar, v.rttvar || 0);
      ser.maxAwake = Math.max(ser.maxAwake, v.mcu_awake || 0); ser.maxTaskAvg = Math.max(ser.maxTaskAvg, v.mcu_task_avg || 0); ser.maxTaskStddev = Math.max(ser.maxTaskStddev, v.mcu_task_stddev || 0);
      track(ser, st.t, { retransmit: v.bytes_retransmit, invalid: v.bytes_invalid || 0, written: v.bytes_write || 0 }, windowS);
    } else if (isCanStats(name, v)) {
      const key = 'can:' + canName(name);
      const ser = s.stats.series[key] || (s.stats.series[key] = { kind: 'canbus', samples: [], states: {}, windows: [] });
      if (v.bus_state != null) ser.states[v.bus_state] = (ser.states[v.bus_state] || 0) + 1;
      track(ser, st.t, { rx_error: v.rx_error || 0, tx_error: v.tx_error || 0, tx_retries: v.tx_retries || 0 }, windowS);
    }
  }
}

/** Keeps first/last values and per-window increases (counters that reset on restart are handled per session). */
function track(ser, t, vals, windowS) {
  if (!ser.first) ser.first = { t, vals: Object.assign({}, vals) };
  const prev = ser.last;
  ser.last = { t, vals: Object.assign({}, vals) };
  if (!ser.win || t - ser.win.t0 >= windowS) {
    if (ser.win && prev) ser.windows.push({ t0: ser.win.t0, t1: prev.t, inc: diff(ser.win.start, prev.vals) });
    ser.win = { t0: t, start: Object.assign({}, prev ? prev.vals : vals) };
  }
}
function diff(a, b) { const o = {}; for (const k of Object.keys(b)) o[k] = Math.max(0, (b[k] || 0) - (a[k] || 0)); return o; }

function finish(s, windowS) {
  const toWall = (t) => (t == null || !s.start ? null : new Date((s.start.real + (t - s.start.mono)) * 1000).toISOString());
  const out = {
    started: s.start ? new Date(s.start.real * 1000).toISOString() : null,
    firstLine: s.startLine, startText: s.startText, klipperVersion: s.version || undefined,
    lines: s.lines, endedInShutdown: s.endState === 'shutdown' || undefined,
    configError: s.configError || undefined,
    eventCounts: s.counts,
    events: s.events.map((e) => Object.assign({}, e, { at: toWall(e.at) || undefined })),
    prints: s.prints.slice(-10).map((p) => Object.assign({}, p, { at: toWall(p.at) || undefined })),
    link: {}
  };
  const span = s.stats.first && s.stats.last ? s.stats.last.t - s.stats.first.t : 0;
  out.statsLines = s.stats.n;
  out.busySeconds = Math.round(span);
  for (const [name, ser] of Object.entries(s.stats.series)) {
    if (ser.win && ser.last) ser.windows.push({ t0: ser.win.t0, t1: ser.last.t, inc: diff(ser.win.start, ser.last.vals) });
    const total = diff(ser.first.vals, ser.last.vals);
    const hours = Math.max((ser.last.t - ser.first.t) / 3600, 1 / 3600);
    if (ser.kind === 'mcu') {
      const worst = ser.windows.slice().sort((a, b) => b.inc.retransmit - a.inc.retransmit).filter((w) => w.inc.retransmit > 0).slice(0, 5);
      out.link[name] = {
        bytes_retransmit: { start: ser.first.vals.retransmit, end: ser.last.vals.retransmit, increase: total.retransmit, perHour: round(total.retransmit / hours, 1) },
        bytes_invalid: { increase: total.invalid },
        retransmitPerMBWritten: total.written > 0 ? round(total.retransmit / (total.written / 1048576), 1) : undefined,
        max_srtt_ms: round(ser.maxSrtt * 1000, 2), max_rttvar_ms: round(ser.maxRttvar * 1000, 2), max_rto_ms: round(ser.maxRto * 1000, 1),
        max_mcu_awake: round(ser.maxAwake, 4), max_mcu_task_avg_us: round(ser.maxTaskAvg * 1e6, 1), max_mcu_task_stddev_us: round(ser.maxTaskStddev * 1e6, 1),
        freq_mhz: ser.freq ? round(ser.freq / 1e6, 1) : undefined,
        worstWindows: worst.map((w) => ({ from: toWall(w.t0) || 'eventtime ' + round(w.t0, 1), seconds: Math.round(w.t1 - w.t0), retransmitBytes: w.inc.retransmit, invalidBytes: w.inc.invalid || undefined })),
        verdict: linkVerdict(name, total, hours, ser)
      };
    } else {
      out.link[name] = { rx_error: total.rx_error, tx_error: total.tx_error, tx_retries: total.tx_retries, busStatesSeen: ser.states,
        verdict: total.rx_error || total.tx_error ? 'CAN errors counted by the adapter: check termination (about 60 ohm across CANH and CANL with power off), wiring and connectors' : (Object.keys(ser.states).some((k) => k !== 'active') ? 'The bus left the active state (' + Object.keys(ser.states).join(', ') + '): wiring or termination problem' : 'Clean') };
    }
  }
  if (!Object.keys(out.link).length) delete out.link;
  return out;
}

function round(v, d) { const p = 10 ** d; return Math.round(v * p) / p; }

/** Plain words for a link's numbers. Thresholds are rules of thumb from the Klipper community, not hard limits. */
function linkVerdict(name, total, hours, ser) {
  const notes = [];
  const perHour = total.retransmit / hours;
  if (total.invalid > 0) notes.push(total.invalid + ' invalid bytes: corrupted frames, usually wiring, termination or a failing connector');
  if (perHour > 2000) notes.push('a lot of retransmits (' + Math.round(perHour) + '/h): the link is struggling');
  else if (perHour > 200) notes.push('steady retransmits (' + Math.round(perHour) + '/h): worth checking the cable, termination and txqueuelen');
  else if (total.retransmit > 0) notes.push('a few retransmits (' + total.retransmit + '): normal for most setups');
  if (ser.maxRto > 0.1) notes.push('rto reached ' + Math.round(ser.maxRto * 1000) + ' ms (normal is about 25 ms): messages were waiting on retries');
  if (ser.maxSrtt > 0.01) notes.push('round trip up to ' + round(ser.maxSrtt * 1000, 1) + ' ms (CAN at 1 Mbit is usually under 1 ms; USB under 1 ms): the host or bus was slow to answer');
  if (ser.maxAwake > 0.5) notes.push('the MCU was busy ' + Math.round(ser.maxAwake * 100) + '% of the time: too much for this board (lower microsteps or step rate)');
  return notes.length ? notes.join('; ') : 'Clean';
}

/** The latest lines (or lines matching a pattern) of a log, newest last. */
function tail(text, { lines = 200, match, before = 0, after = 0, skipStats = true } = {}) {
  const all = String(text || '').split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  let re = null;
  if (match) { try { re = new RegExp(match, 'i'); } catch (e) { return { error: 'The pattern is not a valid regular expression: ' + e.message }; } }
  const keep = [];
  if (re) {
    const take = new Set();
    all.forEach((l, i) => { if (re.test(l)) { take.add(i); for (let j = Math.max(0, i - before); j <= Math.min(all.length - 1, i + after); j++) if (!(skipStats && all[j].startsWith('Stats '))) take.add(j); } });
    [...take].sort((a, b) => a - b).forEach((i) => keep.push((i + 1) + ': ' + all[i].slice(0, 500)));
  } else {
    for (let i = all.length - 1; i >= 0 && keep.length < lines; i--) {
      if (skipStats && all[i].startsWith('Stats ')) continue;
      keep.push((i + 1) + ': ' + all[i].slice(0, 500));
    }
    keep.reverse();
  }
  const shown = keep.slice(-lines);
  return { totalLines: all.length, matched: re ? keep.length : undefined, shown: shown.length, text: shown.join('\n') };
}

module.exports = { analyze, parseStats, parseStart, tail, linkVerdict, EVENTS };
