// Pickleball Südbaden e.V. · session organiser · state and rules of the evening.
// Plain ES module with no DOM access: the roster, the planned rounds and the timer live in one
// JSON-serialisable object. The UI (app.js) calls these functions and saves the result; a later
// sync layer (local server or cloud) could hold the same object and drive more screens.
// Every function that depends on the clock takes `now` (ms) so the time is always absolute.

import { planRounds, drawRound, hashSeed, courtsInUse } from './draw.js';

export const VERSION = 1;
export const MAX_PLAYERS = 64;
const MIN = 60000;

export function createState(seed = Date.now()) {
  return {
    v: VERSION,
    settings: { courts: 5, gameMin: 12, changeMin: 3, warmup: true, warmupMin: 12, rounds: 5, endTime: '' },
    players: [],
    nextId: 1,
    seed: seed >>> 0,
    redraws: 0,
    rounds: [],
    timer: { idx: -1, phase: 'idle', playEnd: 0, changeEnd: 0, pausedAt: 0 },
    sample: false,
  };
}

// ---------- players ----------

export const present = (s) => s.players.filter((p) => p.status === 'here');
export const byId = (s, id) => s.players.find((p) => p.id === id);

function nextCode(s, sex) {
  let max = 0;
  for (const p of s.players) if (p.code && p.code[0] === sex) max = Math.max(max, parseInt(p.code.slice(1), 10) || 0);
  return sex + (max + 1);
}

/** Check a player in. `id` checks in someone from the expected list. Returns the player. */
export function checkIn(s, { sex, level, name = '', id = null }) {
  let p = id ? byId(s, id) : null;
  if (!p) {
    if (s.players.length >= MAX_PLAYERS) throw new Error('too many players');
    p = { id: 'p' + s.nextId++, code: '', sex, level, name: '', status: 'here' };
    s.players.push(p);
  }
  p.sex = sex; p.level = level; p.status = 'here';
  p.name = String(name || p.name || '').trim().slice(0, 24);
  p.code = nextCode(s, sex);
  p.at = Date.now();
  return p;
}

/** Names pasted before the evening; check-in turns them into players. */
export function addExpected(s, text) {
  const names = String(text).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const have = new Set(s.players.map((p) => p.name.toLowerCase()));
  let added = 0;
  for (const name of names) {
    if (have.has(name.toLowerCase()) || s.players.length >= MAX_PLAYERS) continue;
    s.players.push({ id: 'p' + s.nextId++, code: '', sex: '', level: 0, name: name.slice(0, 24), status: 'expected' });
    have.add(name.toLowerCase());
    added++;
  }
  return added;
}

export function editPlayer(s, id, { sex, level, name }) {
  const p = byId(s, id);
  if (!p) return;
  if (name !== undefined) p.name = String(name).trim().slice(0, 24);
  if (level !== undefined) p.level = level;
  if (sex !== undefined && sex !== p.sex) {
    p.sex = sex;
    if (p.code) { p.code = ''; p.code = nextCode(s, sex); }
  }
}

export function setStatus(s, id, status) {
  const p = byId(s, id);
  if (p) p.status = status;
}

export const inStartedRound = (s, id) => s.rounds.some((r) => (r.started || r.locked) && (r.courts.some((c) => c.includes(id)) || r.sitOut.includes(id)));

/** Remove a player entered by mistake. Someone who already played is marked as gone instead. */
export function removePlayer(s, id) {
  if (inStartedRound(s, id)) { setStatus(s, id, 'gone'); return 'gone'; }
  s.players = s.players.filter((p) => p.id !== id);
  return 'removed';
}

export function counts(s) {
  const here = present(s);
  const used = courtsInUse(here.length, s.settings.courts);
  return {
    F: here.filter((p) => p.sex === 'F').length,
    M: here.filter((p) => p.sex === 'M').length,
    X: here.filter((p) => p.sex === 'X').length,
    total: here.length,
    courts: used,
    sitting: here.length - used * 4,
    expected: s.players.filter((p) => p.status === 'expected').length,
    gone: s.players.filter((p) => p.status === 'gone').length,
  };
}

