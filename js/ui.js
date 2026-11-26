// 화면 렌더링과 DOM 이벤트 처리. 게임 규칙은 game.js에 있다.

import { GameSession, MODE, PHASE } from './game.js';
import { handleGameKey } from './hotkeys.js';
import { DIFFICULTY, formatHint } from './judge.js';
import { parseYouTubeLink, youtubeWatchUrl } from './linkParser.js';
import { SCORING, parseRounds } from './scoring.js';
import {
  loadSettings,
  parseDurationText,
  saveSettings,
  searchSongs,
  songFromForm,
  songToFormValues,
} from './songs.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SEARCH_LIMIT = 20;
const MODE_LABEL ={ [MODE.RANDOM]: '랜덤듣기', [MODE.FULL]: '전체듣기' };
const DIFFICULTY_LABEL = {
  [DIFFICULTY.EASY]: '쉬움',
  [DIFFICULTY.NORMAL]: '보통',
  [DIFFICULTY.HARD]: '어려움',
  [DIFFICULTY.EXTREME]: '매우 어려움',
};
const DIFFICULTY_HINT = {
  [DIFFICULTY.EASY]: '4지선다 객관식으로 곡 제목을 고릅니다.',
  [DIFFICULTY.NORMAL]: '곡 제목 또는 작품명(별칭 포함)을 입력하면 정답입니다.',
  [DIFFICULTY.HARD]: '곡 제목(별칭 포함)만 정답으로 인정합니다.',
  [DIFFICULTY.EXTREME]: `제목·가수·작품명을 모두 맞혀야 라운드가 끝납니다. 맞힌 항목마다 점수, 전부 맞히면 보너스. 오답 기회 ${SCORING.extreme.maxWrongAttempts}번.`,
};
const ITEM_LABEL = { title: '제목', artist: '가수', anime: '작품명' };
const itemValue = (song, key) => ({ title: song.title, artist: song.artist, anime: song.anime?.name })[key] ?? '';
const itemNames = (keys) => keys.map((key) => ITEM_LABEL[key]).join(', ');
const RESULT_TEXT = {
  correct: (p) => `정답! +${p}점`,
  wrong: () => '오답 3회 — 0점',
  pass: () => '패스 — 0점',
  timeout: () => '시간 초과 — 0점',
};

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

/** 결과 목록의 곡 제목. 누르면 새 탭에서 YouTube로 들었던 구간부터 다시 듣는다 */
function songLink(title, videoId, startSeconds) {
  const href = youtubeWatchUrl(videoId, startSeconds);
  if (!href) return title;
  return el('a', {
    class: 'song-link',
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'YouTube에서 다시 듣기(새 탭)',
    text: title,
  });
}

export class App {
  constructor({ store, durationCache, highScores, storage }) {
    this.store = store;
    this.durationCache = durationCache;
    this.highScores = highScores;
    this.storage = storage;
    this.players = [];
    this.playerError = null;
    this.game = null;
    this.lastSettings = null;
    this.renderedRound = null;
    this.resultShown = false;
    this.answerWasReady = false;
    this.revealWasShown = false;
    this.editing = null; // 곡 관리 폼에서 수정 중인 곡
  }

  init() {
    if (location.protocol === 'file:') $('#protocol-warning').hidden = false;
    this.restoreSettings();
    this.bindStart();
    this.bindGame();
    this.bindResult();
    this.bindManage();
    this.showScreen('start');
  }

  // ---------- 공통 ----------
  showScreen(name) {
    for (const section of $$('.screen')) {
      const isTarget = section.dataset.screen === name;
      if (section.classList.contains('keep-alive')) section.classList.toggle('active', isTarget);
      else section.hidden = !isTarget;
    }
    this.screen = name;
    if (name === 'start') this.renderStart();
    if (name === 'manage') this.renderManage();
    window.scrollTo(0, 0);
  }

  toast(message, ms = 4500) {
    const node = el('div', { class: 'toast', text: message });
    $('#toasts').append(node);
    setTimeout(() => node.remove(), ms);
  }

  setPlayers(players) {
    this.players = players;
    this.renderStart();
  }

