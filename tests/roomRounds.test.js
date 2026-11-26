// 방 상태 머신: 라운드 진행(준비·시작 신호·판정·점수·공개·예외)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_STATUS, ROOM_PHASE } from '../server/room.js';
import { createEnv } from './roomHelpers.js';
import { makeSong } from './helpers.js';

test('준비: prepare에는 곡 제목·별칭·작품명이 없다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  const prepare = env.prepare('a');
  assert.equal(prepare.type, 'prepare');
  assert.equal(prepare.roundId, 1);
  assert.equal(prepare.mode, 'random');
  assert.equal(prepare.clipLength, 5);
  assert.equal(prepare.answerWindow, 20);
  assert.equal(prepare.total, 6 > 10 ? 10 : 6);
  const song = env.songOf(prepare.videoId);
  assert.ok(prepare.segmentStart >= 0 && prepare.segmentStart <= song.duration - 5);
  assert.deepEqual(env.prepare('b'), prepare, '모두 같은 곡·같은 구간');
  // 공개 전에는 어떤 메시지에도 정답이 없다
  const everything = JSON.stringify([...env.inbox.values()]);
  assert.ok(!everything.includes(song.title));
  assert.ok(!everything.includes(song.titleAliases[0]));
  assert.ok(!everything.includes(song.anime.name));
});

test('모두 ready하면 즉시 go(startAt = 지금 + 카운트다운), 그 시각에 답변 단계', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'start' });
  env.ready('a');
  env.ready('b');
  assert.equal(env.msgs('a', 'go').length, 0, '아직 c가 준비 중');
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
  env.timers.advance(500);
  env.ready('c');
  const go = env.last('a', 'go');
  assert.equal(go.roundId, 1);
  assert.equal(go.startAt, env.timers.now() + 3000);
  assert.equal(go.deadlineAt, go.startAt + 20_000);
  assert.deepEqual(env.last('c', 'go'), go);
  assert.equal(env.state().phase, ROOM_PHASE.STARTING);
  env.timers.advance(2999);
  assert.equal(env.state().phase, ROOM_PHASE.STARTING);
  env.timers.advance(1);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
});

test('시작 신호 전의 답은 무시된다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  env.readyAll();
  env.timers.advance(1000);
  env.answer('a', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.STARTING);
  assert.equal(env.msgs('a', 'reveal').length, 0);
});

test('정답: 맞힌 사람만 잠기고 라운드는 계속, 전원이 끝나면 공개(정답자마다 속도 점수)', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  const title = env.round().song.title;
  env.timers.advance(4000); // 시작 신호 뒤 4초
  env.answer('b', env.correctText().toLowerCase());
  // 100 × (1 + 0.5 × (1 − 4/20)) = 140, 본인에게만 결과
  assert.deepEqual(env.last('b', 'answerResult'), { type: 'answerResult', roundId: 1, correct: true, points: 140, elapsed: 4, order: 1 });
  assert.equal(env.msgs('a', 'answerResult').length, 0);
  assert.deepEqual(env.last('a', 'locked'), { type: 'locked', roundId: 1, playerId: 'p2', reason: 'correct' });
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING, '첫 정답자가 나와도 라운드는 계속');
  assert.equal(env.state().players[1].status, PLAYER_STATUS.CORRECT);
  assert.equal(env.state().players[1].score, 0, '점수는 공개 때 반영');
  assert.ok(!JSON.stringify([env.msgs('a'), env.msgs('b'), env.msgs('c')]).includes(title), '공개 전에는 정답이 새지 않는다');

  // 맞힌 사람의 추가 답·패스는 무시
  env.timers.advance(1000);
  env.answer('b', env.correctText());
  env.send('b', { type: 'pass', roundId: 1 });
  assert.equal(env.msgs('b', 'answerResult').length, 1);
  assert.equal(env.msgs('a', 'locked').length, 1);

  env.timers.advance(5000); // 시작 신호 뒤 10초
  env.answer('a', env.correctText());
  assert.equal(env.last('a', 'answerResult').order, 2);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING, 'c가 아직 남았다');
  env.send('c', { type: 'pass', roundId: 1 });
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  const reveal = env.last('a', 'reveal');
  assert.equal(reveal.reason, 'done');
  assert.deepEqual(reveal.correctPlayers, [
    { playerId: 'p2', nickname: 'b', elapsed: 4, points: 140, hint: false },
    { playerId: 'p1', nickname: 'a', elapsed: 10, points: 125, hint: false }, // 100 × (1 + 0.5 × (1 − 10/20))
  ]);
  assert.equal(reveal.song.title, title);
  assert.deepEqual(reveal.scores, [{ playerId: 'p1', score: 125 }, { playerId: 'p2', score: 140 }, { playerId: 'p3', score: 0 }]);
  assert.deepEqual(env.state().players.map((p) => [p.score, p.correct]), [[125, 1], [140, 1], [0, 0]]);
  assert.deepEqual(env.msgs('a', 'reveal'), env.msgs('c', 'reveal'));
});

