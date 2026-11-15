// Tests for the session organiser's draw and session state (play/js). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawRound, planRounds, stats, isExperienced } from '../play/js/draw.js';
import * as S from '../play/js/session.js';

// f women, m men, x "either"; the first expF women and expM men are experienced (level 2).
function makePlayers(f, m, x = 0, expF = 0, expM = 0, expX = 0) {
  const P = [];
  for (let i = 1; i <= f; i++) P.push({ id: 'F' + i, sex: 'F', level: i <= expF ? 2 : 1 });
  for (let i = 1; i <= m; i++) P.push({ id: 'M' + i, sex: 'M', level: i <= expM ? 3 : 1 });
  for (let i = 1; i <= x; i++) P.push({ id: 'X' + i, sex: 'X', level: i <= expX ? 2 : 1 });
  return P;
}

const ROUNDS = 6; // warm-up plus 5 rounds, as on the night

function checkRoundShape(players, round, courts) {
  const used = Math.min(courts, Math.floor(players.length / 4));
  assert.equal(round.courts.length, used);
  const all = [...round.courts.flat(), ...round.sitOut];
  assert.equal(all.length, players.length, 'everyone is placed once');
  assert.equal(new Set(all).size, players.length, 'nobody is placed twice');
}

function experiencedPerCourt(players, round) {
  const byId = new Map(players.map((p) => [p.id, p]));
  return round.courts.map((c) => c.filter((id) => isExperienced(byId.get(id))).length);
}

function spread(map, ids) {
  const v = ids.map((id) => map.get(id) || 0);
  return Math.max(...v) - Math.min(...v);
}

test('20 players (10 women, 10 men): all mixed, no repeated partner, one experienced player per court', () => {
  const players = makePlayers(10, 10, 0, 2, 3);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 11 });
  rounds.forEach((r) => checkRoundShape(players, r, 5));
  const st = stats(players, rounds);
  assert.equal(st.repeatedPartners, 0);
  assert.equal(st.sameSexTeams, 0, 'every team is a woman and a man');
  assert.equal(st.expTeams, 0, 'never two experienced players on a team');
  for (const r of rounds) assert.deepEqual(experiencedPerCourt(players, r), [1, 1, 1, 1, 1]);
  for (const r of rounds) assert.equal(r.sitOut.length, 0);
  assert.ok(st.repeatedOpponents <= 6, `few repeated opponents (got ${st.repeatedOpponents})`);
});

test('20 players (8 men, 12 women): two women\'s teams per round, shared out fairly', () => {
  const players = makePlayers(12, 8, 0, 3, 2);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 5 });
  const st = stats(players, rounds);
  assert.equal(st.repeatedPartners, 0);
  assert.equal(st.sameSexTeams, 2 * ROUNDS, 'only as many same-sex teams as the numbers force');
  const women = players.filter((p) => p.sex === 'F').map((p) => p.id);
  assert.ok(spread(st.sameSex, women) <= 1, 'most and least times in a women\'s team differ by at most 1');
  for (const p of players.filter((p) => p.sex === 'M')) assert.equal(st.sameSex.get(p.id), 0);
  assert.equal(st.expTeams, 0);
});

test('23 players: 3 sit out each round, nobody twice', () => {
  const players = makePlayers(11, 12, 0, 2, 3);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 3 });
  rounds.forEach((r) => { checkRoundShape(players, r, 5); assert.equal(r.sitOut.length, 3); });
  const st = stats(players, rounds);
  assert.equal(st.repeatedPartners, 0);
  assert.ok(Math.max(...st.sits.values()) <= 1, '18 sit-outs over 23 people: nobody sits twice');
  assert.ok(st.sameSexTeams <= ROUNDS, 'at most one same-sex team per round (11 women, 12 men)');
});

test('23 players over 9 rounds: sitting out stays fair and never twice in a row', () => {
  const players = makePlayers(11, 12, 0, 2, 3);
  const rounds = planRounds({ players, courts: 5, count: 9, seed: 4 });
  const st = stats(players, rounds);
  assert.ok(spread(st.sits, players.map((p) => p.id)) <= 1, 'nobody sits twice before everyone sat once');
  assert.equal(st.maxSitRow, 1, 'nobody sits twice in a row');
  assert.equal(st.repeatedPartners, 0);
});

