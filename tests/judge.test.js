import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTY,
  allowedDistance,
  buildChoices,
  canUseMultipleChoice,
  editDistance,
  itemCandidates,
  judgeAnswer,
  judgeItems,
  splitArtistNames,
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

test('judgeAnswer: 작품명이 없는 일반 노래는 보통 난이도에서도 제목·별칭만 인정', () => {
  const song = { videoId: 'abcdefghijk', title: '밤양갱', titleAliases: ['Bam Yang Gang'], artist: '비비', type: '일반곡' };
  assert.equal(judgeAnswer('밤양갱', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('bam yang gang', song, DIFFICULTY.NORMAL).correct, true);
  assert.equal(judgeAnswer('비비', song, DIFFICULTY.NORMAL).correct, false);
  assert.equal(judgeAnswer('밤양갱', song, DIFFICULTY.HARD).correct, true);
});

test('매우 어려움 항목 후보: 곡에 있는 항목만, 표시 순서는 제목·가수·작품명', () => {
  const song = makeSong(1, { artist: '가수 이름', artistAliases: ['Singer Name'] });
  assert.deepEqual(itemCandidates(song), {
    title: ['Song Title 1', '별칭1'],
    artist: ['가수 이름', 'Singer Name'],
    anime: ['Anime Work 1', '작품1'],
  });
  const plain = makeSong(2, { artist: '가수', anime: undefined });
  assert.deepEqual(Object.keys(itemCandidates(plain)), ['title', 'artist']);
  const noArtist = makeSong(3, { artist: '  ', artistAliases: ['별칭만'] });
  assert.deepEqual(Object.keys(itemCandidates(noArtist)), ['title', 'anime']); // 가수 이름이 없으면 별칭만으로는 항목을 만들지 않는다
});

test('매우 어려움 판정: 입력 하나를 남은 모든 항목과 비교', () => {
  const song = makeSong(1, { artist: 'Singer Name' });
  assert.deepEqual(judgeItems('singer nme', song), { matched: ['artist'], already: [] }); // 오타 허용
  assert.deepEqual(judgeItems('작품1', song), { matched: ['anime'], already: [] });
  assert.deepEqual(judgeItems('별칭1', song, ['title']), { matched: [], already: ['title'] });
  assert.deepEqual(judgeItems('전혀 다른 답', song), { matched: [], already: [] });
  // 제목과 작품명이 같으면 한 번에 둘 다 맞힌다
  const same = makeSong(2, { title: 'Same Name', anime: { name: 'Same Name', aliases: [] }, artist: 'X Band' });
  assert.deepEqual(judgeItems('same name', same), { matched: ['title', 'anime'], already: [] });
});

test('가수 이름 나누기: ×·&·쉼표·feat.·with·" x "로 나누고, and·+는 이름의 일부로 둔다', () => {
  assert.deepEqual(splitArtistNames('히이라기 마그네타이트×9Lana×Eye'), ['히이라기 마그네타이트', '9Lana', 'Eye']);
  assert.deepEqual(splitArtistNames('키시다 교단 & THE 아케보시 로켓'), ['키시다 교단', 'THE 아케보시 로켓', '아케보시 로켓']);
  assert.deepEqual(splitArtistNames('Aiobahn +81 feat. KOTOKO'), ['Aiobahn +81', 'KOTOKO']);
  assert.deepEqual(splitArtistNames('CHiCO with HoneyWorks'), ['CHiCO', 'HoneyWorks']);
  assert.deepEqual(splitArtistNames('스페셜 위크, 사일런스 스즈카, 토카이 테이오'), ['스페셜 위크', '사일런스 스즈카', '토카이 테이오']);
  assert.deepEqual(splitArtistNames('A x B ft. C / D'), ['A', 'B', 'C', 'D']);
  for (const single of ['HIGH and MIGHTY COLOR', 'YOASOBI', 'Linked Horizon', 'Official HIGE DANdism', 'Mrs. GREEN APPLE', '', null]) {
    assert.deepEqual(splitArtistNames(single), [], String(single));
  }
});

test('매우 어려움: 여러 명이 부른 곡은 한 명만 맞혀도 가수 정답', () => {
  const song = makeSong(1, { artist: '스페셜 위크, 사일런스 스즈카, 토카이 테이오' });
  assert.deepEqual(judgeItems('토카이 테이오', song).matched, ['artist']);
  assert.deepEqual(judgeItems('사일런스스즈카', song).matched, ['artist']);
  assert.deepEqual(judgeItems('스페셜 위크, 사일런스 스즈카, 토카이 테이오', song).matched, ['artist'], '전체 이름도 그대로 인정');
  assert.deepEqual(judgeItems('다이와 스칼렛', song).matched, []);
  const feat = makeSong(2, { artist: 'Aiobahn +81 feat. KOTOKO', artistAliases: ['코토코'] });
  assert.deepEqual(judgeItems('Aiobahn', feat).matched, ['artist'], '+81을 빼고 써도 오타 허용 범위');
  assert.deepEqual(judgeItems('kotoko', feat).matched, ['artist']);
  const band = makeSong(3, { artist: 'HIGH and MIGHTY COLOR' });
  assert.deepEqual(judgeItems('high', band).matched, [], 'and로 나누지 않는다');
});