test('전원 정답이면 마지막 정답 즉시 공개', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.answer('a', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.timers.advance(3000);
  env.answer('b', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  assert.deepEqual(env.correctNames(env.last('a', 'reveal')), ['a', 'b']);
  assert.equal(env.timers.pending(), 1, '공개 타이머만 남는다(답변 마감 타이머 해제)');
});

test('시간이 끝나면 남은 사람이 있어도 공개, 그때까지의 정답자는 득점', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin(); // 창 20초
  env.timers.advance(2000);
  env.answer('a', env.correctText());
  env.timers.advance(17_999);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.timers.advance(1);
  const reveal = env.last('b', 'reveal');
  assert.equal(reveal.reason, 'timeout');
  assert.deepEqual(env.correctNames(reveal), ['a']);
  assert.deepEqual(env.state().players.map((p) => p.score), [reveal.correctPlayers[0].points, 0]);
});

test('맞힌 뒤 연결이 끊겨도 점수는 받는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.answer('c', env.correctText());
  env.room.handleDisconnect('c');
  assert.equal(env.state().players[2].status, PLAYER_STATUS.CORRECT);
  env.passRest();
  const reveal = env.last('a', 'reveal');
  assert.deepEqual(env.correctNames(reveal), ['c']);
  assert.ok(env.state().players[2].score > 0);
  assert.deepEqual(reveal.excluded, []);
});

test('작품명·별칭·오타도 정답(보통 난이도)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.answer('a', env.round().song.anime.name);
  assert.equal(env.last('a', 'answerResult').correct, true);
});

test('어려움은 제목만 인정', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { difficulty: 'hard' } });
  env.begin();
  env.answer('a', env.round().song.anime.name);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  assert.equal(env.last('a', 'answerResult').correct, false);
  env.answer('b', env.round().song.titleAliases[0]);
  assert.equal(env.last('b', 'answerResult').correct, true);
});

test('동시 도착: 모두 정답, 같은 시간이면 같은 점수이고 처리 순서대로 기록', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.timers.advance(2000);
  const text = env.correctText();
  env.answer('b', text); // 같은 ms에 도착, 이 순서로 처리
  env.answer('a', text);
  env.answer('c', text);
  assert.equal(env.msgs('a', 'reveal').length, 1);
  const reveal = env.last('a', 'reveal');
  assert.deepEqual(env.correctNames(reveal), ['b', 'a', 'c']);
  const points = reveal.correctPlayers[0].points;
  assert.ok(reveal.correctPlayers.every((c) => c.elapsed === 2 && c.points === points));
  assert.ok(env.state().players.every((p) => p.score === points && p.correct === 1));
});

test('정답 도착 시각은 서버가 잰다(클라이언트가 보낸 시간은 무시)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.timers.advance(10_000);
  env.send('a', { type: 'answer', roundId: env.round().id, text: env.correctText(), elapsed: 0.1, at: 0 });
  assert.equal(env.last('a', 'answerResult').elapsed, 10);
});

