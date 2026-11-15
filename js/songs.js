// 곡 데이터: 검증, 병합, localStorage 저장, 내보내기/가져오기.
import { isValidVideoId } from './linkParser.js';

export const SONG_TYPES = Object.freeze(['OP', 'ED', '삽입곡']);

export const STORAGE_KEYS = Object.freeze({
  userSongs: 'asq.userSongs',
  enabled: 'asq.enabledOverrides',
  removed: 'asq.removedVideoIds',
  durations: 'asq.durationCache',
  highScores: 'asq.highScores',
  settings: 'asq.lastSettings',
});

const toStringList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return splitAliases(value);
  return [];
};

const optionalSeconds = (value) => {
  if (value === '' || value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** "a, b ,c" → ['a','b','c'] (쉼표·전각쉼표·읽기점 구분) */
export function splitAliases(text) {
  return String(text ?? '')
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 원시 객체를 곡 스키마로 정리한다. 필수값(videoId, title, anime.name)이 없으면 null.
 */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const videoId = String(raw.videoId ?? '').trim();
  const title = String(raw.title ?? '').trim();
  const animeRaw = typeof raw.anime === 'string' ? { name: raw.anime } : raw.anime ?? {};
  const animeName = String(animeRaw.name ?? '').trim();
  if (!isValidVideoId(videoId) || !title || !animeName) return null;

  const song = {
    id: String(raw.id ?? videoId),
    videoId,
    title,
    titleAliases: toStringList(raw.titleAliases),
    anime: { name: animeName, aliases: toStringList(animeRaw.aliases) },
    type: SONG_TYPES.includes(raw.type) ? raw.type : 'OP',
    enabled: raw.enabled !== false,
  };
  for (const key of ['hookStart', 'skipStart', 'skipEnd', 'duration']) {
    const v = optionalSeconds(raw[key]);
    if (v !== undefined) song[key] = v;
  }
  if (song.duration === 0) delete song.duration;
  return song;
}

/** JSON 텍스트(배열 또는 {songs: [...]})를 곡 목록으로. 잘못된 항목은 invalid로 센다. */
export function parseSongList(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const list = Array.isArray(data) ? data : Array.isArray(data?.songs) ? data.songs : null;
  if (!list) throw new Error('곡 배열(JSON)이 아닙니다');
  const songs = [];
  let invalid = 0;
  for (const item of list) {
    const song = normalizeSong(item);
    if (song) songs.push(song);
    else invalid++;
  }
  return { songs, invalid };
}

/**
 * 기본 목록과 사용자 목록을 합친다. videoId가 같으면 사용자 항목 우선.
 * enabledOverrides: {videoId: boolean}, removed: videoId 배열(기본 곡 삭제용)
 */
export function mergeSongs(baseSongs, userSongs, enabledOverrides = {}, removed = []) {
  const removedSet = new Set(removed);
  const map = new Map();
  for (const s of baseSongs) if (!removedSet.has(s.videoId)) map.set(s.videoId, { ...s, source: 'base' });
  for (const s of userSongs) map.set(s.videoId, { ...s, source: 'user' });
  return [...map.values()].map((s) =>
    Object.hasOwn(enabledOverrides, s.videoId) ? { ...s, enabled: !!enabledOverrides[s.videoId] } : s,
  );
}

export const playableSongs = (songs) => songs.filter((s) => s.enabled);

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 공간 부족 등은 무시 */
  }
}

/** localStorage(또는 같은 인터페이스) 기반 곡 저장소 */
export class SongStore {
  constructor(storage, baseSongs = []) {
    this.storage = storage;
    this.baseSongs = baseSongs;
  }

  setBaseSongs(songs) {
    this.baseSongs = songs;
  }

  get userSongs() {
    const raw = readJson(this.storage, STORAGE_KEYS.userSongs, []);
    return Array.isArray(raw) ? raw.map(normalizeSong).filter(Boolean) : [];
  }

  get enabledOverrides() {
    return readJson(this.storage, STORAGE_KEYS.enabled, {});
  }

  get removed() {
    return readJson(this.storage, STORAGE_KEYS.removed, []);
  }

  all() {
    return mergeSongs(this.baseSongs, this.userSongs, this.enabledOverrides, this.removed);
  }

  playable() {
    return playableSongs(this.all());
  }

  /** 곡 추가(같은 videoId가 있으면 교체). 성공 시 정리된 곡, 실패 시 null */
  add(raw) {
    const song = normalizeSong(raw);
    if (!song) return null;
    const list = this.userSongs.filter((s) => s.videoId !== song.videoId);
    list.push(song);
    writeJson(this.storage, STORAGE_KEYS.userSongs, list);
    const overrides = this.enabledOverrides;
    delete overrides[song.videoId];
    writeJson(this.storage, STORAGE_KEYS.enabled, overrides);
    writeJson(this.storage, STORAGE_KEYS.removed, this.removed.filter((id) => id !== song.videoId));
    return song;
  }

  remove(videoId) {
    writeJson(
      this.storage,
      STORAGE_KEYS.userSongs,
      this.userSongs.filter((s) => s.videoId !== videoId),
    );
    if (this.baseSongs.some((s) => s.videoId === videoId)) {
      writeJson(this.storage, STORAGE_KEYS.removed, [...new Set([...this.removed, videoId])]);
    }
  }

  setEnabled(videoId, enabled) {
    const overrides = this.enabledOverrides;
    overrides[videoId] = !!enabled;
    writeJson(this.storage, STORAGE_KEYS.enabled, overrides);
  }

  exportJson() {
    // eslint-disable-next-line no-unused-vars
    const songs = this.all().map(({ source, ...rest }) => rest);
    return JSON.stringify(songs, null, 2);
  }

  /** JSON을 사용자 곡으로 가져온다. {added, invalid} 반환 */
  importJson(text) {
    const { songs, invalid } = parseSongList(text);
    for (const song of songs) {
      this.add(song);
      if (!song.enabled) this.setEnabled(song.videoId, false);
    }
    return { added: songs.length, invalid };
  }
}

/** videoId별 영상 길이 캐시 */
export class DurationCache {
  constructor(storage) {
    this.storage = storage;
  }
  get(videoId) {
    const v = readJson(this.storage, STORAGE_KEYS.durations, {})[videoId];
    return typeof v === 'number' && v > 0 ? v : undefined;
  }
  set(videoId, duration) {
    if (!(duration > 0)) return;
    const all = readJson(this.storage, STORAGE_KEYS.durations, {});
    all[videoId] = duration;
    writeJson(this.storage, STORAGE_KEYS.durations, all);
  }
}

/** 모드별 최고 점수 */
export class HighScores {
  constructor(storage) {
    this.storage = storage;
  }
  get(mode) {
    return readJson(this.storage, STORAGE_KEYS.highScores, {})[mode] ?? null;
  }
  /** 기록 갱신 시 true */
  submit(mode, score) {
    const all = readJson(this.storage, STORAGE_KEYS.highScores, {});
    const prev = all[mode];
    if (prev == null || score > prev) {
      all[mode] = score;
      writeJson(this.storage, STORAGE_KEYS.highScores, all);
      return true;
    }
    return false;
  }
}

export function loadSettings(storage) {
  return readJson(storage, STORAGE_KEYS.settings, null);
}
export function saveSettings(storage, settings) {
  writeJson(storage, STORAGE_KEYS.settings, settings);
}

/** 테스트·폴백용 메모리 저장소 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
