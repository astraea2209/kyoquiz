// 게임 상태 머신. DOM·YouTube에 의존하지 않고, 플레이어는 인터페이스로 주입한다.
//
// 플레이어 인터페이스(js/player.js의 YouTube 어댑터와 tests/fakePlayer.js가 구현):
//   load(videoId, startSeconds)  cue(videoId)  play()  pause()  seek(seconds)
//   getCurrentTime()  getDuration()  mute()  unMute()
//   onStateChange(cb(state)) → 구독 해제 함수,  onError(cb(code)) → 구독 해제 함수
// state 값은 PLAYER_STATE 참고.

import { DIFFICULTY, buildChoices, canUseMultipleChoice, judgeAnswer, shuffle } from './judge.js';
import { SCORING, scoreFull, scoreRandom } from './scoring.js';
import { pickSegmentStart } from './segment.js';

export const MODE = Object.freeze({ RANDOM: 'random', FULL: 'full' });

export const PLAYER_STATE = Object.freeze({
  UNSTARTED: 'unstarted',
  ENDED: 'ended',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
  CUED: 'cued',
});

export const PHASE = Object.freeze({
  IDLE: 'idle',
  READY: 'ready', // 곡은 정해졌고 사용자의 "재생" 클릭을 기다림
  LOADING: 'loading', // 로드/탐색 중(음소거 상태)
  PLAYING: 'playing', // 소리가 나는 중
  STOPPED: 'stopped', // 랜덤 구간 재생이 끝나고 답을 기다림
  REVEALED: 'revealed',
  FINISHED: 'finished',
});

export const SKIP_ERROR_CODES = Object.freeze([2, 5, 100, 101, 150, 153]);

// 구간 시작 위치 근처에 도달했다고 볼 오차(초)
const SEEK_TOLERANCE = 0.3;

const defaultScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

export class GameSession {
  /**
   * @param {object} opts
   * @param {object[]} opts.songs       이번 게임에 쓸 수 있는(사용 중인) 곡
   * @param {object} opts.settings      {mode, clipLength, rounds, difficulty, timeLimit}
   * @param {object[]} opts.players     플레이어 1~2개. 2개면 번갈아 쓰며 다음 곡을 미리 cue한다.
   * @param {object} [opts.durationCache] {get(videoId), set(videoId, seconds)}
   * @param {Function} [opts.rng]
   * @param {Function} [opts.now]       ms 단위 시계
   * @param {object} [opts.scheduler]   {setInterval, clearInterval}
   */
  constructor({
    songs,
    settings,
    players,
    durationCache = null,
    rng = Math.random,
    now = () => Date.now(),
    scheduler = defaultScheduler,
    pollInterval = 150,
  }) {
    if (!players?.length) throw new Error('플레이어가 필요합니다');
    this.allSongs = songs.slice();
    this.settings = {
      mode: MODE.RANDOM,
      clipLength: SCORING.defaultClipLength,
      rounds: 10,
      difficulty: DIFFICULTY.NORMAL,
      timeLimit: SCORING.full.timeLimit,
      ...settings,
    };
    this.players = players;
    this.durationCache = durationCache;
    this.rng = rng;
    this.now = now;
    this.scheduler = scheduler;
    this.pollInterval = pollInterval;

    this.phase = PHASE.IDLE;
    this.difficulty = this.settings.difficulty;
    this.queue = [];
    this.totalRounds = 0;
    this.roundIndex = -1;
    this.round = null;
    this.history = [];
    this.score = 0;
    this.skippedSongs = [];
    this.notices = [];
    this.active = 0;
    this.preloaded = null; // {playerIndex, videoId}
    this.playerStates = players.map(() => PLAYER_STATE.UNSTARTED);
    this.pollId = null;
    this.listeners = { change: new Set(), toast: new Set() };

    this.unsubscribers = [];
    players.forEach((player, index) => {
      this.unsubscribers.push(
        player.onStateChange((state) => this.handleStateChange(index, state)),
        player.onError((code) => this.handleError(index, code)),
      );
    });
  }

  // ---------- 이벤트 ----------
  on(type, fn) {
    this.listeners[type].add(fn);
    return () => this.listeners[type].delete(fn);
  }
  emit(type, payload) {
    for (const fn of this.listeners[type]) fn(payload);
  }
  changed() {
    this.emit('change', this);
  }
  toast(message) {
    this.notices.push(message);
    this.emit('toast', message);
  }

  get player() {
    return this.players[this.active];
  }
  get isRandom() {
    return this.settings.mode === MODE.RANDOM;
  }

