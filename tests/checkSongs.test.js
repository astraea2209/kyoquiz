// tools/check-songs.mjs의 순수 함수 테스트(네트워크 사용 안 함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyOembedStatus,
  compareDuration,
  findDuplicates,
  formatSongsJson,
  judgeSong,
  parseLengthSeconds,
  withDuration,
} from '../tools/check-songs.mjs';

test('classifyOembedStatus: 응답 코드 분류', () => {
  assert.equal(classifyOembedStatus(200), 'ok');
  assert.equal(classifyOembedStatus(401), 'blocked');
  assert.equal(classifyOembedStatus(403), 'blocked');
  assert.equal(classifyOembedStatus(400), 'missing');
  assert.equal(classifyOembedStatus(404), 'missing');
  assert.equal(classifyOembedStatus(500), 'error');
  assert.equal(classifyOembedStatus(429), 'error');
});

test('parseLengthSeconds: watch 페이지 HTML에서 길이 추출', () => {
  assert.equal(parseLengthSeconds('..."videoId":"x","lengthSeconds":"244","keywords"...'), 244);
  assert.equal(parseLengthSeconds('"lengthSeconds" : "93"'), 93);
  assert.equal(parseLengthSeconds('"lengthSeconds":"0"'), null);
  assert.equal(parseLengthSeconds('<html>no data</html>'), null);
  assert.equal(parseLengthSeconds(undefined), null);
});

test('compareDuration: 2초 허용 오차', () => {
  assert.equal(compareDuration(244, 244), 'ok');
  assert.equal(compareDuration(242, 244), 'ok');
  assert.equal(compareDuration(241, 244), 'mismatch');
  assert.equal(compareDuration(247, 244), 'mismatch');
  assert.equal(compareDuration(undefined, 244), 'missing');
  assert.equal(compareDuration(0, 244), 'missing');
  assert.equal(compareDuration(244, null), 'unknown');
});

test('findDuplicates: id·videoId 중복', () => {
  const songs = [
    { id: 'a', videoId: 'AAAAAAAAAAA' },
    { id: 'b', videoId: 'BBBBBBBBBBB' },
    { id: 'a', videoId: 'CCCCCCCCCCC' },
    { id: 'd', videoId: 'BBBBBBBBBBB' },
  ];
  assert.deepEqual(findDuplicates(songs), { ids: ['a'], videoIds: ['BBBBBBBBBBB'] });
  assert.deepEqual(findDuplicates(songs.slice(0, 2)), { ids: [], videoIds: [] });
});

test('withDuration: 키 순서 유지', () => {
  const has = { id: 'a', duration: 10, enabled: true };
  assert.deepEqual(Object.keys(withDuration(has, 20)), ['id', 'duration', 'enabled']);
  assert.equal(withDuration(has, 20).duration, 20);
  assert.equal(has.duration, 10); // 원본은 그대로
  assert.deepEqual(Object.keys(withDuration({ id: 'a', type: 'OP', enabled: true }, 5)), ['id', 'type', 'duration', 'enabled']);
  assert.deepEqual(Object.keys(withDuration({ id: 'a' }, 5)), ['id', 'duration']);
});

test('formatSongsJson: songs.json 형식을 그대로 재현', () => {
  for (const name of ['songs.json', 'songs.sample.json']) {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(formatSongsJson(JSON.parse(text)), text, name);
  }
  assert.equal(formatSongsJson([]), '[]\n');
  assert.equal(
    formatSongsJson([{ id: 'x', a: [], o: {}, n: { name: 'w', aliases: ['p', 'q'] } }]),
    '[\n  {\n    "id": "x",\n    "a": [],\n    "o": {},\n    "n": { "name": "w", "aliases": ["p", "q"] }\n  }\n]\n',
  );
});

test('judgeSong: 판정', () => {
  const song = { id: 'a', videoId: 'AAAAAAAAAAA', title: 't', duration: 100 };
  assert.deepEqual(judgeSong(song, { oembedStatus: 200, length: 101 }), { level: 'ok', notes: [], fixDuration: undefined });

  const mismatch = judgeSong(song, { oembedStatus: 200, length: 110 });
  assert.equal(mismatch.level, 'fail');
  assert.equal(mismatch.fixDuration, 110);

  const missing = judgeSong({ ...song, duration: undefined }, { oembedStatus: 200, length: 90 });
  assert.equal(missing.level, 'warn');
  assert.equal(missing.fixDuration, 90);

  assert.equal(judgeSong(song, { oembedStatus: 200, length: null }).level, 'warn');
  assert.equal(judgeSong(song, { oembedStatus: 401, length: 100 }).level, 'fail');
  assert.equal(judgeSong(song, { oembedStatus: 404, length: null }).level, 'fail');
  assert.equal(judgeSong(song, { fetchError: '시간 초과' }).level, 'fail');
  assert.equal(judgeSong({ ...song, videoId: 'bad' }, null).level, 'fail');
  assert.equal(judgeSong(song, { oembedStatus: 200, length: 100 }, { duplicateIds: ['a'] }).level, 'fail');
  assert.equal(judgeSong(song, { oembedStatus: 200, length: 100 }, { duplicateVideoIds: ['AAAAAAAAAAA'] }).level, 'fail');
});
