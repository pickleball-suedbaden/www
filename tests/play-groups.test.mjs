// Tests for the two playing groups (play/js/session.js, play/js/draw.js). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stats, courtsOf, groupIn, planRounds, drawRoundGroups, isExperienced } from '../play/js/draw.js';
import * as S from '../play/js/session.js';

const MIN = 60000;
const copy = (o) => JSON.parse(JSON.stringify(o));
const placed = (r) => [...r.courts.flat(), ...r.sitOut];
function playRound(s) {
  const t = s.timer;
  return S.advance(s, t.phase === 'play' ? t.playEnd : t.changeEnd);
}

/**
 * An evening with groups on. `g1` and `g2` are [women, men] per group; group 1 plays on `split` courts.
 * Arrivals alternate between the groups, so codes are mixed across them as on a real evening.
 */
function evening(g1, g2, { courts = 5, split = 2, warmup = true, seed = 42 } = {}) {
  const s = S.createState(seed);
  S.setSetting(s, 'courts', courts);
  S.setSetting(s, 'warmup', warmup);
  S.setGroups(s, true);
  S.setSetting(s, 'groupCourts', split);
  const queue = [];
  for (const [g, [f, m]] of [[1, g1], [2, g2]]) {
    for (let i = 0; i < f; i++) queue.push({ sex: 'F', group: g, i });
    for (let i = 0; i < m; i++) queue.push({ sex: 'M', group: g, i });
  }
  queue.sort((a, b) => a.i - b.i || a.group - b.group);
  for (const q of queue) S.checkIn(s, { sex: q.sex, group: q.group });
  S.ensurePlan(s);
  return s;
}

const groupPlayers = (s, g) => S.present(s).filter((p) => S.groupOf(p) === g);

/** Every round keeps each group on its own courts, with only its own players. */
function checkGroups(s, rounds = s.rounds) {
  for (const r of rounds) {
    if (!r.groups) continue;
    const { groups } = courtsOf(r);
    assert.equal(new Set(placed(r)).size, placed(r).length, 'nobody is placed twice');
    for (const g of groups) {
      for (const c of g.list) {
        assert.ok(c.num >= g.first && c.num < g.first + 8, 'court numbers start at the group\'s first court');
        for (const id of c.ids) assert.equal(groupIn(r, id), g.k);
      }
      if (g.k === 0) assert.equal(g.first, 1, 'group 1 plays on the lowest-numbered courts');
    }
    assert.deepEqual(r.sitOut.slice().sort(), groups.flatMap((g) => g.sitOut).sort(), 'the flat sit-out list is the groups\' lists');
  }
}

test('two groups at 20 players: 8 advanced on courts 1-2, 12 beginners on courts 3-5', () => {
  const s = evening([4, 4], [6, 6]);
  assert.equal(s.rounds.length, 6);
  checkGroups(s);
  for (const r of s.rounds) {
    const { courts, groups } = courtsOf(r);
    assert.deepEqual(courts.map((c) => c.num), [1, 2, 3, 4, 5]);
    assert.deepEqual(groups.map((g) => [g.first, g.courts]), [[1, 2], [3, 3]]);
    assert.equal(r.sitOut.length, 0);
    for (const c of courts) {
      const g = c.group + 1;
      for (const id of c.ids) assert.equal(S.groupOf(S.byId(s, id)), g, 'a group plays only on its own courts');
    }
  }
  const adv = groupPlayers(s, 1), beg = groupPlayers(s, 2);
  const a = stats(adv, s.rounds), b = stats(beg, s.rounds);
  assert.equal(a.repeatedPartners, 0, 'advanced: no repeated partner over 6 rounds');
  assert.equal(b.repeatedPartners, 0, 'beginners: no repeated partner');
  assert.equal(b.sameSexTeams, 0, 'beginners (6 women, 6 men): every team mixed');
  // 4 women and 4 men can make only 4 rounds of new mixed pairs; after that, same-sex teams come
  // before a repeated partner, and they are shared out fairly.
  assert.ok(a.sameSexTeams <= 2 * 4, `advanced: same-sex teams only once mixed pairs run out (got ${a.sameSexTeams})`);
  const sp = (ids) => Math.max(...ids.map((id) => a.sameSex.get(id))) - Math.min(...ids.map((id) => a.sameSex.get(id)));
  assert.ok(sp(adv.filter((p) => p.sex === 'F').map((p) => p.id)) <= 1);
  assert.ok(sp(adv.filter((p) => p.sex === 'M').map((p) => p.id)) <= 1);
  const info = S.groupInfo(s);
  assert.deepEqual(info.groups.map((g) => [g.present, g.courts, g.used, g.sitting]), [[8, 2, 2, 0], [12, 3, 3, 0]]);
  assert.equal(info.suggest, null);
  assert.deepEqual(S.counts(s).groups.map((g) => [g.F, g.M]), [[4, 4], [6, 6]]);
});

