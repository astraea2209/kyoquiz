// 친구와 대결 채팅 이모지(그림 스티커): 목록(stickers.js), 방(onChat), 클라이언트 상태(OnlineSession)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { STICKERS, isSticker, stickerById } from '../js/online/stickers.js';
import { OnlineSession } from '../js/online/session.js';
import { createEnv } from './roomHelpers.js';

test('STICKERS: id는 겹치지 않고 그림 파일이 저장소에 있다', () => {
  assert.ok(STICKERS.length >= 2);
  assert.equal(new Set(STICKERS.map((s) => s.id)).size, STICKERS.length);
  for (const s of STICKERS) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.label, `${s.id} 이름`);
    assert.ok(existsSync(new URL(`../${s.src}`, import.meta.url)), `${s.src} 파일`);
  }
  assert.equal(isSticker('question'), true);
  assert.equal(isSticker('nope'), false);
  assert.equal(isSticker(undefined), false);
  assert.equal(stickerById('angry').label, '빡침');
  assert.equal(stickerById('nope'), null);
});

test('채팅 이모지: 모두에게 sticker로 전달되고 글은 비어 있다, 최근 채팅에도 남는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'chat', sticker: 'question', text: '같이 온 글은 무시' });
  const got = env.last('b', 'chat');
  assert.equal(got.sticker, 'question');
  assert.equal(got.text, '');
  assert.equal(got.nickname, 'a');
  env.join('c', 'c');
  assert.equal(env.last('c', 'chatLog').messages[0].sticker, 'question');
});

test('채팅 이모지: 목록에 없는 id는 무시(글이 있어도 보내지 않음)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'chat', sticker: '../evil.png', text: '안녕' });
  env.send('a', { type: 'chat', sticker: { id: 'question' } });
  assert.equal(env.msgs('b', 'chat').length, 0);
  assert.equal(env.msgs('a', 'chatBlocked').length, 0);
});

test('채팅 이모지: 라운드 중에도 보낼 수 있고, 채팅과 같은 간격 제한을 받는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  env.send('a', { type: 'chat', sticker: 'angry' });
  assert.equal(env.last('b', 'chat').sticker, 'angry');
  env.send('a', { type: 'chat', text: '빠르다' });
  assert.equal(env.last('a', 'chatBlocked').reason, 'rate');
  assert.equal(env.msgs('b', 'chat').length, 1);
});

function sessionSetup() {
  let now = 100_000;
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
    close: () => {},
  };
  const playback = { handleMessage: () => {}, stop: () => {} };
  const session = new OnlineSession({ connection, playback, clock: { serverNow: () => now } });
  return {
    session,
    sent,
    receive: (m) => [...handlers.message].forEach((fn) => fn(m)),
    advance: (ms) => {
      now += ms;
    },
  };
}

test('세션 sendSticker: 목록의 id만 보내고 채팅과 간격 제한을 같이 쓴다', () => {
  const env = sessionSetup();
  assert.equal(env.session.sendSticker('nope'), 'invalid');
  assert.equal(env.sent.length, 0);
  assert.equal(env.session.sendSticker('question'), 'sent');
  assert.deepEqual(env.sent.at(-1), { type: 'chat', sticker: 'question' });
  assert.equal(env.session.sendChat('바로'), 'rate');
  assert.equal(env.session.sendSticker('angry'), 'rate');
  env.advance(500);
  assert.equal(env.session.sendSticker('angry'), 'sent');
});

test('세션 채팅 수신: 이모지는 sticker로 기록, 모르는 이모지만 있는 채팅은 건너뜀', () => {
  const env = sessionSetup();
  env.receive({ type: 'chat', id: 1, playerId: 'p1', nickname: 'a', text: '', sticker: 'angry', at: 0 });
  env.receive({ type: 'chat', id: 2, playerId: 'p1', nickname: 'a', text: '', sticker: 'future-sticker', at: 1 });
  env.receive({ type: 'chat', id: 3, playerId: 'p1', nickname: 'a', text: '글', at: 2 });
  assert.deepEqual(
    env.session.chat.map((m) => [m.id, m.text, m.sticker]),
    [
      [1, '', 'angry'],
      [3, '글', null],
    ],
  );
});
