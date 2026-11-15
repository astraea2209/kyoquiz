// 온라인 대결의 재생 제어. DOM·WebSocket에 의존하지 않고, 플레이어·시계·타이머·전송을 주입받는다.
//
// 서버 메시지에 맞춰 영상 재생만 맡는다.
//   prepare : 음소거로 불러 구간 위치에 맞춘 뒤 멈추고 ready를 보고한다(소리는 한 번도 나지 않는다)
//   go      : 서버 시각 startAt에 unMute + play
//   reveal  : 영상을 보여 주고 소리를 켠다. 다음 곡은 다른 플레이어에 cue
// 플레이어 인터페이스는 js/game.js 맨 위 주석과 같다(load/cue/play/pause/seek/getCurrentTime/mute/unMute/
// onStateChange/onError). 플레이어 2개를 라운드마다 번갈아 쓴다(공개 중인 영상을 다음 곡 cue가 지우지 않게).
// 모든 메시지는 roundId가 현재 라운드와 다르면 무시한다.

import { PLAYER_STATE } from '../game.js';

export const PLAYBACK_STAGE = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing', // 음소거 로드 + 구간 위치 맞추는 중
  READY: 'ready', // ready 보고 완료, go 대기
  PLAYING: 'playing', // 소리 나는 중
  STOPPED: 'stopped', // 랜덤 구간이 끝나 멈춤(답변 시간 중)
  REVEALED: 'revealed',
  ERROR: 'error', // 재생 오류를 보고함
  MISSED: 'missed', // 준비가 늦어 go를 놓침(서버가 이미 이 사람을 제외했다)
});

// 구간 시작 위치 근처에 도달했다고 볼 오차(초). game.js와 같다.
const SEEK_TOLERANCE = 0.3;
// 시작 신호가 이만큼(구간 길이 대비 비율) 넘게 늦으면 소리를 켜지 않는다.
const MAX_LATE_RATIO = 1;
// 시간 기준 구간 종료 안전장치(재생 위치가 안 오를 때): 구간 길이 + 이 값(초)
const CLIP_END_GRACE = 1;

const defaultScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class OnlinePlayback {
  /**
   * @param {object} opts
   * @param {object[]} opts.players   플레이어 1~2개
   * @param {{serverNow: () => number}} opts.clock  시계 차이를 보정한 서버 시각(js/online/net.js ClockSync)
   * @param {(message: object) => void} opts.send   서버로 보내기
   * @param {object} [opts.scheduler]  {setInterval, clearInterval, setTimeout, clearTimeout}
   * @param {number} [opts.pollInterval]
   */
  constructor({ players, clock, send, scheduler = defaultScheduler, pollInterval = 100 }) {
    if (!players?.length) throw new Error('플레이어가 필요합니다');
    this.players = players;
    this.clock = clock;
    this.sendFn = send;
    this.scheduler = scheduler;
    this.pollInterval = pollInterval;

    this.stage = PLAYBACK_STAGE.IDLE;
    this.roundId = null;
    this.round = null; // prepare 메시지
    this.active = 0;
    this.used = false; // 한 번이라도 prepare를 받았는지(첫 라운드는 0번 플레이어)
    this.states = players.map(() => PLAYER_STATE.UNSTARTED);
    this.seekObservedAt = null;
    this.errored = false;
    this.pollId = null;
    this.goTimerId = null;
    this.startAt = null;
    this.listeners = new Set();

    this.unsubscribers = [];
    players.forEach((player, index) => {
      this.unsubscribers.push(
        player.onStateChange((state) => this.handleStateChange(index, state)),
        player.onError((code) => this.handleError(index, code)),
      );
    });
  }

  get player() {
    return this.players[this.active];
  }

  /** 단계가 바뀔 때마다 fn(stage). 구독 해제 함수를 돌려준다 */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStage(stage) {
    if (this.stage === stage) return;
    this.stage = stage;
    for (const fn of this.listeners) fn(stage);
  }

  get isRandom() {
    return this.round?.mode !== 'full';
  }

  /**
   * 이 플레이어의 영상을 보여 줘도 되는지. 정답 공개 중인 현재 플레이어만 true.
   * (YouTube가 iframe title에 영상 제목을 넣으므로, false인 칸은 UI에서 inert 처리한다)
   */
  isPlayerVisible(index) {
    return this.stage === PLAYBACK_STAGE.REVEALED && !this.errored && index === this.active;
  }

  // ---------- 서버 메시지 ----------
  /** 편의: 서버 메시지를 type별로 분배 */
  handleMessage(message) {
    if (message?.type === 'prepare') this.prepare(message);
    else if (message?.type === 'go') this.go(message);
    else if (message?.type === 'reveal') this.reveal(message);
  }

  /** @param {{roundId, videoId, segmentStart, clipLength, mode}} msg */
  prepare(msg) {
    this.cancelTimers();
    // 이전 라운드 소리를 끊는다(공개 중이던 영상 포함). 이 시점에 영상 표시도 끝난다.
    if (this.used) for (const p of this.players) p.pause();
    if (this.used && this.players.length > 1) this.active = (this.active + 1) % this.players.length;
    this.used = true;

    this.roundId = msg.roundId;
    this.round = {
      videoId: msg.videoId,
      segmentStart: msg.mode === 'full' ? 0 : Number(msg.segmentStart) || 0,
      clipLength: Number(msg.clipLength) || 0,
      mode: msg.mode,
    };
    this.errored = false;
    this.readySent = false;
    this.seekObservedAt = null;
    this.startAt = null;
    this.states[this.active] = PLAYER_STATE.UNSTARTED;
    this.setStage(PLAYBACK_STAGE.PREPARING);

    this.player.mute();
    this.player.load(msg.videoId, this.round.segmentStart);
    this.startPolling();
  }

  /** @param {{roundId, startAt}} msg  startAt: 서버 시각(ms) */
  go(msg) {
    if (msg.roundId !== this.roundId) return;
    if (this.stage !== PLAYBACK_STAGE.READY) {
      // 준비를 못 마친 채 시작 신호가 왔다. 서버가 이미 이 사람을 제외했으므로 소리를 켜지 않는다.
      if (this.stage === PLAYBACK_STAGE.PREPARING) {
        this.stopPolling();
        this.player.pause();
        this.setStage(PLAYBACK_STAGE.MISSED);
      }
      return;
    }
    this.startAt = msg.startAt;
    const wait = msg.startAt - this.clock.serverNow();
    if (wait > 0) {
      const roundId = this.roundId;
      this.goTimerId = this.scheduler.setTimeout(() => {
        this.goTimerId = null;
        if (roundId === this.roundId) this.fire();
      }, wait);
    } else {
      this.fire();
    }
  }

  /** 시작 신호 시각이 됐다: 소리를 켜고 재생한다 */
  fire() {
    if (this.stage !== PLAYBACK_STAGE.READY) return;
    const r = this.round;
    const lateSec = Math.max(0, (this.clock.serverNow() - this.startAt) / 1000);
    if (this.isRandom && lateSec > r.clipLength * MAX_LATE_RATIO) {
      // 구간을 거의 다 놓쳤다. 소리를 켜지 않고 답변 시간만 이어 간다.
      this.player.pause();
      this.setStage(PLAYBACK_STAGE.MISSED);
      return;
    }
    // 시간이 지체됐으면 그만큼 앞으로 가서 다른 사람과 소리를 맞춘다(전체듣기도 동일)
    if (lateSec > 0.25) this.player.seek(r.segmentStart + lateSec);
    this.player.unMute();
    this.player.play();
    this.setStage(PLAYBACK_STAGE.PLAYING);
    this.startPolling();
  }

  /** @param {{roundId, nextVideoId?}} msg */
  reveal(msg) {
    if (msg.roundId !== this.roundId) return;
    this.cancelTimers();
    if (this.stage === PLAYBACK_STAGE.IDLE) return;
    if (!this.errored) {
      this.player.unMute();
      this.player.play();
    }
    this.setStage(this.errored ? PLAYBACK_STAGE.ERROR : PLAYBACK_STAGE.REVEALED);
    // 다음 곡은 다른 플레이어에 미리 cue(플레이어가 1개면 공개 중인 영상이 지워지므로 생략)
    if (msg.nextVideoId && this.players.length > 1) {
      this.players[(this.active + 1) % this.players.length].cue(msg.nextVideoId);
    }
  }

  /** 방을 나가거나 게임이 끝났을 때 */
  stop() {
    this.cancelTimers();
    for (const p of this.players) p.pause();
    this.roundId = null;
    this.setStage(PLAYBACK_STAGE.IDLE);
  }

  dispose() {
    this.cancelTimers();
    for (const off of this.unsubscribers) if (typeof off === 'function') off();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  // ---------- 플레이어 이벤트 ----------
  handleStateChange(index, state) {
    this.states[index] = state;
    if (index !== this.active) return;
    if (this.stage === PLAYBACK_STAGE.PREPARING && state === PLAYER_STATE.PLAYING) this.tick();
  }

  handleError(index, code) {
    if (index !== this.active) return; // 미리 cue한 칸의 오류는 그 칸이 차례가 될 때 다시 드러난다
    if (![PLAYBACK_STAGE.PREPARING, PLAYBACK_STAGE.READY, PLAYBACK_STAGE.PLAYING, PLAYBACK_STAGE.STOPPED, PLAYBACK_STAGE.MISSED].includes(this.stage)) return;
    this.cancelTimers();
    this.player.pause();
    this.errored = true;
    this.send({ type: 'playerError', roundId: this.roundId, code });
    this.setStage(PLAYBACK_STAGE.ERROR);
  }

  // ---------- 폴링 ----------
  startPolling() {
    if (this.pollId != null) return;
    this.pollId = this.scheduler.setInterval(() => this.tick(), this.pollInterval);
  }

  stopPolling() {
    if (this.pollId == null) return;
    this.scheduler.clearInterval(this.pollId);
    this.pollId = null;
  }

  cancelTimers() {
    this.stopPolling();
    if (this.goTimerId != null) {
      this.scheduler.clearTimeout(this.goTimerId);
      this.goTimerId = null;
    }
  }

  tick() {
    if (this.stage === PLAYBACK_STAGE.PREPARING) this.tickPrepare();
    else if (this.stage === PLAYBACK_STAGE.PLAYING) this.tickPlaying();
  }

  /** 구간 위치에서 시간이 실제로 흐르는 것을 확인한 뒤 멈추고 위치를 되돌려 ready를 보고한다 */
  tickPrepare() {
    if (this.states[this.active] !== PLAYER_STATE.PLAYING) return;
    const r = this.round;
    const t = this.player.getCurrentTime();
    const end = this.isRandom ? r.segmentStart + r.clipLength - 0.2 : Infinity;
    const inRange = t >= r.segmentStart - SEEK_TOLERANCE && t < end;
    if (!inRange) {
      this.seekObservedAt = null;
      return;
    }
    if (this.seekObservedAt == null || t <= this.seekObservedAt) {
      this.seekObservedAt = t;
      return;
    }
    // 위치 확인 완료: 멈추고 정확한 시작 위치로 되돌린다(음소거 상태 유지)
    this.stopPolling();
    this.player.pause();
    this.player.seek(r.segmentStart);
    this.seekObservedAt = null;
    this.setStage(PLAYBACK_STAGE.READY);
    if (!this.readySent) {
      this.readySent = true;
      this.send({ type: 'ready', roundId: this.roundId });
    }
  }

  tickPlaying() {
    if (!this.isRandom) return; // 전체듣기는 reveal을 받을 때까지 계속 재생
    const r = this.round;
    const byPosition = this.player.getCurrentTime() >= r.segmentStart + r.clipLength;
    const byClock = this.startAt != null && this.clock.serverNow() >= this.startAt + (r.clipLength + CLIP_END_GRACE) * 1000;
    if (byPosition || byClock) {
      this.stopPolling();
      this.player.pause();
      this.player.mute();
      this.setStage(PLAYBACK_STAGE.STOPPED);
    }
  }

  send(message) {
    this.sendFn(message);
  }
}
