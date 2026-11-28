// 멀티플레이("친구와 대결") 방 상태 머신.
// DOM·네트워크·실제 시계에 의존하지 않는다. 시계(now), 난수(rng), 타이머(timers), 메시지 전송(send)을 주입받는다.
// 실행 환경(Cloudflare Durable Object, Node ws 등)에 맞춘 어댑터가 handleMessage/handleDisconnect를 부르고
// send(connId, message)로 소켓에 쓰면 된다.
//
// 단계: 대기실(lobby) → 준비(preparing) → 시작 대기(starting) → 답변(answering) → 공개(revealed) → … → 결과(results)
// 입장: 어느 단계에서나 새로 들어올 수 있다(최대 인원까지). 게임 중에 들어오면 진행 중인 라운드는 쉬고 다음 라운드부터 0점으로 합류한다.
// 라운드 종료: 참가자 전원이 정답을 맞혔거나 포기·오답 소진·제외됐을 때, 또는 답변 시간이 끝났을 때 중 먼저 오는 것.
// 정답자는 각자 도착 시간에 따른 점수를 받는다(첫 정답자가 나와도 라운드는 계속된다).
// 매우 어려움: 제목·가수·작품명(곡에 있는 항목)을 각자 맞힌 시점의 속도 점수로 나눠 받고, 전부 맞혀야 '정답'으로 잠긴다.
// 일부만 맞힌 사람도 공개 때 그 점수를 받는다. 다른 사람에게는 맞힌 항목 개수(solved)만 보인다.
//
// 클라이언트 → 서버: join, settings, start, ready, answer, pass, hint, playerError, chat, skip, react, ping, leave
// 서버 → 클라이언트: joined, state, prepare, go, locked, answerResult, rateLimited, reveal, gameOver, notice, error, pong, kicked,
//                   hint, chat, chatLog, chatBlocked, reaction
// 정답 공개: 방에서 정한 시간(settings.revealTime) 동안. 접속한 사람 전원이 넘기기(skip)에 투표하면 바로 다음 라운드.
// 리액션: 정답 공개 중에만 REACTIONS의 이모지를 보낼 수 있고 모두에게 그대로 전달한다(기록하지 않음).
// 곡 교체: 준비 단계에서 과반이 재생하지 못하면 곡을 바꾸되, 한 라운드에서 maxSongReplacements번을 넘으면 게임을 멈춘다.
// 초성 힌트: 쉬움 제외, 답할 수 있는 사람이 라운드당 1번 요청하면 본인에게만 초성을 보낸다(매우 어려움은 가수·작품명도). 이후 얻는 점수는 SCORING.hint만큼 깎인다.
// 채팅: 대기실·게임·결과 어디서나. 라운드 중(공개 전)에는 정답이 들어간 채팅을 막는다(chatBlocked {reason: 'answer'}).
// 채팅 이모지: chat {sticker}(STICKERS의 id)는 글 대신 그림. 정답 검사 없이 채팅과 같은 간격 제한만 받는다.
// 라운드 메시지(ready, answer, pass, playerError)는 roundId가 현재 라운드와 다르면 조용히 무시한다.
// 공개(reveal) 전에는 곡 제목·별칭·정답 위치를 어떤 메시지에도 싣지 않는다.

import { DIFFICULTY, buildChoices, canUseMultipleChoice, hintParts, itemCandidates, judgeAnswer, judgeItems, revealsAnswer } from '../js/judge.js';
import { RECENT_SONGS_LIMIT, addRecent, orderByRecency } from '../js/recentSongs.js';
import { MODE } from '../js/game.js';
import { SCORING, answerWindow, applyHint, isValidRounds, scoreExtremeBonus, scoreExtremeItem, scoreMulti } from '../js/scoring.js';
import { pickSegmentStart } from '../js/segment.js';
import { REACTION_COOLDOWN_MS, isReaction } from '../js/online/reactions.js';
import { isSticker } from '../js/online/stickers.js';
import { addSongStats, roundSongStats } from '../js/songStats.js';

export const ROOM_PHASE = Object.freeze({
  LOBBY: 'lobby',
  PREPARING: 'preparing', // prepare를 보내고 ready를 모으는 중
  STARTING: 'starting', // go를 보냈고 startAt을 기다리는 중
  ANSWERING: 'answering',
  REVEALED: 'revealed',
  RESULTS: 'results',
});

/** 플레이어의 이번 라운드 상태 */
export const PLAYER_STATUS = Object.freeze({
  PREPARING: 'preparing',
  READY: 'ready', // 정답을 낼 수 있다
  ERROR: 'error', // 재생 오류로 제외
  TIMEOUT: 'timeout', // ready가 늦어 제외
  ABSENT: 'absent', // 접속이 끊겼거나 이번 라운드 도중 합류해서 제외
  PASSED: 'passed', // 포기
  EXHAUSTED: 'exhausted', // 오답 기회 소진
  CORRECT: 'correct', // 정답을 맞혀 다른 사람을 기다리는 중
});

// 시간·한도. 운영 값은 확정 전이므로 Room 생성 때 config로 덮어쓸 수 있다.
export const ROOM_CONFIG = Object.freeze({
  minPlayers: SCORING.multi.minPlayers,
  maxPlayers: SCORING.multi.maxPlayers,
  goLeadMs: 3000, // go를 보낸 뒤 실제 시작까지(네트워크 지연 흡수용 카운트다운)
  readyTimeoutMs: 10000,
  maxSongReplacements: 3, // 한 라운드에서 재생 못 한 곡을 바꾸는 최대 횟수(넘으면 게임을 멈춘다. 재생이 안 되는 환경에서 곡을 다 써 버리지 않게)
  reconnectGraceMs: 60000,
  answerCooldownMs: 1000,
  maxNicknameLength: 12,
  maxAnswerLength: 100,
  maxChatLength: 100,
  chatCooldownMs: 500, // 한 사람이 채팅을 보내는 최소 간격
  chatLogSize: 50, // 새로 들어오거나 재접속한 사람에게 보내 주는 최근 채팅 수
  recentSongsLimit: RECENT_SONGS_LIMIT, // 방에서 최근에 나온 곡을 기억하는 수(한 판 더 할 때 뒤로 미룸)
  reactionCooldownMs: REACTION_COOLDOWN_MS,
});

