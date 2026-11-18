// Pickleball Südbaden e.V. · session organiser · the draw.
// Plain ES module, no dependencies: runs in the browser and in Node (tests/play-draw.test.mjs).
//
// A round puts 4 players on each court (team A = slots 0,1; team B = slots 2,3) and the rest
// sit out. The search tries random line-ups, improves each by pairwise swaps and keeps the cheapest.
// The cost encodes the rules in priority order (weights fall by rule):
//   1. no repeated partner; sitting out shared fairly (nobody sits twice before everyone sat once,
//      never twice in a row if avoidable)
//   2. mixed teams as far as numbers allow; same-sex teams shared out fairly per sex
//      ("Either" players, sex X, fit any team)
//   3. never two experienced players (level 2 or 3) on one team; one per court where possible
//   4. new opponents preferred
//   5. the two teams on a court as even as possible
//
// Players: { id, sex: 'F' | 'M' | 'X', level: 1 | 2 | 3 } (and group: 1 | 2 when the evening has groups).
// A round: { courts: [[a, b, c, d], ...], sitOut: [id, ...] } with player ids.
// With groups, each group draws only among its own players on its own courts (drawRoundGroups), and
// the round also carries groups: [{ name, first, courts, sitOut }]: `first` is the group's first court
// number, `courts` how many of the round's courts (in order) belong to it, `sitOut` who sits out there.
// The flat courts and sitOut lists stay complete, so the history counts work across both groups.

export const W = {
  partner: 1e6,      // per earlier time together as partners
  sitFair: 1e6,      // per step away from "fewest sits first"
  sitRow: 2e5,       // sitting out twice in a row
  sameSex: 5e4,      // a same-sex team (FF or MM)
  sameSexFair: 2e4,  // per same-sex team more than the least-served player of that sex
  expTeam: 5e3,      // two experienced players on one team
  expCourt: 2e3,     // per (experienced on court - 1)^2
  opponent: 300,     // per earlier meeting as opponents
  oppPartner: 150,   // playing against a former partner
  even: 40,          // per (team strength difference)^2
};

export const isExperienced = (p) => p.level >= 2;

// Small fast seeded generator (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function courtsInUse(playerCount, courts) {
  return Math.max(0, Math.min(courts, Math.floor(playerCount / 4)));
}

// Counts from earlier rounds, for the players present now.
// Rounds where a present player was not on a court (sat out or not there yet) count as sits,
// so a late arrival does not sit out first.
export function tally(players, history) {
  const n = players.length;
  const idx = new Map(players.map((p, i) => [p.id, i]));
  const partner = Array.from({ length: n }, () => new Int16Array(n));
  const opp = Array.from({ length: n }, () => new Int16Array(n));
  const sits = new Int16Array(n);
  const sameSex = new Int16Array(n);
  const lastSat = new Uint8Array(n);
  const sexOf = (id) => { const i = idx.get(id); return i === undefined ? null : players[i].sex; };
  history.forEach((round, r) => {
    const playing = new Set();
    for (const c of round.courts) {
      for (const id of c) playing.add(id);
      const teams = [[c[0], c[1]], [c[2], c[3]]];
      for (const [p, q] of teams) {
        const i = idx.get(p), j = idx.get(q);
        if (i !== undefined && j !== undefined) { partner[i][j]++; partner[j][i]++; }
        const sp = sexOf(p), sq = sexOf(q);
        if (sp && sp === sq && sp !== 'X') { if (i !== undefined) sameSex[i]++; if (j !== undefined) sameSex[j]++; }
      }
      for (const p of teams[0]) for (const q of teams[1]) {
        const i = idx.get(p), j = idx.get(q);
        if (i !== undefined && j !== undefined) { opp[i][j]++; opp[j][i]++; }
      }
    }
    for (let i = 0; i < n; i++) if (!playing.has(players[i].id)) sits[i]++;
    if (r === history.length - 1) for (const id of round.sitOut || []) { const i = idx.get(id); if (i !== undefined) lastSat[i] = 1; }
  });
  return { idx, partner, opp, sits, sameSex, lastSat };
}

/**
 * Draw one round.
 * @param {object} o
 * @param {Array} o.players present players
 * @param {number} o.courts courts available
 * @param {Array} [o.history] earlier rounds (started and already planned), oldest first
 * @param {number} [o.seed]
 * @param {number} [o.restarts] random restarts (default scales with player count)
 */