test('18 players on 5 courts: 4 courts in use, 2 sit out, nobody twice', () => {
  const players = makePlayers(9, 9, 0, 2, 2);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 9 });
  rounds.forEach((r) => { assert.equal(r.courts.length, 4); assert.equal(r.sitOut.length, 2); });
  const st = stats(players, rounds);
  assert.ok(Math.max(...st.sits.values()) <= 1);
  assert.equal(st.repeatedPartners, 0);
  assert.equal(st.expTeams, 0);
});

test('"Either" players fit any team', () => {
  const players = makePlayers(9, 8, 3, 2, 2, 1);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 2 });
  rounds.forEach((r) => checkRoundShape(players, r, 5));
  const st = stats(players, rounds);
  assert.equal(st.repeatedPartners, 0);
  assert.equal(st.sameSexTeams, 0, '9 women, 8 men and 3 either make 10 teams with no same-sex team');
  assert.equal(st.expTeams, 0);
});

test('11 women and 9 men with 2 "Either": same-sex teams kept to the minimum', () => {
  const players = makePlayers(11, 7, 2, 2, 2);
  const rounds = planRounds({ players, courts: 5, count: ROUNDS, seed: 8 });
  const st = stats(players, rounds);
  assert.equal(st.repeatedPartners, 0);
  // 7 mixed teams, 2 women with an "either" player, 1 team of two women.
  assert.equal(st.sameSexTeams, ROUNDS);
  const women = players.filter((p) => p.sex === 'F').map((p) => p.id);
  assert.ok(spread(st.sameSex, women) <= 1);
});

// ---------- the evening, through the session state ----------

function eveningWith(f, m, opts = {}) {
  const s = S.createState(42);
  S.setSetting(s, 'warmup', opts.warmup ?? true);
  for (let i = 0; i < Math.max(f, m); i++) {
    if (i < f) S.checkIn(s, { sex: 'F', level: i < 2 ? 2 : 1, name: 'Frau ' + i });
    if (i < m) S.checkIn(s, { sex: 'M', level: i < 3 ? 2 : 1 });
  }
  S.ensurePlan(s);
  return s;
}

const MIN = 60000;
const roundsCopy = (s) => JSON.parse(JSON.stringify(s.rounds));
// Run the clock to the end of the current phase (game or changeover).
function playRound(s) {
  const t = s.timer;
  return S.advance(s, t.phase === 'play' ? t.playEnd : t.changeEnd);
}

test('codes follow arrival order per sex', () => {
  const s = S.createState(1);
  const a = S.checkIn(s, { sex: 'F', level: 1 });
  const b = S.checkIn(s, { sex: 'M', level: 2, name: '  Ben ' });
  const c = S.checkIn(s, { sex: 'F', level: 3 });
  const d = S.checkIn(s, { sex: 'X', level: 1 });
  assert.deepEqual([a.code, b.code, c.code, d.code], ['F1', 'M1', 'F2', 'X1']);
  assert.equal(b.name, 'Ben');
  S.addExpected(s, 'Anna\nCarla, Dieter');
  const anna = s.players.find((p) => p.name === 'Anna');
  assert.equal(anna.status, 'expected');
  S.checkIn(s, { id: anna.id, sex: 'F', level: 1 });
  assert.equal(anna.code, 'F3');
  assert.equal(S.counts(s).F, 3);
  assert.equal(S.counts(s).expected, 2);
});

test('the plan holds warm-up plus the set number of rounds', () => {
  const s = eveningWith(10, 10);
  assert.equal(s.rounds.length, 6);
  assert.equal(s.rounds[0].warmup, true);
  assert.deepEqual(S.roundLabel(s, 1), { warmup: false, n: 1 });
  S.setSetting(s, 'warmup', false);
  S.ensurePlan(s);
  assert.equal(s.rounds.length, 5);
  assert.equal(s.rounds[0].warmup, false);
});

