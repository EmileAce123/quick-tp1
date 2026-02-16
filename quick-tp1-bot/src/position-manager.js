const logger = require('./logger');
const config = require('../config/config');

class PositionManager {
  constructor(db, tradingEngine, notifier) {
    this.db = db;
    this.engine = tradingEngine;
    this.notifier = notifier;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => this._checkPositions(), 2500); // every 2.5 seconds
    logger.info('Position manager started (checking every 2.5s)');
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('Position manager stopped');
  }

  async _checkPositions() {
    if (!this.running) return;

    try {
      const openTrades = this.db.getOpenTrades();
      if (openTrades.length === 0) return;

      for (const trade of openTrades) {
        try {
          await this._checkSinglePosition(trade);
        } catch (err) {
          logger.error(`Error checking position ${trade.pair} (trade #${trade.id}): ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Position manager loop error: ${err.message}`);
    }
  }

  async _checkSinglePosition(trade) {
    // Get current price
    const currentPrice = await this.engine.getCurrentPrice(trade.pair);
    if (!currentPrice) return;

    const isLong = trade.direction === 'LONG';
    const entryPrice = trade.entry_price;
    const bestPrice = trade.best_price || entryPrice;

    // Calculate P&L
    const pnlPercent = isLong
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    // Check TP1 hit (order on Binance should handle this, but verify)
    const tp1Hit = isLong
      ? currentPrice >= trade.tp1_price
      : currentPrice <= trade.tp1_price;

    if (tp1Hit) {
      await this._closeTradeWithReason(trade, currentPrice, 'tp1_hit', pnlPercent);
      return;
    }

    // Update best price
    let newBestPrice = bestPrice;
    if (isLong && currentPrice > bestPrice) {
      newBestPrice = currentPrice;
    } else if (!isLong && currentPrice < bestPrice) {
      newBestPrice = currentPrice;
    }

    if (newBestPrice !== bestPrice) {
      this.db.updateTradeBestPrice(trade.id, newBestPrice);
    }

    // Check trailing stop
    const activationThreshold = config.strategy.trailingActivationPercent;
    const inProfit = pnlPercent > 0;
    const profitAboveActivation = pnlPercent >= activationThreshold;

    // Activate trailing if conditions met
    if (profitAboveActivation && !trade.trailing_active) {
      this.db.activateTrailing(trade.id);
      trade.trailing_active = 1;
      logger.info(`Trailing stop activated for ${trade.pair} (P&L: ${pnlPercent.toFixed(2)}%)`);
    }

    // Check trailing stop trigger
    if (trade.trailing_active && inProfit) {
      const trailingDistance = config.strategy.trailingDistancePercent / 100;
      let retracePercent;

      if (isLong) {
        // For LONG: retrace from highest point
        retracePercent = (newBestPrice - currentPrice) / newBestPrice;
      } else {
        // For SHORT: retrace from lowest point
        retracePercent = (currentPrice - newBestPrice) / newBestPrice;
      }

      if (retracePercent > trailingDistance) {
        logger.info(
          `Trailing stop triggered for ${trade.pair}: retrace ${(retracePercent * 100).toFixed(2)}% > ${config.strategy.trailingDistancePercent}%`
        );
        await this._closeTradeWithReason(trade, currentPrice, 'trailing_stopped', pnlPercent);
        return;
      }
    }

    // Check for zombie positions (>24h alert, >48h close)
    const openedAt = new Date(trade.opened_at + 'Z').getTime();
    const ageHours = (Date.now() - openedAt) / (1000 * 60 * 60);

    if (ageHours > config.strategy.maxPositionAgeHours) {
      logger.warn(`Position ${trade.pair} expired after ${ageHours.toFixed(1)}h, closing...`);
      await this._closeTradeWithReason(trade, currentPrice, 'expired', pnlPercent);
      return;
    }

    if (ageHours > 24 && ageHours < 24.05) {
      // Alert once around the 24h mark
      if (this.notifier) {
        await this.notifier.sendAlert(
          `⚠️ Position ${trade.pair} ${trade.direction} ouverte depuis ${ageHours.toFixed(0)}h sans TP1`
        );
      }
    }
  }

  async _closeTradeWithReason(trade, exitPrice, reason, pnlPercent) {
    try {
      // Cancel all orders on Binance for this symbol
      await this.engine.cancelAllOrders(trade.pair);

      // Close position with market order
      await this.engine.closePosition(trade.pair);

      // Calculate P&L in USDT
      const isLong = trade.direction === 'LONG';
      const priceDiff = isLong
        ? exitPrice - trade.entry_price
        : trade.entry_price - exitPrice;
      const pnlUsdt = priceDiff * trade.quantity;
      const realPnlPercent = (priceDiff / trade.entry_price) * 100 * trade.leverage;

      // Update DB
      this.db.closeTrade(trade.id, exitPrice, reason, pnlUsdt, realPnlPercent);

      logger.info(
        `Trade closed: ${trade.pair} ${trade.direction} | Reason: ${reason} | P&L: ${pnlUsdt.toFixed(2)} USDT (${realPnlPercent.toFixed(2)}%)`
      );

      // Send notification
      if (this.notifier) {
        await this.notifier.sendTradeClose(trade, exitPrice, reason, pnlUsdt, realPnlPercent);
      }
    } catch (err) {
      logger.error(`Error closing trade ${trade.pair} (trade #${trade.id}): ${err.message}`);
      if (this.notifier) {
        await this.notifier.sendAlert(`❌ Erreur fermeture ${trade.pair}: ${err.message}`);
      }
    }
  }

  /**
   * Force close all open positions (kill switch)
   */
  async closeAllPositions() {
    const openTrades = this.db.getOpenTrades();
    logger.warn(`KILL SWITCH: Closing ${openTrades.length} open positions`);

    for (const trade of openTrades) {
      try {
        const currentPrice = await this.engine.getCurrentPrice(trade.pair);
        await this._closeTradeWithReason(trade, currentPrice, 'manual_close', 0);
      } catch (err) {
        logger.error(`Error force-closing ${trade.pair}: ${err.message}`);
      }
    }
  }

  /**
   * Handle a stop loss message from Telegram group
   * Close all positions matching the pair mentioned in the message, or all positions if no pair found
   */
  async handleGroupStopLoss(rawMessage) {
    const openTrades = this.db.getOpenTrades();
    if (openTrades.length === 0) return;

    // Try to extract pair from message
    const pairMatch = rawMessage.match(/#?(\w+)\/?(USDT)/i);
    const targetPair = pairMatch ? `${pairMatch[1]}${pairMatch[2]}`.toUpperCase() : null;

    for (const trade of openTrades) {
      if (targetPair && trade.pair !== targetPair) continue;

      try {
        const currentPrice = await this.engine.getCurrentPrice(trade.pair);
        logger.warn(`Group SL signal: closing ${trade.pair} ${trade.direction}`);
        await this._closeTradeWithReason(trade, currentPrice, 'sl_hit', 0);
      } catch (err) {
        logger.error(`Error closing ${trade.pair} on group SL: ${err.message}`);
      }
    }
  }
}

module.exports = PositionManager;
