// Pickleball Südbaden e.V. · session organiser · storage on this device and sync between windows.
// Everything lives in localStorage under two keys. Nothing is ever sent anywhere.
// Windows of the same browser on the same device follow each other through BroadcastChannel
// (with the storage event as a fallback): a projector window shows what the control window does.

const KEY = 'pbsb-play-session';
const LANG_KEY = 'pbsb-play-lang';
const CHANNEL = 'pbsb-play';

let channel = null;
try { channel = new BroadcastChannel(CHANNEL); } catch (e) { channel = null; }

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked: keep running in memory */ }
  if (channel) channel.postMessage({ type: 'state' });
}

export function loadLang() {
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'de'; } catch (e) { return 'de'; }
}

export function saveLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
  if (channel) channel.postMessage({ type: 'lang' });
}

/** Delete everything the tool stored on this device. */
export function wipe() {
  try { localStorage.removeItem(KEY); localStorage.removeItem(LANG_KEY); } catch (e) { /* ignore */ }
  if (channel) channel.postMessage({ type: 'wipe' });
}

/** Call `fn(type)` when another window of this tool changed the stored state. */
export function subscribe(fn) {
  if (channel) channel.addEventListener('message', (e) => fn(e.data && e.data.type));
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) fn('state');
    else if (e.key === LANG_KEY) fn('lang');
  });
}
