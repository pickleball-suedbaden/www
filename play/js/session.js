// Pickleball Südbaden e.V. · session organiser · state and rules of the evening.
// Plain ES module with no DOM access: the roster, the planned rounds and the timer live in one
// JSON-serialisable object. The UI (app.js) calls these functions and saves the result; a later
// sync layer (local server or cloud) could hold the same object and drive more screens.
// Every function that depends on the clock takes `now` (ms) so the time is always absolute.

import { planRounds, drawRound, drawRoundGroups, hashSeed, courtsInUse, groupIn } from './draw.js';

// Version 2 added the two playing groups (settings.groups, groupNames, groupCourts; player.group).
export const VERSION = 2;
export const MAX_PLAYERS = 64;
const MIN = 60000;

export function createState(seed = Date.now()) {
  return {
    v: VERSION,
    settings: { courts: 5, gameMin: 12, changeMin: 3, warmup: true, warmupMin: 12, rounds: 5, endTime: '', ...GROUP_DEFAULTS(5) },
    players: [],
    nextId: 1,
    seed: seed >>> 0,
    redraws: 0,
    rounds: [],
    timer: { idx: -1, phase: 'idle', playEnd: 0, changeEnd: 0, pausedAt: 0 },
    sample: false,
  };
}

// Groups off; when switched on, group 1 gets the lower half of the courts (2 of 5).
const GROUP_DEFAULTS = (courts) => ({ groups: false, groupNames: ['', ''], groupCourts: Math.max(1, Math.floor(courts / 2)) });

/**
 * Bring a saved session up to the current shape. A session from before the groups (version 1)
 * loads with groups off and plays on exactly as before. Safe to call more than once.
 */
export function migrate(s) {
  if (!s || typeof s !== 'object' || !s.settings) return s;
  const d = GROUP_DEFAULTS(s.settings.courts || 5);
  for (const k of Object.keys(d)) if (s.settings[k] === undefined) s.settings[k] = d[k];
  if (!Array.isArray(s.settings.groupNames) || s.settings.groupNames.length !== 2) s.settings.groupNames = ['', ''];
  if (!(s.v >= VERSION)) s.v = VERSION;
  return s;
}

/**
 * The whole session as a file for the club's records (who came, the groups, the rounds). The name
 * carries the day the first round started on this device's clock, else the day of `now`.
 */
