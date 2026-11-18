// Tests for the hub (hub/server.mjs): versioned writes, conflicts, events, restart, static files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsb-hub-'));
const DATA = path.join(dir, 'session.json');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function start() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hub/server.mjs')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PLAY_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)\/play\//);
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
    child.on('exit', (code) => reject(new Error('hub exited ' + code + ' ' + out)));
  });
}
const stop = (h) => new Promise((r) => { h.child.removeAllListeners('exit'); h.child.on('exit', r); h.child.kill('SIGTERM'); });
const put = (h, base, state) => fetch(h.base + '/play/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, state }) });

test('versioned writes, conflicts, events and a restart', async () => {
  let h = await start();
  try {
    let doc = await (await fetch(h.base + '/play/api/state')).json();
    assert.equal(doc.hub, true);
    assert.equal(doc.version, 0);
    assert.equal(doc.state, null);

    // An event stream sees every new version.
    const ctl = new AbortController();
    const res = await fetch(h.base + '/play/api/events', { signal: ctl.signal });
    const reader = res.body.getReader();
    const seen = [];
    const reading = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/data: (.*)\n\n/g)) seen.push(JSON.parse(m[1]).version);
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      }
    })();

    let r = await put(h, 0, { players: ['F1'] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).version, 1);
    // A second device wrote on the old version: conflict, and it gets the current state back.
    r = await put(h, 0, { players: ['M1'] });
    assert.equal(r.status, 409);
    doc = await r.json();
    assert.deepEqual(doc, { hub: true, version: 1, state: { players: ['F1'] } });
    // It re-applies its change to the current state and retries.
    r = await put(h, doc.version, { players: [...doc.state.players, 'M1'] });
    assert.equal(r.status, 200);
    await new Promise((res2) => setTimeout(res2, 200));
    ctl.abort();
    await reading;
    assert.deepEqual(seen, [0, 1, 2]);
  } finally {
    await stop(h);
  }
  // A restart keeps the session.
  h = await start();
  try {
    const doc = await (await fetch(h.base + '/play/api/state')).json();
    assert.equal(doc.version, 2);
    assert.deepEqual(doc.state.players, ['F1', 'M1']);
    // Ending the session follows the same version rule.
    assert.equal((await fetch(h.base + '/play/api/state?base=1', { method: 'DELETE' })).status, 409);
    const end = await fetch(h.base + '/play/api/state?base=2', { method: 'DELETE' });
    assert.equal(end.status, 200);
    assert.equal((await end.json()).state, null);
  } finally {
    await stop(h);
  }
});

test('a page running older files cannot overwrite what a newer app wrote', async () => {
  const h = await start();
  try {
    const send = (base, state, schema) => fetch(h.base + '/play/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schema === undefined ? { base, state } : { base, state, schema }) });
    let v = (await (await fetch(h.base + '/play/api/state')).json()).version;
    let r = await send(v, { old: true });               // an old app sends no schema: fine while nobody newer wrote
    assert.equal(r.status, 200); v++;
    r = await send(v, { groups: true }, 2);
    assert.equal(r.status, 200); v++;
    r = await send(v, { old: true });                   // now the old app is refused …
    assert.equal(r.status, 426);
    const doc = await r.json();
    assert.equal(doc.version, v);
    assert.deepEqual(doc.state, { groups: true }, '… and nothing changed');
    r = await send(v, { groups: true, more: 1 }, 2);   // the current app still writes
    assert.equal(r.status, 200); v++;
    r = await fetch(h.base + '/play/api/state?base=' + v, { method: 'DELETE' });
    assert.equal(r.status, 200); v++;
    assert.equal((await send(v, { old: true })).status, 426, 'ending the session does not let old pages back in');
  } finally { await stop(h); }
  const h2 = await start();                              // the rule survives a restart
  try {
    const v = (await (await fetch(h2.base + '/play/api/state')).json()).version;
    const r = await fetch(h2.base + '/play/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: v, state: { old: true } }) });
    assert.equal(r.status, 426);
  } finally { await stop(h2); }
});

test('static files: the site yes, dotfiles and repository folders no', async () => {
  const h = await start();
  try {
    const page = await fetch(h.base + '/play/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(h.base + '/play')).status, 200, 'redirects to /play/');
    assert.match((await fetch(h.base + '/play/js/draw.js')).headers.get('content-type'), /javascript/);
    for (const bad of ['/.git/config', '/.gitignore', '/play/.hidden', '/hub/server.mjs', '/tests/hub.test.mjs', '/%2e%2e/etc/passwd', '/play/..%2f..%2fetc/passwd']) {
      assert.equal((await fetch(h.base + bad)).status, 404, bad);
    }
  } finally {
    await stop(h);
  }
});