test('a late arrival and a leaver change only rounds that have not started', () => {
  const s = eveningWith(10, 10);
  let now = 1_000_000;
  S.startNext(s, now);               // warm-up starts on a tap
  playRound(s); playRound(s);        // warm-up and its changeover: round 1 starts
  assert.equal(s.timer.idx, 1);
  assert.equal(s.timer.phase, 'play');
  const before = roundsCopy(s).slice(0, 2);
  const late = S.checkIn(s, { sex: 'M', level: 1, name: 'Late' });
  S.ensurePlan(s);
  assert.deepEqual(roundsCopy(s).slice(0, 2), before, 'past round and the round in play are unchanged');
  const upcoming = s.rounds.slice(2);
  assert.ok(upcoming.every((r) => [...r.courts.flat(), ...r.sitOut].includes(late.id)), 'the late arrival is in every later round');
  assert.ok(upcoming.every((r) => r.sitOut.length === 1));

  playRound(s); playRound(s);        // round 2 starts
  const leaver = s.players.find((p) => p.code === 'F10');
  S.setStatus(s, leaver.id, 'gone');
  const frozen = roundsCopy(s).slice(0, 3);
  S.ensurePlan(s);
  assert.deepEqual(roundsCopy(s).slice(0, 3), frozen);
  for (const r of s.rounds.slice(3)) {
    assert.ok(![...r.courts.flat(), ...r.sitOut].includes(leaver.id), 'the leaver is out of later rounds');
    assert.equal(r.sitOut.length, 0, '20 players again: nobody sits out');
  }
  const all = S.present(s).concat([leaver]).map((p) => ({ id: p.id, sex: p.sex, level: p.level }));
  assert.equal(stats(all, s.rounds).repeatedPartners, 0);
});

test('a court-count change mid-evening redraws only upcoming rounds', () => {
  const s = eveningWith(10, 10);
  S.startNext(s, 0);
  playRound(s); playRound(s);        // round 1 in play
  const frozen = roundsCopy(s).slice(0, 2);
  S.setSetting(s, 'courts', 4);
  S.ensurePlan(s);
  assert.deepEqual(roundsCopy(s).slice(0, 2), frozen);
  for (const r of s.rounds.slice(2)) { assert.equal(r.courts.length, 4); assert.equal(r.sitOut.length, 4); }
  const players = S.present(s);
  const st = stats(players, s.rounds);
  assert.equal(st.repeatedPartners, 0);
  assert.ok(Math.max(...st.sits.values()) <= 1, '16 sit-outs over 4 rounds for 20 people: nobody twice');
});

test('the next round is fixed once the changeover begins', () => {
  const s = eveningWith(10, 10);
  S.startNext(s, 0);
  playRound(s);                      // horn: changeover, round 1 is next and locked
  assert.equal(s.timer.phase, 'change');
  const next = JSON.stringify(s.rounds[1]);
  S.checkIn(s, { sex: 'F', level: 1 });
  S.ensurePlan(s);
  assert.equal(JSON.stringify(s.rounds[1]), next);
  assert.ok(s.rounds[2].sitOut.length === 1);
});

test('swap two players and redraw one round', () => {
  const s = eveningWith(10, 10);
  const [a, b] = [s.rounds[2].courts[0][0], s.rounds[2].courts[1][1]];
  assert.ok(S.swapPlayers(s, 2, a, b));
  assert.equal(s.rounds[2].courts[0][0], b);
  assert.equal(s.rounds[2].courts[1][1], a);
  const players = S.present(s);
  // The host's swap may itself repeat a partner; the rounds after it add no repeat.
  const bySwap = stats(players, s.rounds.slice(0, 3)).repeatedPartners;
  assert.equal(stats(players, s.rounds).repeatedPartners, bySwap, 'later rounds were drawn again');
  const old = JSON.stringify(s.rounds[3]);
  assert.ok(S.redrawRound(s, 3));
  assert.notEqual(JSON.stringify(s.rounds[3]), old);
  assert.equal(stats(players, s.rounds).repeatedPartners, bySwap);
  S.startNext(s, 0);
  assert.equal(S.swapPlayers(s, 0, a, b), false, 'the round in play cannot change');
  assert.equal(S.redrawRound(s, 0), false);
});

