// 초성 힌트: 변환(initialHint), 점수(applyHint), 개인전(GameSession), 친구와 대결(Room, OnlineSession)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, MODE, PLAYER_STATE } from '../js/game.js';
import { DIFFICULTY, formatHint, hintParts, initialHint } from '../js/judge.js';
import { applyHint } from '../js/scoring.js';
import { OnlineSession } from '../js/online/session.js';
import { DurationCache, createMemoryStorage } from '../js/songs.js';
import { FakePlayer, createClock, makeSong, manualScheduler, seededRng } from './helpers.js';
import { createEnv } from './roomHelpers.js';

test('initialHint: 한글은 초성, 영문은 단어 첫 글자만, 띄어쓰기·숫자·기호는 그대로', () => {
  assert.equal(initialHint('사이하테'), 'ㅅㅇㅎㅌ');
  assert.equal(initialHint('푸른 산호초 2'), 'ㅍㄹ ㅅㅎㅊ 2');
  assert.equal(initialHint('KICK BACK'), 'K___ B___');
  assert.equal(initialHint('깨끗하게 해주시겠어요?'), 'ㄲㄲㅎㄱ ㅎㅈㅅㄱㅇㅇ?');
  assert.equal(initialHint('Q&A'), 'Q&A', '기호 뒤는 새 단어');
  assert.equal(initialHint('IDOL 아이돌'), 'I___ ㅇㅇㄷ');
  assert.equal(initialHint(''), '');
  assert.equal(initialHint(null), '');
});

test('applyHint: 힌트를 봤으면 절반(반올림)', () => {
  assert.equal(applyHint(100, false), 100);
  assert.equal(applyHint(100, true), 50);
  assert.equal(applyHint(75, true), 38);
});

// ---------- 개인전 ----------
function soloSetup(settings = {}) {
  const songs = Array.from({ length: 5 }, (_, i) => makeSong(i + 1, { duration: 200 }));
  const durations = Object.fromEntries(songs.map((s) => [s.videoId, 200]));
  const players = [new FakePlayer({ durations }), new FakePlayer({ durations })];
  const clock = createClock(1000);
  const game = new GameSession({
    songs,
    settings: { mode: MODE.RANDOM, clipLength: 5, rounds: 3, difficulty: DIFFICULTY.NORMAL, ...settings },
    players,
    durationCache: new DurationCache(createMemoryStorage()),
    rng: seededRng(42),
    now: clock.now,
    scheduler: manualScheduler,
  });
  game.start();
  return { game, clock };
}

function beginAudio(game) {
  const p = game.player;
  p.emitState(PLAYER_STATE.PLAYING);
  p.time += 0.15;
  game.tick();
}

test('개인전 힌트: 소리가 난 뒤 1번만, 맞히면 점수 절반, 결과에 hintUsed', () => {
  const { game } = soloSetup();
  assert.equal(game.canHint, false, '소리가 나기 전에는 못 봄');
  assert.equal(game.useHint(), null);
  beginAudio(game);
  assert.equal(game.canHint, true);
  assert.deepEqual(game.useHint(), [{ key: 'title', text: initialHint(game.round.song.title) }]);
  assert.equal(game.canHint, false, '라운드당 1번');
  assert.equal(game.useHint(), null);
  game.submitAnswer(game.round.song.title);
  assert.equal(game.round.result.points, 50);
  assert.equal(game.round.result.hintUsed, true);
  assert.equal(game.score, 50);
  assert.equal(game.history[0].hintUsed, true);
});

test('개인전 힌트: 힌트 없이 맞히면 그대로, 다음 라운드는 다시 쓸 수 있음', () => {
  const { game } = soloSetup();
  beginAudio(game);
  game.submitAnswer(game.round.song.title);
  assert.equal(game.round.result.points, 100);
  assert.equal(game.round.result.hintUsed, false);
  game.next();
  beginAudio(game);
  assert.equal(game.canHint, true);
});

test('개인전 힌트: 쉬움(객관식)에서는 쓸 수 없음', () => {
  const { game } = soloSetup({ difficulty: DIFFICULTY.EASY });
  beginAudio(game);
  assert.equal(game.canHint, false);
  assert.equal(game.useHint(), null);
});

test('개인전 힌트: 매우 어려움은 힌트 뒤에 맞힌 항목·보너스만 절반', () => {
  const { game } = soloSetup({ difficulty: DIFFICULTY.EXTREME });
  beginAudio(game);
  const song = game.round.song; // 작품 있음, 가수 없음 → 제목 2 : 작품 1
  game.submitAnswer(song.anime.name);
  game.useHint();
  game.submitAnswer(song.title);
  // 작품명 100×1/3=33(힌트 전), 제목 50×2/3=33, 보너스 50×0.5=25
  assert.equal(game.round.result.points, 33 + 33 + 25);
  assert.equal(game.round.result.hintUsed, true);
});

