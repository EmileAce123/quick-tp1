const logger = require('./logger');

class SignalParser {
  constructor(db) {
    this.db = db;
  }

  /**
   * Parse a message and return a signal object if it matches known formats.
   * Returns null if the message is not a trading signal.
   */
  parse(message, sourceGroup) {
    if (!message || typeof message !== 'string') return null;

    const text = message.trim();

    // Check for stop loss / cancellation messages
    if (this._isStopLossMessage(text)) {
      return { type: 'stop_loss_alert', rawMessage: text };
    }

    // Try Format 1 - BTC Scalp Signals
    let signal = this._parseFormat1(text);

    // Try Format 2 - Binance Trading Signals
    if (!signal) {
      signal = this._parseFormat2(text);
    }

    if (!signal) return null;

    signal.sourceGroup = sourceGroup || '';
    signal.rawMessage = text;

    // Anti-duplicate check: ignore identical signals received within 5 minutes
    if (this._isDuplicate(signal)) {
      logger.info(`Duplicate signal ignored: ${signal.pair} ${signal.direction}`);
      return null;
    }

    logger.info(`Signal parsed: ${signal.pair} ${signal.direction} x${signal.leverage}`, {
      entryMin: signal.entryMin,
      entryMax: signal.entryMax,
      tp1: signal.tp1Price,
      sl: signal.stopLoss,
    });

    return signal;
  }

  /**
   * Format 1 - BTC Scalp Signals
   * #SIGNAL
   * #BTC/USDT
   * Sell Limit / SHORT
   * Entry zone : 98200 - 98500
   * Targets : 97500 - 96800 - 96200 - 95500 - 94800
   * Stoploss : 99200
   * Leverage : X10
   */
  _parseFormat1(text) {
    // Must contain #SIGNAL or look like format 1
    if (!/#SIGNAL/i.test(text) && !/#\w+\/USDT/i.test(text)) return null;

    // Pair
    const pairMatch = text.match(/#(\w+\/USDT)/i);
    if (!pairMatch) return null;
    const pair = pairMatch[1].toUpperCase().replace('/', '');

    // Direction
    let direction = null;
    if (/sell\s*limit|short/i.test(text)) {
      direction = 'SHORT';
    } else if (/buy\s*limit|long/i.test(text)) {
      direction = 'LONG';
    }
    if (!direction) return null;

    // Entry zone
    const entryMatch = text.match(/entry\s*zone\s*:?\s*([\d.]+)\s*[-–]\s*([\d.]+)/i);
    if (!entryMatch) return null;
    const entryMin = parseFloat(entryMatch[1]);
    const entryMax = parseFloat(entryMatch[2]);

    // Targets
    const targetsMatch = text.match(/targets?\s*:?\s*([\d.\s\-–]+)/i);
    if (!targetsMatch) return null;
    const targets = targetsMatch[1].trim().split(/\s*[-–]\s*/).map(t => parseFloat(t.trim())).filter(t => !isNaN(t));
    if (targets.length === 0) return null;
    const tp1Price = targets[0];

    // Stop loss (optional in some cases)
    let stopLoss = null;
    const slMatch = text.match(/stoploss\s*:?\s*([\d.]+)/i);
    if (slMatch) {
      stopLoss = parseFloat(slMatch[1]);
    }

    // Leverage
    let leverage = 10; // default
    const levMatch = text.match(/leverage\s*:?\s*x?(\d+)/i);
    if (levMatch) {
      leverage = parseInt(levMatch[1], 10);
    }

    return {
      type: 'signal',
      pair,
      direction,
      entryMin: Math.min(entryMin, entryMax),
      entryMax: Math.max(entryMin, entryMax),
      tp1Price,
      stopLoss,
      leverage,
    };
  }

  /**
   * Format 2 - Binance Trading Signals
   * Binance
   * #HANA/USDT
   * Entry zone 0.033065-0.034415
   * TP zone 0.034759 - 0.038545 - 0.041298 - 0.04646 - 0.053343
   * Leverage 10x
   * Direction : LONG
   */
  _parseFormat2(text) {
    // Must contain Binance reference or TP zone
    if (!/binance/i.test(text) && !/TP\s*zone/i.test(text)) return null;

    // Pair
    const pairMatch = text.match(/#(\w+\/USDT)/i);
    if (!pairMatch) return null;
    const pair = pairMatch[1].toUpperCase().replace('/', '');

    // Entry zone
    const entryMatch = text.match(/entry\s*zone\s*:?\s*([\d.]+)\s*[-–]\s*([\d.]+)/i);
    if (!entryMatch) return null;
    const entryMin = parseFloat(entryMatch[1]);
    const entryMax = parseFloat(entryMatch[2]);

    // TP zone
    const tpMatch = text.match(/TP\s*zone\s*:?\s*([\d.\s\-–]+)/i);
    if (!tpMatch) return null;
    const targets = tpMatch[1].trim().split(/\s*[-–]\s*/).map(t => parseFloat(t.trim())).filter(t => !isNaN(t));
    if (targets.length === 0) return null;
    const tp1Price = targets[0];

    // Direction
    let direction = null;
    if (/direction\s*:?\s*short/i.test(text) || /sell\s*limit|short/i.test(text)) {
      direction = 'SHORT';
    } else if (/direction\s*:?\s*long/i.test(text) || /buy\s*limit|long/i.test(text)) {
      direction = 'LONG';
    }
    if (!direction) return null;

    // Leverage
    let leverage = 10;
    const levMatch = text.match(/leverage\s*:?\s*(\d+)\s*x/i);
    if (!levMatch) {
      const levMatch2 = text.match(/leverage\s*:?\s*x?(\d+)/i);
      if (levMatch2) leverage = parseInt(levMatch2[1], 10);
    } else {
      leverage = parseInt(levMatch[1], 10);
    }

    // Stop loss (often absent in format 2)
    let stopLoss = null;
    const slMatch = text.match(/stop\s*loss\s*:?\s*([\d.]+)/i);
    if (slMatch) {
      stopLoss = parseFloat(slMatch[1]);
    }

    return {
      type: 'signal',
      pair,
      direction,
      entryMin: Math.min(entryMin, entryMax),
      entryMax: Math.max(entryMin, entryMax),
      tp1Price,
      stopLoss,
      leverage,
    };
  }

  /**
   * Detect stop loss / cancellation messages from the group
   */
  _isStopLossMessage(text) {
    const patterns = [
      /stoploss\s*❌/i,
      /stop\s*loss\s*❌/i,
      /cancelled\s*❌/i,
      /canceled\s*❌/i,
      /sl\s*hit/i,
      /stop\s*loss\s*hit/i,
      /close\s*trade/i,
    ];
    return patterns.some(p => p.test(text));
  }

  /**
   * Anti-duplicate: check if a similar signal exists in the last 5 minutes
   */
  _isDuplicate(signal) {
    const recent = this.db.getRecentSignals(5);
    return recent.some(s =>
      s.pair === signal.pair &&
      s.direction === signal.direction &&
      Math.abs(s.entry_min - signal.entryMin) < 0.0001 &&
      Math.abs(s.tp1_price - signal.tp1Price) < 0.0001
    );
  }
}

module.exports = SignalParser;
