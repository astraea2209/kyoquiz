// 게임 화면 단축키(개인전·친구와 대결 공용). DOM 이벤트 객체만 받는 순수 함수라 Node 테스트에서 가짜 객체로 확인한다.
//
// - K: 답하는 중이면 패스, 정답 공개 중이면 다음으로(개인전 '다음 곡', 친구와 대결 넘기기 투표).
//   글자를 입력하는 칸(답·채팅 입력칸 등)에 포커스가 있을 때는 동작하지 않는다(정답 입력과 겹치지 않게).
// - Esc: 입력칸에서 빠져나온다(그다음 K로 패스).
// - ↑/↓: 노래 볼륨 ±VOLUME_KEY_STEP. 한 줄 입력칸(답·채팅)에서도 된다(입력 중에도 바로 조절하게).
//   볼륨 슬라이더 자체에서는 브라우저 기본 동작(1씩)에 맡기고, 여러 줄 입력칸·선택 목록에서는 쓰지 않는다.
// - 1~4: 쉬움(객관식)에서 보기 고르기. 글자 입력칸에서는 동작하지 않는다.
// - Tab: 친구와 대결에서 답 입력칸 ↔ 채팅 입력칸 전환(옮길 곳이 없으면 브라우저 기본 Tab).

// 글자를 입력하지 않는 input 종류. 여기서는 K를 단축키로 쓴다
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** ↑/↓ 한 번에 바꾸는 볼륨 */
export const VOLUME_KEY_STEP = 5;

const tagOf = (target) => String(target?.tagName ?? '').toUpperCase();
const inputType = (target) => String(target?.type ?? 'text').toLowerCase();

/** 포커스된 요소가 글자를 입력하는 곳인지(input 텍스트류, textarea, select, contenteditable) */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = tagOf(target);
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has(inputType(target));
}

const hasModifier = (event) => event.ctrlKey || event.metaKey || event.altKey;

/** 수정키 없는 K(한글 자판 상태의 ㅏ 포함). 키를 누르고 있어 반복되는 이벤트와 한글 조합 중 이벤트는 제외 */
export function isPassKey(event) {
  if (!event || hasModifier(event) || event.repeat || event.isComposing) return false;
  return event.code === 'KeyK' || ['k', 'K', 'ㅏ'].includes(event.key);
}

/**
 * ↑/↓ 볼륨 키면 바꿀 양(+/-VOLUME_KEY_STEP), 아니면 0. 누르고 있으면 반복해서 바뀐다.
 * 볼륨 슬라이더·라디오(방향키가 원래 값을 바꿈), 여러 줄 입력칸·선택 목록·contenteditable(줄 이동)에서는 0
 */
export function volumeKeyDelta(event) {
  if (!event || hasModifier(event) || event.shiftKey || event.isComposing) return 0;
  const delta = event.key === 'ArrowUp' ? VOLUME_KEY_STEP : event.key === 'ArrowDown' ? -VOLUME_KEY_STEP : 0;
  if (!delta) return 0;
  const target = event.target;
  if (target?.isContentEditable) return 0;
  const tag = tagOf(target);
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 0;
  if (tag === 'INPUT' && ['range', 'radio', 'number'].includes(inputType(target))) return 0;
  return delta;
}

/** 객관식(쉬움) 보기 고르기 숫자키 1~4(키패드 포함)면 보기 번호 0~3, 아니면 -1 */
export function choiceKeyIndex(event) {
  if (!event || hasModifier(event) || event.repeat || event.isComposing) return -1;
  const match = /^(?:Digit|Numpad)([1-4])$/.exec(event.code ?? '') ?? /^([1-4])$/.exec(event.key ?? '');
  return match ? Number(match[1]) - 1 : -1;
}

/**
 * 게임 화면 keydown 처리.
 * @param {KeyboardEvent} event
 * @param {object} actions
 * @param {() => boolean} actions.pass  지금 패스할 수 있으면 패스하고 true
 * @param {() => boolean} [actions.next]  정답 공개 중이라 다음으로 넘어갈 수 있으면 넘기고 true
 * @param {(delta: number) => void} [actions.volume]  볼륨을 delta만큼 바꾼다
 * @param {(index: number) => boolean} [actions.choose]  객관식 보기 index를 고를 수 있으면 고르고 true
 * @param {(target: EventTarget) => boolean} [actions.toggleInput]  Tab: target에서 다른 입력칸(답↔채팅)으로 옮길 수 있으면 옮기고 true
 * @returns {'pass'|'next'|'blur'|'volume'|'choose'|'toggle'|null}  처리한 동작(처리했으면 event.preventDefault()를 불렀다)
 */
export function handleGameKey(event, { pass, next = () => false, volume = null, choose = null, toggleInput = null }) {
  const target = event.target;
  // Tab(Shift+Tab 포함): 답 입력칸 ↔ 채팅 입력칸. 바꿀 수 없으면 브라우저 기본 Tab 이동
  if (toggleInput && event.key === 'Tab' && !hasModifier(event) && toggleInput(target)) {
    event.preventDefault();
    return 'toggle';
  }
  if (event.key === 'Escape' && isTypingTarget(target) && !event.isComposing) {
    target.blur?.();
    event.preventDefault();
    return 'blur';
  }
  if (volume) {
    const delta = volumeKeyDelta(event);
    if (delta) {
      volume(delta);
      event.preventDefault(); // 화면 스크롤·입력칸 커서 이동 대신
      return 'volume';
    }
  }
  const choice = choose ? choiceKeyIndex(event) : -1;
  if (choice >= 0 && !isTypingTarget(target) && choose(choice)) {
    event.preventDefault();
    return 'choose';
  }
  if (isPassKey(event) && !isTypingTarget(target)) {
    if (pass()) {
      event.preventDefault();
      return 'pass';
    }
    if (next()) {
      event.preventDefault();
      return 'next';
    }
  }
  return null;
}
