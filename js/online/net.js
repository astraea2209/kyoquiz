// 온라인 대결의 시계 차이 계산(순수 함수). WebSocket 연결과 재접속은 어댑터 쪽에서 붙인다.
//
// 용어: offset = 서버 시각 − 클라이언트 시각 (ms). 서버 시각 = 클라이언트 시각 + offset.
// ping/pong 한 번: 클라이언트가 t0에 ping을 보내고, 서버가 serverTime을 찍어 pong으로 돌려주고,
// 클라이언트가 t2에 받는다. 왕복이 대칭이라고 가정하면 서버가 시각을 찍은 순간은 클라이언트 시계로 (t0+t2)/2.

/** 표본 하나: {offset, rtt} */
export function computeClockSample({ sentAt, serverTime, receivedAt }) {
  if (![sentAt, serverTime, receivedAt].every(Number.isFinite) || receivedAt < sentAt) return null;
  return {
    offset: serverTime - (sentAt + receivedAt) / 2,
    rtt: receivedAt - sentAt,
  };
}

/**
 * 여러 표본에서 offset을 고른다. 왕복이 짧은 표본일수록 오차가 작으므로
 * 왕복이 가장 짧은 표본 몇 개의 중앙값을 쓴다.
 */
export function estimateOffset(samples, { best = 3 } = {}) {
  const valid = samples.filter((s) => s && Number.isFinite(s.offset) && Number.isFinite(s.rtt));
  if (valid.length === 0) return null;
  const picked = valid.slice().sort((a, b) => a.rtt - b.rtt).slice(0, best);
  const offsets = picked.map((s) => s.offset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
}

/** 서버 시각(ms) → 클라이언트 시각(ms) */
export const serverToLocal = (serverTime, offset) => serverTime - offset;
/** 클라이언트 시각(ms) → 서버 시각(ms) */
export const localToServer = (localTime, offset) => localTime + offset;

/**
 * 표본을 모아 시계 차이를 유지한다. 최근 maxSamples개만 쓴다.
 * @param {{now?: () => number, maxSamples?: number}} opts now: 클라이언트 시계(ms)
 */
export class ClockSync {
  constructor({ now = () => Date.now(), maxSamples = 10 } = {}) {
    this.localNow = now;
    this.maxSamples = maxSamples;
    this.samples = [];
    this.offset = 0;
    this.synced = false;
  }

  /** ping을 보낼 때 호출. 돌려준 값을 pong 처리까지 들고 있다가 addPong에 넘긴다 */
  startPing() {
    return { sentAt: this.localNow() };
  }

  /** pong을 받았을 때 호출. 표본이 유효하면 true */
  addPong(ping, serverTime) {
    const sample = computeClockSample({ sentAt: ping.sentAt, serverTime, receivedAt: this.localNow() });
    if (!sample) return false;
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.offset = estimateOffset(this.samples);
    this.synced = true;
    return true;
  }

  /** 지금의 서버 시각(ms) 추정 */
  serverNow() {
    return localToServer(this.localNow(), this.offset);
  }

  /** 서버 시각 startAt까지 남은 ms(음수면 이미 지남) */
  msUntil(serverTime) {
    return serverTime - this.serverNow();
  }
}
