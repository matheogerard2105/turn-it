// Moteur de Turn It — partagé entre le navigateur et le serveur en ligne.
// Règles reprises de GameManager.cs :
//  - on lâche un pion dans une colonne, il tombe (gravité) ;
//  - si la colonne est dans les `pivot` colonnes de gauche, la grille pivote de 90° (sens anti-horaire),
//    dans les `pivot` colonnes de droite elle pivote dans le sens horaire, puis tout retombe ;
//  - après chaque coup, chaque série de `gain` pions alignés rapporte 1 point
//    (cumulé à chaque coup en mode classique, score "en direct" en mode Rapide) ;
//  - le premier joueur joue 1 coup, ensuite chacun joue 2 coups d'affilée ;
//  - la partie se termine quand la grille est pleine.

export const P1 = 1;
export const P2 = -1;

export const PRESETS = {
  classic: { size: 6, gain: 4, pivot: 2, scoring: 'cumul' },
  rapide: { size: 4, gain: 3, pivot: 1, scoring: 'live' },
};

export const LIMITS = {
  size: { min: 5, max: 9 },
  gain: (size) => ({ min: 3, max: Math.max(3, size - 2) }),
  pivot: (size) => ({ min: 1, max: Math.max(1, Math.floor(size / 2) - 1) }),
  ai: { min: 1, max: 13 },
};

export function sanitizeSettings(s = {}) {
  if (s.scoring === 'live') return { ...PRESETS.rapide };
  const clamp = (v, { min, max }, d) => {
    v = Number.isFinite(+v) ? Math.round(+v) : d;
    return Math.min(max, Math.max(min, v));
  };
  const size = clamp(s.size, LIMITS.size, 6);
  return {
    size,
    gain: clamp(s.gain, LIMITS.gain(size), 4),
    pivot: clamp(s.pivot, LIMITS.pivot(size), 2),
    scoring: 'cumul',
  };
}

export function emptyGrid(n) {
  return Array.from({ length: n }, () => new Array(n).fill(0));
}

export function cloneGrid(g) {
  return g.map((r) => r.slice());
}

// Les fonctions de grille ci-dessous sont génériques : 0 = vide, toute autre valeur est un pion.
// Le client les réutilise sur une grille d'identifiants pour animer chaque pion.

export function gravity(g) {
  const n = g.length;
  const out = emptyGrid(n);
  for (let j = 0; j < n; j++) {
    let w = n - 1;
    for (let i = n - 1; i >= 0; i--) if (g[i][j] !== 0) out[w--][j] = g[i][j];
  }
  return out;
}

// Anti-horaire (colonnes de gauche) — RotationLogiqueGauche
export function rotateCCW(g) {
  const n = g.length;
  const out = emptyGrid(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[n - 1 - j][i] = g[i][j];
  return out;
}

// Horaire (colonnes de droite) — RotationLogiqueDroite
export function rotateCW(g) {
  const n = g.length;
  const out = emptyGrid(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[j][n - 1 - i] = g[i][j];
  return out;
}

export function rotationFor(col, size, pivot) {
  if (col < pivot) return 'ccw';
  if (col >= size - pivot) return 'cw';
  return null;
}

export function dropInto(g, col, v) {
  const n = g.length;
  for (let i = n - 1; i >= 0; i--) {
    if (g[i][col] === 0) {
      const out = cloneGrid(g);
      out[i][col] = v;
      return out;
    }
  }
  return null;
}

export function simulateMove(g, col, v, pivot) {
  let out = dropInto(g, col, v);
  if (!out) return null;
  const rot = rotationFor(col, g.length, pivot);
  if (rot) out = gravity(rot === 'ccw' ? rotateCCW(out) : rotateCW(out));
  return out;
}

export function legalMoves(g) {
  const res = [];
  for (let j = 0; j < g.length; j++) if (g[0][j] === 0) res.push(j);
  return res;
}

export function isFull(g) {
  return g[0].every((v) => v !== 0);
}

const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

// Nombre de séries de `gain` pions consécutifs (fenêtres qui se chevauchent comptées séparément,
// exactement comme CalculerAlignements).
export function countAlignments(g, p, gain) {
  const n = g.length;
  let total = 0;
  for (const [dl, dc] of DIRS) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const ei = i + (gain - 1) * dl;
        const ej = j + (gain - 1) * dc;
        if (ei < 0 || ei >= n || ej < 0 || ej >= n) continue;
        let k = 0;
        while (k < gain && g[i + k * dl][j + k * dc] === p) k++;
        if (k === gain) total++;
      }
    }
  }
  return total;
}

// Cases faisant partie d'au moins une série (pour les mettre en surbrillance).
export function alignedCells(g, gain) {
  const n = g.length;
  const cells = new Set();
  for (const [dl, dc] of DIRS) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = g[i][j];
        if (p === 0) continue;
        const ei = i + (gain - 1) * dl;
        const ej = j + (gain - 1) * dc;
        if (ei < 0 || ei >= n || ej < 0 || ej >= n) continue;
        let k = 1;
        while (k < gain && g[i + k * dl][j + k * dc] === p) k++;
        if (k === gain) for (let m = 0; m < gain; m++) cells.add((i + m * dl) * n + (j + m * dc));
      }
    }
  }
  return cells;
}

export function createGame(settings, first) {
  const s = sanitizeSettings(settings);
  return {
    ...s,
    grid: emptyGrid(s.size),
    player: first === P1 || first === P2 ? first : Math.random() < 0.5 ? P1 : P2,
    movesLeft: 1,
    scores: { [P1]: 0, [P2]: 0 },
    lastGain: { [P1]: 0, [P2]: 0 },
    moves: 0,
    over: false,
    winner: null,
  };
}

// Applique un coup ; renvoie le nouvel état (l'ancien n'est pas modifié) ou null si le coup est illégal.
export function applyMove(state, col) {
  if (state.over || !Number.isInteger(col) || col < 0 || col >= state.size) return null;
  if (state.grid[0][col] !== 0) return null;
  const grid = simulateMove(state.grid, col, state.player, state.pivot);
  const a1 = countAlignments(grid, P1, state.gain);
  const a2 = countAlignments(grid, P2, state.gain);
  const live = state.scoring === 'live';
  const scores = {
    [P1]: live ? a1 : state.scores[P1] + a1,
    [P2]: live ? a2 : state.scores[P2] + a2,
  };
  let player = state.player;
  let movesLeft = state.movesLeft - 1;
  if (movesLeft <= 0) {
    player = -player;
    movesLeft = 2;
  }
  const over = isFull(grid);
  let winner = null;
  if (over) winner = scores[P1] > scores[P2] ? P1 : scores[P2] > scores[P1] ? P2 : 0;
  return {
    ...state,
    grid,
    player,
    movesLeft,
    scores,
    lastGain: { [P1]: a1, [P2]: a2 },
    moves: state.moves + 1,
    over,
    winner,
    lastMove: { col, by: state.player, rotation: rotationFor(col, state.size, state.pivot) },
  };
}

export function signature(g) {
  return g.map((r) => r.map((v) => (v === -1 ? 2 : v)).join('')).join('');
}

export function gridFromSignature(sig) {
  const n = Math.round(Math.sqrt(sig.length));
  const g = emptyGrid(n);
  for (let k = 0; k < sig.length; k++) g[Math.floor(k / n)][k % n] = sig[k] === '2' ? -1 : +sig[k];
  return g;
}
