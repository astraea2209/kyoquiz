// Room을 소켓에 연결하는 계층. 실행 환경(Cloudflare Durable Object, Node 등)과 무관하다.
// 소켓은 {send(string), close(code, reason)} 모양이면 된다. 환경 쪽 코드는
//   const connId = host.connect(socket);  host.message(connId, data);  host.disconnect(connId);
// 세 가지만 부르면 된다. 여기서 하는 일: JSON 파싱, 메시지 크기·빈도 제한, 입장하지 않은 연결 정리,
// 빈 방 정리, 방이 닫힐 때 소켓 닫기.

import { Room } from './room.js';

export const HOST_LIMITS = Object.freeze({
  maxMessageBytes: 2048,
  burstCount: 40, // burstWindowMs 안에 이 개수를 넘으면 연결을 끊는다
  burstWindowMs: 5000,
  joinTimeoutMs: 10_000, // 연결한 뒤 join을 보내야 하는 시간
  emptyRoomMs: 60_000, // 만든 뒤 아무도 입장하지 않으면 방을 닫는 시간
});

const WS_POLICY_VIOLATION = 1008;
const WS_TOO_BIG = 1009;
const WS_NORMAL = 1000;

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class RoomHost {
  /**
   * @param {object} opts  Room 옵션(code, songs, now, rng, timers, genToken, config)과 같다
   * @param {(host: RoomHost) => void} [opts.onClose]  방이 닫혔을 때(저장소 정리용)
   * @param {object} [opts.limits]  HOST_LIMITS 덮어쓰기
   */
  constructor({ onClose = null, limits = {}, timers = defaultTimers, now = () => Date.now(), ...roomOptions }) {
    this.limits = { ...HOST_LIMITS, ...limits };
    this.timers = timers;
    this.now = now;
    this.onClose = onClose;
    this.sockets = new Map(); // connId → {socket, joinTimer, stamps}
    this.nextConn = 1;
    this.closed = false;
    this.encoder = new TextEncoder();

    this.room = new Room({
      ...roomOptions,
      now,
      timers,
      send: (connId, message) => this.deliver(connId, message),
      onClose: () => this.handleRoomClosed(),
    });
    this.code = this.room.code;
    this.emptyTimer = timers.setTimeout(() => {
      this.emptyTimer = null;
      if (this.room.members.length === 0) this.room.close();
    }, this.limits.emptyRoomMs);
  }

  /** 새 소켓을 받는다. connId를 돌려준다 */
  connect(socket) {
    if (this.closed) {
      socket.close(WS_NORMAL, 'room-closed');
      return null;
    }
    const connId = `c${this.nextConn++}`;
    const entry = { socket, joinTimer: null, stamps: [] };
    entry.joinTimer = this.timers.setTimeout(() => {
      entry.joinTimer = null;
      if (!this.room.playerByConn(connId)) this.kick(connId, WS_POLICY_VIOLATION, 'join-timeout');
    }, this.limits.joinTimeoutMs);
    this.sockets.set(connId, entry);
    return connId;
  }

  /** 소켓에서 온 데이터(문자열)를 처리한다. 잘못된 데이터는 조용히 버린다 */
  message(connId, data) {
    const entry = this.sockets.get(connId);
    if (!entry || this.closed) return;
    if (typeof data !== 'string') return;
    if (this.encoder.encode(data).length > this.limits.maxMessageBytes) {
      this.kick(connId, WS_TOO_BIG, 'too-big');
      return;
    }
    const t = this.now();
    entry.stamps.push(t);
    while (entry.stamps.length && t - entry.stamps[0] >= this.limits.burstWindowMs) entry.stamps.shift();
    if (entry.stamps.length > this.limits.burstCount) {
      this.kick(connId, WS_POLICY_VIOLATION, 'rate-limit');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    try {
      this.room.handleMessage(connId, parsed);
    } catch (error) {
      // 한 메시지의 오류가 방 전체를 멈추게 하지 않는다
      console.error('room error', this.code, error);
    }
  }

  /** 소켓이 닫혔거나 오류가 났을 때 */
  disconnect(connId) {
    const entry = this.sockets.get(connId);
    if (!entry) return;
    this.sockets.delete(connId);
    if (entry.joinTimer != null) this.timers.clearTimeout(entry.joinTimer);
    if (!this.closed) this.room.handleDisconnect(connId);
  }

  kick(connId, code, reason) {
    const entry = this.sockets.get(connId);
    if (!entry) return;
    try {
      entry.socket.close(code, reason);
    } catch {
      // 이미 닫힌 소켓
    }
    this.disconnect(connId);
  }

  deliver(connId, message) {
    const entry = this.sockets.get(connId);
    if (!entry) return;
    try {
      entry.socket.send(JSON.stringify(message));
    } catch {
      // 전송 실패는 곧 disconnect로 이어진다
    }
  }

  handleRoomClosed() {
    if (this.closed) return;
    this.closed = true;
    if (this.emptyTimer != null) this.timers.clearTimeout(this.emptyTimer);
    for (const [connId, entry] of [...this.sockets]) {
      if (entry.joinTimer != null) this.timers.clearTimeout(entry.joinTimer);
      try {
        entry.socket.close(WS_NORMAL, 'room-closed');
      } catch {
        // 이미 닫힌 소켓
      }
      this.sockets.delete(connId);
    }
    this.onClose?.(this);
  }

  /** 방이 아직 쓸 수 있는 상태인지 */
  get isOpen() {
    return !this.closed;
  }
}