/** Sample players for testing and for a generic printed backup schedule. */
export function fillSample(s, women = 10, men = 10) {
  s.players = []; s.nextId = 1; s.rounds = [];
  s.timer = { idx: -1, phase: 'idle', playEnd: 0, changeEnd: 0, pausedAt: 0 };
  // Alternate so the codes come out F1, M1, F2, M2 … like a real arrival order;
  // every fourth player of each sex counts as experienced, like a real evening.
  for (let i = 0; i < Math.max(women, men); i++) {
    if (i < women) checkIn(s, { sex: 'F', level: i % 4 === 1 ? 2 : 1 });
    if (i < men) checkIn(s, { sex: 'M', level: i % 4 === 2 ? 2 : 1 });
  }
  s.sample = true;
}

// ---------- settings ----------

export function setSetting(s, key, value) {
  const lim = { courts: [1, 8], gameMin: [1, 60], changeMin: [0, 20], warmupMin: [1, 60], rounds: [1, 20] };
  if (lim[key]) value = Math.max(lim[key][0], Math.min(lim[key][1], Math.round(Number(value) || 0)));
  if (key === 'warmup') value = !!value;
  if (key === 'endTime') value = /^\d{1,2}:\d{2}$/.test(value) ? value : '';
  s.settings[key] = value;
}

// ---------- the plan ----------

const isFrozen = (r) => r.started || r.locked;

export function signature(s) {
  return s.settings.courts + '#' + present(s).map((p) => p.id + p.sex + p.level).sort().join(',');
}

/** How many rounds the plan should hold in total (warm-up included). */
export function wantedRounds(s) {
  const frozen = s.rounds.filter(isFrozen);
  const hasWarmup = frozen.length ? !!frozen[0].warmup : s.settings.warmup;
  return Math.max(frozen.length, s.settings.rounds + (hasWarmup ? 1 : 0));
}

function drawFrom(s, startIdx) {
  const keep = s.rounds.slice(0, startIdx);
  const players = present(s);
  const sig = signature(s);
  const count = wantedRounds(s) - keep.length;
  const firstWarmup = keep.length === 0 && s.settings.warmup;
  const planned = count > 0 ? planRounds({ players, courts: s.settings.courts, history: keep, count, seed: hashSeed(s.seed, s.redraws) }) : [];
  s.rounds = keep.concat(planned.map((r, k) => ({ ...r, warmup: firstWarmup && k === 0, sig, started: false })));
}

/** Bring the plan up to date: redraw rounds that have not started if the roster or courts changed. */
export function ensurePlan(s) {
  const frozenCount = s.rounds.filter(isFrozen).length;
  const sig = signature(s);
  const upcoming = s.rounds.slice(frozenCount);
  const want = wantedRounds(s);
  const warmupOk = frozenCount > 0 || !upcoming.length || !!upcoming[0].warmup === s.settings.warmup;
  if (!s.rounds.length || upcoming.some((r) => r.sig !== sig) || !warmupOk) { drawFrom(s, frozenCount); return true; }
  if (s.rounds.length > want) { s.rounds = s.rounds.slice(0, want); return true; }
  if (s.rounds.length < want) {
    const keep = s.rounds.length;
    const extra = planRounds({ players: present(s), courts: s.settings.courts, history: s.rounds, count: want - keep, seed: hashSeed(s.seed, s.redraws, keep) });
    s.rounds = s.rounds.concat(extra.map((r) => ({ ...r, warmup: false, sig, started: false })));
    return true;
  }
  return false;
}

export const isUpcoming = (s, idx) => !!s.rounds[idx] && !s.rounds[idx].started;

