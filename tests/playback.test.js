import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_STATE } from '../js/game.js';
import { ClockSync } from '../js/online/net.js';
import { OnlinePlayback, PLAYBACK_STAGE } from '../js/online/playback.js';
import { FakePlayer } from './helpers.js';
import { createFakeTimers } from './fakeTimers.js';

function setup({ playerCount = 2, offset = 0 } = {}) {
  const timers = createFakeTimers();
  // 클라이언트 시계 = 가짜 시계, 서버 시각 = 클라이언트 + offset
  const clock = new ClockSync({ now: timers.now });
  clock.offset = offset;
  const players = Array.from({ length: playerCount }, () => new FakePlayer());
  const sent = [];
  const playback = new OnlinePlayback({ players, clock, send: (m) => sent.push(m), scheduler: timers });
  return { timers, clock, players, sent, playback };
}

const prepareMsg = (extra = {}) => ({
  type: 'prepare',
  roundId: 1,
  mode: 'random',
  videoId: 'vid00000001',
  segmentStart: 42.5,
  clipLength: 5,
  ...extra,
});

/** 로드된 플레이어가 구간 시작 위치에서 재생을 시작하고 시간이 흐르는 상황 */
function reachStart(env, index = env.playback.active) {
  const p = env.players[index];
  p.emitState(PLAYER_STATE.PLAYING); // 1회차 관찰
  p.time += 0.15;
  env.timers.advance(100); // 폴링: 시간이 흐른 것을 확인
}

test('prepare: 음소거로 구간 위치에 로드하고, 위치 확인 뒤 멈춰서 ready 보고', () => {
  const env = setup();
  env.playback.handleMessage(prepareMsg());
  const p = env.players[0];
  assert.deepEqual(p.calls.slice(0, 2), [['mute'], ['load', 'vid00000001', 42.5]]);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PREPARING);
  assert.equal(env.sent.length, 0);

  reachStart(env);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.READY);
  assert.deepEqual(env.sent, [{ type: 'ready', roundId: 1 }]);
  assert.deepEqual(p.calls.slice(2), [['pause'], ['seek', 42.5]]);
  assert.ok(!p.callNames().includes('unMute'), '준비 중에는 소리를 켜지 않는다');
  assert.equal(p.muted, true);

  env.timers.advance(2000);
  assert.equal(env.sent.length, 1); // 폴링이 멈췄으니 ready는 한 번만
});

test('prepare: 위치가 구간 밖이면(seek 전 소리) ready를 보내지 않는다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  const p = env.players[0];
  p.time = 0; // 아직 0초 부근
  p.emitState(PLAYER_STATE.PLAYING);
  p.time = 0.2;
  env.timers.advance(100);
  p.time = 0.4;
  env.timers.advance(100);
  assert.equal(env.sent.length, 0);
  p.time = 42.5;
  env.timers.advance(100);
  p.time = 42.7;
  env.timers.advance(100);
  assert.equal(env.sent.length, 1);
});

test('prepare: 전체듣기는 0초부터', () => {
  const env = setup();
  env.playback.prepare(prepareMsg({ mode: 'full', segmentStart: 99, clipLength: null }));
  assert.deepEqual(env.players[0].calls[1], ['load', 'vid00000001', 0]);
  reachStart(env);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.READY);
  assert.deepEqual(env.players[0].calls.at(-1), ['seek', 0]);
});

test('go: 서버 시각 startAt에 unMute + play', () => {
  const env = setup({ offset: 5000 }); // 서버가 5초 빠르다
  env.playback.prepare(prepareMsg());
  reachStart(env);
  const p = env.players[0];
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() + 3000 });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.READY);

  env.timers.advance(2999);
  assert.ok(!p.callNames().includes('unMute'));
  env.timers.advance(1);
  assert.deepEqual(p.calls.slice(-2), [['unMute'], ['play']]);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PLAYING);
});

test('go: 시작 시각이 이미 지났으면 늦은 만큼 앞으로 가서 재생', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.timers.advance(5000);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() - 1500 });
  assert.deepEqual(env.players[0].calls.slice(-3), [['seek', 44], ['unMute'], ['play']]);
});

test('go: 구간을 다 놓칠 만큼 늦으면 소리를 켜지 않는다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg({ clipLength: 3 }));
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() - 4000 });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.MISSED);
  assert.ok(!env.players[0].callNames().includes('unMute'));
});

test('go: 준비를 못 끝낸 채 받으면 놓친 것으로 처리', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() + 1000 });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.MISSED);
  reachStart(env); // 폴링은 멈췄으므로 ready를 보내지 않는다
  env.timers.advance(5000);
  assert.equal(env.sent.length, 0);
  assert.ok(!env.players[0].callNames().includes('unMute'));
});

