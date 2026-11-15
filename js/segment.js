// 랜덤듣기 구간 시작 위치 선택.

export const SEGMENT = Object.freeze({
  edgeRatio: 0.1, // 앞뒤 10% 제외
  hookWindow: 5, // hookStart ±5초
});

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round1 = (v) => Math.round(v * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 구간 시작 가능 범위 계산.
 * @returns {{min: number, max: number, reason: 'hook'|'range'|'short'}}
 */
export function segmentRange({ duration, clipLength, skipStart, skipEnd, hookStart }) {
  if (!isNum(duration) || duration <= 0) throw new Error('duration이 필요합니다');
  const lastStart = Math.max(0, duration - clipLength);

  if (isNum(hookStart)) {
    return {
      min: clamp(hookStart - SEGMENT.hookWindow, 0, lastStart),
      max: clamp(hookStart + SEGMENT.hookWindow, 0, lastStart),
      reason: 'hook',
    };
  }

  const head = isNum(skipStart) ? skipStart : duration * SEGMENT.edgeRatio;
  const tail = isNum(skipEnd) ? skipEnd : duration * SEGMENT.edgeRatio;
  const min = Math.max(0, head);
  const max = Math.min(lastStart, duration - tail - clipLength);
  if (max < min) {
    // 곡이 짧거나 건너뛰기 값이 커서 범위가 없으면 가운데 구간을 쓴다.
    const center = clamp((duration - clipLength) / 2, 0, lastStart);
    return { min: center, max: center, reason: 'short' };
  }
  return { min, max, reason: 'range' };
}

export function pickSegmentStart(options, rng = Math.random) {
  const { min, max } = segmentRange(options);
  return clamp(round1(min + rng() * (max - min)), min, max);
}
