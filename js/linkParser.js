// YouTube 링크/ID 파서. DOM에 의존하지 않으므로 Node에서도 테스트할 수 있다.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const PATH_PREFIXES = ['shorts', 'embed', 'live', 'v', 'e'];

export function isValidVideoId(id) {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

/**
 * "45", "45s", "1m5s", "1h2m3s", "01:05" 형태의 시간 값을 초로 바꾼다.
 * 해석할 수 없으면 null.
 */
export function parseTimeValue(raw) {
  if (raw == null) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.floor(Number(value));
  if (/^\d+(:\d{1,2}){1,2}$/.test(value)) {
    return value.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const [, h = '0', m = '0', s = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * YouTube 링크 또는 11자리 ID를 해석한다.
 * @returns {{videoId: string, startSeconds: number|null} | null}
 */
export function parseYouTubeLink(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  if (isValidVideoId(text)) return { videoId: text, startSeconds: null };

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  let videoId = null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.searchParams.has('v')) {
      videoId = url.searchParams.get('v');
    } else if (segments.length >= 2 && PATH_PREFIXES.includes(segments[0])) {
      videoId = segments[1];
    }
  } else {
    return null;
  }

  if (!isValidVideoId(videoId)) return null;

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const rawTime =
    url.searchParams.get('t') ?? url.searchParams.get('start') ?? hashParams.get('t');
  return { videoId, startSeconds: parseTimeValue(rawTime) };
}
