// index.js — ReplyLater Bot
'use strict';
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const { initDB, saveUser, updateUser, getUser, getTemplates, saveTemplate, deleteTemplate } = require('./db');
const { encrypt } = require('./crypto');
const userbotManager = require('./userbot');
const { startScheduler } = require('./scheduler');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID    = parseInt(process.env.TG_API_ID || '0');
const API_HASH  = process.env.TG_API_HASH || '';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Auth state ────────────────────────────────────────────────────────────────
// Хранит resolve-функции для GramJS auth callbacks
const authCallbacks = new Map(); // `${userId}_phone/code/2fa` -> resolve fn
// Хранит temp клиент во время авторизации
const authClients   = new Map(); // userId -> { client }

// ── Menu state ────────────────────────────────────────────────────────────────
// Хранит состояние ввода для создания/редактирования шаблонов и расписания
const userState = new Map();
// { step: string, data: object }

// ── Keyboard ──────────────────────────────────────────────────────────────────
function mainKeyboard(isAway) {
  return {
    keyboard: [
      [isAway ? '🔴 Выключить автоответчик' : '🟢 Включить автоответчик'],
      ['📋 Шаблоны', '⏰ По расписанию']
    ],
    resize_keyboard: true
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, opts).catch(e => {
    console.error(`[bot] send error to ${chatId}:`, e.message);
  });
}

async function requireConnected(userId) {
  const user = await getUser(userId);
  if (!user?.connected) {
    await send(userId, 'Сначала подключи аккаунт — нажми /start');
    return false;
  }
  return true;
}

// ── Экраны ────────────────────────────────────────────────────────────────────

// Главный экран — статус + нужная клавиатура
async function showMain(userId) {
  const user = await getUser(userId);
  const away = user?.away || {};
  const isAway = away.active || false;

  const text = isAway
    ? `🟢 *Автоответчик включён*\n\n_«${away.text}»_`
    : '⚪️ *Автоответчик выключен*';

  await send(userId, text, {
    parse_mode: 'Markdown',
    reply_markup: mainKeyboard(isAway)
  });
}

// Включить автоответчик — выбор шаблона (или сразу включить если один)
async function showTurnOn(userId) {
  const templates = await getTemplates(userId);
  if (templates.length === 0) {
    await send(userId,
      '⚪️ *Автоответчик выключен*\n\nСначала создай шаблон — он будет отправляться в ответ на сообщения и звонки.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📋 Создать шаблон', callback_data: 'tpl_create' }]]
        }
      }
    );
    return;
  }
  const rows = templates.map(t => [{ text: `▶️ ${t.name}`, callback_data: `auto_on:${t.id}` }]);
  await send(userId, 'Выбери шаблон для автоответа:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  });
}

async function showTemplates(userId) {
  const templates = await getTemplates(userId);

  if (templates.length === 0) {
    await send(userId, '📋 *Шаблоны*\n\nУ тебя пока нет шаблонов.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '➕ Создать шаблон', callback_data: 'tpl_create' }]]
      }
    });
    return;
  }

  let text = '📋 *Шаблоны*\n\n';
  const rows = [];

  for (const t of templates) {
    const preview = t.text.length > 50 ? t.text.slice(0, 50) + '…' : t.text;
    text += `*${t.name}*\n_«${preview}»_\n\n`;
    rows.push([
      { text: '✏️ Текст',      callback_data: `tpl_edit:${t.id}` },
      { text: '📝 Имя',        callback_data: `tpl_rename:${t.id}` },
      { text: '🗑️ Удалить',   callback_data: `tpl_delete:${t.id}` }
    ]);
  }

  if (templates.length < 5) {
    rows.push([{ text: '➕ Создать шаблон', callback_data: 'tpl_create' }]);
  }

  await send(userId, text.trim(), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  });
}