// ---------- 친구와 대결 서버 ----------
test('대결 힌트: 요청한 사람에게만 초성을 보내고, state에는 사용 여부만', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'hint', roundId: env.round().id });
  const title = initialHint(env.round().song.title);
  assert.deepEqual(env.last('a', 'hint'), { type: 'hint', roundId: 1, text: title, parts: [{ key: 'title', text: title }] });
  assert.equal(env.msgs('b', 'hint').length, 0);
  assert.deepEqual(env.state().players.map((p) => p.hint), [true, false]);
  assert.ok(!JSON.stringify(env.msgs('b')).includes(initialHint(env.round().song.title)), '다른 사람에게 초성이 가지 않는다');

  env.send('a', { type: 'hint', roundId: env.round().id });
  assert.equal(env.msgs('a', 'hint').length, 1, '라운드당 1번');
});

test('대결 힌트: 맞히면 속도 점수 절반, 공개 기록에 hint 표시', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'hint', roundId: env.round().id });
  env.timers.advance(4000); // 기본 140
  env.answer('a', env.correctText());
  env.answer('b', env.correctText());
  assert.equal(env.last('a', 'answerResult').points, 70);
  assert.equal(env.last('b', 'answerResult').points, 140);
  const reveal = env.last('a', 'reveal');
  assert.deepEqual(reveal.correctPlayers.map((c) => [c.nickname, c.points, c.hint]), [['a', 70, true], ['b', 140, false]]);
});

test('대결 힌트: 시작 신호 전, 쉬움, 이미 끝낸 사람, 다른 roundId는 무시', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  env.readyAll();
  env.send('a', { type: 'hint', roundId: env.round().id }); // 시작 신호 전
  assert.equal(env.msgs('a', 'hint').length, 0);
  env.timers.advance(env.room.config.goLeadMs);
  env.send('a', { type: 'hint', roundId: 99 });
  assert.equal(env.msgs('a', 'hint').length, 0);
  env.send('b', { type: 'pass', roundId: env.round().id });
  env.send('b', { type: 'hint', roundId: env.round().id });
  assert.equal(env.msgs('b', 'hint').length, 0, '패스한 사람');

  const easy = createEnv();
  easy.joinAll('a', 'b');
  easy.send('a', { type: 'settings', settings: { difficulty: 'easy' } });
  easy.begin();
  easy.send('a', { type: 'hint', roundId: easy.round().id });
  assert.equal(easy.msgs('a', 'hint').length, 0);
});

test('대결 힌트: 다음 라운드에는 초기화', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'hint', roundId: env.round().id });
  env.passRest();
  env.timers.advance(env.room.config.revealMs);
  env.readyAll();
  env.timers.advance(env.room.config.goLeadMs);
  assert.deepEqual(env.state().players.map((p) => p.hint), [false, false]);
  env.send('a', { type: 'hint', roundId: env.round().id });
  assert.equal(env.msgs('a', 'hint').length, 2);
});

// ---------- 친구와 대결 클라이언트 ----------
test('세션 힌트: 답할 수 있을 때만 요청, 받은 초성 저장, 라운드가 바뀌면 지움', () => {
  let now = 100_000;
  const sent = [];
  const handlers = new Set();
  const connection = {
    on: (type, fn) => {
      if (type === 'message') handlers.add(fn);
      return () => handlers.delete(fn);
    },
    send: (m) => sent.push(m) > 0,
    close: () => {},
  };
  const session = new OnlineSession({ connection, playback: { handleMessage() {}, stop() {} }, clock: { serverNow: () => now } });
  const receive = (m) => [...handlers].forEach((fn) => fn(m));
  const players = [{ id: 'p1', status: 'ready' }, { id: 'p2', status: 'ready' }];
  receive({ type: 'joined', code: 'ABCDE', playerId: 'p1', token: 't' });
  receive({ type: 'prepare', roundId: 3, choices: null });
  receive({ type: 'state', phase: 'starting', hostId: 'p1', players });
  receive({ type: 'go', roundId: 3, startAt: now + 3000, deadlineAt: now + 23_000 });
  assert.equal(session.requestHint(), false, '시작 신호 전');
  now += 3000;
  assert.equal(session.requestHint(), true);
  assert.deepEqual(sent.at(-1), { type: 'hint', roundId: 3 });
  assert.equal(session.requestHint(), false, '응답을 기다리는 중에는 다시 보내지 않음');
  receive({ type: 'hint', roundId: 3, text: 'ㅅㅇㅎㅌ', parts: [{ key: 'title', text: 'ㅅㅇㅎㅌ' }, { key: 'artist', text: 'ㄹㅅ' }] });
  assert.deepEqual(session.hint, [{ key: 'title', text: 'ㅅㅇㅎㅌ' }, { key: 'artist', text: 'ㄹㅅ' }]);
  assert.equal(session.canHint, false);
  receive({ type: 'prepare', roundId: 4, choices: null });
  assert.equal(session.hint, null);
  assert.equal(session.hintRequested, false);
});

