// Pickleball Südbaden e.V. · session organiser · the user interface.
// State rules live in session.js and the draw in draw.js; this file only renders and reacts.
// Views (location hash): #checkin #board #rounds #settings #rules #signs, and #display for a
// projector window that follows the control window without controls and without sound.

import * as S from './session.js';
import { t, setLang, getLang, STRINGS } from './i18n.js';
import * as store from './store.js';
import * as hub from './hub.js';
import { unlockAudio, audioReady, play } from './audio.js';

const DISPLAY = location.hash === '#display';
const VIEWS = ['checkin', 'board', 'rounds', 'settings', 'rules', 'signs'];
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = store.load() || S.createState();
let route = DISPLAY ? 'display' : (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'checkin');
setLang(store.loadLang());

// ---------- saving ----------

// Two modes, one code path for changes:
// - local: the state lives in this browser (store.js); other windows follow over BroadcastChannel.
// - hub:   a hub (hub/server.mjs) served this page and holds the one shared state. Each change is
//          sent with the version it was made on; after a conflict it is re-applied to the newer
//          version. Without a link to the hub, changes are refused so devices never drift apart.
// Every change goes through update(fn). fn(state) must only depend on the state it is given, so it
// can be re-applied.

class Refused extends Error {}
let hubMode = false, linked = false, server = { version: 0, state: null }, pending = [], flushing = false;
const clone = (o) => JSON.parse(JSON.stringify(o));
const fresh = (doc) => (doc && doc.state ? clone(doc.state) : S.createState(1000 + (doc ? doc.version : 0)));

function update(fn, { plan = true } = {}) {
  const step = (s) => { const r = fn(s); if (plan) S.ensurePlan(s); return r; };
  if (!hubMode) {
    const res = step(state);
    store.save(state);
    render();
    return res;
  }
  if (!linked) { toast(t('hubRefused')); render(); throw new Refused(); }
  const res = step(state);          // show it at once …
  pending.push(step);               // … and send it to the hub
  flush();
  render();
  return res;
}

/** What this device shows in hub mode: the hub's state plus changes still on their way. */
function shown() {
  const s = fresh(server);
  for (const f of pending) f(s);
  return s;
}

async function flush() {
  if (flushing) return;
  flushing = true;
  while (pending.length && linked) {
    const next = fresh(server);
    pending[0](next);
    if (server.state && JSON.stringify(next) === JSON.stringify(server.state)) { pending.shift(); continue; }
    let res;
    try { res = await hub.put(server.version, next); } catch (e) { res = null; }
    if (res && res.ok && res.doc) { server = { version: res.doc.version, state: res.doc.state }; pending.shift(); }
    else if (res && res.conflict && res.doc) { server = { version: res.doc.version, state: res.doc.state }; } // re-apply on the newer version
    else { pending = []; setLinked(false); toast(t('hubLost')); }
  }
  flushing = false;
  state = shown();
  render();
}

function setLinked(on) {
  if (linked === on) return;
  linked = on;
  if (on) flush();
  render();
}

function startHub(doc) {
  hubMode = true;
  hub.remember();
  if (doc) server = { version: doc.version, state: doc.state };
  state = shown();
  hub.follow((d) => {
    if (d.version < server.version) return;
    if (d.version > server.version && d.state === null && server.state !== null) resetLocalUi(); // the session was ended elsewhere
    server = { version: d.version, state: d.state };
    state = shown();
    render();
  }, setLinked);
}

function resetLocalUi() { lastIn = null; ciSex = ''; ciName = ''; ciExpected = null; swapSel = null; }

// Check-in stays instant: the plan catches up a moment after the last tap.
let planTimer = 0;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    if (!S.ensurePlan(clone(state))) return;
    try { update((s) => S.ensurePlan(s), { plan: false }); } catch (e) { /* not linked: the hub plans later */ }
  }, 600);
}

store.subscribe((type) => {
  if (type === 'lang') { setLang(store.loadLang()); render(); return; }
  if (hubMode) return; // the hub is the source of truth
  if (type === 'wipe') { state = S.createState(); setLang('de'); resetLocalUi(); }
  else state = store.load() || S.createState();
  render();
});

// ---------- small UI pieces ----------

const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, action) {
  toastEl.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button" class="t-act">${esc(action.label)}</button>` : '');
  toastEl.hidden = false;
  if (action) $('.t-act', toastEl).onclick = () => { toastEl.hidden = true; action.fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 6000 : 3500);
}

const dlg = $('#dlg');
function openDialog(html, onClick) {
  dlg.innerHTML = html;
  dlg.onclick = (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const b = e.target.closest('[data-d]');
    if (b) Promise.resolve().then(() => onClick(b.dataset.d, b, e)).catch((err) => { if (!(err instanceof Refused)) throw err; });
  };
  if (!dlg.open) dlg.showModal();
}

/** In-app confirmation (never the browser's confirm()). */
function confirmBox(text, okLabel, danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    openDialog(`<p class="d-text">${esc(text)}</p>
      <div class="d-btns"><button type="button" class="btn btn-quiet" data-d="no">${esc(t('cancel'))}</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-navy'}" data-d="yes">${esc(okLabel)}</button></div>`,
    (d) => finish(d === 'yes'));
    dlg.addEventListener('close', () => finish(false), { once: true });
  });
}

const roundName = (idx) => {
  const l = S.roundLabel(state, idx);
  return l.warmup ? t('warmup') : t('roundN', { n: l.n });
};
const playerById = (id) => S.byId(state, id) || { code: '?', name: '' };
const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// ---------- courts (board, rounds view, print) ----------

