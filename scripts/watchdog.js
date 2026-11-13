#!/usr/bin/env node
// Watches the app from outside it: when /health stops answering, tells Teams and Telegram; tells them again when it is back.
// Runs as its own process so it still works when the app (or the database) is down:
//   pm2 start scripts/watchdog.js --name case-v3-watch --time && pm2 save
// The Teams channel is the shared one from Settings ("แจ้งเตือนเข้า Teams"). Its link is kept in data/.watchdog.json
// (mode 600) so a database outage can still be reported.
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { config } = require("../src/config");
const { config3 } = require("../src/v3/config3");

const EVERY_MS = Number(process.env.WATCHDOG_EVERY_MS) || 60000;
const FAILS_BEFORE_ALERT = 2; // a restart during a deploy takes a few seconds: never reported
const REMIND_MS = 30 * 60000;
const STATE = path.join(__dirname, "..", "data", ".watchdog.json");
const URL = `http://127.0.0.1:${config3.port}/health`;

const now = () => new Date().toLocaleString("sv-SE", { timeZone: config.tz || "Asia/Bangkok" });
const log = (...a) => console.log(now(), ...a);
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (e) {
    return {};
  }
};
const save = (s) => {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 });
    fs.chmodSync(STATE, 0o600);
  } catch (e) {
    log("state:", e.message);
  }
};

let st = { fails: 0, downSince: null, alertedAt: 0, teamsUrl: "", ...load() };

async function refreshTeamsUrl() {
  try {
    const { getSetting } = require("../src/v3/db");
    const s = (await getSetting("teams_notify", null)) || {};
    const d = (s.channels || {})._default;
    st.teamsUrl = d && d.url ? d.url : "";
  } catch (e) {
    /* database down: keep the link read last time */
  }
}
async function tell(title, text, color) {
  if (config.dryRunEmail) return log("[DRY RUN]", title, text);
  const telegram = require("../src/telegram");
  await telegram.sendText(`${title}\n${text}`).catch((e) => log("telegram:", e.message));
  if (st.teamsUrl) {
    const { payload } = require("../src/v3/teamsnotify");
    await axios.post(st.teamsUrl, payload({ title, color, text, actions: [["เปิดระบบ", config3.baseUrl]] }), { timeout: 10000, maxRedirects: 0, headers: { "Content-Type": "application/json" } }).catch((e) => log("teams:", e.message));
  }
}
async function check() {
  let problem = "";
  try {
    const r = await axios.get(URL, { timeout: 8000, validateStatus: () => true });
    if (r.status !== 200 || !r.data || r.data.ok !== true) problem = r.data && r.data.error ? String(r.data.error) : `HTTP ${r.status}`;
  } catch (e) {
    problem = e.code === "ECONNREFUSED" ? "แอปไม่ได้ทำงาน (ต่อ port ไม่ได้)" : e.code === "ECONNABORTED" ? "แอปไม่ตอบภายใน 8 วินาที" : e.message;
  }
  if (!problem) {
    if (st.downSince && st.alertedAt) {
      const mins = Math.max(1, Math.round((Date.now() - st.downSince) / 60000));
      log("recovered after", mins, "min");
      await refreshTeamsUrl();
      await tell("✅ Sino Case SLA กลับมาใช้งานได้แล้ว", `หยุดไปประมาณ ${mins} นาที (ตั้งแต่ ${new Date(st.downSince).toLocaleString("th-TH", { timeZone: config.tz })})`, "Good");
    }
    st.fails = 0;
    st.downSince = null;
    st.alertedAt = 0;
    await refreshTeamsUrl();
  } else {
    st.fails++;
    st.downSince = st.downSince || Date.now();
    log("check failed", st.fails, problem);
    if (st.fails >= FAILS_BEFORE_ALERT && Date.now() - st.alertedAt >= REMIND_MS) {
      const first = !st.alertedAt;
      st.alertedAt = Date.now();
      await tell(first ? "🔴 Sino Case SLA ไม่ตอบสนอง" : "🔴 Sino Case SLA ยังไม่กลับมา", `${problem}\nตรวจบน server: pm2 status case-v3 และ pm2 logs case-v3 --lines 50`, "Attention");
    }
  }
  save(st);
}

log(`watching ${URL} every ${EVERY_MS / 1000}s`);
check();
setInterval(check, EVERY_MS);
