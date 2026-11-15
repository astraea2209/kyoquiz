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
