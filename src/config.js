// All configuration comes from environment variables (.env on the server).
process.env.TZ = process.env.TZ || "Asia/Bangkok";

const env = process.env;

// The 3 source workbooks (tab "Case List"). Item IDs were resolved from the
// SharePoint links the team shared; /debug shows each file's listItemUniqueId
// so it can be checked against the sourcedoc GUID in those links.
const DEFAULT_SOURCES = [
  {
    key: "ENGAGE",
    label: "Engage / NRX / CXone",
    itemId: "01UECOVNA3CW3DHKJHMRDJ5T5MOYHMWTJ5", // ENGAGE_Engineer_Case_2026.xlsx
    sourcedoc: "33b6151b-27a9-4664-9ecf-ac760ecb4d3d",
  },
  {
    key: "NEXIDIA",
    label: "Nexidia",
    itemId: "01UECOVNHFEOPZ3565SFB2BAGI3YWRYY2C", // NEXIDIA_Engineer_Case_2026 .xlsx
    sourcedoc: "9d9f23e5-ddf7-4391-a080-c8de2d1c6342",
  },
  {
    key: "WFM",
    label: "WFM",
    itemId: "01UECOVNACJWMEUG3FNJGJ75SXXKVR2NZB", // WFM_Engineer_Case_2026 .xlsx
    sourcedoc: "4a984d02-651b-4c6a-9ff6-57baab1d3721",
  },
];

function parseSources() {
  if (!env.SOURCES_JSON) return DEFAULT_SOURCES;
  try {
    return JSON.parse(env.SOURCES_JSON);
  } catch (e) {
    throw new Error("SOURCES_JSON is not valid JSON: " + e.message);
  }
}

const config = {
  port: Number(env.PORT || 3001),
  tz: env.TZ,
  mock: env.MOCK_DATA === "1",
  dryRunEmail: env.DRY_RUN_EMAIL === "1",

  // Microsoft Graph (app registration, client credentials)
  tenantId: env.TENANT_ID,
  clientId: env.CLIENT_ID,
  clientSecret: env.CLIENT_SECRET,
  driveId:
    env.DRIVE_ID || "b!qpaZ9OhqlUaqsykcugfzCTBpF9hgIiFGvnFzY5-degAK78KRnSxrRqnfG8KbUwbl",
  sheetName: env.SHEET_NAME || "Case List",
  sources: parseSources(),

  // Email (sent from an Outlook mailbox through Graph /users/{sender}/sendMail)
  mailSender: env.MAIL_SENDER, // e.g. case-alert@sinostech.co.th
  alertCc: (env.ALERT_CC || "engineer@sinostech.co.th")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  dashboardUrl: env.DASHBOARD_URL || "", // e.g. https://case.baanpin.com

  // SLA
  slaDays: Number(env.SLA_DAYS || 7),
  alert1Day: Number(env.ALERT1_DAY || 3),
  alert2Day: Number(env.ALERT2_DAY || 6),
  closedStatuses: (env.CLOSED_STATUSES || "Success,Cancel,N/A,Resolved")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Schedules (cron syntax, server local time = Asia/Bangkok)
  alertCron: env.ALERT_CRON || "0 8 * * *",
  syncCron: env.SYNC_CRON || "*/15 * * * *",
  telegramCron: env.TELEGRAM_CRON || "5 8 * * *",
  disableScheduler: env.DISABLE_SCHEDULER === "1",

  // Telegram (kept for the overall daily summary)
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  telegramChatId: env.TELEGRAM_CHAT_ID,

  // Supabase (snapshots, alert log, audit log, report schedules)
  supabaseUrl: env.SUPABASE_URL,
  supabaseKey: env.SUPABASE_SERVICE_KEY,

  // Security
  runSecret: env.RUN_SECRET,
  dashboardUser: env.DASHBOARD_USER,
  dashboardPass: env.DASHBOARD_PASS,
};

function missingEnv() {
  if (config.mock) return [];
  const need = {
    TENANT_ID: config.tenantId,
    CLIENT_ID: config.clientId,
    CLIENT_SECRET: config.clientSecret,
    MAIL_SENDER: config.mailSender,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SERVICE_KEY: config.supabaseKey,
    RUN_SECRET: config.runSecret,
    DASHBOARD_USER: config.dashboardUser,
    DASHBOARD_PASS: config.dashboardPass,
  };
  return Object.entries(need)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

module.exports = { config, missingEnv };