export const DEFAULT_SETTINGS = Object.freeze({
  mode: MODE.RANDOM,
  rounds: 10,
  clipLength: SCORING.defaultClipLength,
  difficulty: DIFFICULTY.NORMAL,
  answerTime: SCORING.multi.defaultAnswerTime,
  fullTime: SCORING.multi.defaultFullTime,
  revealTime: SCORING.multi.defaultRevealTime,
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 I, O, 0, 1 제외
export const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}

/** 사용자가 입력한 코드를 정규화한다. 형식이 틀리면 null */
export function normalizeRoomCode(input) {
  const code = String(input ?? '').trim().toUpperCase();
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const defaultToken = () => globalThis.crypto.randomUUID();

function errorMessage(code, message) {
  return { type: 'error', code, message };
}

/** 총점, 동점이면 정답 수, 그래도 같으면 공동 순위(1, 1, 3 방식) */
export function rankPlayers(list) {
  const sorted = list.slice().sort((a, b) => b.score - a.score || b.correct - a.correct || a.joinSeq - b.joinSeq);
  return sorted.map((p) => ({
    ...p,
    rank: 1 + sorted.filter((o) => o.score > p.score || (o.score === p.score && o.correct > p.correct)).length,
  }));
}

export class Room {
  /**
   * @param {object} opts
   * @param {string} opts.code        방 코드(5자리)
   * @param {object[]} opts.songs     곡 목록(서버만 보유). {videoId, title, titleAliases, anime, duration, ...}
   * @param {(connId: string, message: object) => void} opts.send
   * @param {() => number} [opts.now]  ms 단위 시계
   * @param {() => number} [opts.rng]
   * @param {{setTimeout, clearTimeout}} [opts.timers]
   * @param {() => string} [opts.genToken]  재접속 토큰 생성기
   * @param {(room: Room) => void} [opts.onClose]  모든 플레이어가 나가 방을 지워도 될 때
   * @param {{get: (videoId: string) => Promise<object|null>, add: (videoId: string, delta: object) => unknown}} [opts.stats]
   *        곡별 정답률 저장소(매우 어려움만). 라운드 준비 때 get으로 지금까지 기록을 읽고, 공개 때 add로 이번 라운드를 더한다
   * @param {object} [opts.config]    ROOM_CONFIG 덮어쓰기
   */
  constructor({
    code,
    songs,
    send,
    now = () => Date.now(),
    rng = Math.random,
    timers = defaultTimers,
    genToken = defaultToken,
    onClose = null,
    stats = null,
    config = {},
  }) {
    this.code = code;
    this.songs = songs.slice();
    this.sendFn = send;
    this.now = now;
    this.rng = rng;
    this.timers = timers;
    this.genToken = genToken;
    this.onClose = onClose;
    this.stats = stats;
    this.config = { ...ROOM_CONFIG, ...config };

    this.phase = ROOM_PHASE.LOBBY;
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map(); // playerId → player
    this.connToPlayer = new Map(); // connId → playerId
    this.hostId = null;
    this.nextPlayerSeq = 1;

    this.timerIds = {};
    this.graceTimers = new Map(); // playerId → timer id
    this.chatLog = []; // 최근 채팅(방이 살아 있는 동안 유지)
    this.chatSeq = 0;
    this.recentVideoIds = []; // 이 방에서 공개한 곡(앞이 오래전). 한 판 더 해도 유지
    this.closed = false;
    this.resetGame();
  }

  resetGame() {
    this.queue = [];
    this.totalRounds = 0;
    this.roundIndex = -1;
    this.round = null;
    this.roundCounter = 0;
    this.difficulty = this.settings.difficulty;
    this.history = [];
    this.stalled = false;
    this.playableSongs = [];
    this.replacements = 0; // 이번 라운드에서 곡을 바꾼 횟수
  }

  // ---------- 외부 진입점 ----------
  /** 어댑터가 소켓에서 받은 메시지(이미 JSON 파싱한 객체)를 넘긴다 */
  handleMessage(connId, message) {
    if (this.closed || !message || typeof message.type !== 'string') return;
    if (message.type === 'ping') return this.onPing(connId, message);
    if (message.type === 'join') return this.onJoin(connId, message);

    const player = this.playerByConn(connId);
    if (!player) {
      this.sendTo(connId, errorMessage('not-joined', '먼저 방에 입장해야 합니다.'));
      return;
    }
    switch (message.type) {
      case 'settings':
        return this.onSettings(player, message);
      case 'start':
        return this.onStart(player);
      case 'ready':
        return this.onReady(player, message);
      case 'answer':
        return this.onAnswer(player, message);
      case 'pass':
        return this.onPass(player, message);
      case 'hint':
        return this.onHint(player, message);
      case 'playerError':
        return this.onPlayerError(player, message);
      case 'chat':
        return this.onChat(player, message);
      case 'skip':
        return this.onSkip(player, message);
      case 'react':
        return this.onReact(player, message);
      case 'leave':
        return this.removePlayer(player);
      default:
    }
  }

  /** 소켓이 끊겼을 때 */
  handleDisconnect(connId) {
    const player = this.playerByConn(connId);
    if (!player) return;
    this.connToPlayer.delete(connId);
    player.connId = null;
    player.connected = false;
    this.setGraceTimer(player);
    if (this.hostId === player.id) this.electHost();
    this.markAbsentInRound(player);
    this.broadcastState();
    this.afterPlayerGone();
  }

  /** 모든 타이머를 멈춘다(방을 버릴 때) */
  dispose() {
    this.closed = true;
    for (const name of Object.keys(this.timerIds)) this.clearTimer(name);
    for (const id of this.graceTimers.values()) this.timers.clearTimeout(id);
    this.graceTimers.clear();
  }

  // ---------- 조회 ----------
  playerByConn(connId) {
    const id = this.connToPlayer.get(connId);
    return id ? this.players.get(id) : null;
  }

  /** 방에 남아 있는(나가지 않은) 플레이어 */
  get members() {
    return [...this.players.values()].filter((p) => !p.left);
  }

  get connectedMembers() {
    return this.members.filter((p) => p.connected);
  }

  get isInGame() {
    return [ROOM_PHASE.PREPARING, ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING, ROOM_PHASE.REVEALED].includes(this.phase);
  }

  /** 정답 공개 시간(ms) */
  get revealMs() {
    return this.settings.revealTime * 1000;
  }

  get hasNext() {
    return this.roundIndex + 1 < this.totalRounds && this.queue.length > 0;
  }

  /** 모든 클라이언트에게 같은 방 스냅샷. 곡 정보와 토큰은 들어 있지 않다 */
  snapshot() {
    const round = this.round;
    return {
      type: 'state',
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: { ...this.settings },
      players: [...this.players.values()]
        .sort((a, b) => a.joinSeq - b.joinSeq)
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          score: p.score,
          correct: p.correct,
          connected: p.connected,
          left: p.left,
          isHost: p.id === this.hostId,
          status: round && this.isInGame ? (round.players.get(p.id)?.status ?? PLAYER_STATUS.ABSENT) : null,
          // 매우 어려움: 이번 라운드에 맞힌 항목 개수(어떤 항목인지는 공개하지 않는다)
          solved: round?.items && this.isInGame ? (round.players.get(p.id)?.solved.size ?? 0) : null,
          // 이번 라운드에 초성 힌트를 봤는지(힌트 내용은 본인에게만 보낸다)
          hint: round && this.isInGame ? !!round.players.get(p.id)?.hintUsed : null,
          // 정답 공개 중 넘기기에 투표했는지
          skip: round && this.phase === ROOM_PHASE.REVEALED ? round.skipVotes.has(p.id) : null,
        })),
      round: round && this.isInGame ? { id: round.id, index: this.roundIndex, total: this.totalRounds } : null,
    };
  }

  // ---------- 전송 ----------
  sendTo(connId, message) {
    if (connId != null) this.sendFn(connId, message);
  }

  sendToPlayer(player, message) {
    this.sendTo(player.connId, message);
  }

  broadcast(message) {
    for (const p of this.connectedMembers) this.sendToPlayer(p, message);
  }

  broadcastState() {
    this.broadcast(this.snapshot());
  }

  // ---------- 타이머 ----------
  setTimer(name, ms, fn) {
    this.clearTimer(name);
    this.timerIds[name] = this.timers.setTimeout(() => {
      delete this.timerIds[name];
      fn();
    }, ms);
  }

  clearTimer(name) {
    if (this.timerIds[name] != null) {
      this.timers.clearTimeout(this.timerIds[name]);
      delete this.timerIds[name];
    }
  }

  clearRoundTimers() {
    for (const name of ['ready', 'start', 'deadline', 'reveal']) this.clearTimer(name);
  }

  setGraceTimer(player) {
    this.clearGraceTimer(player);
    this.graceTimers.set(
      player.id,
      this.timers.setTimeout(() => {
        this.graceTimers.delete(player.id);
        if (!player.connected) this.removePlayer(player);
      }, this.config.reconnectGraceMs),
    );
  }

  clearGraceTimer(player) {
    const id = this.graceTimers.get(player.id);
    if (id != null) this.timers.clearTimeout(id);
    this.graceTimers.delete(player.id);
  }

  // ---------- 입장·퇴장 ----------
  onPing(connId, message) {
    this.sendTo(connId, { type: 'pong', clientTime: message.clientTime ?? null, serverTime: this.now() });
  }

  onJoin(connId, message) {
    if (this.connToPlayer.has(connId)) return; // 이미 입장한 연결
    const token = typeof message.token === 'string' && message.token ? message.token : null;
    const existing = token ? this.members.find((p) => p.token === token) : null;
    if (existing) return this.reattach(existing, connId);

    if (this.members.length >= this.config.maxPlayers) {
      this.sendTo(connId, errorMessage('room-full', `방이 가득 찼습니다(최대 ${this.config.maxPlayers}명).`));
      return;
    }
    const base = this.cleanNickname(message.nickname);
    if (!base) {
      this.sendTo(connId, errorMessage('bad-nickname', '닉네임을 입력해 주세요.'));
      return;
    }
    const player = {
      id: `p${this.nextPlayerSeq}`,
      joinSeq: this.nextPlayerSeq++,
      nickname: this.uniqueNickname(base),
      token: this.genToken(),
      connId,
      connected: true,
      left: false,
      score: 0,
      correct: 0,
      lastChatAt: null,
      lastReactionAt: null,
    };
    this.players.set(player.id, player);
    this.connToPlayer.set(connId, player.id);
    // 방장이 없거나 끊겨 있으면(접속한 사람이 없을 때 끊긴 방장) 접속한 사람 중에서 다시 정한다
    if (!this.players.get(this.hostId)?.connected) this.electHost();
    this.sendTo(connId, { type: 'joined', code: this.code, playerId: player.id, token: player.token, reconnected: false });
    this.sendChatLog(connId);

    // 게임 중에 들어온 사람: 진행 중인 라운드에는 자리가 없어(상태 absent) 다음 라운드부터 0점으로 합류한다
    if (this.isInGame) {
      for (const p of this.connectedMembers) {
        if (p !== player) this.sendToPlayer(p, { type: 'notice', message: `${player.nickname}님이 들어왔어요. 다음 라운드부터 함께해요.` });
      }
      if (this.stalled) {
        // 모두 끊겨 멈춰 있던 게임: 이어 갈 인원이 없으니 결과 화면으로
        this.stalled = false;
        this.gameOver('not-enough-players');
        return;
      }
    }
    this.broadcastState();
  }

  /** 재접속 토큰으로 돌아온 경우. 진행 중인 라운드에는 끼지 않고 다음 라운드부터 합류한다 */
  reattach(player, connId) {
    if (player.connId != null && player.connId !== connId) {
      this.connToPlayer.delete(player.connId);
      this.sendTo(player.connId, { type: 'kicked', reason: 'replaced' });
    }
    this.clearGraceTimer(player);
    player.connId = connId;
    player.connected = true;
    this.connToPlayer.set(connId, player.id);
    if (!this.players.get(this.hostId)?.connected) this.electHost();
    this.sendTo(connId, { type: 'joined', code: this.code, playerId: player.id, token: player.token, reconnected: true });
    this.sendChatLog(connId);

    if (this.stalled) {
      // 모두 끊겨 멈춰 있던 게임: 혼자 돌아왔으니 결과 화면으로
      this.stalled = false;
      this.gameOver('not-enough-players');
      return;
    }
    this.markAbsentInRound(player); // 새 탭은 재생 준비가 안 돼 있다
    this.broadcastState();
    this.afterPlayerGone();
  }

  cleanNickname(raw) {
    return this.cleanText(raw, this.config.maxNicknameLength);
  }

  uniqueNickname(base) {
    const taken = new Set([...this.players.values()].map((p) => p.nickname.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const suffix = String(n);
      const head = Array.from(base).slice(0, Math.max(1, this.config.maxNicknameLength - suffix.length)).join('');
      const candidate = `${head}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  electHost() {
    const pool = this.connectedMembers.length ? this.connectedMembers : this.members;
    const next = pool.slice().sort((a, b) => a.joinSeq - b.joinSeq)[0];
    this.hostId = next ? next.id : null;
  }

  /** 명시적으로 나가거나, 재접속 유예가 끝났을 때 */
  removePlayer(player) {
    if (player.left || !this.players.has(player.id)) return;
    this.clearGraceTimer(player);
    if (player.connId != null) this.connToPlayer.delete(player.connId);
    player.connId = null;
    player.connected = false;
    player.left = true;
    // 진행 중이거나 결과 화면에서는 순위 기록을 위해 남겨 두고, 대기실에서만 지운다
    if (this.phase === ROOM_PHASE.LOBBY) this.players.delete(player.id);
    if (this.hostId === player.id) this.electHost();
    this.markAbsentInRound(player);

    if (this.members.length === 0) {
      this.close();
      return;
    }
    this.broadcastState();
    this.afterPlayerGone();
  }

  close() {
    if (this.closed) return;
    this.dispose();
    this.onClose?.(this);
  }

  // ---------- 채팅 ----------
  onChat(player, message) {
    // 이모지(STICKERS의 id)를 보내면 글 대신 그림 하나. 글은 무시한다
    const sticker = message.sticker != null ? String(message.sticker) : null;
    if (sticker != null && !isSticker(sticker)) return;
    // 줄바꿈·탭은 지우지 않고 띄어쓰기로 바꾼다(닉네임은 제어 문자로 보고 지운다)
    const text = sticker ? '' : this.cleanText(String(message.text ?? '').replace(/\s+/g, ' '), this.config.maxChatLength);
    if (!text && !sticker) return;
    const now = this.now();
    if (player.lastChatAt != null && now - player.lastChatAt < this.config.chatCooldownMs) {
      this.sendToPlayer(player, { type: 'chatBlocked', reason: 'rate' });
      return;
    }
    // 공개 전에는 정답(제목·가수·작품명과 별칭)이 들어간 채팅을 막는다. 보낸 사람에게만 알린다
    const hidden = [ROOM_PHASE.PREPARING, ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING].includes(this.phase);
    if (text && hidden && this.round && revealsAnswer(text, this.round.song)) {
      this.sendToPlayer(player, { type: 'chatBlocked', reason: 'answer' });
      return;
    }
    player.lastChatAt = now;
    const entry = { id: ++this.chatSeq, playerId: player.id, nickname: player.nickname, text, at: now };
    if (sticker) entry.sticker = sticker;
    this.chatLog.push(entry);
    if (this.chatLog.length > this.config.chatLogSize) this.chatLog.shift();
    this.broadcast({ type: 'chat', ...entry });
  }

  /** 입장·재접속한 연결에 최근 채팅을 보낸다 */
  sendChatLog(connId) {
    if (this.chatLog.length) this.sendTo(connId, { type: 'chatLog', messages: this.chatLog });
  }

  /** 제어 문자를 빼고 공백을 하나로 줄여 최대 길이(글자 수)로 자른다 */
  cleanText(raw, maxLength) {
    const text = String(raw ?? '')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(text).slice(0, maxLength).join('').trim();
  }

  // ---------- 설정·시작 ----------
  onSettings(player, message) {
    if (player.id !== this.hostId) return this.sendToPlayer(player, errorMessage('not-host', '방장만 설정을 바꿀 수 있습니다.'));
    if (this.phase !== ROOM_PHASE.LOBBY && this.phase !== ROOM_PHASE.RESULTS) {
      return this.sendToPlayer(player, errorMessage('bad-phase', '게임 중에는 설정을 바꿀 수 없습니다.'));
    }
    const input = message.settings ?? {};
    const next = { ...this.settings };
    const rules = {
      mode: (v) => Object.values(MODE).includes(v),
      rounds: isValidRounds,
      clipLength: (v) => SCORING.clipLengths.includes(v),
      difficulty: (v) => Object.values(DIFFICULTY).includes(v),
      answerTime: (v) => SCORING.multi.answerTimes.includes(v),
      fullTime: (v) => SCORING.multi.fullTimes.includes(v),
      revealTime: (v) => SCORING.multi.revealTimes.includes(v),
    };
    for (const [key, valid] of Object.entries(rules)) {
      if (!(key in input)) continue;
      if (!valid(input[key])) return this.sendToPlayer(player, errorMessage('bad-settings', `잘못된 설정입니다(${key}).`));
      next[key] = input[key];
    }
    this.settings = next;
    this.broadcastState();
  }

  onStart(player) {
    if (player.id !== this.hostId) return this.sendToPlayer(player, errorMessage('not-host', '방장만 시작할 수 있습니다.'));
    if (this.phase !== ROOM_PHASE.LOBBY && this.phase !== ROOM_PHASE.RESULTS) return;
    if (this.connectedMembers.length < this.config.minPlayers) {
      return this.sendToPlayer(player, errorMessage('not-enough-players', `${this.config.minPlayers}명 이상이 모여야 시작할 수 있습니다.`));
    }
    this.startGame();
  }

  startGame() {
    // 결과 화면에서 다시 시작: 나간 사람을 정리하고 점수를 0으로
    for (const p of [...this.players.values()]) {
      if (p.left) this.players.delete(p.id);
      else {
        p.score = 0;
        p.correct = 0;
      }
    }
    this.resetGame();

    const enabled = this.songs.filter((s) => s.enabled !== false);
    const isRandom = this.settings.mode === MODE.RANDOM;
    const playable = isRandom ? enabled.filter((s) => s.duration > 0) : enabled;
    if (playable.length === 0) {
      this.sendToPlayer(this.players.get(this.hostId), errorMessage('no-songs', isRandom && enabled.length ? '길이 정보가 있는 곡이 없어 랜덤듣기를 할 수 없습니다.' : '재생할 수 있는 곡이 없습니다.'));
      return;
    }
    this.playableSongs = playable;
    this.difficulty = this.settings.difficulty;
    const notices = [];
    if (isRandom && playable.length < enabled.length) {
      notices.push(`길이 정보가 없는 곡 ${enabled.length - playable.length}개는 랜덤듣기에서 제외했습니다.`);
    }
    if (this.difficulty === DIFFICULTY.EASY && !canUseMultipleChoice(playable)) {
      this.difficulty = DIFFICULTY.NORMAL;
      notices.push('객관식 보기를 만들 곡이 부족해 보통 난이도(주관식)로 진행합니다.');
    }
    this.queue = orderByRecency(playable, this.recentVideoIds, this.rng);
    this.totalRounds = Math.min(this.settings.rounds, this.queue.length);
    if (this.totalRounds < this.settings.rounds) {
      notices.push(`사용 가능한 곡이 ${this.queue.length}개라서 ${this.totalRounds}라운드로 진행합니다.`);
    }
    for (const message of notices) this.broadcast({ type: 'notice', message });
    this.beginRound();
  }

  // ---------- 라운드 ----------
  beginRound() {
    this.roundIndex++;
    this.replacements = 0;
    this.createRound(this.queue.shift());
  }

  /** 곡 하나로 새 roundId의 준비 단계를 연다(곡 교체 때도 쓴다) */
  createRound(song) {
    this.clearRoundTimers();
    const { mode, clipLength, answerTime, fullTime } = this.settings;
    const isRandom = mode === MODE.RANDOM;
    const segmentStart = isRandom
      ? pickSegmentStart(
          { duration: song.duration, clipLength, skipStart: song.skipStart, skipEnd: song.skipEnd, hookStart: song.hookStart },
          this.rng,
        )
      : 0;
    const players = new Map();
    for (const p of this.members) {
      players.set(p.id, {
        status: p.connected ? PLAYER_STATUS.PREPARING : PLAYER_STATUS.ABSENT,
        wrong: 0,
        usedChoices: new Set(),
        lastAnswerAt: null,
        errorCode: null,
        correctOrder: null, // 정답 처리 순서(같은 ms 도착도 구분)
        elapsed: null,
        points: 0,
        solved: new Map(), // 매우 어려움: 항목 → {points, elapsed}
        bonus: 0,
        hintUsed: false,
      });
    }
    this.round = {
      id: ++this.roundCounter,
      song,
      segmentStart,
      choices: this.difficulty === DIFFICULTY.EASY ? buildChoices(song, this.playableSongs, this.rng) : null,
      window: answerWindow({ mode, clipLength, answerTime, fullTime }),
      startAt: null,
      deadlineAt: null,
      players,
      correctCount: 0,
      skipVotes: new Set(), // 정답 공개 중 넘기기에 투표한 playerId
      revealEndsAt: null,
      // 매우 어려움: 맞혀야 할 항목 키(값은 공개 전까지 보내지 않는다)
      items: this.difficulty === DIFFICULTY.EXTREME ? Object.keys(itemCandidates(song)) : null,
      priorStats: null, // 매우 어려움: 이 곡의 지금까지 정답률 기록(저장소에서 읽히면 채운다)
    };
    this.phase = ROOM_PHASE.PREPARING;
    if (this.round.items) this.loadSongStats(this.round);

    const prepare = {
      type: 'prepare',
      roundId: this.round.id,
      index: this.roundIndex,
      total: this.totalRounds,
      mode,
      difficulty: this.difficulty,
      videoId: song.videoId,
      segmentStart,
      clipLength: isRandom ? clipLength : null,
      answerWindow: this.round.window,
      choices: this.round.choices ? this.round.choices.map((c) => c.label) : null,
      items: this.round.items,
      attempts: this.maxWrongAttempts,
    };
    for (const p of this.members) {
      if (players.get(p.id).status === PLAYER_STATUS.PREPARING) this.sendToPlayer(p, prepare);
    }
    this.broadcastState();
    if (this.connectedMembers.length === 0) {
      this.stall();
      return;
    }
    this.setTimer('ready', this.config.readyTimeoutMs, () => this.onReadyTimeout());
    this.evaluatePrep();
  }

  /** 곡의 지금까지 기록을 읽어 둔다. 공개 전에 못 읽으면 공개 화면에 정답률을 싣지 않는다(게임은 그대로 진행) */
  loadSongStats(round) {
    if (!this.stats) return;
    Promise.resolve()
      .then(() => this.stats.get(round.song.videoId))
      .then((stats) => {
        round.priorStats = stats ?? { players: 0 };
      })
      .catch(() => {});
  }

  /** 공개 때: 이번 라운드를 더한 누적 기록(공개 화면용)을 돌려주고 저장소에도 더한다 */
  recordSongStats(round) {
    if (!this.stats || !round.items) return null;
    const counted = [PLAYER_STATUS.READY, PLAYER_STATUS.PASSED, PLAYER_STATUS.EXHAUSTED, PLAYER_STATUS.CORRECT];
    // 답할 수 있었던 사람(도중에 끊겨도 맞힌 항목이 있으면 센다)
    const participants = [...round.players.values()]
      .filter((e) => counted.includes(e.status) || e.solved.size > 0)
      .map((e) => ({ solved: e.solved.keys(), hint: e.hintUsed }));
    const delta = roundSongStats(round.items, participants);
    if (delta.players > 0) {
      Promise.resolve()
        .then(() => this.stats.add(round.song.videoId, delta))
        .catch(() => {});
    }
    return round.priorStats ? addSongStats(round.priorStats, delta) : null;
  }

  /** 라운드당 오답 기회(매우 어려움은 항목이 많아 더 준다) */
  get maxWrongAttempts() {
    return this.difficulty === DIFFICULTY.EXTREME ? SCORING.extreme.maxWrongAttempts : SCORING.maxWrongAttempts;
  }

  entriesOf(status) {
    return [...this.round.players.values()].filter((e) => e.status === status);
  }

  onReady(player, message) {
    const entry = this.roundEntry(player, message, [ROOM_PHASE.PREPARING]);
    if (!entry || entry.status !== PLAYER_STATUS.PREPARING) return;
    entry.status = PLAYER_STATUS.READY;
    this.broadcastState();
    this.evaluatePrep();
  }

  onReadyTimeout() {
    if (this.phase !== ROOM_PHASE.PREPARING) return;
    for (const entry of this.entriesOf(PLAYER_STATUS.PREPARING)) entry.status = PLAYER_STATUS.TIMEOUT;
    this.broadcastState();
    this.evaluatePrep();
  }

  onPlayerError(player, message) {
    const entry = this.roundEntry(player, message, [ROOM_PHASE.PREPARING, ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING]);
    if (!entry || ![PLAYER_STATUS.PREPARING, PLAYER_STATUS.READY].includes(entry.status)) return;
    entry.status = PLAYER_STATUS.ERROR;
    entry.errorCode = message.code ?? null;
    this.broadcastState();
    if (this.phase === ROOM_PHASE.PREPARING) this.evaluatePrep();
    else this.checkAllDone();
  }

  /** roundId와 단계가 맞는 메시지의 라운드 상태 항목. 아니면 null(조용히 무시) */
  roundEntry(player, message, phases) {
    const round = this.round;
    if (!round || message.roundId !== round.id || !phases.includes(this.phase)) return null;
    return round.players.get(player.id) ?? null;
  }

  /** 준비 단계 평가: 과반 오류면 곡 교체, 아직 기다릴 사람이 있으면 대기, 끝났으면 시작 신호 */
  evaluatePrep() {
    if (this.phase !== ROOM_PHASE.PREPARING) return;
    const entries = [...this.round.players.values()].filter((e) => e.status !== PLAYER_STATUS.ABSENT);
    const errors = entries.filter((e) => e.status === PLAYER_STATUS.ERROR).length;
    if (entries.length > 0 && errors * 2 > entries.length) {
      this.replaceSong('error');
      return;
    }
    if (entries.some((e) => e.status === PLAYER_STATUS.PREPARING)) return;
    if (!entries.some((e) => e.status === PLAYER_STATUS.READY)) {
      this.replaceSong('no-ready');
      return;
    }
    this.startCountdown();
  }

  /**
   * 과반이 재생하지 못한 곡을 바꾸고 라운드를 다시 준비한다. 곡 부족 시 라운드 축소(개인전과 같은 규칙).
   * 한 라운드에서 maxSongReplacements번 넘게 바꿔야 하면 재생 환경 문제로 보고 게임을 멈춘다(곡을 다 써 버리지 않게).
   */
  replaceSong(reason) {
    this.clearRoundTimers();
    const cause = reason === 'error' ? '재생 오류' : '준비 지연';
    if (this.replacements >= this.config.maxSongReplacements) {
      this.broadcast({
        type: 'notice',
        message: `곡을 ${this.replacements + 1}번 연달아 재생하지 못해(${cause}) 게임을 멈췄습니다. 인터넷 연결이나 브라우저 설정(광고 차단 등)을 확인해 주세요.`,
      });
      this.gameOver('playback-failed');
      return;
    }
    this.replacements++;
    if (this.queue.length === 0) {
      this.totalRounds = this.roundIndex;
      this.broadcast({ type: 'notice', message: `재생할 수 없는 곡을 건너뛰었습니다(${cause}). 남은 곡이 없어 ${this.totalRounds}라운드로 마칩니다.` });
      this.gameOver(this.totalRounds === 0 ? 'no-playable' : 'complete');
      return;
    }
    const replacement = this.queue.shift();
    const before = this.totalRounds;
    this.totalRounds = Math.min(this.totalRounds, this.roundIndex + 1 + this.queue.length);
    let message = `많은 사람이 재생하지 못해(${cause}) 곡을 바꿨습니다.`;
    if (this.totalRounds < before) message += ` 곡이 부족해 ${this.totalRounds}라운드로 줄였습니다.`;
    this.broadcast({ type: 'notice', message });
    this.createRound(replacement);
  }

  startCountdown() {
    const round = this.round;
    this.clearTimer('ready');
    round.startAt = this.now() + this.config.goLeadMs;
    round.deadlineAt = round.startAt + round.window * 1000;
    this.phase = ROOM_PHASE.STARTING;
    this.broadcast({ type: 'go', roundId: round.id, startAt: round.startAt, deadlineAt: round.deadlineAt });
    this.broadcastState();
    this.setTimer('start', this.config.goLeadMs, () => {
      if (this.phase !== ROOM_PHASE.STARTING) return;
      this.phase = ROOM_PHASE.ANSWERING;
      this.broadcastState();
    });
    this.setTimer('deadline', this.config.goLeadMs + round.window * 1000, () => this.finishRound('timeout'));
  }

  // ---------- 답 ----------
  onAnswer(player, message) {
    const entry = this.roundEntry(player, message, [ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING]);
    const round = this.round;
    if (!entry || entry.status !== PLAYER_STATUS.READY) return;
    const arrivedAt = this.now();
    if (arrivedAt < round.startAt) return; // 아직 아무도 소리를 못 들었다

    const easy = this.difficulty === DIFFICULTY.EASY;
    let key;
    if (easy) {
      const index = message.choice;
      if (!Number.isInteger(index) || !round.choices[index] || entry.usedChoices.has(index)) return;
      key = index;
    } else {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (!text || text.length > this.config.maxAnswerLength) return;
      key = text;
    }
    if (entry.lastAnswerAt != null && arrivedAt - entry.lastAnswerAt < this.config.answerCooldownMs) {
      this.sendToPlayer(player, {
        type: 'rateLimited',
        roundId: round.id,
        retryAfterMs: this.config.answerCooldownMs - (arrivedAt - entry.lastAnswerAt),
      });
      return;
    }
    entry.lastAnswerAt = arrivedAt;

    if (round.items) {
      this.answerExtreme(player, entry, key, arrivedAt);
      return;
    }
    const correct = easy ? round.choices[key].correct : judgeAnswer(key, round.song, this.difficulty).correct;
    if (correct) {
      // 점수는 공개 때 반영한다(공개 전에는 다른 사람에게 점수 변화가 보이지 않게)
      entry.status = PLAYER_STATUS.CORRECT;
      entry.correctOrder = ++round.correctCount;
      entry.elapsed = (arrivedAt - round.startAt) / 1000;
      entry.points = this.speedScore(entry, entry.elapsed);
      this.sendToPlayer(player, {
        type: 'answerResult',
        roundId: round.id,
        correct: true,
        points: entry.points,
        elapsed: entry.elapsed,
        order: entry.correctOrder,
      });
      this.afterLock(player, 'correct');
      return;
    }
    if (easy) entry.usedChoices.add(key);
    this.registerWrong(player, entry);
  }

  registerWrong(player, entry) {
    entry.wrong++;
    const attemptsLeft = Math.max(0, this.maxWrongAttempts - entry.wrong);
    this.sendToPlayer(player, { type: 'answerResult', roundId: this.round.id, correct: false, attemptsLeft });
    if (attemptsLeft === 0) {
      entry.status = PLAYER_STATUS.EXHAUSTED;
      this.afterLock(player, 'exhausted');
    }
  }

  /**
   * 매우 어려움 답: 입력 하나를 남은 항목 전부와 비교한다. 맞힌 항목마다 도착 시간의 속도 점수를 가중치로 나눠 주고,
   * 전부 맞히면 보너스와 함께 '정답'으로 잠근다. 이미 맞힌 항목만 다시 내면 기회를 줄이지 않는다.
   * 답한 사람에게만: answerResult {correct, items, itemPoints, points(이번에 얻은 점수, 보너스 포함), total, bonus, complete, …}
   */
  answerExtreme(player, entry, text, arrivedAt) {
    const round = this.round;
    const { matched, already } = judgeItems(text, round.song, entry.solved.keys());
    if (!matched.length) {
      if (already.length) {
        this.sendToPlayer(player, {
          type: 'answerResult',
          roundId: round.id,
          correct: false,
          already,
          attemptsLeft: Math.max(0, this.maxWrongAttempts - entry.wrong),
        });
        return;
      }
      this.registerWrong(player, entry);
      return;
    }
    const elapsed = (arrivedAt - round.startAt) / 1000;
    const base = this.speedScore(entry, elapsed);
    let gained = 0;
    const itemPoints = {};
    for (const item of matched) {
      const points = scoreExtremeItem({ base, item, items: round.items });
      entry.solved.set(item, { points, elapsed });
      itemPoints[item] = points;
      gained += points;
    }
    const complete = round.items.every((item) => entry.solved.has(item));
    if (complete) {
      entry.bonus = scoreExtremeBonus(base);
      gained += entry.bonus;
      entry.status = PLAYER_STATUS.CORRECT;
      entry.correctOrder = ++round.correctCount;
      entry.elapsed = elapsed;
    }
    entry.points += gained; // 점수는 공개 때 반영한다
    this.sendToPlayer(player, {
      type: 'answerResult',
      roundId: round.id,
      correct: true,
      items: matched,
      itemPoints,
      points: gained,
      total: entry.points,
      bonus: entry.bonus,
      complete,
      elapsed,
      order: complete ? entry.correctOrder : null,
    });
    if (complete) this.afterLock(player, 'correct');
    else this.broadcastState(); // 다른 사람에게는 맞힌 항목 개수만 보인다
  }

  /** 맞힌 시점의 속도 점수. 초성 힌트를 봤으면 깎는다 */
  speedScore(entry, elapsed) {
    const points = scoreMulti({
      mode: this.settings.mode,
      clipLength: this.settings.clipLength,
      elapsed,
      answerTime: this.settings.answerTime,
      fullTime: this.settings.fullTime,
    });
    return applyHint(points, entry.hintUsed);
  }

  /** 초성 힌트 요청: 쉬움 제외, 시작 신호 뒤 답할 수 있는 사람만, 라운드당 1번. 본인에게만 hint를 보낸다 */
  onHint(player, message) {
    const entry = this.roundEntry(player, message, [ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING]);
    const round = this.round;
    if (!entry || entry.status !== PLAYER_STATUS.READY || entry.hintUsed) return;
    if (this.difficulty === DIFFICULTY.EASY || this.now() < round.startAt) return;
    entry.hintUsed = true;
    // parts: 매우 어려움은 제목·가수·작품명, 그 밖에는 제목. text는 제목 초성(이전 클라이언트 호환)
    const parts = hintParts(round.song, this.difficulty);
    this.sendToPlayer(player, { type: 'hint', roundId: round.id, text: parts.find((p) => p.key === 'title')?.text ?? '', parts });
    this.broadcastState();
  }

  onPass(player, message) {
    const entry = this.roundEntry(player, message, [ROOM_PHASE.STARTING, ROOM_PHASE.ANSWERING]);
    if (!entry || entry.status !== PLAYER_STATUS.READY) return;
    entry.status = PLAYER_STATUS.PASSED;
    this.afterLock(player, 'pass');
  }

  afterLock(player, reason) {
    this.broadcast({ type: 'locked', roundId: this.round.id, playerId: player.id, reason });
    this.broadcastState();
    this.checkAllDone();
  }

  /** 정답을 낼 수 있는 사람이 아무도 안 남았으면(전원 정답·포기·소진·제외) 라운드를 끝낸다 */
  checkAllDone() {
    if (this.phase !== ROOM_PHASE.STARTING && this.phase !== ROOM_PHASE.ANSWERING) return;
    if (this.entriesOf(PLAYER_STATUS.READY).length === 0) this.finishRound('done');
  }

  // ---------- 공개 ----------
  /** @param {'done'|'timeout'} reason  done: 남은 사람이 없음, timeout: 답변 시간 끝 */
  finishRound(reason) {
    if (this.phase !== ROOM_PHASE.STARTING && this.phase !== ROOM_PHASE.ANSWERING) return;
    const round = this.round;
    this.clearRoundTimers();

    // 정답자: 처리 순서대로. 나간 사람도 이미 맞힌 점수는 받는다
    const correctPlayers = [...round.players]
      .filter(([, e]) => e.status === PLAYER_STATUS.CORRECT)
      .sort(([, a], [, b]) => a.correctOrder - b.correctOrder)
      .map(([id, e]) => {
        const player = this.players.get(id);
        if (player) {
          player.score += e.points;
          player.correct++;
        }
        return { playerId: id, nickname: player?.nickname ?? null, elapsed: e.elapsed, points: e.points, hint: e.hintUsed };
      });
    // 매우 어려움: 일부만 맞힌 사람도 맞힌 항목 점수를 받는다(정답 수에는 넣지 않는다)
    const partialPlayers = [];
    if (round.items) {
      for (const c of correctPlayers) c.solved = round.items.length;
      for (const [id, e] of round.players) {
        if (e.status === PLAYER_STATUS.CORRECT || e.solved.size === 0) continue;
        const player = this.players.get(id);
        if (player) player.score += e.points;
        partialPlayers.push({ playerId: id, nickname: player?.nickname ?? null, points: e.points, solved: e.solved.size, hint: e.hintUsed });
      }
      partialPlayers.sort((a, b) => b.solved - a.solved || b.points - a.points);
    }
    const excluded = [];
    for (const [id, e] of round.players) {
      if ([PLAYER_STATUS.ERROR, PLAYER_STATUS.TIMEOUT, PLAYER_STATUS.ABSENT].includes(e.status)) {
        excluded.push({ playerId: id, reason: e.status, code: e.errorCode });
      }
    }
    const song = round.song;
    const record = {
      roundIndex: this.roundIndex,
      videoId: song.videoId,
      segmentStart: round.segmentStart, // 결과 화면에서 들었던 구간부터 다시 듣기
      title: song.title,
      animeName: song.anime?.name ?? null,
      reason,
      correctPlayers,
      excluded,
      ...(round.items ? { items: round.items, partialPlayers } : {}),
    };
    this.history.push(record);
    this.recentVideoIds = addRecent(this.recentVideoIds, song.videoId, this.config.recentSongsLimit);
    this.phase = ROOM_PHASE.REVEALED;
    round.revealEndsAt = this.now() + this.revealMs;
    const stats = this.recordSongStats(round);

    const willContinue = this.hasNext && this.connectedMembers.length >= this.config.minPlayers;
    this.broadcast({
      type: 'reveal',
      roundId: round.id,
      ...record,
      ...(stats ? { stats } : {}),
      song: { videoId: song.videoId, title: song.title, anime: song.anime?.name ?? null, artist: song.artist ?? null, type: song.type ?? null },
      scores: this.members.map((p) => ({ playerId: p.id, score: p.score })),
      nextVideoId: willContinue ? this.queue[0].videoId : null,
      hasNext: willContinue,
      nextAt: round.revealEndsAt, // 다음 라운드(또는 결과)로 넘어가는 서버 시각. 전원이 넘기기에 투표하면 더 빨라진다
    });
    this.broadcastState();
    if (this.connectedMembers.length === 0) {
      this.stall();
      return;
    }
    this.setTimer('reveal', this.revealMs, () => this.advance());
  }

  // ---------- 정답 공개 중: 넘기기 투표·리액션 ----------
  /** 넘기기 투표. 접속한 사람 전원이 투표하면 공개 시간을 기다리지 않고 넘어간다 */
  onSkip(player, message) {
    const round = this.round;
    if (this.phase !== ROOM_PHASE.REVEALED || !round || message.roundId !== round.id || round.skipVotes.has(player.id)) return;
    round.skipVotes.add(player.id);
    if (this.checkSkipVotes()) return;
    this.broadcastState();
  }

  /** 접속한 사람이 모두 넘기기에 투표했으면 다음으로 넘어간다. 넘어갔으면 true */
  checkSkipVotes() {
    const round = this.round;
    if (this.phase !== ROOM_PHASE.REVEALED || !round || round.skipVotes.size === 0) return false;
    const connected = this.connectedMembers;
    if (connected.length === 0 || !connected.every((p) => round.skipVotes.has(p.id))) return false;
    this.clearTimer('reveal');
    this.advance();
    return true;
  }

  /** 이모지 리액션: 정답 공개 중에만, 목록에 있는 이모지만, 한 사람당 reactionCooldownMs 간격 */
  onReact(player, message) {
    if (this.phase !== ROOM_PHASE.REVEALED || !isReaction(message.emoji)) return;
    const now = this.now();
    if (player.lastReactionAt != null && now - player.lastReactionAt < this.config.reactionCooldownMs) return;
    player.lastReactionAt = now;
    this.broadcast({ type: 'reaction', playerId: player.id, emoji: message.emoji, at: now });
  }

  advance() {
    if (this.phase !== ROOM_PHASE.REVEALED) return;
    if (!this.hasNext || this.connectedMembers.length < this.config.minPlayers) {
      this.gameOver(this.hasNext ? 'not-enough-players' : 'complete');
      return;
    }
    this.beginRound();
  }

  gameOver(reason = 'complete') {
    this.clearRoundTimers();
    this.phase = ROOM_PHASE.RESULTS;
    this.stalled = false;
    const ranking = rankPlayers([...this.players.values()]).map((p) => ({
      playerId: p.id,
      nickname: p.nickname,
      score: p.score,
      correct: p.correct,
      rank: p.rank,
      left: p.left,
    }));
    this.broadcast({ type: 'gameOver', reason, ranking, history: this.history });
    this.broadcastState();
  }

  // ---------- 이탈 처리 ----------
  markAbsentInRound(player) {
    if (!this.round || !this.isInGame || this.phase === ROOM_PHASE.REVEALED) return;
    const entry = this.round.players.get(player.id);
    if (entry && [PLAYER_STATUS.PREPARING, PLAYER_STATUS.READY].includes(entry.status)) entry.status = PLAYER_STATUS.ABSENT;
  }

  /** 누가 끊기거나 나간 뒤 호출: 남은 사람 수에 맞게 진행을 이어 간다 */
  afterPlayerGone() {
    if (!this.isInGame) return;
    if (this.connectedMembers.length === 0) {
      this.stall();
      return;
    }
    if (this.phase === ROOM_PHASE.PREPARING) this.evaluatePrep();
    else if (this.phase === ROOM_PHASE.STARTING || this.phase === ROOM_PHASE.ANSWERING) this.checkAllDone();
    else if (this.phase === ROOM_PHASE.REVEALED) this.checkSkipVotes(); // 남은 사람이 모두 투표했을 수 있다
  }

  /** 접속한 사람이 아무도 없다: 타이머를 멈추고 재접속(또는 유예 만료로 방 삭제)을 기다린다 */
  stall() {
    this.clearRoundTimers();
    this.stalled = true;
  }
}
