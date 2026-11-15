// 방 상태 머신: 로비(입장·설정·시작), 재접속, 방장 이전, 방 닫기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_PHASE, generateRoomCode, normalizeRoomCode, rankPlayers } from '../server/room.js';
import { createEnv } from './roomHelpers.js';
import { seededRng } from './helpers.js';

test('방 코드: 5자리, 헷갈리는 문자 제외, 정규화', () => {
  const rng = seededRng(3);
  for (let i = 0; i < 50; i++) {
    const code = generateRoomCode(rng);
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(normalizeRoomCode(code.toLowerCase()), code);
  }
  assert.equal(normalizeRoomCode('ABC'), null);
  assert.equal(normalizeRoomCode('ABCD0'), null);
  assert.equal(normalizeRoomCode(null), null);
});

test('입장: 첫 사람이 방장, joined에 토큰, 모두에게 state', () => {
  const env = createEnv();
  const joined = env.join('a', '민수');
  assert.equal(joined.playerId, 'p1');
  assert.equal(joined.token, 'token-1');
  assert.equal(joined.code, 'ABCDE');
  assert.equal(joined.reconnected, false);
  env.join('b', '지연');
  const state = env.last('a', 'state');
  assert.equal(state.phase, ROOM_PHASE.LOBBY);
  assert.equal(state.hostId, 'p1');
  assert.deepEqual(state.players.map((p) => [p.nickname, p.isHost]), [['민수', true], ['지연', false]]);
  assert.ok(!JSON.stringify(state).includes('token-'), 'state에는 재접속 토큰이 없다');
});

test('닉네임: 겹치면 숫자를 붙이고, 공백·길이를 정리하고, 빈 값은 거부', () => {
  const env = createEnv();
  env.join('a', '  민수  ');
  assert.equal(env.join('b', '민수').playerId, 'p2');
  env.join('c', '민수');
  env.join('d', '민수');
  assert.deepEqual(env.state().players.map((p) => p.nickname), ['민수', '민수2', '민수3', '민수4']);
  env.join('e', 'A'.repeat(30));
  assert.equal(env.state().players[4].nickname.length, 12);
  env.send('f', { type: 'join', nickname: '   ' });
  assert.equal(env.last('f', 'error').code, 'bad-nickname');
  env.send('g', { type: 'join' });
  assert.equal(env.last('g', 'error').code, 'bad-nickname');
});

test('최대 8명', () => {
  const env = createEnv();
  for (let i = 1; i <= 8; i++) env.join(`c${i}`, `p${i}`);
  env.send('c9', { type: 'join', nickname: '아홉째' });
  assert.equal(env.last('c9', 'error').code, 'room-full');
  assert.equal(env.state().players.length, 8);
});

test('입장 전 연결은 ping만 가능', () => {
  const env = createEnv();
  env.send('x', { type: 'ping', clientTime: 123 });
  assert.deepEqual(env.last('x', 'pong'), { type: 'pong', clientTime: 123, serverTime: env.timers.now() });
  env.send('x', { type: 'start' });
  assert.equal(env.last('x', 'error').code, 'not-joined');
  env.send('x', 'garbage');
  env.send('x', { type: 1 });
});

test('설정: 방장만, 값 검증, 부분 변경', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('b', { type: 'settings', settings: { rounds: 5 } });
  assert.equal(env.last('b', 'error').code, 'not-host');
  assert.equal(env.state().settings.rounds, 10);

  env.send('a', { type: 'settings', settings: { rounds: 5, clipLength: 3, answerTime: 20 } });
  assert.deepEqual(env.state().settings, { mode: 'random', rounds: 5, clipLength: 3, difficulty: 'normal', answerTime: 20 });
  env.send('a', { type: 'settings', settings: { mode: 'full', difficulty: 'hard' } });
  assert.equal(env.state().settings.mode, 'full');
  assert.equal(env.state().settings.rounds, 5);

  for (const bad of [{ rounds: 7 }, { clipLength: 4 }, { answerTime: 12 }, { mode: 'x' }, { difficulty: 'insane' }]) {
    env.send('a', { type: 'settings', settings: bad });
    assert.equal(env.last('a', 'error').code, 'bad-settings');
  }
  assert.equal(env.state().settings.rounds, 5); // 잘못된 요청은 아무것도 바꾸지 않는다
});

test('시작: 방장만, 2명 이상', () => {
  const env = createEnv();
  env.joinAll('a');
  env.send('a', { type: 'start' });
  assert.equal(env.last('a', 'error').code, 'not-enough-players');
  env.join('b', 'b');
  env.send('b', { type: 'start' });
  assert.equal(env.last('b', 'error').code, 'not-host');
  assert.equal(env.state().phase, ROOM_PHASE.LOBBY);
  env.send('a', { type: 'start' });
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
});