test('uneven groups: each group sits out on its own, fairly and never twice in a row', () => {
  const s = evening([6, 5], [7, 7], { warmup: false });
  S.setSetting(s, 'rounds', 8);
  S.ensurePlan(s);
  checkGroups(s);
  for (const r of s.rounds) {
    const { groups } = courtsOf(r);
    assert.equal(groups[0].sitOut.length, 3, '11 advanced on 2 courts: 3 sit out');
    assert.equal(groups[1].sitOut.length, 2, '14 beginners on 3 courts: 2 sit out');
  }
  for (const g of [1, 2]) {
    const mine = groupPlayers(s, g);
    const st = stats(mine, s.rounds);
    const sits = mine.map((p) => st.sits.get(p.id));
    assert.ok(Math.max(...sits) - Math.min(...sits) <= 1, `group ${g}: sitting out shared fairly`);
    assert.equal(st.maxSitRow, 1, `group ${g}: nobody sits twice in a row`);
    assert.equal(st.repeatedPartners, 0);
  }
});

test('a group too small for one court: its players sit out and the setup says so', () => {
  const s = evening([2, 1], [9, 8], { split: 2 });
  checkGroups(s);
  for (const r of s.rounds) {
    const { groups } = courtsOf(r);
    assert.equal(groups[0].courts, 0, '3 advanced: no court in use');
    assert.equal(groups[0].sitOut.length, 3);
    assert.equal(groups[1].first, 3, 'beginners still start on court 3');
    assert.equal(groups[1].courts, 3);
  }
  const info = S.groupInfo(s);
  assert.equal(info.groups[0].tooSmall, true);
  assert.equal(info.groups[1].tooSmall, false);
  // Giving court 2 to the beginners lets 4 more of them play.
  assert.deepEqual(info.suggest, { groupCourts: 1, to: 1, from: 0, saves: 4 });
});

test('a player moves group mid-evening: from the next open round, keeping codes and history', () => {
  const s = evening([4, 4], [6, 6]);
  S.startNext(s, 0);
  playRound(s); playRound(s);          // warm-up played, round 1 in play
  const mover = groupPlayers(s, 2).find((p) => p.sex === 'F');
  const code = mover.code;
  const frozen = copy(s.rounds.slice(0, 2));
  assert.ok(S.setGroup(s, mover.id, 1));
  S.ensurePlan(s);
  assert.equal(mover.code, code, 'the code never changes on a move');
  assert.deepEqual(copy(s.rounds.slice(0, 2)), frozen, 'past round and the round in play keep their split');
  assert.equal(groupIn(s.rounds[1], mover.id), 1, 'still a beginner in the round in play');
  for (const r of s.rounds.slice(2)) assert.equal(groupIn(r, mover.id), 0, 'advanced from the next round on');
  checkGroups(s);
  // The mover's whole evening counts: no partner twice across both groups.
  const all = S.present(s).map((p) => ({ id: p.id, sex: p.sex, level: 1 }));
  assert.equal(stats(all, s.rounds).repeatedPartners, 0);
  // 9 advanced on 2 courts now: one sits out per round in group 1; the mover sat out none so far.
  for (const r of s.rounds.slice(2)) assert.equal(courtsOf(r).groups[0].sitOut.length, 1);
  assert.notEqual(s.rounds[2].groups[0].sitOut[0], mover.id, 'someone who has played every round sits out first');
});

