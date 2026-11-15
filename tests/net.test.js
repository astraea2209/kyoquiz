import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync, computeClockSample, estimateOffset, localToServer, serverToLocal } from '../js/online/net.js';

test('computeClockSample: 왕복이 대칭이면 정확한 offset', () => {
  // 서버 시계가 클라이언트보다 5000ms 빠르고, 편도 100ms
  const sample = computeClockSample({ sentAt: 1000, serverTime: 1000 + 100 + 5000, receivedAt: 1200 });
  assert.deepEqual(sample, { offset: 5000, rtt: 200 });
});

test('computeClockSample: 잘못된 값은 null', () => {
  assert.equal(computeClockSample({ sentAt: 10, serverTime: NaN, receivedAt: 20 }), null);
  assert.equal(computeClockSample({ sentAt: 30, serverTime: 5, receivedAt: 20 }), null);
  assert.equal(computeClockSample({ sentAt: 10, serverTime: 5 }), null);
});

test('estimateOffset: 왕복이 짧은 표본의 중앙값', () => {
  const samples = [
    { offset: 900, rtt: 800 }, // 지연이 큰 표본은 무시
    { offset: 100, rtt: 40 },
    { offset: 104, rtt: 50 },
    { offset: 96, rtt: 45 },
    { offset: 500, rtt: 900 },
  ];
  assert.equal(estimateOffset(samples), 100);
  assert.equal(estimateOffset([]), null);
  assert.equal(estimateOffset([{ offset: 7, rtt: 1 }, { offset: 9, rtt: 2 }], { best: 2 }), 8);
});

test('변환 함수는 서로 역변환', () => {
  assert.equal(serverToLocal(localToServer(1234, 55), 55), 1234);
});

test('ClockSync: pong으로 서버 시각 추정', () => {
  let local = 10_000;
  const sync = new ClockSync({ now: () => local });
  assert.equal(sync.synced, false);
  const ping = sync.startPing();
  local += 60; // 왕복 60ms
  assert.equal(sync.addPong(ping, 40_000 + 30), true); // 서버가 클라이언트보다 30_000 빠름
  assert.equal(sync.synced, true);
  assert.equal(sync.offset, 30_000);
  assert.equal(sync.serverNow(), local + 30_000);
  assert.equal(sync.msUntil(local + 30_500), 500);
});

test('ClockSync: 표본은 최근 maxSamples개만 유지', () => {
  let local = 0;
  const sync = new ClockSync({ now: () => local, maxSamples: 3 });
  for (let i = 0; i < 6; i++) {
    const ping = sync.startPing();
    local += 10;
    sync.addPong(ping, local - 5 + 100);
  }
  assert.equal(sync.samples.length, 3);
  assert.equal(sync.offset, 100);
});
