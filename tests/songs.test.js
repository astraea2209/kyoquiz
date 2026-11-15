import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DurationCache,
  HighScores,
  SongStore,
  createMemoryStorage,
  mergeSongs,
  normalizeSong,
  parseSongList,
  splitAliases,
} from '../js/songs.js';
import { makeSong } from './helpers.js';

test('normalizeSong: 필수값 검사와 기본값', () => {
  assert.equal(normalizeSong({ videoId: 'bad', title: 'a', anime: { name: 'b' } }), null);
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: '', anime: { name: 'b' } }), null);
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: 'a', anime: {} }), null);
  const s = normalizeSong({
    videoId: 'abcdefghijk',
    title: ' 제목 ',
    titleAliases: 'A, B',
    anime: 'Work',
    type: '???',
    hookStart: '45',
    skipEnd: '',
  });
  assert.deepEqual(s, {
    id: 'abcdefghijk',
    videoId: 'abcdefghijk',
    title: '제목',
    titleAliases: ['A', 'B'],
    anime: { name: 'Work', aliases: [] },
    type: 'OP',
    enabled: true,
    hookStart: 45,
  });
});

test('splitAliases', () => {
  assert.deepEqual(splitAliases('a, b，c、 ,d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitAliases(''), []);
});

test('mergeSongs: videoId가 같으면 사용자 항목 우선, 사용 여부 덮어쓰기', () => {
  const base = [makeSong(1), makeSong(2)];
  const user = [makeSong(2, { title: '사용자 제목' }), makeSong(3)];
  const merged = mergeSongs(base, user, { [makeSong(1).videoId]: false });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((s) => s.videoId === makeSong(2).videoId).title, '사용자 제목');
  assert.equal(merged.find((s) => s.videoId === makeSong(1).videoId).enabled, false);
});

test('SongStore: 추가·토글·삭제·내보내기·가져오기', () => {
  const storage = createMemoryStorage();
  const store = new SongStore(storage, [makeSong(1)]);
  assert.equal(store.all().length, 1);

  assert.ok(store.add(makeSong(2)));
  assert.equal(store.add({ videoId: 'x' }), null);
  assert.equal(store.all().length, 2);

  store.setEnabled(makeSong(1).videoId, false);
  assert.equal(store.playable().length, 1);

  // 기본 곡 삭제는 removed 목록으로 숨김
  store.remove(makeSong(1).videoId);
  assert.equal(store.all().length, 1);
  // 같은 videoId를 다시 추가하면 되살아남
  store.add(makeSong(1, { title: '다시' }));
  assert.equal(store.all().length, 2);
  assert.equal(store.all().find((s) => s.videoId === makeSong(1).videoId).enabled, true);

  const json = store.exportJson();
  const fresh = new SongStore(createMemoryStorage(), []);
  const result = fresh.importJson(json);
  assert.deepEqual(result, { added: 2, invalid: 0 });
  assert.equal(fresh.all().length, 2);
  assert.ok(!('source' in JSON.parse(json)[0]));

  const r2 = fresh.importJson(JSON.stringify({ songs: [{ ...makeSong(9), enabled: false }, { bad: 1 }] }));
  assert.deepEqual(r2, { added: 1, invalid: 1 });
  assert.equal(fresh.all().find((s) => s.videoId === makeSong(9).videoId).enabled, false);
  assert.throws(() => fresh.importJson('{"x":1}'));
  assert.throws(() => fresh.importJson('not json'));
});

test('localStorage 값이 깨져 있어도 동작', () => {
  const storage = createMemoryStorage();
  storage.setItem('asq.userSongs', '{broken');
  const store = new SongStore(storage, []);
  assert.deepEqual(store.all(), []);
});

test('DurationCache, HighScores', () => {
  const storage = createMemoryStorage();
  const cache = new DurationCache(storage);
  assert.equal(cache.get('abc'), undefined);
  cache.set('abc', 0);
  assert.equal(cache.get('abc'), undefined);
  cache.set('abc', 201.5);
  assert.equal(new DurationCache(storage).get('abc'), 201.5);

  const hs = new HighScores(storage);
  assert.equal(hs.get('random'), null);
  assert.equal(hs.submit('random', 300), true);
  assert.equal(hs.submit('random', 200), false);
  assert.equal(hs.submit('full', 50), true);
  assert.equal(hs.get('random'), 300);
  assert.equal(hs.get('full'), 50);
});

test('songs.json의 곡은 모두 유효하고 id·videoId가 겹치지 않는다', () => {
  const base = JSON.parse(readFileSync(new URL('../songs.json', import.meta.url), 'utf8'));
  const { songs, invalid } = parseSongList(base);
  assert.equal(invalid, 0);
  assert.equal(songs.length, base.length);
  assert.equal(new Set(songs.map((s) => s.id)).size, songs.length);
  assert.equal(new Set(songs.map((s) => s.videoId)).size, songs.length);
});

test('songs.sample.json은 자리표시자', () => {
  const sample = JSON.parse(readFileSync(new URL('../songs.sample.json', import.meta.url), 'utf8'));
  assert.ok(sample.length >= 1);
  for (const s of sample) assert.match(s.videoId, /^VIDEO_ID_\d+$/);
  // 자리표시자는 실제 ID 형식이 아니므로 그대로 쓰면 걸러진다
  assert.equal(parseSongList(sample).songs.length, 0);
});
