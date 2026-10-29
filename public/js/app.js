import { createGame, applyMove, sanitizeSettings, alignedCells, signature, gridFromSignature, rotationFor, LIMITS, PRESETS, P1, P2 } from './engine.js';
import { Board } from './board.js';
import { store, session } from './storage.js';
import { play, buzz } from './sound.js';
import { Online, serverBase } from './online.js';
import { RARITIES, rarityOf } from './griddex.js';
import { account, api, setSession, refreshProfile } from './account.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const data = store.data;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MODE_LABEL = { solo: 'Solo', duo: '2 joueurs', rapide: 'Rapide', online: 'En ligne' };
const AI_NAMES = ['', 'Hasard', 'Débutant', 'Débutant', 'Facile', 'Facile', 'Moyen', 'Moyen', 'Confirmé', 'Confirmé', 'Expert', 'Expert', 'Maître', 'Grand maître'];

// ---------------------------------------------------------------- Écrans
let current = 'home';
function show(name) {
  current = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  if (name === 'griddex') renderGriddex();
  if (name === 'stats') renderStats();
  if (name === 'leaderboard') renderLeaderboard();
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function confirmBox(title, sub, yes = 'Quitter') {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-sub').textContent = sub;
    $('#confirm-yes').textContent = yes;
    $('#confirm').hidden = false;
    const done = (v) => {
      $('#confirm').hidden = true;
      $('#confirm-yes').onclick = $('#confirm-no').onclick = null;
      resolve(v);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
  });
}

// ---------------------------------------------------------------- Calculs en arrière-plan
let worker = null;
try {
  worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
} catch {}
let reqId = 0;
const pending = new Map();
if (worker) {
  worker.onmessage = (e) => {
    pending.get(e.data.id)?.(e.data);
    pending.delete(e.data.id);
  };
  worker.onerror = () => (worker = null);
}
async function compute(msg) {
  if (worker) {
    const id = ++reqId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ ...msg, id });
    });
  }
  // Repli si les workers en module ne sont pas disponibles
  if (msg.type === 'move') return { col: (await import('./ai.js')).chooseMove(msg.state, msg.level) };
  return { table: (await import('./griddex.js')).buildRarityTable(msg.games) };
}

let rarityPromise = null;
function rarityTable() {
  rarityPromise ??= compute({ type: 'rarity', games: 50000 }).then((r) => r.table);
  return rarityPromise;
}

// ---------------------------------------------------------------- Partie
const board = new Board($('#board'), { onColumn: (c) => onColumn(c) });

const G = {
  mode: 'solo',
  state: null,
  busy: false,
  token: 0,
  ai: 3,
  vsAi: false,
  names: { [P1]: 'Joueur 1', [P2]: 'Joueur 2' },
  you: P1, // en ligne : ton camp
  room: null,
  chain: Promise.resolve(),
  waitingServer: false,
  oppOnline: true,
  rematchAsked: false,
  history: [], // états précédents (modes hors ligne) pour annuler un coup
  preFinish: null, // stats/Griddex avant la fin de partie, restaurés si on annule le dernier coup
  ranked: false, // partie en ligne classée
  elos: null,
  rankedResult: null,
  endInfo: null,
};

function isAi(p) {
  return (G.mode === 'solo' || (G.mode === 'rapide' && G.vsAi)) && p === P2;
}
function isMine(p) {
  if (G.mode === 'online') return p === G.you;
  return !isAi(p);
}
function canPlay() {
  const s = G.state;
  if (!s || s.over || G.busy || G.waitingServer) return false;
  if (G.mode === 'online') return s.player === G.you && net.connected;
  return !isAi(s.player);
}

function startLocal(mode) {
  const cfg = data.settings[mode];
  G.mode = mode;
  G.token++;
  G.busy = false;
  G.waitingServer = false;
  G.history = [];
  G.preFinish = null;
  if (mode === 'rapide') {
    G.vsAi = !!cfg.vsAi;
    G.ai = cfg.ai;
    G.state = createGame(PRESETS.rapide);
  } else {
    G.vsAi = mode === 'solo';
    G.ai = cfg.ai ?? 1;
    G.state = createGame(cfg);
  }
  G.names = isAi(P2) ? { [P1]: data.name || 'Toi', [P2]: `IA niv. ${G.ai}` } : { [P1]: 'Joueur 1', [P2]: 'Joueur 2' };
  enterGame();
}

function enterGame() {
  const s = G.state;
  closeEnd();
  $('#g-mode').textContent = MODE_LABEL[G.mode];
  let params = `${s.size}×${s.size} · série de ${s.gain} · pivot ${s.pivot}`;
  if (isAi(P2)) params = `IA niv. ${G.ai} · ` + params;
  if (G.mode === 'online' && G.room) params = (G.ranked ? 'Classée · ' : `Salon ${G.room} · `) + params;
  $('#g-params').textContent = params;
  $('#g-restart').style.visibility = G.mode === 'online' ? 'hidden' : '';
  $('#emotes').hidden = G.mode !== 'online';
  const label = (p) => G.names[p] + (G.mode === 'online' && G.ranked && G.elos ? ` · ${G.elos[p]}` : '') + (G.mode === 'online' && G.you === p ? ' (toi)' : '');
  $('#pn1').textContent = label(P1);
  $('#pn2').textContent = label(P2);
  for (const k of [1, 2]) {
    $('#pnet' + k).classList.toggle('show', G.mode === 'online');
    $('#pnet' + k).classList.remove('off');
    $('#pg' + k).classList.remove('show');
  }
  board.setup(s);
  updateHud(null);
  show('game');
  maybeAi();
}

function updateHud(prev) {
  const s = G.state;
  for (const [p, k] of [[P1, 1], [P2, 2]]) {
    const el = $('#ps' + k);
    if (prev && s.scores[p] > prev.scores[p]) {
      el.classList.remove('score-bump');
      void el.offsetWidth;
      el.classList.add('score-bump');
    }
    el.textContent = s.scores[p];
    const gain = $('#pg' + k);
    const g = s.lastGain[p];
    gain.textContent = '+' + g;
    gain.classList.toggle('show', !!prev && s.scoring === 'cumul' && g > 0);
    const card = $('#pc' + k);
    card.classList.toggle('active', !s.over && s.player === p);
    $$('.pc-moves i', card).forEach((i, n) => i.classList.toggle('on', n < s.movesLeft));
    $$('.pc-moves i', card)[1].style.display = s.moves === 0 && s.player === p ? 'none' : '';
  }
  board.setTurn(s.player, canPlay());
  board.setFullColumns(s.grid);
  updateUndo();
  $('#g-status').innerHTML = statusText();
}

