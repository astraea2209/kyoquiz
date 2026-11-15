// 테스트용 가짜 플레이어·시계·스케줄러·난수.
import { PLAYER_STATE } from '../js/game.js';

export class FakePlayer {
  constructor({ durations = {} } = {}) {
    this.durations = durations; // videoId → 초
    this.calls = [];
    this.videoId = null;
    this.time = 0;
    this.muted = false;
    this.state = PLAYER_STATE.UNSTARTED;
    this.stateHandlers = new Set();
    this.errorHandlers = new Set();
  }
  log(name, ...args) {
    this.calls.push([name, ...args]);
  }
  callNames() {
    return this.calls.map((c) => c[0]);
  }
  load(videoId, startSeconds = 0) {
    this.log('load', videoId, startSeconds);
    this.videoId = videoId;
    this.time = startSeconds;
  }
  cue(videoId) {
    this.log('cue', videoId);
    this.videoId = videoId;
    this.time = 0;
  }
  play() {
    this.log('play');
  }
  pause() {
    this.log('pause');
  }
  seek(seconds) {
    this.log('seek', seconds);
    this.time = seconds;
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return this.state === PLAYER_STATE.UNSTARTED ? 0 : (this.durations[this.videoId] ?? 0);
  }
  mute() {
    this.log('mute');
    this.muted = true;
  }
  unMute() {
    this.log('unMute');
    this.muted = false;
  }
  onStateChange(fn) {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }
  onError(fn) {
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }
  // --- 테스트에서 호출하는 조작 ---
  emitState(state) {
    this.state = state;
    for (const fn of this.stateHandlers) fn(state);
  }
  emitError(code) {
    for (const fn of this.errorHandlers) fn(code);
  }
}

export function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

export const manualScheduler = {
  setInterval: () => 1,
  clearInterval: () => {},
};

/** 결정적 난수(mulberry32) */
export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSong(n, extra = {}) {
  const videoId = `vid${String(n).padStart(8, '0')}`; // 11자
  return {
    id: `s${n}`,
    videoId,
    title: `Song Title ${n}`,
    titleAliases: [`별칭${n}`],
    anime: { name: `Anime Work ${n}`, aliases: [`작품${n}`] },
    type: 'OP',
    enabled: true,
    ...extra,
  };
}
