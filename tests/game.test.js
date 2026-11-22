import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, MODE, PHASE, PLAYER_STATE } from '../js/game.js';
import { DIFFICULTY } from '../js/judge.js';
import { DurationCache, createMemoryStorage } from '../js/songs.js';
import { FakePlayer, createClock, makeSong, manualScheduler, seededRng } from './helpers.js';

function setup({
  songCount = 5,
  songs = null,
  settings = {},
  playerCount = 2,
  durations = null,
  cache = new DurationCache(createMemoryStorage()),
} = {}) {
  const list = songs ?? Array.from({ length: songCount }, (_, i) => makeSong(i + 1, { duration: 200 }));
  const durationMap = durations ?? Object.fromEntries(list.map((s) => [s.videoId, 200]));
  const players = Array.from({ length: playerCount }, () => new FakePlayer({ durations: durationMap }));
  const clock = createClock(1000);
  const toasts = [];
  const game = new GameSession({
    songs: list,
    settings: { mode: MODE.RANDOM, clipLength: 5, rounds: 3, difficulty: DIFFICULTY.NORMAL, ...settings },
    players,
    durationCache: cache,
    rng: seededRng(42),
    now: clock.now,
    scheduler: manualScheduler,
  });
  game.on('toast', (m) => toasts.push(m));
  return { game, players, clock, toasts, songs: list, cache };
}

/** 현재 플레이어가 구간 시작에서 재생을 시작하고 시간이 흐르는 상황을 흉내 낸다 */
function beginAudio(game) {
  const p = game.player;
  p.emitState(PLAYER_STATE.PLAYING); // 위치 확인(1회차)
  p.time += 0.15;
  game.tick(); // 시간이 흐른 것을 확인 → unMute
}

test('랜덤듣기: 시작 클릭에서 바로 로드(음소거) → 구간 도달 시 unMute → 구간 끝에서 정지', () => {
  const { game, players } = setup();
  game.start();
  const p = players[0];
  assert.equal(game.phase, PHASE.LOADING);
  assert.deepEqual(p.callNames().slice(0, 2), ['mute', 'load']);
  const start = game.round.segmentStart;
  assert.equal(p.calls[1][2], start); // duration을 알고 있으므로 구간 위치로 바로 로드
  assert.ok(start >= 20 && start <= 175);

  assert.equal(game.canAnswer, false); // 소리가 나기 전에는 답할 수 없음
  beginAudio(game);
  assert.equal(game.phase, PHASE.PLAYING);
  assert.equal(p.muted, false);

  p.time = start + 2.5;
  game.tick();
  assert.equal(game.phase, PHASE.PLAYING);
  assert.ok(Math.abs(game.progress - 0.5) < 1e-9);

  p.time = start + 5;
  game.tick();
  assert.equal(game.phase, PHASE.STOPPED);
  assert.equal(p.callNames().at(-2), 'pause');
  assert.equal(game.progress, 1);
});

test('랜덤듣기: 길이를 모르면 음소거 로드 → PLAYING에서 길이 캐시 → seek 후에만 unMute', () => {
  const songs = [makeSong(1), makeSong(2)]; // duration 없음
  const durations = {};
  const { game, players, cache } = setup({ songs, durations });
  game.start();
  const p = players[0];
  const id = game.round.song.videoId;
  assert.deepEqual(p.calls.slice(0, 2), [['mute'], ['load', id, 0]]);

  // 아직 길이를 못 읽는 상태: 재생은 시작됐지만 소리를 켜면 안 됨
  p.emitState(PLAYER_STATE.PLAYING);
  game.tick();
  assert.equal(p.muted, true);
  assert.equal(game.phase, PHASE.LOADING);
  assert.ok(!p.callNames().includes('unMute'));

  durations[id] = 180;
  game.tick();
  assert.equal(cache.get(id), 180);
  const start = game.round.segmentStart;
  assert.ok(start >= 18 && start <= 157);
  const names = p.callNames();
  assert.ok(names.includes('seek'));
  // seek 직후에는 아직 소리를 켜지 않음
  assert.equal(p.muted, true);
  // 구간 위치에서 시간이 실제로 흐르는 것을 확인한 뒤 unMute
  p.time += 0.15;
  game.tick();
  const after = p.callNames();
  assert.ok(after.indexOf('seek') < after.indexOf('unMute'));
  assert.equal(game.phase, PHASE.PLAYING);
});

