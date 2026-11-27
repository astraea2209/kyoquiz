// 온라인 대결 화면(입장, 대기실, 게임, 결과). 규칙은 서버가, 상태 정리는 session.js가 맡고 여기는 DOM만 다룬다.
// 화면 전환은 기존 App.showScreen을 그대로 쓴다(data-screen 이름: online-entry/lobby/game/result).

import { MODE } from '../game.js';
import { DIFFICULTY, formatHint } from '../judge.js';
import { SCORING, parseRounds } from '../scoring.js';
import { RoomConnection } from './connection.js';
import { buildInviteLink, resolveServerUrl, roomsUrl, webSocketUrl } from './config.js';
import { ClockSync } from './net.js';
import { OnlinePlayback, PLAYBACK_STAGE } from './playback.js';
import { REACTIONS } from './reactions.js';
import { STICKERS, stickerById } from './stickers.js';
import { CHAT_LIMITS, OnlineSession, playerColor } from './session.js';
import { handleGameKey } from '../hotkeys.js';
import { youtubeWatchUrl } from '../linkParser.js';
import { bindVolumeInput } from '../volume.js';
import { formatStatsSummary, itemRate } from '../songStats.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MODE_LABEL = { [MODE.RANDOM]: '랜덤듣기', [MODE.FULL]: '전체듣기' };
const DIFFICULTY_LABEL = {
  [DIFFICULTY.EASY]: '쉬움',
  [DIFFICULTY.NORMAL]: '보통',
  [DIFFICULTY.HARD]: '어려움',
  [DIFFICULTY.EXTREME]: '매우 어려움',
};
const ITEM_LABEL = { title: '제목', artist: '가수', anime: '작품명' };
const itemNames = (keys) => keys.map((key) => ITEM_LABEL[key]).join(', ');
const STATUS_CHIP = {
  correct: '정답',
  passed: '패스',
  exhausted: '기회 소진',
  error: '재생 오류',
  timeout: '준비 지연',
  absent: '쉬는 중',
};
// 순위판 상태 칩 색(css .chip.st-*)
const STATUS_CLASS = {
  correct: 'st-correct',
  passed: 'st-passed',
  exhausted: 'st-exhausted',
  error: 'st-off',
  timeout: 'st-off',
  absent: 'st-off',
};
const REASON_TEXT = {
  timeout: '시간 초과 — 아무도 맞히지 못했어요',
  done: '모두 패스하거나 기회를 다 썼어요',
};
const GAME_OVER_NOTE = {
  'not-enough-players': '남은 인원이 부족해 게임을 마쳤습니다.',
  'no-playable': '재생할 수 있는 곡이 없어 게임을 진행하지 못했습니다.',
  'playback-failed': '곡을 연달아 재생하지 못해 게임을 멈췄습니다. 인터넷 연결이나 브라우저 설정(광고 차단 등)을 확인한 뒤 다시 시작해 주세요.',
};
// 한 번에 화면에 떠 있는 리액션 최대 개수(많이 누르면 오래된 것부터 지운다)
const MAX_FLOATING_REACTIONS = 24;
// 이 이유로 닫힐 때는 서버가 보낸 오류 메시지를 이미 보여 줬다
const QUIET_CLOSE = ['left', 'game-started', 'room-full', 'bad-nickname'];
const CLOSE_TEXT = {
  kicked: '다른 탭에서 같은 방에 입장해 이 연결은 종료됐습니다.',
  'gave-up': '서버와 연결이 오래 끊겨 방에서 나갔습니다.',
  'room-closed': '방이 닫혔습니다.',
  'rate-limit': '메시지를 너무 빨리 보내 연결이 끊겼습니다.',
};

const CHAT_BLOCKED_TEXT = {
  answer: '정답이 들어간 채팅은 정답 공개 뒤에 보낼 수 있어요.',
  rate: '채팅을 너무 빨리 보내고 있어요. 잠시 뒤에 보내 주세요.',
};

