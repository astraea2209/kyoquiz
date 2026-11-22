// 온라인 대결의 클라이언트 상태. 서버 메시지를 받아 화면이 그릴 상태로 바꾸고, 사용자 동작을 서버 메시지로 보낸다.
// DOM·WebSocket·YouTube에 의존하지 않는다: connection({on, send, close, status})과 playback(handleMessage, stop,
// isPlayerVisible …)을 주입받는다(테스트에서는 가짜).

import { SCORING } from '../scoring.js';

export class OnlineSession {
  /**
   * @param {object} opts
   * @param {object} opts.connection  RoomConnection
   * @param {object} opts.playback    OnlinePlayback
   * @param {{serverNow: () => number}} opts.clock  ClockSync
   */
  constructor({ connection, playback, clock }) {
    this.connection = connection;
    this.playback = playback;
    this.clock = clock;

    this.code = null;
    this.you = null; // 내 playerId
    this.room = null; // 서버의 state 스냅샷
    this.round = null; // prepare 메시지(진행 중인 라운드)
    this.go = null; // go 메시지
    this.reveal = null; // reveal 메시지(공개 뒤)
    this.gameOver = null;
    this.lockedIds = new Set(); // 이번 라운드에 정답·오답 소진·포기한 사람
    this.attemptsLeft = SCORING.maxWrongAttempts;
    this.myCorrect = null; // 이번 라운드에 내가 맞혔을 때 {points, elapsed, order} (매우 어려움은 전부 맞혔을 때)
    this.maxAttempts = SCORING.maxWrongAttempts;
    this.solved = new Map(); // 매우 어려움: 내가 맞힌 항목 → 점수
    this.lastGain = null; // 매우 어려움: 방금 맞힌 {items, points} 또는 이미 맞힌 {already}
    this.feedback = null; // 'correct' | 'partial' | 'already' | 'wrong' | 'rate' | null
    this.wrongChoices = new Set(); // 객관식에서 이미 틀린 보기 번호
    this.lastChoice = null;
    this.feedbackAt = 0;
    this.kicked = false;
    this.listeners = { change: new Set(), notice: new Set(), error: new Set() };

    this.offMessage = connection.on('message', (m) => this.handle(m));
    this.offStatus = connection.on('status', () => this.emit('change'));
  }

  on(type, fn) {
    this.listeners[type].add(fn);
    return () => this.listeners[type].delete(fn);
  }

  emit(type, payload) {
    for (const fn of [...this.listeners[type]]) fn(payload);
  }

  // ---------- 서버 메시지 ----------
  handle(message) {
    switch (message.type) {
      case 'joined':
        this.code = message.code;
        this.you = message.playerId;
        break;
      case 'state':
        this.room = message;
        if (message.phase === 'lobby') this.resetRound();
        break;
      case 'prepare':
        this.resetRound();
        this.round = message;
        if (message.attempts > 0) this.maxAttempts = this.attemptsLeft = message.attempts;
        this.playback.handleMessage(message);
        break;
      case 'go':
        if (this.round?.roundId === message.roundId) this.go = message;
        this.playback.handleMessage(message);
        break;
      case 'locked':
        if (this.round?.roundId === message.roundId) this.lockedIds.add(message.playerId);
        break;
      case 'answerResult':
        if (this.round?.roundId !== message.roundId) break;
        if (message.items) {
          // 매우 어려움: 항목을 맞혔다(전부 맞히면 complete)
          for (const item of message.items) this.solved.set(item, message.itemPoints?.[item] ?? null);
          this.lastGain = { items: message.items, points: message.points };
          if (message.complete) {
            this.myCorrect = { points: message.total, elapsed: message.elapsed, order: message.order, bonus: message.bonus };
            this.setFeedback('correct');
          } else {
            this.setFeedback('partial');
          }
        } else if (message.already) {
          this.lastGain = { already: message.already };
          this.attemptsLeft = message.attemptsLeft;
          this.setFeedback('already');
        } else if (message.correct) {
          this.myCorrect = { points: message.points, elapsed: message.elapsed, order: message.order };
          this.setFeedback('correct');
        } else {
          this.attemptsLeft = message.attemptsLeft;
          if (this.lastChoice != null) this.wrongChoices.add(this.lastChoice);
          this.setFeedback('wrong');
        }
        break;
      case 'rateLimited':
        if (this.round?.roundId === message.roundId) this.setFeedback('rate');
        break;
      case 'reveal':
        if (this.round?.roundId === message.roundId) this.reveal = message;
        this.playback.handleMessage(message);
        break;
      case 'gameOver':
        this.gameOver = message;
        this.playback.stop();
        break;
      case 'notice':
        this.emit('notice', message.message);
        break;
      case 'error':
        this.emit('error', message);
        break;
      case 'kicked':
        this.kicked = true;
        this.playback.stop();
        break;
      default:
    }
    this.emit('change');
  }

