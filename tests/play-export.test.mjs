// Tests for saving a session as a file (play/js/session.js exportFile). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../play/js/session.js';

test('the file holds the whole session and is named after the day the first round started', () => {
  const s = S.createState(7);
  s.players.push({ id: 'p1', code: 'F1', sex: 'f', name: 'Anna' });
  s.rounds.push({ started: true, locked: true, startedAt: new Date(2026, 10, 22, 15, 5).getTime(), courts: [], sitOut: [] });
  const later = new Date(2026, 10, 23, 1, 0).getTime(); // saved after midnight: the name keeps the playing day
  const { name, text } = S.exportFile(s, later);
  assert.equal(name, 'spieltreff-2026-11-22.json');
  const doc = JSON.parse(text);
  assert.equal(doc.app, 'pbsb-spieltreff');
  assert.equal(doc.exported, new Date(later).toISOString());
  assert.deepEqual(doc.state, s);
});

test('before any round has started the name carries today', () => {
  const now = new Date(2026, 0, 5, 14, 0).getTime();
  assert.equal(S.exportFile(S.createState(1), now).name, 'spieltreff-2026-01-05.json');
});
