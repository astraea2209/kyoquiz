// WebSocket 연결·재접속. 브라우저의 WebSocket과 타이머는 주입받는다(테스트에서는 가짜).
// 프로토콜 중 이 파일이 아는 것은 join(닉네임·재접속 토큰), joined(토큰 보관),
// ping/pong(시계 보정), 치명적 오류(재접속 중단)뿐이다. 나머지 메시지는 그대로 listener에게 넘긴다.

/** 재접속해도 소용없는 서버 오류: 방이 가득 참, 이미 시작함(토큰 만료 포함), 닉네임 문제 */
export const FATAL_ERROR_CODES = Object.freeze(['room-full', 'game-started', 'bad-nickname']);
/** 서버가 일부러 끊은 경우(정상 종료, 정책 위반, 너무 큰 메시지)는 재접속하지 않는다 */
const NO_RECONNECT_CLOSE_CODES = Object.freeze([1000, 1008, 1009]);

const defaultScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

export class RoomConnection {
  /**
   * @param {object} opts
   * @param {string} opts.url  ws(s)://…/ws?code=ABCDE
   * @param {ClockSync} opts.clock  js/online/net.js의 ClockSync
   * @param {(url: string) => WebSocket} [opts.createSocket]
   * @param {object} [opts.scheduler]  {setTimeout, clearTimeout, setInterval, clearInterval}
   * @param {number[]} [opts.reconnectDelays]  재시도 간격(ms). 마지막 값을 계속 쓴다
   * @param {number} [opts.giveUpMs]  이 시간 동안 못 돌아오면 포기(서버의 재접속 유예 60초와 맞춤)
   * @param {number} [opts.pingIntervalMs]
   */
  constructor({
    url,
    clock,
    createSocket = (u) => new WebSocket(u),
    scheduler = defaultScheduler,
    reconnectDelays = [500, 1000, 2000, 4000],
    giveUpMs = 60_000,
    pingIntervalMs = 5000,
  }) {
    this.url = url;
    this.clock = clock;
    this.createSocket = createSocket;
    this.scheduler = scheduler;
    this.reconnectDelays = reconnectDelays;
    this.giveUpMs = giveUpMs;
    this.pingIntervalMs = pingIntervalMs;

    this.status = 'idle'; // idle → connecting → open → reconnecting → closed
    this.closeReason = null;
    this.nickname = '';
    this.token = null;
    this.socket = null;
    this.attempt = 0;
    this.downSince = null;
    this.retryTimer = null;
    this.pingTimer = null;
    this.warmupTimers = [];
    this.explicitClose = false;
    this.listeners = { message: new Set(), status: new Set() };
  }

  on(type, fn) {
    this.listeners[type].add(fn);
    return () => this.listeners[type].delete(fn);
  }

  emit(type, payload) {
    for (const fn of [...this.listeners[type]]) fn(payload);
  }

  setStatus(status, reason = null) {
    if (this.status === status && this.closeReason === reason) return;
    this.status = status;
    this.closeReason = reason;
    this.emit('status', { status, reason });
  }

  /** 처음 연결. token을 주면(새로고침 뒤 복귀 등) 재접속으로 입장한다 */
  connect(nickname, token = null) {
    this.nickname = nickname;
    this.token = token;
    this.explicitClose = false;
    this.attempt = 0;
    this.downSince = null;
    this.open('connecting');
  }

  open(status) {
    this.setStatus(status);
    let socket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.handleClose({ code: 1006 });
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.downSince = null;
      this.setStatus('open');
      this.rawSend({ type: 'join', nickname: this.nickname, token: this.token });
      this.startPings();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.handleData(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.handleClose(event);
    });
    socket.addEventListener('error', () => {}); // 오류 뒤에는 항상 close가 온다
  }

  handleData(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'pong') {
      if (Number.isFinite(message.clientTime)) this.clock.addPong({ sentAt: message.clientTime }, message.serverTime);
      return;
    }
    if (message.type === 'joined') this.token = message.token;
    this.emit('message', message);
    if (message.type === 'kicked') this.finish('kicked');
    else if (message.type === 'error' && FATAL_ERROR_CODES.includes(message.code)) this.finish(message.code);
  }

  handleClose(event) {
    this.stopPings();
    this.socket = null;
    if (this.explicitClose || this.status === 'closed') return;
    if (NO_RECONNECT_CLOSE_CODES.includes(event?.code)) {
      this.finish(event.reason || `close-${event.code}`);
      return;
    }
    const now = this.clock.localNow();
    if (this.downSince == null) this.downSince = now;
    if (now - this.downSince >= this.giveUpMs) {
      this.finish('gave-up');
      return;
    }
    this.setStatus('reconnecting');
    const delay = this.reconnectDelays[Math.min(this.attempt, this.reconnectDelays.length - 1)];
    this.attempt++;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      if (!this.explicitClose && this.status === 'reconnecting') this.open('reconnecting');
    }, delay);
  }

  /** 더 이상 재접속하지 않고 닫는다 */
  finish(reason) {
    this.stopPings();
    if (this.retryTimer != null) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // 이미 닫힌 소켓
    }
    this.setStatus('closed', reason);
  }

  /** 사용자가 나갈 때 */
  close() {
    this.explicitClose = true;
    this.finish('left');
  }

  /** 열려 있을 때만 보낸다. 보냈으면 true */
  send(message) {
    if (this.status !== 'open') return false;
    return this.rawSend(message);
  }

  rawSend(message) {
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // 시계 보정: 연결 직후 빠르게 몇 번, 이후 주기적으로 ping
  startPings() {
    this.stopPings();
    const ping = () => this.send({ type: 'ping', clientTime: this.clock.localNow() });
    for (const ms of [0, 300, 700]) this.warmupTimers.push(this.scheduler.setTimeout(ping, ms));
    this.pingTimer = this.scheduler.setInterval(ping, this.pingIntervalMs);
  }

  stopPings() {
    for (const id of this.warmupTimers) this.scheduler.clearTimeout(id);
    this.warmupTimers = [];
    if (this.pingTimer != null) this.scheduler.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
