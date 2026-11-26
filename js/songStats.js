// 곡별 정답률 기록(친구와 대결의 매우 어려움만). 서버(server/room.js, server/index.js)와 화면(js/online/ui.js)이 같이 쓴다.
// 기록 형식: {players: 푼 사람 수, complete: 전부 맞힌 사람 수, hint: 힌트를 쓴 사람 수, items: {title, artist, anime: 그 항목을 맞힌 사람 수}}
// 한 사람이 같은 곡을 여러 번 풀면 그때마다 센다.

export const STAT_ITEMS = Object.freeze(['title', 'artist', 'anime']);

export function emptySongStats() {
  return { players: 0, complete: 0, hint: 0, items: {} };
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 저장소나 네트워크에서 온 값을 기록 형식으로 정리한다(모르는 키는 버리고 음수·소수는 고친다) */
export function sanitizeSongStats(raw) {
  const stats = emptySongStats();
  if (!raw || typeof raw !== 'object') return stats;
  stats.players = count(raw.players);
  stats.complete = Math.min(count(raw.complete), stats.players);
  stats.hint = Math.min(count(raw.hint), stats.players);
  for (const key of STAT_ITEMS) {
    if (raw.items && key in raw.items) stats.items[key] = Math.min(count(raw.items[key]), stats.players);
  }
  return stats;
}

/** 두 기록을 더한다(항목은 어느 한쪽에라도 있으면 남긴다) */
export function addSongStats(a, b) {
  const x = sanitizeSongStats(a);
  const y = sanitizeSongStats(b);
  const items = {};
  for (const key of STAT_ITEMS) {
    if (key in x.items || key in y.items) items[key] = (x.items[key] ?? 0) + (y.items[key] ?? 0);
  }
  return { players: x.players + y.players, complete: x.complete + y.complete, hint: x.hint + y.hint, items };
}

/**
 * 라운드 하나의 기록
 * @param {string[]} items  이 곡의 항목 키(round.items)
 * @param {{solved: Iterable<string>, hint: boolean}[]} participants  답할 수 있었던 사람들
 */
export function roundSongStats(items, participants) {
  const stats = emptySongStats();
  for (const key of items) if (STAT_ITEMS.includes(key)) stats.items[key] = 0;
  for (const p of participants) {
    const solved = new Set(p.solved);
    stats.players++;
    if (p.hint) stats.hint++;
    for (const key of Object.keys(stats.items)) if (solved.has(key)) stats.items[key]++;
    if (Object.keys(stats.items).every((key) => solved.has(key))) stats.complete++;
  }
  return stats;
}

/** 0~100 정수 백분율. 푼 사람이 없으면 null */
export function percent(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : null;
}

/** 항목 칸에 붙일 정답률. 기록이 없거나 그 항목이 없으면 null */
export function itemRate(stats, key) {
  if (!stats?.players || stats.items?.[key] == null) return null;
  return percent(stats.items[key], stats.players);
}

/** 정답 공개 화면의 요약 문구 */
export function formatStatsSummary(stats) {
  if (!stats?.players) return '';
  return `정답률 누적 ${stats.players}명 · 전부 맞힘 ${percent(stats.complete, stats.players)}%`;
}
