import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTY,
  allowedDistance,
  buildChoices,
  canUseMultipleChoice,
  editDistance,
  judgeAnswer,
  matchesCandidate,
  normalizeAnswer,
} from '../js/judge.js';
import { makeSong, seededRng } from './helpers.js';

test('정규화: NFKC, 소문자, 공백·특수문자 제거', () => {
  assert.equal(normalizeAnswer('  Hello, World!  '), 'helloworld');
  assert.equal(normalizeAnswer('ＡＢＣ　１２３'), 'abc123'); // 전각 → 반각
  assert.equal(normalizeAnswer('Re:Re:'), 'rere');
  assert.equal(normalizeAnswer('紅蓮華 (Gurenge)'), '紅蓮華gurenge');
  assert.equal(normalizeAnswer('ｶﾀｶﾅ'), 'カタカナ'); // 반각 가나 → 전각
  assert.equal(normalizeAnswer('우리의 꿈 ☆ ~'), '우리의꿈');
  assert.equal(normalizeAnswer('ー長音ー'), 'ー長音ー'); // 장음 기호는 문자로 유지
  assert.equal(normalizeAnswer(null), '');
});

test('허용 편집거리 경계값', () => {
  assert.equal(allowedDistance(1), 0);
  assert.equal(allowedDistance(4), 0);
  assert.equal(allowedDistance(5), 1);
  assert.equal(allowedDistance(8), 1);
  assert.equal(allowedDistance(9), 2);
  assert.equal(allowedDistance(30), 2);
});

test('편집거리', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('같다', '같다'), 0);
  assert.equal(editDistance('紅蓮華', '紅連華'), 1);
});

test('길이 4 이하: 완전 일치만', () => {
  assert.equal(matchesCandidate('abcd', 'abcd'), true);
  assert.equal(matchesCandidate('abce', 'abcd'), false);
  assert.equal(matchesCandidate('abc', 'abcd'), false);
  assert.equal(matchesCandidate('紅蓮華', '紅蓮華'), true);
  assert.equal(matchesCandidate('紅連華', '紅蓮華'), false);
});

test('길이 5~8: 1글자 오타 허용', () => {
  assert.equal(matchesCandidate('abcdf', 'abcde'), true); // 5, 거리 1
  assert.equal(matchesCandidate('abcfg', 'abcde'), false); // 거리 2
  assert.equal(matchesCandidate('abcdefgx', 'abcdefgh'), true); // 8, 거리 1
  assert.equal(matchesCandidate('abcdefxy', 'abcdefgh'), false); // 8, 거리 2
  assert.equal(matchesCandidate('abcdefg', 'abcdefgh'), true); // 삭제 1
});

test('길이 9 이상: 2글자 오타 허용', () => {
  assert.equal(matchesCandidate('abcdefgxy', 'abcdefghi'), true); // 9, 거리 2
  assert.equal(matchesCandidate('abcdefxyz', 'abcdefghi'), false); // 거리 3
  // 레벤슈타인 거리에서 글자 자리바꿈은 2로 센다: 길이 7(허용 1)에서는 오답, 9 이상이면 정답
  assert.equal(matchesCandidate('Unravle', 'unravel'), false);
  assert.equal(matchesCandidate('Gurenegdayo', 'gurengedayo'), true);
});

test('빈 입력은 오답', () => {
  assert.equal(matchesCandidate('', 'abc'), false);
  assert.equal(matchesCandidate('!!!', 'abc'), false);
});

test('난이도별 정답 후보', () => {
  const song = makeSong(1); // title 'Song Title 1', 별칭1, Anime Work 1, 작품1
  assert.equal(judgeAnswer('song title 1', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('별칭1', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('anime work 1', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('작품1', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('songtitle1', song, DIFFICULTY.HARD).correct, true);
  assert.equal(judgeAnswer('별칭1', song, DIFFICULTY.HARD).correct, true);
  assert.equal(judgeAnswer('anime work 1', song, DIFFICULTY.HARD).correct, false);
  assert.equal(judgeAnswer('작품1', song, DIFFICULTY.HARD).correct, false);
  assert.equal(judgeAnswer('전혀 다른 답', song, DIFFICULTY.NORMAL).correct, false);
});

test('객관식 보기: 정답 1 + 다른 곡 3, 중복 제목 제외', () => {
  const songs = [1, 2, 3, 4, 5, 6].map((n) => makeSong(n));
  songs.push(makeSong(7, { title: 'song title 2!!' })); // 2번과 정규화 후 같음
  const choices = buildChoices(songs[0], songs, seededRng(3));
  assert.equal(choices.length, 4);
  assert.equal(choices.filter((c) => c.correct).length, 1);
  assert.equal(choices.find((c) => c.correct).label, 'Song Title 1');
  const keys = choices.map((c) => normalizeAnswer(c.label));
  assert.equal(new Set(keys).size, 4);
});

test('객관식 보기: 곡이 적으면 가능한 만큼', () => {
  const songs = [makeSong(1), makeSong(2)];
  assert.equal(buildChoices(songs[0], songs, seededRng(1)).length, 2);
  assert.equal(canUseMultipleChoice(songs), true);
  assert.equal(canUseMultipleChoice([makeSong(1)]), false);
  assert.equal(canUseMultipleChoice([makeSong(1), makeSong(2, { title: 'Song Title 1' })]), false);
});