test('seek 전 위치(0초)에서는 unMute하지 않는다', () => {
  const songs = [makeSong(1)];
  const { game, players } = setup({ songs, durations: { [songs[0].videoId]: 100 } });
  game.start();
  const p = players[0];
  p.emitState(PLAYER_STATE.PLAYING); // probe → seek
  const start = game.round.segmentStart;
  p.time = 0; // seek가 아직 반영되지 않은 상황
  game.tick();
  assert.equal(p.muted, true);
  p.time = start + 0.1;
  game.tick();
  assert.equal(p.muted, true); // 위치만 확인한 상태
  p.time = start + 0.25;
  game.tick();
  assert.equal(p.muted, false);
});

test('캐시된 길이가 있으면 곧바로 구간 위치로 로드', () => {
  const songs = [makeSong(1)];
  const cache = new DurationCache(createMemoryStorage());
  cache.set(songs[0].videoId, 120);
  const { game, players } = setup({ songs, cache });
  game.start();
  assert.equal(players[0].calls[1][0], 'load');
  assert.ok(players[0].calls[1][2] > 0);
  assert.equal(game.round.stage, 'seek');
});

test('정답: 점수 반영, 공개 시 영상 재생, 다음 곡을 다른 플레이어에 cue', () => {
  const { game, players } = setup();
  game.start();
  beginAudio(game);
  const result = game.submitAnswer(game.round.song.title.toUpperCase());
  assert.deepEqual(result, { correct: true });
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.round.result.points, 100);
  assert.equal(game.score, 100);
  assert.ok(players[0].callNames().slice(-2).includes('unMute'));
  const nextId = game.queue[0].videoId;
  assert.deepEqual(players[1].calls.at(-1), ['cue', nextId]);
  // 공개 이후에는 답 제출 불가
  assert.equal(game.submitAnswer('아무거나'), null);

  game.next();
  assert.equal(game.active, 1);
  assert.equal(game.roundIndex, 1);
  assert.equal(game.round.song.videoId, nextId);
  assert.equal(players[1].calls.at(-1)[0], 'load');
  assert.equal(players[0].calls.at(-1)[0], 'pause');
});

test('플레이어가 1개면 cue를 하지 않아 공개 중인 영상을 지우지 않는다', () => {
  const { game, players } = setup({ playerCount: 1 });
  game.start();
  beginAudio(game);
  game.pass();
  assert.ok(!players[0].callNames().includes('cue'));
  game.next();
  assert.equal(game.active, 0);
  assert.equal(players[0].calls.at(-1)[0], 'load');
});

test('영상은 정답 공개 중인 현재 플레이어만 보여 준다(다음 곡을 cue한 플레이어는 숨김)', () => {
  const { game } = setup();
  game.start();
  assert.deepEqual([game.isPlayerVisible(0), game.isPlayerVisible(1)], [false, false]);
  beginAudio(game);
  assert.deepEqual([game.isPlayerVisible(0), game.isPlayerVisible(1)], [false, false]);
  game.pass();
  assert.deepEqual([game.isPlayerVisible(0), game.isPlayerVisible(1)], [true, false]);
  game.next();
  assert.deepEqual([game.isPlayerVisible(0), game.isPlayerVisible(1)], [false, false]);
});

test('소리를 듣기 전에 패스하면 공개 중에도 영상을 보여 주지 않는다', () => {
  const { game } = setup();
  game.start();
  game.pass();
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.isPlayerVisible(game.active), false);
});

test('오답 3회: 0점으로 공개', () => {
  const { game } = setup();
  game.start();
  beginAudio(game);
  assert.deepEqual(game.submitAnswer('wrong one'), { correct: false, attemptsLeft: 2, revealed: false });
  assert.deepEqual(game.submitAnswer('wrong two'), { correct: false, attemptsLeft: 1, revealed: false });
  assert.equal(game.submitAnswer('   '), null); // 빈 입력은 기회 소모 없음
  assert.deepEqual(game.submitAnswer('wrong three'), { correct: false, attemptsLeft: 0, revealed: true });
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.round.result.reason, 'wrong');
  assert.equal(game.score, 0);
});

test('패스: 즉시 공개, 0점', () => {
  const { game } = setup();
  game.start();
  beginAudio(game);
  game.pass();
  assert.equal(game.phase, PHASE.REVEALED);
  assert.deepEqual(
    { reason: game.round.result.reason, points: game.round.result.points },
    { reason: 'pass', points: 0 },
  );
});

