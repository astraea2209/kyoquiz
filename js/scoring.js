// 점수 상수와 계산. 밸런스 조정은 이 파일의 SCORING만 바꾸면 된다.

export const SCORING = Object.freeze({
  random: {
    base: 100,
    clipFactors: Object.freeze({ 3: 1.5, 5: 1.0, 10: 0.7 }),
    replayPenalty: 20,
    minCorrect: 10,
  },
  full: {
    max: 100,
    decay: 80, // max - decay = 최저 점수(20)
    timeLimit: 30, // 초
  },
  // 멀티플레이(친구와 대결, 맞힌 사람 모두 속도 점수). 숫자는 초안이므로 플레이 테스트 뒤 여기만 고친다.
  multi: Object.freeze({
    speedBonusMax: 0.5, // 랜덤듣기: 기본 점수의 최대 +50%
    answerTimes: Object.freeze([10, 15, 20]), // 구간이 끝난 뒤 답변 시간(초)
    defaultAnswerTime: 15,
    minPlayers: 2,
    maxPlayers: 8,
  }),
  // 매우 어려움(제목·가수·작품명 모두 맞히기). 라운드 기본 점수(랜덤·전체듣기 공식)를 항목 가중치대로 나눠 주고,
  // 전부 맞히면 기본 점수의 completeBonus만큼 더 준다. 곡에 없는 항목은 빼고 나머지 가중치로 나눈다.
  extreme: Object.freeze({
    itemWeights: Object.freeze({ title: 2, artist: 1, anime: 1 }),
    completeBonus: 0.5,
    maxWrongAttempts: 5,
  }),
  maxWrongAttempts: 3,
  replaysPerRound: 1,
  clipLengths: Object.freeze([3, 5, 10]),
  defaultClipLength: 5,
  roundOptions: Object.freeze([5, 10, 20]),
});

/** 랜덤듣기 정답 점수 */
export function scoreRandom({ clipLength, replayUsed }, cfg = SCORING.random) {
  const factor = cfg.clipFactors[clipLength] ?? 1;
  const raw = cfg.base * factor - (replayUsed ? cfg.replayPenalty : 0);
  return Math.max(cfg.minCorrect, Math.round(raw));
}

/** 전체듣기 정답 점수. elapsed: 소리가 난 뒤 경과 초 */
export function scoreFull({ elapsed, timeLimit = SCORING.full.timeLimit }) {
  const cfg = SCORING.full;
  const t = Math.min(Math.max(0, elapsed), timeLimit);
  return Math.round(cfg.max - (cfg.decay * t) / timeLimit);
}

/**
 * 매우 어려움 항목 점수.
 * @param {number} base 맞힌 시점의 라운드 기본 점수(scoreRandom 또는 scoreFull)
 * @param {string} item 맞힌 항목
 * @param {string[]} items 이 곡에 있는 항목들
 */
export function scoreExtremeItem({ base, item, items }, cfg = SCORING.extreme) {
  const total = items.reduce((sum, key) => sum + (cfg.itemWeights[key] ?? 0), 0);
  if (!total) return 0;
  return Math.round((base * (cfg.itemWeights[item] ?? 0)) / total);
}

/** 매우 어려움에서 모든 항목을 맞혔을 때 보너스 */
export function scoreExtremeBonus(base, cfg = SCORING.extreme) {
  return Math.round(base * cfg.completeBonus);
}

/**
 * 멀티플레이 답변 창(초). 시작 신호 뒤 이 시간 안에 맞혀야 한다.
 * 랜덤듣기: 구간 길이 + 답변 제한시간, 전체듣기: 전체듣기 제한시간.
 */
export function answerWindow({ mode, clipLength, answerTime = SCORING.multi.defaultAnswerTime }) {
  return mode === 'full' ? SCORING.full.timeLimit : clipLength + answerTime;
}

/**
 * 멀티플레이 랜덤듣기 정답 점수: 기존 점수에 속도 보너스(최대 +50%)를 곱한다. 다시듣기 없음.
 * @param {number} elapsed 시작 신호부터 정답 도착까지(초)
 */
export function scoreMultiRandom({ clipLength, elapsed, answerTime = SCORING.multi.defaultAnswerTime }, cfg = SCORING.multi) {
  const base = scoreRandom({ clipLength, replayUsed: false });
  const window = clipLength + answerTime;
  const left = Math.min(1, Math.max(0, 1 - Math.max(0, elapsed) / window));
  return Math.round(base * (1 + cfg.speedBonusMax * left));
}

/** 멀티플레이 전체듣기 정답 점수: 개인전과 같다(감소 공식이 이미 속도를 반영). */
export function scoreMultiFull({ elapsed, timeLimit = SCORING.full.timeLimit }) {
  return scoreFull({ elapsed, timeLimit });
}

/** 모드에 맞는 멀티플레이 정답 점수 */
export function scoreMulti({ mode, clipLength, elapsed, answerTime }) {
  return mode === 'full' ? scoreMultiFull({ elapsed }) : scoreMultiRandom({ clipLength, elapsed, answerTime });
}