  // ---------- 게임 진행 ----------
  /** 시작 버튼 클릭 핸들러 안에서 호출해야 첫 곡 재생이 자동재생 차단에 걸리지 않는다. */
  start() {
    if (this.phase !== PHASE.IDLE) throw new Error('이미 시작한 게임입니다');
    const playable = this.allSongs.filter((s) => s.enabled !== false);
    if (playable.length === 0) {
      this.phase = PHASE.FINISHED;
      this.finishReason = 'no-songs';
      this.toast('재생할 수 있는 곡이 없습니다. 곡 관리에서 곡을 추가해 주세요.');
      this.changed();
      return;
    }
    this.allSongs = playable;
    if (this.difficulty === DIFFICULTY.EASY && !canUseMultipleChoice(playable)) {
      this.difficulty = DIFFICULTY.NORMAL;
      this.toast('객관식 보기를 만들 곡이 부족해 보통 난이도(주관식)로 진행합니다.');
    }
    this.queue = shuffle(playable, this.rng);
    this.totalRounds = Math.min(this.settings.rounds, this.queue.length);
    if (this.totalRounds < this.settings.rounds) {
      this.toast(`사용 가능한 곡이 ${this.queue.length}개라서 ${this.totalRounds}라운드로 진행합니다.`);
    }
    this.roundIndex = 0;
    this.setupRound(this.queue.shift());
    this.playCurrent();
  }

  setupRound(song) {
    this.round = {
      index: this.roundIndex,
      song,
      segmentStart: this.isRandom ? null : 0,
      replayUsed: false,
      wrongCount: 0,
      choices: this.difficulty === DIFFICULTY.EASY ? buildChoices(song, this.allSongs, this.rng) : null,
      disabledChoices: new Set(),
      wrongAnswers: [],
      result: null,
      heard: false,
      stage: null, // 'probe' | 'seek' | 'audible'
      seekObservedAt: null,
      accumulated: 0,
      audibleSince: null,
    };
    this.phase = PHASE.READY;
  }

  /** "재생" 버튼(또는 시작/다음 곡 클릭) 안에서 호출 */
  playCurrent() {
    if (this.phase !== PHASE.READY) return;
    const round = this.round;
    const { song } = round;
    const player = this.player;
    this.phase = PHASE.LOADING;
    player.mute();

    if (this.isRandom) {
      const duration = song.duration || this.durationCache?.get(song.videoId);
      if (duration) {
        round.segmentStart = this.pickStart(song, duration);
        round.stage = 'seek';
        player.load(song.videoId, round.segmentStart);
      } else {
        // 길이를 모르면 음소거로 0초부터 로드 → PLAYING에서 길이 확인 → seek → unMute
        round.stage = 'probe';
        player.load(song.videoId, 0);
      }
    } else {
      round.stage = 'seek';
      player.load(song.videoId, 0);
    }
    if (this.preloaded?.playerIndex === this.active) this.preloaded = null;
    this.startPolling();
    this.changed();
  }

  pickStart(song, duration) {
    return pickSegmentStart(
      {
        duration,
        clipLength: this.settings.clipLength,
        skipStart: song.skipStart,
        skipEnd: song.skipEnd,
        hookStart: song.hookStart,
      },
      this.rng,
    );
  }

  /** 랜덤듣기 다시듣기(라운드당 1회) */
  replay() {
    const round = this.round;
    if (!this.canReplay) return false;
    round.replayUsed = true;
    this.pauseAudio();
    round.stage = 'seek';
    round.seekObservedAt = null;
    this.phase = PHASE.LOADING;
    this.player.mute();
    this.player.seek(round.segmentStart);
    this.player.play();
    this.startPolling();
    this.changed();
    return true;
  }

  get canReplay() {
    return (
      this.isRandom &&
      !!this.round &&
      !this.round.replayUsed &&
      this.round.result == null &&
      this.round.heard &&
      (this.phase === PHASE.STOPPED || this.phase === PHASE.PLAYING) &&
      SCORING.replaysPerRound > 0
    );
  }

  get canAnswer() {
    return (
      !!this.round &&
      this.round.result == null &&
      this.round.heard &&
      [PHASE.PLAYING, PHASE.STOPPED, PHASE.LOADING].includes(this.phase)
    );
  }

  /**
   * 이 플레이어의 영상을 보여 줘도 되는지. 정답 공개 중인 현재 플레이어만 true.
   * YouTube가 iframe title에 영상 제목을 넣으므로, false인 플레이어는 UI에서 접근성 트리에서도 숨긴다.
   */
  isPlayerVisible(index) {
    return this.phase === PHASE.REVEALED && !!this.round?.heard && index === this.active;
  }

  get attemptsLeft() {
    return this.round ? SCORING.maxWrongAttempts - this.round.wrongCount : 0;
  }

  /** 주관식 답 제출 */
  submitAnswer(text) {
    if (!this.canAnswer || this.difficulty === DIFFICULTY.EASY) return null;
    if (!String(text ?? '').trim()) return null;
    const { correct } = judgeAnswer(text, this.round.song, this.difficulty);
    if (correct) {
      this.reveal('correct');
      return { correct: true };
    }
    this.round.wrongAnswers.push(String(text));
    return this.registerWrong();
  }