test('다시듣기: 1회만, 사용 시 20점 감점', () => {
  const { game, players } = setup();
  game.start();
  beginAudio(game);
  const p = players[0];
  const start = game.round.segmentStart;
  p.time = start + 5;
  game.tick();
  assert.equal(game.phase, PHASE.STOPPED);
  assert.equal(game.canReplay, true);

  assert.equal(game.replay(), true);
  assert.equal(game.phase, PHASE.LOADING);
  assert.deepEqual(p.calls.slice(-3), [['mute'], ['seek', start], ['play']]);
  assert.equal(game.canAnswer, true); // 이미 한 번 들었으므로 답 가능
  game.tick();
  p.time += 0.15;
  game.tick();
  assert.equal(game.phase, PHASE.PLAYING);
  assert.equal(game.replay(), false);

  game.submitAnswer(game.round.song.anime.name);
  assert.equal(game.round.result.points, 80);
});

test('3초 구간 정답은 150점', () => {
  const { game } = setup({ settings: { clipLength: 3 } });
  game.start();
  beginAudio(game);
  game.submitAnswer(game.round.song.title);
  assert.equal(game.score, 150);
});

test('전체듣기: 소리가 난 시간만 재서 점수 계산(버퍼링 제외)', () => {
  const { game, players, clock } = setup({ settings: { mode: MODE.FULL } });
  game.start();
  const p = players[0];
  assert.deepEqual(p.calls.slice(0, 2), [['mute'], ['load', game.round.song.videoId, 0]]);
  clock.advance(3000); // 로딩 시간은 세지 않음
  beginAudio(game);
  assert.equal(game.phase, PHASE.PLAYING);
  clock.advance(10000);
  p.emitState(PLAYER_STATE.BUFFERING);
  clock.advance(4000); // 버퍼링 시간 제외
  p.emitState(PLAYER_STATE.PLAYING);
  clock.advance(5000);
  game.tick();
  assert.ok(Math.abs(game.audibleElapsed() - 15) < 1e-9);
  assert.equal(game.canReplay, false);
  game.submitAnswer(game.round.song.title);
  assert.equal(game.round.result.points, 60);
});

test('전체듣기: 제한시간 30초가 지나면 0점으로 공개', () => {
  const { game, clock } = setup({ settings: { mode: MODE.FULL } });
  game.start();
  beginAudio(game);
  clock.advance(29900);
  game.tick();
  assert.equal(game.phase, PHASE.PLAYING);
  clock.advance(100);
  game.tick();
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.round.result.reason, 'timeout');
  assert.equal(game.round.result.points, 0);
});

test('재생 오류: 다른 곡으로 교체하고 재생 버튼을 기다림', () => {
  const { game, players, toasts } = setup({ songCount: 4, settings: { rounds: 3 } });
  game.start();
  const failed = game.round.song;
  players[0].emitError(150);
  assert.equal(game.phase, PHASE.READY);
  assert.notEqual(game.round.song.videoId, failed.videoId);
  assert.equal(game.roundIndex, 0);
  assert.equal(game.totalRounds, 3);
  assert.equal(game.skippedSongs[0].song, failed);
  assert.match(toasts.at(-1), /건너뛰/);

  game.playCurrent();
  assert.equal(game.phase, PHASE.LOADING);
  assert.equal(players[0].calls.at(-1)[1], game.round.song.videoId);
});

test('재생 오류: 곡이 부족하면 라운드 수를 줄인다', () => {
  const { game, players, toasts } = setup({ songCount: 3, settings: { rounds: 3 } });
  game.start();
  players[0].emitError(100);
  assert.equal(game.totalRounds, 2);
  assert.match(toasts.at(-1), /2라운드로 줄였습니다/);
  game.playCurrent();
  beginAudio(game);
  game.pass();
  game.next();
  assert.equal(game.roundIndex, 1);
  beginAudio(game);
  game.pass();
  assert.equal(game.hasNext, false);
  game.next();
  assert.equal(game.phase, PHASE.FINISHED);
  assert.equal(game.history.length, 2);
});

test('재생 오류: 마지막 라운드에서 남은 곡이 없으면 그 전까지로 종료', () => {
  const { game, players } = setup({ songCount: 2, settings: { rounds: 2 } });
  game.start();
  beginAudio(game);
  game.pass();
  game.next();
  players[1].emitError(101);
  assert.equal(game.phase, PHASE.FINISHED);
  assert.equal(game.finishReason, 'complete');
  assert.equal(game.totalRounds, 1);
});

test('재생 오류: 재생 가능한 곡이 하나도 없으면 no-playable', () => {
  const { game, players } = setup({ songCount: 1, settings: { rounds: 5 } });
  game.start();
  players[0].emitError(5);
  assert.equal(game.phase, PHASE.FINISHED);
  assert.equal(game.finishReason, 'no-playable');
});

