// Serveur Turn It : sert le jeu (dossier public/) et gère le mode en ligne via WebSocket.
// Le serveur fait autorité : il valide chaque coup avec le même moteur que le client.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGame, applyMove, sanitizeSettings, PRESETS, P1, P2 } from '../public/js/engine.js';
import { openDb, Ranked, UserError, CONFIG as RANKED_CONFIG } from './ranked.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const RECONNECT_GRACE_MS = 60_000;
const DATA_FILE = process.env.TURNIT_DB || path.join(ROOT, '..', 'data', 'turnit.db');
const ranked = new Ranked(openDb(DATA_FILE));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
};

// ---------- API HTTP (comptes, classement, boutique, publicités) ----------
const CORS = {
  'access-control-allow-origin': '*', // l'appli Android charge le jeu depuis sa propre origine
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8192) {
        reject(new UserError('Requête trop volumineuse.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new UserError('JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

// Limite simple contre le forçage des mots de passe : 20 tentatives / 10 min par adresse IP
const authAttempts = new Map();
function throttleAuth(req) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const list = (authAttempts.get(ip) || []).filter((t) => now - t < 600_000);
  list.push(now);
  authAttempts.set(ip, list);
  if (list.length > 20) throw new UserError('Trop de tentatives, réessaie dans quelques minutes.');
}

async function api(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = ranked.userFromToken(token);
  const needUser = () => {
    if (!user) throw Object.assign(new UserError('Connecte-toi pour continuer.'), { status: 401 });
    return user;
  };
  const route = `${req.method} ${pathname}`;
  try {
    switch (route) {
      case 'POST /api/register': {
        throttleAuth(req);
        const b = await readBody(req);
        return json(res, 200, ranked.register(b.name, b.password));
      }
      case 'POST /api/login': {
        throttleAuth(req);
        const b = await readBody(req);
        return json(res, 200, ranked.login(b.name, b.password));
      }
      case 'POST /api/logout':
        ranked.logout(token);
        return json(res, 200, { ok: true });
      case 'GET /api/me':
        return json(res, 200, ranked.profile(needUser().id));
      case 'GET /api/leaderboard':
        return json(res, 200, { ...ranked.leaderboard(100), me: user ? ranked.profile(user.id) : null });
      case 'GET /api/shop':
        return json(res, 200, ranked.shop());
      case 'POST /api/shop/buy': {
        const b = await readBody(req);
        return json(res, 200, { quota: ranked.buy(needUser().id, b.plan) });
      }
      case 'POST /api/ads/start':
        return json(res, 200, ranked.startAd(needUser().id));
      case 'POST /api/ads/complete': {
        const b = await readBody(req);
        return json(res, 200, { quota: ranked.completeAd(needUser().id, b.adId) });
      }
      default:
        return json(res, 404, { error: 'Route inconnue.' });
    }
  } catch (e) {
    if (e instanceof UserError) return json(res, e.status || 400, { error: e.message, code: e.code });
    console.error(e);
    return json(res, 500, { error: 'Erreur du serveur.' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, queue: queue.length, ranked: rankedQueue.length }));
  }
  if (url.pathname.startsWith('/api/')) return void api(req, res, url.pathname);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- État en mémoire ----------
const clients = new Map(); // token -> client { token, name, ws, room, lastSeen }
const rooms = new Map(); // code -> room
let queue = []; // clients en attente de partie rapide (clé : format)
let rankedQueue = []; // { client, userId, elo, since } en attente de partie classée

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function send(client, msg) {
  if (client?.ws && client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function cleanName(n) {
  const s = String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Joueur';
}

function sideOf(room, client) {
  if (room.players[P1] === client) return P1;
  if (room.players[P2] === client) return P2;
  return 0;
}

function roomView(room, client) {
  return {
    code: room.code,
    you: sideOf(room, client),
    names: { [P1]: room.players[P1]?.name ?? null, [P2]: room.players[P2]?.name ?? null },
    online: { [P1]: !!room.players[P1]?.ws, [P2]: !!room.players[P2]?.ws },
    settings: room.settings,
    state: room.state,
    isPrivate: room.isPrivate,
    round: room.round,
    ranked: !!room.ranked,
    elos: room.elos || null,
  };
}

function broadcast(room, msg, except) {
  for (const side of [P1, P2]) {
    const c = room.players[side];
    if (c && c !== except) send(c, msg);
  }
}

function startGame(room) {
  room.round += 1;
  room.rematch = new Set();
  // Le perdant (ou un tirage au sort) commence
  let first = Math.random() < 0.5 ? P1 : P2;
  if (room.state?.over && room.state.winner) first = -room.state.winner;
  room.state = createGame(room.settings, first);
  for (const side of [P1, P2]) send(room.players[side], { t: 'start', ...roomView(room, room.players[side]) });
}

function createRoom(owner, settings, isPrivate) {
  const room = {
    code: newCode(),
    settings: sanitizeSettings(settings),
    players: { [P1]: owner, [P2]: null },
    state: null,
    isPrivate,
    round: 0,
    rematch: new Set(),
    abandonTimer: null,
  };
  rooms.set(room.code, room);
  owner.room = room;
  return room;
}

function leaveQueue(client) {
  queue = queue.filter((q) => q.client !== client);
  rankedQueue = rankedQueue.filter((q) => q.client !== client);
}

// ---------- Parties classées ----------
function attachUser(client, token) {
  const user = ranked.userFromToken(token);
  client.userId = user?.id ?? null;
  if (user) client.name = user.name;
  return user;
}

function activeRankedRoom(userId) {
  for (const room of rooms.values()) {
    if (room.ranked && !room.state?.over && (room.userIds[P1] === userId || room.userIds[P2] === userId)) return room;
  }
  return null;
}

// Apparie les joueurs d'elo proche ; l'écart toléré s'élargit avec l'attente
function matchRanked() {
  rankedQueue = rankedQueue.filter((e) => e.client.ws && e.client.userId === e.userId);
  const now = Date.now();
  for (let i = 0; i < rankedQueue.length; i++) {
    for (let j = i + 1; j < rankedQueue.length; j++) {
      const a = rankedQueue[i];
      const b = rankedQueue[j];
      if (a.userId === b.userId) continue;
      const waited = Math.max(now - a.since, now - b.since) / 1000;
      if (Math.abs(a.elo - b.elo) <= 100 + 25 * waited) {
        rankedQueue = rankedQueue.filter((e) => e !== a && e !== b);
        startRanked(a, b);
        return matchRanked();
      }
    }
  }
}

function startRanked(a, b) {
  // Décompte une partie à chacun ; si l'un n'a plus le droit, on rembourse l'autre et on le remet en file
  let usedA;
  try {
    usedA = ranked.consumeGame(a.userId);
  } catch (err) {
    send(a.client, { t: 'error', msg: err.message, code: err.code });
    rankedQueue.push(b);
    return;
  }
  try {
    ranked.consumeGame(b.userId);
  } catch (err) {
    ranked.refundGame(a.userId, usedA);
    send(b.client, { t: 'error', msg: err.message, code: err.code });
    rankedQueue.push(a);
    return;
  }
  const [first, second] = Math.random() < 0.5 ? [a, b] : [b, a];
  const room = createRoom(first.client, PRESETS.classic, false);
  room.ranked = true;
  room.userIds = { [P1]: first.userId, [P2]: second.userId };
  room.elos = { [P1]: first.elo, [P2]: second.elo };
  room.players[P2] = second.client;
  second.client.room = room;
  startGame(room);
}

function finishRanked(room, winnerSide, forfeit) {
  if (!room.ranked || room.recorded) return;
  room.recorded = true;
  const res = ranked.recordMatch(room.userIds[P1], room.userIds[P2], winnerSide, room.state?.scores, forfeit);
  for (const side of [P1, P2]) {
    send(room.players[side], { t: 'ranked-result', result: res[side], profile: ranked.profile(room.userIds[side]) });
  }
}

function closeRoom(room, reason) {
  clearTimeout(room.abandonTimer);
  rooms.delete(room.code);
  for (const side of [P1, P2]) {
    const c = room.players[side];
    if (c && c.room === room) c.room = null;
  }
  if (reason) broadcast(room, { t: 'closed', reason });
}

function leaveRoom(client, reason = 'left') {
  const room = client.room;
  if (!room) return;
  client.room = null;
  const side = sideOf(room, client);
  const other = room.players[-side];
  if (room.state && !room.state.over && room.ranked) {
    // Abandon d'une partie classée : défaite pour celui qui part, même si l'adversaire est déconnecté
    room.state = { ...room.state, over: true, winner: -side, forfeit: side };
    if (other) send(other, { t: 'forfeit', state: room.state, reason });
    finishRanked(room, -side, true);
  } else if (other && room.state && !room.state.over) {
    // Abandon en cours de partie : l'adversaire gagne
    room.state = { ...room.state, over: true, winner: -side, forfeit: side };
    send(other, { t: 'forfeit', state: room.state, reason });
  } else if (other) {
    send(other, { t: 'opp-left' });
  }
  closeRoom(room);
}

function handle(client, msg) {
  switch (msg.t) {
    case 'name':
      if (!client.userId) client.name = cleanName(msg.name);
      break;

    case 'auth':
      attachUser(client, msg.auth);
      send(client, { t: 'authed', user: client.userId ? client.name : null });
      break;

    case 'ranked': {
      if (!client.userId || !ranked.userFromToken(msg.auth || '')) {
        if (msg.auth) attachUser(client, msg.auth);
        if (!client.userId) return send(client, { t: 'error', msg: 'Connecte-toi pour jouer en classé.', code: 'auth' });
      }
      if (activeRankedRoom(client.userId)) return send(client, { t: 'error', msg: 'Tu as déjà une partie classée en cours.' });
      const quota = ranked.quota(client.userId);
      if (!quota.canPlay) return send(client, { t: 'error', msg: 'Plus de partie classée disponible aujourd’hui.', code: 'quota' });
      if (client.room) leaveRoom(client);
      leaveQueue(client);
      // Un même compte ne peut attendre qu'une fois (ex. deux onglets)
      rankedQueue = rankedQueue.filter((e) => e.userId !== client.userId);
      const me = ranked.profile(client.userId);
      rankedQueue.push({ client, userId: client.userId, elo: me.elo, since: Date.now() });
      send(client, { t: 'queued', format: 'ranked', ranked: true });
      matchRanked();
      break;
    }

    case 'quick': {
      if (client.room) leaveRoom(client);
      leaveQueue(client);
      const format = msg.format === 'rapide' ? 'rapide' : 'classic';
      const match = queue.find((q) => q.format === format && q.client !== client && q.client.ws);
      if (match) {
        leaveQueue(match.client);
        const room = createRoom(match.client, PRESETS[format], false);
        room.players[P2] = client;
        client.room = room;
        startGame(room);
      } else {
        queue.push({ client, format });
        send(client, { t: 'queued', format });
      }
      break;
    }

    case 'create': {
      if (client.room) leaveRoom(client);
      leaveQueue(client);
      const room = createRoom(client, msg.settings, true);
      send(client, { t: 'room', ...roomView(room, client) });
      break;
    }

    case 'join': {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const room = rooms.get(code);
      if (!room) return send(client, { t: 'error', msg: 'Salon introuvable. Vérifie le code.' });
      if (room.players[P1] === client || room.players[P2] === client) {
        return send(client, { t: room.state ? 'start' : 'room', ...roomView(room, client) });
      }
      if (room.players[P2]) return send(client, { t: 'error', msg: 'Ce salon est déjà complet.' });
      if (client.room) leaveRoom(client);
      leaveQueue(client);
      room.players[P2] = client;
      client.room = room;
      startGame(room);
      break;
    }

    case 'cancel':
      leaveQueue(client);
      if (client.room) leaveRoom(client);
      send(client, { t: 'idle' });
      break;

    case 'move': {
      const room = client.room;
      if (!room?.state) return;
      const side = sideOf(room, client);
      if (room.state.over || room.state.player !== side) return send(client, { t: 'sync', state: room.state });
      const next = applyMove(room.state, msg.col);
      if (!next) return send(client, { t: 'sync', state: room.state });
      room.state = next;
      broadcast(room, { t: 'move', col: msg.col, by: side, state: next });
      if (next.over) finishRanked(room, next.winner, false);
      break;
    }

    case 'rematch': {
      const room = client.room;
      if (!room?.state?.over) return;
      if (room.ranked) return send(client, { t: 'error', msg: 'Pas de revanche en classé : relance une partie classée.' });
      room.rematch.add(sideOf(room, client));
      if (!room.players[P1] || !room.players[P2]) return send(client, { t: 'opp-left' });
      if (room.rematch.size === 2) startGame(room);
      else broadcast(room, { t: 'rematch-req', by: sideOf(room, client) }, client);
      break;
    }

    case 'emote': {
      const room = client.room;
      const e = String(msg.e || '').slice(0, 8);
      if (room && e) broadcast(room, { t: 'emote', by: sideOf(room, client), e }, client);
      break;
    }

    case 'ping':
      send(client, { t: 'pong' });
      break;
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  let client = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (!client) {
      if (msg.t !== 'hello') return;
      // Reprise de session si le jeton est connu (rechargement de page, coupure réseau…)
      const known = typeof msg.token === 'string' && clients.get(msg.token);
      if (known) {
        client = known;
        if (client.ws && client.ws !== ws) client.ws.terminate();
      } else {
        client = { token: crypto.randomUUID(), name: 'Joueur', ws: null, room: null };
        clients.set(client.token, client);
      }
      client.ws = ws;
      client.name = cleanName(msg.name ?? client.name);
      if (msg.auth) attachUser(client, msg.auth);
      send(client, { t: 'welcome', token: client.token });
      const room = client.room;
      if (room) {
        clearTimeout(room.abandonTimer);
        send(client, { t: room.state ? 'resume' : 'room', ...roomView(room, client) });
        broadcast(room, { t: 'opp-status', online: true }, client);
      }
      return;
    }
    handle(client, msg);
  });

  ws.on('close', () => {
    if (!client || client.ws !== ws) return;
    client.ws = null;
    client.lastSeen = Date.now();
    leaveQueue(client);
    const room = client.room;
    if (!room) return;
    broadcast(room, { t: 'opp-status', online: false, grace: RECONNECT_GRACE_MS }, client);
    clearTimeout(room.abandonTimer);
    room.abandonTimer = setTimeout(() => {
      if (!client.ws && client.room === room) leaveRoom(client, 'timeout');
    }, RECONNECT_GRACE_MS);
  });
});

setInterval(matchRanked, 1000).unref();

// Détection des connexions mortes + ménage des sessions oubliées
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [token, c] of clients) {
    if (!c.ws && !c.room && now - (c.lastSeen || 0) > 10 * 60_000) clients.delete(token);
  }
}, 20_000).unref();

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`\n  Turn It est lancé !\n\n  Sur cet ordinateur : http://localhost:${PORT}`);
  for (const u of lan) console.log(`  Sur le réseau local : ${u}`);
  console.log('');
});