test('오답: 비공개 결과만 본인에게, 3번 소진하면 본인만 잠기고 locked 공지', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.answer('a', '틀린 답 1');
  assert.deepEqual(env.last('a', 'answerResult'), { type: 'answerResult', roundId: 1, correct: false, attemptsLeft: 2 });
  assert.equal(env.msgs('b', 'answerResult').length, 0);
  env.timers.advance(1000);
  env.answer('a', '틀린 답 2');
  env.timers.advance(1000);
  env.answer('a', '틀린 답 3');
  assert.equal(env.last('a', 'answerResult').attemptsLeft, 0);
  assert.deepEqual(env.last('b', 'locked'), { type: 'locked', roundId: 1, playerId: 'p1', reason: 'exhausted' });
  assert.equal(env.state().players[0].status, PLAYER_STATUS.EXHAUSTED);
  assert.ok(!JSON.stringify(env.msgs('b')).includes('틀린 답'), '오답 내용은 다른 사람에게 가지 않는다');

  // 잠긴 사람의 답은 무시, 다른 사람은 계속 푼다
  env.timers.advance(1000);
  env.answer('a', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.answer('b', env.correctText());
  assert.deepEqual(env.correctNames(env.last('b', 'reveal')), ['b']);
});

test('답 도배 제한: 플레이어당 1초 간격, 제한된 시도는 기회를 깎지 않는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.answer('a', 'x1');
  env.timers.advance(400);
  env.answer('a', 'x2');
  assert.equal(env.last('a', 'rateLimited').retryAfterMs, 600);
  assert.equal(env.msgs('a', 'answerResult').length, 1);
  env.answer('b', 'y1'); // 다른 사람은 따로 센다
  assert.equal(env.msgs('b', 'rateLimited').length, 0);
  env.timers.advance(600);
  env.answer('a', 'x3');
  assert.equal(env.msgs('a', 'answerResult').length, 2);
  assert.equal(env.last('a', 'answerResult').attemptsLeft, 1);
});

test('빈 답·너무 긴 답은 무시(기회와 간격에 영향 없음)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.answer('a', '   ');
  env.answer('a', 'x'.repeat(500));
  env.send('a', { type: 'answer', roundId: 1 });
  env.answer('a', '진짜 오답');
  assert.equal(env.msgs('a', 'answerResult').length, 1);
  assert.equal(env.msgs('a', 'rateLimited').length, 0);
});

test('패스: 본인만 잠기고 다른 사람은 계속, 전원 포기하면 정답 공개', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.send('a', { type: 'pass', roundId: 1 });
  assert.deepEqual(env.last('b', 'locked'), { type: 'locked', roundId: 1, playerId: 'p1', reason: 'pass' });
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.send('b', { type: 'pass', roundId: 1 });
  env.send('b', { type: 'pass', roundId: 1 }); // 중복 패스는 무시
  assert.equal(env.msgs('c', 'locked').length, 2);
  env.send('c', { type: 'pass', roundId: 1 });
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  const reveal = env.last('a', 'reveal');
  assert.equal(reveal.reason, 'done');
  assert.deepEqual(reveal.correctPlayers, []);
  assert.ok(env.state().players.every((p) => p.score === 0));
});

test('전원 포기·오답 소진이 섞여도 남은 사람이 없으면 공개', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'pass', roundId: 1 });
  for (let i = 0; i < 3; i++) {
    env.answer('b', `오답${i}`);
    env.timers.advance(1000);
  }
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  assert.equal(env.last('b', 'reveal').reason, 'done');
});

test('시간 만료(랜덤듣기): 구간 + 답변 시간 뒤 공개, 모두 0점', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { clipLength: 3, answerTime: 10 } });
  env.begin(); // 시작 신호 시각
  env.timers.advance(12_999);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.timers.advance(1);
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  const reveal = env.last('a', 'reveal');
  assert.equal(reveal.reason, 'timeout');
  assert.deepEqual(reveal.correctPlayers, []);
  assert.ok(env.state().players.every((p) => p.score === 0));
  // 만료 뒤의 답은 무시
  env.answer('a', env.correctText());
  assert.equal(env.msgs('a', 'reveal').length, 1);
});

