const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

class DB {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    logger.info(`Database initialized at ${dbPath}`);
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_min REAL NOT NULL,
        entry_max REAL NOT NULL,
        tp1_price REAL NOT NULL,
        stop_loss REAL,
        leverage INTEGER NOT NULL,
        source_group TEXT,
        raw_message TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        status TEXT DEFAULT 'new'
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER REFERENCES signals(id),
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        leverage INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        quantity REAL NOT NULL,
        position_size_usdt REAL NOT NULL,
        tp1_price REAL NOT NULL,
        stop_loss_price REAL,
        best_price REAL,
        trailing_active INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open',
        exit_price REAL,
        exit_reason TEXT,
        pnl_usdt REAL,
        pnl_percent REAL,
        opened_at DATETIME DEFAULT (datetime('now')),
        closed_at DATETIME,
        reaction_time_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS balance_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        balance REAL NOT NULL,
        available_balance REAL NOT NULL,
        unrealized_pnl REAL,
        timestamp DATETIME DEFAULT (datetime('now'))
      );
    `);
  }

  // ---- Signals ----

  insertSignal(signal) {
    const stmt = this.db.prepare(`
      INSERT INTO signals (pair, direction, entry_min, entry_max, tp1_price, stop_loss, leverage, source_group, raw_message, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      signal.pair,
      signal.direction,
      signal.entryMin,
      signal.entryMax,
      signal.tp1Price,
      signal.stopLoss || null,
      signal.leverage,
      signal.sourceGroup || null,
      signal.rawMessage || null,
      signal.status || 'new'
    );
    return result.lastInsertRowid;
  }

  updateSignalStatus(id, status) {
    this.db.prepare('UPDATE signals SET status = ? WHERE id = ?').run(status, id);
  }

  getRecentSignals(minutes = 5) {
    return this.db.prepare(`
      SELECT * FROM signals
      WHERE created_at >= datetime('now', ? || ' minutes')
      ORDER BY created_at DESC
    `).all(-minutes);
  }

  // ---- Trades ----

  insertTrade(trade) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (signal_id, pair, direction, leverage, entry_price, quantity, position_size_usdt, tp1_price, stop_loss_price, best_price, status, reaction_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `);
    const result = stmt.run(
      trade.signalId,
      trade.pair,
      trade.direction,
      trade.leverage,
      trade.entryPrice,
      trade.quantity,
      trade.positionSizeUsdt,
      trade.tp1Price,
      trade.stopLossPrice || null,
      trade.entryPrice, // best_price starts at entry
      trade.reactionTimeMs || null
    );
    return result.lastInsertRowid;
  }

  getOpenTrades() {
    return this.db.prepare("SELECT * FROM trades WHERE status = 'open'").all();
  }

  getTradeById(id) {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  }

  updateTradeBestPrice(id, bestPrice) {
    this.db.prepare('UPDATE trades SET best_price = ? WHERE id = ?').run(bestPrice, id);
  }

  activateTrailing(id) {
    this.db.prepare('UPDATE trades SET trailing_active = 1 WHERE id = ?').run(id);
  }

  closeTrade(id, exitPrice, exitReason, pnlUsdt, pnlPercent) {
    this.db.prepare(`
      UPDATE trades
      SET status = ?, exit_price = ?, exit_reason = ?, pnl_usdt = ?, pnl_percent = ?, closed_at = datetime('now')
      WHERE id = ?
    `).run(exitReason, exitPrice, exitReason, pnlUsdt, pnlPercent, id);
  }

  getTradesByDateRange(startDate, endDate) {
    return this.db.prepare(`
      SELECT * FROM trades
      WHERE opened_at >= ? AND opened_at <= ?
      ORDER BY opened_at DESC
    `).all(startDate, endDate);
  }

  getRecentTrades(limit = 50) {
    return this.db.prepare('SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?').all(limit);
  }

  getTradeStats(startDate = null) {
    let whereClause = "WHERE status != 'open'";
    const params = [];
    if (startDate) {
      whereClause += ' AND closed_at >= ?';
      params.push(startDate);
    }

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl_usdt) as total_pnl,
        AVG(CASE WHEN pnl_usdt > 0 THEN pnl_usdt END) as avg_win,
        AVG(CASE WHEN pnl_usdt <= 0 THEN pnl_usdt END) as avg_loss,
        MAX(pnl_usdt) as best_trade,
        MIN(pnl_usdt) as worst_trade,
        AVG(CASE WHEN status = 'tp1_hit' THEN
          (julianday(closed_at) - julianday(opened_at)) * 86400
        END) as avg_tp1_time_seconds,
        SUM(CASE WHEN status = 'tp1_hit' THEN 1 ELSE 0 END) as tp1_hits,
        SUM(CASE WHEN status = 'trailing_stopped' THEN 1 ELSE 0 END) as trailing_stops,
        SUM(CASE WHEN status = 'sl_hit' THEN 1 ELSE 0 END) as sl_hits
      FROM trades
      ${whereClause}
    `).get(...params);

    return stats;
  }

  getTodayPnl() {
    const result = this.db.prepare(`
      SELECT COALESCE(SUM(pnl_usdt), 0) as pnl
      FROM trades
      WHERE closed_at >= date('now')
      AND status != 'open'
    `).get();
    return result.pnl;
  }

  getTodayTradeCount() {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM trades
      WHERE opened_at >= date('now')
    `).get();
    return result.count;
  }

  getTradeByPairOpen(pair) {
    return this.db.prepare("SELECT * FROM trades WHERE pair = ? AND status = 'open'").get(pair);
  }

  // ---- Balance History ----

  insertBalanceSnapshot(balance, availableBalance, unrealizedPnl) {
    this.db.prepare(`
      INSERT INTO balance_history (balance, available_balance, unrealized_pnl)
      VALUES (?, ?, ?)
    `).run(balance, availableBalance, unrealizedPnl || 0);
  }

  getLatestBalance() {
    return this.db.prepare('SELECT * FROM balance_history ORDER BY timestamp DESC LIMIT 1').get();
  }

  getFirstBalanceOfDay() {
    return this.db.prepare(`
      SELECT * FROM balance_history
      WHERE timestamp >= date('now')
      ORDER BY timestamp ASC LIMIT 1
    `).get();
  }

  close() {
    this.db.close();
  }
}

module.exports = DB;
