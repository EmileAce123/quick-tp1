# Quick TP1 Bot

Bot de trading Binance Futures qui capture le premier Take Profit (TP1) des signaux crypto, avec trailing stop intelligent.

## Strategie

1. Ecoute les signaux des groupes Telegram CryptoMau
2. Entre en MARKET des qu'un signal est detecte (3% du wallet)
3. Place un TP au premier target + trailing stop a 0.5%
4. Ferme la position des que TP1 est atteint ou trailing stop declenche

## Installation

```bash
cd quick-tp1-bot
npm install
```

## Configuration

Copier le fichier d'exemple et remplir les variables :

```bash
cp config/.env.example .env
```

Variables a configurer :
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` : Credentials Telegram MTProto
- `NOTIFICATION_BOT_TOKEN` / `NOTIFICATION_CHAT_ID` : Bot Telegram pour les alertes
- `BINANCE_API_KEY` / `BINANCE_API_SECRET` : Cles API Binance Futures
- `TRADING_MODE` : `testnet` ou `live`
- `DASHBOARD_PASSWORD` : Mot de passe du dashboard web

## Lancement

### Direct
```bash
node src/index.js
```

### Avec PM2
```bash
pm2 start ecosystem.config.js
pm2 logs quick-tp1-bot
pm2 monit
```

## Dashboard

Accessible sur `http://localhost:3001` (port configurable dans `.env`).

Fonctionnalites :
- Balance et P&L en temps reel
- Positions ouvertes avec prix actuel
- Historique des trades filtrable
- Statistiques (win rate, ratio gain/perte, etc.)
- Kill switch / Pause / Resume

## Architecture

```
src/
  index.js              - Orchestrateur principal
  telegram-client.js    - Connexion MTProto (GramJS)
  signal-parser.js      - Parser des 2 formats de signaux
  trading-engine.js     - API Binance Futures (REST)
  position-manager.js   - Boucle trailing stop (toutes les 2.5s)
  database.js           - SQLite (better-sqlite3)
  dashboard-server.js   - Express + API REST
  notifier.js           - Alertes via Bot Telegram
  logger.js             - Logs Winston
```

## Securites

- Double verification testnet/live URL
- Maximum 3% du wallet par trade
- Tous les ordres logges
- Retry API Binance (2 tentatives max)
- Arret si balance < 10 USDT
- Kill switch depuis le dashboard
- Positions fermees automatiquement apres 48h
