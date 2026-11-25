// 친구와 대결 채팅: 정답 유출 판정(revealsAnswer), 방 상태 머신(onChat), 클라이언트 상태(OnlineSession)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsAnswer } from '../js/judge.js';
import { OnlineSession } from '../js/online/session.js';
import { createEnv } from './roomHelpers.js';

const song = {
  title: '사이하테',
  titleAliases: ['사이 하테'],
  artist: '요네즈 켄시 & 리사',
  artistAliases: ['켄시'],
  anime: { name: '체인소 맨', aliases: ['체인소맨', 'Chainsaw Man'] },
};

test('revealsAnswer: 정답과 같거나 오타 범위 안이면 true', () => {
  assert.equal(revealsAnswer('사이하테', song), true);
  assert.equal(revealsAnswer('chainsaw  man!', song), true);
  assert.equal(revealsAnswer('Chainsow Man', song), true, '오타 허용');
});

test('revealsAnswer: 정답이 문장 안에 들어 있어도 true(제목·작품명·가수·별칭 모두)', () => {
  assert.equal(revealsAnswer('이거 사이하테 아님?', song), true);
  assert.equal(revealsAnswer('체인소맨 노래네', song), true);
  assert.equal(revealsAnswer('리사 목소리 같은데', song), true, '여러 가수 중 한 명');
  assert.equal(revealsAnswer('켄시 맞지', song), true, '가수 별칭');
});

test('revealsAnswer: 정답과 상관없는 채팅은 false', () => {
  assert.equal(revealsAnswer('어렵다 ㅋㅋ', song), false);
  assert.equal(revealsAnswer('들어 본 것 같은데', song), false);
  assert.equal(revealsAnswer('   ', song), false);
  assert.equal(revealsAnswer('하', { title: '하' }), true, '한 글자 정답은 완전히 같을 때만');
  assert.equal(revealsAnswer('하하하', { title: '하' }), false);
});

test('채팅: 대기실에서 모두에게 전달, 닉네임·순서 번호 포함', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'chat', text: '  안녕\n하세요  ' });
  const got = env.last('b', 'chat');
  assert.equal(got.text, '안녕 하세요', '공백 정리');
  assert.equal(got.nickname, 'a');
  assert.equal(got.playerId, 'p1');
  assert.equal(got.id, 1);
  assert.equal(env.last('a', 'chat').id, 1, '보낸 사람도 받는다');
});

test('채팅: 빈 글은 무시, 긴 글은 100자로 자름', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'chat', text: '   ' });
  env.send('a', { type: 'chat' });
  assert.equal(env.msgs('b', 'chat').length, 0);
  env.send('a', { type: 'chat', text: '가'.repeat(150) });
  assert.equal(Array.from(env.last('b', 'chat').text).length, 100);
});

test('채팅: 너무 빨리 보내면 보낸 사람에게만 chatBlocked(rate)', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'chat', text: '하나' });
  env.send('a', { type: 'chat', text: '둘' });
  assert.equal(env.msgs('b', 'chat').length, 1);
  assert.equal(env.last('a', 'chatBlocked').reason, 'rate');
  assert.equal(env.msgs('b', 'chatBlocked').length, 0);
  env.timers.advance(env.room.config.chatCooldownMs);
  env.send('a', { type: 'chat', text: '셋' });
  assert.equal(env.msgs('b', 'chat').length, 2);
});

test('채팅: 입장 전 연결은 보낼 수 없다', () => {
  const env = createEnv();
  env.join('a', 'a');
  env.send('x', { type: 'chat', text: '몰래' });
  assert.equal(env.last('x', 'error').code, 'not-joined');
  assert.equal(env.msgs('a', 'chat').length, 0);
});

test('채팅: 라운드 중(공개 전) 정답이 들어간 채팅은 막고, 공개 뒤에는 보낼 수 있다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.begin();
  const title = env.correctText();
  env.send('a', { type: 'chat', text: `${title} 같음` });
  assert.equal(env.last('a', 'chatBlocked').reason, 'answer');
  assert.equal(env.msgs('b', 'chat').length, 0, '다른 사람에게 가지 않는다');

  env.timers.advance(env.room.config.chatCooldownMs);
  env.send('a', { type: 'chat', text: '어렵다' });
  assert.equal(env.last('b', 'chat').text, '어렵다', '막힌 채팅은 쿨다운에 들어가지 않고, 다른 채팅은 된다');

  env.passRest();
  assert.equal(env.room.phase, 'revealed');
  env.timers.advance(env.room.config.chatCooldownMs);
  env.send('a', { type: 'chat', text: `${title} 같음` });
  assert.equal(env.last('b', 'chat').text, `${title} 같음`);
});

