// scheduler.js — Проверяет расписание каждую минуту и включает/выключает автоответ
'use strict';
const cron = require('node-cron');
const userbotManager = require('./userbot');
const { saveUser } = require('./db');

// Должен ли автоответ быть включён прямо сейчас?
function shouldBeAway(from, to) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const fromMins = fh * 60 + fm;
  const toMins = th * 60 + tm;
  if (fromMins <= toMins) {
    // Дневной диапазон, например 09:00–18:00
    return nowMins >= fromMins && nowMins < toMins;
  }
  // Ночной диапазон, например 22:00–09:00
  return nowMins >= fromMins || nowMins < toMins;
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    for (const [userId, state] of userbotManager.clients) {
      const sched = state.schedule;
      if (!sched?.enabled || !sched.from || !sched.to || !sched.templateText) continue;

      const shouldBeOn = shouldBeAway(sched.from, sched.to);
      const isOn = state.isAway;

      if (shouldBeOn && !isOn) {
        userbotManager.setAway(userId, sched.templateText, true);
        await saveUser(userId, { away: { active: true, text: sched.templateText } }).catch(() => {});
        console.log(`[scheduler] User ${userId}: away ON (${sched.from}–${sched.to})`);
      } else if (!shouldBeOn && isOn && state.scheduleByAuto) {
        userbotManager.clearAway(userId, true);
        await saveUser(userId, { away: { active: false, text: '' } }).catch(() => {});
        console.log(`[scheduler] User ${userId}: away OFF (schedule ended)`);
      }
    }
  });
  console.log('[scheduler] Started — checking every minute');
}

module.exports = { startScheduler, shouldBeAway };