export function drawRound({ players, courts, history = [], seed = 1, restarts }) {
  const n = players.length;
  const used = courtsInUse(n, courts);
  const slots = used * 4;
  if (used === 0) return { courts: [], sitOut: players.map((p) => p.id), cost: 0 };

  const rand = rng(seed);
  const t = tally(players, history);
  const sex = players.map((p) => p.sex);
  const exp = players.map((p) => (isExperienced(p) ? 1 : 0));
  const str = players.map((p) => p.level || 1);

  // Sitting out: the threshold is the sit count of the nb-th fewest.
  const nb = n - slots;
  const sorted = Array.from(t.sits).sort((a, b) => a - b);
  const T = nb > 0 ? sorted[nb - 1] : -1;
  // Same-sex fairness baseline per sex.
  const minSs = { F: Infinity, M: Infinity };
  for (let i = 0; i < n; i++) if (sex[i] !== 'X') minSs[sex[i]] = Math.min(minSs[sex[i]], t.sameSex[i]);

  const P = t.partner, O = t.opp;
  // Cost of playing (not sitting) when you should sit to keep sits fair.
  const playCost = new Float64Array(n);
  const benchCost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    playCost[i] = nb > 0 && t.sits[i] < T ? W.sitFair * (T - t.sits[i]) : 0;
    benchCost[i] = (t.sits[i] > T ? W.sitFair * (t.sits[i] - T) : 0) + (t.lastSat[i] ? W.sitRow : 0);
  }

  const teamCost = (p, q) => {
    let c = W.partner * P[p][q];
    if (sex[p] === sex[q] && sex[p] !== 'X') {
      c += W.sameSex + W.sameSexFair * ((t.sameSex[p] - minSs[sex[p]]) + (t.sameSex[q] - minSs[sex[q]]));
    }
    if (exp[p] && exp[q]) c += W.expTeam;
    return c;
  };
  const courtCost = (a, b, x, y) => {
    let c = playCost[a] + playCost[b] + playCost[x] + playCost[y];
    c += teamCost(a, b) + teamCost(x, y);
    c += W.opponent * (O[a][x] + O[a][y] + O[b][x] + O[b][y]);
    c += W.oppPartner * (P[a][x] + P[a][y] + P[b][x] + P[b][y]);
    const d = (str[a] + str[b]) - (str[x] + str[y]);
    c += W.even * d * d;
    const e = exp[a] + exp[b] + exp[x] + exp[y] - 1;
    c += W.expCourt * e * e;
    return c;
  };

  const pos = players.map((_, i) => i);
  const unitCost = (k) => {
    if (k < slots) { const b = k - (k % 4); return courtCost(pos[b], pos[b + 1], pos[b + 2], pos[b + 3]); }
    return benchCost[pos[k]];
  };
  const unitOf = (k) => (k < slots ? (k >> 2) : 1000 + k);

  const nRestarts = restarts ?? (n <= 12 ? 30 : n <= 24 ? 50 : 60);
  let best = null, bestCost = Infinity;
  const order = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (i >= slots && j >= slots) continue;                 // bench with bench: no change
    if (i < slots && j < slots && (i >> 1) === (j >> 1)) continue; // within one team: no change
    order.push(i * 64 + j);
  }

  for (let r = 0; r < nRestarts; r++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const s = pos[i]; pos[i] = pos[j]; pos[j] = s; }
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const s = order[i]; order[i] = order[j]; order[j] = s; }
    let improved = true;
    while (improved) {
      improved = false;
      for (const code of order) {
        const i = code >> 6, j = code & 63;
        const ui = unitOf(i), uj = unitOf(j);
        const before = ui === uj ? unitCost(i) : unitCost(i) + unitCost(j);
        let s = pos[i]; pos[i] = pos[j]; pos[j] = s;
        const after = ui === uj ? unitCost(i) : unitCost(i) + unitCost(j);
        if (after < before - 1e-9) improved = true;
        else { s = pos[i]; pos[i] = pos[j]; pos[j] = s; }
      }
    }
    let total = 0;
    for (let c = 0; c < used; c++) total += unitCost(c * 4);
    for (let k = slots; k < n; k++) total += unitCost(k);
    if (total < bestCost) { bestCost = total; best = pos.slice(); }
    if (bestCost === 0) break;
  }

  const ids = best.map((i) => players[i].id);
  const out = [];
  for (let c = 0; c < used; c++) out.push(ids.slice(c * 4, c * 4 + 4));
  return { courts: out, sitOut: ids.slice(slots), cost: bestCost };
}