test('timer: absolute times, pause, +1 minute, skip, settings apply from the next timer', () => {
  const s = eveningWith(10, 10, { warmup: false });
  S.setSetting(s, 'gameMin', 12);
  S.setSetting(s, 'changeMin', 3);
  const t0 = 10_000_000;
  S.startNext(s, t0);
  assert.equal(S.view(s, t0 + 5 * MIN).remaining, 7 * MIN);
  // A reload is a JSON round trip; the times are absolute so nothing drifts.
  const reloaded = JSON.parse(JSON.stringify(s));
  assert.equal(S.view(reloaded, t0 + 11 * MIN).remaining, 1 * MIN);
  assert.equal(S.view(s, t0 + 9 * MIN).showNext, false);
  assert.equal(S.view(s, t0 + 10 * MIN).showNext, true, 'next round shows 2 minutes before the horn');
  // Changing the game length now affects the next round, not this one.
  S.setSetting(s, 'gameMin', 10);
  assert.equal(S.view(s, t0 + 5 * MIN).remaining, 7 * MIN);
  S.pause(s, t0 + 6 * MIN);
  assert.deepEqual(S.advance(s, t0 + 30 * MIN), [], 'nothing happens while paused');
  assert.equal(S.view(s, t0 + 30 * MIN).remaining, 6 * MIN);
  S.resume(s, t0 + 10 * MIN);        // paused for 4 minutes
  S.addMinute(s);                    // and one extra minute
  assert.equal(s.timer.playEnd, t0 + 17 * MIN);
  let ev = S.advance(s, t0 + 17 * MIN);
  assert.deepEqual(ev.map((e) => e.type), ['horn']);
  assert.equal(s.timer.phase, 'change');
  assert.equal(s.timer.changeEnd, t0 + 20 * MIN);
  ev = S.advance(s, t0 + 20 * MIN);
  assert.deepEqual(ev.map((e) => e.type), ['start'], 'the next round starts by itself');
  assert.equal(s.timer.idx, 1);
  assert.equal(s.timer.playEnd, t0 + 30 * MIN, 'new game length applies from this round');
  ev = S.skip(s, t0 + 21 * MIN);
  assert.deepEqual(ev.map((e) => e.type), ['horn']);
  ev = S.skip(s, t0 + 22 * MIN);
  assert.deepEqual(ev.map((e) => e.type), ['start']);
  assert.equal(s.timer.idx, 2);
  // A screen that was off for a long time catches up through several rounds at once.
  ev = S.advance(s, t0 + 200 * MIN);
  assert.equal(s.timer.phase, 'done');
  assert.ok(s.rounds.every((r) => r.started));
});