test('시작한 뒤에는 새로 입장할 수 없다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('c', { type: 'join', nickname: '지각생' });
  assert.equal(env.last('c', 'error').code, 'game-started');
  env.send('c', { type: 'join', nickname: '지각생', token: 'not-a-token' });
  assert.equal(env.last('c', 'error').code, 'game-started');
});

test('곡이 없으면 시작하지 않는다(랜덤듣기는 길이 정보가 필요)', () => {
  const noDuration = [1, 2, 3].map((n) => ({ id: `s${n}`, videoId: `vid0000000${n}`, title: `T${n}`, anime: { name: 'A' } }));
  const env = createEnv({ songs: noDuration });
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  assert.equal(env.last('a', 'error').code, 'no-songs');
  assert.equal(env.state().phase, ROOM_PHASE.LOBBY);
  // 전체듣기는 길이가 없어도 된다
  env.send('a', { type: 'settings', settings: { mode: 'full' } });
  env.send('a', { type: 'start' });
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
});

test('재접속 토큰: 점수를 유지하고 진행 중인 라운드는 쉬고 다음 라운드부터 합류', () => {
  const env = createEnv();
  const [, jb] = env.joinAll('a', 'b');
  env.joinAll('c');
  env.begin();
  env.answer('a', env.correctText()); // a가 1라운드 득점
  const aScore = env.state().players[0].score;
  assert.ok(aScore > 0);

  env.room.handleDisconnect('b');
  assert.equal(env.state().players[1].connected, false);
  env.timers.advance(30_000); // 유예(60초) 안
  assert.equal(env.state().players[1].left, false);

  const back = env.join('b2', '아무거나', jb.token);
  assert.equal(back.reconnected, true);
  assert.equal(back.playerId, jb.playerId);
  assert.equal(env.state().players[1].connected, true);
  assert.equal(env.state().players[0].score, aScore);
  assert.equal(env.msgs('b2', 'prepare').length, 0, '진행 중인 라운드에는 끼지 않는다');

  env.timers.advance(8000); // 공개 → 다음 라운드 준비
  assert.equal(env.msgs('b2', 'prepare').length, 1);
  assert.equal(env.state().players[1].status, 'preparing');
});

test('재접속 유예 60초가 지나면 퇴장 처리(순위 기록은 남음)', () => {
  const env = createEnv();
  const [, jb] = env.joinAll('a', 'b');
  env.joinAll('c');
  env.begin();
  env.room.handleDisconnect('b');
  env.timers.advance(59_999);
  assert.equal(env.state().players[1].left, false);
  env.timers.advance(1);
  assert.equal(env.state().players[1].left, true);
  // 토큰은 더 이상 통하지 않는다(게임 중 새 입장 불가)
  env.send('b2', { type: 'join', nickname: 'b', token: jb.token });
  assert.equal(env.last('b2', 'error').code, 'game-started');
});

test('같은 토큰으로 다른 연결이 들어오면 이전 연결은 밀려난다', () => {
  const env = createEnv();
  const [ja] = env.joinAll('a', 'b');
  env.join('a2', 'a', ja.token);
  assert.deepEqual(env.last('a', 'kicked'), { type: 'kicked', reason: 'replaced' });
  env.send('a', { type: 'start' });
  assert.equal(env.last('a', 'error').code, 'not-joined');
  env.send('a2', { type: 'start' });
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
});

test('방장 이탈: 가장 먼저 입장한 사람에게 넘긴다', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.room.handleDisconnect('a');
  assert.equal(env.state().hostId, 'p2');
  env.send('c', { type: 'settings', settings: { rounds: 5 } });
  assert.equal(env.last('c', 'error').code, 'not-host');
  env.send('b', { type: 'settings', settings: { rounds: 5 } });
  assert.equal(env.state().settings.rounds, 5);

  // 원래 방장이 돌아와도 방장 자리는 되찾지 않는다
  env.join('a2', 'a', 'token-1');
  assert.equal(env.state().hostId, 'p2');
});

test('방장 이탈: 접속 중인 사람 우선, 명시적 leave도 동일', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.room.handleDisconnect('b'); // 유예 중인 b
  env.send('a', { type: 'leave' });
  assert.equal(env.state().hostId, 'p3'); // 접속 중인 c
  assert.equal(env.state().players.length, 2); // 대기실에서는 나간 사람을 지운다
});

