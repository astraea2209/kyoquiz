// 정답 판정: 정규화, 오타 허용, 난이도별 후보, 객관식 보기 생성.

export const DIFFICULTY = Object.freeze({ EASY: 'easy', NORMAL: 'normal', HARD: 'hard' });

/** NFKC → 소문자 → 문자/숫자/결합문자 외 모두 제거 */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

/** 정규화된 정답 길이에 따른 허용 편집거리 */
export function allowedDistance(length) {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

/** 코드 포인트 단위 레벤슈타인 거리 */
export function editDistance(a, b) {
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/** 입력이 후보 하나와 (오타 허용 범위 안에서) 일치하는지 */
export function matchesCandidate(input, candidate) {
  const a = normalizeAnswer(input);
  const b = normalizeAnswer(candidate);
  if (!a || !b) return false;
  const limit = allowedDistance(Array.from(b).length);
  if (Math.abs(Array.from(a).length - Array.from(b).length) > limit) return false;
  return editDistance(a, b) <= limit;
}

/** 난이도별 정답 후보 문자열 목록 */
export function answerCandidates(song, difficulty) {
  const titles = [song.title, ...(song.titleAliases ?? [])];
  if (difficulty === DIFFICULTY.HARD) return titles.filter(Boolean);
  const anime = song.anime ?? {};
  return [...titles, anime.name, ...(anime.aliases ?? [])].filter(Boolean);
}

/** 주관식 판정 */
export function judgeAnswer(input, song, difficulty) {
  for (const candidate of answerCandidates(song, difficulty)) {
    if (matchesCandidate(input, candidate)) return { correct: true, matched: candidate };
  }
  return { correct: false, matched: null };
}

export function shuffle(list, rng = Math.random) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 객관식 보기: 정답 제목 1개 + 다른 곡 제목(정규화 기준 중복 제외) 최대 count-1개.
 * @returns {{label: string, correct: boolean}[]}
 */
export function buildChoices(song, allSongs, rng = Math.random, count = 4) {
  const seen = new Set([normalizeAnswer(song.title)]);
  const distractors = [];
  for (const other of shuffle(allSongs, rng)) {
    if (other.videoId === song.videoId) continue;
    const key = normalizeAnswer(other.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    distractors.push(other.title);
    if (distractors.length >= count - 1) break;
  }
  const choices = [
    { label: song.title, correct: true },
    ...distractors.map((label) => ({ label, correct: false })),
  ];
  return shuffle(choices, rng);
}

/** 객관식이 가능한지(서로 다른 제목이 2개 이상) */
export function canUseMultipleChoice(allSongs) {
  return new Set(allSongs.map((s) => normalizeAnswer(s.title)).filter(Boolean)).size >= 2;
}