  resetRound() {
    this.round = null;
    this.go = null;
    this.reveal = null;
    this.lockedIds = new Set();
    this.maxAttempts = SCORING.maxWrongAttempts;
    this.attemptsLeft = SCORING.maxWrongAttempts;
    this.myCorrect = null;
    this.solved = new Map();
    this.lastGain = null;
    this.feedback = null;
    this.wrongChoices = new Set();
    this.lastChoice = null;
  }

  setFeedback(kind) {
    this.feedback = kind;
    this.feedbackAt = this.clock.serverNow();
  }

  // ---------- 조회 ----------
  get me() {
    return this.room?.players.find((p) => p.id === this.you) ?? null;
  }

  get isHost() {
    return !!this.room && this.room.hostId === this.you;
  }

  get phase() {
    return this.room?.phase ?? null;
  }

  /** 지금 정답을 낼 수 있는지(시작 신호 시각이 지났고, 공개 전이고, 나는 정답·포기·소진·제외되지 않음) */
  get canAnswer() {
    if (!this.round || this.reveal || !this.go || this.myCorrect) return false;
    if (this.clock.serverNow() < this.go.startAt) return false;
    return this.me?.status === 'ready';
  }

  /** 시작 신호까지 남은 초(없으면 null) */
  countdownSeconds() {
    if (!this.go || this.reveal) return null;
    const left = (this.go.startAt - this.clock.serverNow()) / 1000;
    return left > 0 ? Math.ceil(left) : null;
  }

  /** 답변 창에서 남은 초(시작 전이면 창 전체, 없으면 null) */
  secondsLeft() {
    if (!this.go) return null;
    const left = (this.go.deadlineAt - Math.max(this.clock.serverNow(), this.go.startAt)) / 1000;
    return Math.max(0, left);
  }

  /** 답변 창 진행률 0~1 */
  windowProgress() {
    if (!this.go) return 0;
    const total = (this.go.deadlineAt - this.go.startAt) / 1000;
    const elapsed = (this.clock.serverNow() - this.go.startAt) / 1000;
    return Math.min(1, Math.max(0, elapsed / total));
  }

  /** 준비를 마친 사람 수 / 이번 라운드 참가자 수 */
  readyCount() {
    const players = this.room?.players ?? [];
    const joined = players.filter((p) => p.status && p.status !== 'absent');
    return { ready: joined.filter((p) => p.status !== 'preparing').length, total: joined.length };
  }

  // ---------- 사용자 동작 ----------
  send(message) {
    return this.connection.send(message);
  }

  start() {
    this.send({ type: 'start' });
  }

  setSettings(patch) {
    this.send({ type: 'settings', settings: patch });
  }

  /** 주관식 답 */
  submitText(text) {
    if (!this.canAnswer || !this.round || this.round.choices) return false;
    const value = String(text ?? '').trim();
    if (!value) return false;
    return this.send({ type: 'answer', roundId: this.round.roundId, text: value });
  }

  /** 객관식 보기 번호 */
  choose(index) {
    if (!this.canAnswer || !this.round?.choices || this.wrongChoices.has(index)) return false;
    this.lastChoice = index;
    return this.send({ type: 'answer', roundId: this.round.roundId, choice: index });
  }

  pass() {
    if (!this.canAnswer) return false;
    return this.send({ type: 'pass', roundId: this.round.roundId });
  }

  leave() {
    this.send({ type: 'leave' });
    this.playback.stop();
    this.connection.close();
  }

  dispose() {
    this.offMessage?.();
    this.offStatus?.();
    this.listeners.change.clear();
    this.listeners.notice.clear();
    this.listeners.error.clear();
  }
}
