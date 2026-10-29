// Plateau animé : chaque pion est un élément suivi par identifiant, pour qu'il tombe et pivote réellement.
import { emptyGrid, dropInto, gravity, rotateCCW, rotateCW, alignedCells, rotationFor } from './engine.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FALL_MS = 150; // durée de chute d'une case (la vitesse augmente avec la distance)
const ROTATE_MS = 1000;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Board {
  constructor(root, { onColumn, speed = 1 } = {}) {
    this.root = root;
    this.onColumn = onColumn;
    this.speed = speed;
    this.locked = true;
    this.previewPlayer = 0;
    root.innerHTML = `
      <div class="col-heads"></div>
      <div class="board-frame">
        <div class="board">
          <div class="cells"></div>
          <div class="pieces"></div>
        </div>
        <div class="col-hits"></div>
      </div>`;
    this.heads = root.querySelector('.col-heads');
    this.frame = root.querySelector('.board-frame');
    this.board = root.querySelector('.board');
    this.cellsEl = root.querySelector('.cells');
    this.piecesEl = root.querySelector('.pieces');
    this.hits = root.querySelector('.col-hits');
  }

  // (Re)construit le plateau à partir d'un état de jeu
  setup(state) {
    const n = state.size;
    this.n = n;
    this.gain = state.gain;
    this.pivot = state.pivot;
    this.nextId = 1;
    this.owner = new Map();
    this.els = new Map();
    this.root.style.setProperty('--n', n);
    this.board.style.transition = 'none';
    this.board.style.transform = '';
    this.cellsEl.innerHTML = '<i></i>'.repeat(n * n);
    this.piecesEl.innerHTML = '';

    this.heads.innerHTML = '';
    this.hits.innerHTML = '';
    for (let c = 0; c < n; c++) {
      const rot = rotationFor(c, n, state.pivot);
      const h = document.createElement('div');
      h.className = 'col-head' + (rot ? ' pivot ' + rot : '');
      h.innerHTML = `<span class="ghost"></span>${rot ? `<svg class="rot-ico" viewBox="0 0 24 24"><use href="#i-${rot}"/></svg>` : ''}`;
      this.heads.appendChild(h);

      const b = document.createElement('button');
      b.className = 'col-hit' + (rot ? ' pivot' : '');
      b.setAttribute('aria-label', `Colonne ${c + 1}${rot === 'ccw' ? ', fait pivoter à gauche' : rot === 'cw' ? ', fait pivoter à droite' : ''}`);
      b.addEventListener('click', () => {
        if (!this.locked) this.onColumn?.(c);
      });
      b.addEventListener('pointerenter', () => this.hover(c));
      b.addEventListener('pointerleave', () => this.hover(-1));
      this.hits.appendChild(b);
    }

    this.ids = emptyGrid(n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const p = state.grid[i][j];
        if (p) {
          const id = this.spawn(p, i, j);
          this.ids[i][j] = id;
        }
      }
    this.refreshHighlights(state.grid);
    this.syncFull(state);
  }

  spawn(player, row, col) {
    const id = this.nextId++;
    const el = document.createElement('div');
    el.className = 'piece ' + (player === 1 ? 'p1' : 'p2');
    el.innerHTML = '<b></b>';
    this.place(el, row, col);
    this.piecesEl.appendChild(el);
    this.owner.set(id, player);
    this.els.set(id, el);
    return id;
  }

  place(el, row, col) {
    el.style.setProperty('--r', row);
    el.style.setProperty('--c', col);
  }

  hover(c) {
    this.hovered = c;
    [...this.heads.children].forEach((h, k) => {
      h.classList.toggle('hover', k === c && !this.locked);
      h.classList.toggle('g1', this.previewPlayer === 1);
      h.classList.toggle('g2', this.previewPlayer === -1);
    });
  }

  setTurn(player, interactive) {
    this.previewPlayer = player;
    this.locked = !interactive;
    this.root.classList.toggle('locked', !interactive);
    this.root.classList.toggle('turn-p1', player === 1);
    this.root.classList.toggle('turn-p2', player === -1);
    this.hover(interactive ? this.hovered : -1);
  }

  setFullColumns(grid) {
    [...this.hits.children].forEach((b, c) => (b.disabled = grid[0][c] !== 0));
  }

  // Chute d'un pion : accélération (gravité), impact écrasé, deux petits rebonds.
  // Renvoie la durée totale ; `onImpact` est appelé au moment où le pion touche.
  fall(el, from, to, col, onImpact) {
    this.place(el, to, col);
    const d = to - from;
    if (d <= 0 || reduceMotion()) return 0;
    const K = FALL_MS / this.speed; // ms pour tomber d'une case
    const tf = K * Math.sqrt(d);
    const h1 = Math.min(0.2, 0.045 * d + 0.03); // hauteur du rebond (en cases)
    const h2 = h1 * 0.28;
    const tb1 = 2 * K * Math.sqrt(h1) * 0.9;
    const tb2 = 2 * K * Math.sqrt(h2) * 0.9;
    const total = tf + tb1 + tb2;
    const T = (r) => ({ transform: `translate(calc(${col} * 100%), calc(${r} * 100%))` });
    const easeIn = 'cubic-bezier(.4,0,1,.6)';
    const easeOut = 'cubic-bezier(0,.4,.6,1)';
    el.animate(
      [
        { ...T(from), offset: 0, easing: 'cubic-bezier(.3,0,.9,.55)' },
        { ...T(to), offset: tf / total, easing: easeOut },
        { ...T(to - h1), offset: (tf + tb1 / 2) / total, easing: easeIn },
        { ...T(to), offset: (tf + tb1) / total, easing: easeOut },
        { ...T(to - h2), offset: (tf + tb1 + tb2 / 2) / total, easing: easeIn },
        { ...T(to), offset: 1 },
      ],
      { duration: total }
    );
    const squash = Math.min(1, 0.45 + d * 0.12);
    el.firstChild.animate(
      [
        { transform: 'none' },
        { transform: `scale(${1 + 0.16 * squash}, ${1 - 0.22 * squash})`, offset: 0.25 },
        { transform: `scale(${1 - 0.05 * squash}, ${1 + 0.07 * squash})`, offset: 0.6 },
        { transform: 'none' },
      ],
      { duration: 300 / this.speed, delay: tf, easing: 'ease-out' }
    );
    setTimeout(() => onImpact?.(d), tf);
    return total;
  }

  // Petite secousse du plateau, plus forte pour les longues chutes
  impact(d, sound) {
    const now = performance.now();
    if (now - (this.lastImpact || 0) < 70) return;
    this.lastImpact = now;
    sound?.('drop', d);
    const px = Math.min(5, 1 + d * 0.7);
    this.frame.animate(
      [{ transform: 'none' }, { transform: `translateY(${px}px)` }, { transform: `translateY(${-px * 0.3}px)` }, { transform: 'none' }],
      { duration: 240, easing: 'ease-out' }
    );
  }

  // Fait retomber tous les pions vers leur position dans this.ids ; renvoie la durée max
  settle(fromIds, sound) {
    const pos = new Map();
    fromIds.forEach((r, i) => r.forEach((id) => id && pos.set(id, i)));
    let maxMs = 0;
    this.ids.forEach((r, i) =>
      r.forEach((id, j) => {
        if (!id) return;
        const from = pos.get(id) ?? i;
        const ms = this.fall(this.els.get(id), from, i, j, (d) => this.impact(d, sound));
        if (ms > maxMs) maxMs = ms;
      })
    );
    return maxMs;
  }

  // Anime un coup complet : chute, rotation éventuelle, nouvelle chute.
  async playMove(col, player, sound) {
    const fast = reduceMotion();
    const id = this.spawn(player, -1.1, col);
    this.hover(-1);
    await nextFrame();
    this.ids = dropInto(this.ids, col, id);
    const landRow = this.ids.findIndex((r) => r[col] === id);
    const ms = this.fall(this.els.get(id), -1.1, landRow, col, (d) => this.impact(d, sound));
    await wait(ms + 40);

    const rot = rotationFor(col, this.n, this.pivot);
    if (!rot) return;
    const rotMs = fast ? 0 : Math.round(ROTATE_MS / this.speed);
    const angle = rot === 'ccw' ? -90 : 90;
    sound?.('rotate', rotMs);
    this.root.classList.add('spinning');
    if (rotMs) {
      // Accélère puis ralentit ; le plateau recule légèrement au milieu du quart de tour
      const anim = this.board.animate(
        [
          { transform: 'rotate(0deg) scale(1)' },
          { transform: `rotate(${angle * 0.5}deg) scale(0.9)` },
          { transform: `rotate(${angle}deg) scale(1)` },
        ],
        { duration: rotMs, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }
      );
      await anim.finished;
      // Plateau remis droit + pions replacés dans la grille tournée : visuellement identique
      this.ids = rot === 'ccw' ? rotateCCW(this.ids) : rotateCW(this.ids);
      this.ids.forEach((r, i) => r.forEach((pid, j) => pid && this.place(this.els.get(pid), i, j)));
      anim.cancel();
    } else {
      this.ids = rot === 'ccw' ? rotateCCW(this.ids) : rotateCW(this.ids);
      this.ids.forEach((r, i) => r.forEach((pid, j) => pid && this.place(this.els.get(pid), i, j)));
    }
    this.root.classList.remove('spinning');
    await wait(fast ? 0 : 120);
    const pre = this.ids.map((r) => r.slice());
    this.ids = gravity(this.ids);
    const fall = this.settle(pre, sound);
    await wait(fall + 40);
  }

  valueGrid() {
    return this.ids.map((r) => r.map((id) => (id ? this.owner.get(id) : 0)));
  }

  refreshHighlights(grid) {
    const lit = alignedCells(grid, this.gain);
    this.ids.forEach((r, i) =>
      r.forEach((id, j) => {
        if (id) this.els.get(id).classList.toggle('lit', lit.has(i * this.n + j));
      })
    );
    return lit.size;
  }

  // Aligne l'affichage sur un état faisant autorité (utile en ligne si une désynchronisation survient)
  syncFull(state) {
    const same = JSON.stringify(this.valueGrid()) === JSON.stringify(state.grid);
    if (!same) {
      this.piecesEl.innerHTML = '';
      this.owner.clear();
      this.els.clear();
      this.ids = emptyGrid(this.n);
      state.grid.forEach((r, i) => r.forEach((p, j) => p && (this.ids[i][j] = this.spawn(p, i, j))));
    }
    this.refreshHighlights(state.grid);
    this.setFullColumns(state.grid);
  }
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
