// Griddex : collection des grilles finales du mode Rapide, classées par rareté.
// La rareté est estimée en simulant des milliers de parties aléatoires (comme LancerSimulationPourGriddex).
import { createGame, applyMove, legalMoves, signature, PRESETS } from './engine.js';

export const RARITIES = [
  { key: 'commune', label: 'Commune', min: 10 },
  { key: 'normale', label: 'Normale', min: 4 },
  { key: 'rare', label: 'Rare', min: 2 },
  { key: 'legendaire', label: 'Légendaire', min: 0 },
];

export function buildRarityTable(games = 50000) {
  const counts = Object.create(null);
  for (let n = 0; n < games; n++) {
    let s = createGame(PRESETS.rapide);
    while (!s.over) {
      const moves = legalMoves(s.grid);
      s = applyMove(s, moves[Math.floor(Math.random() * moves.length)]);
    }
    const sig = signature(s.grid);
    counts[sig] = (counts[sig] || 0) + 1;
  }
  return counts;
}

export function rarityOf(table, sig) {
  const c = (table && table[sig]) || 0;
  return RARITIES.find((r) => c >= r.min);
}
