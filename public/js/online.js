// Client WebSocket du mode en ligne, avec reconnexion automatique.
import { session, store } from './storage.js';

// Adresse du serveur : réglée dans l'appli Android, sinon celle qui sert la page
export function serverBase() {
  const s = (store.data.server || window.TURNIT_CONFIG?.server || '').trim().replace(/\/+$/, '');
  return s || location.origin;
}

export class Online {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.wanted = false;
    this.retry = 0;
    this.name = 'Joueur';
    this.outbox = [];
  }

  get connected() {
    return this.ws?.readyState === 1 && this.ready;
  }

  connect(name) {
    if (name) this.name = name;
    this.wanted = true;
    if (this.ws && this.ws.readyState <= 1) return;
    let ws;
    try {
      ws = new WebSocket(serverBase().replace(/^http/, 'ws') + '/ws');
    } catch {
      this.handlers.status?.('offline');
      return;
    }
    this.ws = ws;
    this.ready = false;
    this.handlers.status?.('connecting');
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: this.name, token: session('turnit.token'), auth: store.data.auth?.token || null }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        session('turnit.token', msg.token);
        this.ready = true;
        this.retry = 0;
        this.handlers.status?.('online');
        const box = this.outbox;
        this.outbox = [];
        box.forEach((m) => this.send(m));
        return;
      }
      this.handlers.message?.(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.handlers.status?.('offline');
      if (this.wanted) {
        const delay = Math.min(8000, 500 * 2 ** this.retry++);
        setTimeout(() => this.wanted && this.connect(), delay);
      }
    };
    ws.onerror = () => {};
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
    else {
      this.outbox.push(msg);
      this.connect();
    }
  }

  disconnect() {
    this.wanted = false;
    this.outbox = [];
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}
