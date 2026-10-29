import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyMove, rotateCCW, rotateCW, gravity, countAlignments, legalMoves, P1, P2 } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import { buildRarityTable, rarityOf } from '../public/js/griddex.js';

test('rotations inverses et gravité', () => {
  const g = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  assert.deepEqual(rotateCW(rotateCCW(g)), g);
  assert.deepEqual(rotateCCW(g), [[3, 6, 9], [2, 5, 8], [1, 4, 7]]);
  assert.deepEqual(gravity([[1, 0], [0, 0]]), [[0, 0], [1, 0]]);
});

test('ordre des tours : 1 coup puis 2 coups chacun', () => {
  let s = createGame({ size: 6, gain: 4, pivot: 2 }, P1);
  const seq = [];
  for (let k = 0; k < 7; k++) { seq.push(s.player); s = applyMove(s, 2); if (k === 5) s = applyMove(s, 3), seq.push(-1); }
  assert.deepEqual(seq.slice(0, 5), [P1, P2, P2, P1, P1]);
});

test('colonne de gauche = rotation anti-horaire', () => {
  let s = createGame({ size: 6, gain: 4, pivot: 2 }, P1);
  s = applyMove(s, 0); // pion en bas à gauche -> après rotation anti-horaire il est en bas à droite
  assert.equal(s.grid[5][5], P1);
  s = createGame({ size: 6, gain: 4, pivot: 2 }, P1);
  s = applyMove(s, 5); // bas droite -> rotation horaire -> bas gauche
  assert.equal(s.grid[5][0], P1);
});

test('alignements et partie complète', () => {
  const g = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,1,1,1]];
  assert.equal(countAlignments(g, 1, 3), 2);
  for (const mode of [{ size: 7, gain: 4, pivot: 2 }, { scoring: 'live' }]) {
    let s = createGame(mode);
    while (!s.over) s = applyMove(s, legalMoves(s.grid)[0]);
    assert.equal(s.moves, s.size * s.size);
    assert.ok([P1, P2, 0].includes(s.winner));
  }
});

test('IA : coups légaux et niveau max bat le hasard', () => {
  let wins = 0;
  for (let g = 0; g < 6; g++) {
    let s = createGame({ size: 6, gain: 4, pivot: 2 });
    while (!s.over) {
      const col = chooseMove(s, s.player === P2 ? 10 : 1, 150);
      assert.ok(legalMoves(s.grid).includes(col));
      s = applyMove(s, col);
    }
    if (s.winner === P2) wins++;
  }
  assert.ok(wins >= 5, `IA niveau 10 n'a gagné que ${wins}/6`);
});

test('table de rareté Griddex', () => {
  const t = buildRarityTable(3000);
  const [sig] = Object.keys(t);
  assert.ok(rarityOf(t, sig));
  assert.equal(rarityOf(t, 'x').key, 'legendaire');
});