  /** 객관식 보기 선택 */
  chooseOption(index) {
    if (!this.canAnswer || this.difficulty !== DIFFICULTY.EASY) return null;
    const choice = this.round.choices?.[index];
    if (!choice || this.round.disabledChoices.has(index)) return null;
    if (choice.correct) {
      this.reveal('correct');
      return { correct: true };
    }
    this.round.disabledChoices.add(index);
    this.round.wrongAnswers.push(choice.label);
    return this.registerWrong();
  }

  registerWrong() {
    this.round.wrongCount++;
    if (this.round.wrongCount >= SCORING.maxWrongAttempts) {
      this.reveal('wrong');
      return { correct: false, attemptsLeft: 0, revealed: true };
    }
    this.changed();
    return { correct: false, attemptsLeft: this.attemptsLeft, revealed: false };
  }

  pass() {
    if (!this.round || this.round.result) return;
    if (![PHASE.LOADING, PHASE.PLAYING, PHASE.STOPPED, PHASE.READY].includes(this.phase)) return;
    this.reveal('pass');
  }

  /** 소리가 실제로 난 시간(초) */
  audibleElapsed() {
    const r = this.round;
    if (!r) return 0;
    const live = r.audibleSince != null ? this.now() - r.audibleSince : 0;
    return (r.accumulated + live) / 1000;
  }

  pauseAudio() {
    const r = this.round;
    if (r?.audibleSince != null) {
      r.accumulated += this.now() - r.audibleSince;
      r.audibleSince = null;
    }
  }

  reveal(reason) {
    const round = this.round;
    this.pauseAudio();
    this.stopPolling();
    let points = 0;
    if (reason === 'correct') {
      points = this.isRandom
        ? scoreRandom({ clipLength: this.settings.clipLength, replayUsed: round.replayUsed })
        : scoreFull({ elapsed: this.audibleElapsed(), timeLimit: this.settings.timeLimit });
    }
    round.result = {
      reason,
      correct: reason === 'correct',
      points,
      elapsed: this.isRandom ? null : this.audibleElapsed(),
    };
    this.score += points;
    this.history.push({ song: round.song, ...round.result });
    const wasPlaying = this.phase !== PHASE.READY;
    this.phase = PHASE.REVEALED;

    // 정답 공개: 영상을 보여 주고 소리를 들려준다.
    if (wasPlaying) {
      this.player.unMute();
      this.player.play();
    }
    this.preloadNext();
    this.changed();
  }

  get hasNext() {
    return this.roundIndex + 1 < this.totalRounds && this.queue.length > 0;
  }

  /** 다음 곡을 다른 플레이어에 cue해 둔다(플레이어가 1개면 공개 중인 영상을 지우지 않도록 생략). */
  preloadNext() {
    if (!this.hasNext || this.players.length < 2) return;
    const index = (this.active + 1) % this.players.length;
    const next = this.queue[0];
    this.players[index].cue(next.videoId);
    this.preloaded = { playerIndex: index, videoId: next.videoId };
  }

  /** "다음 곡" 클릭 핸들러 안에서 호출 */
  next() {
    if (this.phase !== PHASE.REVEALED) return;
    this.player.pause();
    if (!this.hasNext) {
      this.finish();
      return;
    }
    if (this.players.length > 1) this.active = (this.active + 1) % this.players.length;
    this.roundIndex++;
    this.setupRound(this.queue.shift());
    this.playCurrent();
  }

  finish(reason = 'complete') {
    this.stopPolling();
    this.pauseAudio();
    if (this.phase !== PHASE.IDLE) {
      for (const p of this.players) p.pause();
    }
    this.phase = PHASE.FINISHED;
    this.finishReason = reason;
    this.changed();
  }

  /** 게임 중단(시작 화면으로 나가기) */
  abort() {
    if (this.phase !== PHASE.FINISHED) this.finish('aborted');
  }

  /** 플레이어 이벤트 구독 해제. 게임을 버릴 때 호출 */
  dispose() {
    this.stopPolling();
    for (const off of this.unsubscribers) if (typeof off === 'function') off();
    this.unsubscribers = [];
    this.listeners.change.clear();
    this.listeners.toast.clear();
  }