test('전체듣기: 제한시간 30초, 점수는 개인전 공식', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { mode: 'full' } });
  env.send('a', { type: 'start' });
  const prepare = env.prepare('a');
  assert.equal(prepare.mode, 'full');
  assert.equal(prepare.segmentStart, 0);
  assert.equal(prepare.clipLength, null);
  assert.equal(prepare.answerWindow, 30);
  env.readyAll();
  env.timers.advance(3000 + 7500);
  env.answer('b', env.correctText());
  assert.equal(env.last('b', 'answerResult').points, 80); // 100 − 80 × 7.5/30
  env.passRest();
  assert.equal(env.last('a', 'reveal').correctPlayers[0].points, 80);

  env.timers.advance(env.room.revealMs); // 다음 라운드: 시간 만료
  env.readyAll();
  env.timers.advance(3000 + 29_999);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.timers.advance(1);
  assert.equal(env.last('a', 'reveal').reason, 'timeout');
});

test('다른 roundId의 메시지는 모두 무시', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  env.send('a', { type: 'ready', roundId: 99 });
  env.send('b', { type: 'ready', roundId: 0 });
  env.send('a', { type: 'ready' });
  assert.equal(env.state().players[0].status, PLAYER_STATUS.PREPARING);
  env.readyAll();
  env.timers.advance(3000);
  const text = env.correctText();
  env.send('a', { type: 'answer', roundId: 98, text });
  env.send('a', { type: 'pass', roundId: 97 });
  env.send('a', { type: 'playerError', roundId: 96, code: 150 });
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  assert.equal(env.msgs('a', 'answerResult').length, 0);
  assert.equal(env.state().players[0].status, PLAYER_STATUS.READY);
});

test('늦게 도착한 이전 라운드 메시지는 다음 라운드에 영향이 없다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  const firstRound = env.round().id;
  env.answer('a', env.correctText());
  env.passRest();
  env.timers.advance(env.room.revealMs); // 다음 라운드 준비
  assert.notEqual(env.round().id, firstRound);
  env.send('b', { type: 'ready', roundId: firstRound });
  env.send('b', { type: 'answer', roundId: firstRound, text: env.correctText() });
  assert.equal(env.state().players[1].status, PLAYER_STATUS.PREPARING);
  env.readyAll();
  env.timers.advance(3000);
  env.send('b', { type: 'answer', roundId: firstRound, text: env.correctText() });
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
});

test('자동 진행: 공개 10초 뒤 다음 라운드, reveal에 다음 곡 videoId', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  const first = env.round().song.videoId;
  env.answer('a', env.correctText());
  env.passRest();
  const reveal = env.last('a', 'reveal');
  assert.equal(reveal.hasNext, true);
  assert.ok(reveal.nextVideoId && reveal.nextVideoId !== first);
  env.timers.advance(9999);
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  env.timers.advance(1);
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
  const prepare = env.prepare('b');
  assert.equal(prepare.roundId, 2);
  assert.equal(prepare.index, 1);
  assert.equal(prepare.videoId, reveal.nextVideoId);
});

test('쉬움: 보기 문구만 보내고, 번호로 답하며, 같은 보기는 다시 고를 수 없다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { difficulty: 'easy' } });
  env.send('a', { type: 'start' });
  const prepare = env.prepare('a');
  assert.equal(prepare.choices.length, 4);
  assert.ok(prepare.choices.every((c) => typeof c === 'string'));
  const song = env.songOf(prepare.videoId);
  const correctIndex = prepare.choices.indexOf(song.title);
  assert.ok(correctIndex >= 0);
  assert.ok(!JSON.stringify(prepare).includes('correct'));
  env.readyAll();
  env.timers.advance(3000);

  const wrong = prepare.choices.findIndex((_, i) => i !== correctIndex);
  const choose = (conn, choice) => env.send(conn, { type: 'answer', roundId: 1, choice });
  choose('a', wrong);
  assert.equal(env.last('a', 'answerResult').attemptsLeft, 2);
  env.timers.advance(1000);
  choose('a', wrong); // 이미 고른 보기는 무시
  assert.equal(env.msgs('a', 'answerResult').length, 1);
  choose('a', 9); // 범위 밖
  choose('a', 'x');
  assert.equal(env.msgs('a', 'answerResult').length, 1);
  env.send('a', { type: 'answer', roundId: 1, text: song.title }); // 객관식에서 텍스트는 무시
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  choose('b', correctIndex);
  assert.equal(env.last('b', 'answerResult').correct, true);
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING, 'a는 계속 고를 수 있다');
});

