import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DurationCache,
  HighScores,
  SongStore,
  createMemoryStorage,
  formatDurationText,
  mergeSongs,
  normalizeSong,
  parseDurationText,
  parseSongList,
  searchSongs,
  songFromForm,
  songToFormValues,
  splitAliases,
} from '../js/songs.js';
import { makeSong } from './helpers.js';

test('normalizeSong: 필수값 검사와 기본값', () => {
  assert.equal(normalizeSong({ videoId: 'bad', title: 'a', anime: { name: 'b' } }), null);
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: '', anime: { name: 'b' } }), null);
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', anime: { name: 'b' } }), null);
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

test('normalizeSong: 가수(artist)는 선택 필드로 보존', () => {
  const base = { videoId: 'abcdefghijk', title: 't', anime: { name: 'a' } };
  assert.equal(normalizeSong({ ...base, artist: ' YOASOBI ' }).artist, 'YOASOBI');
  assert.ok(!('artist' in normalizeSong(base)));
  assert.ok(!('artist' in normalizeSong({ ...base, artist: '  ' })));
  assert.ok(!('artist' in normalizeSong({ ...base, artist: 123 })));

  // 추가 → 내보내기 → 가져오기에서도 유지
  const store = new SongStore(createMemoryStorage(), [makeSong(1, { artist: '기본 가수' })]);
  store.add({ ...base, artist: 'LiSA' });
  const fresh = new SongStore(createMemoryStorage(), []);
  fresh.importJson(store.exportJson());
  assert.equal(fresh.all().find((s) => s.videoId === 'abcdefghijk').artist, 'LiSA');
  assert.equal(fresh.all().find((s) => s.videoId === makeSong(1).videoId).artist, '기본 가수');
});

test('normalizeSong: 일반 노래는 제목만 있으면 되고 작품 필드를 넣지 않는다', () => {
  const s = normalizeSong({ videoId: 'abcdefghijk', title: '밤양갱', anime: { name: '  ', aliases: ['x'] } });
  assert.deepEqual(s, {
    id: 'abcdefghijk',
    videoId: 'abcdefghijk',
    title: '밤양갱',
    titleAliases: [],
    type: '일반곡',
    enabled: true,
  });
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: 't' }).type, '일반곡');
  // 작품이 있으면 종류 기본값은 OP, 지정한 종류는 그대로
  assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: 't', anime: 'a', type: '' }).type, 'OP');
  for (const type of ['OST', '캐릭터송', '일반곡', '기타', '삽입곡']) {
    assert.equal(normalizeSong({ videoId: 'abcdefghijk', title: 't', type }).type, type);
  }
});

test('normalizeSong: 가수 별칭(artistAliases)은 가수가 있을 때만 보존', () => {
  const base = { videoId: 'abcdefghijk', title: 't' };
  assert.deepEqual(normalizeSong({ ...base, artist: '아이유', artistAliases: 'IU, 李知恩' }).artistAliases, [
    'IU',
    '李知恩',
  ]);
  assert.ok(!('artistAliases' in normalizeSong({ ...base, artist: '아이유', artistAliases: [] })));
  assert.ok(!('artistAliases' in normalizeSong({ ...base, artistAliases: ['IU'] })));

  const store = new SongStore(createMemoryStorage(), []);
  store.add({ ...base, artist: '아이유', artistAliases: ['IU'] });
  const fresh = new SongStore(createMemoryStorage(), []);
  fresh.importJson(store.exportJson());
  const song = fresh.all()[0];
  assert.deepEqual(song.artistAliases, ['IU']);
  assert.ok(!('anime' in song));
});

