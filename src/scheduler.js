// Internal scheduler (server local time, Asia/Bangkok). Replaces cron-job.org.
const cron = require("node-cron");
const { config } = require("./config");
const { sync, onChanges } = require("./sync");
const { runAlerts, notifyChanges } = require("./alerts");
const { runDueSchedules } = require("./reports");
const telegram = require("./telegram");

const lastRuns = {};

function job(name, expr, fn) {
  cron.schedule(
    expr,
    async () => {
      const started = new Date().toISOString();
      try {
        const result = await fn();
        lastRuns[name] = { at: started, ok: true, result };
      } catch (e) {
        lastRuns[name] = { at: started, ok: false, error: e.message };
        console.error(`[scheduler] ${name} failed:`, e.message);
      }
    },
    { timezone: config.tz }
  );
}

function startScheduler() {
  // Every sync that finds date edits emails engineer@ and posts to Telegram.
  onChanges(async (changes) => {
    await notifyChanges(changes);
    await telegram.sendChangesNotice(changes);
  });

  if (config.disableScheduler) {
    console.log("[scheduler] disabled (DISABLE_SCHEDULER=1)");
    return;
  }
  job("sync", config.syncCron, () => sync().then((r) => ({ cases: r.cases.length, changes: r.changes.length })));
  job("alerts", config.alertCron, () => runAlerts());
  job("telegram", config.telegramCron, () => telegram.sendDailySummary());
  job("reports", "*/5 * * * *", () => runDueSchedules());
  console.log(
    `[scheduler] sync "${config.syncCron}", alerts "${config.alertCron}", telegram "${config.telegramCron}", reports every 5 min (${config.tz})`
  );
}

module.exports = { startScheduler, lastRuns };
