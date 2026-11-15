#!/usr/bin/env node
// songs.json 점검: 영상 존재·임베드 가능 여부, 영상 길이, duration 차이, id·videoId 중복.
// 사용법: node tools/check-songs.mjs [파일경로] [--write]
//   --write  duration이 없거나 2초 넘게 틀린 곡을 실제 길이로 고쳐 파일을 다시 쓴다.
// 출력은 곡마다 한 줄 + 요약. 문제가 있으면 exit code 1.
// 네트워크와 무관한 함수는 export해서 tests/checkSongs.test.js에서 테스트한다.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isValidVideoId } from '../js/linkParser.js';

export const DURATION_TOLERANCE = 2;

/** oEmbed 응답 코드 → 'ok' | 'blocked'(임베드 금지) | 'missing'(없음) | 'error' */
export function classifyOembedStatus(status) {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'blocked';
  if (status === 400 || status === 404) return 'missing';
  return 'error';
}

/** watch 페이지 HTML에서 "lengthSeconds":"N"을 찾는다. 없으면 null */
export function parseLengthSeconds(html) {
  const m = /"lengthSeconds"\s*:\s*"(\d+)"/.exec(String(html ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * 저장된 duration과 실제 길이 비교.
 * 'ok' | 'missing'(저장값 없음) | 'mismatch'(허용 오차 초과) | 'unknown'(실제 길이 모름)
 */
export function compareDuration(stored, actual, tolerance = DURATION_TOLERANCE) {
  if (!(actual > 0)) return 'unknown';
  if (!(typeof stored === 'number' && stored > 0)) return 'missing';
  return Math.abs(stored - actual) > tolerance ? 'mismatch' : 'ok';
}

/** 중복된 id·videoId 값 목록 */
export function findDuplicates(songs) {
  const dup = (key) => {
    const seen = new Set();
    const out = new Set();
    for (const s of songs) {
      const v = s?.[key];
      if (v == null || v === '') continue;
      if (seen.has(v)) out.add(v);
      seen.add(v);
    }
    return [...out];
  };
  return { ids: dup('id'), videoIds: dup('videoId') };
}

/** duration 값을 바꾼 새 객체. 기존 키 순서 유지, 없으면 enabled 앞(없으면 끝)에 넣는다 */
export function withDuration(song, duration) {
  if (Object.hasOwn(song, 'duration')) return { ...song, duration };
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(song)) {
    if (k === 'enabled' && !placed) {
      out.duration = duration;
      placed = true;
    }
    out[k] = v;
  }
  if (!placed) out.duration = duration;
  return out;
}

const inline = (value) => {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
};

/** songs.json 형식(2칸 들여쓰기, 곡 필드는 한 줄씩, 안쪽 배열·객체는 한 줄)으로 직렬화 */
export function formatSongsJson(songs) {
  if (!songs.length) return '[]\n';
  const body = songs
    .map((song) => {
      const lines = Object.entries(song).map(([k, v]) => `    ${JSON.stringify(k)}: ${inline(v)}`);
      return `  {\n${lines.join(',\n')}\n  }`;
    })
    .join(',\n');
  return `[\n${body}\n]\n`;
}

/**
 * 한 곡의 점검 결과를 판정한다(네트워크 결과를 받아서).
 * info: { oembedStatus, length, fetchError? }
 * 반환: { level: 'ok'|'warn'|'fail', notes: string[], fixDuration?: number }
 */
export function judgeSong(song, info, { duplicateIds = [], duplicateVideoIds = [] } = {}) {
  const notes = [];
  let level = 'ok';
  const fail = (msg) => {
    notes.push(msg);
    level = 'fail';
  };
  const warn = (msg) => {
    notes.push(msg);
    if (level === 'ok') level = 'warn';
  };

  if (!isValidVideoId(song?.videoId)) fail('videoId 형식 오류');
  if (duplicateIds.includes(song?.id)) fail(`id 중복(${song.id})`);
  if (duplicateVideoIds.includes(song?.videoId)) fail('videoId 중복');

  if (info?.fetchError) fail(`확인 실패: ${info.fetchError}`);
  else if (info) {
    const kind = classifyOembedStatus(info.oembedStatus);
    if (kind === 'blocked') fail(`임베드 금지(${info.oembedStatus})`);
    else if (kind === 'missing') fail(`영상 없음(${info.oembedStatus})`);
    else if (kind === 'error') fail(`oEmbed 응답 ${info.oembedStatus}`);
  }

  let fixDuration;
  if (info && !info.fetchError) {
    const cmp = compareDuration(song?.duration, info.length);
    if (cmp === 'unknown') warn('길이 확인 불가');
    else if (cmp === 'missing') {
      warn('duration 없음');
      fixDuration = info.length;
    } else if (cmp === 'mismatch') {
      fail(`duration ${song.duration}초 ≠ 실제 ${info.length}초`);
      fixDuration = info.length;
    }
  }
  return { level, notes, fixDuration };
}

// ---------- 네트워크 ----------

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.8',
  // 일부 지역의 쿠키 동의 페이지를 건너뛰기 위함
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};
const TIMEOUT_MS = 15000;

async function fetchOembed(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let title;
  let author;
  if (res.status === 200) {
    try {
      const data = await res.json();
      title = data.title;
      author = data.author_name;
    } catch {
      /* 본문 파싱 실패는 무시 */
    }
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, title, author };
}

async function fetchLength(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseLengthSeconds(await res.text());
  } catch {
    return null;
  }
}