test('미리 cue한 플레이어의 오류나 이벤트는 현재 라운드에 영향을 주지 않는다', () => {
  const { game, players } = setup();
  game.start();
  beginAudio(game);
  players[1].emitError(150);
  players[1].emitState(PLAYER_STATE.ENDED);
  assert.equal(game.phase, PHASE.PLAYING);
  game.pass();
  assert.ok(game.preloaded);
  players[1].emitError(150); // cue 실패 → 미리 불러오기 정보만 지움
  assert.equal(game.preloaded, null);
  assert.equal(game.phase, PHASE.REVEALED);
});

test('곡 부족: 라운드 수를 곡 수로 줄이고 한 게임 안에서 중복 없이 진행', () => {
  const { game, toasts } = setup({ songCount: 3, settings: { rounds: 5 } });
  game.start();
  assert.equal(game.totalRounds, 3);
  assert.match(toasts[0], /3라운드로 진행/);
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    seen.add(game.round.song.videoId);
    beginAudio(game);
    game.pass();
    game.next();
  }
  assert.equal(seen.size, 3);
  assert.equal(game.phase, PHASE.FINISHED);
  assert.equal(game.history.length, 3);
});

test('사용 중인 곡이 없으면 바로 종료', () => {
  const songs = [makeSong(1, { enabled: false })];
  const { game, toasts } = setup({ songs });
  game.start();
  assert.equal(game.phase, PHASE.FINISHED);
  assert.equal(game.finishReason, 'no-songs');
  assert.equal(toasts.length, 1);
});

test('쉬움: 객관식 보기, 오답 보기는 비활성화되고 기회 소모', () => {
  const { game } = setup({ songCount: 6, settings: { difficulty: DIFFICULTY.EASY } });
  game.start();
  beginAudio(game);
  const choices = game.round.choices;
  assert.equal(choices.length, 4);
  assert.equal(game.submitAnswer(game.round.song.title), null); // 쉬움에서는 주관식 불가
  const wrongIndex = choices.findIndex((c) => !c.correct);
  assert.equal(game.chooseOption(wrongIndex).attemptsLeft, 2);
  assert.equal(game.chooseOption(wrongIndex), null); // 이미 비활성
  assert.equal(game.attemptsLeft, 2);
  game.chooseOption(choices.findIndex((c) => c.correct));
  assert.equal(game.round.result.correct, true);
  assert.equal(game.score, 100);
});

test('쉬움: 곡이 2개 미만이면 보통 난이도로 대체하고 안내', () => {
  const { game, toasts } = setup({ songCount: 1, settings: { difficulty: DIFFICULTY.EASY } });
  game.start();
  assert.equal(game.difficulty, DIFFICULTY.NORMAL);
  assert.equal(game.round.choices, null);
  assert.match(toasts[0], /보통 난이도/);
});

test('어려움: 작품명은 오답 처리', () => {
  const { game } = setup({ settings: { difficulty: DIFFICULTY.HARD } });
  game.start();
  beginAudio(game);
  assert.equal(game.submitAnswer(game.round.song.anime.name).correct, false);
  assert.equal(game.submitAnswer(game.round.song.titleAliases[0]).correct, true);
});

test('dispose 후에는 플레이어 이벤트를 받지 않는다', () => {
  const { game, players } = setup();
  game.start();
  game.dispose();
  players[0].emitState(PLAYER_STATE.PLAYING);
  assert.equal(game.phase, PHASE.LOADING);
  assert.equal(players[0].stateHandlers.size, 0);
});

function extremeSongs(count = 5) {
  return Array.from({ length: count }, (_, i) =>
    makeSong(i + 1, { duration: 200, artist: `Singer Name ${i + 1}`, artistAliases: [`가수${i + 1}`] }),
  );
}

test('매우 어려움: 항목마다 점수, 셋 다 맞혀야 공개되고 보너스', () => {
  const { game } = setup({ songs: extremeSongs(), settings: { difficulty: DIFFICULTY.EXTREME } });
  game.start();
  beginAudio(game);
  const song = game.round.song;
  assert.deepEqual(game.round.items, ['title', 'artist', 'anime']);

  const r1 = game.submitAnswer(song.artistAliases[0]);
  assert.deepEqual(r1, { correct: true, items: ['artist'], points: 25, bonus: 0, complete: false });
  assert.equal(game.score, 25); // 맞힌 즉시 점수에 반영
  assert.equal(game.phase, PHASE.PLAYING); // 다 맞히기 전에는 라운드가 끝나지 않음

  // 이미 맞힌 항목은 오답으로 치지 않는다
  const again = game.submitAnswer(song.artist);
  assert.deepEqual(again, { correct: false, already: ['artist'], attemptsLeft: 5, revealed: false });

  assert.equal(game.submitAnswer(song.anime.name).points, 25);
  const last = game.submitAnswer(song.title);
  assert.deepEqual(last, { correct: true, items: ['title'], points: 100, bonus: 50, complete: true }); // 제목 50 + 보너스 50
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.score, 150);
  assert.equal(game.round.result.points, 150);
  assert.equal(game.round.result.correct, true);
  assert.deepEqual(game.round.result.solved, ['title', 'artist', 'anime']);
  assert.equal(game.history[0].points, 150);
});

