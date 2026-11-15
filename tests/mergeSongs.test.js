import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSong } from '../js/songs.js';
import { formatSongsJson } from '../tools/check-songs.mjs';
import { diffFields, mergeSongLists, orderSongFields } from '../tools/merge-songs.mjs';

const base = [
  {
    id: 'eva-op',
    videoId: 'o6wtDPVkKqI',
    title: '잔혹한 천사의 테제',
    titleAliases: [],
    anime: { name: '신세기 에반게리온', aliases: [] },
    artist: '타카하시 요코',
    type: 'OP',
    duration: 244,
    enabled: true,
  },
];
const incoming = (raw) => normalizeSong(raw);

test('mergeSongLists: 없는 영상만 끝에 추가하고 기존 곡은 그대로 둔다', () => {
  const r = mergeSongLists(base, [
    {
      name: 'a.json',
      invalid: 1,
      songs: [
        incoming({ videoId: 'aaaaaaaaaaa', title: '밤양갱', artist: '비비', duration: 150, enabled: true }),
        incoming({ ...base[0], artist: '高橋洋子', enabled: false }),
      ],
    },
  ]);
  assert.equal(r.songs.length, 2);
  assert.deepEqual(r.songs[0], base[0]);
  assert.equal(r.songs[1].title, '밤양갱');
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid, 1);
  assert.equal(r.existing.length, 1);
  assert.deepEqual(r.existing[0].diff, ['artist']); // enabled 차이는 무시
});

test('mergeSongLists: 파일끼리 같은 영상은 먼저 나온 것만, id 충돌은 videoId로 바꿈', () => {
  const r = mergeSongLists(base, [
    { name: 'a.json', songs: [incoming({ id: 'eva-op', videoId: 'bbbbbbbbbbb', title: '첫 번째' })] },
    { name: 'b.json', songs: [incoming({ videoId: 'bbbbbbbbbbb', title: '두 번째' })] },
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].song.title, '첫 번째');
  assert.equal(r.added[0].song.id, 'bbbbbbbbbbb');
  assert.equal(r.added[0].renamedFrom, 'eva-op');
  assert.equal(r.repeated.length, 1);
  assert.equal(r.repeated[0].source, 'b.json');
  // id가 videoId까지 이미 쓰이면 -2를 붙인다
  const r2 = mergeSongLists([...base, { ...base[0], id: 'ccccccccccc', videoId: 'ddddddddddd' }], [
    { name: 'c.json', songs: [incoming({ id: 'eva-op', videoId: 'ccccccccccc', title: 't' })] },
  ]);
  assert.equal(r2.added[0].song.id, 'ccccccccccc-2');
});

test('orderSongFields: songs.json과 같은 필드 순서', () => {
  const song = incoming({
    videoId: 'aaaaaaaaaaa',
    title: 't',
    artist: '가수',
    artistAliases: ['singer'],
    anime: 'a',
    duration: 100,
    hookStart: 30,
  });
  assert.deepEqual(Object.keys(orderSongFields(song)), [
    'id',
    'videoId',
    'title',
    'titleAliases',
    'anime',
    'artist',
    'artistAliases',
    'type',
    'hookStart',
    'duration',
    'enabled',
  ]);
  // 합친 결과를 songs.json 형식으로 써도 다시 읽힌다
  const text = formatSongsJson(mergeSongLists(base, [{ name: 'x', songs: [song] }]).songs);
  assert.equal(JSON.parse(text).length, 2);
});

test('diffFields: 같은 내용이면 빈 배열', () => {
  assert.deepEqual(diffFields(base[0], { ...base[0], enabled: false }), []);
  assert.deepEqual(diffFields(base[0], { ...base[0], duration: undefined, type: 'ED' }), ['type', 'duration']);
});
