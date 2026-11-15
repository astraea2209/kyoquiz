import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORING, scoreFull, scoreRandom } from '../js/scoring.js';

test('랜덤듣기 점수: 구간 계수', () => {
  assert.equal(scoreRandom({ clipLength: 3, replayUsed: false }), 150);
  assert.equal(scoreRandom({ clipLength: 5, replayUsed: false }), 100);
  assert.equal(scoreRandom({ clipLength: 10, replayUsed: false }), 70);
});

test('랜덤듣기 점수: 다시듣기 감점', () => {
  assert.equal(scoreRandom({ clipLength: 3, replayUsed: true }), 130);
  assert.equal(scoreRandom({ clipLength: 5, replayUsed: true }), 80);
  assert.equal(scoreRandom({ clipLength: 10, replayUsed: true }), 50);
});

test('랜덤듣기 점수: 최소 10점', () => {
  const harsh = { ...SCORING.random, replayPenalty: 95 };
  assert.equal(scoreRandom({ clipLength: 10, replayUsed: true }, harsh), 10); // 70-95 → 10
  assert.equal(scoreRandom({ clipLength: 3, replayUsed: true }, harsh), 55);
  // 알 수 없는 구간 길이는 계수 1
  assert.equal(scoreRandom({ clipLength: 7, replayUsed: false }), 100);
});

test('전체듣기 점수: 경과 시간에 따라 100 → 20', () => {
  assert.equal(scoreFull({ elapsed: 0 }), 100);
  assert.equal(scoreFull({ elapsed: 15 }), 60);
  assert.equal(scoreFull({ elapsed: 29.9 }), 20);
  assert.equal(scoreFull({ elapsed: 30 }), 20);
  assert.equal(scoreFull({ elapsed: 45 }), 20);
  assert.equal(scoreFull({ elapsed: -3 }), 100);
  assert.equal(scoreFull({ elapsed: 7.5 }), 80);
});
