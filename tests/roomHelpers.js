// 방 테스트용 환경: 가짜 시계·타이머 + 가짜 소켓(connId별 수신함).
import { Room } from '../server/room.js';
import { createFakeTimers } from './fakeTimers.js';
import { makeSong, seededRng } from './helpers.js';

export function createEnv({ songCount = 6, songs = null, config = {}, seed = 7, closed = [] } = {}) {
  const timers = createFakeTimers();
  const list = songs ?? Array.from({ length: songCount }, (_, i) => makeSong(i + 1, { duration: 200 }));
  const inbox = new Map(); // connId → message[]
  let tokenSeq = 0;
  const room = new Room({
    code: 'ABCDE',
    songs: list,
    send: (connId, message) => {
      if (!inbox.has(connId)) inbox.set(connId, []);
      inbox.get(connId).push(JSON.parse(JSON.stringify(message))); // 실제 전송처럼 직렬화 가능한 내용만
    },
    now: timers.now,
    rng: seededRng(seed),
    timers,
    genToken: () => `token-${++tokenSeq}`,
    onClose: (r) => closed.push(r.code),
    config,
  });

  const env = {
    room,
    timers,
    songs: list,
    closed,
    inbox,
    msgs: (conn, type) => (inbox.get(conn) ?? []).filter((m) => !type || m.type === type),
    last: (conn, type) => env.msgs(conn, type).at(-1),
    clear: () => inbox.clear(),
    send: (conn, message) => room.handleMessage(conn, message),
    join: (conn, nickname, token) => {
      room.handleMessage(conn, { type: 'join', nickname, token });
      return env.last(conn, 'joined');
    },
    /** 여러 명 입장. 첫 번째가 방장. connId = 닉네임 */
    joinAll: (...names) => names.map((n) => env.join(n, n)),
    state: () => room.snapshot(),
    ready: (conn) => room.handleMessage(conn, { type: 'ready', roundId: env.round().id }),
    readyAll: () => {
      for (const p of room.connectedMembers) {
        if (env.room.round.players.get(p.id)?.status === 'preparing') env.ready(p.connId);
      }
    },
    round: () => room.round,
    /** 이 방이 마지막으로 보낸 prepare */
    prepare: (conn) => env.last(conn, 'prepare'),
    songOf: (videoId) => list.find((s) => s.videoId === videoId),
    answer: (conn, text) => room.handleMessage(conn, { type: 'answer', roundId: env.round().id, text }),
    correctText: () => env.round().song.title,
    /** 아직 답할 수 있는(ready) 사람을 모두 패스시킨다 → 남은 사람이 없어 라운드 종료 */
    passRest: () => {
      for (const p of room.connectedMembers) {
        if (room.round?.players.get(p.id)?.status === 'ready') room.handleMessage(p.connId, { type: 'pass', roundId: room.round.id });
      }
    },
    /** reveal·history 기록의 정답자 닉네임(처리 순서) */
    correctNames: (record) => record.correctPlayers.map((c) => c.nickname),
    /** 시작 → 전원 ready → 시작 신호 시각 지남 */
    begin: () => {
      room.handleMessage(room.members[0].connId, { type: 'start' });
      env.readyAll();
      timers.advance(room.config.goLeadMs);
    },
  };
  return env;
}
