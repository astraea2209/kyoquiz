// 게임 화면 단축키(개인전·친구와 대결 공용). DOM 이벤트 객체만 받는 순수 함수라 Node 테스트에서 가짜 객체로 확인한다.
//
// - K: 패스. 글자를 입력하는 칸(답·채팅 입력칸 등)에 포커스가 있을 때는 동작하지 않는다(정답 입력과 겹치지 않게).
// - Esc: 입력칸에서 빠져나온다(그다음 K로 패스).

// 글자를 입력하지 않는 input 종류. 여기서는 K를 단축키로 쓴다
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** 포커스된 요소가 글자를 입력하는 곳인지(input 텍스트류, textarea, select, contenteditable) */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has(String(target.type ?? 'text').toLowerCase());
}

/** 수정키 없는 K(한글 자판 상태의 ㅏ 포함). 키를 누르고 있어 반복되는 이벤트와 한글 조합 중 이벤트는 제외 */
export function isPassKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return false;
  return event.code === 'KeyK' || ['k', 'K', 'ㅏ'].includes(event.key);
}

/**
 * 게임 화면 keydown 처리.
 * @param {KeyboardEvent} event
 * @param {{pass: () => boolean}} actions  pass: 지금 패스할 수 있으면 패스하고 true
 * @returns {'pass'|'blur'|null}  처리한 동작(처리했으면 event.preventDefault()를 불렀다)
 */
export function handleGameKey(event, { pass }) {
  const target = event.target;
  if (event.key === 'Escape' && isTypingTarget(target) && !event.isComposing) {
    target.blur?.();
    event.preventDefault();
    return 'blur';
  }
  if (isPassKey(event) && !isTypingTarget(target) && pass()) {
    event.preventDefault();
    return 'pass';
  }
  return null;
}
