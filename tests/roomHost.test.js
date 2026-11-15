// 소켓 호스트 계층: JSON 처리, 크기·빈도 제한, 입장 시간 제한, 빈 방 정리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomHost } from '../server/roomHost.js';
import { createFakeTimers } from './fakeTimers.js';
import { makeSong, seededRng } from './helpers.js';

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  last(type) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function setup(limits = {}) {
  const timers = createFakeTimers();
  const closed = [];
  let seq = 0;
  const host = new RoomHost({
    code: 'ABCDE',
    songs: Array.from({ length: 5 }, (_, i) => makeSong(i + 1, { duration: 200 })),
    now: timers.now,
    rng: seededRng(5),
    timers,
    genToken: () => `tok${++seq}`,
    onClose: (h) => closed.push(h.code),
    limits,
  });
  const open = () => {
    const socket = new FakeSocket();
    const id = host.connect(socket);
    return { socket, id };
  };
  const join = (conn, nickname) => host.message(conn.id, JSON.stringify({ type: 'join', nickname }));
  return { host, timers, closed, open, join };
}

test('연결 → join → joined·state를 JSON 문자열로 받는다', () => {
  const env = setup();
  const a = env.open();
  env.join(a, '민수');
  assert.equal(a.socket.last('joined').playerId, 'p1');
  assert.equal(a.socket.last('state').players[0].nickname, '민수');
});

test('ping/pong은 입장 전에도 된다', () => {
  const env = setup();
  const a = env.open();
  env.host.message(a.id, JSON.stringify({ type: 'ping', clientTime: 5 }));
  assert.deepEqual(a.socket.last('pong'), { type: 'pong', clientTime: 5, serverTime: env.timers.now() });
});

test('잘못된 JSON·배열·문자열이 아닌 데이터는 조용히 무시', () => {
  const env = setup();
  const a = env.open();
  env.host.message(a.id, '{broken');
  env.host.message(a.id, '[1,2]');
  env.host.message(a.id, '"text"');
  env.host.message(a.id, 'null');
  env.host.message(a.id, new Uint8Array([1, 2, 3]));
  env.host.message('c999', JSON.stringify({ type: 'join', nickname: 'x' }));
  assert.equal(a.socket.sent.length, 0);
  assert.equal(a.socket.closed, null);
});

test('너무 큰 메시지는 연결을 끊는다', () => {
  const env = setup();
  const a = env.open();
  env.host.message(a.id, JSON.stringify({ type: 'join', nickname: 'x'.repeat(5000) }));
  assert.deepEqual(a.socket.closed, { code: 1009, reason: 'too-big' });
});

test('메시지 빈도 제한: 창 안에서 한도를 넘으면 끊고, 시간이 지나면 다시 센다', () => {
  const env = setup({ burstCount: 5, burstWindowMs: 1000 });
  const a = env.open();
  env.join(a, '민수');
  for (let i = 0; i < 4; i++) env.host.message(a.id, JSON.stringify({ type: 'ping' }));
  assert.equal(a.socket.closed, null); // 5개째까지 허용
  env.timers.advance(1000);
  for (let i = 0; i < 5; i++) env.host.message(a.id, JSON.stringify({ type: 'ping' }));
  assert.equal(a.socket.closed, null);
  env.host.message(a.id, JSON.stringify({ type: 'ping' }));
  assert.deepEqual(a.socket.closed, { code: 1008, reason: 'rate-limit' });
  // 끊긴 연결은 방에서도 끊김 처리
  assert.equal(env.host.room.snapshot().players[0].connected, false);
});

test('연결만 하고 join하지 않으면 10초 뒤 끊는다', () => {
  const env = setup();
  const lurker = env.open();
  const a = env.open();
  env.join(a, '민수');
  env.timers.advance(9999);
  assert.equal(lurker.socket.closed, null);
  env.timers.advance(1);
  assert.deepEqual(lurker.socket.closed, { code: 1008, reason: 'join-timeout' });
  assert.equal(a.socket.closed, null);
});

test('소켓이 끊기면 방에 끊김으로 전달되고 재접속 토큰으로 돌아올 수 있다', () => {
  const env = setup();
  const a = env.open();
  env.join(a, '민수');
  const b = env.open();
  env.join(b, '지연');
  const token = b.socket.last('joined').token;
  env.host.disconnect(b.id);
  assert.equal(a.socket.last('state').players[1].connected, false);

  const b2 = env.open();
  env.host.message(b2.id, JSON.stringify({ type: 'join', nickname: '지연', token }));
  assert.equal(b2.socket.last('joined').reconnected, true);
  assert.equal(a.socket.last('state').players[1].connected, true);
});

test('아무도 입장하지 않으면 60초 뒤 방을 닫고 소켓도 닫는다', () => {
  const env = setup();
  const lurker = env.open();
  env.timers.advance(59_999);
  assert.deepEqual(env.closed, []);
  env.timers.advance(1);
  assert.deepEqual(env.closed, ['ABCDE']);
  assert.equal(env.host.isOpen, false);
  assert.ok(lurker.socket.closed);
  // 닫힌 방에는 새 연결을 받지 않는다
  const late = new FakeSocket();
  assert.equal(env.host.connect(late), null);
  assert.deepEqual(late.closed, { code: 1000, reason: 'room-closed' });
});

test('입장한 사람이 있으면 빈 방 타이머는 방을 닫지 않는다', () => {
  const env = setup();
  const a = env.open();
  env.join(a, '민수');
  env.timers.advance(120_000);
  assert.deepEqual(env.closed, []);
  assert.equal(a.socket.closed, null);
});

test('전원이 나가 방이 닫히면 onClose와 소켓 정리, 남은 타이머 없음', () => {
  const env = setup();
  const a = env.open();
  env.join(a, '민수');
  env.host.message(a.id, JSON.stringify({ type: 'leave' }));
  assert.deepEqual(env.closed, ['ABCDE']);
  assert.deepEqual(a.socket.closed, { code: 1000, reason: 'room-closed' });
  assert.equal(env.timers.pending(), 0);
});

test('한 메시지에서 예외가 나도 방은 계속 동작한다', () => {
  const env = setup();
  const a = env.open();
  env.join(a, '민수');
  const original = env.host.room.handleMessage;
  env.host.room.handleMessage = () => {
    throw new Error('boom');
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    env.host.message(a.id, JSON.stringify({ type: 'ping' }));
  } finally {
    console.error = quiet;
  }
  env.host.room.handleMessage = original;
  env.host.message(a.id, JSON.stringify({ type: 'ping', clientTime: 1 }));
  assert.equal(a.socket.last('pong').clientTime, 1);
});
