#!/usr/bin/env node
// 친구들이 보낸 곡 JSON(곡 관리 → "내가 추가한 곡만 내보내기")을 songs.json에 합친다.
// 사용법: node tools/merge-songs.mjs 친구1.json [친구2.json ...] [--into songs.json] [--write]
//   기본은 무엇이 추가될지 보여 주기만 한다. --write를 붙여야 songs.json에 저장한다.
// 규칙:
//   - songs.json에 없는 영상(videoId)만 끝에 추가한다. 이미 있는 곡은 바꾸지 않고, 내용이 다르면 다른 항목만 알려 준다
//   - 여러 파일에 같은 영상이 있으면 먼저 나온 것만 쓴다
//   - 형식이 틀린 항목(영상 ID나 제목 없음)은 건너뛴다
//   - id가 이미 쓰이고 있으면 videoId로 바꾸고, 그것도 쓰이면 뒤에 -2, -3을 붙인다
// 합친 뒤 node tools/check-songs.mjs --write로 영상 상태를 점검하고 길이를 채운다.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSong, parseSongList } from '../js/songs.js';
import { formatSongsJson } from './check-songs.mjs';

/** songs.json에 저장할 때의 필드 순서(기존 곡과 같은 순서) */
const FIELD_ORDER = [
  'id',
  'videoId',
  'title',
  'titleAliases',
  'anime',
  'artist',
  'artistAliases',
  'type',
  'hookStart',
  'skipStart',
  'skipEnd',
  'duration',
  'enabled',
];

/** 내용 비교에 쓰는 필드(enabled는 각자 브라우저의 켜기·끄기라서 뺀다) */
const COMPARE_FIELDS = FIELD_ORDER.filter((k) => !['id', 'videoId', 'enabled'].includes(k));

/** 정해진 필드 순서로 다시 만든 곡 객체 */
export function orderSongFields(song) {
  const out = {};
  for (const key of FIELD_ORDER) if (song[key] !== undefined) out[key] = song[key];
  for (const [key, value] of Object.entries(song)) if (!(key in out)) out[key] = value;
  return out;
}

/** 두 곡에서 값이 다른 필드 이름 목록(둘 다 normalizeSong을 거친 값으로 비교) */
export function diffFields(a, b) {
  const na = normalizeSong(a) ?? {};
  const nb = normalizeSong(b) ?? {};
  return COMPARE_FIELDS.filter((k) => JSON.stringify(na[k]) !== JSON.stringify(nb[k]));
}

function uniqueId(wanted, videoId, usedIds) {
  if (!usedIds.has(wanted)) return wanted;
  if (!usedIds.has(videoId)) return videoId;
  for (let n = 2; ; n++) {
    const candidate = `${videoId}-${n}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

/**
 * 기존 곡 목록에 새 곡을 합친다.
 * @param {object[]} baseSongs  songs.json 내용(그대로 유지된다)
 * @param {{name: string, songs: object[], invalid?: number}[]} sources  가져온 파일별 곡(normalizeSong을 거친 것)
 * @returns {{songs: object[], added: object[], existing: object[], repeated: object[], invalid: number}}
 *   added: [{song, source, renamedFrom?}], existing: [{song, source, diff}], repeated: [{song, source}]
 */
export function mergeSongLists(baseSongs, sources) {
  const byVideoId = new Map(baseSongs.map((s) => [s.videoId, s]));
  const usedIds = new Set(baseSongs.map((s) => s.id));
  const result = { songs: [...baseSongs], added: [], existing: [], repeated: [], invalid: 0 };

  for (const { name, songs, invalid = 0 } of sources) {
    result.invalid += invalid;
    for (const incoming of songs) {
      const current = byVideoId.get(incoming.videoId);
      if (current) {
        if (result.added.some((a) => a.song.videoId === incoming.videoId)) {
          result.repeated.push({ song: incoming, source: name });
        } else {
          result.existing.push({ song: incoming, source: name, diff: diffFields(current, incoming) });
        }
        continue;
      }
      const id = uniqueId(incoming.id, incoming.videoId, usedIds);
      const song = orderSongFields({ ...incoming, id });
      usedIds.add(id);
      byVideoId.set(song.videoId, song);
      result.songs.push(song);
      result.added.push({ song, source: name, ...(id !== incoming.id ? { renamedFrom: incoming.id } : {}) });
    }
  }
  return result;
}

async function main(argv) {
  const write = argv.includes('--write');
  const intoIdx = argv.indexOf('--into');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const target = intoIdx >= 0 && argv[intoIdx + 1] ? resolve(argv[intoIdx + 1]) : resolve(here, '..', 'songs.json');
  const files = argv.filter((a, i) => !a.startsWith('--') && !(intoIdx >= 0 && i === intoIdx + 1));
  if (!files.length) {
    console.error('사용법: node tools/merge-songs.mjs 친구1.json [친구2.json ...] [--into songs.json] [--write]');
    return 1;
  }

  let baseSongs;
  try {
    baseSongs = JSON.parse(await readFile(target, 'utf8'));
    if (!Array.isArray(baseSongs)) throw new Error('곡 배열(JSON)이 아닙니다');
  } catch (error) {
    console.error(`읽기 실패: ${target} (${error.message})`);
    return 1;
  }

  const sources = [];
  for (const file of files) {
    try {
      const { songs, invalid } = parseSongList(await readFile(resolve(file), 'utf8'));
      sources.push({ name: basename(file), songs, invalid });
    } catch (error) {
      console.error(`읽기 실패: ${file} (${error.message})`);
      return 1;
    }
  }

  const r = mergeSongLists(baseSongs, sources);
  for (const { song, source, renamedFrom } of r.added) {
    const extra = [song.artist, song.anime?.name, song.type, song.duration ? `${song.duration}초` : '길이 없음']
      .filter(Boolean)
      .join(' · ');
    const renamed = renamedFrom ? ` [id ${renamedFrom}가 이미 있어 ${song.id}로 바꿈]` : '';
    console.log(`추가 ${song.videoId} ${song.title} (${extra}) ← ${source}${renamed}`);
  }
  for (const { song, source, diff } of r.existing) {
    const note = diff.length ? `내용이 다름: ${diff.join(', ')} → 기존 곡 유지` : '같은 내용';
    console.log(`이미 있음 ${song.videoId} ${song.title} ← ${source} (${note})`);
  }
  for (const { song, source } of r.repeated) {
    console.log(`중복 ${song.videoId} ${song.title} ← ${source} (앞 파일의 곡을 씀)`);
  }

  const summary = [`새 곡 ${r.added.length}개`, `이미 있음 ${r.existing.length}개`];
  if (r.repeated.length) summary.push(`파일끼리 중복 ${r.repeated.length}개`);
  if (r.invalid) summary.push(`형식이 틀려 건너뜀 ${r.invalid}개`);
  if (write && r.added.length) {
    await writeFile(target, formatSongsJson(r.songs), 'utf8');
    summary.push(`${basename(target)}에 저장함 → 다음: node tools/check-songs.mjs --write`);
  } else if (write) {
    summary.push('추가할 곡이 없어 저장하지 않음');
  } else if (r.added.length) {
    summary.push('--write를 붙이면 저장');
  }
  console.log(summary.join(' · '));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