test('준비 10초 안에 ready가 없으면 그 사람만 제외하고 시작 신호', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'start' });
  env.ready('a');
  env.ready('b');
  env.timers.advance(9999);
  assert.equal(env.msgs('a', 'go').length, 0);
  env.timers.advance(1);
  assert.equal(env.msgs('a', 'go').length, 1);
  assert.equal(env.state().players[2].status, PLAYER_STATUS.TIMEOUT);
  env.timers.advance(3000);
  // 제외된 사람의 답은 무시
  env.answer('c', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.answer('a', env.correctText());
  env.passRest();
  const reveal = env.last('a', 'reveal');
  assert.deepEqual(reveal.excluded, [{ playerId: 'p3', reason: 'timeout', code: null }]);
});

test('아무도 준비하지 못하면 곡을 바꿔 다시 준비', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  const first = env.prepare('a');
  env.timers.advance(10_000);
  const second = env.prepare('a');
  assert.notEqual(second.roundId, first.roundId);
  assert.notEqual(second.videoId, first.videoId);
  assert.equal(second.index, 0);
  assert.equal(env.msgs('a', 'go').length, 0);
});

test('일부만 재생 오류: 그 사람만 제외하고 진행(0점, 공개에 표시)', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'start' });
  env.send('c', { type: 'playerError', roundId: 1, code: 150 });
  assert.equal(env.state().players[2].status, PLAYER_STATUS.ERROR);
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
  env.ready('a');
  env.ready('b');
  assert.equal(env.state().phase, ROOM_PHASE.STARTING);
  env.timers.advance(3000);
  env.answer('b', env.correctText());
  env.passRest();
  const reveal = env.last('c', 'reveal');
  assert.deepEqual(reveal.excluded, [{ playerId: 'p3', reason: 'error', code: 150 }]);
  assert.equal(env.state().players[2].score, 0);
});

test('시작 신호 뒤 오류로 마지막 사람까지 빠지면 라운드 종료', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.send('a', { type: 'pass', roundId: 1 });
  env.send('b', { type: 'pass', roundId: 1 });
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.send('c', { type: 'playerError', roundId: 1, code: 101 });
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
});

test('과반이 재생 오류: 곡 교체 + 새 roundId로 다시 준비, 점수·라운드 번호 유지', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'start' });
  const first = env.prepare('a');
  env.send('b', { type: 'playerError', roundId: 1, code: 150 });
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
  assert.equal(env.msgs('a', 'prepare').length, 1, '1/3은 과반이 아니다');
  env.send('c', { type: 'playerError', roundId: 1, code: 101 });
  const second = env.prepare('a');
  assert.equal(env.msgs('a', 'prepare').length, 2);
  assert.equal(second.roundId, 2);
  assert.notEqual(second.videoId, first.videoId);
  assert.equal(second.index, 0);
  assert.match(env.last('a', 'notice').message, /곡을 바꿨습니다/);
  // 새 라운드에서는 오류 상태가 초기화돼 모두 다시 준비한다
  assert.ok(env.state().players.every((p) => p.status === PLAYER_STATUS.PREPARING));
  // 이전 roundId의 메시지는 무시
  env.send('a', { type: 'ready', roundId: 1 });
  assert.equal(env.state().players[0].status, PLAYER_STATUS.PREPARING);
  env.readyAll();
  env.timers.advance(3000);
  env.answer('a', env.round().song.title);
  env.passRest();
  assert.equal(env.last('a', 'reveal').roundId, 2);
});

