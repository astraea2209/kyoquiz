// 온라인 대결 서버 주소 결정과 URL 만들기(순수 함수).

// 배포 뒤 여기에 Worker 주소를 넣으면 모든 사용자의 기본값이 된다.
// 예: 'https://anime-song-quiz-rooms.<계정>.workers.dev'
export const DEFAULT_SERVER_URL = '';
export const LOCAL_SERVER_PORT = 8787; // npm run server:dev

const SERVER_STORAGE_KEY = 'asq.server';

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/** 서버 주소 우선순위: 주소의 ?server= → 저장된 값 → localhost에서 열었으면 로컬 서버 → 기본값('' 이면 미설정) */
export function resolveServerUrl({ search = '', hostname = '', storage = null } = {}) {
  const fromQuery = new URLSearchParams(search).get('server');
  if (fromQuery) return trimSlash(fromQuery);
  try {
    const saved = storage?.getItem(SERVER_STORAGE_KEY);
    if (saved) return trimSlash(saved);
  } catch {
    // 저장소를 못 쓰는 환경
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `http://${hostname}:${LOCAL_SERVER_PORT}`;
  return trimSlash(DEFAULT_SERVER_URL);
}

export const roomsUrl = (serverUrl) => `${trimSlash(serverUrl)}/api/rooms`;

export function webSocketUrl(serverUrl, code) {
  const base = trimSlash(serverUrl).replace(/^http/i, 'ws');
  return `${base}/ws?code=${encodeURIComponent(code)}`;
}

/** 친구에게 보낼 초대 링크. ?server=를 직접 지정해 열었다면 그대로 이어 붙인다 */
export function buildInviteLink({ origin, pathname, search = '' }, code) {
  const params = new URLSearchParams();
  params.set('room', code);
  const server = new URLSearchParams(search).get('server');
  if (server) params.set('server', server);
  return `${origin}${pathname}?${params.toString()}`;
}

/** 주소의 ?room=를 읽어 올바른 코드면 돌려준다(형식은 server/room.js의 방 코드 규칙과 같다) */
export function roomCodeFromSearch(search = '') {
  const raw = new URLSearchParams(search).get('room');
  const code = String(raw ?? '').trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{5}$/.test(code) ? code : null;
}
