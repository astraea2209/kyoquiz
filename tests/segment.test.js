import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSegmentStart, segmentRange } from '../js/segment.js';

const fixed = (v) => () => v;

test('기본: 앞뒤 10% 제외', () => {
  const opts = { duration: 100, clipLength: 5 };
  assert.deepEqual(segmentRange(opts), { min: 10, max: 85, reason: 'range' });
  assert.equal(pickSegmentStart(opts, fixed(0)), 10);
  assert.equal(pickSegmentStart(opts, fixed(0.999999)), 85);
  for (let i = 0; i < 200; i++) {
    const s = pickSegmentStart(opts);
    assert.ok(s >= 10 && s + 5 <= 90, `start ${s}`);
  }
});

test('곡별 skipStart/skipEnd', () => {
  const r = segmentRange({ duration: 90, clipLength: 10, skipStart: 20, skipEnd: 5 });
  assert.deepEqual(r, { min: 20, max: 75, reason: 'range' });
  const r0 = segmentRange({ duration: 90, clipLength: 10, skipStart: 0, skipEnd: 0 });
  assert.deepEqual(r0, { min: 0, max: 80, reason: 'range' });
});

test('hookStart ±5초', () => {
  const r = segmentRange({ duration: 200, clipLength: 5, hookStart: 60, skipStart: 100 });
  assert.deepEqual(r, { min: 55, max: 65, reason: 'hook' });
  for (let i = 0; i < 100; i++) {
    const s = pickSegmentStart({ duration: 200, clipLength: 5, hookStart: 60 });
    assert.ok(s >= 55 && s <= 65);
  }
});

test('hookStart 경계: 0초 근처와 곡 끝 근처', () => {
  assert.deepEqual(segmentRange({ duration: 100, clipLength: 5, hookStart: 2 }), {
    min: 0,
    max: 7,
    reason: 'hook',
  });
  assert.deepEqual(segmentRange({ duration: 100, clipLength: 10, hookStart: 98 }), {
    min: 90,
    max: 90,
    reason: 'hook',
  });
  assert.equal(segmentRange({ duration: 100, clipLength: 5, hookStart: 0 }).min, 0);
});

test('짧은 곡: 범위가 없으면 가운데', () => {
  // 12초 곡, 10초 구간: 10% 제외 범위(1.2 ~ 0.8)가 비어 있음 → (12-10)/2 = 1
  assert.deepEqual(segmentRange({ duration: 12, clipLength: 10 }), { min: 1, max: 1, reason: 'short' });
  // 곡이 구간보다 짧으면 0초
  assert.equal(pickSegmentStart({ duration: 3, clipLength: 5 }), 0);
  // 정확히 구간 길이
  assert.equal(pickSegmentStart({ duration: 5, clipLength: 5 }), 0);
  // skip 값이 너무 커도 범위 안
  const s = pickSegmentStart({ duration: 60, clipLength: 5, skipStart: 50, skipEnd: 50 });
  assert.equal(s, 27.5);
});

test('결과는 항상 [0, duration-clip] 안', () => {
  for (const duration of [1, 4.9, 5, 5.1, 9.99, 33.33, 61, 240.7]) {
    for (const clipLength of [3, 5, 10]) {
      for (const hookStart of [undefined, 0, 3, duration, duration + 10]) {
        for (const r of [0, 0.5, 0.9999]) {
          const s = pickSegmentStart({ duration, clipLength, hookStart }, fixed(r));
          assert.ok(s >= 0 && s <= Math.max(0, duration - clipLength) + 1e-9, `${duration}/${clipLength}/${hookStart}/${r} → ${s}`);
        }
      }
    }
  }
});

test('duration이 없으면 오류', () => {
  assert.throws(() => pickSegmentStart({ duration: 0, clipLength: 5 }));
  assert.throws(() => pickSegmentStart({ clipLength: 5 }));
});

test('15초 구간: 구간이 곡 안에 들어가고, 짧은 곡은 가운데', () => {
  for (let i = 0; i < 50; i++) {
    const start = pickSegmentStart({ duration: 90, clipLength: 15 }, () => i / 50);
    assert.ok(start >= 9 && start + 15 <= 81, `start ${start}`);
  }
  assert.deepEqual(segmentRange({ duration: 16, clipLength: 15 }), { min: 0.5, max: 0.5, reason: 'short' });
  assert.equal(pickSegmentStart({ duration: 10, clipLength: 15 }), 0);
});
