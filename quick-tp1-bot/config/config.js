const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Fallback: also try loading from config/.env
if (!process.env.BINANCE_API_KEY) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

const config = {
  // Bot 1 database — signals are read from here instead of connecting to Telegram
  bot1: {
    dbPath: process.env.BOT1_DB_PATH || '/root/Test-Claude-code/crypto-signals-tracker/database/signals.db',
  },

  notifications: {
    botToken: process.env.NOTIFICATION_BOT_TOKEN || '',
    chatId: process.env.NOTIFICATION_CHAT_ID || '',
  },

  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    mode: process.env.TRADING_MODE || 'testnet', // 'testnet' or 'live'
    get baseUrl() {
      return this.mode === 'live'
        ? 'https://fapi.binance.com'
        : 'https://testnet.binancefuture.com';
    },
  },

  strategy: {
    positionSizePercent: parseFloat(process.env.POSITION_SIZE_PERCENT) || 3,
    trailingDistancePercent: parseFloat(process.env.TRAILING_DISTANCE_PERCENT) || 0.5,
    trailingActivationPercent: parseFloat(process.env.TRAILING_ACTIVATION_PERCENT) || 0.3,
    defaultStopLossPercent: parseFloat(process.env.DEFAULT_STOP_LOSS_PERCENT) || 5,
    maxPositionAgeHours: parseInt(process.env.MAX_POSITION_AGE_HOURS, 10) || 48,
    entryTolerancePercent: 1, // tolerance for price vs entry zone
    minBalanceUsdt: 10, // minimum balance to open new positions
  },

  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT, 10) || 3001,
    password: process.env.DASHBOARD_PASSWORD || 'quicktp1',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  db: {
    path: path.join(__dirname, '..', 'data', 'quick-tp1.db'),
  },
};

// Safety check: never allow live URL in testnet mode
if (config.binance.mode === 'testnet' && config.binance.baseUrl.includes('fapi.binance.com')) {
  throw new Error('SAFETY: Testnet mode detected but live URL configured. Aborting.');
}

module.exports = config;