// ----- Annuler (modes hors ligne)
function updateUndo() {
  const btn = $('#g-undo');
  btn.hidden = G.mode === 'online';
  btn.disabled = G.busy || !canUndo();
}

// Il faut au moins un coup joué par un humain (contre l'IA, annuler seulement ses coups n'a pas de sens)
function canUndo() {
  return G.history.some((s) => !isAi(s.player));
}

function undo() {
  if (G.mode === 'online' || G.busy || !canUndo()) return;
  G.token++; // annule un coup de l'IA en préparation ou l'affichage de fin de partie
  const wasOver = G.state.over;
  let s = G.history.pop();
  // Contre l'IA, on revient jusqu'au dernier coup du joueur humain
  while (isAi(s.player) && G.history.length) s = G.history.pop();
  if (wasOver && G.preFinish) {
    const saved = JSON.parse(G.preFinish);
    data.stats = saved.stats;
    data.griddex = saved.griddex;
    store.save();
    G.preFinish = null;
  }
  G.state = s;
  closeEnd();
  play('tap');
  board.setup(s);
  updateHud(null);
  maybeAi();
}

function statusText() {
  const s = G.state;
  if (s.over) return `Partie terminée · <button class="link-btn" data-action="reopen-end">voir le résultat</button>`;
  const c = s.player === P1 ? 'c1' : 'c2';
  const left = s.movesLeft === 2 ? '2 coups' : '1 coup';
  if (G.mode === 'online') {
    if (!net.connected) return `Reconnexion<span class="dots"></span>`;
    if (!G.oppOnline) return `En attente de <b class="${G.you === P1 ? 'c2' : 'c1'}">${esc(G.names[-G.you])}</b><span class="dots"></span>`;
    return s.player === G.you ? `<b class="${c}">À toi</b> · ${left}` : `<b class="${c}">${esc(G.names[s.player])}</b> joue<span class="dots"></span>`;
  }
  if (isAi(s.player)) return `<b class="${c}">L'IA</b> réfléchit<span class="dots"></span>`;
  if (isAi(P2)) return `<b class="${c}">À toi</b> · ${left}`;
  return `Au tour de <b class="${c}">${esc(G.names[s.player])}</b> · ${left}`;
}

function onColumn(col) {
  if (!canPlay()) return;
  const s = G.state;
  if (s.grid[0][col] !== 0) return;
  play('tap');
  buzz(8);
  if (G.mode === 'online') {
    G.waitingServer = true;
    board.setTurn(s.player, false);
    net.send({ t: 'move', col });
    setTimeout(() => {
      // sécurité : si le serveur ne répond pas, on redonne la main
      if (G.waitingServer && G.state === s) {
        G.waitingServer = false;
        updateHud(null);
      }
    }, 5000);
    return;
  }
  doMove(col);
}

async function doMove(col, serverState) {
  const prev = G.state;
  const next = serverState || applyMove(prev, col);
  if (!next) return;
  const token = G.token;
  if (G.mode !== 'online') G.history.push(prev);
  G.busy = true;
  board.setTurn(prev.player, false);
  updateUndo();
  $$('.pc-gain').forEach((g) => g.classList.remove('show'));
  await board.playMove(col, prev.player, (name, arg) => {
    play(name, arg);
    if (name === 'drop') buzz(Math.round(6 + Math.min(arg || 1, 6) * 3));
  });
  if (token !== G.token) return;
  G.state = next;
  G.busy = false;
  if (serverState) board.syncFull(next);
  const lit = board.refreshHighlights(next.grid);
  const gained = next.scoring === 'cumul' ? next.lastGain[P1] + next.lastGain[P2] > 0 : next.scores[P1] + next.scores[P2] > prev.scores[P1] + prev.scores[P2];
  if (lit && gained) play('score');
  updateHud(prev);
  if (next.over) finish();
  else maybeAi();
}

async function maybeAi() {
  const s = G.state;
  if (!s || s.over || !isAi(s.player)) return;
  const token = G.token;
  const [{ col }] = await Promise.all([compute({ type: 'move', state: s, level: G.ai }), wait(550)]);
  if (token !== G.token || G.state !== s) return;
  doMove(col);
}

// ---------------------------------------------------------------- Fin de partie
async function finish(extra = {}) {
  const s = G.state;
  const token = G.token;
  board.setTurn(s.player, false);
  $$('.pcard').forEach((c) => c.classList.remove('active'));
  const info = { ...extra, dex: null };
  if (G.mode !== 'online') G.preFinish = JSON.stringify({ stats: data.stats, griddex: data.griddex });

  // Statistiques
  const st = data.stats[G.mode];
  st.played++;
  st.best = Math.max(st.best || 0, s.scores[P1], s.scores[P2]);
  if (G.mode === 'solo' || G.mode === 'online' || (G.mode === 'rapide' && G.vsAi)) {
    const me = G.mode === 'online' ? G.you : P1;
    const res = s.winner === me ? 'won' : s.winner === 0 ? 'draw' : 'lost';
    if (G.mode === 'rapide') st[res === 'won' ? 'p1' : res === 'lost' ? 'p2' : 'draw']++;
    else st[res]++;
    if (G.mode === 'solo' && res === 'won') st.bestLevel = Math.max(st.bestLevel || 0, G.ai);
    if (G.mode === 'online') {
      st.streak = res === 'won' ? (st.streak || 0) + 1 : 0;
      st.bestStreak = Math.max(st.bestStreak || 0, st.streak);
    }
  } else {
    st[s.winner === P1 ? 'p1' : s.winner === P2 ? 'p2' : 'draw']++;
  }

  // Griddex (grilles finales du format Rapide)
  if (s.scoring === 'live' && !s.forfeit) {
    const sig = signature(s.grid);
    const known = data.griddex[sig];
    data.griddex[sig] = { count: (known?.count || 0) + 1, first: known?.first || Date.now() };
    info.dex = { sig, isNew: !known, rarity: null };
    rarityTable().then((t) => {
      info.dex.rarity = rarityOf(t, sig);
      if (G.endInfo === info) renderEndDex(info.dex);
    });
  }
  store.save();

  await wait(extra.forfeit ? 100 : 750);
  if (token !== G.token) return;
  const me = G.mode === 'online' ? G.you : isAi(P2) ? P1 : null;
  if (me !== null) play(s.winner === me ? 'win' : s.winner === 0 ? 'score' : 'lose');
  else play('win');
  openEnd(info);
}