async function showSchedule(userId) {
  const user = await getUser(userId);
  const sched = user?.schedule;

  if (!sched?.enabled) {
    await send(userId,
      '⏰ *Автоответ по расписанию*\n\nРасписание не настроено.\n\nНапример: автоответ включается каждый день с 22:00 до 09:00 — и выключается сам.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📅 Настроить', callback_data: 'sched_setup' }]]
        }
      }
    );
  } else {
    const preview = sched.templateText?.slice(0, 50) || '';
    await send(userId,
      `⏰ *Автоответ по расписанию*\n\nВключается с *${sched.from}* до *${sched.to}* автоматически.\n\n_«${preview}»_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Изменить', callback_data: 'sched_setup' }],
            [{ text: '❌ Отключить', callback_data: 'sched_disable' }]
          ]
        }
      }
    );
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function initiateAuth(userId) {
  if (authClients.has(userId)) {
    await send(userId, '⏳ Авторизация уже идёт. Жди запроса или напиши /cancel для отмены.');
    return;
  }

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 3
  });
  authClients.set(userId, { client });

  client.start({
    phoneNumber: () => new Promise(resolve => {
      authCallbacks.set(`${userId}_phone`, resolve);
      send(userId, '📱 Введи свой номер телефона (например: +79001234567):');
    }),
    phoneCode: () => new Promise(resolve => {
      authCallbacks.set(`${userId}_code`, resolve);
      send(userId, '🔐 Telegram отправил тебе код.\n\nВведи его *с пробелами* (например: `1 2 3 4 5`)',
        { parse_mode: 'Markdown' });
    }),
    password: () => new Promise(resolve => {
      authCallbacks.set(`${userId}_2fa`, resolve);
      send(userId, '🔑 Введи пароль двухфакторной аутентификации:');
    }),
    onError: (err) => {
      console.error(`[auth] Error for user ${userId}:`, err.message);
      send(userId, `❌ Ошибка: ${err.message}\n\nПопробуй снова — нажми /start`);
      cleanupAuth(userId);
    }
  }).then(async () => {
    const sessionStr = client.session.save();
    const encSession = encrypt(sessionStr);

    await saveUser(userId, {
      connected: true,
      encryptedSession: encSession,
      away: { active: false, text: '' },
      schedule: null
    });
    await userbotManager.addUser(String(userId), sessionStr);
    cleanupAuth(userId);

    await send(userId, '✅ Аккаунт успешно подключён!\n\nТеперь можешь включить автоответчик.');
    await showMain(userId);
  }).catch(async (err) => {
    console.error(`[auth] Failed for user ${userId}:`, err.message);
    await send(userId, '❌ Не удалось подключить аккаунт. Попробуй снова — нажми /start');
    cleanupAuth(userId);
  });
}

function cleanupAuth(userId) {
  authCallbacks.delete(`${userId}_phone`);
  authCallbacks.delete(`${userId}_code`);
  authCallbacks.delete(`${userId}_2fa`);
  authClients.delete(userId);
}

function resolveAuthStep(userId, value) {
  const phoneRes = authCallbacks.get(`${userId}_phone`);
  if (phoneRes) {
    authCallbacks.delete(`${userId}_phone`);
    phoneRes(value);
    return true;
  }
  const codeRes = authCallbacks.get(`${userId}_code`);
  if (codeRes) {
    authCallbacks.delete(`${userId}_code`);
    codeRes(value.replace(/\s/g, '')); // убираем пробелы из кода
    return true;
  }
  const tfaRes = authCallbacks.get(`${userId}_2fa`);
  if (tfaRes) {
    authCallbacks.delete(`${userId}_2fa`);
    tfaRes(value);
    return true;
  }
  return false;
}

// ── /start и /cancel ──────────────────────────────────────────────────────────

bot.onText(/^\/start$/, async (msg) => {
  const userId = msg.from.id;
  const user = await getUser(userId);

  if (!user?.connected) {
    await send(userId,
      '👋 Привет! Я *ReplyLater* — автоответчик для Telegram.\n\n' +
      'Когда ты занят — автоматически отвечу на сообщения и звонки твоим текстом.\n\n' +
      'Для начала подключи свой Telegram-аккаунт:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔗 Подключить аккаунт', callback_data: 'connect' }]]
        }
      }
    );
  } else {
    await showMain(userId);
  }
});

bot.onText(/^\/cancel$/, async (msg) => {
  const userId = msg.from.id;
  cleanupAuth(userId);
  userState.delete(userId);
  await showMain(userId);
});

// ── Message handler ───────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const userId = msg.from.id;
  const text   = msg.text.trim();

  if (text.startsWith('/')) return; // команды обрабатываются отдельно

  // Авторизация в процессе — пробрасываем ввод в auth callback
  if (authClients.has(userId)) {
    resolveAuthStep(userId, text);
    return;
  }

  // Ввод данных (создание шаблона, расписание и т.д.)
  const state = userState.get(userId);
  if (state) {
    await handleStateInput(userId, text, state);
    return;
  }

  // Кнопки главного меню
  if (!(await requireConnected(userId))) return;

  switch (text) {
    case '🟢 Включить автоответчик':   await showTurnOn(userId);    break;
    case '🔴 Выключить автоответчик': {
      userbotManager.clearAway(String(userId));
      await saveUser(userId, { away: { active: false, text: '' } });
      await showMain(userId);
      break;
    }
    case '📋 Шаблоны':        await showTemplates(userId);  break;
    case '⏰ По расписанию':  await showSchedule(userId);   break;
  }
});

// ── Обработка ввода по шагам ──────────────────────────────────────────────────

async function handleStateInput(userId, text, state) {
  switch (state.step) {

    case 'create_tpl_name': {
      if (text.length > 30) {
        await send(userId, '❌ Имя слишком длинное (макс. 30 символов). Попробуй ещё раз:');
        return; // не удаляем state
      }
      userState.set(userId, { step: 'create_tpl_text', data: { name: text } });
      await send(userId, `Теперь введи *текст* автоответа для шаблона «${text}»:`,
        { parse_mode: 'Markdown' });
      break;
    }

    case 'create_tpl_text': {
      userState.delete(userId);
      const templateId = Date.now().toString();
      await saveTemplate(userId, templateId, {
        name: state.data.name,
        text,
        createdAt: Date.now()
      });
      await send(userId, `✅ Шаблон *${state.data.name}* создан!`, { parse_mode: 'Markdown' });
      await showTemplates(userId);
      break;
    }

    case 'edit_tpl_text': {
      userState.delete(userId);
      await saveTemplate(userId, state.data.templateId, { text });
      // Если этот шаблон сейчас активен — обновляем живой текст
      const user = await getUser(userId);
      if (user?.away?.active && user.away.templateId === state.data.templateId) {
        await updateUser(userId, { 'away.text': text });
        userbotManager.setAway(String(userId), text);
      }
      await send(userId, '✅ Текст шаблона обновлён!');
      await showTemplates(userId);
      break;
    }

    case 'rename_tpl': {
      if (text.length > 30) {
        await send(userId, '❌ Имя слишком длинное (макс. 30 символов). Попробуй ещё раз:');
        return;
      }
      userState.delete(userId);
      await saveTemplate(userId, state.data.templateId, { name: text });
      await send(userId, '✅ Шаблон переименован!');
      await showTemplates(userId);
      break;
    }

    case 'schedule_from': {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await send(userId, '❌ Неверный формат. Введи время в виде ЧЧ:ММ (например: 22:00)');
        return;
      }
      userState.set(userId, { step: 'schedule_to', data: { ...state.data, from: text } });
      await send(userId, `До какого времени? (ЧЧ:ММ, например: 09:00)`);
      break;
    }

    case 'schedule_to': {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await send(userId, '❌ Неверный формат. Введи время в виде ЧЧ:ММ (например: 09:00)');
        return;
      }
      userState.delete(userId);
      const schedule = {
        enabled:      true,
        from:         state.data.from,
        to:           text,
        templateText: state.data.templateText
      };
      await saveUser(userId, { schedule });
      userbotManager.setSchedule(String(userId), schedule);
      await send(userId,
        `✅ Расписание настроено!\n\nАвтоответ будет включаться с *${state.data.from}* до *${text}*`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    default:
      userState.delete(userId);
  }
}

// ── Callback queries ──────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data   = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    // Подключить аккаунт
    if (data === 'connect') {
      await initiateAuth(userId);

    // Выключить автоответчик
    } else if (data === 'auto_off') {
      userbotManager.clearAway(String(userId));
      await saveUser(userId, { away: { active: false, text: '' } });
      await showMain(userId);

    // Включить автоответчик с шаблоном
    } else if (data.startsWith('auto_on:')) {
      const templateId = data.slice(8);
      const templates  = await getTemplates(userId);
      const tpl        = templates.find(t => t.id === templateId);
      if (!tpl) { await send(userId, '❌ Шаблон не найден.'); return; }

      await saveUser(userId, { away: { active: true, text: tpl.text, templateId } });
      userbotManager.setAway(String(userId), tpl.text);
      await showMain(userId);

    // Создать шаблон
    } else if (data === 'tpl_create') {
      const templates = await getTemplates(userId);
      if (templates.length >= 5) {
        await send(userId, '❌ Максимум 5 шаблонов. Удали один, чтобы создать новый.');
        return;
      }
      userState.set(userId, { step: 'create_tpl_name', data: {} });
      await send(userId, '📝 Введи *название* шаблона (например: "На практике"):',
        { parse_mode: 'Markdown' });

    // Редактировать текст шаблона
    } else if (data.startsWith('tpl_edit:')) {
      const templateId = data.slice(9);
      userState.set(userId, { step: 'edit_tpl_text', data: { templateId } });
      await send(userId, '✏️ Введи новый текст автоответа:');

    // Переименовать шаблон
    } else if (data.startsWith('tpl_rename:')) {
      const templateId = data.slice(11);
      userState.set(userId, { step: 'rename_tpl', data: { templateId } });
      await send(userId, '📝 Введи новое название шаблона:');

    // Удалить шаблон — запрос подтверждения
    } else if (data.startsWith('tpl_delete:')) {
      const templateId = data.slice(11);
      const templates  = await getTemplates(userId);
      const tpl        = templates.find(t => t.id === templateId);
      if (!tpl) { await send(userId, '❌ Шаблон не найден.'); return; }
      await send(userId, `Удалить шаблон *${tpl.name}*?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да, удалить', callback_data: `tpl_del_ok:${templateId}` }],
            [{ text: '↩️ Отмена',      callback_data: 'tpl_list' }]
          ]
        }
      });

    // Удалить шаблон — подтверждено
    } else if (data.startsWith('tpl_del_ok:')) {
      const templateId = data.slice(11);
      await deleteTemplate(userId, templateId);
      const user = await getUser(userId);
      if (user?.away?.active && user.away.templateId === templateId) {
        await saveUser(userId, { away: { active: false, text: '' } });
        userbotManager.clearAway(String(userId));
      }
      await send(userId, '✅ Шаблон удалён.');
      await showTemplates(userId);

    // Показать список шаблонов
    } else if (data === 'tpl_list') {
      await showTemplates(userId);

    // Настроить расписание — выбор шаблона
    } else if (data === 'sched_setup') {
      const templates = await getTemplates(userId);
      if (templates.length === 0) {
        await send(userId, '❌ Сначала создай шаблон в разделе 📋 Шаблоны.');
        return;
      }
      const rows = templates.map(t => [{ text: t.name, callback_data: `sched_tpl:${t.id}` }]);
      await send(userId, 'Выбери шаблон для расписания:', {
        reply_markup: { inline_keyboard: rows }
      });

    // Расписание — шаблон выбран, запрашиваем время
    } else if (data.startsWith('sched_tpl:')) {
      const templateId = data.slice(10);
      const templates  = await getTemplates(userId);
      const tpl        = templates.find(t => t.id === templateId);
      if (!tpl) { await send(userId, '❌ Шаблон не найден.'); return; }
      userState.set(userId, { step: 'schedule_from', data: { templateId, templateText: tpl.text } });
      await send(userId,
        `Шаблон: *${tpl.name}*\n\nС какого времени включать автоответ? (ЧЧ:ММ, например: 22:00)`,
        { parse_mode: 'Markdown' }
      );

    // Отключить расписание
    } else if (data === 'sched_disable') {
      const state = userbotManager.getState(String(userId));
      if (state?.scheduleByAuto) {
        userbotManager.clearAway(String(userId), true);
        await saveUser(userId, { away: { active: false, text: '' } });
      }
      userbotManager.setSchedule(String(userId), null);
      await saveUser(userId, { schedule: { enabled: false } });
      await send(userId, '✅ Расписание отключено.');
    }

  } catch (e) {
    console.error(`[bot] Callback error (user ${userId}, data="${data}"):`, e.message);
    await send(userId, '❌ Что-то пошло не так. Попробуй ещё раз.');
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('[bot] Polling error:', err.message);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  initDB();
  await userbotManager.loadAll();
  startScheduler();
  console.log('[bot] ReplyLater started ✅');
}

main().catch(console.error);
