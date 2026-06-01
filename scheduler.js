// scheduler.js — Проверяет расписание каждую минуту и включает/выключает автоответ
'use strict';
const cron = require('node-cron');
const userbotManager = require('./userbot');
const { saveUser } = require('./db');

// Должен ли автоответ быть включён прямо сейчас?
// days: 'all' | 'weekdays' | 'weekends' | undefined
function shouldBeAway(from, to, days) {
  const now = new Date();

  // Проверка дней недели
  if (days && days !== 'all') {
    const dow = now.getDay(); // 0=Вс, 1=Пн, ..., 6=Сб
    if (days === 'weekdays' && (dow === 0 || dow === 6)) return false;
    if (days === 'weekends' && dow !== 0 && dow !== 6) return false;
  }

  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const fromMins = fh * 60 + fm;
  const toMins = th * 60 + tm;
  if (fromMins <= toMins) {
    return nowMins >= fromMins && nowMins < toMins;
  }
  return nowMins >= fromMins || nowMins < toMins;
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    for (const [userId, state] of userbotManager.clients) {

      // ── Проверка "включён на время" ──
      if (state.isAway && state.awayUntil && Date.now() > state.awayUntil) {
        userbotManager.clearAway(userId);
        await saveUser(userId, { away: { active: false, text: '', until: null } }).catch(() => {});
        console.log(`[scheduler] User ${userId}: timed away expired`);
        continue;
      }

      // ── Проверка расписания ──
      const sched = state.schedule;
      if (!sched?.enabled || !sched.from || !sched.to || !sched.templateText) continue;

      const shouldBeOn = shouldBeAway(sched.from, sched.to, sched.days);
      const isOn = state.isAway;

      if (shouldBeOn && !isOn) {
        userbotManager.setAway(userId, sched.templateText, { byAuto: true });
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