  setPlayerError(error) {
    this.playerError = error;
    this.renderStart();
  }

  songsChanged() {
    if (this.screen === 'start') this.renderStart();
    if (this.screen === 'manage') this.renderManage();
  }

  // ---------- 시작 화면 ----------
  restoreSettings() {
    const saved = loadSettings(this.storage);
    if (!saved) return;
    for (const name of ['mode', 'clipLength', 'answerTime', 'rounds', 'difficulty']) {
      const input = $(`input[name="${name}"][value="${saved[name]}"]`);
      if (input) input.checked = true;
    }
    // 빠른 선택에 없는 라운드 수는 직접 입력칸에 채운다
    const rounds = parseRounds(saved.rounds);
    if (rounds != null && !SCORING.roundOptions.includes(rounds)) this.setCustomRounds(rounds);
  }

  /** 라운드 직접 입력: 값을 넣으면 빠른 선택 버튼은 해제한다 */
  setCustomRounds(value) {
    $('#rounds-custom').value = value;
    for (const radio of $$('input[name="rounds"]')) radio.checked = false;
  }

  bindRoundsInput() {
    const custom = $('#rounds-custom');
    custom.addEventListener('input', () => {
      if (custom.value !== '') for (const radio of $$('input[name="rounds"]')) radio.checked = false;
    });
    // 범위를 벗어난 값은 입력을 마칠 때 끝값으로 고친다
    custom.addEventListener('change', () => {
      const rounds = parseRounds(custom.value);
      custom.value = rounds ?? '';
      if (rounds == null && !$('input[name="rounds"]:checked')) $(`input[name="rounds"][value="${SCORING.defaultRounds}"]`).checked = true;
      this.renderStart();
    });
    for (const radio of $$('input[name="rounds"]')) radio.addEventListener('change', () => (custom.value = ''));
  }

  readSettings() {
    const value = (name) => $(`input[name="${name}"]:checked`)?.value;
    return {
      mode: value('mode') === MODE.FULL ? MODE.FULL : MODE.RANDOM,
      clipLength: Number(value('clipLength')) || SCORING.defaultClipLength,
      answerTime: SCORING.solo.answerTimes.includes(Number(value('answerTime'))) ? Number(value('answerTime')) : SCORING.solo.defaultAnswerTime,
      rounds: Number(value('rounds')) || parseRounds($('#rounds-custom').value) || SCORING.defaultRounds,
      difficulty: value('difficulty') || DIFFICULTY.NORMAL,
      timeLimit: SCORING.full.timeLimit,
    };
  }

  bindStart() {
    $('#screen-start').addEventListener('change', () => this.renderStart());
    this.bindRoundsInput();
    $('#start-btn').addEventListener('click', () => {
      const settings = this.readSettings();
      saveSettings(this.storage, settings);
      this.startGame(settings);
    });
    for (const btn of $$('[data-action="open-manage"]')) {
      btn.addEventListener('click', () => this.showScreen('manage'));
    }
  }

  renderStart() {
    const settings = this.readSettings();
    const playable = this.store.playable();
    const total = this.store.all().length;
    $('#clip-setting').disabled = settings.mode !== MODE.RANDOM;
    $('#answer-time-setting').disabled = settings.mode !== MODE.RANDOM;
    $('#difficulty-hint').textContent = DIFFICULTY_HINT[settings.difficulty];
    $('#empty-notice').hidden = playable.length > 0;
    $('#song-count').textContent =
      total === 0 ? '등록된 곡: 0곡' : `사용 중인 곡: ${playable.length}곡 (전체 ${total}곡)`;

    let status;
    if (this.playerError) {
      status = `플레이어를 준비하지 못했습니다: ${this.playerError.message}. 인터넷 연결과 http(s)로 열었는지 확인해 주세요.`;
    } else if (!this.players.length) {
      status = '플레이어 준비 중…';
    } else {
      status = '플레이어 준비 완료';
    }
    $('#player-status').textContent = status;
    $('#start-btn').disabled = !this.players.length || playable.length === 0;
  }

