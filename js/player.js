// YouTube IFrame API 어댑터. game.js가 기대하는 플레이어 인터페이스를 구현한다.
// 브라우저 전용 모듈(Node 테스트에서는 tests/fakePlayer.js를 쓴다).

import { PLAYER_STATE } from './game.js';

const API_URL = 'https://www.youtube.com/iframe_api';
let apiPromise = null;

/** IFrame API 스크립트를 한 번만 로드하고 ready 후 YT 객체를 돌려준다. */
export function loadYouTubeApi({ timeoutMs = 15000 } = {}) {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const timer = setTimeout(() => {
      apiPromise = null;
      reject(new Error('YouTube IFrame API 로드 시간 초과'));
    }, timeoutMs);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      apiPromise = null;
      script.remove();
      reject(new Error('YouTube IFrame API를 불러오지 못했습니다'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

const STATE_MAP = {
  [-1]: PLAYER_STATE.UNSTARTED,
  0: PLAYER_STATE.ENDED,
  1: PLAYER_STATE.PLAYING,
  2: PLAYER_STATE.PAUSED,
  3: PLAYER_STATE.BUFFERING,
  5: PLAYER_STATE.CUED,
};

/**
 * 지정한 요소 자리에 YouTube 플레이어를 만들고, ready가 되면 어댑터를 돌려준다.
 * @param {HTMLElement|string} element
 */
export async function createYouTubePlayer(element, { width = 320, height = 240 } = {}) {
  const YT = await loadYouTubeApi();
  const stateHandlers = new Set();
  const errorHandlers = new Set();

  let volume = null; // setVolume으로 정한 값. unMute 때 다시 적용한다
  const yt = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('플레이어 준비 시간 초과')), 15000);
    const instance = new YT.Player(element, {
      width,
      height,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        playsinline: 1,
        rel: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          clearTimeout(timer);
          resolve(instance);
        },
        onStateChange: (e) => {
          const state = STATE_MAP[e.data] ?? PLAYER_STATE.UNSTARTED;
          for (const fn of stateHandlers) fn(state);
        },
        onError: (e) => {
          for (const fn of errorHandlers) fn(e.data);
        },
      },
    });
  });

  return {
    load(videoId, startSeconds = 0) {
      yt.loadVideoById({ videoId, startSeconds });
    },
    cue(videoId) {
      yt.cueVideoById({ videoId });
    },
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    seek: (seconds) => yt.seekTo(seconds, true),
    getCurrentTime: () => yt.getCurrentTime?.() ?? 0,
    getDuration: () => yt.getDuration?.() ?? 0,
    mute: () => yt.mute(),
    unMute: () => {
      if (volume != null) yt.setVolume(volume);
      yt.unMute();
    },
    /** 0~100 */
    setVolume: (value) => {
      volume = value;
      yt.setVolume(value);
    },
    onStateChange: (fn) => {
      stateHandlers.add(fn);
      return () => stateHandlers.delete(fn);
    },
    onError: (fn) => {
      errorHandlers.add(fn);
      return () => errorHandlers.delete(fn);
    },
    iframe: () => yt.getIframe(),
  };
}
