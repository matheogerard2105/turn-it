# Turn It

Version web de Turn It (d'après `TurnIt/Assets/GameManager.cs`) : on aligne ses pions pendant que la grille pivote.
Elle se joue sur mobile et sur ordinateur, et peut s'installer comme une application (PWA).

## Modes
- **Solo** : contre l'IA, 13 niveaux (du coup au hasard à une recherche minimax sur plusieurs coups).
- **2 joueurs** : à deux sur le même écran.
- **Rapide** : grille 4×4, séries de 3, pivot 1, score non cumulé. À deux ou contre l'IA. Chaque grille finale rejoint le **Griddex**, avec une rareté estimée à partir de 50 000 parties simulées.
- **En ligne** : partie rapide (recherche automatique d'un adversaire) ou salon privé avec un code / un lien d'invitation. Le serveur valide chaque coup. Si tu recharges la page ou perds la connexion, tu as 1 minute pour revenir. Il y a aussi des réactions (emojis) et la revanche.

## Parties classées
- Compte avec pseudo et mot de passe (haché avec scrypt), elo de départ 1200 (K = 40 pendant les 10 premières parties, puis 32, et 20 au-dessus de 2000). L'appariement se fait entre elos proches, avec un écart toléré qui s'élargit pendant l'attente.
- **3 parties classées par jour**, remises à zéro à minuit (heure de Paris, variable `TURNIT_TZ`). Une partie est décomptée au lancement du match. Abandonner ou rester déconnecté plus d'1 minute compte comme une défaite.
- **Bonus** : gagnés en regardant une publicité récompensée (30 s, variable `TURNIT_AD_SECONDS`). Le serveur vérifie la durée. On peut en stocker autant qu'on veut, mais un seul est utilisable par jour, et seulement quand les 3 parties sont jouées.
- **Parties illimitées** : 1 € la semaine, 3 € le mois, 10 € à vie. Les durées s'additionnent si on rachète.
- Les données sont dans `data/turnit.db` (SQLite, variable `TURNIT_DB`). Pense à sauvegarder ce fichier.

### Mode test → vrais paiements et vraies pubs
Pour l'instant, les achats et les publicités sont **simulés** (`TURNIT_PAYMENTS=test`, `TURNIT_ADS=test`). Pour passer en réel :
- **Paiements** : vérifier le paiement côté serveur (webhook Stripe, ou jeton Google Play vérifié avec l'API Google Play Developer), puis appeler `ranked.grantPlan(userId, planId, provider, ref)` dans `server/ranked.js`. Si l'appli est publiée sur le Play Store, Google Play Billing est obligatoire pour ce type d'achat.
- **Pubs** : intégrer les pubs récompensées AdMob dans l'appli Android, et n'accorder le bonus qu'après le callback de récompense serveur (SSV AdMob) qui appelle `ranked.completeAd`.

## Lancer le jeu
```bash
npm install
npm start          # http://localhost:3000  (PORT=xxxx pour changer de port)
npm test
```
Au lancement, le terminal affiche aussi l'adresse **réseau local** (ex. `http://192.168.1.240:3000`).
Ouvre-la sur un téléphone connecté au même Wi-Fi pour jouer en ligne entre deux appareils.

## Jouer en ligne à distance
Héberge le dossier sur n'importe quel service qui fait tourner Node.js avec WebSocket (Render, Railway, Fly.io…) :
commande de build `npm install`, commande de démarrage `npm start`. Le port est lu dans la variable `PORT`.

## Structure
- `public/js/engine.js` : règles (partagées entre le client et le serveur)
- `public/js/ai.js` : IA ; `ai-worker.js` : calculs en arrière-plan
- `public/js/board.js` : plateau animé (chute, rotation, surbrillance)
- `public/js/app.js` : écrans, modes, statistiques, Griddex
- `server/server.js` : serveur HTTP + WebSocket (salons, matchmaking, reconnexion)

---
Développé avec l'assistance de Claude Code (Anthropic) ; conception du jeu et choix techniques par Mathéo Gérard.
