import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSongStats, emptySongStats, formatStatsSummary, itemRate, percent, roundSongStats, sanitizeSongStats } from '../js/songStats.js';

test('라운드 기록: 사람 수, 항목별 맞힌 수, 전부 맞힘, 힌트', () => {
  const stats = roundSongStats(['title', 'artist', 'anime'], [
    { solved: ['title', 'artist', 'anime'], hint: false },
    { solved: new Map([['title', {}]]).keys(), hint: true },
    { solved: [], hint: false },
  ]);
  assert.deepEqual(stats, { players: 3, complete: 1, hint: 1, items: { title: 2, artist: 1, anime: 1 } });
});

test('라운드 기록: 작품 없는 곡은 항목 2개, 2개를 다 맞히면 전부 맞힘', () => {
  const stats = roundSongStats(['title', 'artist'], [{ solved: ['artist', 'title'], hint: false }]);
  assert.deepEqual(stats, { players: 1, complete: 1, hint: 0, items: { title: 1, artist: 1 } });
});

test('기록 더하기: 항목은 한쪽에만 있어도 남는다', () => {
  const a = { players: 4, complete: 1, hint: 2, items: { title: 3, artist: 1, anime: 2 } };
  const b = { players: 2, complete: 0, hint: 0, items: { title: 1, artist: 0 } };
  assert.deepEqual(addSongStats(a, b), { players: 6, complete: 1, hint: 2, items: { title: 4, artist: 1, anime: 2 } });
  assert.deepEqual(addSongStats(null, b), b);
});

test('정리: 모르는 키·음수·소수·사람 수보다 큰 값을 고친다', () => {
  assert.deepEqual(sanitizeSongStats({ players: 3.7, complete: -1, hint: 9, items: { title: 5, bogus: 1, artist: 'x' }, extra: 1 }), {
    players: 3,
    complete: 0,
    hint: 3,
    items: { title: 3, artist: 0 },
  });
  assert.deepEqual(sanitizeSongStats('nope'), emptySongStats());
});

test('정답률 표시: 백분율 반올림, 기록이 없으면 비움', () => {
  const stats = { players: 3, complete: 1, hint: 0, items: { title: 2, artist: 0 } };
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(0, 0), null);
  assert.equal(itemRate(stats, 'title'), 67);
  assert.equal(itemRate(stats, 'artist'), 0);
  assert.equal(itemRate(stats, 'anime'), null);
  assert.equal(itemRate(null, 'title'), null);
  assert.equal(itemRate({ players: 0, items: { title: 0 } }, 'title'), null);
  assert.equal(formatStatsSummary(stats), '정답률 누적 3명 · 전부 맞힘 33%');
  assert.equal(formatStatsSummary(null), '');
});
