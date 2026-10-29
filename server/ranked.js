// Mode classé : comptes, elo, quota de parties quotidien, bonus (publicités) et parties illimitées (boutique).
// Les données sont stockées dans data/turnit.db (SQLite intégré à Node).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG = {
  timeZone: process.env.TURNIT_TZ || 'Europe/Paris', // la journée se termine à minuit, heure de Paris
  freeGamesPerDay: 3,
  startElo: 1200,
  adSeconds: Number(process.env.TURNIT_AD_SECONDS) || 30, // durée d'une publicité récompensée
  // 'test' = achats et publicités simulés. À remplacer par un vrai fournisseur (voir README).
  payments: process.env.TURNIT_PAYMENTS || 'test',
  ads: process.env.TURNIT_ADS || 'test',
};

const LIFETIME = 253402300799000; // an 9999
export const PLANS = {
  week: { label: '1 semaine', price: 100, days: 7 },
  month: { label: '1 mois', price: 300, days: 30 },
  life: { label: 'À vie', price: 1000, days: null },
};

// ---------------------------------------------------------------- Base de données
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL,
      elo INTEGER NOT NULL,
      peak INTEGER NOT NULL,
      games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      bonus INTEGER NOT NULL DEFAULT 0,
      premium_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_elo ON users(elo DESC);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS daily (
      user_id INTEGER NOT NULL, day TEXT NOT NULL,
      played INTEGER NOT NULL DEFAULT 0, bonus_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY, p1 INTEGER NOT NULL, p2 INTEGER NOT NULL, winner INTEGER,
      score1 INTEGER, score2 INTEGER, delta1 INTEGER, delta2 INTEGER, forfeit INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL,
      provider TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER
    );
  `);
  return db;
}

// ---------------------------------------------------------------- Dates (minuit, fuseau de Paris)
export function dayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone }).format(new Date(now));
}

function tzOffsetMs(at) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName').value; // "GMT+02:00"
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
}

// Instant (ms) du prochain minuit dans le fuseau configuré
export function nextReset(now = Date.now()) {
  const [y, mo, d] = dayKey(now).split('-').map(Number);
  const utcMidnight = Date.UTC(y, mo - 1, d + 1);
  let t = utcMidnight - tzOffsetMs(utcMidnight);
  t = utcMidnight - tzOffsetMs(t); // corrige un éventuel changement d'heure
  return t;
}

// ---------------------------------------------------------------- Elo
export function eloDelta(ra, rb, scoreA, gamesA) {
  const k = gamesA < 10 ? 40 : ra >= 2000 ? 20 : 32;
  const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
  return Math.round(k * (scoreA - expected));
}

// ---------------------------------------------------------------- Service
export class Ranked {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
    const q = (sql) => db.prepare(sql);
    this.q = {
      userByName: q('SELECT * FROM users WHERE name = ?'),
      userById: q('SELECT * FROM users WHERE id = ?'),
      insertUser: q('INSERT INTO users (name, pass, elo, peak, created_at) VALUES (?, ?, ?, ?, ?)'),
      session: q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
      insertSession: q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
      deleteSession: q('DELETE FROM sessions WHERE token = ?'),
      daily: q('SELECT played, bonus_used FROM daily WHERE user_id = ? AND day = ?'),
      upsertDaily: q(`INSERT INTO daily (user_id, day, played, bonus_used) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, day) DO UPDATE SET played = excluded.played, bonus_used = excluded.bonus_used`),
      setBonus: q('UPDATE users SET bonus = ? WHERE id = ?'),
      setPremium: q('UPDATE users SET premium_until = ? WHERE id = ?'),
      rankOf: q('SELECT COUNT(*) + 1 AS r FROM users WHERE games > 0 AND elo > ?'),
      rankedCount: q('SELECT COUNT(*) AS n FROM users WHERE games > 0'),
      top: q('SELECT name, elo, games, wins FROM users WHERE games > 0 ORDER BY elo DESC, wins DESC, id ASC LIMIT ?'),
      applyResult: q(`UPDATE users SET elo = ?, peak = MAX(peak, ?), games = games + 1,
        wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?`),
      insertMatch: q(`INSERT INTO matches (p1, p2, winner, score1, score2, delta1, delta2, forfeit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertPurchase: q('INSERT INTO purchases (user_id, plan, amount, provider, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      insertAd: q('INSERT INTO ads (id, user_id, started_at) VALUES (?, ?, ?)'),
      ad: q('SELECT * FROM ads WHERE id = ? AND user_id = ?'),
      completeAd: q('UPDATE ads SET completed_at = ? WHERE id = ? AND completed_at IS NULL'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ----- Comptes
  register(name, password) {
    name = String(name ?? '').trim();
    password = String(password ?? '');
    if (!/^[\p{L}\p{N}_ .-]{3,16}$/u.test(name)) throw new UserError('Le pseudo doit faire 3 à 16 caractères (lettres, chiffres, espace, _ . -).');
    if (password.length < 6) throw new UserError('Le mot de passe doit faire au moins 6 caractères.');
    if (this.q.userByName.get(name)) throw new UserError('Ce pseudo est déjà pris.');
    const r = this.q.insertUser.run(name, hashPassword(password), CONFIG.startElo, CONFIG.startElo, this.now());
    return this.createSession(Number(r.lastInsertRowid));
  }

  login(name, password) {
    const u = this.q.userByName.get(String(name ?? '').trim());
    if (!u || !verifyPassword(String(password ?? ''), u.pass)) throw new UserError('Pseudo ou mot de passe incorrect.');
    return this.createSession(u.id);
  }

  createSession(userId) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.q.insertSession.run(token, userId, this.now());
    return { token, profile: this.profile(userId) };
  }

  logout(token) {
    this.q.deleteSession.run(String(token));
  }

  userFromToken(token) {
    if (typeof token !== 'string' || !token) return null;
    return this.q.session.get(token) || null;
  }

  // ----- Quota quotidien
  quota(userId) {
    const u = this.q.userById.get(userId);
    const now = this.now();
    const d = this.q.daily.get(userId, dayKey(now)) || { played: 0, bonus_used: 0 };
    const premium = u.premium_until > now;
    const freeLeft = Math.max(0, CONFIG.freeGamesPerDay - d.played);
    const canUseBonus = !premium && freeLeft === 0 && !d.bonus_used && u.bonus > 0;
    return {
      free: CONFIG.freeGamesPerDay,
      played: d.played,
      freeLeft,
      bonus: u.bonus,
      bonusUsedToday: !!d.bonus_used,
      canUseBonus,
      premium,
      premiumUntil: premium ? u.premium_until : null,
      lifetime: u.premium_until >= LIFETIME,
      canPlay: premium || freeLeft > 0 || canUseBonus,
      resetAt: nextReset(now),
    };
  }

  // Décompte une partie au lancement d'un match classé. Renvoie ce qui a été utilisé.
  consumeGame(userId) {
    return this.tx(() => {
      const q = this.quota(userId);
      const day = dayKey(this.now());
      if (q.premium) {
        this.q.upsertDaily.run(userId, day, q.played + 1, q.bonusUsedToday ? 1 : 0);
        return 'premium';
      }
      if (q.freeLeft > 0) {
        this.q.upsertDaily.run(userId, day, q.played + 1, q.bonusUsedToday ? 1 : 0);
        return 'free';
      }
      if (q.canUseBonus) {
        this.q.upsertDaily.run(userId, day, q.played + 1, 1);
        this.q.setBonus.run(q.bonus - 1, userId);
        return 'bonus';
      }
      throw new UserError('Plus de partie classée disponible aujourd’hui.', 'quota');
    });
  }

  // Rend la partie si le match n'a finalement pas eu lieu
  refundGame(userId, kind) {
    this.tx(() => {
      const q = this.quota(userId);
      const day = dayKey(this.now());
      if (kind === 'bonus') {
        this.q.upsertDaily.run(userId, day, Math.max(0, q.played - 1), 0);
        this.q.setBonus.run(q.bonus + 1, userId);
      } else {
        this.q.upsertDaily.run(userId, day, Math.max(0, q.played - 1), q.bonusUsedToday ? 1 : 0);
      }
    });
  }

  // ----- Résultat d'un match classé
  recordMatch(p1Id, p2Id, winnerSide, scores, forfeit = false) {
    return this.tx(() => {
      const a = this.q.userById.get(p1Id);
      const b = this.q.userById.get(p2Id);
      const sa = winnerSide === 1 ? 1 : winnerSide === -1 ? 0 : 0.5;
      const da = eloDelta(a.elo, b.elo, sa, a.games);
      const db = eloDelta(b.elo, a.elo, 1 - sa, b.games);
      const ea = Math.max(100, a.elo + da);
      const eb = Math.max(100, b.elo + db);
      this.q.applyResult.run(ea, ea, sa === 1 ? 1 : 0, sa === 0 ? 1 : 0, sa === 0.5 ? 1 : 0, a.id);
      this.q.applyResult.run(eb, eb, sa === 0 ? 1 : 0, sa === 1 ? 1 : 0, sa === 0.5 ? 1 : 0, b.id);
      const winner = sa === 1 ? a.id : sa === 0 ? b.id : null;
      this.q.insertMatch.run(a.id, b.id, winner, scores?.[1] ?? null, scores?.[-1] ?? null, ea - a.elo, eb - b.elo, forfeit ? 1 : 0, this.now());
      return { [1]: { before: a.elo, after: ea, delta: ea - a.elo }, [-1]: { before: b.elo, after: eb, delta: eb - b.elo } };
    });
  }

  // ----- Profil et classement
  profile(userId) {
    const u = this.q.userById.get(userId);
    return {
      name: u.name,
      elo: u.elo,
      peak: u.peak,
      games: u.games,
      wins: u.wins,
      losses: u.losses,
      draws: u.draws,
      rank: u.games > 0 ? this.q.rankOf.get(u.elo).r : null,
      quota: this.quota(userId),
    };
  }

  leaderboard(limit = 100) {
    const rows = this.q.top.all(Math.min(200, Math.max(1, limit | 0)));
    let rank = 0;
    let prev = null;
    return {
      total: this.q.rankedCount.get().n,
      players: rows.map((r, i) => {
        if (r.elo !== prev) rank = i + 1;
        prev = r.elo;
        return { rank, name: r.name, elo: r.elo, games: r.games, wins: r.wins };
      }),
    };
  }

  // ----- Boutique (parties illimitées)
  shop() {
    return {
      mode: CONFIG.payments,
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, price: p.price, days: p.days })),
    };
  }

  // Accorde un forfait. `provider`/`ref` identifient le paiement (ex. session Stripe, jeton Google Play).
  grantPlan(userId, planId, provider, ref = null) {
    const plan = PLANS[planId];
    if (!plan) throw new UserError('Offre inconnue.');
    return this.tx(() => {
      const u = this.q.userById.get(userId);
      const now = this.now();
      let until;
      if (plan.days === null) until = LIFETIME;
      else if (u.premium_until >= LIFETIME) until = LIFETIME;
      else until = Math.max(now, u.premium_until) + plan.days * 86400000;
      this.q.setPremium.run(until, userId);
      this.q.insertPurchase.run(userId, planId, plan.price, provider, ref, now);
      return this.quota(userId);
    });
  }

  buy(userId, planId) {
    if (CONFIG.payments !== 'test') throw new UserError('Paiement réel pas encore configuré sur ce serveur.');
    return this.grantPlan(userId, planId, 'test');
  }

  // ----- Publicités récompensées
  startAd(userId) {
    const id = crypto.randomBytes(12).toString('base64url');
    this.q.insertAd.run(id, userId, this.now());
    return { adId: id, seconds: CONFIG.adSeconds, mode: CONFIG.ads };
  }

  // Le bonus n'est accordé que si la pub a réellement duré le temps prévu (vérifié côté serveur)
  completeAd(userId, adId) {
    return this.tx(() => {
      const ad = this.q.ad.get(String(adId), userId);
      if (!ad) throw new UserError('Publicité inconnue.');
      if (ad.completed_at) throw new UserError('Bonus déjà récupéré.');
      if (this.now() - ad.started_at < (CONFIG.adSeconds - 1) * 1000) throw new UserError('La publicité n’est pas terminée.');
      this.q.completeAd.run(this.now(), ad.id);
      const u = this.q.userById.get(userId);
      this.q.setBonus.run(u.bonus + 1, userId);
      return this.quota(userId);
    });
  }
}

export class UserError extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}