  // ---------- 플레이어 이벤트 ----------
  handleStateChange(index, state) {
    this.playerStates[index] = state;
    if (index !== this.active || !this.round) return;
    const r = this.round;
    if (this.phase === PHASE.LOADING || this.phase === PHASE.PLAYING) {
      if (state === PLAYER_STATE.PLAYING) {
        if (r.stage === 'probe') this.tryProbe();
        else if (r.stage === 'audible' && r.audibleSince == null) r.audibleSince = this.now();
        this.tick();
      } else if (state === PLAYER_STATE.BUFFERING || state === PLAYER_STATE.PAUSED) {
        this.pauseAudio();
      } else if (state === PLAYER_STATE.ENDED && r.stage === 'audible') {
        if (this.isRandom) this.endClip();
        else this.reveal('timeout');
      }
    }
  }

  handleError(index, code) {
    if (index !== this.active) {
      if (this.preloaded?.playerIndex === index) this.preloaded = null;
      return;
    }
    if (![PHASE.LOADING, PHASE.PLAYING, PHASE.STOPPED].includes(this.phase)) return;
    const failed = this.round.song;
    this.stopPolling();
    this.pauseAudio();
    this.player.pause();
    this.skippedSongs.push({ song: failed, code });
    const known = SKIP_ERROR_CODES.includes(Number(code));
    const label = known ? `오류 ${code}` : `알 수 없는 오류 ${code}`;

    if (this.queue.length === 0) {
      this.totalRounds = this.roundIndex;
      if (this.totalRounds === 0) {
        this.toast(`재생할 수 없는 곡을 건너뛰었습니다(${label}). 재생 가능한 곡이 없어 게임을 끝냅니다.`);
        this.finish('no-playable');
      } else {
        this.toast(`재생할 수 없는 곡을 건너뛰었습니다(${label}). 남은 곡이 없어 ${this.totalRounds}라운드로 마칩니다.`);
        this.finish();
      }
      return;
    }
    const replacement = this.queue.shift();
    const before = this.totalRounds;
    this.totalRounds = Math.min(this.totalRounds, this.roundIndex + 1 + this.queue.length);
    let message = `재생할 수 없는 곡을 건너뛰고 다른 곡으로 바꿨습니다(${label}). 재생 버튼을 눌러 주세요.`;
    if (this.totalRounds < before) message += ` 곡이 부족해 ${this.totalRounds}라운드로 줄였습니다.`;
    this.setupRound(replacement);
    this.toast(message);
    this.changed();
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

  tryProbe() {
    const r = this.round;
    const duration = this.player.getDuration();
    if (!(duration > 0)) return false;
    this.durationCache?.set(r.song.videoId, duration);
    r.segmentStart = this.pickStart(r.song, duration);
    r.stage = 'seek';
    r.seekObservedAt = null;
    this.player.seek(r.segmentStart);
    return true;
  }

  endClip() {
    this.pauseAudio();
    this.player.pause();
    this.player.mute();
    this.stopPolling();
    this.phase = PHASE.STOPPED;
    this.changed();
  }

  tick() {
    const r = this.round;
    if (!r) return;
    const playing = this.playerStates[this.active] === PLAYER_STATE.PLAYING;

    if (this.phase === PHASE.LOADING) {
      if (r.stage === 'probe') {
        if (playing) this.tryProbe();
      }
      if (r.stage === 'seek' && playing) {
        const t = this.player.getCurrentTime();
        const start = r.segmentStart;
        const end = this.isRandom ? start + this.settings.clipLength - 0.2 : Infinity;
        const inRange = t >= start - SEEK_TOLERANCE && t < end;
        // 위치가 구간 안에 들어온 뒤 실제로 시간이 흐르는 것을 한 번 더 확인하고 소리를 켠다.
        // (seek 직후 이전 위치의 소리가 새어 나오지 않게 하기 위함)
        if (!inRange) {
          r.seekObservedAt = null;
        } else if (r.seekObservedAt == null || t <= r.seekObservedAt) {
          r.seekObservedAt = t;
        } else {
          r.seekObservedAt = null;
          this.player.unMute();
          r.stage = 'audible';
          r.heard = true;
          r.audibleSince = this.now();
          this.phase = PHASE.PLAYING;
        }
      }
    }

    if (this.phase === PHASE.PLAYING) {
      if (this.isRandom) {
        const t = this.player.getCurrentTime();
        if (t >= r.segmentStart + this.settings.clipLength) {
          this.endClip();
          return;
        }
      } else if (this.audibleElapsed() >= this.settings.timeLimit) {
        this.reveal('timeout');
        return;
      }
    }
    this.changed();
  }

  /** 진행률 0~1 (랜덤: 구간 진행, 전체: 제한시간 경과) */
  get progress() {
    const r = this.round;
    if (!r) return 0;
    if (this.isRandom) {
      if (this.phase === PHASE.STOPPED) return 1;
      if (this.phase !== PHASE.PLAYING) return 0;
      const t = this.player.getCurrentTime() - r.segmentStart;
      return Math.min(1, Math.max(0, t / this.settings.clipLength));
    }
    return Math.min(1, this.audibleElapsed() / this.settings.timeLimit);
  }
}
