import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORING, answerWindow, isValidRounds, parseRounds, scoreExtremeBonus, scoreExtremeItem, scoreFull, scoreMulti, scoreMultiFull, scoreMultiRandom, scoreRandom } from '../js/scoring.js';

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

test('매우 어려움 항목 점수: 기본 점수를 제목 2 : 가수 1 : 작품명 1로 나눈다', () => {
  const items = ['title', 'artist', 'anime'];
  assert.equal(scoreExtremeItem({ base: 100, item: 'title', items }), 50);
  assert.equal(scoreExtremeItem({ base: 100, item: 'artist', items }), 25);
  assert.equal(scoreExtremeItem({ base: 150, item: 'anime', items }), 38);
  // 작품명이 없는 곡은 남은 항목끼리 나눈다
  assert.equal(scoreExtremeItem({ base: 100, item: 'title', items: ['title', 'artist'] }), 67);
  assert.equal(scoreExtremeItem({ base: 100, item: 'artist', items: ['title', 'artist'] }), 33);
  assert.equal(scoreExtremeItem({ base: 100, item: 'title', items: [] }), 0);
});

test('매우 어려움 보너스와 상수', () => {
  assert.equal(scoreExtremeBonus(100), 50);
  assert.equal(scoreExtremeBonus(70), 35);
  assert.equal(SCORING.extreme.maxWrongAttempts, 5);
  assert.ok(Object.isFrozen(SCORING.extreme.itemWeights));
});

test('랜덤듣기 15초 구간: 계수 0.5', () => {
  assert.ok(SCORING.clipLengths.includes(15));
  assert.equal(scoreRandom({ clipLength: 15, replayUsed: false }), 50);
  assert.equal(scoreRandom({ clipLength: 15, replayUsed: true }), 30);
  assert.equal(answerWindow({ mode: 'random', clipLength: 15, answerTime: 15 }), 30);
  assert.equal(scoreMultiRandom({ clipLength: 15, elapsed: 0, answerTime: 15 }), 75);
});

test('라운드 수 직접 입력: 1~100 정수', () => {
  assert.equal(isValidRounds(1), true);
  assert.equal(isValidRounds(100), true);
  assert.equal(isValidRounds(37), true);
  for (const bad of [0, 101, 7.5, '10', null, NaN]) assert.equal(isValidRounds(bad), false);
  assert.equal(parseRounds('37'), 37);
  assert.equal(parseRounds(' 8 '), 8);
  assert.equal(parseRounds(15), 15);
  assert.equal(parseRounds('0'), 1, '범위 밖은 끝값으로');
  assert.equal(parseRounds('500'), 100);
  for (const bad of ['', '  ', 'abc', '3.5', '-2', null, undefined]) assert.equal(parseRounds(bad), null);
});
