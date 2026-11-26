// Cloudflare Workers + Durable Objects 진입점.
//
//   POST /api/rooms        → 방을 만들고 {code}를 돌려준다
//   GET  /ws?code=ABCDE    → WebSocket 업그레이드(방 하나 = Durable Object 하나)
//   GET  /api/health       → 상태 확인
//
// 곡별 정답률(매우 어려움)은 서버 전체에 하나뿐인 StatsDO의 저장소에 남는다(재배포해도 유지). 밖에서는 직접 부를 수 없다.
// 방 상태는 Durable Object의 메모리에만 있다. 배포·재시작으로 객체가 내려가면 진행 중인 방은 사라진다
// (1차 범위: 친구끼리 한 판). 규칙은 server/room.js, 소켓 처리는 server/roomHost.js에 있고 여기는 연결만 한다.
// 환경 변수 ALLOWED_ORIGINS: 허용할 사이트 주소를 쉼표로 나열(예: https://example.com). "*" 또는 빈 값이면 제한 없음.

import songs from '../songs.json';
import { generateRoomCode, normalizeRoomCode } from './room.js';
import { RoomHost } from './roomHost.js';
import { addSongStats, sanitizeSongStats } from '../js/songStats.js';

const MAX_CODE_ATTEMPTS = 8;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** 방에서 쓰는 곡별 정답률 저장소 연결. 실패해도 게임은 계속되도록 Room이 오류를 삼킨다 */
function statsClient(env) {
  if (!env.STATS) return null;
  const stub = () => env.STATS.get(env.STATS.idFromName('global'));
  const url = (path, videoId) => `https://stats/${path}?videoId=${encodeURIComponent(videoId)}`;
  return {
    async get(videoId) {
      const res = await stub().fetch(url('get', videoId));
      return res.ok ? res.json() : null;
    },
    add(videoId, delta) {
      return stub().fetch(url('add', videoId), { method: 'POST', body: JSON.stringify(delta) });
    },
  };
}

/** 예측하기 어려운 0~1 난수(방 코드용) */
function secureRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

function originAllowed(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0 || allowed.includes('*')) return true;
  return !origin || allowed.includes(origin); // Origin이 없는 비브라우저 클라이언트는 통과
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!originAllowed(origin, env)) return new Response('허용되지 않은 사이트입니다.', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/health') return json({ ok: true }, 200, origin);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const code = generateRoomCode(secureRandom);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(`https://room/init?code=${code}`, { method: 'POST' });
        if (res.ok) return json({ code }, 201, origin);
        if (res.status !== 409) break;
      }
      return json({ error: '방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, 503, origin);
    }

    if (url.pathname === '/ws') {
      const code = normalizeRoomCode(url.searchParams.get('code'));
      if (!code) return new Response('방 코드 형식이 올바르지 않습니다.', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.host = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      if (this.host?.isOpen) return new Response('exists', { status: 409 });
      const code = normalizeRoomCode(url.searchParams.get('code'));
      if (!code) return new Response('bad code', { status: 400 });
      this.host = new RoomHost({
        code,
        songs,
        genToken: () => crypto.randomUUID(),
        stats: statsClient(this.env),
        onClose: () => {
          this.host = null;
        },
      });
      return new Response('ok');
    }

    if (url.pathname === '/ws') {
      if (!this.host?.isOpen) return new Response('방을 찾을 수 없습니다.', { status: 404 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 연결이 필요합니다.', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const host = this.host;
      const connId = host.connect(server);
      if (connId) {
        server.addEventListener('message', (event) => host.message(connId, event.data));
        server.addEventListener('close', () => host.disconnect(connId));
        server.addEventListener('error', () => host.disconnect(connId));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}

/** 곡별 정답률 저장소. 곡 하나 = 키 하나(song:<videoId>). Durable Object는 요청을 하나씩 처리하므로 읽고 더해 쓰는 사이에 끼어드는 요청이 없다 */
export class StatsDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get('videoId') ?? '';
    if (!VIDEO_ID.test(videoId)) return new Response('bad videoId', { status: 400 });
    const key = `song:${videoId}`;

    if (url.pathname === '/get') {
      const stored = await this.ctx.storage.get(key);
      return Response.json(stored ? sanitizeSongStats(stored) : null);
    }

    if (url.pathname === '/add' && request.method === 'POST') {
      let delta;
      try {
        delta = sanitizeSongStats(await request.json());
      } catch {
        return new Response('bad body', { status: 400 });
      }
      const next = addSongStats(await this.ctx.storage.get(key), delta);
      await this.ctx.storage.put(key, next);
      return Response.json(next);
    }

    return new Response('Not found', { status: 404 });
  }
}
