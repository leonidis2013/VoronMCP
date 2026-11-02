/*
 * Is VoronMCP itself healthy? Checks the place it saves to (the /data volume, which
 * may be a local dataset, a Docker volume or a network share), free space there, and
 * the container's memory and load. Each part gets a level: ok, warn or bad, and a
 * plain-language reason.
 *
 * Storage is checked by actually writing, reading back and deleting a small file, with
 * a time limit, because a network share can be mounted but hung or read-only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GB = 1024 ** 3, MB = 1024 ** 2;
const NETWORK_FS = /^(nfs4?|cifs|smb3?|smbfs|fuse\.sshfs|glusterfs|ceph|9p|fuse\.rclone|davfs)$/;

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' took longer than ' + Math.round(ms / 1000) + ' s (the storage may be hung or very slow)')), ms); })])
    .finally(() => clearTimeout(t));
}
// A hung network share can leave a file operation waiting forever. Node only has a few
// threads for file work, so never start a new probe while the last one is still stuck.
let stuck = null; // { since, what }
const human = (b) => (b >= GB ? (b / GB).toFixed(b >= 100 * GB ? 0 : 1) + ' GB' : Math.round(b / MB) + ' MB');

/** The mount that holds dir, from /proc/self/mountinfo text: { mountPoint, fsType, source, readOnly } */
function mountFor(dir, mountinfo) {
  let best = null;
  String(mountinfo || '').split('\n').forEach((line) => {
    const parts = line.split(' - ');
    if (parts.length < 2) return;
    const a = parts[0].split(' '), b = parts[1].split(' ');
    const mp = (a[4] || '').replace(/\\040/g, ' ');
    if (!mp) return;
    const inside = dir === mp || dir.startsWith(mp.endsWith('/') ? mp : mp + '/');
    if (inside && (!best || mp.length >= best.mountPoint.length)) {
      best = { mountPoint: mp, fsType: b[0] || '', source: b[1] || '', readOnly: /(^|,)ro(,|$)/.test(a[5] || '') || /(^|,)ro(,|$)/.test(b[2] || '') };
    }
  });
  return best;
}

/** What kind of storage that is, in words */
function describeMount(m, dir) {
  if (!m) return { kind: 'unknown', text: 'Unknown storage' };
  if (m.fsType === 'overlay' || m.mountPoint === '/') return { kind: 'container', text: 'Inside the container (not a volume)' };
  if (NETWORK_FS.test(m.fsType)) return { kind: 'network', text: 'Network share (' + m.fsType + (m.source ? ', ' + m.source : '') + ')' };
  if (m.fsType === 'zfs') return { kind: 'local', text: 'ZFS dataset or volume' };
  return { kind: 'local', text: (m.mountPoint === dir ? 'Volume' : 'Disk') + ' (' + m.fsType + ')' };
}

