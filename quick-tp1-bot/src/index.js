const config = require('../config/config');
const logger = require('./logger');
const DB = require('./database');
const SignalParser = require('./signal-parser');
const TelegramListener = require('./telegram-client');
const TradingEngine = require('./trading-engine');
const PositionManager = require('./position-manager');
const Notifier = require('./notifier');
const DashboardServer = require('./dashboard-server');

class QuickTP1Bot {
  constructor() {
    this.db = null;
    this.tradingEngine = null;
    this.notifier = null;
    this.positionManager = null;
    this.dashboard = null;
    this.telegramListener = null;
    this.signalParser = null;
  }

  async start() {
    logger.info('====================================');
    logger.info('  QUICK TP1 BOT - Starting...');
    logger.info(`  Mode: ${config.binance.mode.toUpperCase()}`);
    logger.info(`  API URL: ${config.binance.baseUrl}`);
    logger.info('====================================');

    // Safety check
    if (config.binance.mode === 'testnet' && config.binance.baseUrl.includes('fapi.binance.com')) {
      logger.error('SAFETY ABORT: Testnet mode with live URL detected!');
      process.exit(1);
    }

    try {
      // 1. Initialize database
      this.db = new DB(config.db.path);
      logger.info('Database initialized');

      // 2. Initialize trading engine
      this.tradingEngine = new TradingEngine();
      logger.info('Trading engine initialized');

      // 3. Test Binance connection
      try {
        const balance = await this.tradingEngine.getAccountBalance();
        logger.info(`Binance connected - Balance: ${balance.balance} USDT (Available: ${balance.availableBalance} USDT)`);
        this.db.insertBalanceSnapshot(balance.balance, balance.availableBalance, balance.unrealizedPnl);
      } catch (err) {
        logger.error(`Binance connection failed: ${err.message}`);
        logger.warn('Bot will continue but trading will not work until Binance is configured');
      }

      // 4. Initialize notifier
      this.notifier = new Notifier();
      logger.info('Notifier initialized');

      // 5. Initialize position manager
      this.positionManager = new PositionManager(this.db, this.tradingEngine, this.notifier);
      this.positionManager.start();

      // 6. Initialize dashboard
      this.dashboard = new DashboardServer(this.db, this.tradingEngine, this.positionManager);
      this.dashboard.start();

      // 7. Initialize signal parser
      this.signalParser = new SignalParser(this.db);

      // 8. Initialize Telegram listener
      this.telegramListener = new TelegramListener(this.signalParser, (signal) => this._onSignal(signal));

      try {
        await this.telegramListener.start();
        logger.info('Telegram listener started');
      } catch (err) {
        logger.error(`Telegram connection failed: ${err.message}`);
        logger.warn('Bot will run without Telegram - configure credentials in .env');
      }

      // 9. Schedule daily report
      this.notifier.scheduleDailyReport(this.db);

      // 10. Balance snapshot every 5 minutes
      setInterval(async () => {
        try {
          const balance = await this.tradingEngine.getAccountBalance();
          this.db.insertBalanceSnapshot(balance.balance, balance.availableBalance, balance.unrealizedPnl);
        } catch (_) {}
      }, 5 * 60 * 1000);

      // Startup notification
      await this.notifier.sendAlert(
        `🚀 <b>QUICK-TP1 Bot démarré</b>\nMode: ${config.binance.mode.toUpperCase()}\nDashboard: http://localhost:${config.dashboard.port}`
      );

      logger.info('Quick TP1 Bot fully started and running!');

    } catch (err) {
      logger.error(`Fatal startup error: ${err.message}`, { stack: err.stack });
      process.exit(1);
    }
  }

  async _onSignal(signal) {
    try {
      // Handle stop loss alerts from the group
      if (signal.type === 'stop_loss_alert') {
        logger.warn(`Group stop loss alert received: ${signal.rawMessage}`);
        await this.positionManager.handleGroupStopLoss(signal.rawMessage);
        return;
      }

      // Check if bot is paused
      if (this.dashboard && this.dashboard.isPaused()) {
        logger.info(`Signal ignored (bot paused): ${signal.pair} ${signal.direction}`);
        return;
      }

      logger.info(`Processing signal: ${signal.pair} ${signal.direction} x${signal.leverage}`);

      // Save signal to DB
      const signalId = this.db.insertSignal(signal);

      // Check if we already have an open position for this pair
      const existingTrade = this.db.getTradeByPairOpen(signal.pair);
      if (existingTrade) {
        logger.info(`Already have open position for ${signal.pair}, skipping`);
        this.db.updateSignalStatus(signalId, 'skipped');
        return;
      }

      // Check available balance
      let balance;
      try {
        balance = await this.tradingEngine.getAccountBalance();
      } catch (err) {
        logger.error(`Cannot get balance: ${err.message}`);
        this.db.updateSignalStatus(signalId, 'error');
        await this.notifier.sendAlert(`❌ Erreur balance pour ${signal.pair}: ${err.message}`);
        return;
      }

      if (balance.availableBalance < config.strategy.minBalanceUsdt) {
        logger.warn(`Balance too low (${balance.availableBalance} USDT), skipping signal`);
        this.db.updateSignalStatus(signalId, 'skipped');
        await this.notifier.sendAlert(
          `⚠️ Balance insuffisante (${balance.availableBalance.toFixed(2)} USDT) pour ${signal.pair}`
        );
        return;
      }

      // Execute trade
      let tradeResult;
      try {
        tradeResult = await this.tradingEngine.executeTrade(signal, balance.availableBalance);
      } catch (err) {
        logger.error(`Trade execution error for ${signal.pair}: ${err.message}`);
        this.db.updateSignalStatus(signalId, 'error');
        await this.notifier.sendAlert(`❌ Erreur trade ${signal.pair}: ${err.message}`);
        return;
      }

      if (!tradeResult) {
        logger.info(`Trade not executed for ${signal.pair} (price outside zone or size too small)`);
        this.db.updateSignalStatus(signalId, 'skipped');
        return;
      }

      // Save trade to DB
      const tradeId = this.db.insertTrade({
        signalId,
        pair: tradeResult.symbol,
        direction: tradeResult.direction,
        leverage: tradeResult.leverage,
        entryPrice: tradeResult.entryPrice,
        quantity: tradeResult.quantity,
        positionSizeUsdt: tradeResult.positionSizeUsdt,
        tp1Price: tradeResult.tp1Price,
        stopLossPrice: tradeResult.stopLossPrice,
        reactionTimeMs: tradeResult.reactionTimeMs,
      });

      this.db.updateSignalStatus(signalId, 'traded');

      logger.info(`Trade opened: #${tradeId} ${tradeResult.symbol} ${tradeResult.direction} @ ${tradeResult.entryPrice}`);

      // Send notification
      await this.notifier.sendTradeOpen(tradeResult);

    } catch (err) {
      logger.error(`Signal processing error: ${err.message}`, { stack: err.stack });
    }
  }

  async stop() {
    logger.info('Shutting down Quick TP1 Bot...');

    if (this.positionManager) this.positionManager.stop();
    if (this.telegramListener) await this.telegramListener.stop();
    if (this.db) this.db.close();

    await this.notifier?.sendAlert('🔴 <b>QUICK-TP1 Bot arrêté</b>');

    logger.info('Bot stopped.');
    process.exit(0);
  }
}

// ---- Main ----
const bot = new QuickTP1Bot();

bot.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => bot.stop());
process.on('SIGTERM', () => bot.stop());
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});