test('searchSongs: 제목·작품·가수·별칭·videoId 부분 일치, 공백·대소문자 무시', () => {
  const songs = [
    { videoId: 'aaaaaaaaaaa', title: '군청', titleAliases: ['Gunjou'], artist: 'YOASOBI', type: '일반곡' },
    {
      videoId: 'bbbbbbbbbbb',
      title: '아이돌',
      titleAliases: ['アイドル'],
      anime: { name: '최애의 아이', aliases: ['Oshi no Ko'] },
      artist: 'YOASOBI',
      artistAliases: ['요아소비'],
      type: 'OP',
    },
    { videoId: 'ccccccccccc', title: '밤양갱', titleAliases: [], artist: '비비', type: '일반곡' },
  ];
  const ids = (q, limit) => searchSongs(songs, q, limit).matches.map((s) => s.videoId[0]);
  assert.deepEqual(ids('yoasobi'), ['a', 'b']);
  assert.deepEqual(ids('요아소비'), ['b']);
  assert.deepEqual(ids('oshi  NO'), ['b']);
  assert.deepEqual(ids('최애'), ['b']);
  assert.deepEqual(ids('gun'), ['a']);
  assert.deepEqual(ids('ccccc'), ['c']);
  assert.deepEqual(ids('없는곡'), []);
  assert.deepEqual(searchSongs(songs, '  ', 20), { matches: [], total: 0 });
  // limit을 넘으면 matches는 잘리고 total은 전체 수
  const r = searchSongs(songs, 'yoasobi', 1);
  assert.equal(r.matches.length, 1);
  assert.equal(r.total, 2);
});

test('parseDurationText: 초, 분:초, 시:분:초', () => {
  assert.equal(parseDurationText(''), undefined);
  assert.equal(parseDurationText('  '), undefined);
  assert.equal(parseDurationText('225'), 225);
  assert.equal(parseDurationText('3:45'), 225);
  assert.equal(parseDurationText(' 3：05 '), 185);
  assert.equal(parseDurationText('1:02:03'), 3723);
  assert.equal(parseDurationText('0'), null);
  assert.equal(parseDurationText('0:00'), null);
  assert.equal(parseDurationText('3:75'), null);
  assert.equal(parseDurationText('1:60:00'), null);
  assert.equal(parseDurationText('3분'), null);
  assert.equal(parseDurationText('-5'), null);
});

test('formatDurationText: 초 → 분:초, parseDurationText와 왕복', () => {
  assert.equal(formatDurationText(undefined), '');
  assert.equal(formatDurationText(0), '');
  assert.equal(formatDurationText(225), '3:45');
  assert.equal(formatDurationText(65), '1:05');
  assert.equal(formatDurationText(59), '0:59');
  assert.equal(formatDurationText(3723), '1:02:03');
  assert.equal(formatDurationText(212.5), '212.5');
  for (const s of [59, 225, 3600, 3723, 212.5]) assert.equal(parseDurationText(formatDurationText(s)), s);
});

test('songToFormValues → songFromForm: 수정하지 않으면 같은 곡이 된다', () => {
  const original = normalizeSong(
    makeSong(1, {
      id: 'bleach-op2',
      artist: 'UVERworld',
      artistAliases: ['우버월드', '우버'],
      type: 'ED',
      hookStart: 42,
      skipStart: 5,
      skipEnd: 10,
      duration: 245,
      enabled: false,
    }),
  );
  const values = songToFormValues(original);
  assert.deepEqual(values, {
    link: original.videoId,
    title: 'Song Title 1',
    titleAliases: '별칭1',
    artist: 'UVERworld',
    artistAliases: '우버월드, 우버',
    animeName: 'Anime Work 1',
    animeAliases: '작품1',
    type: 'ED',
    duration: '4:05',
    hookStart: '42',
  });
  const raw = songFromForm(values, { videoId: original.videoId, duration: parseDurationText(values.duration) }, original);
  assert.deepEqual(normalizeSong(raw), original);
});