test('a court split change mid-evening applies from the next open round', () => {
  const s = evening([6, 6], [4, 4]);
  let info = S.groupInfo(s);
  assert.deepEqual(info.groups.map((g) => g.sitting), [4, 0]);
  assert.deepEqual(info.suggest, { groupCourts: 3, to: 0, from: 1, saves: 4 }, 'one court more for group 1: 4 fewer sit out');
  S.startNext(s, 0);
  playRound(s);                        // horn: the changeover fixes round 1
  const frozen = copy(s.rounds.slice(0, 2));
  S.setSetting(s, 'groupCourts', 3);
  S.ensurePlan(s);
  assert.deepEqual(copy(s.rounds.slice(0, 2)), frozen, 'the fixed rounds keep the old split');
  assert.deepEqual(courtsOf(s.rounds[1]).groups.map((g) => [g.first, g.courts]), [[1, 2], [3, 2]]);
  for (const r of s.rounds.slice(2)) {
    assert.deepEqual(courtsOf(r).groups.map((g) => [g.first, g.courts]), [[1, 3], [4, 2]]);
    assert.equal(r.sitOut.length, 0);
  }
  checkGroups(s);
  info = S.groupInfo(s);
  assert.equal(info.suggest, null);
  // Fewer courts in total: group 1 keeps its courts as far as possible.
  S.setSetting(s, 'courts', 4);
  assert.deepEqual(S.groupCourts(s), [3, 1]);
  S.setSetting(s, 'courts', 3);
  assert.deepEqual(S.groupCourts(s), [2, 1], 'each group keeps at least one court');
});

test('groups switched off for the final round: one last round with everyone together', () => {
  const s = evening([4, 4], [6, 6]);
  S.startNext(s, 0);
  for (let k = 0; k < 6; k++) playRound(s); // warm-up, rounds 1 and 2 played; round 3 in play
  assert.equal(s.timer.idx, 3);
  const frozen = copy(s.rounds.slice(0, 4));
  const idx = S.togetherFrom(s, { last: true });
  S.ensurePlan(s);
  assert.equal(idx, 4);
  assert.equal(s.rounds.length, 5, 'round 4 is now the last round');
  assert.deepEqual(copy(s.rounds.slice(0, 4)), frozen, 'played rounds keep their groups');
  const last = s.rounds[4];
  assert.equal(last.groups, undefined, 'the last round has no groups');
  assert.equal(last.courts.length, 5);
  const adv = new Set(groupPlayers(s, 1).map((p) => p.id));
  assert.ok(last.courts.some((c) => c.some((id) => adv.has(id)) && c.some((id) => !adv.has(id))), 'the groups mix');
  // Group 1 counts as experienced: never two advanced players on one team.
  const as = S.present(s).map((p) => ({ id: p.id, sex: p.sex, level: adv.has(p.id) ? 2 : 1 }));
  assert.equal(stats(as, [last]).expTeams, 0);
  assert.equal(stats(as, s.rounds).repeatedPartners, 0, 'no repeated partner across the whole evening');
  playRound(s); playRound(s);          // round 4 starts
  assert.equal(s.timer.idx, 4);
  playRound(s);
  assert.equal(s.timer.phase, 'done');
  // Groups switched off in the changeover: the fixed next round keeps its groups, the one after has none.
  const t = evening([4, 4], [6, 6]);
  S.startNext(t, 0);
  playRound(t);
  assert.equal(S.togetherFrom(t, { last: true }), 2);
  S.ensurePlan(t);
  assert.ok(t.rounds[1].groups, 'the round people are walking to keeps its groups');
  assert.equal(t.rounds.length, 3);
  assert.equal(t.rounds[2].groups, undefined);
});

test('an old saved session (version 1) loads with groups off and keeps its plan', () => {
  const old = JSON.parse(fs.readFileSync(new URL('./fixtures/session-v1.json', import.meta.url), 'utf8'));
  assert.equal(old.v, 1);
  const s = S.migrate(copy(old));
  assert.equal(s.v, S.VERSION);
  assert.equal(s.settings.groups, false);
  assert.deepEqual(s.settings.groupNames, ['', '']);
  assert.equal(S.ensurePlan(s), false, 'nothing is drawn again');
  assert.deepEqual(s.rounds, old.rounds);
  assert.deepEqual(S.migrate(copy(s)), s, 'migrating twice changes nothing');
  // The evening goes on as before.
  playRound(s); playRound(s);
  assert.equal(s.timer.idx, 2);
  // Switching groups on later: players without a group get one from their level, marked as automatic.
  const auto = S.setGroups(s, true);
  assert.equal(auto, 20);
  const g1 = S.present(s).filter((p) => p.group === 1);
  assert.ok(g1.length > 0 && g1.every((p) => p.level >= 2 && p.groupAuto));
  assert.ok(S.present(s).filter((p) => p.level < 2).every((p) => p.group === 2));
  assert.equal(S.groupInfo(s).auto, 20);
  S.confirmGroups(s);
  assert.equal(S.groupInfo(s).auto, 0);
  S.ensurePlan(s);
  checkGroups(s);
  assert.equal(s.rounds[2].groups, undefined, 'the round in play keeps its draw');
  assert.ok(s.rounds[3].groups);
});

