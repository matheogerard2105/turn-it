// IA de Turn It — 13 niveaux, du coup au hasard jusqu'à une recherche minimax sur plusieurs coups.
import { applyMove, legalMoves, countAlignments, P1, P2 } from './engine.js';

// depth : profondeur de recherche ; p : probabilité de jouer le coup réfléchi plutôt que la version plus faible
const LEVELS = [
  null,
  { depth: 0, p: 0 }, // 1 : hasard
  { depth: 1, p: 0.2 },
  { depth: 1, p: 0.4 },
  { depth: 1, p: 0.6 },
  { depth: 1, p: 0.8 },
  { depth: 1, p: 1 },
  { depth: 2, p: 0.5 },
  { depth: 2, p: 1 },
  { depth: 3, p: 0.5 },
  { depth: 3, p: 1 },
  { depth: 4, p: 0.6 },
  { depth: 4, p: 1 },
  { depth: 6, p: 1 }, // 13 : limité par le temps
];

const WIN = 100000;

function evaluate(s, me) {
  const diff = s.scores[me] - s.scores[-me];
  if (s.over) return s.winner === me ? WIN + diff : s.winner === 0 ? diff : -WIN + diff;
  if (s.scoring === 'live') return diff * 10;
  // En mode cumulé, une série déjà en place rapportera encore à chaque coup restant.
  const remaining = s.grid.reduce((acc, r) => acc + r.filter((v) => v === 0).length, 0);
  const potential = countAlignments(s.grid, me, s.gain) - countAlignments(s.grid, -me, s.gain);
  return diff * 10 + potential * Math.min(remaining, 6) * 6 + (s.lastGain[me] - s.lastGain[-me]);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const k = Math.floor(Math.random() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

class Timeout extends Error {}

function search(s, depth, me, alpha, beta, deadline, counter) {
  if (depth === 0 || s.over) return evaluate(s, me);
  if ((++counter.n & 255) === 0 && performance.now() > deadline) throw new Timeout();
  const moves = legalMoves(s.grid);
  const maximizing = s.player === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const c of moves) {
    const v = search(applyMove(s, c), depth - 1, me, alpha, beta, deadline, counter);
    if (maximizing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  return best;
}

function bestMove(s, depth, timeBudget) {
  const me = s.player;
  const moves = shuffle(legalMoves(s.grid));
  if (moves.length === 1 || depth <= 0) return moves[0];
  const deadline = performance.now() + timeBudget;
  let best = moves[0];
  let order = moves;
  // Approfondissement itératif : on garde le résultat de la dernière profondeur complète.
  for (let d = 1; d <= depth; d++) {
    try {
      const counter = { n: 0 };
      const scored = [];
      let alpha = -Infinity;
      for (const c of order) {
        const v = search(applyMove(s, c), d - 1, me, alpha, Infinity, deadline, counter);
        scored.push([v, c]);
        if (v > alpha) alpha = v;
      }
      scored.sort((a, b) => b[0] - a[0]);
      best = scored[0][1];
      order = scored.map((x) => x[1]);
    } catch (e) {
      if (e instanceof Timeout) break;
      throw e;
    }
  }
  return best;
}

export function chooseMove(state, level, timeBudget = 900) {
  const L = LEVELS[Math.min(13, Math.max(1, level | 0))];
  const smart = Math.random() < L.p;
  const depth = smart ? L.depth : L.depth - 1;
  if (depth <= 0) {
    const moves = legalMoves(state.grid);
    return moves[Math.floor(Math.random() * moves.length)];
  }
  return bestMove(state, depth, timeBudget);
}

export { P1, P2 };
