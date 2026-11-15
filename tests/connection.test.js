import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../js/online/net.js';
import { RoomConnection } from '../js/online/connection.js';
import {
  buildInviteLink,
  resolveServerUrl,
  roomCodeFromSearch,
  roomsUrl,
  webSocketUrl,
} from '../js/online/config.js';
import { createFakeTimers } from './fakeTimers.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.handlers = { open: [], message: [], close: [], error: [] };
  }
  addEventListener(type, fn) {
    this.handlers[type].push(fn);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  // --- 테스트 조작 ---
  fire(type, event = {}) {
    for (const fn of this.handlers[type]) fn(event);
  }
  open() {
    this.fire('open');
  }
  receive(message) {
    this.fire('message', { data: JSON.stringify(message) });
  }
  drop(code = 1006, reason = '') {
    this.fire('close', { code, reason });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

function setup(options = {}) {
  const timers = createFakeTimers();
  const clock = new ClockSync({ now: timers.now });
  const sockets = [];
  const conn = new RoomConnection({
    url: 'ws://x/ws?code=ABCDE',
    clock,
    scheduler: timers,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    ...options,
  });
  const messages = [];
  const statuses = [];
  conn.on('message', (m) => messages.push(m));
  conn.on('status', (s) => statuses.push(s.status + (s.reason ? `:${s.reason}` : '')));
  return { conn, timers, clock, sockets, messages, statuses };
}

test('연결: 열리면 닉네임으로 join을 보내고, joined에서 토큰을 보관', () => {
  const env = setup();
  env.conn.connect('민수');
  assert.equal(env.conn.status, 'connecting');
  env.sockets[0].open();
  assert.equal(env.conn.status, 'open');
  assert.deepEqual(env.sockets[0].sent[0], { type: 'join', nickname: '민수', token: null });
  env.sockets[0].receive({ type: 'joined', playerId: 'p1', token: 'tok', code: 'ABCDE', reconnected: false });
  assert.equal(env.conn.token, 'tok');
  assert.deepEqual(env.messages.map((m) => m.type), ['joined']);
});

test('저장된 토큰이 있으면 처음부터 그 토큰으로 join', () => {
  const env = setup();
  env.conn.connect('민수', 'saved-token');
  env.sockets[0].open();
  assert.equal(env.sockets[0].sent[0].token, 'saved-token');
});

test('send: 열려 있을 때만 전송', () => {
  const env = setup();
  assert.equal(env.conn.send({ type: 'x' }), false);
  env.conn.connect('a');
  assert.equal(env.conn.send({ type: 'x' }), false); // 아직 연결 중
  env.sockets[0].open();
  assert.equal(env.conn.send({ type: 'start' }), true);
  assert.equal(env.sockets[0].sent.at(-1).type, 'start');
});

test('끊기면 토큰으로 재접속(간격은 점점 늘어남)하고, 성공하면 간격 초기화', () => {
  const env = setup({ reconnectDelays: [500, 1000, 2000] });
  env.conn.connect('민수');
  env.sockets[0].open();
  env.sockets[0].receive({ type: 'joined', playerId: 'p1', token: 'tok', code: 'ABCDE' });
  env.sockets[0].drop();
  assert.equal(env.conn.status, 'reconnecting');
  env.timers.advance(499);
  assert.equal(env.sockets.length, 1);
  env.timers.advance(1);
  assert.equal(env.sockets.length, 2);
  env.sockets[1].drop(); // 두 번째 시도 실패 → 1000ms 뒤
  env.timers.advance(999);
  assert.equal(env.sockets.length, 2);
  env.timers.advance(1);
  assert.equal(env.sockets.length, 3);
  env.sockets[2].open();
  assert.deepEqual(env.sockets[2].sent[0], { type: 'join', nickname: '민수', token: 'tok' });
  assert.equal(env.conn.status, 'open');
  // 성공 뒤 다시 끊기면 다시 처음 간격
  env.sockets[2].drop();
  env.timers.advance(500);
  assert.equal(env.sockets.length, 4);
});

test('60초 안에 못 돌아오면 포기', () => {
  const env = setup({ reconnectDelays: [10_000], giveUpMs: 60_000 });
  env.conn.connect('민수');
  env.sockets[0].open();
  env.sockets[0].drop();
  for (let i = 0; i < 6; i++) {
    env.timers.advance(10_000);
    env.sockets.at(-1).drop();
  }
  assert.equal(env.conn.status, 'closed');
  assert.equal(env.conn.closeReason, 'gave-up');
  const count = env.sockets.length;
  env.timers.advance(100_000);
  assert.equal(env.sockets.length, count);
});

test('서버가 일부러 끊거나(1000, 1008) 치명적 오류면 재접속하지 않는다', () => {
  for (const [code, reason] of [[1000, 'room-closed'], [1008, 'rate-limit'], [1009, 'too-big']]) {
    const env = setup();
    env.conn.connect('a');
    env.sockets[0].open();
    env.sockets[0].drop(code, reason);
    assert.equal(env.conn.status, 'closed');
    assert.equal(env.conn.closeReason, reason);
    env.timers.advance(60_000);
    assert.equal(env.sockets.length, 1);
  }
  for (const errorCode of ['game-started', 'room-full', 'bad-nickname']) {
    const env = setup();
    env.conn.connect('a');
    env.sockets[0].open();
    env.sockets[0].receive({ type: 'error', code: errorCode, message: 'x' });
    assert.equal(env.conn.status, 'closed');
    assert.equal(env.conn.closeReason, errorCode);
    assert.deepEqual(env.messages.map((m) => m.code), [errorCode], '오류 메시지는 화면에도 전달');
    assert.ok(env.sockets[0].closed);
  }
});

test('치명적이지 않은 오류(not-host 등)는 연결을 유지', () => {
  const env = setup();
  env.conn.connect('a');
  env.sockets[0].open();
  env.sockets[0].receive({ type: 'error', code: 'not-host', message: 'x' });
  assert.equal(env.conn.status, 'open');
});

test('kicked(다른 탭에서 같은 토큰으로 입장)면 닫고 재접속하지 않는다', () => {
  const env = setup();
  env.conn.connect('a');
  env.sockets[0].open();
  env.sockets[0].receive({ type: 'kicked', reason: 'replaced' });
  assert.equal(env.conn.status, 'closed');
  assert.equal(env.conn.closeReason, 'kicked');
});

test('close(): 사용자가 나가면 재접속하지 않는다', () => {
  const env = setup();
  env.conn.connect('a');
  env.sockets[0].open();
  env.conn.close();
  assert.equal(env.conn.status, 'closed');
  assert.equal(env.conn.closeReason, 'left');
  env.timers.advance(100_000);
  assert.equal(env.sockets.length, 1);
  assert.equal(env.timers.pending(), 0);
});

test('연결을 만들다 예외가 나도 재시도한다', () => {
  let calls = 0;
  const env = setup({
    createSocket: () => {
      calls++;
      if (calls === 1) throw new Error('blocked');
      return new FakeSocket('x');
    },
  });
  env.conn.connect('a');
  assert.equal(env.conn.status, 'reconnecting');
  env.timers.advance(500);
  assert.equal(calls, 2);
});

test('ping/pong으로 시계 차이를 맞춘다(연결 직후 빠르게, 이후 주기적으로)', () => {
  const env = setup({ pingIntervalMs: 5000 });
  env.conn.connect('a');
  const socket = env.sockets[0];
  socket.open();
  env.timers.advance(0);
  assert.equal(socket.sent.filter((m) => m.type === 'ping').length, 1);
  env.timers.advance(700);
  assert.equal(socket.sent.filter((m) => m.type === 'ping').length, 3);
  env.timers.advance(5000);
  assert.equal(socket.sent.filter((m) => m.type === 'ping').length, 4);

  // 서버 시각이 클라이언트보다 5000ms 빠르다(왕복이 대칭이라 서버가 찍은 시각 = 왕복의 한가운데)
  const ping = socket.sent.filter((m) => m.type === 'ping').at(-1);
  env.timers.advance(40);
  socket.receive({ type: 'pong', clientTime: ping.clientTime, serverTime: (ping.clientTime + env.timers.now()) / 2 + 5000 });
  assert.equal(env.clock.synced, true);
  assert.equal(env.clock.offset, 5000);
  assert.deepEqual(env.messages, [], 'pong은 화면으로 전달하지 않는다');
});

test('끊긴 뒤에는 ping을 멈추고, 연결이 낡은 소켓의 이벤트는 무시', () => {
  const env = setup();
  env.conn.connect('a');
  env.sockets[0].open();
  env.sockets[0].drop();
  const before = env.sockets[0].sent.length;
  env.timers.advance(3000);
  assert.equal(env.sockets[0].sent.length, before);
  env.sockets[0].receive({ type: 'state' }); // 이미 버린 소켓
  assert.deepEqual(env.messages, []);
});

test('설정: 서버 주소 우선순위', () => {
  const storage = { getItem: (k) => (k === 'asq.server' ? 'https://saved.example/' : null) };
  assert.equal(resolveServerUrl({ search: '?server=https://q.example/', hostname: 'localhost', storage }), 'https://q.example');
  assert.equal(resolveServerUrl({ search: '', hostname: 'localhost', storage }), 'https://saved.example');
  assert.equal(resolveServerUrl({ search: '', hostname: 'localhost' }), 'http://localhost:8787');
  assert.equal(resolveServerUrl({ search: '', hostname: '127.0.0.1' }), 'http://127.0.0.1:8787');
  assert.equal(resolveServerUrl({ search: '', hostname: 'quiz.example.com' }), '');
});

test('설정: URL 만들기', () => {
  assert.equal(roomsUrl('http://localhost:8787/'), 'http://localhost:8787/api/rooms');
  assert.equal(webSocketUrl('http://localhost:8787', 'ABCDE'), 'ws://localhost:8787/ws?code=ABCDE');
  assert.equal(webSocketUrl('https://a.workers.dev/', 'AB CD'), 'wss://a.workers.dev/ws?code=AB%20CD');
  assert.equal(
    buildInviteLink({ origin: 'http://localhost:8000', pathname: '/', search: '' }, 'ABCDE'),
    'http://localhost:8000/?room=ABCDE',
  );
  assert.equal(
    buildInviteLink({ origin: 'https://q.example', pathname: '/game/', search: '?server=https%3A%2F%2Fs.example&x=1' }, 'ABCDE'),
    'https://q.example/game/?room=ABCDE&server=https%3A%2F%2Fs.example',
  );
});

test('설정: 주소의 방 코드', () => {
  assert.equal(roomCodeFromSearch('?room=abcde'), 'ABCDE');
  assert.equal(roomCodeFromSearch('?room=ABCD0'), null);
  assert.equal(roomCodeFromSearch('?room=ABC'), null);
  assert.equal(roomCodeFromSearch(''), null);
});
