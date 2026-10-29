// Petits effets sonores synthétisés (aucun fichier audio nécessaire).
import { store } from './storage.js';

let ctx;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ f = 440, f2, type = 'sine', dur = 0.12, vol = 0.18, delay = 0, curve }) {
  const a = ac();
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (curve) o.frequency.setValueCurveAtTime(curve, t, dur);
  else if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const SOUNDS = {
  tap: () => tone({ f: 660, dur: 0.05, vol: 0.08, type: 'triangle' }),
  // Impact : plus grave et plus fort quand le pion tombe de haut
  drop: (d = 3) => {
    const k = Math.min(1, d / 6);
    tone({ f: 240 - 90 * k, f2: 70, dur: 0.14, vol: 0.16 + 0.14 * k, type: 'sine' });
    tone({ f: 1800, f2: 900, dur: 0.035, vol: 0.03 + 0.03 * k, type: 'triangle' });
  },
  // Souffle qui monte puis redescend, calé sur la rotation
  rotate: (ms = 1000) => {
    const dur = Math.max(0.2, ms / 1000);
    tone({ dur, vol: 0.06, type: 'sawtooth', curve: new Float32Array([160, 260, 420, 300, 180]) });
    tone({ dur, vol: 0.05, type: 'sine', curve: new Float32Array([320, 520, 840, 600, 360]) });
  },
  score: () => [0, 0.08].forEach((d, k) => tone({ f: 740 + k * 250, dur: 0.14, vol: 0.12, type: 'triangle', delay: d })),
  win: () => [523, 659, 784, 1046].forEach((f, k) => tone({ f, dur: 0.22, vol: 0.14, type: 'triangle', delay: k * 0.11 })),
  lose: () => [392, 330, 262].forEach((f, k) => tone({ f, dur: 0.26, vol: 0.12, type: 'sine', delay: k * 0.14 })),
  notify: () => [880, 1320].forEach((f, k) => tone({ f, dur: 0.1, vol: 0.1, type: 'sine', delay: k * 0.09 })),
};

export function play(name, arg) {
  if (!store.data.sound) return;
  try {
    SOUNDS[name]?.(arg);
  } catch {}
}

export function buzz(ms = 12) {
  if (store.data.sound && navigator.vibrate) navigator.vibrate(ms);
}