async function inspect(song) {
  if (!isValidVideoId(song?.videoId)) return null;
  try {
    const oembed = await fetchOembed(song.videoId);
    const length = classifyOembedStatus(oembed.status) === 'missing' ? null : await fetchLength(song.videoId);
    return { oembedStatus: oembed.status, title: oembed.title, author: oembed.author, length };
  } catch (error) {
    return { fetchError: error?.name === 'TimeoutError' ? '시간 초과' : String(error?.message ?? error) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

async function main(argv) {
  const write = argv.includes('--write');
  const fileArg = argv.find((a) => !a.startsWith('--'));
  const here = fileURLToPath(new URL('.', import.meta.url));
  const file = fileArg ? resolve(fileArg) : resolve(here, '..', 'songs.json');

  let songs;
  try {
    songs = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`읽기 실패: ${file} (${error.message})`);
    return 1;
  }
  if (!Array.isArray(songs)) {
    console.error('곡 배열(JSON)이 아닙니다');
    return 1;
  }

  const { ids, videoIds } = findDuplicates(songs);
  const infos = await mapLimit(songs, 4, inspect);
  const counts = { ok: 0, warn: 0, fail: 0 };
  let fixed = 0;
  let fixable = 0;
  const updated = songs.map((song, i) => {
    const info = infos[i];
    const r = judgeSong(song, info, { duplicateIds: ids, duplicateVideoIds: videoIds });
    if (r.fixDuration) fixable++;
    let { level } = r;
    const notes = [...r.notes];
    let out = song;
    if (write && r.fixDuration) {
      out = withDuration(song, r.fixDuration);
      fixed++;
      const idx = notes.findIndex((n) => n.startsWith('duration'));
      if (idx >= 0) notes[idx] = `duration → ${r.fixDuration}초로 고침`;
      // duration 외의 문제가 없으면 정상으로 본다
      const others = judgeSong(out, info, { duplicateIds: ids, duplicateVideoIds: videoIds });
      level = others.level;
    }
    counts[level]++;
    const tag = { ok: '정상', warn: '경고', fail: '문제' }[level];
    const len = info?.length ? mmss(info.length) : '?:??';
    const yt = info?.title ? ` ← ${clip(info.title, 40)} / ${clip(info.author, 20)}` : '';
    const extra = notes.length ? ` [${notes.join(', ')}]` : '';
    console.log(`${tag} ${song?.id ?? '-'} ${song?.videoId ?? '-'} ${len} ${clip(song?.title, 20)}${yt}${extra}`);
    return out;
  });

  if (write && fixed) {
    await writeFile(file, formatSongsJson(updated), 'utf8');
  }
  const summary = [`${songs.length}곡: 정상 ${counts.ok}, 경고 ${counts.warn}, 문제 ${counts.fail}`];
  if (write) summary.push(fixed ? `duration ${fixed}곡 고쳐서 저장함` : '고칠 duration 없음');
  else if (fixable) summary.push('--write로 duration을 채울 수 있음');
  console.log(summary.join(' · '));
  return counts.fail ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