function openEnd(info) {
  const s = G.state;
  G.endInfo = info;
  G.rematchAsked = false;
  const me = G.mode === 'online' ? G.you : isAi(P2) ? P1 : null;
  const badge = $('#end-badge');
  badge.className = 'end-badge' + (s.winner === P1 ? ' p1' : s.winner === P2 ? ' p2' : '');
  badge.textContent = s.winner === 0 ? '=' : '';
  let title, sub;
  if (me !== null) {
    title = s.winner === me ? 'Victoire !' : s.winner === 0 ? 'Égalité' : 'Défaite';
    if (G.mode === 'online') {
      sub = info.forfeit ? `${G.names[-G.you]} a quitté la partie.` : s.winner === me ? `Tu bats ${G.names[-me]} !` : s.winner === 0 ? 'Personne ne l’emporte.' : `${G.names[-me]} l’emporte.`;
    } else {
      sub = s.winner === me ? `Tu bats l'IA niveau ${G.ai} (${AI_NAMES[G.ai]}).` : s.winner === 0 ? 'Match nul contre l’IA.' : `L'IA niveau ${G.ai} l'emporte. Retente ta chance !`;
    }
  } else {
    title = s.winner === 0 ? 'Égalité !' : `${G.names[s.winner]} gagne !`;
    sub = s.winner === 0 ? 'Aucun joueur ne se démarque.' : `Avec ${s.scores[s.winner]} points contre ${s.scores[-s.winner]}.`;
  }
  $('#end-title').textContent = title;
  $('#end-sub').textContent = sub;
  $('#es-n1').textContent = G.names[P1];
  $('#es-n2').textContent = G.names[P2];
  $('#es-s1').textContent = s.scores[P1];
  $('#es-s2').textContent = s.scores[P2];
  const again = $('#end-again');
  again.disabled = false;
  if (G.mode === 'online') {
    again.textContent = G.ranked ? 'Nouvelle partie classée' : info.forfeit ? 'Nouvelle partie' : 'Revanche';
  } else again.textContent = 'Rejouer';
  renderEndDex(info.dex);
  renderEndElo();
  $('#end').hidden = false;
  $('#g-status').innerHTML = statusText();
}

function renderEndDex(dex) {
  const box = $('#end-dex');
  if (!dex) return (box.hidden = true);
  box.hidden = false;
  const r = dex.rarity;
  box.className = 'end-dex' + (r ? ' rar-' + r.key : '') + (dex.isNew ? ' new' : '');
  box.innerHTML = `${miniGrid(gridFromSignature(dex.sig))}
    <div><b>${dex.isNew ? 'Nouvelle grille découverte !' : 'Grille déjà dans ton Griddex'}</b>
    <small>Rareté : <span style="color:var(--rc)">${r ? r.label : 'calcul…'}</span></small></div>`;
}

function renderEndElo() {
  const box = $('#end-elo');
  box.hidden = !(G.mode === 'online' && G.ranked);
  if (box.hidden) return;
  const r = G.rankedResult;
  if (!r) return (box.innerHTML = '<small>Calcul de ton elo…</small>');
  const cls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : '';
  box.innerHTML = `<b class="${cls}">${r.delta > 0 ? '+' : ''}${r.delta}</b><div><small>Elo</small><br/><b style="font-size:20px">${r.before} → ${r.after}</b></div>`;
}

function closeEnd() {
  $('#end').hidden = true;
  G.endInfo = null;
}

function miniGrid(g, pivot = 0, lit = true) {
  const n = g.length;
  const on = lit ? alignedCells(g, n === 4 ? 3 : 4) : new Set();
  let cells = '';
  g.forEach((r, i) =>
    r.forEach((v, j) => {
      const cls = v === P1 ? 'p1' : v === P2 ? 'p2' : pivot && rotationFor(j, n, pivot) ? 'pv' : '';
      cells += `<i class="${cls}${on.has(i * n + j) ? ' lit' : ''}"></i>`;
    })
  );
  return `<div class="mini" style="--n:${n}">${cells}</div>`;
}

$('#end-menu').onclick = () => {
  closeEnd();
  if (G.mode === 'online') {
    net.send({ t: 'cancel' });
    G.room = null;
    showOnlineIdle();
  }
  G.token++;
  show(G.mode === 'online' ? 'online' : 'home');
};
$('#end-again').onclick = () => {
  if (G.mode !== 'online') {
    closeEnd();
    return startLocal(G.mode);
  }
  if (G.ranked) {
    closeEnd();
    G.room = null;
    show('online');
    return startRankedSearch();
  }
  if (G.endInfo?.forfeit || !G.room) {
    closeEnd();
    G.room = null;
    showOnlineIdle();
    return show('online');
  }
  net.send({ t: 'rematch' });
  G.rematchAsked = true;
  $('#end-again').disabled = true;
  $('#end-again').textContent = 'En attente…';
};
$('#end-view').onclick = () => {
  $('#end').hidden = true;
};

// ---------------------------------------------------------------- Actions globales
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    play('tap');
    if (go.dataset.go === 'home' && current === 'online') leaveOnlineScreen();
    return show(go.dataset.go);
  }
  const mode = e.target.closest('[data-mode]');
  if (mode) {
    play('tap');
    return mode.dataset.mode === 'online' ? openOnline() : openSheet(mode.dataset.mode);
  }
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (!act) return;
  if (act === 'close-sheet') closeSheet();
  if (act === 'close-shop') $('#shop').hidden = true;
  if (act === 'undo') undo();
  if (act === 'reopen-end' && G.endInfo) $('#end').hidden = false;
  if (act === 'restart') {
    if (G.state && !G.state.over && G.state.moves > 0 && !(await confirmBox('Recommencer ?', 'La partie en cours sera perdue.', 'Recommencer'))) return;
    startLocal(G.mode);
  }
  if (act === 'quit') {
    const s = G.state;
    if (G.mode === 'online' && s && !s.over) {
      const sub = G.ranked ? 'Quitter une partie classée compte comme une défaite et te fait perdre de l’elo.' : 'Quitter une partie en ligne compte comme une défaite.';
      if (!(await confirmBox('Abandonner ?', sub, 'Abandonner'))) return;
      net.send({ t: 'cancel' });
      data.stats.online.played++;
      data.stats.online.lost++;
      data.stats.online.streak = 0;
      store.save();
      G.room = null;
      G.token++;
      showOnlineIdle();
      return show('online');
    }
    if (s && !s.over && s.moves > 0 && G.mode !== 'online' && !(await confirmBox('Quitter la partie ?', 'La partie en cours sera perdue.'))) return;
    G.token++;
    if (G.mode === 'online') {
      net.send({ t: 'cancel' });
      G.room = null;
      showOnlineIdle();
      return show('online');
    }
    show('home');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#sheet').hidden) closeSheet();
    else if (!$('#end').hidden) $('#end').hidden = true;
  }
  if (current === 'game' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
  }
  // Jouer au clavier : touches 1 à 9
  if (current === 'game' && /^[1-9]$/.test(e.key) && $('#end').hidden) {
    const c = +e.key - 1;
    if (G.state && c < G.state.size) onColumn(c);
  }
});