test('songFromForm: 수정은 id·skip·사용 여부를 유지하고 바꾼 값만 반영, 새 곡은 videoId가 id', () => {
  const original = normalizeSong(makeSong(2, { id: 'keep-id', skipStart: 3, enabled: false, duration: 200 }));
  const values = { ...songToFormValues(original), title: ' 새 제목 ', titleAliases: 'a, b', animeName: '', hookStart: '', duration: '' };
  const edited = normalizeSong(songFromForm(values, { videoId: original.videoId, duration: undefined }, original));
  assert.equal(edited.id, 'keep-id');
  assert.equal(edited.title, '새 제목');
  assert.deepEqual(edited.titleAliases, ['a', 'b']);
  assert.equal(edited.anime, undefined);
  assert.equal(edited.skipStart, 3);
  assert.equal(edited.enabled, false);
  assert.equal(edited.duration, undefined);
  assert.equal(edited.hookStart, undefined);

  const fresh = normalizeSong(songFromForm({ ...values, title: '새 곡' }, { videoId: 'abcdefghijk', duration: 100 }));
  assert.equal(fresh.id, 'abcdefghijk');
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.duration, 100);
});

test('SongStore: songs.json 곡 수정과 원래대로', () => {
  const store = new SongStore(createMemoryStorage(), [makeSong(1), makeSong(2)]);
  const vid = makeSong(1).videoId;
  assert.ok(store.isBaseSong(vid));
  assert.equal(store.isBaseSong('abcdefghijk'), false);
  assert.equal(store.revert(vid), false); // 고친 적 없음

  store.add({ ...makeSong(1), title: '고친 제목', enabled: false });
  assert.equal(store.all().find((s) => s.videoId === vid).title, '고친 제목');
  assert.equal(store.all().find((s) => s.videoId === vid).source, 'user');

  assert.ok(store.revert(vid));
  const back = store.all().find((s) => s.videoId === vid);
  assert.equal(back.title, 'Song Title 1');
  assert.equal(back.source, 'base');
  assert.equal(back.enabled, false); // 꺼 둔 상태는 유지
  assert.equal(store.all().length, 2);

  // 직접 추가한 곡은 되돌릴 원본이 없다
  store.add({ videoId: 'abcdefghijk', title: '내 곡' });
  assert.equal(store.revert('abcdefghijk'), false);
  assert.equal(store.all().length, 3);
});

test('SongStore.clearUserSongs: 내 곡을 모두 지우고 다음 내보내기는 빈 목록', () => {
  const store = new SongStore(createMemoryStorage(), [makeSong(1), makeSong(2), makeSong(3)]);
  assert.equal(store.clearUserSongs(), 0);

  store.add({ videoId: 'abcdefghijk', title: '내 곡' });
  store.setEnabled('abcdefghijk', false);
  store.add({ ...makeSong(1), title: '고친 곡', enabled: false });
  store.add({ ...makeSong(2), title: '고친 곡 2' });
  store.remove(makeSong(3).videoId); // songs.json 곡 숨김은 내 곡이 아니라 그대로

  assert.equal(store.clearUserSongs(), 3);
  assert.deepEqual(JSON.parse(store.exportJson({ userOnly: true })), []);
  const all = store.all();
  assert.deepEqual(all.map((s) => s.title).sort(), ['Song Title 1', 'Song Title 2']);
  assert.ok(all.every((s) => s.source === 'base'));
  assert.equal(all.find((s) => s.videoId === makeSong(1).videoId).enabled, false); // 꺼 둔 상태 유지
  assert.ok(!('abcdefghijk' in store.enabledOverrides)); // 지운 곡의 사용 여부 기록도 정리
  assert.equal(store.clearUserSongs(), 0);
});

test('exportJson({userOnly}): 직접 추가한 곡만 내보낸다', () => {
  const store = new SongStore(createMemoryStorage(), [makeSong(1), makeSong(2)]);
  store.add({ videoId: 'abcdefghijk', title: '내 곡', duration: 200 });
  store.add({ ...makeSong(2), title: '고친 기본 곡' });
  const mine = JSON.parse(store.exportJson({ userOnly: true }));
  assert.deepEqual(mine.map((s) => s.title).sort(), ['고친 기본 곡', '내 곡'].sort());
  assert.equal(mine.find((s) => s.title === '내 곡').duration, 200);
  assert.ok(mine.every((s) => !('source' in s)));
  assert.equal(JSON.parse(store.exportJson()).length, 3);
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