/**
 * Draw one round with groups. Each group draws only among its own players (player.group = k + 1)
 * on its own courts; the whole evening's history counts, so someone who moved group keeps their
 * past partners, opponents and sit-outs.
 * @param {Array} o.groups [{ courts, first, name }] in court order (group 1 on the lowest courts)
 */
export function drawRoundGroups({ players, groups, history = [], seed = 1, restarts }) {
  const courts = [], sitOut = [], out = [];
  groups.forEach((g, k) => {
    const mine = players.filter((p) => p.group === k + 1);
    const r = drawRound({ players: mine, courts: g.courts, history, seed: hashSeed(seed, 'group', k), restarts });
    courts.push(...r.courts);
    sitOut.push(...r.sitOut);
    out.push({ name: g.name ?? '', first: g.first, courts: r.courts.length, sitOut: r.sitOut });
  });
  return { courts, sitOut, groups: out };
}

/** Plan `count` rounds after `history`, each one seeing the ones before it. */
export function planRounds({ players, courts, groups = null, history = [], count, seed = 1 }) {
  const all = history.slice();
  const out = [];
  for (let k = 0; k < count; k++) {
    const sd = hashSeed(seed, all.length);
    const r = groups ? drawRoundGroups({ players, groups, history: all, seed: sd }) : drawRound({ players, courts, history: all, seed: sd });
    const round = groups ? { courts: r.courts, sitOut: r.sitOut, groups: r.groups } : { courts: r.courts, sitOut: r.sitOut };
    all.push(round);
    out.push(round);
  }
  return out;
}

/**
 * The courts of a round with their real numbers and groups: [{ ids, num, group }] (group -1 without
 * groups), plus the groups with their slice of the courts. Used by the board, the lists and print.
 */
export function courtsOf(round) {
  if (!round.groups) return { courts: round.courts.map((ids, k) => ({ ids, num: k + 1, group: -1 })), groups: null };
  const courts = [], groups = [];
  let i = 0;
  round.groups.forEach((g, k) => {
    const mine = round.courts.slice(i, i + g.courts).map((ids, j) => ({ ids, num: g.first + j, group: k }));
    courts.push(...mine);
    groups.push({ ...g, k, list: mine });
    i += g.courts;
  });
  return { courts, groups };
}

/** Which group of `round` a player is in (-1 if the round has no groups or not the player). */
export function groupIn(round, id) {
  if (!round || !round.groups) return -1;
  for (const g of courtsOf(round).groups) if (g.sitOut.includes(id) || g.list.some((c) => c.ids.includes(id))) return g.k;
  return -1;
}

/** Evening statistics, used by the tests and for a quick check of a plan. */
export function stats(players, rounds) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const partner = new Map(), opp = new Map();
  const sameSex = new Map(players.map((p) => [p.id, 0]));
  const sits = new Map(players.map((p) => [p.id, 0]));
  let maxSitRow = 0;
  const lastSat = new Map();
  let expTeams = 0, sameSexTeams = 0;
  rounds.forEach((r, ri) => {
    for (const c of r.courts) {
      for (const [p, q] of [[c[0], c[1]], [c[2], c[3]]]) {
        partner.set(key(p, q), (partner.get(key(p, q)) || 0) + 1);
        const P = byId.get(p), Q = byId.get(q);
        if (P && Q && P.sex === Q.sex && P.sex !== 'X') { sameSexTeams++; sameSex.set(p, sameSex.get(p) + 1); sameSex.set(q, sameSex.get(q) + 1); }
        if (P && Q && isExperienced(P) && isExperienced(Q)) expTeams++;
      }
      for (const p of [c[0], c[1]]) for (const q of [c[2], c[3]]) opp.set(key(p, q), (opp.get(key(p, q)) || 0) + 1);
    }
    for (const id of r.sitOut) {
      sits.set(id, (sits.get(id) || 0) + 1);
      const row = lastSat.get(id) === ri - 1 ? 2 : 1;
      maxSitRow = Math.max(maxSitRow, row);
      lastSat.set(id, ri);
    }
  });
  return {
    repeatedPartners: [...partner.values()].filter((v) => v > 1).length,
    repeatedOpponents: [...opp.values()].filter((v) => v > 1).length,
    sameSexTeams, expTeams, sameSex, sits, maxSitRow,
  };
}