const soundBtn = $('#sound-toggle');
function renderSound() {
  soundBtn.classList.toggle('off', !data.sound);
  soundBtn.querySelector('use').setAttribute('href', data.sound ? '#i-sound' : '#i-mute');
  soundBtn.querySelector('span').textContent = data.sound ? 'Son' : 'Muet';
}
soundBtn.onclick = () => {
  data.sound = !data.sound;
  store.save();
  renderSound();
  play('tap');
};
renderSound();

// ---------------------------------------------------------------- Réglages (feuille)
function stepper({ key, label, hint, value, min, max, onChange }) {
  const el = document.createElement('div');
  el.className = 'stepper';
  el.innerHTML = `<div class="stepper-label"><b>${label}</b><small></small></div>
    <div class="stepper-ctl"><button aria-label="Moins">−</button><output></output><button aria-label="Plus">+</button></div>`;
  const [minus, plus] = $$('button', el);
  const out = $('output', el);
  const small = $('small', el);
  let v = value;
  const render = () => {
    out.textContent = key === 'size' ? `${v}×${v}` : v;
    small.textContent = typeof hint === 'function' ? hint(v) : hint;
    minus.disabled = v <= min();
    plus.disabled = v >= max();
  };
  minus.onclick = () => {
    v = Math.max(min(), v - 1);
    play('tap');
    onChange(v);
  };
  plus.onclick = () => {
    v = Math.min(max(), v + 1);
    play('tap');
    onChange(v);
  };
  el.set = (nv) => {
    v = nv;
    render();
  };
  render();
  return el;
}

function segmented(options, value, onChange) {
  const el = document.createElement('div');
  el.className = 'seg';
  for (const [v, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.v = v;
    b.classList.toggle('on', v === value);
    b.onclick = () => {
      $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
      play('tap');
      onChange(v);
    };
    el.appendChild(b);
  }
  return el;
}

// Construit les réglages de grille (taille, série, pivot) + aperçu, liés à l'objet `cfg`
function gridSettings(cfg, container, withAi) {
  container.innerHTML = '';
  const prev = document.createElement('div');
  prev.className = 'preview';
  const panel = document.createElement('div');
  const refresh = () => {
    Object.assign(cfg, sanitizeSettings(cfg), withAi ? { ai: cfg.ai } : {});
    const n = cfg.size;
    prev.innerHTML = `${miniGrid(Array.from({ length: n }, () => new Array(n).fill(0)), cfg.pivot, false)}
      <p>Grille <b>${n}×${n}</b>, aligne <b>${cfg.gain}</b> pions.<br/>Les <b>${cfg.pivot}</b> colonne${cfg.pivot > 1 ? 's' : ''} de chaque bord ${cfg.pivot > 1 ? 'font' : 'fait'} pivoter la grille.${withAi ? `<br/>IA : <b>${AI_NAMES[cfg.ai]}</b>` : ''}</p>`;
    steppers.forEach((s) => s.set(cfg[s.key]));
    store.save();
  };
  const steppers = [];
  const mk = (o) => {
    const s = stepper({ ...o, onChange: (v) => ((cfg[o.key] = v), refresh()) });
    s.key = o.key;
    steppers.push(s);
    panel.appendChild(s);
  };
  if (withAi) mk({ key: 'ai', label: 'Niveau IA', hint: (v) => AI_NAMES[v], value: cfg.ai, min: () => 1, max: () => 13 });
  mk({ key: 'size', label: 'Taille', hint: 'Côté de la grille', value: cfg.size, min: () => LIMITS.size.min, max: () => LIMITS.size.max });
  mk({ key: 'gain', label: 'Série', hint: 'Pions à aligner', value: cfg.gain, min: () => LIMITS.gain(cfg.size).min, max: () => LIMITS.gain(cfg.size).max });
  mk({ key: 'pivot', label: 'Pivot', hint: 'Colonnes pivotantes par côté', value: cfg.pivot, min: () => LIMITS.pivot(cfg.size).min, max: () => LIMITS.pivot(cfg.size).max });
  container.append(prev, panel);
  refresh();
}

let sheetMode = null;
function openSheet(mode) {
  sheetMode = mode;
  $('#sheet-title').textContent = MODE_LABEL[mode];
  const body = $('#sheet-body');
  body.innerHTML = '';
  const cfg = data.settings[mode];
  if (mode === 'rapide') {
    const info = document.createElement('div');
    info.className = 'preview';
    info.innerHTML = `${miniGrid([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 1, false)}
      <p>Grille <b>4×4</b>, séries de <b>3</b>, pivot <b>1</b>.<br/>Seules les séries présentes comptent. Chaque grille finale rejoint ton <b>Griddex</b>.</p>`;
    const aiBox = document.createElement('div');
    const renderAi = () => {
      aiBox.innerHTML = '';
      if (cfg.vsAi)
        aiBox.appendChild(
          stepper({ key: 'ai', label: 'Niveau IA', hint: (v) => AI_NAMES[v], value: cfg.ai, min: () => 1, max: () => 13, onChange: (v) => ((cfg.ai = v), aiBox.firstChild.set(v), store.save()) })
        );
    };
    const seg = segmented([[false, '2 joueurs'], [true, 'Contre l’IA']], !!cfg.vsAi, (v) => {
      cfg.vsAi = v;
      store.save();
      renderAi();
    });
    body.append(info, seg, aiBox);
    renderAi();
  } else {
    gridSettings(cfg, body, mode === 'solo');
  }
  $('#sheet').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
}
$('#sheet').addEventListener('click', (e) => e.target.id === 'sheet' && closeSheet());
$('#sheet-play').onclick = () => {
  closeSheet();
  play('tap');
  startLocal(sheetMode);
};

// ---------------------------------------------------------------- En ligne
const net = new Online({
  status: (st) => {
    $('#net-dot').className = 'net-dot ' + st;
    $('#net-label').textContent = st === 'online' ? 'Connecté' : st === 'connecting' ? 'Connexion…' : 'Hors ligne';
    if (G.mode === 'online' && current === 'game' && G.state) updateHud(null);
  },
  message: onNet,
});

const onlineCfg = data.settings.online;
let quickFormat = 'classic';

function openOnline() {
  $('#o-name').value = data.name;
  show('online');
  net.connect(account.profile?.name || data.name || 'Joueur');
  if (!G.room) showOnlineIdle();
  loadAccount();
}

function leaveOnlineScreen() {
  if (!$('#o-wait').hidden) net.send({ t: 'cancel' });
  showOnlineIdle();
}

function showOnlineIdle() {
  $('#o-idle').hidden = false;
  $('#o-wait').hidden = true;
}

function showWaiting(title, room) {
  $('#o-idle').hidden = true;
  $('#o-wait').hidden = false;
  $('#o-wait-title').textContent = title;
  $('#o-room').hidden = !room;
  if (room) {
    $('#o-room-code').textContent = room.code;
    const s = room.settings;
    $('#o-room-params').textContent = s.scoring === 'live' ? 'Format Rapide · 4×4' : `Grille ${s.size}×${s.size} · série de ${s.gain} · pivot ${s.pivot}`;
  }
}

function inviteLink() {
  return window.TURNIT_CONFIG?.app ? `${serverBase()}/?salon=${G.room}` : `${location.origin}${location.pathname}?salon=${G.room}`;
}

const IS_APP = !!window.TURNIT_CONFIG?.app;
$('#o-server-box').hidden = !IS_APP;
if (IS_APP) {
  $('#o-help').textContent = "Le serveur Turn It doit tourner sur ton ordinateur (npm start) ou être hébergé en ligne. Sur un même Wi-Fi, mets l'adresse « réseau local » affichée au lancement.";
  $('#o-server').value = serverBase();
  $('#o-server').addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (v && !/^https?:\/\//.test(v)) v = 'http://' + v;
    data.server = v;
    store.save();
    e.target.value = serverBase();
    net.disconnect();
    net.connect(data.name || 'Joueur');
  });
}

