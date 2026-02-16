const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('../config/config');

class TelegramListener {
  constructor(signalParser, onSignalCallback) {
    this.signalParser = signalParser;
    this.onSignalCallback = onSignalCallback;
    this.client = null;
    this.sessionFile = path.join(__dirname, '..', `${config.telegram.sessionName}.session`);
    this.monitoredGroupIds = new Map(); // groupTitle -> groupId
  }

  async start() {
    // Load or create session
    let sessionString = '';
    if (fs.existsSync(this.sessionFile)) {
      sessionString = fs.readFileSync(this.sessionFile, 'utf-8').trim();
      logger.info('Loaded existing Telegram session');
    }

    const session = new StringSession(sessionString);

    this.client = new TelegramClient(
      session,
      config.telegram.apiId,
      config.telegram.apiHash,
      {
        connectionRetries: 5,
        baseLogger: { // Minimal logger to avoid GramJS noise
          _log: () => {},
          info: () => {},
          debug: () => {},
          warn: (msg) => logger.warn(`GramJS: ${msg}`),
          error: (msg) => logger.error(`GramJS: ${msg}`),
        },
      }
    );

    await this.client.start({
      phoneNumber: async () => await input.text('Enter your phone number: '),
      password: async () => await input.text('Enter your 2FA password (if any): '),
      phoneCode: async () => await input.text('Enter the code you received: '),
      onError: (err) => logger.error('Telegram auth error:', err),
    });

    // Save session
    const savedSession = this.client.session.save();
    fs.writeFileSync(this.sessionFile, savedSession);
    logger.info('Telegram session saved');

    // Resolve group IDs
    await this._resolveGroups();

    // Set up message handler
    this.client.addEventHandler(
      (event) => this._handleMessage(event),
      new NewMessage({})
    );

    logger.info('Telegram client started and listening for signals');
  }

  async _resolveGroups() {
    const dialogs = await this.client.getDialogs({ limit: 200 });

    for (const groupTitle of config.telegram.groups) {
      const dialog = dialogs.find(d =>
        d.title && d.title.toLowerCase().includes(groupTitle.toLowerCase())
      );

      if (dialog) {
        this.monitoredGroupIds.set(dialog.id.toString(), groupTitle);
        logger.info(`Found group: "${dialog.title}" (ID: ${dialog.id})`);
      } else {
        logger.warn(`Group not found: "${groupTitle}". Make sure you're a member.`);
      }
    }

    if (this.monitoredGroupIds.size === 0) {
      logger.error('No monitored groups found! The bot will not receive any signals.');
    }
  }

  async _handleMessage(event) {
    try {
      const message = event.message;
      if (!message || !message.message) return;

      // Check if message is from a monitored group
      const chatId = message.chatId || (message.peerId && message.peerId.channelId);
      if (!chatId) return;

      const chatIdStr = chatId.toString();

      // Check various ID formats
      let sourceGroup = null;
      for (const [gId, gTitle] of this.monitoredGroupIds) {
        if (chatIdStr === gId || chatIdStr === `-100${gId}` || `-100${chatIdStr}` === gId) {
          sourceGroup = gTitle;
          break;
        }
      }

      if (!sourceGroup) return;

      const text = message.message;
      logger.debug(`Message from ${sourceGroup}: ${text.substring(0, 100)}...`);

      const signal = this.signalParser.parse(text, sourceGroup);

      if (signal && this.onSignalCallback) {
        await this.onSignalCallback(signal);
      }
    } catch (err) {
      logger.error('Error handling Telegram message:', err);
    }
  }

  async stop() {
    if (this.client) {
      await this.client.disconnect();
      logger.info('Telegram client disconnected');
    }
  }
}

module.exports = TelegramListener;
