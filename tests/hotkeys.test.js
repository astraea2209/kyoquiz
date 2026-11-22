// 게임 화면 단축키: 패스 K(입력칸 밖), Esc로 입력칸 빠져나오기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGameKey, isPassKey, isTypingTarget } from '../js/hotkeys.js';

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