$('#o-name').addEventListener('change', (e) => {
  data.name = e.target.value.trim().slice(0, 16);
  store.save();
  net.name = data.name || 'Joueur';
  net.send({ t: 'name', name: net.name });
});

$('#o-format').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  quickFormat = b.dataset.v;
  $$('#o-format button').forEach((x) => x.classList.toggle('on', x === b));
});

function renderOnlineSettings() {
  const box = $('#o-settings');
  box.innerHTML = '';
  const inner = document.createElement('div');
  inner.style.display = 'flex';
  inner.style.flexDirection = 'column';
  inner.style.gap = '12px';
  const render = () => {
    if (onlineCfg.format === 'rapide') inner.innerHTML = '';
    else gridSettings(onlineCfg, inner, false);
  };
  box.append(
    segmented([['classic', 'Classique'], ['rapide', 'Rapide 4×4']], onlineCfg.format, (v) => {
      onlineCfg.format = v;
      store.save();
      render();
    }),
    inner
  );
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.gap = '12px';
  render();
}
renderOnlineSettings();

function ensureName() {
  const v = $('#o-name').value.trim().slice(0, 16);
  if (v !== data.name) {
    data.name = v;
    store.save();
    net.name = v || 'Joueur';
    net.send({ t: 'name', name: net.name });
  }
}

$('#o-quick').onclick = () => {
  ensureName();
  showWaiting("Recherche d'un adversaire…");
  net.send({ t: 'quick', format: quickFormat });
};
$('#o-create').onclick = () => {
  ensureName();
  showWaiting('Création du salon…');
  const settings = onlineCfg.format === 'rapide' ? { scoring: 'live' } : { size: onlineCfg.size, gain: onlineCfg.gain, pivot: onlineCfg.pivot };
  net.send({ t: 'create', settings });
};
$('#o-join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $('#o-code').value.trim().toUpperCase();
  if (code.length < 4) return toast('Le code fait 4 caractères.');
  ensureName();
  showWaiting('Connexion au salon…');
  net.send({ t: 'join', code });
};
$('#o-code').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
$('#o-cancel').onclick = () => {
  net.send({ t: 'cancel' });
  G.room = null;
  showOnlineIdle();
};
$('#o-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Lien copié !');
  } catch {
    toast(inviteLink(), 5000);
  }
};
$('#o-share').onclick = async () => {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Turn It', text: `Viens jouer à Turn It avec moi ! Code : ${G.room}`, url: inviteLink() });
    } catch {}
  } else $('#o-copy').click();
};

