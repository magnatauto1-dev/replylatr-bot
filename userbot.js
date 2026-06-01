// userbot.js — UserbotManager: управляет GramJS сессиями нескольких пользователей
'use strict';
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const API_ID = parseInt(process.env.TG_API_ID || '0');
const API_HASH = process.env.TG_API_HASH || '';

class UserbotManager {
  constructor() {
    // userId -> { client, isAway, awayText, repliedCalls, schedule, scheduleByAuto, pollInterval }
    this.clients = new Map();
  }

  // Загружает всех подключённых пользователей из Firestore при старте
  async loadAll() {
    const { getAllConnectedUsers } = require('./db');
    const { decrypt } = require('./crypto');
    let users = [];
    try {
      users = await getAllConnectedUsers();
    } catch (e) {
      console.error('[userbot] loadAll: DB error:', e.message);
      return;
    }
    console.log(`[userbot] Loading ${users.length} connected users...`);
    for (const user of users) {
      if (!user.encryptedSession) continue;
      try {
        const sessionStr = decrypt(user.encryptedSession);
        await this._startClient(String(user.id), sessionStr, {
          isAway: user.away?.active || false,
          awayText: user.away?.text || '',
          schedule: user.schedule || null
        });
      } catch (e) {
        console.error(`[userbot] Failed to load user ${user.id}:`, e.message);
        const { saveUser } = require('./db');
        await saveUser(user.id, { connected: false }).catch(() => {});
      }
    }
    console.log('[userbot] All users loaded');
  }

  async _startClient(userId, sessionStr, opts = {}) {
    const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
      connectionRetries: 5
    });
    await client.connect();
    const me = await client.getMe();
    console.log(`[userbot] ✅ User ${userId} connected as @${me.username}`);

    const state = {
      client,
      isAway: opts.isAway || false,
      awayText: opts.awayText || '',
      repliedCalls: new Set(),
      repliedTexts: new Map(),     // chatId -> timestamp последнего ответа на текст
      repliedCallDialogs: new Map(), // chatId -> timestamp последнего ответа на звонок
      schedule: opts.schedule || null,
      scheduleByAuto: false,
      pollInterval: null
    };
    this.clients.set(userId, state);
    this._attachHandlers(userId, state);
  }

  _attachHandlers(userId, state) {
    const { client } = state;

    // Автоответ на текстовые сообщения
    client.addEventHandler(async (event) => {
      if (!state.isAway || !state.awayText) return;
      if (!event.isPrivate) return;
      const msg = event.message;
      if (!msg || msg.out) return;
      // Игнорируем сообщения старше 60 секунд (защита от replay при рестарте)
      const ageMs = Date.now() - msg.date * 1000;
      if (ageMs > 60 * 1000) return;
      // Игнорируем сообщения от ботов (в т.ч. от нашего собственного бота)
      try {
        const sender = await client.getEntity(msg.senderId);
        if (sender?.bot) return;
      } catch (e) { /* если не удалось получить — пропускаем проверку */ }
      // Cooldown: один ответ на один чат раз в 5 минут
      const chatId = String(msg.chatId || msg.peerId?.userId || msg.senderId);
      const lastReplied = state.repliedTexts.get(chatId) || 0;
      if (Date.now() - lastReplied < 5 * 60 * 1000) return;
      state.repliedTexts.set(chatId, Date.now());
      try {
        await msg.reply({ message: state.awayText });
        console.log(`[userbot] 💬 User ${userId}: replied to text`);
      } catch (e) {
        console.error(`[userbot] text reply error (${userId}):`, e.message);
      }
    }, new NewMessage({ incoming: true }));

    // Поллинг пропущенных звонков каждые 15 секунд
    // Логика: один ответ на диалог — помечаем все call-сообщения сразу, потом шлём один ответ
    state.pollInterval = setInterval(async () => {
      if (!state.isAway || !state.awayText) return;
      try {
        const dialogs = await client.getDialogs({ limit: 50 });
        for (const dialog of dialogs) {
          if (!dialog.isUser) continue;
          const dialogId = String(dialog.entity?.id);
          // Cooldown по диалогу: один ответ на звонки раз в 5 минут
          const lastCallReply = state.repliedCallDialogs.get(dialogId) || 0;
          if (Date.now() - lastCallReply < 5 * 60 * 1000) continue;
          try {
            const messages = await client.getMessages(dialog.entity, { limit: 10 });
            let hasNewCall = false;
            for (const msg of messages) {
              if (msg.className !== 'MessageService') continue;
              if (msg.action?.className !== 'MessageActionPhoneCall') continue;
              if (state.repliedCalls.has(msg.id)) continue;
              const ageMs = Date.now() - msg.date * 1000;
              state.repliedCalls.add(msg.id); // помечаем все, чтобы не дублировать
              if (ageMs > 5 * 60 * 1000) continue;
              hasNewCall = true;
            }
            if (hasNewCall) {
              state.repliedCallDialogs.set(dialogId, Date.now());
              console.log(`[userbot] ☎️ User ${userId}: missed call from dialog ${dialogId}`);
              await client.sendMessage(dialog.entity, { message: state.awayText });
              console.log(`[userbot] ✅ User ${userId}: replied to call`);
            }
          } catch (e) { /* тихо пропускаем ошибки по отдельным диалогам */ }
        }
      } catch (e) {
        console.error(`[userbot] poll calls error (${userId}):`, e.message);
      }
    }, 15000);
  }

  // Подключить нового пользователя (после авторизации)
  async addUser(userId, sessionStr, opts = {}) {
    if (this.isConnected(userId)) await this.disconnectUser(userId);
    await this._startClient(String(userId), sessionStr, opts);
  }

  async disconnectUser(userId) {
    const state = this.clients.get(String(userId));
    if (!state) return;
    clearInterval(state.pollInterval);
    try { await state.client.disconnect(); } catch (e) {}
    this.clients.delete(String(userId));
    console.log(`[userbot] User ${userId} disconnected`);
  }

  // Включить автоответ
  setAway(userId, text, byAuto = false) {
    const state = this.clients.get(String(userId));
    if (!state) return false;
    state.isAway = true;
    state.awayText = text;
    if (byAuto) state.scheduleByAuto = true;
    return true;
  }

  // Выключить автоответ
  // byAuto=true — выключаем только если включили мы (не перебиваем ручной)
  clearAway(userId, byAuto = false) {
    const state = this.clients.get(String(userId));
    if (!state) return false;
    if (byAuto && !state.scheduleByAuto) return false;
    state.isAway = false;
    state.awayText = '';
    state.scheduleByAuto = false;
    return true;
  }

  // Обновить расписание в памяти
  setSchedule(userId, schedule) {
    const state = this.clients.get(String(userId));
    if (!state) return false;
    state.schedule = schedule;
    return true;
  }

  isConnected(userId) {
    return this.clients.has(String(userId));
  }

  getState(userId) {
    return this.clients.get(String(userId)) || null;
  }
}

module.exports = new UserbotManager();