/** Draw one upcoming round again (and the rounds after it, so partners stay new). */
export function redrawRound(s, idx) {
  if (!isUpcoming(s, idx)) return false;
  s.redraws++;
  const r = s.rounds[idx];
  const players = present(s);
  const one = drawRound({ players, courts: s.settings.courts, history: s.rounds.slice(0, idx), seed: hashSeed(s.seed, 'redraw', s.redraws) });
  s.rounds[idx] = { ...r, courts: one.courts, sitOut: one.sitOut, sig: signature(s) };
  redrawAfter(s, idx);
  return true;
}

function redrawAfter(s, idx) {
  const players = present(s);
  const rest = s.rounds.length - idx - 1;
  if (rest <= 0) return;
  const planned = planRounds({ players, courts: s.settings.courts, history: s.rounds.slice(0, idx + 1), count: rest, seed: hashSeed(s.seed, 'after', s.redraws) });
  s.rounds = s.rounds.slice(0, idx + 1).concat(planned.map((r) => ({ ...r, warmup: false, sig: signature(s), started: false })));
}

/** Swap two players in an upcoming round; later rounds are drawn again. */
export function swapPlayers(s, idx, a, b) {
  if (!isUpcoming(s, idx) || a === b) return false;
  const r = s.rounds[idx];
  const swap = (id) => (id === a ? b : id === b ? a : id);
  r.courts = r.courts.map((c) => c.map(swap));
  r.sitOut = r.sitOut.map(swap);
  s.redraws++;
  redrawAfter(s, idx);
  return true;
}

export function roundLabel(s, idx) {
  const r = s.rounds[idx];
  if (!r) return { warmup: false, n: idx + 1 };
  const warm = s.rounds[0] && s.rounds[0].warmup ? 1 : 0;
  return { warmup: !!r.warmup, n: idx + 1 - warm };
}

// ---------- the timer ----------
// phase: 'idle' (waiting for the tap that starts the next round), 'play', 'change', 'done'.
// Every end is an absolute timestamp, so a reload or a locked screen does not drift.

const lengthOf = (s, idx) => ((s.rounds[idx] && s.rounds[idx].warmup ? s.settings.warmupMin : s.settings.gameMin) * MIN);

export function nextIndex(s) {
  return s.rounds.findIndex((r) => !r.started);
}

/** Start the next round now (the first round, or after the plan ran out and rounds were added). */
export function startNext(s, now) {
  ensurePlan(s);
  const idx = nextIndex(s);
  if (idx < 0) return false;
  beginRound(s, idx, now);
  return true;
}

function beginRound(s, idx, at) {
  const r = s.rounds[idx];
  r.started = true; r.locked = true; r.startedAt = at;
  Object.assign(s.timer, { idx, phase: 'play', playEnd: at + lengthOf(s, idx), changeEnd: 0, pausedAt: 0 });
}

/**
 * Move the timer forward to `now`. Returns the transitions that happened, oldest first:
 * { type: 'horn' | 'start', at }.
 */
export function advance(s, now) {
  const events = [];
  const t = s.timer;
  if (t.pausedAt) return events;
  for (let guard = 0; guard < 100; guard++) {
    if (t.phase === 'play' && now >= t.playEnd) {
      events.push({ type: 'horn', at: t.playEnd });
      // The next round is fixed from here on: people are walking to their courts.
      ensurePlan(s);
      const next = nextIndex(s);
      if (next < 0) { t.phase = 'done'; continue; }
      s.rounds[next].locked = true;
      t.phase = 'change';
      t.changeEnd = t.playEnd + s.settings.changeMin * MIN;
      continue;
    }
    if (t.phase === 'change' && now >= t.changeEnd) {
      const next = nextIndex(s);
      if (next < 0) { t.phase = 'done'; continue; }
      events.push({ type: 'start', at: t.changeEnd });
      beginRound(s, next, t.changeEnd);
      continue;
    }
    break;
  }
  return events;
}