$('#emotes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  net.send({ t: 'emote', e: b.dataset.e });
  showEmote(G.you, b.dataset.e);
});
function showEmote(side, e) {
  const el = $(side === P1 ? '#pe1' : '#pe2');
  el.textContent = e;
  el.classList.toggle('txt', e === 'GG');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function startOnline(view) {
  G.mode = 'online';
  G.token++;
  G.busy = false;
  G.waitingServer = false;
  G.chain = Promise.resolve();
  G.room = view.code;
  G.you = view.you;
  G.ranked = !!view.ranked;
  G.elos = view.elos || null;
  if (view.round !== G.round || view.code !== G.lastCode) G.rankedResult = null;
  G.round = view.round;
  G.lastCode = view.code;
  G.oppOnline = view.online ? !!view.online[-view.you] : true;
  G.names = { [P1]: view.names[P1] || 'Joueur 1', [P2]: view.names[P2] || 'Joueur 2' };
  G.state = view.state;
  showOnlineIdle();
  enterGame();
  $(G.you === P1 ? '#pnet2' : '#pnet1').classList.toggle('off', !G.oppOnline);
  if (G.state.over) openEnd({ dex: null });
}

function onNet(msg) {
  switch (msg.t) {
    case 'queued':
      showWaiting(msg.ranked ? 'Recherche d’un adversaire classé…' : "Recherche d'un adversaire…");
      break;
    case 'ranked-result':
      G.rankedResult = msg.result;
      account.profile = msg.profile;
      renderEndElo();
      renderAccount();
      break;
    case 'room':
      G.room = msg.code;
      showWaiting("En attente d'un ami…", msg);
      if (current !== 'online') show('online');
      break;
    case 'start':
      play('notify');
      buzz(30);
      if (G.rematchAsked || (G.mode === 'online' && G.room === msg.code && msg.round > 1)) toast('Revanche ! Nouvelle partie.');
      history.replaceState(null, '', location.pathname);
      startOnline(msg);
      break;
    case 'resume':
      G.chain = G.chain.then(() => {
        if (current === 'game' && G.mode === 'online' && G.room === msg.code && G.state) {
          G.state = msg.state;
          G.waitingServer = false;
          G.oppOnline = !!msg.online[-G.you];
          board.syncFull(msg.state);
          updateHud(null);
        } else startOnline(msg);
      });
      break;
    case 'move':
      G.chain = G.chain.then(async () => {
        if (G.mode !== 'online' || !G.state) return;
        G.waitingServer = false;
        if (msg.state.moves !== G.state.moves + 1) {
          // décalage : on se recale sur l'état du serveur
          G.state = msg.state;
          board.syncFull(msg.state);
          updateHud(null);
          if (msg.state.over) finish();
          return;
        }
        await doMove(msg.col, msg.state);
      });
      break;
    case 'sync':
      G.chain = G.chain.then(() => {
        G.waitingServer = false;
        G.state = msg.state;
        board.syncFull(msg.state);
        updateHud(null);
      });
      break;
    case 'opp-status':
      G.oppOnline = msg.online;
      $(G.you === P1 ? '#pnet2' : '#pnet1').classList.toggle('off', !msg.online);
      toast(msg.online ? `${G.names[-G.you]} est de retour.` : `${G.names[-G.you]} s'est déconnecté… (1 min pour revenir)`);
      if (current === 'game') updateHud(null);
      break;
    case 'forfeit':
      G.chain = G.chain.then(() => {
        G.state = msg.state;
        G.room = null;
        updateHud(null);
        closeEnd();
        finish({ forfeit: true });
      });
      break;
    case 'opp-left':
      G.room = null;
      if (G.endInfo) {
        $('#end-again').disabled = false;
        $('#end-again').textContent = 'Nouvelle partie';
        G.endInfo.forfeit = true;
      }
      toast(`${G.names[-G.you] || 'Ton adversaire'} a quitté le salon.`);
      break;
    case 'rematch-req':
      play('notify');
      toast(`${G.names[-G.you]} veut une revanche !`);
      if (!G.rematchAsked) $('#end-again').textContent = 'Accepter la revanche';
      break;
    case 'emote':
      showEmote(msg.by, msg.e);
      play('tap');
      break;
    case 'error':
      toast(msg.msg);
      if (msg.code === 'auth') setSession(null);
      if (current !== 'game') {
        G.room = null;
        showOnlineIdle();
      }
      if (msg.code === 'quota' || msg.code === 'auth') loadAccount();
      break;
    case 'idle':
      break;
  }
}

// ---------------------------------------------------------------- Griddex
async function renderGriddex() {
  const entries = Object.entries(data.griddex);
  $('#dex-count').textContent = `${entries.length} grille${entries.length > 1 ? 's' : ''} découverte${entries.length > 1 ? 's' : ''}`;
  const grid = $('#dex-grid');
  const summary = $('#dex-summary');
  if (!entries.length) {
    summary.innerHTML = '';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><svg><use href="#i-dex"/></svg><p>Aucune grille pour l'instant.<br/>Termine une partie <b>Rapide</b> pour commencer ta collection.</p><button class="btn primary" data-mode="rapide">Jouer en Rapide</button></div>`;
    return;
  }
  grid.innerHTML = '<p class="muted center" style="grid-column:1/-1">Calcul des raretés…</p>';
  const table = await rarityTable();
  const order = RARITIES.map((r) => r.key).reverse();
  const items = entries
    .map(([sig, v]) => ({ sig, ...v, r: rarityOf(table, sig) }))
    .sort((a, b) => order.indexOf(a.r.key) - order.indexOf(b.r.key) || b.first - a.first);
  summary.innerHTML = RARITIES.map((r) => `<div class="dex-sum rar-${r.key}"><b>${items.filter((i) => i.r.key === r.key).length}</b><span>${r.label}</span></div>`).join('');
  grid.innerHTML = items
    .map((i) => `<div class="dex-card rar-${i.r.key}">${miniGrid(gridFromSignature(i.sig))}<span>${i.r.label}</span><small>×${i.count}</small></div>`)
    .join('');
}

// ---------------------------------------------------------------- Stats
function renderStats() {
  const s = data.stats;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + ' %' : '—');
  const bar = (parts) => {
    const t = parts.reduce((a, [v]) => a + v, 0) || 1;
    return `<div class="winbar">${parts.map(([v, c]) => `<i style="width:${(100 * v) / t}%;background:${c}"></i>`).join('')}</div>`;
  };
  const panel = (icon, title, stats, extra = '') => `<div class="panel"><div class="panel-head"><svg><use href="#${icon}"/></svg><h3>${title}</h3></div>
    <div class="stat-grid">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>${extra}</div>`;
  $('#stats-body').innerHTML = [
    panel('i-solo', 'Solo', [[s.solo.played, 'Parties'], [s.solo.won, 'Victoires'], [pct(s.solo.won, s.solo.played), 'Réussite'], [s.solo.lost, 'Défaites'], [s.solo.draw, 'Nuls'], [s.solo.bestLevel || '—', 'Meilleure IA battue']],
      bar([[s.solo.won, 'var(--p1)'], [s.solo.draw, '#666b7d'], [s.solo.lost, 'var(--p2)']])),
    panel('i-globe', 'En ligne', [[s.online.played, 'Parties'], [s.online.won, 'Victoires'], [pct(s.online.won, s.online.played), 'Réussite'], [s.online.lost, 'Défaites'], [s.online.streak || 0, 'Série actuelle'], [s.online.bestStreak || 0, 'Meilleure série']],
      bar([[s.online.won, 'var(--p1)'], [s.online.draw, '#666b7d'], [s.online.lost, 'var(--p2)']])),
    panel('i-duo', '2 joueurs', [[s.duo.played, 'Parties'], [s.duo.p1, 'Victoires J1'], [s.duo.p2, 'Victoires J2'], [s.duo.draw, 'Nuls'], [s.duo.best || 0, 'Meilleur score'], ['', '']].slice(0, 5),
      bar([[s.duo.p1, 'var(--p1)'], [s.duo.draw, '#666b7d'], [s.duo.p2, 'var(--p2)']])),
    panel('i-bolt', 'Rapide', [[s.rapide.played, 'Parties'], [s.rapide.p1, 'Victoires J1'], [s.rapide.p2, 'Victoires J2'], [s.rapide.draw, 'Nuls'], [Object.keys(data.griddex).length, 'Grilles Griddex']],
      bar([[s.rapide.p1, 'var(--p1)'], [s.rapide.draw, '#666b7d'], [s.rapide.p2, 'var(--p2)']])),
  ].join('');
}

// ---------------------------------------------------------------- Classé : compte, quota, pubs, boutique
function fmtLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}
const euros = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

let accountError = null;
async function loadAccount() {
  accountError = null;
  try {
    await refreshProfile();
  } catch (e) {
    if (e.offline) accountError = e.message;
  }
  renderAccount();
}

