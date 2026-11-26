// 방 상태 머신: 정답 공개 시간·전체듣기 제한 시간 설정, 넘기기 투표, 이모지 리액션, 곡 교체 횟수 제한
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_PHASE } from '../server/room.js';
import { REACTIONS } from '../js/online/reactions.js';
import { createEnv } from './roomHelpers.js';

/** 2명이 들어와 1라운드를 시작하고 모두 패스해 정답 공개까지 간다 */
function toReveal(env, settings = {}) {
  env.joinAll('a', 'b');
  if (Object.keys(settings).length) env.send('a', { type: 'settings', settings });
  env.begin();
  env.passRest();
  assert.equal(env.room.phase, ROOM_PHASE.REVEALED);
}

test('정답 공개 시간: 방 설정만큼 공개한 뒤 다음 라운드', () => {
  const env = createEnv();
  toReveal(env, { revealTime: 5 });
  const reveal = env.last('a', 'reveal');
  assert.equal(reveal.nextAt, env.timers.now() + 5000);
  env.timers.advance(4999);
  assert.equal(env.room.phase, ROOM_PHASE.REVEALED);
  env.timers.advance(1);
  assert.equal(env.room.phase, ROOM_PHASE.PREPARING);
  assert.equal(env.prepare('a').index, 1);
});

test('전체듣기 제한 시간: 방 설정이 답변 창과 점수에 쓰인다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { mode: 'full', fullTime: 60 } });
  env.begin();
  assert.equal(env.prepare('a').answerWindow, 60);
  env.timers.advance(30000); // 30초 뒤 정답: 60초 기준이면 60점(30초 기준이었다면 20점)
  env.answer('a', env.correctText());
  assert.equal(env.last('a', 'answerResult').points, 60);
  env.timers.advance(29999);
  assert.equal(env.room.phase, ROOM_PHASE.ANSWERING);
  env.timers.advance(1);
  assert.equal(env.room.phase, ROOM_PHASE.REVEALED);
});

test('넘기기 투표: 접속한 사람 전원이 투표하면 바로 다음 라운드', () => {
  const env = createEnv();
  toReveal(env, { revealTime: 30 });
  const roundId = env.round().id;
  env.send('a', { type: 'skip', roundId });
  env.send('a', { type: 'skip', roundId }); // 같은 사람이 두 번 눌러도 한 표
  const state = env.state();
  assert.equal(state.phase, ROOM_PHASE.REVEALED);
  assert.deepEqual(state.players.map((p) => p.skip), [true, false]);
  env.send('b', { type: 'skip', roundId: roundId + 1 }); // 다른 라운드 표는 무시
  assert.equal(env.room.phase, ROOM_PHASE.REVEALED);
  env.send('b', { type: 'skip', roundId });
  assert.equal(env.room.phase, ROOM_PHASE.PREPARING);
  assert.equal(env.prepare('b').index, 1);
  assert.deepEqual(env.state().players.map((p) => p.skip), [null, null]); // 공개가 끝나면 표시 없음
  // 원래 공개 타이머는 지워져 다음 라운드를 건너뛰지 않는다
  env.timers.advance(30000);
  assert.equal(env.prepare('a').index, 1);
});

test('넘기기 투표: 공개 중이 아니면 무시', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'skip', roundId: env.round().id });
  env.send('b', { type: 'skip', roundId: env.round().id });
  assert.equal(env.room.phase, ROOM_PHASE.ANSWERING);
  env.passRest();
  assert.deepEqual(env.state().players.map((p) => p.skip), [false, false]);
});

test('넘기기 투표: 투표하지 않은 사람이 끊기면 남은 사람끼리 넘어간다', () => {
  const env = createEnv();
  env.joinAll('a', 'b', 'c');
  env.begin();
  env.passRest();
  const roundId = env.round().id;
  env.send('a', { type: 'skip', roundId });
  env.send('b', { type: 'skip', roundId });
  assert.equal(env.room.phase, ROOM_PHASE.REVEALED);
  env.room.handleDisconnect('c');
  assert.equal(env.room.phase, ROOM_PHASE.PREPARING);
});

test('넘기기 투표: 마지막 라운드면 바로 결과', () => {
  const env = createEnv();
  toReveal(env, { rounds: 1 });
  const roundId = env.round().id;
  env.send('a', { type: 'skip', roundId });
  env.send('b', { type: 'skip', roundId });
  assert.equal(env.room.phase, ROOM_PHASE.RESULTS);
  assert.equal(env.last('a', 'gameOver').reason, 'complete');
});

test('리액션: 정답 공개 중에만, 목록의 이모지만 모두에게 전달', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'react', emoji: REACTIONS[0] }); // 답변 중에는 안 됨
  assert.equal(env.msgs('b', 'reaction').length, 0);
  env.passRest();
  env.send('a', { type: 'react', emoji: '💩' }); // 목록에 없는 이모지
  env.send('a', { type: 'react', emoji: '<b>' });
  assert.equal(env.msgs('b', 'reaction').length, 0);
  env.send('a', { type: 'react', emoji: REACTIONS[1] });
  for (const conn of ['a', 'b']) {
    const r = env.last(conn, 'reaction');
    assert.deepEqual([r.playerId, r.emoji], ['p1', REACTIONS[1]]);
  }
});

test('리액션: 한 사람이 너무 빨리 보내면 버린다', () => {
  const env = createEnv();
  toReveal(env);
  const cooldown = env.room.config.reactionCooldownMs;
  env.send('a', { type: 'react', emoji: REACTIONS[0] });
  env.send('a', { type: 'react', emoji: REACTIONS[0] });
  env.send('b', { type: 'react', emoji: REACTIONS[2] }); // 다른 사람은 상관없다
  assert.equal(env.msgs('a', 'reaction').length, 2);
  env.timers.advance(cooldown);
  env.send('a', { type: 'react', emoji: REACTIONS[3] });
  assert.equal(env.msgs('a', 'reaction').length, 3);
});

/** 지금 라운드를 전원 재생 오류로 만든다(과반 오류 → 곡 교체) */
function failAll(env) {
  const roundId = env.round().id;
  for (const conn of ['a', 'b']) env.send(conn, { type: 'playerError', roundId, code: 150 });
}

test('곡 교체 제한: 한 라운드에서 연달아 재생하지 못하면 곡을 다 쓰기 전에 멈춘다', () => {
  const env = createEnv({ songCount: 20 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  const max = env.room.config.maxSongReplacements;
  for (let i = 0; i < max; i++) {
    failAll(env);
    assert.equal(env.room.phase, ROOM_PHASE.PREPARING, `${i + 1}번째 교체 뒤에도 준비 중`);
  }
  failAll(env);
  assert.equal(env.room.phase, ROOM_PHASE.RESULTS);
  assert.equal(env.last('a', 'gameOver').reason, 'playback-failed');
  assert.match(env.last('b', 'notice').message, /게임을 멈췄습니다/);
  assert.equal(env.room.queue.length, 20 - 1 - max); // 시도한 곡만 썼다
});

test('곡 교체 제한: 라운드가 바뀌면 횟수를 다시 센다', () => {
  const env = createEnv({ songCount: 20 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  const max = env.room.config.maxSongReplacements;
  for (let i = 0; i < max; i++) failAll(env);
  env.readyAll(); // 이번 곡은 재생됨
  env.timers.advance(env.room.config.goLeadMs);
  env.passRest();
  env.timers.advance(env.room.revealMs);
  assert.equal(env.prepare('a').index, 1);
  for (let i = 0; i < max; i++) failAll(env);
  assert.equal(env.room.phase, ROOM_PHASE.PREPARING);
});