  /** 클릭 핸들러 안에서 동기적으로 호출된다(첫 곡 재생이 사용자 동작 안에서 시작되도록). */
  startGame(settings) {
    if (this.game) this.game.dispose();
    this.lastSettings = settings;
    this.renderedRound = null;
    this.resultShown = false;
    const game = new GameSession({
      songs: this.store.playable(),
      settings,
      players: this.players,
      durationCache: this.durationCache,
    });
    this.game = game;
    game.on('change', () => this.renderGame());
    game.on('toast', (message) => this.toast(message));
    $('#feedback').textContent = '';
    $('#answer-input').value = '';
    this.showScreen('game');
    game.start();
    this.renderGame();
  }

  // ---------- 게임 화면 ----------
  bindGame() {
    $('#play-btn').addEventListener('click', () => this.game?.playCurrent());
    $('#replay-btn').addEventListener('click', () => {
      // 다시듣기를 눌러도 바로 이어서 입력할 수 있게 입력칸으로 돌아간다
      if (this.game?.replay()) this.focusAnswer();
    });
    $('#pass-btn').addEventListener('click', () => this.game?.pass());
    $('#hint-btn').addEventListener('click', () => {
      // 힌트를 보고 바로 입력할 수 있게 입력칸으로 돌아간다
      if (this.game?.useHint()) this.focusAnswer();
    });
    // 패스 단축키 K(입력칸 밖에서), Esc로 입력칸 빠져나오기
    document.addEventListener('keydown', (event) => {
      if (this.screen !== 'game' || !this.game) return;
      handleGameKey(event, {
        pass: () => {
          const btn = $('#pass-btn');
          if (btn.hidden || btn.disabled) return false;
          btn.click();
          return true;
        },
      });
    });
    $('#next-btn').addEventListener('click', () => this.game?.next());
    $('#quit-btn').addEventListener('click', () => {
      if (!this.game) return;
      if (!confirm('게임을 그만두고 시작 화면으로 돌아갈까요?')) return;
      this.game.abort();
      this.game.dispose();
      this.game = null;
      this.showScreen('start');
    });
    $('#answer-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('#answer-input');
      const result = this.game?.submitAnswer(input.value);
      if (!result) return;
      this.showAnswerFeedback(result);
      if (result.correct) input.value = '';
      else input.select();
    });
  }

  /** 답 입력칸에 포커스(매 라운드 입력칸을 다시 클릭하지 않아도 되게) */
  focusAnswer() {
    const input = $('#answer-input');
    if (this.screen !== 'game' || input.disabled || $('#answer-form').hidden) return;
    const active = document.activeElement;
    if (active === input || active?.matches?.('[data-volume]')) return; // 볼륨 조절 중에는 뺏지 않는다
    input.focus();
  }

  showAnswerFeedback(result) {
    const fb = $('#feedback');
    if (result.correct) {
      // 매우 어려움에서 일부 항목만 맞힌 경우
      const round = this.game?.round;
      if (result.items && !result.complete && round) {
        const left = round.items.filter((key) => !round.solved.has(key));
        fb.className = 'feedback ok';
        fb.textContent = `${itemNames(result.items)} 정답! +${result.points}점 · 남은 항목: ${itemNames(left)}`;
      } else {
        fb.textContent = '';
      }
      return;
    }
    if (result.already) {
      fb.className = 'feedback';
      fb.textContent = `이미 맞힌 항목이에요(${itemNames(result.already)}). 기회는 줄지 않아요.`;
      return;
    }
    fb.className = 'feedback bad';
    fb.textContent = result.revealed ? '기회를 모두 썼습니다.' : `틀렸어요. 남은 기회 ${result.attemptsLeft}번`;
  }

  /** 매우 어려움 항목 칸: 맞힌 항목은 답과 점수, 못 맞힌 항목은 ?(공개 후에는 정답) */
  renderExtremeItems(round, revealed) {
    const list = $('#extreme-items');
    list.hidden = !round.items;
    if (!round.items) return;
    list.replaceChildren(
      ...round.items.map((key) => {
        const solved = round.solved.get(key);
        // 힌트를 봤으면 아직 못 맞힌 칸의 ? 자리에 초성
        const hint = round.hint?.find((p) => p.key === key)?.text;
        const state = solved ? 'solved' : revealed ? 'missed' : hint ? 'hinted' : '';
        return el(
          'li',
          { class: state },
          el('span', { class: 'item-label', text: ITEM_LABEL[key] }),
          el('span', { class: 'item-value', text: solved || revealed ? itemValue(round.song, key) : hint ?? '?' }),
          ...(solved ? [el('span', { class: 'item-points', text: `+${solved.points}` })] : []),
        );
      }),
    );
  }

  renderGame() {
    const game = this.game;
    if (!game || this.screen !== 'game') return;
    if (game.phase === PHASE.FINISHED) {
      this.showResult();
      return;
    }
    const round = game.round;
    if (!round) return;

    if (this.renderedRound !== round) {
      this.renderedRound = round;
      $('#answer-input').value = '';
      $('#feedback').textContent = '';
      $('#feedback').className = 'feedback';
      this.buildChoices();
      this.answerWasReady = false;
      this.revealWasShown = false;
    }

    const { phase } = game;
    const revealed = phase === PHASE.REVEALED;
    const s = game.settings;
    $('#round-label').textContent = `${game.roundIndex + 1} / ${game.totalRounds}`;
    $('#mode-label').textContent = [
      MODE_LABEL[s.mode],
      game.isRandom ? `${s.clipLength}초` : null,
      DIFFICULTY_LABEL[game.difficulty],
    ]
      .filter(Boolean)
      .join(' · ');
    $('#score-label').textContent = `${game.score}점`;

    // 플레이어/오버레이
    for (const [i, slot] of $$('.player-slot').entries()) {
      slot.classList.toggle('active', i === game.active);
      // iframe title(영상 제목)이 스크린리더·접근성 트리로 정답을 알려 주지 않도록 공개 전에는 inert
      slot.inert = !game.isPlayerVisible(i);
    }
    const overlay = $('#overlay');
    overlay.classList.toggle('hidden', game.isPlayerVisible(game.active));
    $('#eq').classList.toggle('on', phase === PHASE.PLAYING);
    $('#overlay-text').textContent = {
      [PHASE.READY]: '재생 버튼을 눌러 주세요',
      [PHASE.LOADING]: round.heard ? '다시 재생 준비 중…' : '불러오는 중…',
      [PHASE.PLAYING]: '재생 중',
      [PHASE.STOPPED]: round.answerDeadline != null ? '구간 재생이 끝났어요. 시간 안에 답하세요' : '구간 재생이 끝났어요',
      [PHASE.REVEALED]: '정답 공개',
    }[phase] ?? '';

    // 진행 바
    $('#progress-bar').style.width = `${Math.round(game.progress * 100)}%`;
    const answerLeft = game.answerSecondsLeft();
    $('#progress-label').textContent = !game.isRandom
      ? `${Math.min(game.audibleElapsed(), s.timeLimit).toFixed(1)} / ${s.timeLimit}초`
      : answerLeft != null
        ? `구간 ${s.clipLength}초 · 남은 시간 ${Math.ceil(answerLeft)}초`
        : `구간 ${s.clipLength}초`;

    // 컨트롤
    $('#play-btn').hidden = phase !== PHASE.READY;
    $('#replay-btn').hidden = !game.isRandom || revealed;
    $('#replay-btn').disabled = !game.canReplay;
    $('#replay-btn').textContent = round.replayUsed ? '다시듣기 사용함' : '다시듣기 (-20점)';
    $('#pass-btn').hidden = revealed;
    const hintBtn = $('#hint-btn');
    hintBtn.hidden = revealed || game.difficulty === DIFFICULTY.EASY;
    hintBtn.disabled = !game.canHint;
    hintBtn.textContent = round.hint ? '힌트 사용함' : '초성 힌트 (-50%)';
    // 초성 힌트: 매우 어려움은 항목 칸의 ? 자리에, 그 밖에는 무대 가운데에 크게
    const overlayHint = !game.isExtreme && round.hint && !revealed ? round.hint[0].text : null;
    $('#overlay-hint').hidden = overlayHint == null;
    $('#overlay-hint-text').textContent = overlayHint ?? '';
    $('#overlay-hint').setAttribute('aria-label', formatHint(round.hint));

    // 답 입력
    $('#answer-area').hidden = revealed;
    const easy = game.difficulty === DIFFICULTY.EASY;
    $('#choices').hidden = !easy;
    $('#answer-form').hidden = easy;
    const left = game.attemptsLeft;
    $('#attempts').textContent = `남은 기회 ${'●'.repeat(left)}${'○'.repeat(game.maxWrongAttempts - left)}`;
    const input = $('#answer-input');
    const canAnswer = game.canAnswer;
    input.disabled = !canAnswer;
    $('#answer-form button').disabled = !canAnswer;
    input.placeholder = {
      [DIFFICULTY.HARD]: '곡 제목',
      [DIFFICULTY.EXTREME]: '제목, 가수, 작품명 중 하나씩 입력',
    }[game.difficulty] ?? '곡 제목 또는 작품명';
    this.renderExtremeItems(round, revealed);
    for (const [i, btn] of $$('#choices .btn').entries()) {
      const wrong = round.disabledChoices.has(i);
      btn.classList.toggle('wrong', wrong);
      btn.disabled = wrong || !game.canAnswer;
    }
    // 소리가 나기 시작해 답할 수 있게 되는 순간 입력칸에 자동 포커스
    if (canAnswer && !this.answerWasReady) this.focusAnswer();
    this.answerWasReady = canAnswer;

    // 정답 공개
    $('#reveal').hidden = !revealed;
    if (revealed && round.result) {
      const { reason, points } = round.result;
      const resultEl = $('#reveal-result');
      resultEl.textContent = this.revealText(round.result);
      resultEl.className = `reveal-result ${reason === 'correct' || points > 0 ? 'ok' : 'bad'}`;
      $('#reveal-title').replaceChildren(
        round.song.title,
        ...(round.song.artist ? [el('span', { class: 'reveal-artist', text: ` / ${round.song.artist}` })] : []),
      );
      $('#reveal-anime').textContent = [round.song.anime?.name, round.song.type].filter(Boolean).join(' · ');
      $('#next-btn').textContent = game.hasNext ? '다음 곡' : '결과 보기';
      // 공개되면 Enter로 바로 다음 곡으로 넘어갈 수 있게
      if (!this.revealWasShown) $('#next-btn').focus();
    }
    this.revealWasShown = revealed;
  }

  revealText(result) {
    const { reason, points, items, solved, bonus, hintUsed } = result;
    const hint = hintUsed && points > 0 ? ' · 힌트 사용' : '';
    if (!items) return RESULT_TEXT[reason](points) + hint;
    if (reason === 'correct') return `전부 정답! +${points}점 (보너스 ${bonus}점 포함)${hint}`;
    const why = { wrong: '기회 소진', pass: '패스', timeout: '시간 초과' }[reason];
    return `${solved.length}/${items.length} 맞힘 — +${points}점 (${why})${hint}`;
  }

  buildChoices() {
    const container = $('#choices');
    container.replaceChildren();
    const choices = this.game.round.choices;
    if (!choices) return;
    choices.forEach((choice, index) => {
      container.append(
        el('button', {
          type: 'button',
          class: 'btn',
          text: choice.label,
          onclick: () => {
            const result = this.game?.chooseOption(index);
            if (result) this.showAnswerFeedback(result);
          },
        }),
      );
    });
  }

  // ---------- 결과 화면 ----------
  bindResult() {
    $('#again-btn').addEventListener('click', () => {
      if (this.lastSettings && this.players.length && this.store.playable().length) {
        this.startGame(this.lastSettings);
      } else {
        this.showScreen('start');
      }
    });
    $('#home-btn').addEventListener('click', () => this.showScreen('start'));
  }

  showResult() {
    if (this.resultShown) return;
    this.resultShown = true;
    const game = this.game;
    const mode = game.settings.mode;
    const played = game.history.length > 0;
    // 0점은 기록으로 남기지 않는다(첫 게임을 0점으로 끝내도 '최고 기록 갱신!'이 뜨지 않게)
    const isRecord = played && game.finishReason === 'complete' && game.score > 0 && this.highScores.submit(mode, game.score);
    const best = this.highScores.get(mode);

    $('#final-score').textContent = game.score;
    const hs = $('#high-score');
    hs.replaceChildren();
    if (isRecord) hs.append(el('span', { class: 'new-record', text: '최고 기록 갱신! ' }));
    hs.append(`${MODE_LABEL[mode]} 최고 점수: ${best ?? '-'}점`);

    const notes = [];
    if (game.finishReason === 'no-songs') notes.push('재생할 수 있는 곡이 없습니다.');
    if (game.finishReason === 'no-playable') notes.push('재생 가능한 곡이 없어 게임을 진행하지 못했습니다.');
    if (game.skippedSongs.length) notes.push(`재생 오류로 건너뛴 곡: ${game.skippedSongs.length}곡`);
    if (game.totalRounds < game.settings.rounds && played) {
      notes.push(`곡이 부족해 ${game.totalRounds}라운드로 진행했습니다.`);
    }
    $('#result-note').textContent = notes.join(' ');

    const list = $('#result-list');
    list.replaceChildren(
      ...game.history.map((h) => {
        const partial = !h.correct && h.solved?.length > 0;
        return el(
          'li',
          {},
          el('span', { class: 'pts', text: `${h.points}점` }),
          el('span', { class: h.correct || partial ? 'ok' : 'bad', text: h.correct ? '○ ' : partial ? '△ ' : '× ' }),
          songLink(h.song.title, h.song.videoId, h.segmentStart),
          ...[h.song.anime?.name ?? h.song.artist].filter(Boolean).map((name) => ` — ${name}`),
          ...(h.items ? [` (${h.solved.length}/${h.items.length})`] : []),
          ...(h.hintUsed ? [' (힌트)'] : []),
        );
      }),
    );
    this.showScreen('result');
  }

  // ---------- 곡 관리 ----------
  bindManage() {
    $('[data-action="go-home"]').addEventListener('click', () => this.showScreen('start'));
    const form = $('#song-form');
    const linkInput = $('#link-input');
    const hookInput = form.elements.hookStart;

    linkInput.addEventListener('input', () => {
      const parsed = parseYouTubeLink(linkInput.value);
      const hint = $('#link-result');
      if (!linkInput.value.trim()) {
        hint.textContent = '';
      } else if (!parsed) {
        hint.textContent = '영상 ID를 찾지 못했습니다. 링크를 확인해 주세요.';
      } else {
        hint.textContent = `영상 ID: ${parsed.videoId}${parsed.startSeconds != null ? ` · 시작 ${parsed.startSeconds}초` : ''}`;
        if (parsed.startSeconds != null && (!hookInput.value || hookInput.dataset.auto === '1')) {
          hookInput.value = parsed.startSeconds;
          hookInput.dataset.auto = '1';
        }
      }
    });
    hookInput.addEventListener('input', () => {
      hookInput.dataset.auto = '0';
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const f = form.elements;
      const editing = this.editing;
      const parsed = editing ? { videoId: editing.videoId } : parseYouTubeLink(f.link.value);
      if (!parsed) {
        this.toast('YouTube 링크 또는 11자리 영상 ID를 입력해 주세요.');
        return;
      }
      const duration = parseDurationText(f.duration.value);
      if (duration === null) {
        this.toast('곡 길이는 3:45 또는 225(초)처럼 입력해 주세요.');
        return;
      }
      const values = Object.fromEntries(Object.keys(songToFormValues({})).map((key) => [key, f[key].value]));
      // 수정 중에 사용 여부를 바꿨을 수 있으니 저장 직전의 곡을 원본으로 쓴다
      const original = editing ? this.store.all().find((s) => s.videoId === editing.videoId) ?? editing : null;
      const exists = !editing && this.store.all().some((s) => s.videoId === parsed.videoId);
      const song = this.store.add(songFromForm(values, { videoId: parsed.videoId, duration }, original));
      if (!song) {
        this.toast('곡 제목을 입력해 주세요.');
        return;
      }
      if (editing) this.toast(`수정했습니다: ${song.title}`);
      else this.toast(exists ? `같은 영상이 있어 교체했습니다: ${song.title}` : `추가했습니다: ${song.title}`);
      this.endEdit();
      this.renderManage();
    });

    $('#edit-cancel').addEventListener('click', () => {
      this.endEdit();
      this.renderManage();
    });

    $('#song-search').addEventListener('input', () => this.renderSearch());

    $('#export-btn').addEventListener('click', () => {
      this.downloadJson(this.store.exportJson(), 'songs.json', 'JSON을 내보냈습니다. 아래 입력란에도 복사해 두었습니다.');
    });
    $('#export-mine-btn').addEventListener('click', () => {
      const count = this.store.all().filter((s) => s.source === 'user').length;
      if (!count) {
        this.toast('이 브라우저에서 직접 추가한 곡이 없습니다.');
        return;
      }
      this.downloadJson(
        this.store.exportJson({ userOnly: true }),
        'my-songs.json',
        `직접 추가한 ${count}곡을 내보냈습니다. 이 파일을 운영자에게 보낸 뒤 "내 곡 전부 지우기"를 누르면 다음에 보낼 때 겹치지 않아요.`,
      );
    });
    $('#clear-mine-btn').addEventListener('click', () => {
      const count = this.store.all().filter((s) => s.source === 'user').length;
      if (!count) {
        this.toast('이 브라우저에서 직접 추가하거나 고친 곡이 없습니다.');
        return;
      }
      const ok = confirm(
        `이 브라우저에서 직접 추가하거나 고친 ${count}곡을 모두 지울까요?\n` +
          '되돌릴 수 없어요. 아직 보내지 않은 곡이 있으면 먼저 "내 곡만 내보내기"로 파일을 받아 두세요.\n' +
          '(고친 songs.json 곡은 원래 내용으로 돌아가요)',
      );
      if (!ok) return;
      if (this.editing && this.store.userSongs.some((s) => s.videoId === this.editing.videoId)) this.endEdit();
      const removed = this.store.clearUserSongs();
      this.toast(`내 곡 ${removed}곡을 지웠습니다.`);
      this.renderManage();
    });

    $('#import-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      this.importText(await file.text());
      event.target.value = '';
    });
    $('#import-text-btn').addEventListener('click', () => this.importText($('#import-text').value));
  }

  /** 등록 폼을 수정 모드로: 곡 값을 채우고 링크(영상)는 잠근다 */
  startEdit(song) {
    const form = $('#song-form');
    const f = form.elements;
    form.reset();
    this.editing = song;
    for (const [key, value] of Object.entries(songToFormValues(song))) f[key].value = value;
    f.hookStart.dataset.auto = '0';
    f.link.readOnly = true;
    $('#link-result').textContent = `영상 ID: ${song.videoId} (수정 중에는 영상을 바꿀 수 없어요)`;
    const note = $('#edit-note');
    note.replaceChildren(
      el('strong', { text: `"${song.title}" 수정 중` }),
      this.store.isBaseSong(song.videoId)
        ? ' · songs.json 곡은 이 브라우저에서만 바뀌어요. 모두에게 반영하려면 "내 곡만 내보내기"로 운영자에게 보내 주세요.'
        : '',
    );
    note.hidden = false;
    $('#song-submit').textContent = '수정 저장';
    $('#edit-cancel').hidden = false;
    this.renderSearch();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.title.focus({ preventScroll: true });
  }

  /** 수정 모드를 끝내고 빈 등록 폼으로 */
  endEdit() {
    const form = $('#song-form');
    this.editing = null;
    form.reset();
    form.elements.link.readOnly = false;
    form.elements.hookStart.dataset.auto = '0';
    $('#link-result').textContent = '';
    $('#edit-note').hidden = true;
    $('#song-submit').textContent = '곡 추가';
    $('#edit-cancel').hidden = true;
  }

  /** JSON 파일로 내려받고, 아래 입력란에도 복사해 둔다 */
  downloadJson(json, filename, message) {
    $('#import-text').value = json;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast(message);
  }

  importText(text) {
    try {
      const { added, invalid } = this.store.importJson(text);
      this.toast(`${added}곡을 가져왔습니다${invalid ? ` (형식이 맞지 않는 ${invalid}개는 건너뜀)` : ''}.`);
      this.renderManage();
    } catch (error) {
      this.toast(`가져오기 실패: ${error.message}`);
    }
  }

  renderManage() {
    const songs = this.store.all();
    const enabled = songs.filter((s) => s.enabled).length;
    const box = $('#manage-count');
    this.renderSearch(songs);
    if (!songs.length) {
      box.textContent = '아직 등록된 곡이 없습니다. 위에서 링크를 붙여넣어 추가해 보세요.';
      return;
    }
    box.replaceChildren(
      el('strong', { text: String(songs.length) }),
      '곡',
      ...(enabled < songs.length ? [` (사용 ${enabled}곡)`] : []),
    );
  }

  /** 곡 찾기 결과. 검색어가 없으면 아무것도 보여 주지 않는다 */
  renderSearch(songs = this.store.all()) {
    const query = $('#song-search').value;
    const { matches, total } = searchSongs(songs, query, SEARCH_LIMIT);
    const note = $('#song-search-note');
    if (!query.trim()) note.textContent = '';
    else if (!total) note.textContent = '찾는 곡이 없습니다.';
    else note.textContent = total > matches.length ? `${total}곡 중 ${matches.length}곡만 표시합니다. 검색어를 더 자세히 입력해 주세요.` : `${total}곡`;

    $('#song-results').replaceChildren(
      ...matches.map((song) => {
        const toggle = el('input', {
          type: 'checkbox',
          checked: song.enabled,
          'aria-label': `${song.title} 사용`,
          onchange: (e) => {
            this.store.setEnabled(song.videoId, e.target.checked);
            this.renderManage();
          },
        });
        // songs.json 곡을 이 브라우저에서 고쳤으면 source가 user로 바뀐다
        const editedBase = song.source === 'user' && this.store.isBaseSong(song.videoId);
        const origin = song.source === 'base' ? 'songs.json' : editedBase ? 'songs.json · 이 브라우저에서 수정함' : '직접 추가';
        const detail = [song.anime?.name, song.type, song.videoId, origin];
        const isEditing = this.editing?.videoId === song.videoId;
        const classes = [song.enabled ? '' : 'off', isEditing ? 'editing' : ''].filter(Boolean).join(' ');
        return el(
          'li',
          { class: classes },
          el(
            'div',
            { class: 'info' },
            el('strong', { text: song.artist ? `${song.title} / ${song.artist}` : song.title }),
            el('span', { text: detail.filter(Boolean).join(' · ') }),
          ),
          el(
            'div',
            { class: 'row-actions' },
            el('label', { class: 'switch' }, toggle, '사용'),
            el('button', {
              type: 'button',
              class: 'btn small',
              text: '수정',
              'aria-label': `${song.title} 수정`,
              onclick: () => this.startEdit(song),
            }),
            editedBase
              ? el('button', {
                  type: 'button',
                  class: 'btn small',
                  text: '원래대로',
                  title: '이 브라우저에서 고친 내용을 지우고 songs.json 내용으로 되돌립니다',
                  onclick: () => {
                    if (!confirm(`"${song.title}"을(를) songs.json 내용으로 되돌릴까요? 이 브라우저에서 고친 내용은 지워져요.`)) return;
                    this.store.revert(song.videoId);
                    if (isEditing) this.endEdit();
                    this.toast(`songs.json 내용으로 되돌렸습니다: ${song.title}`);
                    this.renderManage();
                  },
                })
              : '',
            el('button', {
              type: 'button',
              class: 'btn small danger',
              text: '삭제',
              onclick: () => {
                if (!confirm(`"${song.title}"을(를) 삭제할까요?`)) return;
                this.store.remove(song.videoId);
                if (this.editing?.videoId === song.videoId) this.endEdit();
                this.toast(`삭제했습니다: ${song.title}`);
                this.renderManage();
              },
            }),
          ),
        );
      }),
    );
  }
}
