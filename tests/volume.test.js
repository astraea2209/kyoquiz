import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../js/songs.js';
import { DEFAULT_VOLUME, VOLUME_KEY, VolumeControl, bindVolumeInput, clampVolume } from '../js/volume.js';

const fakePlayer = () => {
  const calls = [];
  return { calls, setVolume: (v) => calls.push(v) };
};

test('clampVolume: 0~100 정수, 이상한 값은 기본값', () => {
  assert.equal(clampVolume(50), 50);
  assert.equal(clampVolume('35'), 35);
  assert.equal(clampVolume(33.6), 34);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(250), 100);
  assert.equal(clampVolume('abc'), DEFAULT_VOLUME);
  assert.equal(clampVolume(null), DEFAULT_VOLUME);
  assert.equal(clampVolume(''), DEFAULT_VOLUME);
  assert.equal(clampVolume('x', 10), 10);
});

test('저장값이 없으면 기본값, 있으면 그 값으로 시작', () => {
  const storage = createMemoryStorage();
  assert.equal(new VolumeControl(storage).value, DEFAULT_VOLUME);
  storage.setItem(VOLUME_KEY, '42');
  assert.equal(new VolumeControl(storage).value, 42);
  storage.setItem(VOLUME_KEY, '깨진 값');
  assert.equal(new VolumeControl(storage).value, DEFAULT_VOLUME);
});

test('attach하면 바로 적용, set하면 모든 플레이어에 적용하고 저장', () => {
  const storage = createMemoryStorage();
  const control = new VolumeControl(storage);
  const a = fakePlayer();
  const b = fakePlayer();
  control.attach([a]);
  assert.deepEqual(a.calls, [DEFAULT_VOLUME]);
  control.attach([b]); // 친구와 대결 플레이어는 나중에 붙는다
  control.set(30);
  assert.deepEqual(a.calls, [DEFAULT_VOLUME, 30]);
  assert.deepEqual(b.calls, [DEFAULT_VOLUME, 30]);
  assert.equal(storage.getItem(VOLUME_KEY), '30');
  control.set(30); // 같은 값이면 아무것도 안 한다
  assert.equal(a.calls.length, 2);
  control.set('oops'); // 잘못된 값은 현재 값 유지
  assert.equal(control.value, 30);
});

test('setVolume이 없거나 던지는 플레이어, 저장 실패는 무시', () => {
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const control = new VolumeControl(broken);
  const throwing = {
    setVolume: () => {
      throw new Error('not ready');
    },
  };
  control.attach([{}, throwing]);
  control.set(10);
  assert.equal(control.value, 10);
});

test('bindVolumeInput: 슬라이더 여러 개가 같은 값을 공유', () => {
  const control = new VolumeControl(createMemoryStorage());
  const makeInput = () => {
    const handlers = [];
    return { value: '', addEventListener: (type, fn) => handlers.push(fn), fire: (v, self) => { self.value = v; handlers.forEach((fn) => fn()); } };
  };
  const one = makeInput();
  const two = makeInput();
  const label = { textContent: '' };
  bindVolumeInput(control, one, label);
  const off = bindVolumeInput(control, two);
  assert.equal(one.value, String(DEFAULT_VOLUME));
  assert.equal(label.textContent, `${DEFAULT_VOLUME}%`);
  one.fire('25', one);
  assert.equal(control.value, 25);
  assert.equal(two.value, '25');
  assert.equal(label.textContent, '25%');
  off();
  one.fire('60', one);
  assert.equal(two.value, '25', '해제한 슬라이더는 갱신하지 않는다');
});
