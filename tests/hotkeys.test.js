// 게임 화면 단축키: 패스 K(입력칸 밖), Esc로 입력칸 빠져나오기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLUME_KEY_STEP, choiceKeyIndex, handleGameKey, isPassKey, isTypingTarget, volumeKeyDelta } from '../js/hotkeys.js';

const input = (type = 'text') => ({ tagName: 'INPUT', type, blurred: false, blur() { this.blurred = true; } });
const body = { tagName: 'BODY' };

function keyEvent(props) {
  return {
    key: '',
    code: '',
    target: body,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...props,
  };
}

test('isTypingTarget: 글자 입력칸만 true', () => {
  assert.equal(isTypingTarget(input()), true);
  assert.equal(isTypingTarget(input('search')), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget(input('range')), false, '볼륨 슬라이더');
  assert.equal(isTypingTarget(input('radio')), false);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(body), false);
  assert.equal(isTypingTarget(null), false);
});

test('isPassKey: K·k·한글 자판 ㅏ, 수정키·반복·조합 중은 제외', () => {
  assert.equal(isPassKey(keyEvent({ key: 'k', code: 'KeyK' })), true);
  assert.equal(isPassKey(keyEvent({ key: 'K', code: 'KeyK', shiftKey: true })), true);
  assert.equal(isPassKey(keyEvent({ key: 'ㅏ', code: 'KeyK' })), true);
  assert.equal(isPassKey(keyEvent({ key: 'Process', code: 'KeyK' })), true, '한글 IME가 key를 숨겨도 code로 인식');
  assert.equal(isPassKey(keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true })), false);
  assert.equal(isPassKey(keyEvent({ key: 'k', code: 'KeyK', metaKey: true })), false);
  assert.equal(isPassKey(keyEvent({ key: 'k', code: 'KeyK', repeat: true })), false);
  assert.equal(isPassKey(keyEvent({ key: 'k', code: 'KeyK', isComposing: true })), false);
  assert.equal(isPassKey(keyEvent({ key: 'j', code: 'KeyJ' })), false);
});

test('handleGameKey: 입력칸 밖에서 K → 패스', () => {
  let passed = 0;
  const event = keyEvent({ key: 'k', code: 'KeyK' });
  assert.equal(handleGameKey(event, { pass: () => ++passed > 0 }), 'pass');
  assert.equal(passed, 1);
  assert.equal(event.prevented, true);
});

test('handleGameKey: 입력칸 안에서 K는 글자 입력(패스 안 함)', () => {
  let passed = 0;
  const event = keyEvent({ key: 'k', code: 'KeyK', target: input() });
  assert.equal(handleGameKey(event, { pass: () => ++passed > 0 }), null);
  assert.equal(passed, 0);
  assert.equal(event.prevented, false);
});

test('handleGameKey: 패스할 수 없는 때(pass가 false)는 기본 동작을 막지 않음', () => {
  const event = keyEvent({ key: 'k', code: 'KeyK' });
  assert.equal(handleGameKey(event, { pass: () => false }), null);
  assert.equal(event.prevented, false);
});

test('handleGameKey: 입력칸에서 Esc → 입력칸 빠져나오기, 그다음 K로 패스', () => {
  const field = input();
  const esc = keyEvent({ key: 'Escape', code: 'Escape', target: field });
  assert.equal(handleGameKey(esc, { pass: () => true }), 'blur');
  assert.equal(field.blurred, true);
  assert.equal(handleGameKey(keyEvent({ key: 'Escape', code: 'Escape' }), { pass: () => true }), null, '입력칸 밖 Esc는 무시');
  assert.equal(handleGameKey(keyEvent({ key: 'Escape', target: input(), isComposing: true }), { pass: () => true }), null, '한글 조합 중 Esc는 조합 취소용');
});

test('handleGameKey: 패스할 수 없으면 K로 다음으로(정답 공개 중)', () => {
  const calls = [];
  const actions = { pass: () => (calls.push('pass'), false), next: () => (calls.push('next'), true) };
  const event = keyEvent({ key: 'k', code: 'KeyK' });
  assert.equal(handleGameKey(event, actions), 'next');
  assert.deepEqual(calls, ['pass', 'next']);
  assert.equal(event.prevented, true);
  // 답하는 중이면 패스만(다음으로는 부르지 않는다)
  calls.length = 0;
  assert.equal(handleGameKey(keyEvent({ key: 'k', code: 'KeyK' }), { pass: () => (calls.push('pass'), true), next: () => (calls.push('next'), true) }), 'pass');
  assert.deepEqual(calls, ['pass']);
  // 둘 다 안 되면 기본 동작 그대로, 입력칸 안에서는 다음으로도 안 함
  const none = keyEvent({ key: 'k', code: 'KeyK' });
  assert.equal(handleGameKey(none, { pass: () => false, next: () => false }), null);
  assert.equal(none.prevented, false);
  assert.equal(handleGameKey(keyEvent({ key: 'k', code: 'KeyK', target: input() }), { pass: () => false, next: () => true }), null);
  // 누르고 있어 반복되는 K로 여러 라운드를 건너뛰지 않는다
  assert.equal(handleGameKey(keyEvent({ key: 'k', code: 'KeyK', repeat: true }), { pass: () => false, next: () => true }), null);
});

