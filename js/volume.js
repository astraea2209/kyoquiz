// 노래 볼륨(0~100). 개인전·친구와 대결 플레이어 모두에 같은 값을 적용하고 localStorage에 기억한다.
// DOM·YouTube에 의존하지 않는다: 플레이어는 setVolume(v)가 있으면 쓰고, 없으면(가짜 플레이어 등) 건너뛴다.

export const VOLUME_KEY = 'asq.volume';
export const DEFAULT_VOLUME = 80;

/** 0~100 정수로 맞춘다. 숫자가 아니면 기본값 */
export function clampVolume(value, fallback = DEFAULT_VOLUME) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export class VolumeControl {
  /** @param {Storage} storage */
  constructor(storage) {
    this.storage = storage;
    let saved = null;
    try {
      saved = storage?.getItem(VOLUME_KEY);
    } catch {
      saved = null;
    }
    this.value = clampVolume(saved);
    this.players = new Set();
    this.listeners = new Set();
  }

  /** 플레이어를 등록하고 지금 볼륨을 바로 적용한다 */
  attach(players) {
    for (const p of players) {
      this.players.add(p);
      this.applyTo(p);
    }
  }

  applyTo(player) {
    if (typeof player?.setVolume !== 'function') return;
    try {
      player.setVolume(this.value);
    } catch {
      // 플레이어가 아직 준비되지 않았으면 다음 unMute 때 적용된다(js/player.js)
    }
  }

  set(value) {
    const next = clampVolume(value, this.value);
    if (next === this.value) return;
    this.value = next;
    try {
      this.storage?.setItem(VOLUME_KEY, String(next));
    } catch {
      // 저장 실패(사생활 보호 모드 등)는 무시: 이번 접속 동안만 유지
    }
    for (const p of this.players) this.applyTo(p);
    for (const fn of [...this.listeners]) fn(next);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * range input(과 선택적 숫자 표시)을 VolumeControl과 양방향으로 묶는다. 여러 화면의 슬라이더가 같은 값을 공유한다.
 * @param {{value: string, addEventListener: Function}} input
 * @param {{textContent: string}|null} label
 */
export function bindVolumeInput(control, input, label = null) {
  const show = (v) => {
    input.value = String(v);
    if (label) label.textContent = `${v}%`;
  };
  show(control.value);
  input.addEventListener('input', () => control.set(input.value));
  return control.onChange(show);
}