export function exportFile(s, now = Date.now()) {
  const first = (s.rounds || []).find((r) => r.startedAt);
  const d = new Date(first ? first.startedAt : now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const doc = { app: 'pbsb-spieltreff', exported: new Date(now).toISOString(), state: s };
  return { name: `spieltreff-${day}.json`, text: JSON.stringify(doc, null, 1) };
}

// ---------- players ----------

export const present = (s) => s.players.filter((p) => p.status === 'here');
export const byId = (s, id) => s.players.find((p) => p.id === id);

function nextCode(s, sex) {
  let max = 0;
  for (const p of s.players) if (p.code && p.code[0] === sex) max = Math.max(max, parseInt(p.code.slice(1), 10) || 0);
  return sex + (max + 1);
}

// ---------- groups ----------
// Two groups, for example advanced players on courts 1-2 and beginners on courts 3-5. A player's group
// is kept when groups are switched off, so switching them on again restores it.

const isGroup = (g) => g === 1 || g === 2;
/** Group for someone checked in without one: an experienced player (level 2 or 3) goes to group 1. */
export const defaultGroup = (p) => (p.level >= 2 ? 1 : 2);
export const groupOf = (p) => (isGroup(p.group) ? p.group : defaultGroup(p));

/** Courts of group 1 and group 2. Group 1 plays on the lowest-numbered courts. */
export function groupCourts(s) {
  const n = s.settings.courts;
  if (n < 2) return [n, 0];
  const a = Math.max(1, Math.min(n - 1, s.settings.groupCourts || 1));
  return [a, n - a];
}

/** Switch groups on or off. Players who have no group yet get one from their level, marked as automatic. */
export function setGroups(s, on) {
  s.settings.groups = !!on;
  let auto = 0;
  if (on) {
    for (const p of s.players) {
      if (p.code && !isGroup(p.group)) { p.group = defaultGroup(p); p.groupAuto = true; auto++; }
    }
  }
  return auto;
}

export function setGroup(s, id, group) {
  const p = byId(s, id);
  if (!p || !isGroup(group)) return false;
  p.group = group; p.groupAuto = false;
  return true;
}

/** The host checked the automatic groups: they no longer need a look. */
export function confirmGroups(s) {
  for (const p of s.players) delete p.groupAuto;
}

export function setGroupName(s, k, name) {
  if (k !== 0 && k !== 1) return;
  const names = s.settings.groupNames.slice();
  names[k] = String(name || '').trim().slice(0, 24);
  s.settings.groupNames = names;
}

/**
 * Per group: players present, courts, courts in use and how many sit out per round; plus a
 * suggestion when giving one court to the other group means fewer people sit out.
 */
export function groupInfo(s) {
  const split = groupCourts(s);
  const here = present(s);
  const sitting = (n, c) => n - 4 * courtsInUse(n, c);
  const groups = split.map((courts, k) => {
    const mine = here.filter((p) => groupOf(p) === k + 1);
    const used = courtsInUse(mine.length, courts);
    return {
      k, name: s.settings.groupNames[k] || '', courts, first: k ? split[0] + 1 : 1, present: mine.length,
      F: mine.filter((p) => p.sex === 'F').length, M: mine.filter((p) => p.sex === 'M').length, X: mine.filter((p) => p.sex === 'X').length,
      used, sitting: sitting(mine.length, courts), tooSmall: mine.length > 0 && mine.length < 4,
      auto: mine.filter((p) => p.groupAuto).length,
    };
  });
  const total = (a) => sitting(groups[0].present, a) + sitting(groups[1].present, s.settings.courts - a);
  let suggest = null;
  if (s.settings.courts >= 2) {
    for (const a of [split[0] - 1, split[0] + 1]) {
      if (a < 1 || a > s.settings.courts - 1) continue;
      const saves = total(split[0]) - total(a);
      if (saves > 0 && (!suggest || saves > suggest.saves)) suggest = { groupCourts: a, to: a > split[0] ? 0 : 1, from: a > split[0] ? 1 : 0, saves };
    }
  }
  return { groups, suggest, auto: groups[0].auto + groups[1].auto };
}

// ---------- players: check-in and changes ----------

/**
 * Check a player in. `id` checks in someone from the expected list. `newId` names a new player, so
 * a check-in that is applied again after a sync conflict stays the same player. `group` (1 or 2) is
 * the group they chose; with groups on there is no level question. Returns the player.
 */
export function checkIn(s, { sex, level = 0, group = 0, name = '', id = null, newId = null }) {
  let p = id ? byId(s, id) : null;
  if (!p) {
    if (s.players.length >= MAX_PLAYERS) throw new Error('too many players');
    p = { id: newId && !byId(s, newId) ? newId : 'p' + s.nextId++, code: '', sex, level, name: '', status: 'here' };
    s.players.push(p);
  }
  p.sex = sex; p.level = level || 0; p.status = 'here';
  if (isGroup(group)) { p.group = group; delete p.groupAuto; }
  else if (s.settings.groups && !isGroup(p.group)) { p.group = defaultGroup(p); p.groupAuto = true; }
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

export function editPlayer(s, id, { sex, level, name, group }) {
  const p = byId(s, id);
  if (!p) return;
  if (name !== undefined) p.name = String(name).trim().slice(0, 24);
  if (level !== undefined) p.level = level;
  if (isGroup(group) && (group !== p.group || p.groupAuto)) { p.group = group; delete p.groupAuto; }
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
  let used = courtsInUse(here.length, s.settings.courts);
  let groups = null;
  if (s.settings.groups) { groups = groupInfo(s).groups; used = groups[0].used + groups[1].used; }
  return {
    groups,
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
// First names for sample players, 32 of each so the sample dialog's maximum never runs out.
const SAMPLE_F = ['Anna', 'Lena', 'Julia', 'Sophie', 'Laura', 'Marie', 'Hannah', 'Lea', 'Lisa', 'Sarah', 'Katharina', 'Johanna',
  'Clara', 'Emma', 'Mia', 'Nina', 'Paula', 'Greta', 'Ida', 'Carla', 'Elif', 'Sofia', 'Ines', 'Jana', 'Theresa', 'Franziska',
  'Miriam', 'Petra', 'Sabine', 'Ursula', 'Bärbel', 'Chiara'];
const SAMPLE_M = ['Lukas', 'Jonas', 'Felix', 'Max', 'Paul', 'Leon', 'David', 'Tobias', 'Simon', 'Jan', 'Florian', 'Matthias',
  'Stefan', 'Thomas', 'Michael', 'Andreas', 'Moritz', 'Jakob', 'Elias', 'Noah', 'Emre', 'Luca', 'Marco', 'Niklas', 'Philipp',
  'Sebastian', 'Johannes', 'Martin', 'Uwe', 'Jürgen', 'Kai', 'Mehmet'];

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function fillSample(s, women = 10, men = 10, rand = Math.random) {
  s.players = []; s.nextId = 1; s.rounds = [];
  s.timer = { idx: -1, phase: 'idle', playEnd: 0, changeEnd: 0, pausedAt: 0 };
  // Alternate so the codes come out F1, M1, F2, M2 … like a real arrival order;
  // every fourth player of each sex counts as experienced, like a real evening.
  // With groups on, the first arrivals fill group 1's courts and the rest go to group 2.
  const g1 = s.settings.groups ? 4 * groupCourts(s)[0] : 0;
  let k = 0;
  const group = () => (s.settings.groups ? (k++ < g1 ? 1 : 2) : 0);
  const fNames = shuffled(SAMPLE_F, rand), mNames = shuffled(SAMPLE_M, rand);
  for (let i = 0; i < Math.max(women, men); i++) {
    if (i < women) checkIn(s, { sex: 'F', level: s.settings.groups ? 0 : i % 4 === 1 ? 2 : 1, group: group(), name: fNames[i % fNames.length] });
    if (i < men) checkIn(s, { sex: 'M', level: s.settings.groups ? 0 : i % 4 === 2 ? 2 : 1, group: group(), name: mNames[i % mNames.length] });
  }
  s.sample = true;
}

// ---------- settings ----------

export function setSetting(s, key, value) {
  const lim = { courts: [1, 8], gameMin: [1, 60], changeMin: [0, 20], warmupMin: [1, 60], rounds: [1, 20], groupCourts: [1, 7] };
  if (lim[key]) value = Math.max(lim[key][0], Math.min(lim[key][1], Math.round(Number(value) || 0)));
  if (key === 'warmup') value = !!value;
  if (key === 'endTime') value = /^\d{1,2}:\d{2}$/.test(value) ? value : '';
  s.settings[key] = value;
}

// ---------- the plan ----------

const isFrozen = (r) => r.started || r.locked;
/** Index of the first round that is not fixed yet: changes apply from there. */
export const firstOpen = (s) => s.rounds.filter(isFrozen).length;

/**
 * What the draw works with now. With groups: players carry their group and no level, because the
 * group already separates the levels (and players who chose a group gave no level answer). Without
 * groups, someone who has a group counts as experienced if it is group 1, so a final round with
 * everyone together spreads the advanced players over the courts; everyone else keeps their answer.
 */
function spec(s) {
  const here = present(s);
  if (s.settings.groups) {
    const split = groupCourts(s);
    return {
      players: here.map((p) => ({ id: p.id, sex: p.sex, level: 1, group: groupOf(p) })),
      courts: s.settings.courts,
      groups: split.map((courts, k) => ({ courts, first: k ? split[0] + 1 : 1, name: s.settings.groupNames[k] || '' })),
    };
  }
  return {
    players: here.map((p) => (isGroup(p.group) && !p.level ? { id: p.id, sex: p.sex, level: p.group === 1 ? 2 : 1 } : p)),
    courts: s.settings.courts,
    groups: null,
  };
}

export function signature(s) {
  const sp = spec(s);
  // Without groups the signature is the one from before groups existed, so an old session keeps its plan.
  if (!sp.groups) return s.settings.courts + '#' + sp.players.map((p) => p.id + p.sex + p.level).sort().join(',');
  return s.settings.courts + '#G' + sp.groups.map((g) => g.courts).join('/') + '#' + sp.players.map((p) => p.id + p.sex + p.group).sort().join(',');
}

function plan(s, history, count, seed) {
  const sp = spec(s);
  return planRounds({ players: sp.players, courts: sp.courts, groups: sp.groups, history, count, seed });
}

function drawOne(s, history, seed) {
  const sp = spec(s);
  if (sp.groups) return drawRoundGroups({ players: sp.players, groups: sp.groups, history, seed });
  return drawRound({ players: sp.players, courts: sp.courts, history, seed });
}

/** How many rounds the plan should hold in total (warm-up included). */
export function wantedRounds(s) {
  const frozen = s.rounds.filter(isFrozen);
  const hasWarmup = frozen.length ? !!frozen[0].warmup : s.settings.warmup;
  return Math.max(frozen.length, s.settings.rounds + (hasWarmup ? 1 : 0));
}

function drawFrom(s, startIdx) {
  const keep = s.rounds.slice(0, startIdx);
  const sig = signature(s);
  const count = wantedRounds(s) - keep.length;
  const firstWarmup = keep.length === 0 && s.settings.warmup;
  const planned = count > 0 ? plan(s, keep, count, hashSeed(s.seed, s.redraws)) : [];
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
    const extra = plan(s, s.rounds, want - keep, hashSeed(s.seed, s.redraws, keep));
    s.rounds = s.rounds.concat(extra.map((r) => ({ ...r, warmup: false, sig, started: false })));
    return true;
  }
  // A new group name needs no new draw: rounds that are not fixed take it over.
  let renamed = false;
  for (const r of upcoming) {
    if (!r.groups) continue;
    r.groups.forEach((g, k) => { const name = s.settings.groupNames[k] || ''; if (g.name !== name) { g.name = name; renamed = true; } });
  }
  return renamed;
}

/**
 * The last round with everyone together: groups off from the first round that is not fixed, and
 * with `last` that round becomes the last one of the evening (one is added if the plan ran out).
 */
export function togetherFrom(s, { last = false } = {}) {
  s.settings.groups = false;
  if (last) {
    const idx = firstOpen(s);
    const frozen = s.rounds.filter(isFrozen);
    const hasWarmup = frozen.length ? !!frozen[0].warmup : s.settings.warmup;
    s.settings.rounds = Math.max(1, Math.min(20, idx + 1 - (hasWarmup ? 1 : 0)));
  }
  return firstOpen(s);
}

export const isUpcoming = (s, idx) => !!s.rounds[idx] && !s.rounds[idx].started;

/** Draw one upcoming round again (and the rounds after it, so partners stay new). */
export function redrawRound(s, idx) {
  if (!isUpcoming(s, idx)) return false;
  s.redraws++;
  const r = s.rounds[idx];
  const one = drawOne(s, s.rounds.slice(0, idx), hashSeed(s.seed, 'redraw', s.redraws));
  const next = { ...r, courts: one.courts, sitOut: one.sitOut, sig: signature(s) };
  if (one.groups) next.groups = one.groups; else delete next.groups;
  s.rounds[idx] = next;
  redrawAfter(s, idx);
  return true;
}

function redrawAfter(s, idx) {
  const rest = s.rounds.length - idx - 1;
  if (rest <= 0) return;
  const planned = plan(s, s.rounds.slice(0, idx + 1), rest, hashSeed(s.seed, 'after', s.redraws));
  s.rounds = s.rounds.slice(0, idx + 1).concat(planned.map((r) => ({ ...r, warmup: false, sig: signature(s), started: false })));
}

/**
 * Swap two players in an upcoming round; later rounds are drawn again. Only within one group:
 * to play in the other group, a player moves group.
 */
export function swapPlayers(s, idx, a, b) {
  if (!isUpcoming(s, idx) || a === b) return false;
  const r = s.rounds[idx];
  if (r.groups && groupIn(r, a) !== groupIn(r, b)) return false;
  const swap = (id) => (id === a ? b : id === b ? a : id);
  r.courts = r.courts.map((c) => c.map(swap));
  r.sitOut = r.sitOut.map(swap);
  if (r.groups) r.groups = r.groups.map((g) => ({ ...g, sitOut: g.sitOut.map(swap) }));
  s.redraws++;
  redrawAfter(s, idx);
  return true;
}

export function roundLabel(s, idx) {
  const r = s.rounds[idx];
  const warm = s.rounds[0] && s.rounds[0].warmup ? 1 : 0;
  if (!r) return { warmup: false, n: idx + 1 - warm }; // a round still to be added
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
