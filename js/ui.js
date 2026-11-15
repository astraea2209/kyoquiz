// 화면 렌더링과 DOM 이벤트 처리. 게임 규칙은 game.js에 있다.

import { GameSession, MODE, PHASE } from './game.js';
import { DIFFICULTY } from './judge.js';
import { parseYouTubeLink } from './linkParser.js';
import { SCORING } from './scoring.js';
import { loadSettings, saveSettings, searchSongs, splitAliases } from './songs.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SEARCH_LIMIT = 20;
const MODE_LABEL ={ [MODE.RANDOM]: '랜덤듣기', [MODE.FULL]: '전체듣기' };
const DIFFICULTY_LABEL = {
  [DIFFICULTY.EASY]: '쉬움',
  [DIFFICULTY.NORMAL]: '보통',
  [DIFFICULTY.HARD]: '어려움',
};
const DIFFICULTY_HINT = {
  [DIFFICULTY.EASY]: '4지선다 객관식으로 곡 제목을 고릅니다.',
  [DIFFICULTY.NORMAL]: '곡 제목 또는 작품명(별칭 포함)을 입력하면 정답입니다.',
  [DIFFICULTY.HARD]: '곡 제목(별칭 포함)만 정답으로 인정합니다.',
};
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
    for (const name of ['mode', 'clipLength', 'rounds', 'difficulty']) {
      const input = $(`input[name="${name}"][value="${saved[name]}"]`);
      if (input) input.checked = true;
    }
  }

  readSettings() {
    const value = (name) => $(`input[name="${name}"]:checked`)?.value;
    return {
      mode: value('mode') === MODE.FULL ? MODE.FULL : MODE.RANDOM,
      clipLength: Number(value('clipLength')) || SCORING.defaultClipLength,
      rounds: Number(value('rounds')) || 10,
      difficulty: value('difficulty') || DIFFICULTY.NORMAL,
      timeLimit: SCORING.full.timeLimit,
    };
  }

  bindStart() {
    $('#screen-start').addEventListener('change', () => this.renderStart());
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
    $('#replay-btn').addEventListener('click', () => this.game?.replay());
    $('#pass-btn').addEventListener('click', () => this.game?.pass());
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
      if (!result.correct) input.select();
    });
  }

  showAnswerFeedback(result) {
    const fb = $('#feedback');
    if (result.correct) {
      fb.textContent = '';
      return;
    }
    fb.className = 'feedback bad';
    fb.textContent = result.revealed ? '기회를 모두 썼습니다.' : `틀렸어요. 남은 기회 ${result.attemptsLeft}번`;
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
      [PHASE.STOPPED]: '구간 재생이 끝났어요',
      [PHASE.REVEALED]: '정답 공개',
    }[phase] ?? '';

    // 진행 바
    $('#progress-bar').style.width = `${Math.round(game.progress * 100)}%`;
    $('#progress-label').textContent = game.isRandom
      ? `구간 ${s.clipLength}초`
      : `${Math.min(game.audibleElapsed(), s.timeLimit).toFixed(1)} / ${s.timeLimit}초`;

    // 컨트롤
    $('#play-btn').hidden = phase !== PHASE.READY;
    $('#replay-btn').hidden = !game.isRandom || revealed;
    $('#replay-btn').disabled = !game.canReplay;
    $('#replay-btn').textContent = round.replayUsed ? '다시듣기 사용함' : '다시듣기 (-20점)';
    $('#pass-btn').hidden = revealed;

    // 답 입력
    $('#answer-area').hidden = revealed;
    const easy = game.difficulty === DIFFICULTY.EASY;
    $('#choices').hidden = !easy;
    $('#answer-form').hidden = easy;
    const left = game.attemptsLeft;
    $('#attempts').textContent = `남은 기회 ${'●'.repeat(left)}${'○'.repeat(SCORING.maxWrongAttempts - left)}`;
    const input = $('#answer-input');
    input.disabled = !game.canAnswer;
    $('#answer-form button').disabled = !game.canAnswer;
    input.placeholder = game.difficulty === DIFFICULTY.HARD ? '곡 제목' : '곡 제목 또는 작품명';
    for (const [i, btn] of $$('#choices .btn').entries()) {
      const wrong = round.disabledChoices.has(i);
      btn.classList.toggle('wrong', wrong);
      btn.disabled = wrong || !game.canAnswer;
    }

    // 정답 공개
    $('#reveal').hidden = !revealed;
    if (revealed && round.result) {
      const { reason, points } = round.result;
      const resultEl = $('#reveal-result');
      resultEl.textContent = RESULT_TEXT[reason](points);
      resultEl.className = `reveal-result ${reason === 'correct' ? 'ok' : 'bad'}`;
      $('#reveal-title').replaceChildren(
        round.song.title,
        ...(round.song.artist ? [el('span', { class: 'reveal-artist', text: ` / ${round.song.artist}` })] : []),
      );
      $('#reveal-anime').textContent = [round.song.anime?.name, round.song.type].filter(Boolean).join(' · ');
      $('#next-btn').textContent = game.hasNext ? '다음 곡' : '결과 보기';
    }
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
    const isRecord = played && game.finishReason === 'complete' && this.highScores.submit(mode, game.score);
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
      ...game.history.map((h) =>
        el(
          'li',
          {},
          el('span', { class: 'pts', text: `${h.points}점` }),
          el('span', { class: h.correct ? 'ok' : 'bad', text: h.correct ? '○ ' : '× ' }),
          [h.song.title, h.song.anime?.name ?? h.song.artist].filter(Boolean).join(' — '),
        ),
      ),
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
      const parsed = parseYouTubeLink(f.link.value);
      if (!parsed) {
        this.toast('YouTube 링크 또는 11자리 영상 ID를 입력해 주세요.');
        return;
      }
      const exists = this.store.all().some((s) => s.videoId === parsed.videoId);
      const song = this.store.add({
        videoId: parsed.videoId,
        title: f.title.value,
        titleAliases: splitAliases(f.titleAliases.value),
        artist: f.artist.value,
        artistAliases: splitAliases(f.artistAliases.value),
        anime: { name: f.animeName.value, aliases: splitAliases(f.animeAliases.value) },
        type: f.type.value,
        hookStart: f.hookStart.value === '' ? undefined : Number(f.hookStart.value),
        enabled: true,
      });
      if (!song) {
        this.toast('곡 제목을 입력해 주세요.');
        return;
      }
      this.toast(exists ? `같은 영상이 있어 교체했습니다: ${song.title}` : `추가했습니다: ${song.title}`);
      form.reset();
      hookInput.dataset.auto = '0';
      $('#link-result').textContent = '';
      this.renderManage();
    });

    $('#song-search').addEventListener('input', () => this.renderSearch());

    $('#export-btn').addEventListener('click', () => {
      const json = this.store.exportJson();
      $('#import-text').value = json;
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = el('a', { href: url, download: 'songs.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.toast('JSON을 내보냈습니다. 아래 입력란에도 복사해 두었습니다.');
    });

    $('#import-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      this.importText(await file.text());
      event.target.value = '';
    });
    $('#import-text-btn').addEventListener('click', () => this.importText($('#import-text').value));
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
        const detail = [song.anime?.name, song.type, song.videoId, song.source === 'base' ? 'songs.json' : '직접 추가'];
        return el(
          'li',
          { class: song.enabled ? '' : 'off' },
          el(
            'div',
            { class: 'info' },
            el('strong', { text: song.artist ? `${song.title} / ${song.artist}` : song.title }),
            el('span', { text: detail.filter(Boolean).join(' · ') }),
          ),
          el('label', { class: 'switch' }, toggle, '사용'),
          el('button', {
            type: 'button',
            class: 'btn small danger',
            text: '삭제',
            onclick: () => {
              if (!confirm(`"${song.title}"을(를) 삭제할까요?`)) return;
              this.store.remove(song.videoId);
              this.toast(`삭제했습니다: ${song.title}`);
              this.renderManage();
            },
          }),
        );
      }),
    );
  }
}