test('timer: -1 minute, and restarting the round in play keeps its line-up', () => {
  const s = eveningWith(10, 10, { warmup: false });
  S.setSetting(s, 'gameMin', 12);
  S.setSetting(s, 'changeMin', 3);
  const t0 = 10_000_000;
  S.startNext(s, t0);
  assert.equal(S.minusMinute(s, t0), true);
  assert.equal(S.view(s, t0).remaining, 11 * MIN);
  assert.equal(S.minusMinute(s, t0 + 10 * MIN), false, 'a minute left: -1 does not end the game (Skip does)');
  assert.equal(S.view(s, t0 + 10 * MIN).remaining, 1 * MIN);
  S.pause(s, t0 + 2 * MIN);
  assert.equal(S.minusMinute(s, t0 + 50 * MIN), true, 'works while paused, from the paused clock');
  assert.equal(S.view(s, t0 + 50 * MIN).remaining, 8 * MIN);
  // Through the first changeover into round 2, then restart round 2.
  S.resume(s, t0 + 2 * MIN);
  S.advance(s, t0 + 11 * MIN);       // the horn came at 10 minutes
  assert.equal(s.timer.phase, 'change');
  assert.equal(S.restartRound(s), false, 'only the round in play can restart');
  S.advance(s, t0 + 16 * MIN);
  assert.equal(s.timer.idx, 1);
  const lineUp = JSON.stringify(s.rounds[1].courts);
  S.pause(s, t0 + 18 * MIN);
  assert.equal(S.restartRound(s), true);
  assert.equal(s.timer.phase, 'idle');
  assert.equal(s.timer.idx, 0);
  assert.equal(S.nextIndex(s), 1, 'round 2 waits for its start tap');
  // A late arrival now must not change the restarted round.
  S.checkIn(s, { sex: 'M', level: 1 });
  S.ensurePlan(s);
  assert.equal(JSON.stringify(s.rounds[1].courts), lineUp);
  assert.deepEqual(S.advance(s, t0 + 60 * MIN), [], 'nothing runs until the host starts it');
  S.startNext(s, t0 + 60 * MIN);
  assert.equal(s.timer.idx, 1);
  assert.equal(S.view(s, t0 + 60 * MIN).remaining, 12 * MIN, 'the full length again');
  assert.equal(S.view(s, t0 + 60 * MIN).paused, false);
});

test('a check-in applied again after a sync conflict stays the same player with the next free code', () => {
  const base = S.createState(1);
  const a = JSON.parse(JSON.stringify(base));
  const fromA = (s) => S.checkIn(s, { sex: 'F', level: 1, newId: 'pA' });
  assert.equal(fromA(a).code, 'F1', 'device A first thinks F1');
  const hub = JSON.parse(JSON.stringify(base));
  S.checkIn(hub, { sex: 'F', level: 2, newId: 'pB' });  // device B got there first
  const p = fromA(hub);                                   // A's change re-applied on the newer state
  assert.equal(p.id, 'pA');
  assert.equal(p.code, 'F2');
  assert.deepEqual(hub.players.map((x) => x.id + '=' + x.code), ['pB=F1', 'pA=F2']);
});

test('rounds that still fit before the end time', () => {
  const s = eveningWith(10, 10, { warmup: false });
  const now = new Date(2026, 10, 15, 19, 0).getTime();
  S.setSetting(s, 'endTime', '20:00');
  assert.equal(S.roundsThatFit(s, now).fit, 4, '12+3+12+3+12+3+12 = 57 minutes');
  S.startNext(s, now);
  assert.equal(S.roundsThatFit(s, now).fit, 3);
});

test('remove deletes a mistaken entry but keeps players who already played', () => {
  const s = eveningWith(4, 4, { warmup: false });
  const extra = S.checkIn(s, { sex: 'F', level: 1 });
  assert.equal(S.removePlayer(s, extra.id), 'removed');
  assert.equal(S.checkIn(s, { sex: 'F', level: 1 }).code, 'F5', 'the code is free again');
  S.startNext(s, 0);
  const played = s.rounds[0].courts[0][0];
  assert.equal(S.removePlayer(s, played), 'gone');
});

test('sample players for a generic backup schedule', () => {
  const s = S.createState(3);
  S.fillSample(s, 10, 10);
  S.ensurePlan(s);
  assert.equal(S.present(s).length, 20);
  assert.equal(s.sample, true);
  assert.deepEqual(s.players.slice(0, 4).map((p) => p.code), ['F1', 'M1', 'F2', 'M2']);
  assert.equal(stats(S.present(s), s.rounds).repeatedPartners, 0);
});

test('draw time: 32 players on 8 courts, well under half a second per round', () => {
  const players = makePlayers(16, 16, 0, 4, 4);
  const history = planRounds({ players, courts: 8, count: 3, seed: 1 });
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    drawRound({ players, courts: 8, history, seed: 100 + k });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  // A mid-range phone is several times slower than a laptop; keep a wide margin.
  assert.ok(median < 60, `median draw ${median.toFixed(1)} ms`);
  console.log(`# draw time for 32 players: median ${median.toFixed(1)} ms (max ${times[4].toFixed(1)} ms)`);
});
