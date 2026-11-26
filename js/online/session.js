// 온라인 대결의 클라이언트 상태. 서버 메시지를 받아 화면이 그릴 상태로 바꾸고, 사용자 동작을 서버 메시지로 보낸다.
// DOM·WebSocket·YouTube에 의존하지 않는다: connection({on, send, close, status})과 playback(handleMessage, stop,
// isPlayerVisible …)을 주입받는다(테스트에서는 가짜).

import { SCORING } from '../scoring.js';
import { REACTION_COOLDOWN_MS, isReaction } from './reactions.js';

// 플레이어 색(채팅 이름·참가자·순위판). 방 안 입장 순서(p1, p2, …)로 정해 최대 인원 8명이 모두 다르다
export const PLAYER_COLORS = Object.freeze(['#6c8cff', '#3ecf8e', '#ffb84d', '#ff7eb6', '#4dd0e1', '#b892ff', '#ff8a65', '#c6e05a']);

/** playerId('p3' 등)의 색. 모르는 형식이면 첫 색 */
export function playerColor(playerId) {
  const n = Number.parseInt(String(playerId ?? '').replace(/\D/g, ''), 10);
  return PLAYER_COLORS[(Number.isFinite(n) && n > 0 ? n - 1 : 0) % PLAYER_COLORS.length];
}

/** 채팅 한도(서버 ROOM_CONFIG와 같은 값. 서버가 최종 판단한다) */
export const CHAT_LIMITS = Object.freeze({ maxLength: 100, cooldownMs: 500, keep: 100 });

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
    this.hint = null; // 이번 라운드에 받은 초성 힌트 [{key, text}]
    this.hintRequested = false;
    this.feedbackAt = 0;
    this.kicked = false;
    this.chat = []; // 받은 채팅 {id, playerId, nickname, text, at} (최근 CHAT_LIMITS.keep개)
    this.chatVersion = 0; // 채팅 목록이 바뀔 때마다 1씩 늘어난다(화면이 다시 그릴지 판단)
    this.chatBlocked = null; // 방금 막힌 내 채팅 {reason: 'answer'|'rate', at}
    this.lastChatSentAt = null;
    this.skipRequested = false; // 이번 공개에서 넘기기를 눌렀는지(서버 state가 오기 전에도 버튼을 잠그려고)
    this.lastReactionAt = null;
    this.listeners = { change: new Set(), notice: new Set(), error: new Set(), reaction: new Set() };

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
      case 'hint':
        // parts: [{key, text}](매우 어려움은 제목·가수·작품명). 예전 서버는 text(제목)만 보낸다
        if (this.round?.roundId === message.roundId) this.hint = Array.isArray(message.parts) ? message.parts : [{ key: 'title', text: message.text }];
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
      case 'chat':
        this.addChat([message]);
        break;
      case 'chatLog':
        // 입장·재접속 때 받는 최근 채팅. 이미 받은 것(id)은 건너뛴다
        this.addChat(Array.isArray(message.messages) ? message.messages : []);
        break;
      case 'chatBlocked':
        this.chatBlocked = { reason: message.reason, at: this.clock.serverNow() };
        this.chatVersion++;
        break;
      case 'reaction':
        // 화면에 잠깐 띄우고 마는 것이라 상태에 쌓지 않고 이벤트로만 넘긴다
        if (isReaction(message.emoji)) this.emit('reaction', { playerId: message.playerId, emoji: message.emoji });
        return;
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
    this.hint = null;
    this.hintRequested = false;
    this.skipRequested = false;
  }

  addChat(list) {
    const seen = new Set(this.chat.map((m) => m.id));
    let added = false;
    for (const m of list) {
      if (!m || typeof m.text !== 'string' || seen.has(m.id)) continue;
      seen.add(m.id);
      this.chat.push({ id: m.id, playerId: m.playerId, nickname: m.nickname, text: m.text, at: m.at });
      added = true;
    }
    if (!added) return;
    this.chat.sort((a, b) => a.id - b.id);
    if (this.chat.length > CHAT_LIMITS.keep) this.chat.splice(0, this.chat.length - CHAT_LIMITS.keep);
    this.chatVersion++;
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

  /** 초성 힌트를 요청할 수 있는지(쉬움 제외, 답할 수 있을 때, 라운드당 1번) */
  get canHint() {
    return this.canAnswer && !this.round.choices && this.hint == null && !this.hintRequested;
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

  /** 정답 공개가 끝나 다음 라운드(또는 결과)로 넘어갈 때까지 남은 초(공개 중이 아니면 null) */
  revealSecondsLeft() {
    if (!this.reveal || this.phase !== 'revealed' || !Number.isFinite(this.reveal.nextAt)) return null;
    return Math.max(0, (this.reveal.nextAt - this.clock.serverNow()) / 1000);
  }

  /** 넘기기 투표 현황: 투표한 사람 수 / 접속한 사람 수, 내가 투표했는지 */
  skipVotes() {
    const players = (this.room?.players ?? []).filter((p) => p.connected && !p.left);
    const mine = this.skipRequested || !!this.me?.skip;
    return { votes: players.filter((p) => p.skip || (p.id === this.you && mine)).length, total: players.length, mine };
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

  /** 초성 힌트 요청. 서버가 본인에게만 hint를 보내 준다 */
  requestHint() {
    if (!this.canHint) return false;
    if (!this.send({ type: 'hint', roundId: this.round.roundId })) return false;
    this.hintRequested = true;
    this.emit('change');
    return true;
  }

  pass() {
    if (!this.canAnswer) return false;
    return this.send({ type: 'pass', roundId: this.round.roundId });
  }

  /** 정답 공개 중 넘기기 투표(전원이 누르면 바로 다음 라운드) */
  skip() {
    if (this.phase !== 'revealed' || !this.reveal || this.skipVotes().mine) return false;
    if (!this.send({ type: 'skip', roundId: this.reveal.roundId })) return false;
    this.skipRequested = true;
    this.emit('change');
    return true;
  }

  /**
   * 정답 공개 중 이모지 리액션. 너무 빨리 누르면 보내지 않는다(서버도 같은 간격으로 버린다).
   * @returns {boolean} 보냈는지
   */
  react(emoji) {
    if (this.phase !== 'revealed' || !isReaction(emoji)) return false;
    const now = this.clock.serverNow();
    if (this.lastReactionAt != null && now - this.lastReactionAt < REACTION_COOLDOWN_MS) return false;
    if (!this.send({ type: 'react', emoji })) return false;
    this.lastReactionAt = now;
    return true;
  }

  /**
   * 채팅 보내기. 빈 글이거나 너무 빨리 보내면 보내지 않는다(서버도 같은 한도로 검사).
   * @returns {'sent'|'empty'|'rate'|false}  false: 연결이 없어 못 보냄
   */
  sendChat(text) {
    const value = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, CHAT_LIMITS.maxLength).join('');
    if (!value) return 'empty';
    const now = this.clock.serverNow();
    if (this.lastChatSentAt != null && now - this.lastChatSentAt < CHAT_LIMITS.cooldownMs) return 'rate';
    if (!this.send({ type: 'chat', text: value })) return false;
    this.lastChatSentAt = now;
    this.chatBlocked = null;
    return 'sent';
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
    this.listeners.reaction.clear();
  }
}
