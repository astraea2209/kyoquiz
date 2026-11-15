// 진입점: 저장소·곡 목록·플레이어를 준비하고 App을 시작한다.

import { createYouTubePlayer } from './player.js';
import {
  DurationCache,
  HighScores,
  SongStore,
  createMemoryStorage,
  parseSongList,
} from './songs.js';
import { App } from './ui.js';

function getStorage() {
  try {
    const key = '__asq_test__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return window.localStorage;
  } catch {
    return createMemoryStorage(); // 사생활 보호 모드 등에서 localStorage를 못 쓸 때
  }
}

const storage = getStorage();
const store = new SongStore(storage);
const app = new App({
  store,
  storage,
  durationCache: new DurationCache(storage),
  highScores: new HighScores(storage),
});
app.init();

fetch('songs.json', { cache: 'no-cache' })
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then((data) => {
    const { songs, invalid } = parseSongList(data);
    store.setBaseSongs(songs);
    if (invalid) app.toast(`songs.json에서 형식이 맞지 않는 항목 ${invalid}개를 건너뛰었습니다.`);
    app.songsChanged();
  })
  .catch((error) => {
    app.toast(`songs.json을 불러오지 못했습니다(${error.message}). 직접 추가한 곡만 사용합니다.`);
    app.songsChanged();
  });

// 플레이어 2개: 번갈아 쓰면서 정답 공개 중에 다음 곡을 미리 cue한다.
Promise.allSettled([createYouTubePlayer('player-0'), createYouTubePlayer('player-1')]).then(
  (results) => {
    const players = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (players.length) app.setPlayers(players);
    else app.setPlayerError(results[0].reason ?? new Error('알 수 없는 오류'));
  },
);