test('volumeKeyDelta: ↑ +5, ↓ -5. 한 줄 입력칸에서도 되고 슬라이더·여러 줄 입력칸에서는 안 됨', () => {
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp' })), VOLUME_KEY_STEP);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowDown' })), -VOLUME_KEY_STEP);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowDown', repeat: true })), -VOLUME_KEY_STEP, '누르고 있으면 계속');
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: input() })), VOLUME_KEY_STEP, '답 입력칸');
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: { tagName: 'BUTTON' } })), VOLUME_KEY_STEP);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: input('range') })), 0, '슬라이더는 브라우저 기본 동작');
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: input('radio') })), 0);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: { tagName: 'TEXTAREA' } })), 0);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', target: { tagName: 'DIV', isContentEditable: true } })), 0);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', ctrlKey: true })), 0);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', shiftKey: true })), 0);
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowUp', isComposing: true })), 0, '한글 조합 중');
  assert.equal(volumeKeyDelta(keyEvent({ key: 'ArrowLeft' })), 0);
});

test('handleGameKey: ↑↓로 볼륨을 바꾸고 스크롤을 막는다', () => {
  const changes = [];
  const up = keyEvent({ key: 'ArrowUp', target: input() });
  assert.equal(handleGameKey(up, { pass: () => true, volume: (d) => changes.push(d) }), 'volume');
  assert.equal(up.prevented, true);
  handleGameKey(keyEvent({ key: 'ArrowDown' }), { pass: () => true, volume: (d) => changes.push(d) });
  assert.deepEqual(changes, [VOLUME_KEY_STEP, -VOLUME_KEY_STEP]);
  // volume을 안 넘기면(볼륨 제어 없음) 방향키는 그대로
  const plain = keyEvent({ key: 'ArrowUp' });
  assert.equal(handleGameKey(plain, { pass: () => true }), null);
  assert.equal(plain.prevented, false);
});

test('choiceKeyIndex: 숫자키 1~4(키패드 포함)는 보기 0~3, 그 밖은 -1', () => {
  assert.equal(choiceKeyIndex(keyEvent({ key: '1', code: 'Digit1' })), 0);
  assert.equal(choiceKeyIndex(keyEvent({ key: '4', code: 'Digit4' })), 3);
  assert.equal(choiceKeyIndex(keyEvent({ key: '2', code: 'Numpad2' })), 1);
  assert.equal(choiceKeyIndex(keyEvent({ key: '3', code: '' })), 2, 'code가 없으면 key로');
  assert.equal(choiceKeyIndex(keyEvent({ key: '5', code: 'Digit5' })), -1);
  assert.equal(choiceKeyIndex(keyEvent({ key: '0', code: 'Digit0' })), -1);
  assert.equal(choiceKeyIndex(keyEvent({ key: '1', code: 'Digit1', ctrlKey: true })), -1);
  assert.equal(choiceKeyIndex(keyEvent({ key: '1', code: 'Digit1', repeat: true })), -1, '누르고 있어도 한 번만');
  assert.equal(choiceKeyIndex(keyEvent({ key: 'k', code: 'KeyK' })), -1);
});

test('handleGameKey: 숫자키로 객관식 보기 고르기(입력칸 안에서는 안 함)', () => {
  const chosen = [];
  const actions = { pass: () => true, choose: (i) => (chosen.push(i), true) };
  const event = keyEvent({ key: '2', code: 'Digit2' });
  assert.equal(handleGameKey(event, actions), 'choose');
  assert.equal(event.prevented, true);
  assert.deepEqual(chosen, [1]);
  assert.equal(handleGameKey(keyEvent({ key: '2', code: 'Digit2', target: input() }), actions), null);
  // 고를 수 없으면(이미 틀린 보기, 공개 중) 기본 동작 그대로
  const blocked = keyEvent({ key: '1', code: 'Digit1' });
  assert.equal(handleGameKey(blocked, { pass: () => true, choose: () => false }), null);
  assert.equal(blocked.prevented, false);
  // choose를 안 넘기면 숫자키는 무시
  assert.equal(handleGameKey(keyEvent({ key: '1', code: 'Digit1' }), { pass: () => true }), null);
  assert.deepEqual(chosen, [1]);
});
