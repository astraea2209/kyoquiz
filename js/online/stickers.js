// 채팅 이모지(그림 스티커). 서버(server/room.js)와 화면(js/online/ui.js)이 같은 목록을 쓴다.
// 그림은 img/stickers/에 두고, 새 이모지는 이 목록 끝에 추가한다(id는 영문 소문자·숫자·하이픈).

/** 보낼 수 있는 채팅 이모지(서버는 이 목록에 없는 id를 무시한다) */
export const STICKERS = Object.freeze([
  Object.freeze({ id: 'question', src: 'img/stickers/question.gif', label: '물음표' }),
  Object.freeze({ id: 'angry', src: 'img/stickers/angry.webp', label: '빡침' }),
]);

export function isSticker(id) {
  return STICKERS.some((s) => s.id === id);
}

/** id에 맞는 이모지(없으면 null) */
export function stickerById(id) {
  return STICKERS.find((s) => s.id === id) ?? null;
}
