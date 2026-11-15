// 시계와 연결된 가짜 타이머: advance(ms)가 기한이 된 타이머를 순서대로 실행한다.
export function createFakeTimers(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map(); // id → {at, fn, every}
  function add(fn, ms, every = null) {
    const id = ++seq;
    timers.set(id, { at: t + ms, fn, every });
    return id;
  }
  const api = {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let nextId = null;
        for (const [id, tm] of timers) if (tm.at <= target && (nextId === null || tm.at < timers.get(nextId).at)) nextId = id;
        if (nextId === null) break;
        const tm = timers.get(nextId);
        t = Math.max(t, tm.at);
        if (tm.every) tm.at += tm.every;
        else timers.delete(nextId);
        tm.fn();
      }
      t = target;
    },
  };
  return api;
}
