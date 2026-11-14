#!/usr/bin/env node
// Pickleball Südbaden e.V. · session organiser hub.
// One small server, no dependencies (Node 20+). It serves the site's static files and holds the one
// shared session, so several devices on the same network (an iPad checking players in, a laptop
// driving the projector) work on the same state.
//
//   node hub/server.mjs
//
// Settings (environment variables, defaults in brackets):
//   PORT       port to listen on                        [15120]
//   HOST       bind address                             [0.0.0.0]
//   PLAY_ROOT  folder with the site's static files      [the folder above hub/]
//   PLAY_DATA  JSON file that keeps the session         [~/.local/share/pbsb-play/session.json]
//
// API (relative to /play/, so the app needs no host name):
//   GET    /play/api/state   -> { hub: true, version, state }
//   PUT    /play/api/state   body { base, state } -> 200 { version, state } if base is the current
//                            version, else 409 with the current { version, state }
//   DELETE /play/api/state?base=N -> ends the session (state null), same version rule
//   GET    /play/api/events  -> server-sent events; every new { version, state } is pushed

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 15120);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.PLAY_ROOT || path.join(HERE, '..'));
const DATA = path.resolve(process.env.PLAY_DATA || path.join(os.homedir(), '.local', 'share', 'pbsb-play', 'session.json'));
const MAX_BODY = 2 * 1024 * 1024;
// Folders of the repository that are not part of the site.
const PRIVATE_TOP = new Set(['hub', 'tests', 'tmp', 'node_modules']);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// ---------- the session ----------

let doc = { version: 0, state: null };
try {
  const saved = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (saved && Number.isInteger(saved.version)) doc = { version: saved.version, state: saved.state ?? null };
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`Could not read ${DATA} (${e.message}); starting with an empty session.`);
}

let writing = Promise.resolve();
function persist() {
  const body = JSON.stringify(doc);
  writing = writing.then(async () => {
    await fsp.mkdir(path.dirname(DATA), { recursive: true });
    const tmp = DATA + '.tmp';
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, DATA);
  }).catch((e) => console.error('Could not save the session:', e.message));
  return writing;
}

const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(doc)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 15000).unref();

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const json = (res, status, obj) => send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- API ----------

async function api(req, res, url) {
  const route = url.pathname.slice('/play/api/'.length);
  if (route === 'state' && req.method === 'GET') return json(res, 200, { hub: true, ...doc });
  if (route === 'state' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.status || 400, { error: 'bad request' }); }
    if (!body || !Number.isInteger(body.base) || typeof body.state !== 'object' || body.state === null) return json(res, 400, { error: 'bad request' });
    if (body.base !== doc.version) return json(res, 409, { hub: true, ...doc });
    doc = { version: doc.version + 1, state: body.state };
    await persist();
    broadcast();
    return json(res, 200, { hub: true, ...doc });
  }
  if (route === 'state' && req.method === 'DELETE') {
    const base = Number(url.searchParams.get('base'));
    if (base !== doc.version) return json(res, 409, { hub: true, ...doc });
    doc = { version: doc.version + 1, state: null };
    await persist();
    broadcast();
    return json(res, 200, { hub: true, ...doc });
  }
  if (route === 'events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(doc)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- static files ----------

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
  const parts = rel.split('/').filter(Boolean);
  // Never dotfiles or dot-folders (.git, .claude …), never the repository's own folders.
  if (parts.some((p) => p.startsWith('.') || p.includes('\\')) || PRIVATE_TOP.has(parts[0])) return send(res, 404, 'Not found');
  let file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 404, 'Not found');
  if (file === DATA || file === DATA + '.tmp') return send(res, 404, 'Not found');
  let stat;
  try { stat = await fsp.stat(file); } catch (e) { return send(res, 404, 'Not found'); }
  if (stat.isDirectory()) {
    if (!rel.endsWith('/')) return send(res, 301, '', { Location: rel + '/' + url.search });
    file = path.join(file, 'index.html');
    try { stat = await fsp.stat(file); } catch (e) { return send(res, 404, 'Not found'); }
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://hub');
    if (url.pathname.startsWith('/play/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error');
  }
});

function addresses(port) {
  const list = [`http://localhost:${port}/play/   (on this computer)`];
  let local = '';
  if (process.platform === 'darwin') {
    try { local = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch (e) { local = ''; }
  }
  if (local && ['0.0.0.0', '::', ''].includes(HOST)) list.push(`http://${local}.local:${port}/play/`);
  if (!['0.0.0.0', '::', ''].includes(HOST)) return list; // bound to one address: no network addresses
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) list.push(`http://${n.address}:${port}/play/`);
  }
  return list;
}

server.listen(PORT, HOST, () => {
  console.log('Spieltreff hub is running.');
  console.log(`Session file: ${DATA} (version ${doc.version}${doc.state ? '' : ', empty'})`);
  console.log('Open on the devices:');
  for (const a of addresses(server.address().port)) console.log('  ' + a);
  console.log('Stop with Ctrl+C.');
});

function stop() {
  for (const res of clients) res.end();
  server.close(() => writing.then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
