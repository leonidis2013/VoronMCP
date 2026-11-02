/*
 * Before Claude changes or deletes a config file (or runs SAVE_CONFIG, which rewrites
 * printer.cfg), the current version is copied here:
 *   <data>/backups/config/<file name, encoded>/<date-time>-<reason>.json
 * Each backup holds { alias (the file path), content (the text) }.
 * The newest few per file are kept. Restoring one writes it back through Moonraker.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KINDS = ['config'];
const FILE_RE = /^\d{8}-\d{6}(-\d+)?-[a-z-]{1,30}\.json$/;
const enc = (id) => Buffer.from(String(id), 'utf8').toString('base64url');
const dec = (s) => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch (e) { return null; } };

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function create({ dir, keep }) {
  const ok = (kind, id) => KINDS.includes(kind) && typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('\0');

  function save(kind, id, config, reason) {
    if (!ok(kind, id)) throw new Error('Cannot back up ' + kind + ' "' + id + '": unexpected name');
    reason = String(reason || 'change').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 30) || 'change';
    const folder = path.join(dir, kind, enc(id));
    fs.mkdirSync(folder, { recursive: true });
    const base = stamp(new Date());
    let file = base + '-' + reason + '.json';
    for (let n = 2; fs.existsSync(path.join(folder, file)); n++) file = base + '-' + n + '-' + reason + '.json';
    const body = { kind, id: String(id), savedAt: new Date().toISOString(), reason, config };
    fs.writeFileSync(path.join(folder, file), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    prune(folder);
    return file;
  }

  function prune(folder) {
    const max = Math.max(1, Number(typeof keep === 'function' ? keep() : keep) || 30);
    const files = fs.readdirSync(folder).filter((f) => FILE_RE.test(f)).sort().reverse();
    files.slice(max).forEach((f) => { try { fs.unlinkSync(path.join(folder, f)); } catch (e) { /* gone */ } });
  }

  function list() {
    const out = [];
    for (const kind of KINDS) {
      let ids = [];
      try { ids = fs.readdirSync(path.join(dir, kind)); } catch (e) { continue; }
      for (const folder of ids) {
        const id = dec(folder);
        if (!id || !ok(kind, id) || enc(id) !== folder) continue;
        let files = [];
        try { files = fs.readdirSync(path.join(dir, kind, folder)).filter((f) => FILE_RE.test(f)); } catch (e) { continue; }
        for (const file of files) {
          const b = read(kind, id, file);
          if (!b) continue;
          const c = b.config || {};
          out.push({ kind, id, file, savedAt: b.savedAt, reason: b.reason, alias: String(c.alias || id).slice(0, 120), size: typeof c.content === 'string' ? c.content.length : 0 });
        }
      }
    }
    return out.sort((a, b) => (b.savedAt > a.savedAt ? 1 : b.savedAt < a.savedAt ? -1 : 0));
  }

  function filePath(kind, id, file) {
    if (!ok(kind, id) || !FILE_RE.test(String(file))) return null;
    const p = path.join(dir, kind, enc(id), String(file));
    return fs.existsSync(p) ? p : null;
  }

  function read(kind, id, file) {
    const p = filePath(kind, id, file);
    if (!p) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  return { save, list, read, filePath };
}

module.exports = { create };
