// 정답 공개 중 이모지 리액션. 서버(server/room.js)와 화면(js/online/ui.js)이 같은 목록을 쓴다.

/** 보낼 수 있는 이모지(서버는 이 목록에 없는 값을 무시한다) */
export const REACTIONS = Object.freeze(['👍', '😂', '😮', '😭', '🔥', '❤️', '👏', '🤔']);

/** 한 사람이 리액션을 보내는 최소 간격(ms). 연결 빈도 제한(40개/5초)에 걸리지 않을 만큼 넉넉하게 */
export const REACTION_COOLDOWN_MS = 400;

export function isReaction(value) {
  return REACTIONS.includes(value);
}
