const express = require('express');
const path = require('path');
const logger = require('./logger');
const config = require('../config/config');

class DashboardServer {
  constructor(db, tradingEngine, positionManager) {
    this.db = db;
    this.engine = tradingEngine;
    this.positionManager = positionManager;
    this.app = express();
    this.paused = false;

    this._setupMiddleware();
    this._setupRoutes();
  }

  _setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '..', 'public')));

    // Simple auth middleware for API routes
    this.app.use('/api', (req, res, next) => {
      const password = req.headers['x-password'] || req.query.password;
      if (password !== config.dashboard.password) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    });
  }

  _setupRoutes() {
    // ---- Dashboard data ----

    this.app.get('/api/status', async (req, res) => {
      try {
        let balance = { balance: 0, availableBalance: 0, unrealizedPnl: 0 };
        try {
          balance = await this.engine.getAccountBalance();
          this.db.insertBalanceSnapshot(balance.balance, balance.availableBalance, balance.unrealizedPnl);
        } catch (err) {
          // Use cached balance
          const cached = this.db.getLatestBalance();
          if (cached) {
            balance = {
              balance: cached.balance,
              availableBalance: cached.available_balance,
              unrealizedPnl: cached.unrealized_pnl,
            };
          }
        }

        const todayPnl = this.db.getTodayPnl();
        const todayTrades = this.db.getTodayTradeCount();
        const stats = this.db.getTradeStats();
        const openTrades = this.db.getOpenTrades();

        const firstBalance = this.db.getFirstBalanceOfDay();
        const dayPnlPercent = firstBalance
          ? ((balance.balance - firstBalance.balance) / firstBalance.balance * 100)
          : 0;

        const winRate = stats.total_trades > 0
          ? ((stats.wins / stats.total_trades) * 100).toFixed(1)
          : 0;

        res.json({
          balance: balance.balance,
          availableBalance: balance.availableBalance,
          unrealizedPnl: balance.unrealizedPnl,
          todayPnl,
          todayPnlPercent: dayPnlPercent,
          todayTrades,
          totalPnl: stats.total_pnl || 0,
          winRate: parseFloat(winRate),
          openPositions: openTrades.length,
          mode: config.binance.mode.toUpperCase(),
          paused: this.paused,
        });
      } catch (err) {
        logger.error(`Dashboard status error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/positions', async (req, res) => {
      try {
        const openTrades = this.db.getOpenTrades();
        const positions = [];

        for (const trade of openTrades) {
          let currentPrice = trade.entry_price;
          try {
            currentPrice = await this.engine.getCurrentPrice(trade.pair);
          } catch (_) {}

          const isLong = trade.direction === 'LONG';
          const priceDiff = isLong
            ? currentPrice - trade.entry_price
            : trade.entry_price - currentPrice;
          const pnlUsdt = priceDiff * trade.quantity;
          const pnlPercent = (priceDiff / trade.entry_price) * 100 * trade.leverage;

          const distToTp1 = isLong
            ? ((trade.tp1_price - currentPrice) / currentPrice * 100).toFixed(2)
            : ((currentPrice - trade.tp1_price) / currentPrice * 100).toFixed(2);

          const openedAt = new Date(trade.opened_at + 'Z');
          const ageMs = Date.now() - openedAt.getTime();

          positions.push({
            id: trade.id,
            pair: trade.pair,
            direction: trade.direction,
            leverage: trade.leverage,
            entryPrice: trade.entry_price,
            currentPrice,
            pnlUsdt,
            pnlPercent,
            bestPrice: trade.best_price,
            tp1Price: trade.tp1_price,
            distanceToTp1: distToTp1,
            trailingActive: !!trade.trailing_active,
            openedAt: trade.opened_at,
            ageMs,
          });
        }

        res.json(positions);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/trades', (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const period = req.query.period || 'all';

        let startDate = null;
        const now = new Date();

        switch (period) {
          case 'today':
            startDate = now.toISOString().split('T')[0];
            break;
          case '7d':
            startDate = new Date(now - 7 * 86400000).toISOString();
            break;
          case '30d':
            startDate = new Date(now - 30 * 86400000).toISOString();
            break;
          default:
            break;
        }

        let trades;
        if (startDate) {
          trades = this.db.getTradesByDateRange(startDate, now.toISOString());
        } else {
          trades = this.db.getRecentTrades(limit);
        }

        res.json(trades);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/stats', (req, res) => {
      try {
        const stats = this.db.getTradeStats();
        const winRate = stats.total_trades > 0
          ? ((stats.wins / stats.total_trades) * 100).toFixed(1)
          : 0;

        res.json({
          totalTrades: stats.total_trades,
          wins: stats.wins || 0,
          losses: stats.losses || 0,
          winRate: parseFloat(winRate),
          totalPnl: stats.total_pnl || 0,
          avgWin: stats.avg_win || 0,
          avgLoss: stats.avg_loss || 0,
          gainLossRatio: stats.avg_win && stats.avg_loss
            ? Math.abs(stats.avg_win / stats.avg_loss).toFixed(2)
            : 0,
          bestTrade: stats.best_trade || 0,
          worstTrade: stats.worst_trade || 0,
          avgTp1TimeSeconds: stats.avg_tp1_time_seconds || 0,
          tp1Hits: stats.tp1_hits || 0,
          trailingStops: stats.trailing_stops || 0,
          slHits: stats.sl_hits || 0,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ---- Controls ----

    this.app.post('/api/kill', async (req, res) => {
      try {
        this.paused = true;
        await this.positionManager.closeAllPositions();
        res.json({ success: true, message: 'Kill switch activated. All positions closed.' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/pause', (req, res) => {
      this.paused = true;
      logger.warn('Bot PAUSED - no new positions will be opened');
      res.json({ success: true, paused: true });
    });

    this.app.post('/api/resume', (req, res) => {
      this.paused = false;
      logger.info('Bot RESUMED - new positions can be opened');
      res.json({ success: true, paused: false });
    });

    this.app.post('/api/close/:id', async (req, res) => {
      try {
        const tradeId = parseInt(req.params.id);
        const trade = this.db.getTradeById(tradeId);
        if (!trade || trade.status !== 'open') {
          return res.status(404).json({ error: 'Trade not found or already closed' });
        }

        const currentPrice = await this.engine.getCurrentPrice(trade.pair);
        await this.engine.cancelAllOrders(trade.pair);
        await this.engine.closePosition(trade.pair);

        const isLong = trade.direction === 'LONG';
        const priceDiff = isLong
          ? currentPrice - trade.entry_price
          : trade.entry_price - currentPrice;
        const pnlUsdt = priceDiff * trade.quantity;
        const pnlPercent = (priceDiff / trade.entry_price) * 100 * trade.leverage;

        this.db.closeTrade(tradeId, currentPrice, 'manual_close', pnlUsdt, pnlPercent);

        res.json({ success: true, pnlUsdt, pnlPercent });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  isPaused() {
    return this.paused;
  }

  start() {
    const port = config.dashboard.port;
    this.app.listen(port, () => {
      logger.info(`Dashboard running on http://localhost:${port}`);
    });
  }
}

module.exports = DashboardServer;