test('과반 오류로 곡이 모자라면 라운드를 줄인다', () => {
  const env = createEnv({ songCount: 3 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  assert.equal(env.prepare('a').total, 3);
  env.send('a', { type: 'playerError', roundId: 1, code: 2 });
  env.send('b', { type: 'playerError', roundId: 1, code: 5 }); // 2/2 → 교체(남은 곡 1개)
  const prepare = env.prepare('a');
  assert.equal(prepare.roundId, 2);
  assert.equal(prepare.total, 2);
  assert.match(env.msgs('a', 'notice').at(-1).message, /2라운드로 줄였습니다/);
});

test('곡 교체 후 남은 곡이 없으면 지금까지의 라운드로 마친다', () => {
  const env = createEnv({ songCount: 2 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { rounds: 5 } });
  env.begin();
  env.answer('a', env.correctText());
  env.passRest();
  env.timers.advance(env.room.revealMs); // 2라운드 준비
  assert.equal(env.round().id, 2);
  env.send('a', { type: 'playerError', roundId: 2, code: 150 });
  env.send('b', { type: 'playerError', roundId: 2, code: 150 });
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  const over = env.last('a', 'gameOver');
  assert.equal(over.reason, 'complete');
  assert.equal(over.history.length, 1);
  assert.match(env.msgs('a', 'notice').at(-1).message, /1라운드로 마칩니다/);
});

test('첫 라운드부터 재생할 수 있는 곡이 없으면 no-playable로 종료', () => {
  const env = createEnv({ songCount: 1 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  env.send('a', { type: 'playerError', roundId: 1, code: 150 });
  env.send('b', { type: 'playerError', roundId: 1, code: 150 });
  assert.equal(env.last('a', 'gameOver').reason, 'no-playable');
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
});

test('접속이 끊긴 사람은 준비를 기다리지 않는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'start' });
  env.ready('a');
  env.ready('b');
  env.room.handleDisconnect('c');
  assert.equal(env.state().phase, ROOM_PHASE.STARTING);
  assert.equal(env.state().players[2].status, PLAYER_STATUS.ABSENT);
  assert.equal(env.msgs('c', 'go').length, 0);
});

test('답변 중 모두 끊기거나 포기하면 라운드가 끝난다(끊긴 사람은 기다리지 않음)', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.send('a', { type: 'pass', roundId: 1 });
  env.room.handleDisconnect('b');
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.room.handleDisconnect('c');
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
});

test('여러 라운드에 걸쳐 점수가 쌓이고 타이머가 남지 않는다', () => {
  const env = createEnv({ songCount: 3 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { rounds: 5 } });
  env.send('a', { type: 'start' });
  assert.equal(env.prepare('a').total, 3);
  for (let i = 0; i < 3; i++) {
    env.readyAll();
    env.timers.advance(3000 + 1000);
    env.answer(i === 1 ? 'b' : 'a', env.correctText());
    env.passRest();
    env.timers.advance(env.room.revealMs);
  }
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  const over = env.last('a', 'gameOver');
  assert.deepEqual(over.ranking.map((r) => [r.nickname, r.score]), [['a', 296], ['b', 148]]);
  assert.equal(env.timers.pending(), 0);
});

// ---------- 매우 어려움 ----------
function extremeEnv() {
  const songs = Array.from({ length: 6 }, (_, i) => makeSong(i + 1, { duration: 200, artist: `Singer Name ${i + 1}` }));
  const env = createEnv({ songs });
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'settings', settings: { difficulty: 'extreme' } });
  return env;
}

test('매우 어려움: prepare에는 항목 키와 기회 수만, 정답 값은 공개 전까지 없다', () => {
  const env = extremeEnv();
  assert.equal(env.state().settings.difficulty, 'extreme');
  env.begin();
  const prepare = env.prepare('a');
  assert.deepEqual(prepare.items, ['title', 'artist', 'anime']);
  assert.equal(prepare.attempts, 5);
  const song = env.round().song;
  env.timers.advance(4000);
  env.answer('b', song.artist);
  const everything = JSON.stringify([...env.inbox.values()]);
  for (const secret of [song.title, song.artist, song.anime.name]) assert.ok(!everything.includes(secret));
});

