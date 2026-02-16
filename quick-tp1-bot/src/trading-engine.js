const crypto = require('crypto');
const logger = require('./logger');
const config = require('../config/config');

class TradingEngine {
  constructor() {
    this.baseUrl = config.binance.baseUrl;
    this.apiKey = config.binance.apiKey;
    this.apiSecret = config.binance.apiSecret;
    this.symbolInfoCache = new Map();
  }

  // ---- HTTP helpers ----

  _sign(params) {
    const queryString = new URLSearchParams(params).toString();
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
    return `${queryString}&signature=${signature}`;
  }

  async _request(method, endpoint, params = {}, signed = false) {
    let url = `${this.baseUrl}${endpoint}`;
    const headers = { 'X-MBX-APIKEY': this.apiKey };

    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = 5000;
    }

    let body = null;
    if (method === 'GET' || method === 'DELETE') {
      const qs = signed ? this._sign(params) : new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    } else {
      if (signed) {
        body = this._sign(params);
      } else {
        body = new URLSearchParams(params).toString();
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    // Error codes that should not be retried (already-configured states)
    const noRetryCodes = [-4046, -4028];

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, { method, headers, body });
        const data = await resp.json();

        if (data.code && data.code < 0) {
          const err = new Error(`Binance API error ${data.code}: ${data.msg}`);
          err.binanceCode = data.code;
          throw err;
        }
        return data;
      } catch (err) {
        // Don't retry on known harmless "already set" errors
        if (noRetryCodes.includes(err.binanceCode)) {
          throw err;
        }
        if (attempt < maxRetries) {
          logger.warn(`Binance API retry ${attempt + 1}/${maxRetries}: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          throw err;
        }
      }
    }
  }

  // ---- Public methods ----

  async getAccountBalance() {
    const data = await this._request('GET', '/fapi/v2/balance', {}, true);
    const usdt = data.find(b => b.asset === 'USDT');
    if (!usdt) throw new Error('USDT balance not found');
    return {
      balance: parseFloat(usdt.balance),
      availableBalance: parseFloat(usdt.availableBalance),
      unrealizedPnl: parseFloat(usdt.crossUnPnl || 0),
    };
  }

  async getPositions() {
    const data = await this._request('GET', '/fapi/v2/positionRisk', {}, true);
    return data.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
      symbol: p.symbol,
      positionAmt: parseFloat(p.positionAmt),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedProfit: parseFloat(p.unRealizedProfit),
      leverage: parseInt(p.leverage, 10),
      side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
    }));
  }

  async getSymbolInfo(symbol) {
    if (this.symbolInfoCache.has(symbol)) {
      return this.symbolInfoCache.get(symbol);
    }

    let data;
    try {
      data = await this._request('GET', '/fapi/v1/exchangeInfo');
    } catch (err) {
      logger.error(`Failed to fetch exchangeInfo: ${err.message}`);
      return null;
    }
    const sym = data.symbols ? data.symbols.find(s => s.symbol === symbol) : null;
    if (!sym) {
      logger.warn(`Symbol ${symbol} not found on Binance Futures (may not be available on ${config.binance.mode})`);
      return null;
    }

    const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
    const marketLotFilter = sym.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
    const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');

    const info = {
      symbol: sym.symbol,
      pricePrecision: sym.pricePrecision,
      quantityPrecision: sym.quantityPrecision,
      tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
      stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
      minQty: lotFilter ? parseFloat(lotFilter.minQty) : 0.001,
      maxQty: lotFilter ? parseFloat(lotFilter.maxQty) : 999999,
      marketMinQty: marketLotFilter ? parseFloat(marketLotFilter.minQty) : 0.001,
      marketMaxQty: marketLotFilter ? parseFloat(marketLotFilter.maxQty) : 999999,
      minNotional: minNotional ? parseFloat(minNotional.notional || minNotional.minNotional || 5) : 5,
    };

    this.symbolInfoCache.set(symbol, info);
    return info;
  }

  async getCurrentPrice(symbol) {
    const data = await this._request('GET', '/fapi/v1/ticker/price', { symbol });
    return parseFloat(data.price);
  }

  async setLeverage(symbol, leverage) {
    try {
      await this._request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
      logger.info(`Leverage set to ${leverage}x for ${symbol}`);
    } catch (err) {
      // -4028: No need to change leverage — already set, silently continue
      if (err.binanceCode === -4028) return;
      logger.warn(`Could not set leverage for ${symbol}: ${err.message}`);
    }
  }

  async setMarginType(symbol, marginType = 'CROSSED') {
    try {
      await this._request('POST', '/fapi/v1/marginType', { symbol, marginType }, true);
    } catch (err) {
      // -4046: No need to change margin type — already set, silently continue
      if (err.binanceCode === -4046) return;
      logger.warn(`Could not set margin type for ${symbol}: ${err.message}`);
    }
  }

  async placeMarketOrder(symbol, side, quantity) {
    const params = {
      symbol,
      side, // BUY or SELL
      type: 'MARKET',
      quantity: quantity.toString(),
    };

    logger.info(`Placing MARKET order: ${side} ${quantity} ${symbol}`);
    const result = await this._request('POST', '/fapi/v1/order', params, true);
    logger.info(`MARKET order placed: orderId=${result.orderId}, avgPrice=${result.avgPrice}`);
    return result;
  }

  async placeLimitOrder(symbol, side, price, quantity, reduceOnly = true) {
    const params = {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      price: price.toString(),
      quantity: quantity.toString(),
    };
    if (reduceOnly) params.reduceOnly = 'true';

    logger.info(`Placing LIMIT order: ${side} ${quantity} ${symbol} @ ${price}`);
    const result = await this._request('POST', '/fapi/v1/order', params, true);
    logger.info(`LIMIT order placed: orderId=${result.orderId}`);
    return result;
  }

  async placeStopMarketOrder(symbol, side, stopPrice, quantity, reduceOnly = true) {
    const params = {
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice: stopPrice.toString(),
      quantity: quantity.toString(),
    };
    if (reduceOnly) params.reduceOnly = 'true';

    logger.info(`Placing STOP_MARKET order: ${side} ${quantity} ${symbol} stopPrice=${stopPrice}`);
    const result = await this._request('POST', '/fapi/v1/order', params, true);
    logger.info(`STOP_MARKET order placed: orderId=${result.orderId}`);
    return result;
  }

  async cancelAllOrders(symbol) {
    try {
      await this._request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
      logger.info(`All open orders cancelled for ${symbol}`);
    } catch (err) {
      logger.warn(`Error cancelling orders for ${symbol}: ${err.message}`);
    }
  }

  async closePosition(symbol) {
    // Get current position to determine direction and quantity
    const positions = await this.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) {
      logger.warn(`No open position found for ${symbol}`);
      return null;
    }

    // Cancel existing orders first
    await this.cancelAllOrders(symbol);

    // Close with opposite market order
    const side = pos.positionAmt > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(pos.positionAmt);

    const symbolInfo = await this.getSymbolInfo(symbol);
    const roundedQty = this.roundQuantity(qty, symbolInfo);

    return this.placeMarketOrder(symbol, side, roundedQty);
  }

  // ---- Precision helpers ----

  roundPrice(price, symbolInfo) {
    const precision = symbolInfo.pricePrecision;
    const tickSize = symbolInfo.tickSize;
    const rounded = Math.round(price / tickSize) * tickSize;
    return parseFloat(rounded.toFixed(precision));
  }

  roundQuantity(qty, symbolInfo) {
    const precision = symbolInfo.quantityPrecision;
    const stepSize = symbolInfo.stepSize;
    const rounded = Math.floor(qty / stepSize) * stepSize;
    return parseFloat(rounded.toFixed(precision));
  }

  /**
   * Execute a full trade: set leverage, place market entry, place TP limit, place SL stop-market.
   * Returns trade details or null on failure.
   */
  async executeTrade(signal, availableBalance) {
    const startTime = Date.now();
    const symbol = signal.pair;

    try {
      // 1. Get symbol info for precision
      const symbolInfo = await this.getSymbolInfo(symbol);

      if (!symbolInfo) {
        logger.warn(`Skipping trade for ${symbol}: pair not available on ${config.binance.mode}`);
        return null;
      }

      // Validate symbolInfo fields
      if (!symbolInfo.stepSize || !symbolInfo.quantityPrecision == null) {
        logger.warn(`Skipping trade for ${symbol}: incomplete symbol info`, symbolInfo);
        return null;
      }

      // 2. Get current price
      const currentPrice = await this.getCurrentPrice(symbol);

      // 3. Check if price is within or close to entry zone (1% tolerance)
      const tolerance = config.strategy.entryTolerancePercent / 100;
      const expandedMin = signal.entryMin * (1 - tolerance);
      const expandedMax = signal.entryMax * (1 + tolerance);

      if (currentPrice < expandedMin || currentPrice > expandedMax) {
        logger.warn(`Price ${currentPrice} outside entry zone [${signal.entryMin}-${signal.entryMax}] for ${symbol}`);
        return null;
      }

      // 4. Calculate position size (3% of available balance)
      const positionSizeUsdt = availableBalance * (config.strategy.positionSizePercent / 100);

      // Ensure minimum notional
      if (positionSizeUsdt < symbolInfo.minNotional) {
        logger.warn(`Position size ${positionSizeUsdt} USDT below minimum notional ${symbolInfo.minNotional} for ${symbol}`);
        return null;
      }

      // 5. Calculate quantity with debug logging
      const rawQty = positionSizeUsdt / currentPrice;
      const quantity = this.roundQuantity(rawQty, symbolInfo);

      logger.debug(`Quantity calc for ${symbol}: positionSizeUSDT=${positionSizeUsdt.toFixed(4)}, currentPrice=${currentPrice}, rawQty=${rawQty}, roundedQty=${quantity}, stepSize=${symbolInfo.stepSize}, qtyPrecision=${symbolInfo.quantityPrecision}, minQty=${symbolInfo.minQty}`);

      // Guard against NaN or zero quantity
      if (!quantity || isNaN(quantity) || quantity <= 0) {
        logger.error(`Invalid quantity for ${symbol}: ${quantity} (raw=${rawQty}, price=${currentPrice}, size=${positionSizeUsdt}, stepSize=${symbolInfo.stepSize})`);
        return null;
      }

      if (quantity < symbolInfo.minQty) {
        logger.warn(`Quantity ${quantity} below min ${symbolInfo.minQty} for ${symbol}`);
        return null;
      }

      // 6. Set leverage
      await this.setLeverage(symbol, signal.leverage);
      await this.setMarginType(symbol, 'CROSSED');

      // 7. Place MARKET entry order
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
      const entryResult = await this.placeMarketOrder(symbol, side, quantity);

      const avgEntryPrice = parseFloat(entryResult.avgPrice) || currentPrice;

      // 8. Place TP1 LIMIT order
      const tp1Price = this.roundPrice(signal.tp1Price, symbolInfo);
      const tpSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
      try {
        await this.placeLimitOrder(symbol, tpSide, tp1Price, quantity, true);
      } catch (err) {
        logger.error(`Failed to place TP order for ${symbol}: ${err.message}`);
      }

      // 9. Place STOP MARKET order
      let slPrice = signal.stopLoss;
      if (!slPrice) {
        // Default SL: 5% from entry in the wrong direction
        const slPercent = config.strategy.defaultStopLossPercent / 100;
        slPrice = signal.direction === 'LONG'
          ? avgEntryPrice * (1 - slPercent)
          : avgEntryPrice * (1 + slPercent);
      }
      slPrice = this.roundPrice(slPrice, symbolInfo);

      try {
        await this.placeStopMarketOrder(symbol, tpSide, slPrice, quantity, true);
      } catch (err) {
        logger.error(`Failed to place SL order for ${symbol}: ${err.message}`);
      }

      const reactionTime = Date.now() - startTime;

      return {
        pair: symbol,
        direction: signal.direction,
        leverage: signal.leverage,
        entryPrice: avgEntryPrice,
        quantity,
        positionSizeUsdt: quantity * avgEntryPrice,
        tp1Price: signal.tp1Price,
        stopLossPrice: slPrice,
        reactionTimeMs: reactionTime,
      };
    } catch (err) {
      logger.error(`Trade execution failed for ${symbol}: ${err.message}`);
      throw err;
    }
  }
}

module.exports = TradingEngine;
