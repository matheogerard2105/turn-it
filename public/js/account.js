// Compte joueur (parties classées) : appels à l'API du serveur.
import { store } from './storage.js';
import { serverBase } from './online.js';

export const account = {
  profile: null,
  get token() {
    return store.data.auth?.token || null;
  },
  get loggedIn() {
    return !!this.token;
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (account.token) headers.authorization = 'Bearer ' + account.token;
  let res;
  try {
    res = await fetch(serverBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('Serveur injoignable. Vérifie ta connexion.'), { offline: true });
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401) setSession(null);
    throw Object.assign(new Error(data.error || 'Erreur du serveur.'), { status: res.status, code: data.code });
  }
  return data;
}

export function setSession(session) {
  store.data.auth = session ? { token: session.token, name: session.profile?.name } : null;
  account.profile = session?.profile || null;
  store.save();
}

export async function refreshProfile() {
  if (!account.loggedIn) return (account.profile = null);
  account.profile = await api('/api/me');
  return account.profile;
}
