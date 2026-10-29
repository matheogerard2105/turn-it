// Calculs lourds hors du fil principal : choix du coup de l'IA et base de rareté du Griddex.
import { chooseMove } from './ai.js';
import { buildRarityTable } from './griddex.js';

self.onmessage = (e) => {
  const { id, type } = e.data;
  if (type === 'move') {
    self.postMessage({ id, col: chooseMove(e.data.state, e.data.level) });
  } else if (type === 'rarity') {
    self.postMessage({ id, table: buildRarityTable(e.data.games) });
  }
};