test('채팅: 준비 단계에서도 정답 채팅을 막는다', () => {
  const env = createEnv();
  env.joinAll('a', 'b');
  env.send('a', { type: 'start' });
  assert.equal(env.room.phase, 'preparing');
  env.send('b', { type: 'chat', text: env.round().song.anime.name });
  assert.equal(env.last('b', 'chatBlocked').reason, 'answer');
});

test('채팅: 새로 입장하거나 재접속하면 최근 채팅(chatLog)을 받는다', () => {
  const env = createEnv({ config: { chatLogSize: 3 } });
  const [joinedA] = env.joinAll('a', 'b');
  for (let i = 1; i <= 5; i++) {
    env.send('a', { type: 'chat', text: `메시지${i}` });
    env.timers.advance(env.room.config.chatCooldownMs);
  }
  env.join('c', 'c');
  assert.deepEqual(env.last('c', 'chatLog').messages.map((m) => m.text), ['메시지3', '메시지4', '메시지5']);

  env.room.handleDisconnect('a');
  env.join('a2', 'a', joinedA.token);
  assert.equal(env.last('a2', 'joined').reconnected, true);
  assert.equal(env.last('a2', 'chatLog').messages.length, 3);
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

test('세션 sendChat: 공백 정리, 빈 글·너무 빠른 전송은 보내지 않음', () => {
  const env = sessionSetup();
  assert.equal(env.session.sendChat('   '), 'empty');
  assert.equal(env.session.sendChat('  안녕   하세요 '), 'sent');
  assert.deepEqual(env.sent.at(-1), { type: 'chat', text: '안녕 하세요' });
  assert.equal(env.session.sendChat('또'), 'rate');
  assert.equal(env.sent.length, 1);
  env.advance(500);
  assert.equal(env.session.sendChat('또'), 'sent');
});

test('세션 채팅 수신: chat·chatLog를 id 순서로 합치고 중복은 건너뜀, 버전 증가', () => {
  const env = sessionSetup();
  const v0 = env.session.chatVersion;
  env.receive({ type: 'chat', id: 2, playerId: 'p1', nickname: 'a', text: '둘', at: 1 });
  env.receive({ type: 'chatLog', messages: [{ id: 1, playerId: 'p1', nickname: 'a', text: '하나', at: 0 }, { id: 2, playerId: 'p1', nickname: 'a', text: '둘', at: 1 }] });
  assert.deepEqual(env.session.chat.map((m) => m.text), ['하나', '둘']);
  assert.ok(env.session.chatVersion > v0);
  const v1 = env.session.chatVersion;
  env.receive({ type: 'chat', id: 2, playerId: 'p1', nickname: 'a', text: '둘', at: 1 });
  assert.equal(env.session.chatVersion, v1, '중복이면 다시 그리지 않는다');
});

test('세션 chatBlocked: 이유를 기록하고 다음 전송 때 지운다', () => {
  const env = sessionSetup();
  env.receive({ type: 'chatBlocked', reason: 'answer' });
  assert.equal(env.session.chatBlocked.reason, 'answer');
  env.session.sendChat('다른 말');
  assert.equal(env.session.chatBlocked, null);
});

test('playerColor: 입장 순서마다 다른 색(최대 8명 모두 다름), 모르는 형식은 첫 색', async () => {
  const { playerColor, PLAYER_COLORS } = await import('../js/online/session.js');
  const colors = Array.from({ length: 8 }, (_, i) => playerColor(`p${i + 1}`));
  assert.equal(new Set(colors).size, 8);
  assert.equal(playerColor('p1'), PLAYER_COLORS[0]);
  assert.equal(playerColor('p9'), PLAYER_COLORS[0], '9번째부터는 다시 처음 색');
  assert.equal(playerColor(null), PLAYER_COLORS[0]);
});
