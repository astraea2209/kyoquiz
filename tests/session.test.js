import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../js/online/session.js';

function setup() {
  let now = 100_000;
  const clock = { serverNow: () => now };
  const sent = [];
  const handlers = { message: new Set(), status: new Set() };
  const connection = {
    on: (type, fn) => {
      handlers[type].add(fn);
      return () => handlers[type].delete(fn);
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
    close: () => sent.push({ type: '__close' }),
  };
  const playbackCalls = [];
  const playback = {
    handleMessage: (m) => playbackCalls.push(m.type),
    stop: () => playbackCalls.push('stop'),
  };
  const session = new OnlineSession({ connection, playback, clock });
  const events = { notice: [], error: [], change: 0 };
  session.on('notice', (m) => events.notice.push(m));
  session.on('error', (m) => events.error.push(m));
  session.on('change', () => events.change++);
  return {
    session,
    sent,
    playbackCalls,
    events,
    receive: (m) => [...handlers.message].forEach((fn) => fn(m)),
    setNow: (t) => {
      now = t;
    },
    now: () => now,
  };
}

const player = (id, extra = {}) => ({ id, nickname: id, score: 0, correct: 0, connected: true, left: false, isHost: false, status: null, ...extra });
const roomState = (phase, players, extra = {}) => ({
  type: 'state',
  code: 'ABCDE',
  phase,
  hostId: 'p1',
  settings: { mode: 'random', rounds: 10, clipLength: 5, difficulty: 'normal', answerTime: 15 },
  players,
  round: null,
  ...extra,
});

function inRound(env, { choices = null, myStatus = 'ready', now = 100_000 } = {}) {
  env.receive({ type: 'joined', code: 'ABCDE', playerId: 'p2', token: 't' });
  env.receive({ type: 'prepare', roundId: 3, index: 0, total: 5, mode: 'random', videoId: 'v', segmentStart: 10, clipLength: 5, answerWindow: 20, choices });
  env.receive(roomState('starting', [player('p1', { status: 'ready' }), player('p2', { status: myStatus })]));
  env.receive({ type: 'go', roundId: 3, startAt: now + 3000, deadlineAt: now + 23_000 });
}

test('joined·state로 내 정보와 방장 여부', () => {
  const env = setup();
  env.receive({ type: 'joined', code: 'ABCDE', playerId: 'p2', token: 't' });
  env.receive(roomState('lobby', [player('p1', { isHost: true }), player('p2')]));
  assert.equal(env.session.you, 'p2');
  assert.equal(env.session.isHost, false);
  assert.equal(env.session.me.id, 'p2');
  assert.equal(env.session.phase, 'lobby');
  assert.ok(env.events.change >= 2);
});

test('prepare·go·reveal은 재생 제어에 전달하고 라운드 상태를 갱신', () => {
  const env = setup();
  inRound(env);
  assert.deepEqual(env.playbackCalls, ['prepare', 'go']);
  assert.equal(env.session.round.roundId, 3);
  assert.equal(env.session.go.roundId, 3);
  env.receive({ type: 'reveal', roundId: 3, correctPlayers: [{ playerId: 'p1' }], song: { title: 'T' } });
  assert.equal(env.session.reveal.correctPlayers[0].playerId, 'p1');
  assert.deepEqual(env.playbackCalls, ['prepare', 'go', 'reveal']);
});

test('새 prepare는 이전 라운드의 잠금·기회·공개를 초기화', () => {
  const env = setup();
  inRound(env);
  env.receive({ type: 'locked', roundId: 3, playerId: 'p1', reason: 'pass' });
  env.receive({ type: 'answerResult', roundId: 3, correct: false, attemptsLeft: 1 });
  env.receive({ type: 'reveal', roundId: 3, correctPlayers: [] });
  assert.ok(env.session.lockedIds.has('p1'));
  assert.equal(env.session.attemptsLeft, 1);
  env.receive({ type: 'prepare', roundId: 4, index: 1, total: 5, mode: 'random', videoId: 'w', segmentStart: 1, clipLength: 5, choices: null });
  assert.equal(env.session.lockedIds.size, 0);
  assert.equal(env.session.attemptsLeft, 3);
  assert.equal(env.session.reveal, null);
  assert.equal(env.session.go, null);
  assert.equal(env.session.feedback, null);
});

test('다른 라운드의 locked·answerResult·reveal은 무시', () => {
  const env = setup();
  inRound(env);
  env.receive({ type: 'locked', roundId: 2, playerId: 'p1', reason: 'pass' });
  env.receive({ type: 'answerResult', roundId: 2, correct: false, attemptsLeft: 0 });
  env.receive({ type: 'reveal', roundId: 2, correctPlayers: [] });
  assert.equal(env.session.lockedIds.size, 0);
  assert.equal(env.session.attemptsLeft, 3);
  assert.equal(env.session.reveal, null);
});

test('canAnswer: 시작 신호 시각 전·공개 뒤·잠긴 뒤에는 불가', () => {
  const env = setup();
  inRound(env);
  assert.equal(env.session.canAnswer, false); // 카운트다운 중
  assert.equal(env.session.countdownSeconds(), 3);
  env.setNow(101_500);
  assert.equal(env.session.countdownSeconds(), 2);
  env.setNow(103_000);
  assert.equal(env.session.canAnswer, true);
  assert.equal(env.session.countdownSeconds(), null);

  env.receive(roomState('answering', [player('p1', { status: 'ready' }), player('p2', { status: 'exhausted' })]));
  assert.equal(env.session.canAnswer, false);
  env.receive(roomState('answering', [player('p1', { status: 'ready' }), player('p2', { status: 'ready' })]));
  assert.equal(env.session.canAnswer, true);
  env.receive({ type: 'reveal', roundId: 3, correctPlayers: [] });
  assert.equal(env.session.canAnswer, false);
});

test('내 정답: 점수·시간을 보관하고 더는 답할 수 없다, 다음 라운드에 초기화', () => {
  const env = setup();
  inRound(env);
  env.setNow(104_000);
  assert.equal(env.session.submitText('정답'), true);
  env.receive({ type: 'answerResult', roundId: 3, correct: true, points: 140, elapsed: 4, order: 1 });
  assert.deepEqual(env.session.myCorrect, { points: 140, elapsed: 4, order: 1 });
  assert.equal(env.session.feedback, 'correct');
  assert.equal(env.session.attemptsLeft, 3, '정답은 기회를 깎지 않는다');
  // state의 status가 아직 ready여도 다시 보내지 않는다
  assert.equal(env.session.canAnswer, false);
  assert.equal(env.session.submitText('또'), false);
  assert.equal(env.session.pass(), false);
  env.receive({ type: 'prepare', roundId: 4, index: 1, total: 5, mode: 'random', videoId: 'w', segmentStart: 1, clipLength: 5, choices: null });
  assert.equal(env.session.myCorrect, null);
});

test('다른 라운드의 정답 결과는 무시', () => {
  const env = setup();
  inRound(env);
  env.receive({ type: 'answerResult', roundId: 2, correct: true, points: 100, elapsed: 1, order: 1 });
  assert.equal(env.session.myCorrect, null);
});

test('제외된 사람(error/timeout/absent)은 답할 수 없다', () => {
  for (const status of ['error', 'timeout', 'absent', 'passed']) {
    const env = setup();
    inRound(env, { myStatus: status });
    env.setNow(104_000);
    assert.equal(env.session.canAnswer, false, status);
  }
});

test('주관식 제출: roundId와 함께 전송, 빈 답·시작 전은 전송하지 않는다', () => {
  const env = setup();
  inRound(env);
  assert.equal(env.session.submitText('답'), false); // 시작 전
  env.setNow(104_000);
  assert.equal(env.session.submitText('   '), false);
  assert.equal(env.session.submitText('  잔혹한 천사의 테제 '), true);
  assert.deepEqual(env.sent.at(-1), { type: 'answer', roundId: 3, text: '잔혹한 천사의 테제' });
  assert.equal(env.session.choose(0), false, '주관식에서 보기 선택은 불가');
});

test('객관식 선택: 틀린 보기는 다시 못 고르고, 패스 전송', () => {
  const env = setup();
  inRound(env, { choices: ['a', 'b', 'c', 'd'] });
  env.setNow(104_000);
  assert.equal(env.session.submitText('x'), false, '객관식에서 텍스트는 불가');
  assert.equal(env.session.choose(2), true);
  assert.deepEqual(env.sent.at(-1), { type: 'answer', roundId: 3, choice: 2 });
  env.receive({ type: 'answerResult', roundId: 3, correct: false, attemptsLeft: 2 });
  assert.deepEqual([...env.session.wrongChoices], [2]);
  assert.equal(env.session.feedback, 'wrong');
  const count = env.sent.length;
  assert.equal(env.session.choose(2), false);
  assert.equal(env.sent.length, count);
  assert.equal(env.session.pass(), true);
  assert.deepEqual(env.sent.at(-1), { type: 'pass', roundId: 3 });
});

test('rateLimited는 피드백으로 표시', () => {
  const env = setup();
  inRound(env);
  env.receive({ type: 'rateLimited', roundId: 3, retryAfterMs: 400 });
  assert.equal(env.session.feedback, 'rate');
});

test('남은 시간과 진행률: 시작 전에는 창 전체, 시작 뒤 줄어든다', () => {
  const env = setup();
  inRound(env);
  assert.equal(env.session.secondsLeft(), 20);
  assert.equal(env.session.windowProgress(), 0);
  env.setNow(103_000 + 5000);
  assert.equal(env.session.secondsLeft(), 15);
  assert.equal(env.session.windowProgress(), 0.25);
  env.setNow(200_000);
  assert.equal(env.session.secondsLeft(), 0);
  assert.equal(env.session.windowProgress(), 1);
});

test('준비 인원 집계', () => {
  const env = setup();
  env.receive(roomState('preparing', [player('p1', { status: 'ready' }), player('p2', { status: 'preparing' }), player('p3', { status: 'absent' })]));
  assert.deepEqual(env.session.readyCount(), { ready: 1, total: 2 });
});

test('설정·시작·나가기 전송, notice·error 이벤트', () => {
  const env = setup();
  env.session.setSettings({ rounds: 5 });
  env.session.start();
  assert.deepEqual(env.sent, [{ type: 'settings', settings: { rounds: 5 } }, { type: 'start' }]);
  env.receive({ type: 'notice', message: '곡을 바꿨습니다' });
  env.receive({ type: 'error', code: 'not-host', message: '방장만' });
  assert.deepEqual(env.events.notice, ['곡을 바꿨습니다']);
  assert.equal(env.events.error[0].code, 'not-host');
  env.session.leave();
  assert.deepEqual(env.sent.slice(-2), [{ type: 'leave' }, { type: '__close' }]);
  assert.equal(env.playbackCalls.at(-1), 'stop');
});

test('gameOver: 결과 보관하고 재생 정지, 로비로 돌아오면 라운드 초기화', () => {
  const env = setup();
  inRound(env);
  env.receive({ type: 'gameOver', reason: 'complete', ranking: [], history: [] });
  assert.equal(env.session.gameOver.reason, 'complete');
  assert.equal(env.playbackCalls.at(-1), 'stop');
  env.receive(roomState('lobby', [player('p1'), player('p2')]));
  assert.equal(env.session.round, null);
});