function personHtml(id, { roundIdx = -1, swappable = false } = {}) {
  const p = playerById(id);
  const gone = p.status === 'gone' && !DISPLAY ? ' is-gone' : '';
  const sel = swapSel && swapSel.round === roundIdx && swapSel.id === id ? ' is-sel' : '';
  const inner = `<span class="p-code">${esc(p.code)}</span><span class="p-name">${esc(p.name) || '&nbsp;'}</span>`;
  if (swappable) return `<button type="button" class="person${gone}${sel}" data-act="swap" data-round="${roundIdx}" data-id="${esc(id)}">${inner}</button>`;
  return `<span class="person${gone}">${inner}</span>`;
}

function courtsHtml(round, idx, opts = {}) {
  if (!round) return '';
  const courts = round.courts.map((c, k) => `
    <li class="court">
      <div class="c-num"><span class="c-word">${esc(t('court'))}</span> ${k + 1}</div>
      <div class="team">${personHtml(c[0], { roundIdx: idx, ...opts })}${personHtml(c[1], { roundIdx: idx, ...opts })}</div>
      <div class="vs">${esc(t('versus'))}</div>
      <div class="team">${personHtml(c[2], { roundIdx: idx, ...opts })}${personHtml(c[3], { roundIdx: idx, ...opts })}</div>
    </li>`).join('');
  const sit = round.sitOut.length
    ? `<div class="sit"><span class="sit-label">${esc(t('sittingOut'))}</span>${round.sitOut.slice().sort(byCode).map((id) => personHtml(id, { roundIdx: idx, ...opts })).join('')}</div>`
    : '';
  const n = round.courts.length;
  const cols = n <= 5 ? n : Math.ceil(n / 2);
  return `<ol class="courts" style="--n:${n};--cols:${cols}">${courts}</ol>${sit}`;
}

function byCode(a, b) {
  const A = playerById(a).code, B = playerById(b).code;
  return A[0] === B[0] ? parseInt(A.slice(1), 10) - parseInt(B.slice(1), 10) : A.localeCompare(B);
}

// ---------- board ----------

let lastBoardHtml = '';
function boardHtml(now) {
  const v = S.view(state, now);
  const display = DISPLAY;
  let label = '', phase = '', msg = '', banner = '', round = null, idx = -1;

  if (v.phase === 'idle') {
    round = v.next; idx = v.nextIdx;
    label = round ? roundName(idx) : '';
    phase = t('phaseIdle');
    msg = round && display ? t('nextFrom', { round: roundName(idx) }) : '';
  } else if (v.phase === 'play') {
    label = roundName(v.currentIdx);
    phase = v.paused ? t('paused') : t('phasePlay');
    if (v.showNext) { round = v.next; idx = v.nextIdx; banner = t('nextFrom', { round: roundName(v.nextIdx) }); }
    else { round = v.current; idx = v.currentIdx; }
  } else if (v.phase === 'change') {
    round = v.next; idx = v.nextIdx;
    label = t('phaseChange');
    phase = v.paused ? t('paused') : '';
    const sinceHorn = now - state.timer.playEnd;
    msg = sinceHorn < 20000 && !v.paused ? t('hornText') : t('startsIn', { round: roundName(v.nextIdx) });
    banner = t('next') + ': ' + roundName(v.nextIdx);
  } else if (v.phase === 'done') {
    label = t('phaseDone');
    msg = t('sessionDone');
  }

  const cls = ['board', 'ph-' + v.phase, v.paused ? 'is-paused' : '', v.showNext || v.phase === 'change' ? 'is-next' : '', display ? 'is-display' : ''].join(' ');
  const courts = round ? courtsHtml(round, idx) : (v.phase === 'done' ? '' : `<p class="b-empty">${esc(t('noRounds'))}</p>`);
  const sample = state.sample && display ? `<span class="b-sample">${esc(t('sample'))}</span>` : '';

  let ctrl = '';
  if (!display) {
    const b = (act, text, cls2 = 'btn-quiet') => `<button type="button" class="btn ${cls2}" data-act="${act}">${esc(text)}</button>`;
    const parts = [];
    if (v.phase === 'idle' && v.next) parts.push(b('start', t('startRound', { round: roundName(v.nextIdx) }), 'btn-go'));
    if (v.phase === 'done') parts.push(b('addRound', t('addRound'), 'btn-navy'));
    if (v.phase === 'play' || v.phase === 'change') {
      parts.push(v.paused ? b('resume', t('resume'), 'btn-go') : b('pause', t('pause')));
      parts.push(b('plus', t('plusMinute')));
      parts.push(b('skip', t('skip')));
    }
    parts.push(b('projector', t('projector')));
    ctrl = `<div class="b-ctrl">${parts.join('')}</div>`;
  }
  const fs = display && document.fullscreenEnabled ? `<button type="button" class="b-fs" data-act="fullscreen" aria-label="${esc(t('fullscreen'))}">⛶</button>` : '';

  return `<section class="${cls}">
    <div class="b-head">
      <div class="b-title"><span class="b-label">${esc(label)}</span>${phase ? `<span class="b-phase">${esc(phase)}</span>` : ''}${sample}</div>
      <div class="b-clock" data-clock>${esc(clockText(v))}</div>
      ${msg ? `<div class="b-msg">${esc(msg)}</div>` : ''}
    </div>
    ${banner ? `<div class="b-banner">${esc(banner)}</div>` : ''}
    <div class="b-body">${courts}</div>
    ${ctrl}${fs}
    <p class="b-sound" data-sound hidden></p>
  </section>`;
}

function clockText(v) {
  if (v.phase === 'play' || v.phase === 'change') return fmt(v.remaining);
  if (v.phase === 'idle') {
    const r = v.next;
    return r ? fmt((r.warmup ? state.settings.warmupMin : state.settings.gameMin) * 60000) : '';
  }
  return '';
}

