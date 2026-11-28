import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_SONGS_KEY, RecentSongs, addRecent, orderByRecency, sanitizeRecent } from '../js/recentSongs.js';
import { GameSession, MODE } from '../js/game.js';
import { DIFFICULTY } from '../js/judge.js';
import { createMemoryStorage } from '../js/songs.js';
import { FakePlayer, createClock, makeSong, manualScheduler, seededRng } from './helpers.js';
import { createEnv } from './roomHelpers.js';

const ids = (songs) => songs.map((s) => s.videoId);

test('orderByRecency: 기록이 없으면 그냥 섞은 순서', () => {
  const songs = Array.from({ length: 8 }, (_, i) => makeSong(i + 1));
  const a = orderByRecency(songs, [], seededRng(3));
  const b = orderByRecency(songs, undefined, seededRng(3));
  assert.equal(a.length, 8);
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(new Set(ids(a)), new Set(ids(songs)));
});

test('orderByRecency: 최근 곡은 뒤로, 그중 오래전에 나온 곡이 먼저, 빼지는 않음', () => {
  const songs = Array.from({ length: 6 }, (_, i) => makeSong(i + 1));
  const recent = [songs[4].videoId, songs[0].videoId, songs[2].videoId]; // 5 → 1 → 3 순으로 나옴
  for (let seed = 1; seed <= 5; seed++) {
    const order = ids(orderByRecency(songs, recent, seededRng(seed)));
    assert.equal(order.length, 6);
    assert.deepEqual(new Set(order.slice(0, 3)), new Set([songs[1], songs[3], songs[5]].map((s) => s.videoId)));
    assert.deepEqual(order.slice(3), recent);
  }
});

test('orderByRecency: 모든 곡이 최근 곡이면 가장 오래전에 나온 곡부터', () => {
  const songs = Array.from({ length: 3 }, (_, i) => makeSong(i + 1));
  const recent = [songs[2].videoId, 'gone0000000', songs[0].videoId, songs[1].videoId];
  assert.deepEqual(ids(orderByRecency(songs, recent, seededRng(1))), [songs[2], songs[0], songs[1]].map((s) => s.videoId));
});

test('addRecent: 끝에 추가, 같은 곡은 맨 끝으로 옮김, 한도 넘으면 오래된 것부터 버림', () => {
  assert.deepEqual(addRecent([], 'a'), ['a']);
  assert.deepEqual(addRecent(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(addRecent(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  assert.deepEqual(addRecent(['a'], ''), ['a']);
  assert.deepEqual(addRecent(null, 'a'), ['a']);
});

test('sanitizeRecent: 문자열만, 중복은 나중 것, 한도까지', () => {
  assert.deepEqual(sanitizeRecent('x'), []);
  assert.deepEqual(sanitizeRecent(['a', 1, null, 'b', 'a', '']), ['b', 'a']);
  assert.deepEqual(sanitizeRecent(['a', 'b', 'c', 'd'], 2), ['c', 'd']);
});

test('RecentSongs: 저장하고 다시 읽음, 깨진 값은 빈 목록', () => {
  const storage = createMemoryStorage();
  const recent = new RecentSongs(storage, 2);
  assert.deepEqual(recent.list(), []);
  recent.add('a');
  recent.add('b');
  recent.add('c');
  assert.deepEqual(new RecentSongs(storage, 2).list(), ['b', 'c']);
  storage.setItem(RECENT_SONGS_KEY, '{깨짐');
  assert.deepEqual(recent.list(), []);
  recent.add('d');
  assert.deepEqual(recent.list(), ['d']);
});

function soloGame(songs, recentSongs, seed) {
  const durations = Object.fromEntries(songs.map((s) => [s.videoId, 200]));
  return new GameSession({
    songs,
    settings: { mode: MODE.FULL, rounds: 3, difficulty: DIFFICULTY.NORMAL },
    players: [new FakePlayer({ durations }), new FakePlayer({ durations })],
    recentSongs,
    rng: seededRng(seed),
    now: createClock(1000).now,
    scheduler: manualScheduler,
  });
}

function playAll(game) {
  game.start();
  const played = [];
  while (game.round && !game.round.result) {
    played.push(game.round.song.videoId);
    game.pass();
    if (!game.hasNext) break;
    game.next();
  }
  return played;
}

test('개인전: 공개한 곡을 기록하고 다음 게임은 안 나온 곡부터', () => {
  const songs = Array.from({ length: 6 }, (_, i) => makeSong(i + 1, { duration: 200 }));
  const recent = new RecentSongs(createMemoryStorage());
  const first = playAll(soloGame(songs, recent, 1));
  assert.equal(first.length, 3);
  assert.deepEqual(recent.list(), first);
  const second = playAll(soloGame(songs, recent, 1));
  assert.equal(second.length, 3);
  assert.equal(second.filter((id) => first.includes(id)).length, 0);
  // 곡이 다 나온 뒤에는 가장 오래전에 나온 곡부터 다시
  const third = playAll(soloGame(songs, recent, 1));
  assert.deepEqual(third, first);
});

test('대결: 한 판 더 하면 앞 판에 나온 곡을 뒤로 미룸', () => {
  const env = createEnv({ songCount: 4 });
  env.joinAll('a', 'b');
  env.send('a', { type: 'settings', settings: { rounds: 2 } });
  const playGame = () => {
    env.begin();
    const played = [];
    for (;;) {
      played.push(env.round().song.videoId);
      env.passRest();
      if (env.state().phase === 'results') break;
      env.timers.advance(env.room.revealMs);
      if (env.state().phase === 'results') break;
      env.readyAll();
      env.timers.advance(env.room.config.goLeadMs);
    }
    return played;
  };
  const first = playGame();
  assert.equal(first.length, 2);
  assert.deepEqual(env.room.recentVideoIds, first);
  const second = playGame();
  assert.equal(second.length, 2);
  assert.equal(second.filter((id) => first.includes(id)).length, 0);
  assert.deepEqual(env.room.recentVideoIds, [...first, ...second]);
});
