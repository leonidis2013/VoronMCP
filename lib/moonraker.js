/*
 * Talks to the printer through Moonraker's own HTTP API (the same one Mainsail and Fluidd
 * use). Nothing is installed on the printer. An API key is only needed when Moonraker
 * does not trust VoronMCP's address (trusted_clients in moonraker.conf).
 *
 * Every call is one HTTP request; there is no WebSocket to keep alive.
 */
'use strict';

const MAX_DOWNLOAD = 64 * 1024 * 1024;

class MoonrakerError extends Error {
  constructor(message, status, code) { super(message); this.status = status || 0; this.code = code || ''; }
}

/** opts.getUrl() -> "http://192.168.1.50:7125", opts.getKey() -> API key or '' */
function create(opts) {
  const base = () => String(opts.getUrl() || '').replace(/\/+$/, '');
  const configured = () => !!base();

  function headers(extra) {
    const h = Object.assign({ accept: 'application/json', 'user-agent': 'VoronMCP' }, extra || {});
    const k = opts.getKey && opts.getKey();
    if (k) h['x-api-key'] = k;
    return h;
  }

  function qs(query) {
    if (!query) return '';
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      // Moonraker object queries use bare keys (?toolhead&extruder=temperature,target)
      parts.push(v === '' ? encodeURIComponent(k) : encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function explain(e, what) {
    if (e instanceof MoonrakerError) return e;
    const code = (e.cause && e.cause.code) || e.code || '';
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return new MoonrakerError(what + ' took too long (no answer from Moonraker)', 0, 'timeout');
    if (/bad port/i.test(String(e.cause && e.cause.message))) return new MoonrakerError('That port cannot be used from here; Moonraker usually listens on 7125', 0, 'bad_port');
    if (code === 'ECONNREFUSED') return new MoonrakerError('Moonraker refused the connection at ' + base() + ' (is it running, and is the port right? It is usually 7125)', 0, code);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new MoonrakerError('Could not find ' + base() + '. Use the printer\'s IP address; .local names usually do not work inside a container', 0, code);
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return new MoonrakerError('Could not reach ' + base() + ' (is the printer on and on this network?)', 0, code);
    return new MoonrakerError(what + ' failed: ' + (code || e.message), 0, code);
  }

  async function raw(method, path, { query, body, form, timeoutMs = 15000, binary = false, maxBytes = MAX_DOWNLOAD } = {}) {
    if (!configured()) throw new MoonrakerError('The printer is not set up yet: enter its Moonraker address on the VoronMCP page', 0, 'not_configured');
    const url = base() + path + qs(query);
    const init = { method, headers: headers(), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' };
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, init); } catch (e) { throw explain(e, method + ' ' + path); }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) { try { res.body && res.body.cancel(); } catch (e) { /* fine */ } throw new MoonrakerError(path + ' is larger than ' + Math.round(maxBytes / 1048576) + ' MB', 413, 'too_large'); }
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch (e) { throw explain(e, method + ' ' + path); }
    if (buf.length > maxBytes) throw new MoonrakerError(path + ' is larger than ' + Math.round(maxBytes / 1048576) + ' MB', 413, 'too_large');
    if (!res.ok) {
      let msg = '';
      try { const j = JSON.parse(buf.toString('utf8')); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { msg = buf.toString('utf8').slice(0, 300); }
      if (res.status === 401 || res.status === 403) msg = 'Moonraker refused VoronMCP (' + res.status + '). Add an API key on the VoronMCP page, or add VoronMCP\'s address to trusted_clients in moonraker.conf' + (msg ? ' (' + msg + ')' : '');
      throw new MoonrakerError(String(msg || 'HTTP ' + res.status), res.status, 'http_' + res.status);
    }
    if (binary) return { buf, type: res.headers.get('content-type') || '' };
    const text = buf.toString('utf8');
    if (!text) return null;
    let j;
    try { j = JSON.parse(text); } catch (e) { return text; }
    return j && Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : j;
  }

  const get = (path, query, o) => raw('GET', path, Object.assign({ query }, o || {}));
  const post = (path, body, o) => raw('POST', path, Object.assign({ body }, o || {}));
  const del = (path, query, o) => raw('DELETE', path, Object.assign({ query }, o || {}));

  const filePath = (root, p) => '/server/files/' + encodeURIComponent(root) + '/' + String(p).split('/').map(encodeURIComponent).join('/');

  /** A file's text from a Moonraker root (config, logs, gcodes). */
  async function download(root, p, o) {
    const r = await raw('GET', filePath(root, p), Object.assign({ binary: true, timeoutMs: 60000 }, o || {}));
    return r.buf.toString('utf8');
  }
  /** Writes a file into a root (config by default), replacing it. */
  async function upload(root, p, text) {
    const i = String(p).lastIndexOf('/');
    const dir = i >= 0 ? p.slice(0, i) : '', name = i >= 0 ? p.slice(i + 1) : p;
    const form = new FormData();
    form.append('root', root);
    if (dir) form.append('path', dir);
    form.append('file', new Blob([text], { type: 'text/plain' }), name);
    return raw('POST', '/server/files/upload', { form, timeoutMs: 60000 });
  }
  const remove = (root, p) => raw('DELETE', filePath(root, p));
  /** An image from the printer's network (a webcam snapshot). Relative URLs are on Moonraker's host. */
  async function fetchImage(url, maxBytes) {
    let u;
    try { u = new URL(url, base()); } catch (e) { throw new MoonrakerError('Bad snapshot address: ' + url); }
    // only the printer's own host, so a webcam entry cannot make VoronMCP fetch something elsewhere
    const host = new URL(base()).hostname;
    if (u.hostname !== host) throw new MoonrakerError('The snapshot address points at another machine (' + u.hostname + '); only the printer\'s own host is fetched');
    if (!/^https?:$/.test(u.protocol)) throw new MoonrakerError('The snapshot address is not http');
    let res;
    try { res = await fetch(u, { headers: { 'user-agent': 'VoronMCP' }, signal: AbortSignal.timeout(10000), redirect: 'error' }); } catch (e) { throw explain(e, 'Webcam snapshot'); }
    if (!res.ok) throw new MoonrakerError('The webcam answered ' + res.status, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > (maxBytes || 4 * 1048576)) throw new MoonrakerError('The snapshot is too large');
    return { buf, type: (res.headers.get('content-type') || 'image/jpeg').split(';')[0] };
  }

  /** Moonraker object query: names like ['toolhead', 'extruder'] or { extruder: 'temperature,target' }. */
  async function query(objects) {
    const q = {};
    if (Array.isArray(objects)) objects.forEach((o) => { q[o] = ''; });
    else Object.entries(objects || {}).forEach(([k, v]) => { q[k] = v == null || v === true ? '' : Array.isArray(v) ? v.join(',') : String(v); });
    const r = await get('/printer/objects/query', q);
    return (r && r.status) || {};
  }

  /** G-code through Moonraker. It answers when Klipper has finished the script. */
  const gcode = (script, timeoutMs) => post('/printer/gcode/script', { script }, { timeoutMs: timeoutMs || 30 * 60e3 });

  return { configured, base, get, post, del, download, upload, remove, query, gcode, fetchImage, reset: () => {} };
}

module.exports = { create, MoonrakerError };