export function pause(s, now) { if (!s.timer.pausedAt && (s.timer.phase === 'play' || s.timer.phase === 'change')) s.timer.pausedAt = now; }

export function resume(s, now) {
  const t = s.timer;
  if (!t.pausedAt) return;
  const d = now - t.pausedAt;
  if (t.playEnd) t.playEnd += d;
  if (t.changeEnd) t.changeEnd += d;
  t.pausedAt = 0;
}

export function addMinute(s) {
  const t = s.timer;
  if (t.phase === 'play') t.playEnd += MIN;
  else if (t.phase === 'change') t.changeEnd += MIN;
}

/** Take a minute off the game or the changeover, but never end it this way (that is Skip). */
export function minusMinute(s, now) {
  const t = s.timer;
  const clock = t.pausedAt || now;
  const key = t.phase === 'play' ? 'playEnd' : t.phase === 'change' ? 'changeEnd' : '';
  if (!key || t[key] - clock <= MIN) return false;
  t[key] -= MIN;
  return true;
}

/**
 * Restart the round in play: it goes back to waiting for its start tap, with the same line-up.
 * The clock runs again from the full length when the host starts it.
 */
export function restartRound(s) {
  const t = s.timer;
  if (t.phase !== 'play') return false;
  const r = s.rounds[t.idx];
  if (!r) return false;
  r.started = false; r.locked = true; delete r.startedAt;
  const prev = s.rounds.slice(0, t.idx).map((x) => x.started).lastIndexOf(true);
  Object.assign(t, { idx: prev, phase: 'idle', playEnd: 0, changeEnd: 0, pausedAt: 0 });
  return true;
}

/** Skip: end the game now, or end the changeover now. */
export function skip(s, now) {
  const t = s.timer;
  const at = t.pausedAt || now;
  if (t.phase === 'play') t.playEnd = Math.min(t.playEnd, at);
  else if (t.phase === 'change') t.changeEnd = Math.min(t.changeEnd, at);
  if (t.pausedAt) { t.pausedAt = 0; return advance(s, at); }
  return advance(s, now);
}

/** What the board shows at `now`. */
export function view(s, now) {
  const t = s.timer;
  const clock = t.pausedAt || now;
  let remaining = 0;
  if (t.phase === 'play') remaining = t.playEnd - clock;
  else if (t.phase === 'change') remaining = t.changeEnd - clock;
  remaining = Math.max(0, remaining);
  const current = t.idx >= 0 ? s.rounds[t.idx] : null;
  const nextIdx = nextIndex(s);
  // Show the next round from 2 minutes before the horn, during the changeover, and while waiting.
  const showNext = nextIdx >= 0 && (t.phase === 'idle' || t.phase === 'change' || (t.phase === 'play' && remaining <= 2 * MIN));
  return { phase: t.phase, paused: !!t.pausedAt, remaining, current, currentIdx: t.idx, nextIdx, next: nextIdx >= 0 ? s.rounds[nextIdx] : null, showNext };
}

/** Rounds that still fit before the end time, counted from the end of what is running now. */
export function roundsThatFit(s, now) {
  const end = s.settings.endTime;
  if (!end) return null;
  const [h, m] = end.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  let endMs = d.getTime();
  if (endMs < now - 12 * 3600 * 1000) endMs += 24 * 3600 * 1000;
  const g = s.settings.gameMin * MIN, c = s.settings.changeMin * MIN;
  const t = s.timer;
  const held = t.pausedAt ? now - t.pausedAt : 0; // a paused clock pushes everything back
  let from = now;
  if (t.phase === 'play') from = t.playEnd + held + c;
  else if (t.phase === 'change') from = t.changeEnd + held;
  const fit = Math.max(0, Math.floor((endMs - from + c) / (g + c)));
  // Rounds still to start, counted from the same point in time as `fit`.
  const planned = s.rounds.filter((r) => !r.started).length;
  return { fit, planned, endMs };
}