let authMode = 'login';
function renderAccount() {
  const box = $('#o-account');
  const p = account.profile;
  $('#o-guest').hidden = account.loggedIn;
  if (!account.loggedIn) {
    box.innerHTML = `
      <div class="panel-head"><svg><use href="#i-trophy"/></svg><h3>Parties classées</h3></div>
      <p class="muted">Crée un compte pour avoir un elo et apparaître au classement. ${3} parties classées offertes chaque jour.</p>
      <div class="seg tabs"><button data-auth="login" class="${authMode === 'login' ? 'on' : ''}">Connexion</button><button data-auth="register" class="${authMode === 'register' ? 'on' : ''}">Créer un compte</button></div>
      <form class="btn-col" id="auth-form">
        <label class="field"><span>Pseudo</span><input id="auth-name" maxlength="16" autocomplete="username" value="${esc(data.auth?.name || data.name || '')}" /></label>
        <label class="field"><span>Mot de passe</span><input id="auth-pass" type="password" autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}" /></label>
        <p class="err" id="auth-err"></p>
        <button class="btn primary wide" type="submit">${authMode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
      </form>
      <div class="link-row"><button class="link-btn" data-go="leaderboard">Voir le classement</button></div>`;
    $$('[data-auth]', box).forEach((b) => (b.onclick = () => ((authMode = b.dataset.auth), renderAccount())));
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await api(authMode === 'login' ? '/api/login' : '/api/register', {
          method: 'POST',
          body: { name: $('#auth-name').value, password: $('#auth-pass').value },
        });
        setSession(res);
        net.name = res.profile.name;
        net.send({ t: 'auth', auth: res.token });
        toast(authMode === 'login' ? `Content de te revoir, ${res.profile.name} !` : `Bienvenue ${res.profile.name} !`);
        renderAccount();
      } catch (err) {
        $('#auth-err').textContent = err.message;
        btn.disabled = false;
      }
    };
    return;
  }
  if (!p) {
    box.innerHTML = accountError
      ? `<p class="muted">${esc(accountError)}</p><button class="btn wide" id="acc-retry">Réessayer</button>`
      : `<p class="muted center">Chargement du profil…</p>`;
    $('#acc-retry')?.addEventListener('click', loadAccount);
    return;
  }
  const q = p.quota;
  const left = q.resetAt - Date.now();
  const usedDots = Array.from({ length: q.free }, (_, i) => `<i class="${i < q.played && !q.premium ? 'used' : ''}"></i>`).join('');
  let quotaLine, quotaSub;
  if (q.premium) {
    quotaLine = '<b>Parties illimitées</b>';
    quotaSub = q.lifetime ? 'À vie' : `Jusqu’au ${new Date(q.premiumUntil).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  } else {
    quotaLine = q.freeLeft ? `<b>${q.freeLeft} partie${q.freeLeft > 1 ? 's' : ''} classée${q.freeLeft > 1 ? 's' : ''}</b> aujourd’hui` : '<b>Parties du jour jouées</b>';
    quotaSub = `Nouvelles parties dans ${fmtLeft(left)}`;
  }
  const needBonus = !q.premium && q.freeLeft === 0;
  let mainBtn;
  if (q.canPlay) mainBtn = `<button class="btn primary wide big" id="rk-play"><svg><use href="#i-trophy"/></svg>${needBonus ? 'Jouer avec un bonus' : 'Jouer une partie classée'}</button>`;
  else mainBtn = `<button class="btn wide big" disabled>Reviens dans ${fmtLeft(left)}</button>`;
  const bonusChip = q.premium
    ? ''
    : `<span class="chip ${q.bonus ? 'ok' : 'off'}"><svg><use href="#i-gift"/></svg>${q.bonus} bonus</span>
       <span class="chip ${q.bonusUsedToday ? 'off' : ''}">${q.bonusUsedToday ? 'Bonus du jour utilisé' : '1 bonus utilisable / jour'}</span>`;
  box.innerHTML = `
    <div class="rk-head">
      <div class="rk-avatar">${esc(p.name[0].toUpperCase())}</div>
      <div class="rk-id"><b>${esc(p.name)}</b><small>${p.rank ? `#${p.rank} au classement` : 'Pas encore classé'} · ${p.wins} V · ${p.losses} D${p.draws ? ` · ${p.draws} N` : ''}</small></div>
      <div class="rk-elo"><b>${p.elo}</b><small>elo</small></div>
    </div>
    <div class="quota">
      ${q.premium ? `<span class="chip gold"><svg><use href="#i-infinity"/></svg></span>` : `<div class="quota-dots">${usedDots}</div>`}
      <div class="quota-txt"><span>${quotaLine}</span><small>${quotaSub}</small></div>
    </div>
    ${bonusChip ? `<div class="chips">${bonusChip}</div>` : ''}
    <div class="btn-col">
      ${mainBtn}
      ${q.premium ? '' : `<div class="row"><button class="btn" id="rk-ad"><svg><use href="#i-play"/></svg>+1 bonus</button>${q.lifetime ? '' : `<button class="btn gold" id="rk-shop"><svg><use href="#i-infinity"/></svg>Illimité</button>`}</div>`}
      ${q.premium && !q.lifetime ? `<button class="btn" id="rk-shop"><svg><use href="#i-infinity"/></svg>Prolonger l’illimité</button>` : ''}
    </div>
    <div class="link-row"><button class="link-btn" data-go="leaderboard">Voir le classement</button><button class="link-btn" id="rk-logout">Se déconnecter</button></div>`;
  $('#rk-play')?.addEventListener('click', startRankedSearch);
  $('#rk-ad')?.addEventListener('click', watchAd);
  $('#rk-shop')?.addEventListener('click', openShop);
  $('#rk-logout').onclick = async () => {
    if (!(await confirmBox('Se déconnecter ?', 'Tu pourras te reconnecter avec ton pseudo et ton mot de passe.', 'Déconnexion'))) return;
    api('/api/logout', { method: 'POST' }).catch(() => {});
    setSession(null);
    net.send({ t: 'auth', auth: null });
    renderAccount();
  };
}

// Met à jour le compte à rebours de minuit pendant que l'écran est affiché
setInterval(() => {
  if (current === 'online' && account.profile && $('#o-wait').hidden) {
    if (Date.now() >= account.profile.quota.resetAt) loadAccount();
    else renderAccount();
  }
}, 30000);

async function startRankedSearch() {
  if (!account.loggedIn) return toast('Connecte-toi pour jouer en classé.');
  let p = account.profile;
  try {
    p = await refreshProfile();
  } catch (e) {
    return toast(e.message);
  }
  const q = p.quota;
  if (!q.canPlay) {
    renderAccount();
    return toast('Plus de partie classée aujourd’hui.');
  }
  if (!q.premium && q.freeLeft === 0) {
    const ok = await confirmBox('Utiliser un bonus ?', `Tes ${q.free} parties du jour sont jouées. 1 bonus sera utilisé au lancement de la partie (il t’en reste ${q.bonus}).`, 'Utiliser');
    if (!ok) return;
  }
  showWaiting('Recherche d’un adversaire classé…');
  net.send({ t: 'ranked', auth: account.token });
}

// ----- Publicité récompensée (mode test : écran simulé, durée vérifiée par le serveur)
async function watchAd() {
  let ad;
  try {
    ad = await api('/api/ads/start', { method: 'POST' });
  } catch (e) {
    return toast(e.message);
  }
  const box = $('#ad');
  const total = ad.seconds * 1000;
  const start = Date.now();
  let done = false;
  box.hidden = false;
  $('#ad-claim').hidden = true;
  $('#ad-hint').textContent = 'Regarde la publicité jusqu’au bout pour gagner 1 bonus.';
  const tick = () => {
    const el = Date.now() - start;
    $('#ad-bar').style.width = Math.min(100, (100 * el) / total) + '%';
    $('#ad-count').textContent = done ? '' : Math.max(0, Math.ceil((total - el) / 1000));
    if (!done && el >= total) {
      done = true;
      clearInterval(timer);
      $('#ad-claim').hidden = false;
      $('#ad-hint').textContent = 'Merci ! Ton bonus est prêt.';
      play('notify');
    }
  };
  const timer = setInterval(tick, 200);
  tick();
  const close = () => {
    clearInterval(timer);
    box.hidden = true;
  };
  $('#ad-close').onclick = async () => {
    if (!done && !(await confirmBox('Quitter la publicité ?', 'Tu ne recevras pas de bonus.', 'Quitter'))) return;
    close();
  };
  $('#ad-claim').onclick = async () => {
    $('#ad-claim').disabled = true;
    try {
      const res = await api('/api/ads/complete', { method: 'POST', body: { adId: ad.adId } });
      if (account.profile) account.profile.quota = res.quota;
      play('win');
      toast(`+1 bonus ! Tu en as ${res.quota.bonus}.`);
      close();
      renderAccount();
    } catch (e) {
      toast(e.message);
    }
    $('#ad-claim').disabled = false;
  };
}

// ----- Boutique
async function openShop() {
  let shop;
  try {
    shop = await api('/api/shop');
  } catch (e) {
    return toast(e.message);
  }
  const info = {
    week: ['7 jours de parties classées illimitées', ''],
    month: ['30 jours de parties classées illimitées', '<span class="tag">Populaire</span>'],
    life: ['Pour toujours, une seule fois', '<span class="tag">Meilleure offre</span>'],
  };
  $('#shop-plans').innerHTML = shop.plans
    .map((pl) => `<button class="plan ${pl.id === 'life' ? 'best' : ''}" data-plan="${pl.id}">
        <span><b>${esc(pl.label)}${info[pl.id]?.[1] || ''}</b><small>${info[pl.id]?.[0] || ''}</small></span>
        <span class="price">${euros(pl.price)}</span></button>`)
    .join('');
  $('#shop-note').hidden = shop.mode !== 'test';
  $('#shop').hidden = false;
  $$('#shop-plans .plan').forEach(
    (b) =>
      (b.onclick = async () => {
        const pl = shop.plans.find((x) => x.id === b.dataset.plan);
        const ok = await confirmBox(`Acheter « ${pl.label} » ?`, shop.mode === 'test' ? 'Mode test : aucun paiement réel ne sera effectué.' : '', `Payer ${euros(pl.price)}`);
        if (!ok) return;
        try {
          const res = await api('/api/shop/buy', { method: 'POST', body: { plan: pl.id } });
          if (account.profile) account.profile.quota = res.quota;
          $('#shop').hidden = true;
          play('win');
          toast(pl.id === 'life' ? 'Parties illimitées à vie activées !' : 'Parties illimitées activées !');
          renderAccount();
        } catch (e) {
          toast(e.message);
        }
      })
  );
}
$('#shop').addEventListener('click', (e) => e.target.id === 'shop' && ($('#shop').hidden = true));

// ----- Classement
async function renderLeaderboard() {
  const list = $('#lb-list');
  list.innerHTML = '<p class="muted center">Chargement…</p>';
  $('#lb-me').innerHTML = '';
  let lb;
  try {
    lb = await api('/api/leaderboard');
  } catch (e) {
    list.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    return;
  }
  $('#lb-count').textContent = `${lb.total} joueur${lb.total > 1 ? 's' : ''} classé${lb.total > 1 ? 's' : ''}`;
  const me = lb.me;
  if (!lb.players.length) {
    list.innerHTML = `<div class="empty"><svg><use href="#i-trophy"/></svg><p>Personne n’est encore classé.<br/>Joue la première partie classée !</p></div>`;
    return;
  }
  list.innerHTML = lb.players
    .map((r) => `<div class="lb-row ${me && r.name === me.name ? 'me' : ''}"><span class="lb-rank">${r.rank}</span>
      <span class="lb-name"><b>${esc(r.name)}</b><small>${r.games} partie${r.games > 1 ? 's' : ''} · ${r.wins} victoire${r.wins > 1 ? 's' : ''}</small></span>
      <span class="lb-elo">${r.elo}</span></div>`)
    .join('');
  if (me && !lb.players.some((r) => r.name === me.name)) {
    $('#lb-me').innerHTML = `<div class="lb-row me"><span class="lb-rank">${me.rank ?? '–'}</span>
      <span class="lb-name"><b>${esc(me.name)} (toi)</b><small>${me.rank ? 'Ta position' : 'Joue une partie classée pour être classé'}</small></span>
      <span class="lb-elo">${me.elo}</span></div>`;
  }
}

// Bouton retour Android : renvoie false quand il faut fermer l'appli
window.turnitBack = () => {
  if (!$('#confirm').hidden) return $('#confirm-no').click(), true;
  if (!$('#ad').hidden) return $('#ad-close').click(), true;
  if (!$('#shop').hidden) return ($('#shop').hidden = true), true;
  if (current === 'leaderboard') return show('online'), true;
  if (!$('#sheet').hidden) return closeSheet(), true;
  if (!$('#end').hidden) return $('#end-menu').click(), true;
  if (current === 'game') return $('#screen-game [data-action="quit"]').click(), true;
  if (current === 'online' && !$('#o-wait').hidden) return $('#o-cancel').click(), true;
  if (current !== 'home') {
    if (current === 'online') leaveOnlineScreen();
    return show('home'), true;
  }
  return false;
};

// ---------------------------------------------------------------- Démarrage
// Lien d'invitation : ?salon=CODE
const invite = new URLSearchParams(location.search).get('salon');
if (invite) {
  openOnline();
  $('#o-code').value = invite.toUpperCase().slice(0, 4);
  showWaiting('Connexion au salon…');
  net.send({ t: 'join', code: invite });
} else if (session('turnit.token')) {
  // Après un rechargement : si une partie en ligne était en cours, le serveur nous la renverra
  net.connect(data.name || 'Joueur');
}
// Précalcul de la rareté du Griddex pendant que le joueur navigue
setTimeout(rarityTable, 1500);