function renderBoard(main, now) {
  const html = boardHtml(now);
  const key = html.replace(/<div class="b-clock" data-clock>[^<]*<\/div>/, '');
  if (key !== lastBoardHtml || !main.querySelector('.board')) { main.innerHTML = html; lastBoardHtml = key; }
  else { const c = main.querySelector('[data-clock]'); const txt = clockText(S.view(state, now)); if (c.textContent !== txt) c.textContent = txt; }
  const note = main.querySelector('[data-sound]');
  if (note && !DISPLAY) {
    const msg = !soundOn() ? t('soundDeviceOff') : !soundLeader ? t('soundElsewhere') : !audioReady() ? t('soundOff') : '';
    note.hidden = !msg; note.textContent = msg;
  }
}

// ---------- check-in ----------

let ciSex = '', ciName = '', ciExpected = null, lastIn = null;

function checkinHtml() {
  const c = S.counts(state);
  const here = state.players.filter((p) => p.status === 'here').slice().reverse();
  const gone = state.players.filter((p) => p.status === 'gone');
  const expected = state.players.filter((p) => p.status === 'expected');
  const exp = ciExpected ? S.byId(state, ciExpected) : null;
  const lvl = (n) => `<button type="button" class="ci-level" data-act="level" data-level="${n}"><span class="ci-ln">${n}</span>${esc(t('level' + n))}</button>`;
  const sex = (k) => `<button type="button" class="ci-sex" data-act="sex" data-sex="${k}" aria-pressed="${ciSex === k}"><span class="ci-sx">${k}</span>${esc(t('sex' + k))}</button>`;
  const row = (p) => `<li><button type="button" class="pl-row" data-act="editPlayer" data-id="${p.id}">
      <span class="pl-code">${esc(p.code || '·')}</span><span class="pl-name">${esc(p.name)}</span><span class="pl-lvl">${p.level ? esc(t('level' + p.level + 'Short')) : ''}</span></button></li>`;
  return `<section class="ci">
    <p class="ci-counts">
      <span><b>${c.F}</b> ${esc(t('countsWomen'))}</span><span><b>${c.M}</b> ${esc(t('countsMen'))}</span><span><b>${c.X}</b> ${esc(t('countsEither'))}</span>
      <span><b>${c.courts}</b> ${esc(t('countsCourts'))}</span><span><b>${c.sitting}</b> ${esc(t('countsSitting'))}</span>
      ${c.expected ? `<span><b>${c.expected}</b> ${esc(t('countsExpected'))}</span>` : ''}
    </p>
    ${lastIn ? `<div class="ci-last"><span class="ci-lcode">${esc(lastIn.code)}</span><span class="ci-lname">${esc(lastIn.name)} ${esc(t('checkedIn'))}</span>
      <button type="button" class="btn btn-quiet" data-act="undoIn">${esc(t('undo'))}</button><button type="button" class="btn btn-quiet" data-act="editLast">${esc(t('edit'))}</button></div>` : ''}
    ${exp ? `<p class="ci-selected">${esc(t('selectedName', { name: exp.name }))} <button type="button" class="link" data-act="clearExp">${esc(t('clearSelection'))}</button></p>`
      : `<label class="ci-field"><span>${esc(t('nameLabel'))}</span><input id="ciName" type="text" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24" placeholder="${esc(t('namePlaceholder'))}" value="${esc(ciName)}"></label>`}
    <div class="ci-sexes" role="group" aria-label="${esc(t('sexLabel'))}">${sex('F')}${sex('M')}${sex('X')}</div>
    <p class="ci-hint">${esc(t('levelLabel'))}</p>
    <div class="ci-levels ${ciSex ? '' : 'is-waiting'}">${lvl(1)}${lvl(2)}${lvl(3)}</div>
    ${expected.length ? `<h2 class="ci-h">${esc(t('expectedTitle'))} <small>${esc(t('expectedHint'))}</small></h2>
      <div class="ci-exp">${expected.map((p) => `<button type="button" class="chip${p.id === ciExpected ? ' is-on' : ''}" data-act="pickExp" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    <p><button type="button" class="btn btn-quiet" data-act="paste">${esc(t('pasteNames'))}</button></p>
    <h2 class="ci-h">${esc(t('playersTitle'))} (${here.length})</h2>
    ${here.length ? `<ul class="pl">${here.map(row).join('')}</ul>` : `<p class="muted">${esc(t('noPlayers'))}</p>`}
    ${gone.length ? `<h2 class="ci-h">${esc(t('goneTitle'))} (${gone.length})</h2><ul class="pl is-gone">${gone.map(row).join('')}</ul>` : ''}
  </section>`;
}

function doCheckIn(level) {
  if (!ciSex) { toast(t('pickSexFirst')); return; }
  const nameInput = $('#ciName');
  if (nameInput) ciName = nameInput.value;
  const entry = { sex: ciSex, level, name: ciExpected ? '' : ciName, id: ciExpected };
  const wasExpected = !!ciExpected;
  const p = update((s) => S.checkIn(s, entry), { plan: false }); // throws if a hub refuses it
  ciSex = ''; ciName = ''; ciExpected = null;
  lastIn = { id: p.id, code: p.code, name: p.name, wasExpected };
  render();
  schedulePlan();
  if (navigator.vibrate) navigator.vibrate(30);
}

function editPlayer(id) {
  const p = S.byId(state, id);
  if (!p) return;
  const draft = { sex: p.sex, level: p.level, name: p.name };
  const draw = () => openDialog(`<h2 class="d-h">${esc(t('editTitle', { code: p.code || p.name }))}</h2>
    <label class="ci-field"><span>${esc(t('editName'))}</span><input id="edName" type="text" maxlength="24" value="${esc(draft.name)}"></label>
    <div class="ci-sexes">${['F', 'M', 'X'].map((k) => `<button type="button" class="ci-sex" data-d="sex:${k}" aria-pressed="${draft.sex === k}"><span class="ci-sx">${k}</span>${esc(t('sex' + k))}</button>`).join('')}</div>
    <p class="d-small">${esc(t('codeChangeNote'))}</p>
    <div class="d-levels">${[1, 2, 3].map((n) => `<button type="button" class="ci-level" data-d="level:${n}" aria-pressed="${draft.level === n}"><span class="ci-ln">${n}</span>${esc(t('level' + n))}</button>`).join('')}</div>
    <div class="d-btns">
      ${p.status === 'gone' ? `<button type="button" class="btn btn-quiet" data-d="back">${esc(t('markBack'))}</button>` : p.status === 'here' ? `<button type="button" class="btn btn-quiet" data-d="gone">${esc(t('markGone'))}</button>` : ''}
      <button type="button" class="btn btn-quiet btn-danger-q" data-d="remove">${esc(t('remove'))}</button>
    </div>
    <div class="d-btns"><button type="button" class="btn btn-quiet" data-d="cancel">${esc(t('cancel'))}</button><button type="button" class="btn btn-navy" data-d="save">${esc(t('save'))}</button></div>`,
  async (d) => {
    const nameNow = $('#edName', dlg).value;
    draft.name = nameNow;
    if (d.startsWith('sex:')) { draft.sex = d.slice(4); draw(); return; }
    if (d.startsWith('level:')) { draft.level = Number(d.slice(6)); draw(); return; }
    if (d === 'cancel') { dlg.close(); return; }
    if (d === 'save') {
      const wasExpected = p.status === 'expected';
      dlg.close();
      update((s) => {
        if (wasExpected && draft.sex && draft.level) S.checkIn(s, { id, sex: draft.sex, level: draft.level, name: draft.name });
        else S.editPlayer(s, id, { sex: draft.sex || undefined, level: draft.level || undefined, name: draft.name });
      });
      return;
    }
    if (d === 'gone' || d === 'back') {
      dlg.close();
      update((s) => { S.editPlayer(s, id, { name: draft.name }); S.setStatus(s, id, d === 'gone' ? 'gone' : 'here'); });
      return;
    }
    if (d === 'remove') {
      const ok = await confirmBox(t('removeConfirm', { code: p.code || p.name }), t('remove'), true);
      if (!ok) return;
      if (lastIn && lastIn.id === id) lastIn = null;
      const res = update((s) => S.removePlayer(s, id));
      if (res === 'gone') toast(t('removedGone', { code: p.code }));
    }
  });
  draw();
}

function pasteNames() {
  openDialog(`<h2 class="d-h">${esc(t('pasteTitle'))}</h2><p class="d-small">${esc(t('pasteHint'))}</p>
    <textarea id="pasteBox" rows="8"></textarea>
    <div class="d-btns"><button type="button" class="btn btn-quiet" data-d="cancel">${esc(t('cancel'))}</button><button type="button" class="btn btn-navy" data-d="add">${esc(t('pasteAdd'))}</button></div>`,
  (d) => {
    if (d === 'add') { const text = $('#pasteBox', dlg).value; dlg.close(); const n = update((s) => S.addExpected(s, text), { plan: false }); toast(t('pasteAdded', { n })); }
    else dlg.close();
  });
}

// ---------- rounds ----------

let swapSel = null;

function roundsHtml() {
  S.ensurePlan(state);
  const v = S.view(state, Date.now());
  const items = state.rounds.map((r, i) => {
    const status = r.started ? (i === v.currentIdx && (v.phase === 'play') ? t('statusPlaying') : t('statusDone'))
      : r.locked ? t('statusFixed') : i === v.nextIdx ? t('statusNext') : '';
    const upcoming = !r.started;
    return `<li class="r-item${r.started ? ' is-past' : ''}">
      <div class="r-head"><h2 class="r-h">${esc(roundName(i))}</h2>${status ? `<span class="r-status">${esc(status)}</span>` : ''}
        ${upcoming ? `<button type="button" class="btn btn-quiet r-redraw" data-act="redraw" data-round="${i}">${esc(t('redraw'))}</button>` : ''}</div>
      ${courtsHtml(r, i, { swappable: upcoming })}
    </li>`;
  }).join('');
  const has = state.rounds.length && state.rounds[0].courts.length;
  return `<section class="rounds">
    <div class="r-top no-print"><h1 class="r-title">${esc(t('roundsTitle'))}</h1>${state.sample ? `<span class="b-sample">${esc(t('sample'))}</span>` : ''}
      ${has ? `<span class="r-actions"><button type="button" class="btn btn-navy" data-act="share">${esc(t('share'))}</button><button type="button" class="btn btn-quiet" data-act="print">${esc(t('print'))}</button></span>` : ''}</div>
    <p class="muted no-print">${esc(t('swapHint'))}</p>
    ${has ? `<ol class="r-list no-print">${items}</ol>` : `<p class="b-empty">${esc(t('noRounds'))}</p>`}
    <p class="no-print"><button type="button" class="btn btn-quiet" data-act="addRound">${esc(t('addRound'))}</button></p>
    ${has ? printRoundsHtml() : ''}
  </section>`;
}

// The paper backup: every round as a compact table. Codes and first names only, never the level.
function printRoundsHtml() {
  const date = new Date().toLocaleDateString(getLang() === 'de' ? 'de-DE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
  const who = (id) => { const p = playerById(id); return `<b>${esc(p.code)}</b>${p.name ? ` <span>${esc(p.name)}</span>` : ''}`; };
  const rounds = state.rounds.map((r, i) => `<section class="pr-round">
      <h2>${esc(roundName(i))}</h2>
      <table><tbody>${r.courts.map((c, k) => `<tr><th>${k + 1}</th><td>${who(c[0])} + ${who(c[1])}</td><td class="pr-vs">${esc(t('versus'))}</td><td>${who(c[2])} + ${who(c[3])}</td></tr>`).join('')}
      ${r.sitOut.length ? `<tr class="pr-sit"><th></th><td colspan="3">${esc(t('sittingOut'))}: ${r.sitOut.slice().sort(byCode).map(who).join(', ')}</td></tr>` : ''}</tbody></table>
    </section>`).join('');
  return `<div class="print-rounds">
    <header class="pr-head"><h1>${esc(t('printTitle'))} · Pickleball Südbaden e.V.</h1><p>${esc(date)}${state.sample ? ' · ' + esc(t('sample')) : ''}</p></header>
    <p class="pr-note">${esc(t('printNote'))} ${esc(t('court'))} 1 … ${state.settings.courts}.</p>
    <div class="pr-grid">${rounds}</div></div>`;
}

/** All planned rounds as plain text for WhatsApp (*bold* marks the headings). */
function shareText() {
  const who = (id) => { const p = playerById(id); return p.name ? `${p.code} ${p.name}` : p.code; };
  const lines = [`*${t('shareHeader')}*`];
  if (state.sample) lines.push(`(${t('sample')})`);
  state.rounds.forEach((r, i) => {
    if (r.started && i !== state.timer.idx) return; // only what is still to come
    lines.push('', `*${roundName(i)}*`);
    r.courts.forEach((c, k) => lines.push(`${t('courtN', { n: k + 1 })}: ${who(c[0])} + ${who(c[1])} – ${who(c[2])} + ${who(c[3])}`));
    if (r.sitOut.length) lines.push(`${t('shareSit')}: ${r.sitOut.slice().sort(byCode).map(who).join(', ')}`);
  });
  lines.push('', t('shareFooter'));
  return lines.join('\n');
}

function shareDialog() {
  S.ensurePlan(state);
  const text = shareText();
  openDialog(`<h2 class="d-h">${esc(t('share'))}</h2>
    <textarea id="shareBox" rows="12" readonly>${esc(text)}</textarea>
    <div class="d-btns"><button type="button" class="btn btn-quiet" data-d="cancel">${esc(t('close'))}</button>
    <button type="button" class="btn btn-quiet" data-d="copy">${esc(t('copy'))}</button>
    ${navigator.share ? `<button type="button" class="btn btn-navy" data-d="share">${esc(t('share'))}</button>` : ''}</div>`,
  async (d) => {
    if (d === 'cancel') { dlg.close(); return; }
    if (d === 'share') {
      try { await navigator.share({ text }); dlg.close(); } catch (e) { if (e && e.name !== 'AbortError') toast(t('shareFailed')); }
      return;
    }
    if (d === 'copy') {
      try { await navigator.clipboard.writeText(text); dlg.close(); toast(t('shareCopied')); }
      catch (e) { const box = $('#shareBox', dlg); box.focus(); box.select(); toast(t('shareFailed')); }
    }
  });
}

function onSwap(roundIdx, id) {
  if (!swapSel || swapSel.round !== roundIdx) { swapSel = { round: roundIdx, id }; render(); return; }
  if (swapSel.id === id) { swapSel = null; render(); return; }
  const a = swapSel.id, b = id;
  swapSel = null;
  if (update((s) => S.swapPlayers(s, roundIdx, a, b), { plan: false })) {
    const A = playerById(a).code, B = playerById(b).code;
    const r = state.rounds[roundIdx];
    const earlier = state.rounds.slice(0, roundIdx);
    const repeat = r.courts.flatMap((c) => [[c[0], c[1]], [c[2], c[3]]]).find(([p, q]) =>
      (p === a || p === b || q === a || q === b) && earlier.some((e) => e.courts.some((c) => (c[0] === p && c[1] === q) || (c[0] === q && c[1] === p) || (c[2] === p && c[3] === q) || (c[2] === q && c[3] === p))));
    toast(repeat ? t('swapRepeat', { a: playerById(repeat[0]).code, b: playerById(repeat[1]).code }) : t('swapDone', { a: A, b: B }));
  } else render();
}

// ---------- settings ----------

function settingsHtml() {
  const st = state.settings;
  const step = (key, label, unit = '') => `<div class="set-row"><span class="set-label">${esc(label)}</span>
    <div class="stepper"><button type="button" data-act="step" data-key="${key}" data-d="-1" aria-label="−">−</button>
    <output>${st[key]}${unit ? ` <small>${esc(unit)}</small>` : ''}</output>
    <button type="button" data-act="step" data-key="${key}" data-d="1" aria-label="+">+</button></div></div>`;
  const fit = S.roundsThatFit(state, Date.now());
  const started = state.rounds.some((r) => r.started);
  return `<section class="set">
    <h1 class="r-title">${esc(t('settingsTitle'))}</h1>
    <div class="set-group">
      ${step('courts', t('courts'))}
      ${step('gameMin', t('gameMin'), t('minutes'))}
      ${step('changeMin', t('changeMin'), t('minutes'))}
      <div class="set-row"><span class="set-label">${esc(t('warmupOn'))}</span>
        <button type="button" class="switch" role="switch" aria-checked="${st.warmup}" data-act="toggleWarmup" ${started ? 'disabled' : ''}><span></span></button></div>
      ${st.warmup ? step('warmupMin', t('warmupMin'), t('minutes')) : ''}
      ${step('rounds', t('rounds'))}
      <div class="set-row"><label class="set-label" for="endTime">${esc(t('endTime'))}</label><input id="endTime" type="time" value="${esc(st.endTime)}" data-act="endTime"></div>
      ${fit ? `<p class="set-fit">${esc(t('fitInfo', { fit: fit.fit, planned: fit.planned, time: st.endTime }))}
        ${fit.fit !== fit.planned && fit.fit > 0 ? `<button type="button" class="btn btn-quiet" data-act="fitSet" data-fit="${fit.fit}">${esc(t('fitSet', { fit: fit.fit }))}</button>` : ''}</p>` : ''}
      <p class="muted">${esc(t('settingsNote'))}</p>
    </div>
    <div class="set-group">
      <div class="set-row"><span class="set-label">${esc(t('language'))}</span>
        <div class="seg"><button type="button" data-act="lang" data-lang="de" aria-pressed="${getLang() === 'de'}">Deutsch</button><button type="button" data-act="lang" data-lang="en" aria-pressed="${getLang() === 'en'}">English</button></div></div>
      <div class="set-row"><span class="set-label">${esc(t('sound'))}</span>
        <div class="seg"><button type="button" data-act="test" data-kind="warn">${esc(t('testWarn'))}</button><button type="button" data-act="test" data-kind="horn">${esc(t('testHorn'))}</button><button type="button" data-act="test" data-kind="start">${esc(t('testStart'))}</button></div></div>
      <div class="set-row"><span class="set-label">${esc(t('soundDevice'))}</span>
        <button type="button" class="switch" role="switch" aria-checked="${soundOn()}" data-act="soundDevice"><span></span></button></div>
      <p class="muted">${esc(t('soundHint'))}${hubMode ? ' ' + esc(t('soundHubHint')) : ''}</p>
    </div>
    <div class="set-group">
      <h2 class="ci-h">${esc(t('printables'))}</h2>
      <p class="set-links"><a class="btn btn-quiet" href="#rules">${esc(t('rulesCard'))}</a> <a class="btn btn-quiet" href="#signs">${esc(t('courtSigns'))}</a></p>
    </div>
    <div class="set-group is-test">
      <h2 class="ci-h">${esc(t('testing'))}</h2>
      <p class="muted">${esc(t('fillSampleHint'))}</p>
      <p><button type="button" class="btn btn-quiet" data-act="sample" ${started ? 'disabled' : ''}>${esc(t('fillSample'))}</button>${started ? ` <small class="muted">${esc(t('fillSampleBlocked'))}</small>` : ''}</p>
    </div>
    <div class="set-group is-end">
      <h2 class="ci-h">${esc(t('endSession'))}</h2>
      <p class="muted">${esc(t('endSessionHint'))}</p>
      <p><button type="button" class="btn btn-danger" data-act="end">${esc(t('endSession'))}</button></p>
      <p class="muted">${esc(t('privacy'))} <span data-offline></span></p>
    </div>
  </section>`;
}

function sampleDialog() {
  let w = 10, m = 10;
  const draw = () => openDialog(`<h2 class="d-h">${esc(t('fillSample'))}</h2><p class="d-small">${esc(t('fillSampleHint'))}</p>
    <div class="set-row"><span class="set-label">${esc(t('sampleWomen'))}</span><div class="stepper"><button type="button" data-d="w-">−</button><output>${w}</output><button type="button" data-d="w+">+</button></div></div>
    <div class="set-row"><span class="set-label">${esc(t('sampleMen'))}</span><div class="stepper"><button type="button" data-d="m-">−</button><output>${m}</output><button type="button" data-d="m+">+</button></div></div>
    <div class="d-btns"><button type="button" class="btn btn-quiet" data-d="cancel">${esc(t('cancel'))}</button><button type="button" class="btn btn-navy" data-d="go">${esc(t('fillSampleGo'))}</button></div>`,
  (d) => {
    if (d === 'w-') w = Math.max(0, w - 1); else if (d === 'w+') w = Math.min(32, w + 1);
    else if (d === 'm-') m = Math.max(0, m - 1); else if (d === 'm+') m = Math.min(32, m + 1);
    else if (d === 'cancel') { dlg.close(); return; }
    else if (d === 'go') { lastIn = null; dlg.close(); update((s) => S.fillSample(s, w, m)); return; }
    draw();
  });
  draw();
}

// ---------- printables (rules card, court signs) ----------

function rulesHtml() {
  const half = (l) => `<div class="rc-half" lang="${l}">
      <h2 class="rc-h">${esc(t('rulesHeading', null, l))}</h2>
      <ol class="rc-rules">${STRINGS[l].rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
      <p class="rc-safety">${esc(t('safety', null, l))}</p>
    </div>`;
  return `<section class="print-page rc">
    <div class="no-print pr-bar"><button type="button" class="btn btn-navy" data-act="print">${esc(t('print'))}</button></div>
    <div class="sheet sheet-portrait rc-sheet">
      <div class="rc-brand"><img src="../assets/img/logo-mark-on-dark.png" alt="" width="40" height="40"><span>Pickleball Südbaden e.V.</span></div>
      ${half('de')}${half('en')}
    </div></section>`;
}

let signsUpTo = 0;
function signsHtml() {
  const n = signsUpTo || state.settings.courts;
  const sign = (k) => `<div class="sheet sheet-landscape sign">
      <svg class="sign-num" viewBox="0 0 400 300" aria-hidden="true"><text x="200" y="262" text-anchor="middle">${k}</text></svg>
      <p class="sign-word">Feld ${k} · Court ${k}</p></div>`;
  return `<section class="print-page signs">
    <div class="no-print pr-bar">
      <div class="stepper"><button type="button" data-act="signs" data-d="-1">−</button><output>${esc(t('signsUpTo', { n }))}</output><button type="button" data-act="signs" data-d="1">+</button></div>
      <button type="button" class="btn btn-navy" data-act="print">${esc(t('print'))}</button></div>
    ${Array.from({ length: n }, (_, i) => sign(i + 1)).join('')}
  </section>`;
}

// ---------- render ----------

const main = $('#view');

function render() {
  document.documentElement.lang = getLang();
  document.body.classList.toggle('is-display', DISPLAY);
  document.body.classList.toggle('hub-lost', hubMode && !linked);
  document.body.dataset.view = route;
  document.title = (DISPLAY ? t('navBoard') : t('appTitle')) + ' · Pickleball Südbaden';
  if (!DISPLAY) {
    $('#langBtn').textContent = t('langToggle');
    $('#langBtn').setAttribute('aria-label', t('langToggleLabel'));
    $('#appTitle').textContent = t('appTitle');
    for (const a of document.querySelectorAll('.p-nav a')) {
      const v = a.getAttribute('href').slice(1);
      a.querySelector('span').textContent = t({ checkin: 'navCheckin', board: 'navBoard', rounds: 'navRounds', settings: 'navSettingsShort' }[v]);
      a.toggleAttribute('aria-current', v === route);
      if (v === route) a.setAttribute('aria-current', 'page');
    }
    const mark = $('#hubMark');
    mark.hidden = !hubMode;
    mark.textContent = t(linked ? 'hubOn' : 'hubOff');
    mark.classList.toggle('is-off', !linked);
    $('#sampleBadge').hidden = !state.sample;
    $('#sampleBadge').textContent = t('sample');
  }
  const pageSize = route === 'signs' ? 'A4 landscape' : 'A4 portrait';
  $('#pageStyle').textContent = `@page { size: ${pageSize}; margin: ${route === 'signs' ? '10mm' : '14mm'}; }`;

  if (route === 'board' || route === 'display') {
    if (!DISPLAY && (!hubMode || linked) && S.ensurePlan(clone(state))) update((s) => S.ensurePlan(s), { plan: false });
    renderBoard(main, Date.now());
    return;
  }
  lastBoardHtml = '';
  if (route === 'checkin') {
    const focused = document.activeElement && document.activeElement.id === 'ciName';
    main.innerHTML = checkinHtml();
    if (focused && $('#ciName')) $('#ciName').focus();
  } else if (route === 'rounds') main.innerHTML = roundsHtml();
  else if (route === 'settings') { main.innerHTML = settingsHtml(); updateOffline(); }
  else if (route === 'rules') main.innerHTML = rulesHtml();
  else if (route === 'signs') main.innerHTML = signsHtml();
}

window.addEventListener('hashchange', () => {
  if (DISPLAY) return;
  const h = location.hash.slice(1);
  route = VIEWS.includes(h) ? h : 'checkin';
  swapSel = null;
  render();
  window.scrollTo(0, 0);
  keepAwake();
});

// ---------- events ----------

document.addEventListener('input', (e) => {
  if (e.target.id === 'ciName') ciName = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'endTime') { const v = e.target.value; update((s) => S.setSetting(s, 'endTime', v), { plan: false }); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'ciName') e.target.blur();
});

document.addEventListener('pointerdown', () => { if (!DISPLAY) unlockAudio(); }, { capture: true });

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || dlg.contains(el)) return;
  onAction(el).catch((err) => { if (!(err instanceof Refused)) throw err; });
});

async function onAction(el) {
  const act = el.dataset.act;
  const now = Date.now();
  switch (act) {
    case 'sex':
      ciSex = ciSex === el.dataset.sex ? '' : el.dataset.sex;
      for (const b of document.querySelectorAll('.ci .ci-sex')) b.setAttribute('aria-pressed', String(b.dataset.sex === ciSex));
      $('.ci-levels').classList.toggle('is-waiting', !ciSex);
      break;
    case 'level': doCheckIn(Number(el.dataset.level)); break;
    case 'undoIn':
      if (lastIn) {
        const { id, wasExpected } = lastIn;
        lastIn = null;
        update((s) => {
          if (wasExpected) { const p = S.byId(s, id); if (p) { p.status = 'expected'; p.code = ''; } }
          else S.removePlayer(s, id);
        });
      }
      break;
    case 'editLast': if (lastIn) editPlayer(lastIn.id); break;
    case 'editPlayer': editPlayer(el.dataset.id); break;
    case 'pickExp': ciExpected = ciExpected === el.dataset.id ? null : el.dataset.id; render(); break;
    case 'clearExp': ciExpected = null; render(); break;
    case 'paste': pasteNames(); break;

    case 'start': unlockAudio(); update((s) => { if (s.timer.phase === 'idle' || s.timer.phase === 'done') S.startNext(s, now); }, { plan: false }); keepAwake(); break;
    case 'pause': update((s) => S.pause(s, now), { plan: false }); break;
    case 'resume': update((s) => S.resume(s, now), { plan: false }); break;
    case 'plus': { const at = state.timer.phase + (state.timer.phase === 'play' ? state.timer.playEnd : state.timer.changeEnd); update((s) => { if (s.timer.phase + (s.timer.phase === 'play' ? s.timer.playEnd : s.timer.changeEnd) === at) S.addMinute(s); }, { plan: false }); break; }
    case 'skip': {
      const playing = state.timer.phase === 'play';
      if (!(await confirmBox(t(playing ? 'skipPlayConfirm' : 'skipChangeConfirm'), t('skip')))) break;
      const phase = state.timer.phase, idx = state.timer.idx, at = Date.now();
      // Only skip what the host saw: if another device moved on meanwhile, do nothing.
      update((s) => (s.timer.phase === phase && s.timer.idx === idx ? S.skip(s, at) : []), { plan: false });
      break;
    }
    case 'addRound': update((s) => S.setSetting(s, 'rounds', s.settings.rounds + 1)); break;
    case 'projector': window.open('./#display', 'pbsb-display', 'popup,width=1280,height=720'); break;
    case 'fullscreen': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); break;

    case 'swap': onSwap(Number(el.dataset.round), el.dataset.id); break;
    case 'redraw': {
      const i = Number(el.dataset.round);
      if (update((s) => S.redrawRound(s, i), { plan: false })) toast(t('redrawDone', { round: roundName(i) }));
      break;
    }

    case 'step': { const key = el.dataset.key, d = Number(el.dataset.d); update((s) => S.setSetting(s, key, s.settings[key] + d)); break; }
    case 'toggleWarmup': { const on = !state.settings.warmup; update((s) => S.setSetting(s, 'warmup', on)); break; }
    case 'fitSet': { const fit = Number(el.dataset.fit); update((s) => S.setSetting(s, 'rounds', s.settings.rounds + fit - S.roundsThatFit(s, now).planned)); break; }
    case 'soundDevice': setSound(!soundOn()); if (soundOn()) unlockAudio(); render(); break;
    case 'lang': setLang(el.dataset.lang); store.saveLang(getLang()); render(); break;
    case 'test': unlockAudio(); setTimeout(() => play(el.dataset.kind), 60); break;
    case 'sample': sampleDialog(); break;
    case 'end':
      if (await confirmBox(t('endSessionConfirm'), t('endSessionGo'), true)) {
        if (hubMode) {
          if (!linked) { toast(t('hubRefused')); break; }
          let res = null;
          try { res = await hub.end(server.version); if (res.conflict) res = await hub.end(res.doc.version); } catch (e) { res = null; }
          if (!res || !res.ok) { toast(t('hubLost')); break; }
          server = { version: res.doc.version, state: null }; pending = [];
        }
        store.wipe(); state = hubMode ? shown() : S.createState(); setLang('de'); resetLocalUi();
        render(); toast(t('ended'));
      }
      break;
    case 'print': window.print(); break;
    case 'share': shareDialog(); break;
    case 'signs': signsUpTo = Math.max(1, Math.min(8, (signsUpTo || state.settings.courts) + Number(el.dataset.d))); render(); break;
    default: break;
  }
}

if (!DISPLAY) {
  $('#langBtn').addEventListener('click', () => { setLang(getLang() === 'de' ? 'en' : 'de'); store.saveLang(getLang()); render(); });
}

// ---------- the clock ----------

// Signals come from what the clock shows, not from who wrote the change, so the window that plays
// them does so even when another device moved the timer on. Only fresh moments sound: after a
// reload or a long sleep the window stays quiet.
let warned = '', lastKey = '';
function sounds(now) {
  const tm = state.timer;
  const key = tm.idx + ':' + tm.phase;
  const on = soundOn() && soundLeader && !DISPLAY;
  if (lastKey && key !== lastKey && !tm.pausedAt && on) {
    const r = state.rounds[tm.idx];
    if ((tm.phase === 'change' || tm.phase === 'done') && now - tm.playEnd < 5000) play('horn');
    else if (tm.phase === 'play' && r && now - r.startedAt < 5000) play('start');
  }
  lastKey = key;
  if (tm.phase === 'play' && !tm.pausedAt) {
    const left = tm.playEnd - now;
    const wkey = tm.idx + ':' + tm.playEnd;
    if (left <= 60000 && left > 55000 && warned !== wkey) { warned = wkey; if (on) play('warn'); }
  }
}

function tick() {
  const now = Date.now();
  const events = S.advance(state, now);
  // A control window records the transition; the projector window only shows it.
  if (events.length && !DISPLAY) {
    if (!hubMode) store.save(state);
    else if (linked) { try { update((s) => { S.advance(s, Date.now()); }, { plan: false }); } catch (e) { /* refused */ } }
  }
  sounds(now);
  if (events.length && route !== 'board' && route !== 'display') render();
  if (route === 'board' || route === 'display') renderBoard(main, now);
}

// Sound plays on one device and in one window there. Per device: a switch in the settings,
// on by default without a hub, and with a hub only on the computer that runs it.
// Per window: the first window that wants sound takes a lock.
const SOUND_KEY = 'pbsb-play-sound';
function soundOn() {
  let v = null;
  try { v = localStorage.getItem(SOUND_KEY); } catch (e) { v = null; }
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !hubMode || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}
function setSound(on) { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (e) { /* ignore */ } }
let soundLeader = !DISPLAY;
if (!DISPLAY && navigator.locks) {
  soundLeader = false;
  navigator.locks.request('pbsb-play-sound', () => { soundLeader = true; return new Promise(() => {}); });
}

// ---------- screen on ----------

let wakeLock = null;
async function keepAwake() {
  const want = document.visibilityState === 'visible' && (DISPLAY || route === 'board' || state.timer.phase === 'play' || state.timer.phase === 'change');
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { keepAwake(); if (document.visibilityState === 'visible') tick(); });

// ---------- offline ----------

function updateOffline() {
  const el = $('[data-offline]');
  if (el) el.textContent = '· ' + t(offlineReady ? 'offlineReady' : 'offlineNot');
}
let offlineReady = false;
if ('serviceWorker' in navigator) {
  // `ready` resolves once a worker is active, i.e. after every file is in the cache.
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { offlineReady = true; updateOffline(); }).catch(() => {});
}

// Display window: hide the pointer when idle.
if (DISPLAY) {
  let idle = 0;
  document.addEventListener('pointermove', () => { document.body.classList.remove('is-idle'); clearTimeout(idle); idle = setTimeout(() => document.body.classList.add('is-idle'), 2500); });
  document.addEventListener('fullscreenchange', () => { lastBoardHtml = ''; render(); });
}

// Start: with a hub remembered for this address, wait for it; otherwise run locally and look for one.
const wasHub = hub.remembered();
if (wasHub) startHub(null);
else S.ensurePlan(state);
render();
tick();
setInterval(tick, 250);
keepAwake();
hub.detect().then((doc) => {
  if (doc && doc !== 'none') { if (!hubMode) { startHub(doc); render(); } }
  else if (doc === 'none' && wasHub) { hub.forget(); location.reload(); } // this address no longer has a hub
});
