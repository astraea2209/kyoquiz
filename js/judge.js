// 정답 판정: 정규화, 오타 허용, 난이도별 후보, 객관식 보기 생성.

export const DIFFICULTY = Object.freeze({ EASY: 'easy', NORMAL: 'normal', HARD: 'hard', EXTREME: 'extreme' });

/** 매우 어려움에서 맞혀야 하는 항목(표시 순서) */
export const EXTREME_ITEMS = Object.freeze(['title', 'artist', 'anime']);

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

// 여러 명이 부른 곡의 가수 구분자. 'and'와 '+'는 이름 안에 들어가는 경우가 많아(HIGH and MIGHTY COLOR,
// Aiobahn +81) 나누지 않는다. 'x'는 앞뒤에 공백이 있을 때만(A x B).
const ARTIST_SEPARATORS = /\s*(?:×|&|,|、|\/|\s+x\s+|\s+(?:feat\.?|ft\.|featuring|with)\s+)\s*/i;

/**
 * 가수 표기를 한 사람(팀)씩 나눈다. 나눌 게 없으면 빈 배열.
 * 'THE 아케보시 로켓'처럼 앞의 THE는 빼고 부르는 경우가 많아 뺀 이름도 넣는다.
 * @example splitArtistNames('키시다 교단 & THE 아케보시 로켓') → ['키시다 교단', 'THE 아케보시 로켓', '아케보시 로켓']
 */
export function splitArtistNames(artist) {
  const parts = String(artist ?? '')
    .split(ARTIST_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];
  const names = [];
  for (const part of parts) {
    names.push(part);
    const withoutThe = part.replace(/^the\s+/i, '');
    if (withoutThe !== part && withoutThe) names.push(withoutThe);
  }
  return names;
}

/**
 * 매우 어려움 항목별 정답 후보. 곡에 없는 항목(가수 없음, 작품 없는 일반 노래)은 빠진다.
 * 가수가 여러 명이면 그중 한 사람 이름만 맞혀도 인정한다(splitArtistNames).
 * @returns {Record<string, string[]>} EXTREME_ITEMS 순서
 */
export function itemCandidates(song) {
  const lists = {
    title: [song.title, ...(song.titleAliases ?? [])],
    artist: [song.artist, ...(song.artistAliases ?? []), ...splitArtistNames(song.artist)],
    anime: [song.anime?.name, ...(song.anime?.aliases ?? [])],
  };
  const result = {};
  for (const key of EXTREME_ITEMS) {
    const list = lists[key].filter((v) => typeof v === 'string' && v.trim());
    if (String(lists[key][0] ?? '').trim()) result[key] = list;
  }
  return result;
}

/**
 * 매우 어려움 판정: 입력 하나를 아직 못 맞힌 모든 항목과 비교한다.
 * @param {Iterable<string>} solved 이미 맞힌 항목
 * @returns {{matched: string[], already: string[]}} matched: 새로 맞힌 항목, already: 이미 맞힌 항목과만 일치
 */
export function judgeItems(input, song, solved = []) {
  const done = new Set(solved);
  const matched = [];
  const already = [];
  for (const [key, candidates] of Object.entries(itemCandidates(song))) {
    if (!candidates.some((c) => matchesCandidate(input, c))) continue;
    (done.has(key) ? already : matched).push(key);
  }
  return { matched, already };
}

/**
 * 채팅 글에 이 곡의 정답(제목·가수·작품명과 별칭)이 들어 있는지. 공개 전 채팅으로 정답이 새지 않게 막을 때 쓴다.
 * 글 전체가 정답 후보와 (오타 허용 범위 안에서) 같거나, 정규화한 글 안에 2글자 이상인 후보가 그대로 들어 있으면 true.
 */
export function revealsAnswer(text, song) {
  const normalized = normalizeAnswer(text);
  if (!normalized) return false;
  for (const candidates of Object.values(itemCandidates(song))) {
    for (const candidate of candidates) {
      if (matchesCandidate(text, candidate)) return true;
      const key = normalizeAnswer(candidate);
      if (Array.from(key).length >= 2 && normalized.includes(key)) return true;
    }
  }
  return false;
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
