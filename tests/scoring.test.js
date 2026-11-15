import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORING, answerWindow, scoreFull, scoreMulti, scoreMultiFull, scoreMultiRandom, scoreRandom } from '../js/scoring.js';

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

test('멀티 랜덤듣기 점수: 속도 보너스(최대 +50%)', () => {
  // 5초 구간 + 답변 15초 = 20초 창. 문서 예: 4초에 맞히면 140점
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 4 }), 140);
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 0 }), 150);
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 19.9 }), 100);
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 20 }), 100);
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 99 }), 100);
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: -2 }), 150);
});

test('멀티 랜덤듣기 점수: 구간 계수와 답변 시간 반영, 다시듣기 감점 없음', () => {
  assert.equal(scoreMultiRandom({ clipLength: 3, elapsed: 0 }), 225); // 150 × 1.5
  assert.equal(scoreMultiRandom({ clipLength: 10, elapsed: 0 }), 105); // 70 × 1.5
  // 답변 시간 10초: 창 15초 → 7.5초에 절반 → +25%
  assert.equal(scoreMultiRandom({ clipLength: 5, elapsed: 7.5, answerTime: 10 }), 125);
});

test('멀티 전체듣기 점수는 개인전과 같다', () => {
  assert.equal(scoreMultiFull({ elapsed: 15 }), scoreFull({ elapsed: 15 }));
  assert.equal(scoreMulti({ mode: 'full', clipLength: 5, elapsed: 7.5 }), 80);
  assert.equal(scoreMulti({ mode: 'random', clipLength: 5, elapsed: 4, answerTime: 15 }), 140);
});

test('답변 창 길이', () => {
  assert.equal(answerWindow({ mode: 'random', clipLength: 5, answerTime: 15 }), 20);
  assert.equal(answerWindow({ mode: 'random', clipLength: 3, answerTime: 10 }), 13);
  assert.equal(answerWindow({ mode: 'full', clipLength: 5, answerTime: 20 }), 30);
});

test('SCORING.multi 상수', () => {
  assert.deepEqual([...SCORING.multi.answerTimes], [10, 15, 20]);
  assert.equal(SCORING.multi.defaultAnswerTime, 15);
  assert.equal(SCORING.multi.speedBonusMax, 0.5);
});
