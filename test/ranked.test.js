import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, Ranked, eloDelta, nextReset, dayKey, CONFIG } from '../server/ranked.js';

function setup(start = Date.UTC(2026, 8, 28, 10)) {
  let now = start;
  const r = new Ranked(openDb(':memory:'), () => now);
  return { r, tick: (ms) => (now += ms), at: (t) => (now = t), get now() { return now; } };
}

test('comptes : inscription, connexion, erreurs', () => {
  const { r } = setup();
  const { token, profile } = r.register('Matheo', 'secret1');
  assert.equal(profile.elo, 1200);
  assert.equal(r.userFromToken(token).name, 'Matheo');
  assert.throws(() => r.register('matheo', 'secret1'), /déjà pris/);
  assert.throws(() => r.login('Matheo', 'mauvais'), /incorrect/);
  assert.ok(r.login('MATHEO', 'secret1').token);
  assert.throws(() => r.register('ab', 'secret1'), /3 à 16/);
});

test('3 parties par jour, puis 1 bonus max, remise à zéro à minuit (Paris)', () => {
  const env = setup();
  const { r } = env;
  const id = r.userFromToken(r.register('Alex', 'secret1').token).id;
  for (let i = 0; i < 3; i++) assert.equal(r.consumeGame(id), 'free');
  assert.equal(r.quota(id).canPlay, false);
  assert.throws(() => r.consumeGame(id), /Plus de partie/);

  // 2 pubs => 2 bonus, mais un seul utilisable dans la journée
  for (let k = 0; k < 2; k++) {
    const ad = r.startAd(id);
    assert.throws(() => r.completeAd(id, ad.adId), /pas terminée/);
    env.tick(CONFIG.adSeconds * 1000);
    r.completeAd(id, ad.adId);
    assert.throws(() => r.completeAd(id, ad.adId), /déjà/);
  }
  assert.equal(r.quota(id).bonus, 2);
  assert.equal(r.consumeGame(id), 'bonus');
  assert.equal(r.quota(id).bonus, 1);
  assert.equal(r.quota(id).canPlay, false);

  // 10 h UTC le 28/09 -> minuit à Paris (UTC+2) = 22 h UTC
  assert.equal(nextReset(env.now), Date.UTC(2026, 8, 28, 22));
  env.at(Date.UTC(2026, 8, 28, 21, 59));
  assert.equal(r.quota(id).canPlay, false);
  env.at(Date.UTC(2026, 8, 28, 22, 0, 1));
  assert.equal(dayKey(env.now), '2026-09-29');
  assert.equal(r.quota(id).freeLeft, 3);
  // le bonus ne sert que quand les parties gratuites sont épuisées
  assert.equal(r.consumeGame(id), 'free');
});

test('forfaits illimités : semaine cumulable, à vie', () => {
  const env = setup();
  const { r } = env;
  const id = r.userFromToken(r.register('Bea', 'secret1').token).id;
  r.buy(id, 'week');
  r.buy(id, 'week');
  const q = r.quota(id);
  assert.equal(q.premiumUntil, env.now + 14 * 86400000);
  for (let i = 0; i < 10; i++) assert.equal(r.consumeGame(id), 'premium');
  env.tick(15 * 86400000);
  assert.equal(r.quota(id).premium, false);
  r.buy(id, 'life');
  env.tick(10 * 365 * 86400000);
  assert.equal(r.quota(id).lifetime, true);
  assert.equal(r.quota(id).canPlay, true);
});

test('elo : gain/perte symétriques, classement', () => {
  assert.equal(eloDelta(1200, 1200, 1, 20), 16);
  assert.equal(eloDelta(1200, 1200, 0, 20), -16);
  assert.ok(eloDelta(1000, 1400, 1, 20) > 25);
  const { r } = setup();
  const a = r.userFromToken(r.register('Ana', 'secret1').token).id;
  const b = r.userFromToken(r.register('Bob', 'secret1').token).id;
  const res = r.recordMatch(a, b, 1, { 1: 10, [-1]: 4 });
  assert.equal(res[1].delta, 20);
  assert.equal(res[-1].delta, -20);
  const lb = r.leaderboard();
  assert.deepEqual(lb.players.map((p) => [p.rank, p.name, p.elo]), [[1, 'Ana', 1220], [2, 'Bob', 1180]]);
  assert.equal(r.profile(b).rank, 2);
});