test('매우 어려움: 항목마다 그 시점 속도 점수, 전부 맞혀야 잠기고 일부만 맞힌 사람도 점수', () => {
  const env = extremeEnv();
  env.begin();
  const song = env.round().song;

  env.timers.advance(4000); // 기본 140 → 가수 35
  env.answer('b', song.artist.toLowerCase());
  assert.deepEqual(env.last('b', 'answerResult'), {
    type: 'answerResult', roundId: 1, correct: true, items: ['artist'], itemPoints: { artist: 35 },
    points: 35, total: 35, bonus: 0, complete: false, elapsed: 4, order: null,
  });
  assert.equal(env.msgs('a', 'locked').length, 0, '일부만 맞히면 잠기지 않는다');
  const b = () => env.state().players.find((p) => p.nickname === 'b');
  assert.deepEqual([b().status, b().solved, b().score], [PLAYER_STATUS.READY, 1, 0]);
  assert.equal(env.state().players[0].solved, 0, '다른 사람에게는 개수만');

  env.timers.advance(1000); // 이미 맞힌 항목: 기회 유지
  env.answer('b', song.artist);
  assert.deepEqual(env.last('b', 'answerResult'), { type: 'answerResult', roundId: 1, correct: false, already: ['artist'], attemptsLeft: 5 });

  env.answer('a', song.title); // 5초: 기본 138 → 제목 69 (같은 시각 b의 쿨다운과 무관)
  assert.equal(env.last('a', 'answerResult').points, 69);

  env.timers.advance(1000); // 6초: 기본 135 → 제목 68
  env.answer('b', song.title);
  env.timers.advance(2000); // 8초: 기본 130 → 작품명 33 + 보너스 65
  env.answer('b', song.anime.aliases[0]);
  const done = env.last('b', 'answerResult');
  assert.deepEqual([done.points, done.total, done.bonus, done.complete, done.order], [98, 201, 65, true, 1]);
  assert.deepEqual(env.last('a', 'locked'), { type: 'locked', roundId: 1, playerId: 'p2', reason: 'correct' });
  assert.equal(b().status, PLAYER_STATUS.CORRECT);

  env.passRest(); // a(1/3)와 c(0/3) 패스 → 공개
  const reveal = env.last('c', 'reveal');
  assert.deepEqual(reveal.items, ['title', 'artist', 'anime']);
  assert.deepEqual(reveal.correctPlayers, [{ playerId: 'p2', nickname: 'b', elapsed: 8, points: 201, solved: 3, hint: false }]);
  assert.deepEqual(reveal.partialPlayers, [{ playerId: 'p1', nickname: 'a', points: 69, solved: 1, hint: false }]);
  assert.equal(reveal.song.artist, song.artist);
  assert.deepEqual(reveal.scores, [
    { playerId: 'p1', score: 69 },
    { playerId: 'p2', score: 201 },
    { playerId: 'p3', score: 0 },
  ]);
  const players = env.state().players;
  assert.deepEqual(players.map((p) => p.correct), [0, 1, 0], '정답 수는 전부 맞힌 사람만');
});

test('매우 어려움: 오답 5번이면 소진, 맞힌 항목 점수는 공개 때 받는다', () => {
  const env = extremeEnv();
  env.begin();
  const song = env.round().song;
  env.answer('c', song.anime.name); // 0초: 기본 150 → 작품명 38
  for (let i = 1; i <= 5; i++) {
    env.timers.advance(1000);
    env.answer('c', `틀린 답 ${i}`);
    assert.equal(env.last('c', 'answerResult').attemptsLeft, 5 - i);
  }
  assert.deepEqual(env.last('a', 'locked'), { type: 'locked', roundId: 1, playerId: 'p3', reason: 'exhausted' });
  env.passRest();
  const reveal = env.last('a', 'reveal');
  assert.deepEqual(reveal.partialPlayers, [{ playerId: 'p3', nickname: 'c', points: 38, solved: 1, hint: false }]);
  assert.equal(env.state().players[2].score, 38);
});

test('매우 어려움이 아니면 prepare.items는 null, 기회 3번', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  assert.equal(env.prepare('a').items, null);
  assert.equal(env.prepare('a').attempts, 3);
  assert.equal(env.state().players[0].solved, null);
});

test('공개·결과 기록에 들었던 구간 시작(segmentStart)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  const start = env.round().segmentStart;
  env.passRest();
  assert.equal(env.last('a', 'reveal').segmentStart, start);
  assert.equal(env.room.history[0].segmentStart, start);
  assert.ok(start > 0);
});