const NICKNAME_KEY = 'asq.nickname';
const SESSION_KEY = 'asq.online';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/** 결과 기록의 곡 제목. 누르면 새 탭에서 YouTube로 들었던 구간부터 다시 듣는다 */
function songLink(title, videoId, startSeconds) {
  const href = youtubeWatchUrl(videoId, startSeconds);
  if (!href) return title;
  return el('a', { class: 'song-link', href, target: '_blank', rel: 'noopener noreferrer', title: 'YouTube에서 다시 듣기(새 탭)', text: title });
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 설정 그룹 정의: [키, 라벨, [[값, 라벨], …]] */
const SETTING_GROUPS = [
  ['mode', '모드', [[MODE.RANDOM, '랜덤듣기'], [MODE.FULL, '전체듣기']]],
  ['clipLength', '구간 길이', SCORING.clipLengths.map((n) => [n, `${n}초`])],
  ['answerTime', '답변 시간', SCORING.multi.answerTimes.map((n) => [n, `${n}초`])], // 랜덤듣기: 구간이 끝난 뒤
  ['fullTime', '제한 시간', SCORING.multi.fullTimes.map((n) => [n, `${n}초`])], // 전체듣기
  ['revealTime', '정답 공개', SCORING.multi.revealTimes.map((n) => [n, `${n}초`])],
  ['rounds', '라운드', SCORING.roundOptions.map((n) => [n, `${n}`])],
  ['difficulty', '난이도', [[DIFFICULTY.EASY, '쉬움'], [DIFFICULTY.NORMAL, '보통'], [DIFFICULTY.HARD, '어려움'], [DIFFICULTY.EXTREME, '매우 어려움']]],
];

export class OnlineApp {
  /**
   * @param {object} opts
   * @param {object} opts.app  기존 App(showScreen, toast 사용)
   * @param {(element: string) => Promise<object>} opts.createPlayer  YouTube 플레이어 생성(js/player.js)
   * @param {Storage} opts.storage  localStorage(닉네임·서버 주소)
   * @param {Location} opts.location
   * @param {import('../volume.js').VolumeControl} [opts.volume]  노래 볼륨(개인전과 공유)
   */
  constructor({ app, createPlayer, storage, location, volume = null }) {
    this.volume = volume;
    this.app = app;
    this.createPlayer = createPlayer;
    this.storage = storage;
    this.location = location;
    this.serverUrl = resolveServerUrl({ search: location.search, hostname: location.hostname, storage });
    this.clock = new ClockSync();
    this.players = null;
    this.playback = null;
    this.connection = null;
    this.session = null;
    this.busy = false;
    this.joined = false;
    this.renderedRoundId = null;
    this.ticker = null;
    this.chat = null; // 채팅 패널(대기실·게임·결과 화면을 옮겨 다닌다)
    this.renderedChatVersion = -1;
    this.pendingChat = null; // 방금 보낸 채팅(정답이 들어가 막히면 입력칸에 되돌린다)
    this.handledChatBlock = null;
  }

  init() {
    const root = document.body;
    const toasts = $('#toasts');
    for (const section of [this.buildEntry(), this.buildLobby(), this.buildGame(), this.buildResult()]) {
      root.insertBefore(section, toasts);
    }
    root.insertBefore(
      el('div', { id: 'on-conn-banner', class: 'banner warn conn-banner', hidden: true, role: 'status', text: '연결이 끊겼어요. 다시 연결하는 중…' }),
      $('#screen-start'),
    );
    this.bindEntry();
    this.chat = this.buildChat();
    // 단축키: K = 패스(정답 공개 중에는 넘기기 투표), Esc = 입력칸 빠져나오기, ↑↓ = 볼륨
    document.addEventListener('keydown', (event) => {
      if (this.app.screen !== 'online-game' || !this.session) return;
      handleGameKey(event, {
        pass: () => !$('#on-pass').disabled && !!this.session?.pass(),
        next: () => !$('#on-skip').disabled && !!this.session?.skip(),
        choose: (index) => {
          const btn = $$('#on-choices .btn')[index];
          if (!btn || btn.disabled || $('#on-choices').hidden || $('#on-answer-area').hidden) return false;
          btn.click();
          return true;
        },
        volume: this.volume ? (delta) => this.volume.set(this.volume.value + delta) : null,
        toggleInput: (target) => {
          const answer = $('#on-answer-input');
          const chat = $('#on-chat-input');
          if (target === answer && chat?.isConnected) {
            chat.focus();
            return true;
          }
          if (target === chat && this.answerInputUsable()) {
            answer.focus();
            return true;
          }
          return false;
        },
      });
    });
  }

  /** 답 입력칸에 지금 글을 쓸 수 있는지(보이고 잠기지 않음) */
  answerInputUsable() {
    return !$('#on-answer-input').disabled && !$('#on-answer-form').hidden && !$('#on-answer-area').hidden;
  }

  /** 채팅 입력칸에 포커스(볼륨 조절 중이면 뺏지 않는다) */
  focusChat() {
    const chat = $('#on-chat-input');
    const active = document.activeElement;
    if (!chat?.isConnected || active === chat || active?.matches?.('[data-volume]')) return;
    chat.focus();
  }

  /** 볼륨 슬라이더. 개인전 화면과 같은 VolumeControl을 공유한다 */
  volumeRow() {
    return el('div', { class: 'volume-row' }, this.volumeControl('볼륨'));
  }

  /** 볼륨 슬라이더 하나(게임 화면 머리줄에서는 아이콘만) */
  volumeControl(label = '🔊') {
    const input = el('input', { type: 'range', min: '0', max: '100', step: '1', 'data-volume': true, 'aria-label': '노래 볼륨', 'aria-keyshortcuts': 'ArrowUp ArrowDown' });
    const value = el('span', { class: 'volume-value', 'aria-hidden': 'true' });
    if (this.volume) bindVolumeInput(this.volume, input, value);
    return el('label', { class: 'volume-control', title: '게임 중 ↑↓ 키로도 조절' }, el('span', { class: 'volume-label', text: label, 'aria-hidden': 'true' }), input, value);
  }

  // ---------- 진입 ----------
  /** 시작 화면의 "친구와 대결" 버튼, 또는 초대 링크(?room=)로 들어왔을 때 */
  open({ code = null } = {}) {
    this.app.showScreen('online-entry');
    const saved = this.savedSession();
    if (code) $('#on-code').value = code;
    this.renderEntry();
    // 새로고침 등으로 끊겼던 같은 방이면 저장된 토큰으로 바로 돌아간다
    if (saved && code && saved.code === code && saved.server === this.serverUrl) {
      this.enter({ code, nickname: saved.nickname, token: saved.token });
    }
  }

  savedSession() {
    return safe(() => JSON.parse(sessionStorage.getItem(SESSION_KEY)));
  }

  saveSession(data) {
    safe(() => sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)));
  }

  clearSession() {
    safe(() => sessionStorage.removeItem(SESSION_KEY));
  }

  buildEntry() {
    return el(
      'section',
      { id: 'screen-online-entry', class: 'screen', 'data-screen': 'online-entry', hidden: true },
      el('div', { class: 'manage-header' }, el('h1', { text: '친구와 대결' }), el('button', { type: 'button', class: 'btn small', id: 'on-entry-back', text: '← 시작 화면' })),
      el('p', { class: 'sub', text: '방을 만들고 코드나 링크를 공유하면 친구들이 들어옵니다. 같은 곡을 동시에 듣고 맞힌 사람은 모두 점수를 받아요. 빨리 맞힐수록 점수가 높아요.' }),
      el('label', { class: 'field' }, '닉네임', el('input', { id: 'on-nickname', maxlength: '12', autocomplete: 'off', placeholder: '최대 12글자' })),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn primary big', id: 'on-create', text: '방 만들기' })),
      el('h2', { text: '코드로 입장' }),
      el(
        'form',
        { id: 'on-join-form', class: 'answer-form', autocomplete: 'off' },
        el('input', { id: 'on-code', maxlength: '5', autocapitalize: 'characters', placeholder: '방 코드 5자리', 'aria-label': '방 코드' }),
        el('button', { type: 'submit', class: 'btn primary', id: 'on-join', text: '입장' }),
      ),
      el('p', { class: 'status', id: 'on-entry-status', role: 'status' }),
    );
  }

  bindEntry() {
    const nickname = $('#on-nickname');
    nickname.value = safe(() => this.storage.getItem(NICKNAME_KEY), '') ?? '';
    $('#on-entry-back').addEventListener('click', () => this.app.showScreen('start'));
    $('#on-create').addEventListener('click', () => this.enter({ create: true, nickname: nickname.value }));
    $('#on-join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.enter({ code: $('#on-code').value.trim().toUpperCase(), nickname: nickname.value });
    });
    $('#on-code').addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase();
    });
  }

  renderEntry(status = null) {
    const configured = !!this.serverUrl;
    $('#on-create').disabled = !configured || this.busy;
    $('#on-join').disabled = !configured || this.busy;
    $('#on-entry-status').textContent =
      status ??
      (configured
        ? ''
        : '서버 주소가 설정되지 않았습니다. js/online/config.js의 DEFAULT_SERVER_URL을 채우거나 주소 끝에 ?server=https://… 를 붙여 열어 주세요.');
  }

  // ---------- 연결 ----------
  async ensurePlayers() {
    if (this.playback) return;
    const results = await Promise.allSettled([this.createPlayer('online-player-0'), this.createPlayer('online-player-1')]);
    const players = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!players.length) throw new Error('YouTube 플레이어를 준비하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    this.players = players;
    this.volume?.attach(players);
    this.playback = new OnlinePlayback({
      players,
      clock: this.clock,
      send: (message) => this.connection?.send(message),
    });
    this.playback.onChange(() => this.render());
  }

  /** 입장 버튼 클릭 안에서 시작한다(소리 켜기를 위한 사용자 동작 확보) */
  async enter({ create = false, code = null, nickname = '', token = null }) {
    if (this.busy) return;
    const name = String(nickname ?? '').trim();
    if (!name) {
      this.app.toast('닉네임을 입력해 주세요.');
      return;
    }
    if (!create && !/^[A-HJ-NP-Z2-9]{5}$/.test(code ?? '')) {
      this.app.toast('방 코드 5자리를 입력해 주세요.');
      return;
    }
    safe(() => this.storage.setItem(NICKNAME_KEY, name));
    this.busy = true;
    this.renderEntry('연결 중…');
    try {
      await this.ensurePlayers();
      if (create) {
        const res = await fetch(roomsUrl(this.serverUrl), { method: 'POST' });
        if (!res.ok) throw new Error('방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
        code = (await res.json()).code;
      }
      this.connect({ code, nickname: name, token });
    } catch (error) {
      this.busy = false;
      this.renderEntry();
      this.app.toast(error.message || '연결하지 못했습니다.');
    }
  }

  connect({ code, nickname, token }) {
    this.teardownConnection();
    this.clock.reset();
    this.joined = false;
    this.renderedRoundId = null;
    this.renderedChatVersion = -1;
    this.pendingChat = null;
    this.handledChatBlock = null;
    this.revealFocusedRound = null; // 방마다 라운드 번호가 1부터라 새로 들어가면 지운다
    this.correctFocusedRound = null;
    const connection = new RoomConnection({ url: webSocketUrl(this.serverUrl, code), clock: this.clock });
    const session = new OnlineSession({ connection, playback: this.playback, clock: this.clock });
    this.connection = connection;
    this.session = session;
    session.on('change', () => this.render());
    session.on('notice', (message) => this.app.toast(message));
    session.on('error', (message) => this.app.toast(message.message || '요청을 처리하지 못했습니다.'));
    session.on('reaction', (reaction) => this.showReaction(reaction));
    connection.on('message', (message) => {
      if (message.type === 'joined') this.handleJoined(message, nickname);
    });
    connection.on('status', ({ status, reason }) => this.handleStatus(status, reason));
    connection.connect(nickname, token);
  }

  handleJoined(message, nickname) {
    this.joined = true;
    this.busy = false;
    this.saveSession({ server: this.serverUrl, code: message.code, nickname, token: this.connection.token });
    // 새로고침해도 같은 방으로 돌아올 수 있게 주소에 방 코드를 남긴다
    safe(() => history.replaceState(null, '', buildInviteLink(this.location, message.code)));
    this.render();
  }

  handleStatus(status, reason) {
    $('#on-conn-banner').hidden = status !== 'reconnecting';
    if (status !== 'closed') return;
    const wasJoined = this.joined;
    if (reason === 'left') return;
    this.teardownConnection();
    this.busy = false;
    if (!QUIET_CLOSE.includes(reason)) {
      this.app.toast(CLOSE_TEXT[reason] ?? (wasJoined ? '연결이 종료되었습니다.' : '방에 연결하지 못했습니다. 방 코드와 서버 주소를 확인해 주세요.'));
    }
    this.clearSession();
    this.app.showScreen(wasJoined ? 'start' : 'online-entry');
    if (!wasJoined) this.renderEntry();
  }

  teardownConnection() {
    this.stopTicker();
    this.session?.dispose();
    this.connection?.close?.();
    this.playback?.stop();
    this.session = null;
    this.connection = null;
    $('#on-conn-banner').hidden = true;
  }

  leave({ ask = false } = {}) {
    if (ask && !confirm('방에서 나갈까요?')) return;
    this.session?.leave();
    this.clearSession();
    this.teardownConnection();
    this.joined = false;
    safe(() => history.replaceState(null, '', this.location.pathname));
    this.app.showScreen('start');
  }

  // ---------- 화면 전환 ----------
  render() {
    const session = this.session;
    if (!session?.room || !this.joined) return;
    const phase = session.phase;
    const target = phase === 'lobby' ? 'online-lobby' : phase === 'results' ? 'online-result' : 'online-game';
    if (this.app.screen !== target) this.app.showScreen(target);
    if (target === 'online-game') this.startTicker();
    else this.stopTicker();
    this.renderChat(target);
    if (target === 'online-lobby') this.renderLobby();
    else if (target === 'online-result') this.renderResult();
    else this.renderGame();
  }

  startTicker() {
    if (this.ticker != null) return;
    this.ticker = setInterval(() => this.renderGame(), 200);
  }

  stopTicker() {
    if (this.ticker == null) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  // ---------- 채팅 ----------
  buildChat() {
    const input = el('input', {
      id: 'on-chat-input',
      type: 'text',
      maxlength: String(CHAT_LIMITS.maxLength),
      enterkeyhint: 'send',
      placeholder: '채팅 (정답은 공개 뒤에)',
      'aria-label': '채팅 입력',
      oninput: () => {
        $('#on-chat-status').textContent = '';
      },
    });
    const picker = el(
      'div',
      { id: 'on-sticker-picker', class: 'sticker-picker', role: 'group', 'aria-label': '이모지', hidden: true },
      ...STICKERS.map((sticker) =>
        el(
          'button',
          { type: 'button', class: 'sticker-btn', title: sticker.label, 'aria-label': `${sticker.label} 이모지 보내기`, onclick: () => this.sendSticker(sticker.id) },
          el('img', { src: sticker.src, alt: '', width: '56', height: '56', loading: 'lazy' }),
        ),
      ),
    );
    const toggle = el('button', {
      type: 'button',
      id: 'on-sticker-toggle',
      class: 'btn sticker-toggle',
      text: '😀',
      title: '이모지',
      'aria-label': '이모지 열기',
      'aria-expanded': 'false',
      'aria-controls': 'on-sticker-picker',
      onclick: () => this.toggleStickerPicker(),
    });
    return el(
      'div',
      { class: 'chat', id: 'on-chat' },
      el('ul', { id: 'on-chat-log', class: 'chat-log', 'aria-label': '채팅', 'aria-live': 'polite', 'data-empty': '아직 채팅이 없어요' }),
      el('p', { id: 'on-chat-status', class: 'chat-status', role: 'status' }),
      picker,
      el(
        'form',
        { id: 'on-chat-form', class: 'answer-form chat-form', autocomplete: 'off', onsubmit: (event) => this.submitChat(event) },
        input,
        toggle,
        el('button', { type: 'submit', class: 'btn', text: '보내기' }),
      ),
    );
  }

  toggleStickerPicker(open) {
    const picker = $('#on-sticker-picker');
    const show = open ?? picker.hidden;
    picker.hidden = !show;
    $('#on-sticker-toggle').setAttribute('aria-expanded', String(show));
  }

  sendSticker(id) {
    const result = this.session?.sendSticker(id);
    if (result === 'sent') {
      $('#on-chat-status').textContent = '';
      this.toggleStickerPicker(false);
    } else if (result === 'rate') {
      $('#on-chat-status').textContent = CHAT_BLOCKED_TEXT.rate;
    }
  }

  submitChat(event) {
    event.preventDefault();
    const input = $('#on-chat-input');
    const result = this.session?.sendChat(input.value);
    if (result === 'sent') {
      this.pendingChat = input.value;
      input.value = '';
      $('#on-chat-status').textContent = '';
    } else if (result === 'rate') {
      $('#on-chat-status').textContent = CHAT_BLOCKED_TEXT.rate;
    }
  }

  /** 채팅 패널을 지금 화면으로 옮기고, 새 채팅이 있으면 목록을 다시 그린다 */
  renderChat(screen) {
    const s = this.session;
    const slot = $(`#screen-${screen} .chat-slot`);
    if (slot && this.chat.parentNode !== slot) slot.append(this.chat);
    const log = $('#on-chat-log');
    if (this.renderedChatVersion !== s.chatVersion) {
      this.renderedChatVersion = s.chatVersion;
      // 위로 올려 예전 채팅을 읽는 중이 아니면 맨 아래(새 채팅)로 내린다
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      const lastMine = s.chat.at(-1)?.playerId === s.you;
      log.replaceChildren(
        ...s.chat.map((m) => {
          const sticker = m.sticker ? stickerById(m.sticker) : null;
          return el(
            'li',
            { class: [m.playerId === s.you ? 'me' : '', sticker ? 'chat-sticker-line' : ''].filter(Boolean).join(' ') },
            el('span', { class: 'chat-name', text: m.nickname, style: `color: ${playerColor(m.playerId)}` }),
            sticker
              ? el('img', { class: 'chat-sticker', src: sticker.src, alt: `(${sticker.label} 이모지)`, title: sticker.label, width: '72', height: '72' })
              : el('span', { class: 'chat-text', text: m.text }),
          );
        }),
      );
      if (atBottom || lastMine) log.scrollTop = log.scrollHeight;
    }
    const blocked = s.chatBlocked;
    if (blocked && blocked !== this.handledChatBlock) {
      this.handledChatBlock = blocked;
      $('#on-chat-status').textContent = CHAT_BLOCKED_TEXT[blocked.reason] ?? '채팅을 보내지 못했어요.';
      // 정답이 들어가 막힌 글은 지우지 않고 입력칸에 돌려준다(공개 뒤에 그대로 보낼 수 있게)
      const input = $('#on-chat-input');
      if (blocked.reason === 'answer' && this.pendingChat && !input.value) input.value = this.pendingChat;
    }
  }

  // ---------- 대기실 ----------
  buildLobby() {
    const groups = SETTING_GROUPS.map(([key, label, options]) =>
      el(
        'fieldset',
        { class: 'segmented', id: `on-set-${key}` },
        el('legend', { text: label }),
        ...options.map(([value, text]) =>
          el(
            'label',
            {},
            el('input', {
              type: 'radio',
              name: `on-${key}`,
              value: String(value),
              onchange: () => this.session?.setSettings({ [key]: value }),
            }),
            el('span', { text }),
          ),
        ),
        ...(key === 'rounds' ? [this.customRoundsInput()] : []),
      ),
    );
    return el(
      'section',
      { id: 'screen-online-lobby', class: 'screen screen-wide', 'data-screen': 'online-lobby', hidden: true },
      el('div', { class: 'manage-header' }, el('h1', { text: '대기실' }), el('button', { type: 'button', class: 'btn small ghost', id: 'on-leave-lobby', text: '방 나가기', onclick: () => this.leave() })),
      el(
        'div',
        { class: 'two-col' },
        el(
          'div',
          { class: 'col-main' },
          el(
            'div',
            { class: 'room-code-box' },
            el('span', { class: 'sub', text: '방 코드' }),
            el('strong', { id: 'on-room-code', class: 'room-code' }),
            el('button', { type: 'button', class: 'btn small', id: 'on-copy', text: '🔗 초대 링크 복사', onclick: () => this.copyInvite() }),
          ),
          el('h2', {}, '설정 ', el('span', { id: 'on-settings-note', class: 'sub' })),
          el('div', { class: 'settings', id: 'on-settings' }, ...groups, this.volumeRow()),
          el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn primary big', id: 'on-start', text: '게임 시작', onclick: () => this.session?.start() })),
          el('p', { class: 'status', id: 'on-lobby-hint' }),
        ),
        el(
          'aside',
          { class: 'col-side panel' },
          el('h2', { class: 'panel-title' }, '참가자 ', el('span', { class: 'panel-meta', id: 'on-member-count' })),
          el('ul', { id: 'on-members', class: 'member-list' }),
          el('div', { class: 'chat-slot' }),
        ),
      ),
    );
  }

  /** 라운드 수 직접 입력(1~100). 입력을 마치면 방장 설정으로 보낸다 */
  customRoundsInput() {
    const input = el('input', {
      type: 'number',
      id: 'on-rounds-custom',
      min: String(SCORING.roundLimits.min),
      max: String(SCORING.roundLimits.max),
      step: '1',
      inputmode: 'numeric',
      placeholder: '직접',
      'aria-label': `라운드 수 직접 입력(${SCORING.roundLimits.min}~${SCORING.roundLimits.max})`,
      onchange: () => {
        const rounds = parseRounds(input.value);
        if (rounds == null) {
          this.renderLobby(); // 지우거나 숫자가 아니면 현재 방 설정으로 되돌린다
          return;
        }
        input.value = rounds;
        this.session?.setSettings({ rounds });
      },
    });
    return el('label', { class: 'segmented-number' }, input);
  }

  copyInvite() {
    const link = buildInviteLink(this.location, this.session.code);
    const done = () => this.app.toast('초대 링크를 복사했어요. 친구에게 보내 주세요.');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => prompt('링크를 복사해 주세요', link));
    else prompt('링크를 복사해 주세요', link);
  }

  renderLobby() {
    const s = this.session;
    const room = s.room;
    $('#on-room-code').textContent = room.code;
    $('#on-members').replaceChildren(
      ...room.players
        .filter((p) => !p.left)
        .map((p) =>
          el(
            'li',
            { class: p.connected ? '' : 'off' },
            el('span', { class: 'name', text: p.nickname, style: `color: ${playerColor(p.id)}` }),
            p.isHost ? el('span', { class: 'chip host', text: '방장' }) : '',
            p.id === s.you ? el('span', { class: 'chip me', text: '나' }) : '',
            p.connected ? '' : el('span', { class: 'chip', text: '연결 끊김' }),
          ),
        ),
    );
    const isHost = s.isHost;
    $('#on-settings-note').textContent = isHost ? '' : '(방장이 정합니다)';
    const full = room.settings.mode === MODE.FULL;
    for (const [key] of SETTING_GROUPS) {
      const fieldset = $(`#on-set-${key}`);
      // 답변 시간은 모드마다 따로: 랜덤듣기는 구간 뒤 답변 시간, 전체듣기는 제한 시간
      fieldset.hidden = (key === 'answerTime' && full) || (key === 'fullTime' && !full);
      fieldset.disabled = !isHost || (key === 'clipLength' && full);
      for (const input of $$('input[type="radio"]', fieldset)) input.checked = input.value === String(room.settings[key]);
    }
    // 빠른 선택에 없는 라운드 수는 직접 입력칸에 보인다(입력 중이면 건드리지 않는다)
    const custom = $('#on-rounds-custom');
    if (document.activeElement !== custom) {
      custom.value = SCORING.roundOptions.includes(room.settings.rounds) ? '' : room.settings.rounds;
    }
    const connected = room.players.filter((p) => p.connected && !p.left).length;
    $('#on-member-count').textContent = `${connected} / ${SCORING.multi.maxPlayers}`;
    const enough = connected >= SCORING.multi.minPlayers;
    const start = $('#on-start');
    start.hidden = !isHost;
    start.disabled = !enough;
    $('#on-lobby-hint').textContent = isHost
      ? enough
        ? '준비되면 시작하세요. 시작한 뒤에 들어온 사람은 다음 라운드부터 함께해요.'
        : `${SCORING.multi.minPlayers}명 이상 모이면 시작할 수 있어요.`
      : '방장이 시작하길 기다리는 중…';
  }

  // ---------- 게임 ----------
  buildGame() {
    return el(
      'section',
      { id: 'screen-online-game', class: 'screen screen-wide keep-alive', 'data-screen': 'online-game' },
      el(
        'div',
        { class: 'game-header' },
        el('span', { id: 'on-round-label', class: 'pill' }),
        el('span', { id: 'on-mode-label', class: 'pill muted' }),
        el('span', { id: 'on-score-label', class: 'score' }),
        el('button', { type: 'button', class: 'btn small ghost', id: 'on-quit', text: '나가기', onclick: () => this.leave({ ask: true }) }),
      ),
      el('div', { class: 'game-layout' }, this.buildGameMain(), this.buildGameSide()),
    );
  }

  /** 대결 게임 화면 오른쪽: 순위판과 채팅 */
  buildGameSide() {
    return el(
      'aside',
      { class: 'game-side panel' },
      el('h2', { class: 'panel-title', text: '순위' }),
      el('ol', { id: 'on-board', class: 'scoreboard' }),
      el('div', { class: 'chat-slot' }),
    );
  }

  /** 대결 게임 화면 왼쪽: 무대, 남은 시간, 답 입력, 정답 공개 */
  buildGameMain() {
    return el(
      'div',
      { class: 'game-main' },
      el(
        'div',
        { class: 'stage' },
        el('div', { class: 'player-slot', id: 'on-slot-0' }, el('div', { id: 'online-player-0' })),
        el('div', { class: 'player-slot', id: 'on-slot-1' }, el('div', { id: 'online-player-1' })),
        el(
          'div',
          { class: 'overlay', id: 'on-overlay' },
          el('div', { class: 'eq', id: 'on-eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'), el('i')),
          el('p', { id: 'on-overlay-text', class: 'overlay-text' }),
          // 초성 힌트(매우 어려움이 아닐 때): 정답 영상이 뜨는 무대 가운데에 크게
          el('p', { class: 'overlay-hint', id: 'on-overlay-hint', 'aria-live': 'polite', hidden: true }, el('strong', { id: 'on-overlay-hint-text' }), el('span', { text: '제목 초성' })),
        ),
        // 정답 공개 중 이모지 리액션이 떠오르는 자리(영상 위)
        el('div', { class: 'reaction-layer', id: 'on-reaction-layer', 'aria-hidden': 'true' }),
      ),
      el('div', { class: 'progress', 'aria-label': '남은 시간' }, el('div', { class: 'progress-bar', id: 'on-progress-bar' })),
      // 영상 바로 아래: 남은 시간과 볼륨
      el('div', { class: 'stage-meta' }, el('p', { class: 'progress-label', id: 'on-progress-label' }), this.volumeControl()),
      // 매우 어려움: 내가 맞힌 항목. 정답 공개 중에도 보여 준다
      el('ul', { id: 'on-extreme-items', class: 'extreme-items', 'aria-label': '맞힌 항목', hidden: true }),
      el(
        'div',
        { id: 'on-answer-area' },
        // 힌트·패스 버튼과 입력칸을 한 줄로(개인전과 같은 배치)
        el(
          'div',
          { class: 'answer-row' },
          el(
            'div',
            { class: 'controls' },
            el('button', { type: 'button', class: 'btn', id: 'on-hint', text: '초성 힌트 (-50%)', title: '곡 제목(매우 어려움은 가수·작품명도)의 초성을 나에게만 보여 줍니다. 이후 맞히면 점수가 절반', onclick: () => this.requestHint() }),
            el('button', { type: 'button', class: 'btn ghost', id: 'on-pass', text: '패스 (K)', title: '단축키 K. 입력칸에 있을 때는 Esc를 누른 뒤 K', 'aria-keyshortcuts': 'K', onclick: () => this.session?.pass() }),
          ),
          el(
            'form',
            { id: 'on-answer-form', class: 'answer-form', autocomplete: 'off', onsubmit: (event) => this.submitAnswer(event) },
            el('input', { id: 'on-answer-input', type: 'text', enterkeyhint: 'done', placeholder: '곡 제목 또는 작품명', 'aria-label': '정답 입력' }),
            el('button', { type: 'submit', class: 'btn primary', text: '제출' }),
          ),
        ),
        el('div', { class: 'choices', id: 'on-choices' }),
        el('div', { class: 'answer-meta' }, el('p', { class: 'attempts', id: 'on-attempts' }), el('p', { class: 'feedback', id: 'on-feedback', role: 'status' })),
      ),
      el(
        'div',
        { id: 'on-reveal', class: 'reveal', hidden: true },
        // 넓은 화면에서는 왼쪽 곡 정보, 오른쪽 리액션·넘기기
        el(
          'div',
          { class: 'reveal-info' },
          el('p', { class: 'reveal-result', id: 'on-reveal-result' }),
          el('h2', { id: 'on-reveal-title' }),
          el('p', { id: 'on-reveal-anime' }),
          el('p', { class: 'sub', id: 'on-reveal-stats' }),
          el('p', { class: 'sub', id: 'on-reveal-excluded' }),
        ),
        el(
          'div',
          { class: 'reveal-actions' },
          el(
            'div',
            { class: 'reactions', role: 'group', 'aria-label': '리액션 보내기' },
            ...REACTIONS.map((emoji) =>
              el('button', { type: 'button', class: 'btn reaction-btn', text: emoji, 'aria-label': `${emoji} 보내기`, onclick: () => this.session?.react(emoji) }),
            ),
          ),
          el(
            'div',
            { class: 'reveal-next' },
            el('p', { class: 'sub', id: 'on-reveal-next', role: 'status' }),
            el('button', {
              type: 'button',
              class: 'btn primary',
              id: 'on-skip',
              title: '단축키 K(채팅 입력칸에서는 Esc를 누른 뒤 K). 모두 누르면 기다리지 않고 바로 넘어가요',
              'aria-keyshortcuts': 'K',
              onclick: () => this.session?.skip(),
            }),
          ),
        ),
      ),
    );
  }

  /** 받은 리액션을 영상 위에 잠깐 띄운다(보낸 사람 이름 색과 함께) */
  showReaction({ playerId, emoji }) {
    const layer = $('#on-reaction-layer');
    if (!layer || this.app.screen !== 'online-game') return;
    while (layer.childElementCount >= MAX_FLOATING_REACTIONS) layer.firstElementChild.remove();
    const nickname = this.session?.room?.players.find((p) => p.id === playerId)?.nickname ?? '';
    const node = el(
      'span',
      { class: 'reaction-float', style: `left: ${8 + Math.random() * 84}%; --drift: ${Math.round((Math.random() - 0.5) * 60)}px` },
      el('span', { class: 'reaction-emoji', text: emoji }),
      el('span', { class: 'reaction-name', text: playerId === this.session?.you ? '나' : nickname, style: `color: ${playerColor(playerId)}` }),
    );
    const remove = () => node.remove();
    node.addEventListener('animationend', remove);
    setTimeout(remove, 4000); // 애니메이션이 꺼진 환경 대비
    layer.append(node);
  }

  requestHint() {
    // 힌트를 보고 바로 입력할 수 있게 입력칸으로 돌아간다
    if (this.session?.requestHint()) $('#on-answer-input').focus();
  }

  submitAnswer(event) {
    event.preventDefault();
    const input = $('#on-answer-input');
    if (this.session?.submitText(input.value)) input.select();
  }

  buildChoices() {
    const container = $('#on-choices');
    container.replaceChildren();
    const choices = this.session.round?.choices;
    if (!choices) return;
    choices.forEach((label, index) =>
      container.append(el('button', { type: 'button', class: 'btn', text: label, onclick: () => this.session?.choose(index) })),
    );
  }

  overlayText() {
    const s = this.session;
    const stage = this.playback.stage;
    const status = s.me?.status;
    if (s.phase === 'revealed') return '정답 공개';
    if (s.phase === 'preparing') {
      const { ready, total } = s.readyCount();
      return status === 'absent' ? '다음 라운드부터 함께해요' : `곡을 불러오는 중… (${ready}/${total})`;
    }
    if (status === 'timeout') return '준비가 늦어 이번 라운드는 구경만 해요';
    if (status === 'absent') return '다음 라운드부터 함께해요';
    if (stage === PLAYBACK_STAGE.ERROR || status === 'error') return '재생 오류 — 이번 라운드는 제외돼요';
    if (stage === PLAYBACK_STAGE.MISSED) return '시작을 놓쳤어요. 다른 사람들이 끝낼 때까지 기다려 주세요';
    if (s.phase === 'starting') {
      const left = s.countdownSeconds();
      return left ? `${left}` : '시작!';
    }
    if (stage === PLAYBACK_STAGE.STOPPED) return '구간이 끝났어요. 답을 입력하세요';
    return '재생 중';
  }

  feedbackText() {
    const s = this.session;
    const status = s.me?.status;
    if (s.myCorrect) {
      const head = s.round?.items ? `전부 정답! +${s.myCorrect.points}점(보너스 ${s.myCorrect.bonus ?? 0}점 포함)` : `정답! +${s.myCorrect.points}점`;
      return { text: `${head} · ${Number(s.myCorrect.elapsed).toFixed(1)}초 — 다른 사람을 기다리는 중…`, kind: 'ok' };
    }
    if (status === 'exhausted') return { text: '기회를 모두 썼어요. 다른 사람을 기다리는 중…', kind: 'bad' };
    if (status === 'passed') return { text: '패스했어요. 다른 사람을 기다리는 중…', kind: '' };
    if (s.feedback === 'rate') return { text: '너무 빨라요. 1초 뒤에 다시 제출해 주세요.', kind: 'bad' };
    if (s.feedback === 'wrong') return { text: `틀렸어요. 남은 기회 ${s.attemptsLeft}번`, kind: 'bad' };
    if (s.feedback === 'partial' && s.lastGain?.items) {
      const left = (s.round?.items ?? []).filter((key) => !s.solved.has(key));
      return { text: `${itemNames(s.lastGain.items)} 정답! +${s.lastGain.points}점 · 남은 항목: ${itemNames(left)}`, kind: 'ok' };
    }
    if (s.feedback === 'already' && s.lastGain?.already) {
      return { text: `이미 맞힌 항목이에요(${itemNames(s.lastGain.already)}). 기회는 줄지 않아요.`, kind: '' };
    }
    return { text: '', kind: '' };
  }

  renderGame() {
    const s = this.session;
    if (!s?.room || !this.playback || this.app.screen !== 'online-game') return;
    const room = s.room;
    const round = s.round;
    if (!round) {
      // prepare를 받기 전(게임 중에 새로 들어왔거나 재접속 직후): 다음 라운드부터 합류한다
      $('#on-round-label').textContent = room.round ? `${room.round.index + 1} / ${room.round.total}` : '';
      $('#on-mode-label').textContent = [MODE_LABEL[room.settings.mode], room.settings.mode === MODE.RANDOM ? `${room.settings.clipLength}초` : null, DIFFICULTY_LABEL[room.settings.difficulty]]
        .filter(Boolean)
        .join(' · ');
      $('#on-score-label').textContent = `${s.me?.score ?? 0}점`;
      $('#on-overlay').classList.remove('hidden');
      $('#on-eq').classList.remove('on');
      $('#on-overlay-text').textContent = '다음 라운드부터 함께해요';
      $('#on-overlay-text').classList.remove('countdown');
      $('#on-overlay-hint').hidden = true;
      $('#on-progress-bar').style.width = '0%';
      $('#on-progress-label').textContent = '';
      $('#on-answer-area').hidden = true;
      $('#on-reveal').hidden = true;
      $('#on-extreme-items').hidden = true;
      this.renderBoard(false);
      return;
    }
    if (this.renderedRoundId !== round.roundId) {
      this.renderedRoundId = round.roundId;
      $('#on-answer-input').value = '';
      this.buildChoices();
      this.answerWasReady = false;
    }
    const revealed = s.phase === 'revealed' && !!s.reveal;
    const easy = !!round.choices;

    $('#on-round-label').textContent = `${round.index + 1} / ${round.total}`;
    $('#on-mode-label').textContent = [MODE_LABEL[round.mode], round.mode === MODE.RANDOM ? `${round.clipLength}초` : null, DIFFICULTY_LABEL[round.difficulty]]
      .filter(Boolean)
      .join(' · ');
    $('#on-score-label').textContent = `${s.me?.score ?? 0}점`;

    // 플레이어·오버레이(공개 전에는 영상을 가린다. iframe title 보호를 위해 inert)
    for (let i = 0; i < 2; i++) {
      const slot = $(`#on-slot-${i}`);
      slot.classList.toggle('active', i === this.playback.active);
      slot.inert = !this.playback.isPlayerVisible(i);
    }
    const showVideo = this.playback.isPlayerVisible(this.playback.active);
    $('#on-overlay').classList.toggle('hidden', showVideo);
    $('#on-eq').classList.toggle('on', this.playback.stage === PLAYBACK_STAGE.PLAYING);
    const overlayText = this.overlayText();
    $('#on-overlay-text').textContent = overlayText;
    // 시작 신호 카운트다운(3, 2, 1, 시작!)은 크게
    $('#on-overlay-text').classList.toggle('countdown', s.phase === 'starting' && /^(\d+|시작!)$/.test(overlayText));

    // 남은 시간(5초 이하면 진행 바를 붉게)
    $('#on-progress-bar').style.width = `${Math.round(s.windowProgress() * 100)}%`;
    const left = s.secondsLeft();
    $('#screen-online-game .progress').classList.toggle('low', !revealed && left != null && left <= 5);
    $('#on-progress-label').textContent = revealed || left == null ? '' : `남은 시간 ${Math.ceil(left)}초`;

    this.renderBoard(revealed);

    // 답 입력
    const canAnswer = s.canAnswer;
    $('#on-answer-area').hidden = revealed;
    $('#on-choices').hidden = !easy;
    $('#on-answer-form').hidden = easy;
    const left3 = s.attemptsLeft;
    $('#on-attempts').textContent = `남은 기회 ${'●'.repeat(left3)}${'○'.repeat(Math.max(0, s.maxAttempts - left3))}`;
    $('#on-answer-input').disabled = !canAnswer;
    $('#on-answer-form button').disabled = !canAnswer;
    $('#on-answer-input').placeholder = {
      [DIFFICULTY.HARD]: '곡 제목',
      [DIFFICULTY.EXTREME]: '제목, 가수, 작품명 중 하나씩 입력',
    }[round.difficulty] ?? '곡 제목 또는 작품명';
    this.renderExtremeItems(revealed);
    for (const [i, btn] of $$('#on-choices .btn').entries()) {
      const wrong = s.wrongChoices.has(i);
      btn.classList.toggle('wrong', wrong);
      btn.disabled = wrong || !canAnswer;
    }
    $('#on-pass').disabled = !canAnswer;
    const hintBtn = $('#on-hint');
    hintBtn.hidden = easy;
    hintBtn.disabled = !s.canHint;
    hintBtn.textContent = s.hint != null || s.hintRequested ? '힌트 사용함' : '초성 힌트 (-50%)';
    // 초성 힌트: 매우 어려움은 항목 칸의 ? 자리에, 그 밖에는 무대 가운데에 크게
    const overlayHint = !round.items && s.hint && !revealed ? s.hint[0].text : null;
    $('#on-overlay-hint').hidden = overlayHint == null;
    $('#on-overlay-hint-text').textContent = overlayHint ?? '';
    $('#on-overlay-hint').setAttribute('aria-label', formatHint(s.hint));
    // 답할 수 있게 되는 순간 입력칸에 자동 포커스(매 라운드 다시 클릭하지 않아도 되게)
    if (canAnswer && !this.answerWasReady && !easy) {
      const input = $('#on-answer-input');
      const active = document.activeElement;
      // 볼륨 조절 중이거나 채팅을 쓰는 중이면 뺏지 않는다
      const chatting = active?.id === 'on-chat-input' && active.value.trim();
      if (active !== input && !active?.matches?.('[data-volume]') && !chatting) input.focus();
    }
    this.answerWasReady = canAnswer;
    // 정답을 맞히면(매우 어려움은 전부) 채팅 입력칸으로. 답 입력칸은 잠기므로 바로 채팅할 수 있게
    if (s.myCorrect && !revealed && this.correctFocusedRound !== round.roundId) {
      this.correctFocusedRound = round.roundId;
      this.focusChat();
    }
    const fb = this.feedbackText();
    $('#on-feedback').textContent = fb.text;
    $('#on-feedback').className = `feedback ${fb.kind}`;

    // 정답 공개
    $('#on-reveal').hidden = !revealed;
    if (revealed) {
      const r = s.reveal;
      const result = $('#on-reveal-result');
      const corrects = r.correctPlayers ?? [];
      const partials = r.partialPlayers ?? [];
      if (r.items) {
        // 매우 어려움: 전부 맞힌 사람과 일부만 맞힌 사람 모두 점수와 함께
        const total = r.items.length;
        const lines = [
          ...corrects.map((c) => `${c.playerId === s.you ? '나' : c.nickname} ${total}/${total} +${c.points}점(${Number(c.elapsed).toFixed(1)}초${c.hint ? ', 힌트' : ''})`),
          ...partials.map((c) => `${c.playerId === s.you ? '나' : c.nickname} ${c.solved}/${total} +${c.points}점${c.hint ? '(힌트)' : ''}`),
        ];
        const mine = [...corrects, ...partials].some((c) => c.playerId === s.you);
        result.textContent = lines.length ? lines.join(', ') : REASON_TEXT[r.reason] ?? '아무도 맞히지 못했어요';
        result.className = `reveal-result ${lines.length ? (mine ? 'ok' : '') : 'bad'}`;
      } else if (corrects.length) {
        const mine = corrects.some((c) => c.playerId === s.you);
        result.textContent = `정답 ${corrects.length}명: ${corrects
          .map((c) => `${c.playerId === s.you ? '나' : c.nickname} +${c.points}점(${Number(c.elapsed).toFixed(1)}초${c.hint ? ', 힌트' : ''})`)
          .join(', ')}`;
        result.className = `reveal-result ${mine ? 'ok' : ''}`;
      } else {
        result.textContent = REASON_TEXT[r.reason] ?? '아무도 맞히지 못했어요';
        result.className = 'reveal-result bad';
      }
      $('#on-reveal-title').replaceChildren(
        r.song.title,
        ...(r.song.artist ? [el('span', { class: 'reveal-artist', text: ` / ${r.song.artist}` })] : []),
      );
      $('#on-reveal-anime').textContent = [r.song.anime, r.song.type].filter(Boolean).join(' · ');
      // 매우 어려움: 이 곡을 지금까지 푼 사람들의 정답률(항목별 정답률은 항목 칸에)
      const statsText = r.items ? formatStatsSummary(r.stats) : '';
      $('#on-reveal-stats').textContent = statsText;
      $('#on-reveal-stats').hidden = !statsText;
      const names = new Map(room.players.map((p) => [p.id, p.nickname]));
      $('#on-reveal-excluded').textContent = r.excluded?.length
        ? `제외된 사람: ${r.excluded.map((e) => `${names.get(e.playerId) ?? '?'}(${STATUS_CHIP[e.reason] ?? e.reason})`).join(', ')}`
        : '';
      const secs = s.revealSecondsLeft();
      const when = secs == null ? '잠시 뒤' : `${Math.ceil(secs)}초 뒤`;
      $('#on-reveal-next').textContent = r.hasNext ? `${when} 다음 라운드가 시작돼요.` : `${when} 결과가 나와요.`;
      const { votes, total, mine } = s.skipVotes();
      const skip = $('#on-skip');
      skip.disabled = mine;
      skip.textContent = mine ? `모두 기다리는 중 (${votes}/${total})` : `${r.hasNext ? '다음으로' : '결과 보기'} (K) · ${votes}/${total}`;
      // 공개되는 순간 채팅 입력칸에 포커스(바로 채팅). 넘기기 투표는 버튼 클릭 또는 Esc → K
      if (this.revealFocusedRound !== r.roundId) {
        this.revealFocusedRound = r.roundId;
        this.focusChat();
      }
    } else {
      $('#on-reaction-layer').replaceChildren();
    }
  }

  /** 매우 어려움 항목 칸: 맞힌 항목은 답(공개 전에는 맞힌 표시와 점수), 공개 후에는 모든 정답 */
  renderExtremeItems(revealed) {
    const s = this.session;
    const items = s.round?.items;
    const list = $('#on-extreme-items');
    list.hidden = !items;
    if (!items) return;
    const song = revealed ? s.reveal.song : null;
    const value = (key) => (song ? { title: song.title, artist: song.artist, anime: song.anime }[key] ?? '' : '맞혔어요');
    const stats = revealed ? s.reveal.stats : null;
    list.replaceChildren(
      ...items.map((key) => {
        const solved = s.solved.has(key);
        const points = s.solved.get(key);
        // 힌트를 봤으면 아직 못 맞힌 칸의 ? 자리에 초성
        const hint = s.hint?.find((p) => p.key === key)?.text;
        return el(
          'li',
          { class: solved ? 'solved' : revealed ? 'missed' : hint ? 'hinted' : '' },
          el('span', { class: 'item-label', text: ITEM_LABEL[key] }),
          el('span', { class: 'item-value', text: solved || revealed ? value(key) : hint ?? '?' }),
          ...(solved && points != null ? [el('span', { class: 'item-points', text: `+${points}` })] : []),
          ...(itemRate(stats, key) != null
            ? [el('span', { class: 'item-rate', title: `지금까지 ${stats.players}명 중 ${stats.items[key]}명이 맞혔어요`, text: `정답률 ${itemRate(stats, key)}%` })]
            : []),
        );
      }),
    );
  }

  renderBoard(revealed) {
    const s = this.session;
    const room = s.room;
    // 점수 높은 순(같으면 입장 순)
    const players = room.players.filter((p) => !p.left);
    const order = new Map(players.map((p, i) => [p.id, i]));
    players.sort((a, b) => b.score - a.score || order.get(a.id) - order.get(b.id));
    $('#on-board').replaceChildren(
      ...players
        .map((p) => {
          // 매우 어려움: 아직 푸는 중인 사람은 맞힌 항목 개수만 보인다(어떤 항목인지는 숨김)
          const total = s.round?.items?.length;
          const progress = total && p.status === 'ready' && p.solved > 0 ? `${p.solved}/${total}` : '';
          const chip = !p.connected ? '연결 끊김' : STATUS_CHIP[p.status] ?? progress;
          const chipClass = !p.connected ? 'st-off' : STATUS_CLASS[p.status] ?? (progress ? 'st-progress' : '');
          const winner = revealed && (s.reveal.correctPlayers ?? []).some((c) => c.playerId === p.id);
          return el(
            'li',
            { class: `${p.id === s.you ? 'me' : ''} ${winner ? 'winner' : ''}`.trim() },
            el('span', { class: 'name', text: p.nickname, style: `color: ${playerColor(p.id)}` }),
            chip ? el('span', { class: `chip ${chipClass}`.trim(), text: chip }) : '',
            p.hint ? el('span', { class: 'chip st-hint', text: '힌트' }) : '',
            el('span', { class: 'pts', text: `${p.score}점` }),
          );
        }),
    );
  }

  // ---------- 결과 ----------
  buildResult() {
    return el(
      'section',
      { id: 'screen-online-result', class: 'screen screen-wide', 'data-screen': 'online-result', hidden: true },
      el('h1', { text: '최종 순위' }),
      el(
        'div',
        { class: 'two-col' },
        el(
          'div',
          { class: 'col-main' },
          el('p', { class: 'status', id: 'on-result-note' }),
          el('ol', { id: 'on-ranking', class: 'ranking' }),
          el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', class: 'btn primary big', id: 'on-again', text: '같은 멤버로 한 판 더', onclick: () => this.session?.start() }),
            el('button', { type: 'button', class: 'btn', id: 'on-leave-result', text: '방 나가기', onclick: () => this.leave() }),
          ),
          el('p', { class: 'status', id: 'on-result-hint' }),
          el('h2', { text: '라운드별 기록' }),
          el('p', { class: 'hint', text: '곡 제목을 누르면 YouTube에서 들었던 구간부터 다시 들을 수 있어요.' }),
          el('ol', { id: 'on-history', class: 'result-list' }),
        ),
        el('aside', { class: 'col-side panel' }, el('h2', { class: 'panel-title', text: '채팅' }), el('div', { class: 'chat-slot' })),
      ),
    );
  }

  renderResult() {
    const s = this.session;
    const over = s.gameOver;
    $('#on-result-note').textContent = over ? GAME_OVER_NOTE[over.reason] ?? '' : '';
    $('#on-ranking').replaceChildren(
      ...(over?.ranking ?? []).map((r) =>
        el(
          'li',
          { class: `${r.playerId === s.you ? 'me' : ''} rank-${r.rank}`.trim() },
          el('span', { class: 'rank', text: ['🥇', '🥈', '🥉'][r.rank - 1] ?? `${r.rank}위`, 'aria-label': `${r.rank}위` }),
          el('span', { class: 'name', text: r.nickname, style: `color: ${playerColor(r.playerId)}` }),
          r.left ? el('span', { class: 'chip', text: '나감' }) : '',
          el('span', { class: 'rank-correct', text: `정답 ${r.correct}` }),
          el('span', { class: 'pts', text: `${r.score}점` }),
        ),
      ),
    );
    $('#on-history').replaceChildren(
      ...(over?.history ?? []).map((h, index) => {
        const corrects = h.correctPlayers ?? [];
        const partials = h.partialPlayers ?? [];
        const mine = [...corrects, ...partials].find((c) => c.playerId === s.you);
        const total = h.items?.length;
        const names = [
          ...corrects.map((c) => `${c.nickname} (${Number(c.elapsed).toFixed(1)}초${c.hint ? ', 힌트' : ''})`),
          ...partials.map((c) => `${c.nickname} (${c.solved}/${total}${c.hint ? ', 힌트' : ''})`),
        ];
        const state = corrects.length ? 'ok' : partials.length ? 'partial' : 'bad';
        return el(
          'li',
          { class: `res ${state}` },
          el('span', { class: 'res-index', text: String(index + 1) }),
          el('span', { class: 'res-mark', text: { ok: '○', partial: '△', bad: '×' }[state] }),
          el(
            'span',
            { class: 'res-body' },
            songLink(h.title, h.videoId, h.segmentStart),
            el('span', { class: 'res-sub', text: names.length ? names.join(', ') : '정답자 없음' }),
          ),
          el('span', { class: 'pts', text: mine ? `+${mine.points}점` : '' }),
        );
      }),
    );
    $('#on-again').hidden = !s.isHost;
    $('#on-result-hint').textContent = s.isHost ? '' : '방장이 다시 시작하길 기다리는 중…';
  }
}