test('check-in with groups: codes stay unique across groups; swaps stay inside a group; renames redraw nothing', () => {
  const s = S.createState(9);
  S.setGroups(s, true);
  const a = S.checkIn(s, { sex: 'F', group: 1 });
  const b = S.checkIn(s, { sex: 'F', group: 2 });
  const c = S.checkIn(s, { sex: 'M', group: 2, name: 'Ben' });
  assert.deepEqual([a.code, b.code, c.code], ['F1', 'F2', 'M1']);
  assert.equal(a.level, 0, 'no level question with groups');
  assert.equal(a.groupAuto, undefined);
  S.setGroup(s, b.id, 1);
  assert.equal(b.code, 'F2');
  // A player checked in without a group while groups are on gets a visible automatic one.
  const d = S.checkIn(s, { sex: 'M', level: 3 });
  assert.equal(d.group, 1);
  assert.equal(d.groupAuto, true);
  S.editPlayer(s, d.id, { group: 1 });
  assert.equal(d.groupAuto, undefined, 'confirming in the player dialog clears the mark');

  const e = evening([4, 5], [6, 6], { warmup: false });
  const r = e.rounds[1];
  const g1 = courtsOf(r).groups[0], g2 = courtsOf(r).groups[1];
  assert.equal(S.swapPlayers(e, 1, g1.list[0].ids[0], g2.list[0].ids[0]), false, 'no swap across groups');
  const sitter = g1.sitOut[0], player = g1.list[1].ids[2];
  assert.ok(S.swapPlayers(e, 1, sitter, player));
  assert.deepEqual(e.rounds[1].groups[0].sitOut, [player], 'the group\'s sit-out list follows the swap');
  checkGroups(e);

  const before = copy(e.rounds.map((x) => x.courts));
  S.startNext(e, 0);
  S.setGroupName(e, 0, '  Profis ');
  assert.equal(S.ensurePlan(e), true);
  assert.deepEqual(e.rounds.map((x) => x.courts), before, 'a new name needs no new draw');
  assert.equal(e.rounds[0].groups[0].name, '', 'the round in play keeps its name');
  assert.ok(e.rounds.slice(1).every((x) => x.groups[0].name === 'Profis'));
});

test('sample players with groups fill group 1\'s courts first', () => {
  const s = S.createState(3);
  S.setGroups(s, true);
  S.fillSample(s, 10, 10);
  S.ensurePlan(s);
  assert.deepEqual(S.groupInfo(s).groups.map((g) => [g.F, g.M, g.courts]), [[4, 4, 2], [6, 6, 3]]);
  checkGroups(s);
});

test('draw time: 32 players in two groups on 8 courts, well under half a second per round', () => {
  const players = [];
  for (let i = 0; i < 16; i++) players.push({ id: 'F' + i, sex: 'F', level: 1, group: i < 6 ? 1 : 2 });
  for (let i = 0; i < 16; i++) players.push({ id: 'M' + i, sex: 'M', level: 1, group: i < 7 ? 1 : 2 });
  const groups = [{ courts: 3, first: 1 }, { courts: 5, first: 4 }];
  const history = planRounds({ players, groups, count: 3, seed: 1 });
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    const r = drawRoundGroups({ players, groups, history, seed: 100 + k });
    times.push(performance.now() - t);
    assert.equal(placed(r).length, 32);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 60, `median draw ${times[2].toFixed(1)} ms`);
  console.log(`# draw time for 32 players in two groups: median ${times[2].toFixed(1)} ms (max ${times[4].toFixed(1)} ms)`);
  // And a whole evening through the session state stays quick.
  const s = evening([6, 7], [10, 9], { courts: 8, split: 3 });
  const t = performance.now();
  S.setGroup(s, S.present(s)[0].id, 2);
  S.ensurePlan(s);
  assert.ok(performance.now() - t < 500, 'redrawing all upcoming rounds');
  assert.equal(isExperienced({ level: 1 }), false);
});