async function checkStorage(dir, o = {}) {
  const out = { level: 'ok', path: dir, problems: [] };
  const bad = (msg) => { out.level = 'bad'; out.problems.push(msg); };
  const warn = (msg) => { if (out.level === 'ok') out.level = 'warn'; out.problems.push(msg); };
  // where is it
  let info = '';
  try { info = fs.readFileSync(o.mountinfoPath || '/proc/self/mountinfo', 'utf8'); } catch (e) { /* not Linux */ }
  const m = info ? mountFor(path.resolve(dir), info) : null;
  const d = describeMount(m, path.resolve(dir));
  out.kind = d.kind; out.where = d.text; out.fsType = m ? m.fsType : '';
  if (o.inDocker && d.kind === 'container') warn('/data is not on a volume. Settings and tokens are lost when the app is updated or recreated. Map a volume to /data in the app\'s YAML.');
  if (m && m.readOnly) bad('The storage is mounted read-only, so nothing can be saved.');
  // can it be written, read back and deleted, in time
  const t0 = Date.now(), probe = path.join(dir, '.healthcheck-' + process.pid);
  if (stuck) {
    out.writable = false;
    bad('The storage stopped answering ' + Math.round((Date.now() - stuck.since) / 1000) + ' s ago and has not come back. ' + (d.kind === 'network' ? 'The network share may be disconnected.' : 'The disk may have a problem.') + ' VoronMCP cannot save anything until it does.');
    return out;
  }
  try {
    const work = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = String(Date.now());
      await fs.promises.writeFile(probe, stamp);
      const back = await fs.promises.readFile(probe, 'utf8');
      await fs.promises.unlink(probe);
      if (back !== stamp) throw new Error('what was written did not read back the same');
    })();
    const mark = { since: Date.now() };
    work.then(() => { if (stuck === mark) stuck = null; }, () => { if (stuck === mark) stuck = null; });
    await withTimeout(work, o.timeoutMs || 5000, 'Saving a test file').catch((e) => { if (/took longer/.test(e.message)) stuck = mark; throw e; });
    out.writable = true;
    out.latencyMs = Date.now() - t0;
    if (out.latencyMs > 1500) warn('Saving is slow (' + out.latencyMs + ' ms for a tiny file). ' + (d.kind === 'network' ? 'The network share may be overloaded or the connection poor.' : 'The disk may be busy.'));
  } catch (e) {
    out.writable = false;
    const code = e.code;
    bad(code === 'EACCES' || code === 'EPERM' ? 'VoronMCP is not allowed to write to ' + dir + '. Give user 1000 write access to it (or use a Docker volume).'
      : code === 'EROFS' ? 'The storage is read-only, so nothing can be saved.'
      : code === 'ENOSPC' ? 'The storage is full.'
      : code === 'ENOENT' ? dir + ' does not exist and could not be created.'
      : code === 'EEXIST' || code === 'ENOTDIR' ? 'There is a file where the data folder ' + dir + ' should be. Check the volume mapping in the app\'s YAML.'
      : code === 'EIO' || code === 'ESTALE' || code === 'EHOSTDOWN' || code === 'ENOTCONN' ? 'The storage is not answering (' + code + '). ' + (d.kind === 'network' ? 'The network share may be disconnected.' : 'There may be a disk problem.')
      : 'Could not save a test file: ' + (e.message || code));
    try { fs.unlinkSync(probe); } catch (x) { /* never written */ }
  }
  // free space (skipped when the storage is not answering)
  if (!stuck) try {
    const s = await withTimeout(fs.promises.statfs(dir), o.timeoutMs || 5000, 'Reading free space');
    out.freeBytes = s.bavail * s.bsize; out.totalBytes = s.blocks * s.bsize;
    out.free = human(out.freeBytes);
    if (out.freeBytes < 100 * MB) bad('Only ' + out.free + ' free where VoronMCP saves. Settings and backups may fail to save.');
    else if (out.freeBytes < 1 * GB) warn('Only ' + out.free + ' free where VoronMCP saves.');
  } catch (e) { /* statfs is not everywhere */ }
  if (o.lastWriteError && Date.now() - o.lastWriteError.at < 10 * 60000 && out.writable !== true) bad('The last save failed (' + o.lastWriteError.message + ').');
  return out;
}

function readNum(p) { try { const v = fs.readFileSync(p, 'utf8').trim(); return v === 'max' ? null : Number(v); } catch (e) { return undefined; } }

function checkMemory(o = {}) {
  const root = o.cgroupRoot || '/sys/fs/cgroup';
  let limit = readNum(root + '/memory.max'), used = readNum(root + '/memory.current');
  if (used === undefined) { limit = readNum(root + '/memory/memory.limit_in_bytes'); used = readNum(root + '/memory/memory.usage_in_bytes'); }
  if (limit && limit > os.totalmem() * 4) limit = null; // "no limit" written as a huge number
  const rss = process.memoryUsage().rss;
  const out = { level: 'ok', rss, used: used || rss, limit: limit || null, hostTotal: os.totalmem(), hostFree: os.freemem(), problems: [] };
  const cap = limit || os.totalmem();
  out.pct = Math.round((out.used / cap) * 100);
  out.text = human(out.used) + ' used' + (limit ? ' of a ' + human(limit) + ' limit' : '');
  if (limit && out.pct >= 95) { out.level = 'bad'; out.problems.push('The container is at ' + out.pct + '% of its memory limit and may be stopped. Raise the limit in TrueNAS.'); }
  else if (limit && out.pct >= 85) { out.level = 'warn'; out.problems.push('The container is using ' + out.pct + '% of its memory limit.'); }
  if (!limit && os.freemem() < 0.03 * os.totalmem()) { out.level = 'warn'; out.problems.push('The server is almost out of memory (' + human(os.freemem()) + ' free).'); }
  return out;
}

function checkLoad() {
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  const load = os.loadavg()[0];
  const out = { level: 'ok', load: Math.round(load * 100) / 100, cores, problems: [], text: 'Load ' + load.toFixed(2) + ' on ' + cores + ' cores' };
  if (load > cores * 2) { out.level = 'warn'; out.problems.push('The server is very busy (load ' + load.toFixed(1) + ' on ' + cores + ' cores). Answers to Claude may be slow.'); }
  return out;
}

async function check(o) {
  const storage = await checkStorage(o.dataDir, o);
  const memory = checkMemory(o), load = checkLoad();
  const levels = [storage.level, memory.level, load.level];
  return {
    level: levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok',
    checkedAt: Date.now(), storage, memory, load,
    uptime: Math.round(process.uptime()), node: process.version
  };
}

module.exports = { check, checkStorage, checkMemory, checkLoad, mountFor, describeMount };
