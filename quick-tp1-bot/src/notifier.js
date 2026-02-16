const logger = require('./logger');
const config = require('../config/config');

class Notifier {
  constructor() {
    this.botToken = config.notifications.botToken;
    this.chatId = config.notifications.chatId;
    this.enabled = !!(this.botToken && this.chatId);
    this.dailyReportScheduled = false;

    if (!this.enabled) {
      logger.warn('Telegram notifications disabled (missing bot token or chat ID)');
    }
  }

  async _send(text) {
    if (!this.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json();
        logger.error(`Telegram notification error: ${data.description}`);
      }
    } catch (err) {
      logger.error(`Telegram notification failed: ${err.message}`);
    }
  }

  async sendAlert(message) {
    await this._send(message);
  }

  async sendTradeOpen(trade) {
    const dirEmoji = trade.direction === 'LONG' ? '📈' : '📉';
    const distanceToTp1 = trade.direction === 'LONG'
      ? ((trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100).toFixed(2)
      : ((trade.entryPrice - trade.tp1Price) / trade.entryPrice * 100).toFixed(2);

    const msg = [
      `🟢 <b>QUICK-TP1 | OUVERTURE</b>`,
      `${dirEmoji} ${trade.pair} ${trade.direction} X${trade.leverage}`,
      `💰 Entrée: ${this._fmt(trade.entryPrice)}$ | Taille: ${this._fmt(trade.positionSizeUsdt)}$ (${config.strategy.positionSizePercent}%)`,
      `🎯 TP1: ${this._fmt(trade.tp1Price)}$ (distance: ${distanceToTp1}%)`,
      trade.stopLossPrice ? `🛡️ SL: ${this._fmt(trade.stopLossPrice)}$` : `🛡️ SL: défaut (-${config.strategy.defaultStopLossPercent}%)`,
      `⏱️ Réaction: ${(trade.reactionTimeMs / 1000).toFixed(1)}s`,
    ].join('\n');

    await this._send(msg);
  }

  async sendTradeClose(trade, exitPrice, reason, pnlUsdt, pnlPercent) {
    const isWin = pnlUsdt > 0;
    let header, emoji;

    switch (reason) {
      case 'tp1_hit':
        header = 'TP1 ATTEINT';
        emoji = '✅';
        break;
      case 'trailing_stopped':
        header = 'TRAILING STOP';
        emoji = '🟡';
        break;
      case 'sl_hit':
        header = 'STOP LOSS';
        emoji = '🔴';
        break;
      case 'manual_close':
        header = 'FERMETURE MANUELLE';
        emoji = '🔵';
        break;
      case 'expired':
        header = 'EXPIRÉ';
        emoji = '⏰';
        break;
      default:
        header = 'FERMÉ';
        emoji = '⚪';
    }

    const pnlEmoji = isWin ? '📈' : '📉';
    const pnlSign = isWin ? '+' : '';

    const openedAt = new Date(trade.opened_at + 'Z');
    const duration = this._formatDuration(Date.now() - openedAt.getTime());

    const lines = [
      `${emoji} <b>QUICK-TP1 | ${header}</b>`,
      `📊 ${trade.pair} ${trade.direction} X${trade.leverage}`,
      `💰 Entrée: ${this._fmt(trade.entry_price)}$ → Sortie: ${this._fmt(exitPrice)}$`,
      `${pnlEmoji} ${isWin ? 'Profit' : 'Perte'}: ${pnlSign}${this._fmt(pnlUsdt)}$ (${pnlSign}${pnlPercent.toFixed(2)}%)`,
    ];

    if (reason === 'trailing_stopped' && trade.best_price) {
      lines.push(`🔝 Meilleur prix: ${this._fmt(trade.best_price)}$`);
    }

    lines.push(`⏱️ Durée: ${duration}`);

    await this._send(lines.join('\n'));
  }

  async sendDailyReport(db) {
    try {
      const balance = db.getLatestBalance();
      const firstBalance = db.getFirstBalanceOfDay();
      const todayPnl = db.getTodayPnl();
      const stats = db.getTradeStats(new Date().toISOString().split('T')[0]);

      const balanceChange = firstBalance
        ? ((balance.balance - firstBalance.balance) / firstBalance.balance * 100).toFixed(1)
        : '0.0';

      const winRate = stats.total_trades > 0
        ? ((stats.wins / stats.total_trades) * 100).toFixed(0)
        : 0;

      const msg = [
        `📊 <b>QUICK-TP1 | RAPPORT JOUR</b>`,
        `💰 Balance: ${this._fmt(balance?.balance || 0)}$ (${balanceChange > 0 ? '+' : ''}${balanceChange}%)`,
        `📈 Trades: ${stats.total_trades} (${stats.wins || 0} wins, ${stats.losses || 0} losses)`,
        `✅ Win rate: ${winRate}%`,
        `💵 P&L jour: ${todayPnl >= 0 ? '+' : ''}${this._fmt(todayPnl)}$`,
        stats.best_trade ? `🏆 Best: +${this._fmt(stats.best_trade)}$` : '',
        stats.worst_trade ? `💀 Worst: ${this._fmt(stats.worst_trade)}$` : '',
      ].filter(Boolean).join('\n');

      await this._send(msg);
    } catch (err) {
      logger.error(`Daily report error: ${err.message}`);
    }
  }

  scheduleDailyReport(db) {
    if (this.dailyReportScheduled) return;
    this.dailyReportScheduled = true;

    // Schedule daily report at 22:00
    const scheduleNext = () => {
      const now = new Date();
      const target = new Date();
      target.setHours(22, 0, 0, 0);
      if (now >= target) {
        target.setDate(target.getDate() + 1);
      }
      const delay = target.getTime() - now.getTime();

      setTimeout(async () => {
        await this.sendDailyReport(db);
        scheduleNext();
      }, delay);

      logger.info(`Daily report scheduled for ${target.toISOString()}`);
    };

    scheduleNext();
  }

  _fmt(num) {
    if (num === null || num === undefined) return '0';
    if (Math.abs(num) >= 1) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // For small numbers, show more decimals
    return parseFloat(num).toPrecision(4);
  }

  _formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    const remainMins = minutes % 60;
    if (hours < 24) return `${hours}h${remainMins}min`;
    const days = Math.floor(hours / 24);
    return `${days}j ${hours % 24}h`;
  }
}

module.exports = Notifier;