test('대기실에서 끊긴 사람은 시작 인원에 세지 않는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.room.handleDisconnect('b');
  env.send('a', { type: 'start' });
  assert.equal(env.last('a', 'error').code, 'not-enough-players');
});

test('전원이 끊기고 유예가 끝나면 방을 닫는다', () => {
  const closed = [];
  const env = createEnv({ closed });
  env.joinAll('a', 'b');
  env.room.handleDisconnect('a');
  env.room.handleDisconnect('b');
  assert.deepEqual(closed, []);
  env.timers.advance(60_000);
  assert.deepEqual(closed, ['ABCDE']);
  assert.equal(env.timers.pending(), 0, '남은 타이머가 없다');
});

test('게임 중 전원이 끊기면 진행을 멈추고, 한 명이 돌아오면 결과 화면', () => {
  const env = createEnv();
  const [ja] = env.joinAll('a', 'b');
  env.begin();
  env.room.handleDisconnect('a');
  env.room.handleDisconnect('b');
  env.timers.advance(30_000); // 라운드 타이머가 멈춰 있어야 한다
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING);
  env.join('a2', 'a', ja.token);
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  assert.equal(env.last('a2', 'gameOver').reason, 'not-enough-players');
});

test('남은 사람이 1명이면 현재 라운드를 마치고 결과 화면', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.room.handleDisconnect('b');
  assert.equal(env.state().phase, ROOM_PHASE.ANSWERING); // 라운드는 계속
  env.answer('a', env.correctText());
  assert.equal(env.state().phase, ROOM_PHASE.REVEALED);
  assert.equal(env.last('a', 'reveal').hasNext, false);
  env.timers.advance(8000);
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  assert.equal(env.last('a', 'gameOver').reason, 'not-enough-players');
});

test('순위: 총점, 동점이면 정답 수, 그래도 같으면 공동 순위', () => {
  const ranked = rankPlayers([
    { id: 'a', joinSeq: 1, score: 200, correct: 2 },
    { id: 'b', joinSeq: 2, score: 300, correct: 2 },
    { id: 'c', joinSeq: 3, score: 200, correct: 3 },
    { id: 'd', joinSeq: 4, score: 200, correct: 2 },
    { id: 'e', joinSeq: 5, score: 0, correct: 0 },
  ]);
  assert.deepEqual(ranked.map((p) => [p.id, p.rank]), [['b', 1], ['c', 2], ['a', 3], ['d', 3], ['e', 5]]);
});

test('끝까지 진행: 순위·라운드별 기록, 방장이 같은 멤버로 다시 시작', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'settings', settings: { rounds: 5 } });
  env.send('a', { type: 'start' });
  const winners = ['a', 'a', 'b', 'c', 'a'];
  for (const w of winners) {
    env.readyAll();
    env.timers.advance(3000 + 2000);
    env.answer(w, env.correctText());
    env.timers.advance(8000);
  }
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  const over = env.last('b', 'gameOver');
  assert.equal(over.reason, 'complete');
  assert.deepEqual(over.ranking.map((r) => [r.nickname, r.rank, r.correct]), [['a', 1, 3], ['b', 2, 1], ['c', 2, 1]]);
  assert.equal(over.history.length, 5);
  assert.deepEqual(over.history.map((h) => h.winnerNickname), ['a', 'a', 'b', 'c', 'a']);
  assert.ok(over.history.every((h) => h.elapsed === 2 && h.points > 0));

  // 같은 멤버로 한 판 더: 점수 초기화
  env.send('b', { type: 'start' });
  assert.equal(env.last('b', 'error').code, 'not-host');
  env.send('a', { type: 'start' });
  assert.equal(env.state().phase, ROOM_PHASE.PREPARING);
  assert.ok(env.state().players.every((p) => p.score === 0 && p.correct === 0));
  assert.equal(env.state().round.index, 0);
});

test('다시 시작 전에 나간 사람은 정리된다', () => {
  const env = createEnv({ songCount: 5 });
  env.joinAll('a', 'b', 'c');
  env.send('a', { type: 'settings', settings: { rounds: 5 } });
  env.send('a', { type: 'start' });
  env.readyAll();
  env.timers.advance(3000);
  env.send('c', { type: 'leave' });
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      env.readyAll();
      env.timers.advance(3000);
    }
    env.answer('a', env.correctText());
    env.timers.advance(8000);
  }
  assert.equal(env.state().phase, ROOM_PHASE.RESULTS);
  assert.equal(env.last('a', 'gameOver').ranking.find((r) => r.nickname === 'c').left, true);
  env.send('a', { type: 'start' });
  assert.deepEqual(env.state().players.map((p) => p.nickname), ['a', 'b']);
});
