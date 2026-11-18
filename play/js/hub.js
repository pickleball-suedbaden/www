// Pickleball Südbaden e.V. · session organiser · talking to a hub (hub/server.mjs), if one serves
// this page. All URLs are relative, so the app works with whatever host and port serve it.
// Without a hub the app keeps everything in this browser (store.js).

import { VERSION as SCHEMA } from './session.js';

const API = 'api/';

/** The hub's current { version, state }; 'none' when the server answers but is no hub; null when
 *  nothing answers (offline, or the hub is down). */
export async function detect(timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API + 'state', { cache: 'no-store', signal: ctl.signal });
    const doc = res.ok ? await res.json().catch(() => null) : null;
    return doc && doc.hub === true ? doc : 'none';
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write against `base`. Returns { ok, conflict, outdated, doc }; throws when the hub cannot be reached.
 * `outdated`: an app with a newer state version has written, so this page must reload first.
 */
export async function put(base, state) {
  const res = await fetch(API + 'state', {
    method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, state, schema: SCHEMA }),
  });
  const doc = await res.json().catch(() => null);
  return { ok: res.ok, conflict: res.status === 409, outdated: res.status === 426, doc };
}

export async function end(base) {
  const res = await fetch(API + 'state?base=' + base, { method: 'DELETE', cache: 'no-store' });
  const doc = await res.json().catch(() => null);
  return { ok: res.ok, conflict: res.status === 409, doc };
}

/** Follow the hub: onDoc({ version, state }) for every version, onStatus(true|false) for the link. */
export function follow(onDoc, onStatus) {
  const es = new EventSource(API + 'events');
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false); // EventSource reconnects by itself
  es.onmessage = (e) => { try { onDoc(JSON.parse(e.data)); } catch (err) { /* ignore a broken message */ } };
  return es;
}

const FLAG = 'pbsb-play-hub';
export function remembered() { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } }
export function remember() { try { localStorage.setItem(FLAG, '1'); } catch (e) { /* ignore */ } }
export function forget() { try { localStorage.removeItem(FLAG); } catch (e) { /* ignore */ } }