test('매우 어려움: 일부만 맞히고 패스해도 맞힌 항목 점수는 남는다', () => {
  const { game } = setup({ songs: extremeSongs(), settings: { difficulty: DIFFICULTY.EXTREME } });
  game.start();
  beginAudio(game);
  game.submitAnswer(game.round.song.title);
  game.pass();
  assert.equal(game.phase, PHASE.REVEALED);
  assert.deepEqual(
    { reason: game.round.result.reason, correct: game.round.result.correct, points: game.round.result.points },
    { reason: 'pass', correct: false, points: 50 },
  );
  assert.deepEqual(game.round.result.solved, ['title']);
  assert.equal(game.score, 50); // 두 번 더하지 않는다
});

test('매우 어려움: 오답 기회 5번, 소진하면 맞힌 항목 점수만 두고 공개', () => {
  const { game } = setup({ songs: extremeSongs(), settings: { difficulty: DIFFICULTY.EXTREME } });
  game.start();
  beginAudio(game);
  assert.equal(game.attemptsLeft, 5);
  game.submitAnswer(game.round.song.anime.aliases[0]);
  for (let i = 0; i < 4; i++) assert.equal(game.submitAnswer(`틀린 답 ${i}`).revealed, false);
  assert.deepEqual(game.submitAnswer('틀린 답 마지막'), { correct: false, attemptsLeft: 0, revealed: true });
  assert.equal(game.round.result.reason, 'wrong');
  assert.equal(game.round.result.points, 25);
  assert.equal(game.score, 25);
});

test('매우 어려움: 작품이 없는 곡은 제목·가수만 맞히면 끝', () => {
  const songs = extremeSongs().map((s) => ({ ...s, anime: undefined, type: '일반곡' }));
  const { game } = setup({ songs, settings: { difficulty: DIFFICULTY.EXTREME } });
  game.start();
  beginAudio(game);
  assert.deepEqual(game.round.items, ['title', 'artist']);
  assert.equal(game.submitAnswer(game.round.song.title).points, 67);
  assert.equal(game.submitAnswer(game.round.song.artist).points, 83); // 33 + 보너스 50
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.score, 150);
});

test('매우 어려움 전체듣기: 항목마다 맞힌 시점의 점수', () => {
  const { game, clock } = setup({ songs: extremeSongs(), settings: { mode: MODE.FULL, difficulty: DIFFICULTY.EXTREME } });
  game.start();
  beginAudio(game);
  game.submitAnswer(game.round.song.title); // 0초: 기본 100 → 50
  clock.advance(15000);
  game.tick();
  game.submitAnswer(game.round.song.artist); // 15초: 기본 60 → 15
  assert.equal(game.score, 65);
  clock.advance(15000);
  game.tick(); // 30초 → 시간 초과
  assert.equal(game.phase, PHASE.REVEALED);
  assert.equal(game.round.result.reason, 'timeout');
  assert.equal(game.round.result.points, 65);
  assert.deepEqual(game.round.result.solved, ['title', 'artist']);
});

test('매우 어려움이 아닌 난이도는 오답 기회 3번 그대로', () => {
  const { game } = setup();
  game.start();
  assert.equal(game.maxWrongAttempts, 3);
  assert.equal(game.round.items, null);
});

test('라운드 수 직접 지정(7)과 15초 구간', () => {
  const { game, players } = setup({ songCount: 10, settings: { rounds: 7, clipLength: 15 } });
  game.start();
  assert.equal(game.totalRounds, 7);
  const start = game.round.segmentStart;
  assert.ok(start >= 20 && start + 15 <= 180);
  beginAudio(game);
  players[0].time = start + 14.5;
  game.tick();
  assert.equal(game.phase, PHASE.PLAYING);
  players[0].time = start + 15;
  game.tick();
  assert.equal(game.phase, PHASE.STOPPED);
  game.submitAnswer(game.round.song.title);
  assert.equal(game.round.result.points, 50);
});