test('hintParts: 매우 어려움은 곡에 있는 항목 전부, 그 밖에는 제목만', () => {
  const song = { title: '사이하테', artist: '요네즈 켄시', anime: { name: '체인소 맨', aliases: [] } };
  assert.deepEqual(hintParts(song, DIFFICULTY.NORMAL), [{ key: 'title', text: 'ㅅㅇㅎㅌ' }]);
  assert.deepEqual(hintParts(song, DIFFICULTY.HARD), [{ key: 'title', text: 'ㅅㅇㅎㅌ' }]);
  assert.deepEqual(hintParts(song, DIFFICULTY.EXTREME), [
    { key: 'title', text: 'ㅅㅇㅎㅌ' },
    { key: 'artist', text: 'ㅇㄴㅈ ㅋㅅ' },
    { key: 'anime', text: 'ㅊㅇㅅ ㅁ' },
  ]);
  assert.deepEqual(hintParts({ title: 'Only Way', artist: '9Lana' }, DIFFICULTY.EXTREME), [
    { key: 'title', text: 'O___ W__' },
    { key: 'artist', text: '9L___' },
  ], '작품 없는 일반 노래는 제목·가수');
});

test('formatHint: 항목 하나면 "제목 초성: …", 여럿이면 항목별로', () => {
  assert.equal(formatHint(null), '');
  assert.equal(formatHint([{ key: 'title', text: 'ㅅㅇㅎㅌ' }]), '제목 초성: ㅅㅇㅎㅌ');
  assert.equal(formatHint([{ key: 'title', text: 'ㅅㅇㅎㅌ' }, { key: 'artist', text: 'ㄹㅅ' }]), '초성 — 제목 ㅅㅇㅎㅌ · 가수 ㄹㅅ');
});

test('대결 힌트: 매우 어려움은 가수·작품명 초성도 보낸다', () => {
  const env = createEnv({ songs: Array.from({ length: 4 }, (_, i) => makeSong(i + 1, { duration: 200, artist: `가수 ${i + 1}` })) });
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { difficulty: 'extreme' } });
  env.begin();
  env.send('a', { type: 'hint', roundId: env.round().id });
  assert.deepEqual(env.last('a', 'hint').parts.map((p) => p.key), ['title', 'artist', 'anime']);
});

test('개인전 답변 시간: 구간이 끝나고 정한 시간이 지나면 시간 초과로 공개, 제한 없음은 계속 기다림', () => {
  const { game, clock } = soloSetup({ answerTime: 10 });
  beginAudio(game);
  game.player.time = game.round.segmentStart + 5;
  game.tick(); // 구간 끝 → STOPPED, 답변 시간 시작
  assert.equal(game.phase, 'stopped');
  assert.equal(game.answerSecondsLeft(), 10);
  clock.advance(9_000);
  game.tick();
  assert.equal(game.phase, 'stopped');
  assert.equal(Math.ceil(game.answerSecondsLeft()), 1);
  clock.advance(1_000);
  game.tick();
  assert.equal(game.phase, 'revealed');
  assert.equal(game.round.result.reason, 'timeout');
  assert.equal(game.round.result.points, 0);

  const free = soloSetup();
  beginAudio(free.game);
  free.game.player.time = free.game.round.segmentStart + 5;
  free.game.tick();
  assert.equal(free.game.answerSecondsLeft(), null);
  free.clock.advance(600_000);
  free.game.tick();
  assert.equal(free.game.phase, 'stopped', '제한 없음(기본)');
});

test('개인전 답변 시간: 다시듣기를 하면 다시 들은 구간이 끝난 뒤부터 새로 센다', () => {
  const { game, clock } = soloSetup({ answerTime: 10 });
  beginAudio(game);
  game.player.time = game.round.segmentStart + 5;
  game.tick();
  clock.advance(8_000);
  game.replay();
  assert.equal(game.round.answerDeadline, null);
  clock.advance(5_000); // 원래 마감이 지났지만 다시듣기 중
  game.tick();
  assert.notEqual(game.phase, 'revealed');
});
