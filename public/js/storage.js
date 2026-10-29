// Sauvegarde locale (réglages, statistiques, Griddex) — résiste aux navigateurs qui bloquent le stockage.
const KEY = 'turnit.v1';

const DEFAULTS = {
  name: '',
  sound: true,
  server: '',
  auth: null, // { token, name } du compte classé
  settings: {
    solo: { size: 6, gain: 4, pivot: 2, ai: 3 },
    duo: { size: 6, gain: 4, pivot: 2 },
    rapide: { vsAi: false, ai: 3 },
    online: { format: 'classic', size: 6, gain: 4, pivot: 2 },
  },
  stats: {
    solo: { played: 0, won: 0, lost: 0, draw: 0, bestLevel: 0, best: 0 },
    duo: { played: 0, p1: 0, p2: 0, draw: 0, best: 0 },
    rapide: { played: 0, p1: 0, p2: 0, draw: 0, best: 0 },
    online: { played: 0, won: 0, lost: 0, draw: 0, best: 0, streak: 0, bestStreak: 0 },
  },
  griddex: {}, // signature -> { count, first }
};

function merge(base, extra) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return extra ?? base;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
  return out;
}

let data = structuredClone(DEFAULTS);
try {
  data = merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
} catch {}

export const store = {
  get data() {
    return data;
  },
  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {}
  },
};

export function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {}
  return null;
}