test('랜덤 구간은 재생 위치가 끝에 닿으면 멈추고 다시 음소거', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  const p = env.players[0];
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PLAYING);
  p.time = 46;
  env.timers.advance(100);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PLAYING);
  p.time = 47.6;
  env.timers.advance(100);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.STOPPED);
  assert.deepEqual(p.calls.slice(-2), [['pause'], ['mute']]);
});

test('재생 위치가 안 올라도 시간 기준으로 구간을 끝낸다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  env.timers.advance(5900);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PLAYING);
  env.timers.advance(300);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.STOPPED);
});

test('전체듣기는 reveal까지 계속 재생', () => {
  const env = setup();
  env.playback.prepare(prepareMsg({ mode: 'full', clipLength: null }));
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  env.players[0].time = 200;
  env.timers.advance(20_000);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.PLAYING);
});

test('reveal: 영상 표시, 소리 켜기, 다음 곡은 다른 플레이어에 cue', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  env.playback.reveal({ roundId: 1, nextVideoId: 'vid00000002' });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.REVEALED);
  assert.deepEqual(env.players[0].calls.slice(-2), [['unMute'], ['play']]);
  assert.deepEqual(env.players[1].calls, [['cue', 'vid00000002']]);
  assert.equal(env.playback.isPlayerVisible(0), true);
  assert.equal(env.playback.isPlayerVisible(1), false);
});

test('reveal 전에는 어떤 플레이어도 보이지 않는다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  assert.equal(env.playback.isPlayerVisible(0), false);
  reachStart(env);
  assert.equal(env.playback.isPlayerVisible(0), false);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  assert.equal(env.playback.isPlayerVisible(0), false);
});

test('플레이어가 1개면 다음 곡 cue를 생략(공개 중인 영상 보존)', () => {
  const env = setup({ playerCount: 1 });
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.reveal({ roundId: 1, nextVideoId: 'vid00000002' });
  assert.ok(!env.players[0].callNames().includes('cue'));
});

test('다음 prepare는 다른 플레이어를 쓰고 이전 소리를 끊는다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.reveal({ roundId: 1, nextVideoId: 'vid00000002' });
  env.playback.prepare(prepareMsg({ roundId: 2, videoId: 'vid00000002', segmentStart: 10 }));
  assert.equal(env.playback.active, 1);
  assert.ok(env.players[0].callNames().filter((n) => n === 'pause').length >= 1);
  assert.deepEqual(env.players[1].calls.slice(-2), [['mute'], ['load', 'vid00000002', 10]]);
  assert.equal(env.playback.isPlayerVisible(0), false);
  assert.equal(env.playback.isPlayerVisible(1), false);
});

test('다른 roundId의 go·reveal은 무시', () => {
  const env = setup();
  env.playback.prepare(prepareMsg({ roundId: 7 }));
  reachStart(env);
  env.playback.go({ roundId: 6, startAt: env.clock.serverNow() });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.READY);
  env.playback.reveal({ roundId: 6 });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.READY);
  assert.ok(!env.players[0].callNames().includes('unMute'));
});

test('새 prepare가 이전 라운드의 예약된 go를 취소', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() + 3000 });
  env.playback.prepare(prepareMsg({ roundId: 2 }));
  env.timers.advance(5000);
  assert.ok(!env.players[0].callNames().includes('unMute'));
  assert.ok(!env.players[1].callNames().includes('unMute'));
});

test('재생 오류: playerError 보고, 영상은 보이지 않음', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  env.players[0].emitError(150);
  assert.deepEqual(env.sent, [{ type: 'playerError', roundId: 1, code: 150 }]);
  assert.equal(env.playback.stage, PLAYBACK_STAGE.ERROR);
  env.playback.reveal({ roundId: 1 });
  assert.equal(env.playback.isPlayerVisible(0), false);
  assert.ok(!env.players[0].callNames().includes('unMute'));
});

test('미리 cue한 플레이어의 오류는 보고하지 않는다', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.reveal({ roundId: 1, nextVideoId: 'vid00000002' });
  env.players[1].emitError(101);
  assert.ok(!env.sent.some((m) => m.type === 'playerError'));
});

test('stop: 모두 멈추고 대기 상태로', () => {
  const env = setup();
  env.playback.prepare(prepareMsg());
  reachStart(env);
  env.playback.stop();
  assert.equal(env.playback.stage, PLAYBACK_STAGE.IDLE);
  assert.ok(env.players.every((p) => p.callNames().includes('pause')));
  env.playback.go({ roundId: 1, startAt: env.clock.serverNow() });
  assert.equal(env.playback.stage, PLAYBACK_STAGE.IDLE);
});
