// 최근에 나온 곡: 새 게임에서 최근 곡을 출제 순서 뒤로 미룬다.
// 아예 빼지는 않으므로 곡이 적어도 라운드 수가 줄지 않고, 오래전에 나온 곡부터 다시 나온다.
// 개인전(localStorage)과 친구와 대결 서버(방 메모리)가 같이 쓴다.
import { shuffle } from './judge.js';

export const RECENT_SONGS_LIMIT = 100;
export const RECENT_SONGS_KEY = 'asq.recentSongs';

/**
 * 곡을 섞은 뒤 최근에 안 나온 곡을 앞에, 최근 곡은 오래전에 나온 것부터 뒤에 둔다.
 * @param {object[]} songs
 * @param {string[]} recentIds  videoId 목록(앞이 오래전, 끝이 가장 최근)
 */
export function orderByRecency(songs, recentIds, rng = Math.random) {
  const shuffled = shuffle(songs, rng);
  if (!recentIds?.length) return shuffled;
  const age = new Map(recentIds.map((id, i) => [id, i]));
  const fresh = [];
  const recent = [];
  for (const song of shuffled) (age.has(song.videoId) ? recent : fresh).push(song);
  recent.sort((a, b) => age.get(a.videoId) - age.get(b.videoId));
  return fresh.concat(recent);
}

/** 곡 하나를 가장 최근으로 기록한 새 목록(같은 곡은 한 번만, limit 넘으면 오래된 것부터 버림) */
export function addRecent(recentIds, videoId, limit = RECENT_SONGS_LIMIT) {
  const list = Array.isArray(recentIds) ? recentIds.filter((id) => id !== videoId) : [];
  if (typeof videoId === 'string' && videoId) list.push(videoId);
  return list.length > limit ? list.slice(list.length - limit) : list;
}

/** 저장값 검사: 문자열만, 중복은 나중 것만 남기고, limit개까지 */
export function sanitizeRecent(value, limit = RECENT_SONGS_LIMIT) {
  if (!Array.isArray(value)) return [];
  let list = [];
  for (const id of value) {
    if (typeof id === 'string' && id) list = addRecent(list, id, limit);
  }
  return list;
}

/** 개인전용 localStorage(또는 같은 인터페이스) 저장소 */
export class RecentSongs {
  constructor(storage, limit = RECENT_SONGS_LIMIT) {
    this.storage = storage;
    this.limit = limit;
  }
  list() {
    try {
      const raw = this.storage?.getItem(RECENT_SONGS_KEY);
      return raw ? sanitizeRecent(JSON.parse(raw), this.limit) : [];
    } catch {
      return [];
    }
  }
  add(videoId) {
    try {
      this.storage?.setItem(RECENT_SONGS_KEY, JSON.stringify(addRecent(this.list(), videoId, this.limit)));
    } catch {
      /* 저장 공간 부족 등은 무시 */
    }
  }
}
