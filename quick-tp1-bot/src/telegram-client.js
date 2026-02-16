const Database = require('better-sqlite3');
const fs = require('fs');
const logger = require('./logger');
const config = require('../config/config');

/**
 * Instead of connecting to Telegram directly (which conflicts with bot 1's session),
 * this watcher polls bot 1's SQLite database for new signals every 5 seconds.
 * Bot 1 handles Telegram → parsing → DB. Bot 2 reads from that DB.
 */
class SignalWatcher {
  constructor(onSignalCallback) {
    this.onSignalCallback = onSignalCallback;
    this.bot1DbPath = config.bot1.dbPath;
    this.bot1Db = null;
    this.interval = null;
    this.processedIds = new Set(); // track bot1 signal IDs already processed
    this.running = false;
  }

  start() {
    // Verify bot 1 DB exists
    if (!fs.existsSync(this.bot1DbPath)) {
      logger.error(`Bot 1 database not found at ${this.bot1DbPath}`);
      logger.error('Make sure crypto-signals-tracker is running and the path is correct in BOT1_DB_PATH');
      throw new Error(`Bot 1 database not found: ${this.bot1DbPath}`);
    }

    // Open bot 1 DB in read-only mode
    this.bot1Db = new Database(this.bot1DbPath, { readonly: true, fileMustExist: true });
    this.bot1Db.pragma('journal_mode = WAL'); // WAL allows concurrent reads
    logger.info(`Connected to bot 1 database: ${this.bot1DbPath}`);

    // Seed processedIds with recent signals so we don't replay old ones on startup
    this._seedProcessedIds();

    this.running = true;
    this.interval = setInterval(() => this._poll(), 5000);
    logger.info('Signal watcher started (polling bot 1 DB every 5s)');
  }

  /**
   * On startup, mark all existing signals as "already seen" so we only
   * process signals that arrive AFTER the bot starts.
   */
  _seedProcessedIds() {
    try {
      const recent = this.bot1Db.prepare(`
        SELECT id FROM signals
        WHERE created_at >= datetime('now', '-120 seconds')
      `).all();

      for (const row of recent) {
        this.processedIds.add(row.id);
      }
      logger.info(`Seeded ${this.processedIds.size} existing signal IDs (will be skipped)`);
    } catch (err) {
      logger.warn(`Could not seed signal IDs: ${err.message}`);
    }
  }

  _poll() {
    if (!this.running) return;

    try {
      // Fetch signals created in the last 60 seconds
      const rows = this.bot1Db.prepare(`
        SELECT id, pair, direction, entry_min, entry_max, tp1_price, stop_loss,
               leverage, source_group, raw_message, created_at, status
        FROM signals
        WHERE created_at >= datetime('now', '-60 seconds')
        ORDER BY created_at ASC
      `).all();

      for (const row of rows) {
        // Skip already-processed signals
        if (this.processedIds.has(row.id)) continue;
        this.processedIds.add(row.id);

        logger.info(`New signal from bot 1 DB: #${row.id} ${row.pair} ${row.direction} x${row.leverage}`);

        // Convert DB row to signal object (same format as signal-parser output)
        const signal = {
          type: 'signal',
          pair: row.pair,
          direction: row.direction,
          entryMin: row.entry_min,
          entryMax: row.entry_max,
          tp1Price: row.tp1_price,
          stopLoss: row.stop_loss,
          leverage: row.leverage,
          sourceGroup: row.source_group,
          rawMessage: row.raw_message,
        };

        // Fire callback (same as before — index.js _onSignal handles it)
        if (this.onSignalCallback) {
          this.onSignalCallback(signal).catch(err => {
            logger.error(`Error processing signal #${row.id}: ${err.message}`);
          });
        }
      }

      // Prune old IDs to prevent memory leak (keep only last 1000)
      if (this.processedIds.size > 1000) {
        const arr = [...this.processedIds];
        this.processedIds = new Set(arr.slice(-500));
      }
    } catch (err) {
      logger.error(`Signal watcher poll error: ${err.message}`);
    }
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.bot1Db) {
      this.bot1Db.close();
      this.bot1Db = null;
    }
    logger.info('Signal watcher stopped');
  }
}

module.exports = SignalWatcher;
