// Background jobs for v3: owner alerts, Telegram summary, manager reports, retention, yearly report.
const cron = require("node-cron");
const ExcelJS = require("exceljs");
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { caseAlertEmail, reportEmail } = require("../emails");
const { alertFor } = require("../alerts");
const { recipientsFor, defaultRules, splitList: splitEmails } = require("../alertRecipients");
const reports = require("../reports");
const telegram = require("../telegram");
const d = require("../dates");
const { q, one, all, getSetting, tx } = require("./db");
const repo = require("./caserepo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastRuns = {};

// ------------------------------------------------------------ shared loaders
async function teams() {
  return (await all("SELECT code AS key, label FROM teams ORDER BY sort")).map((t) => ({ ...t }));
}

async function listChanges({ from, limit = 500, caseIds } = {}) {
  const p = [];
  const cond = [];
  if (from) {
    p.push(from);
    cond.push(`detected_at >= $${p.length}`);
  }
  if (caseIds) {
    p.push(caseIds);
    cond.push(`case_id = ANY($${p.length})`);
  }
  p.push(limit);
  const rows = await all(
    `SELECT * FROM case_changes ${cond.length ? "WHERE " + cond.join(" AND ") : ""} ORDER BY detected_at DESC LIMIT $${p.length}`,
    p
  );
  // Same field names the v2 dashboard and reports use.
  return rows.map((r) => ({
    ...r,
    case_key: `v3:${r.case_id}`,
    source: r.team,
    owner: r.owner_name,
    last_modified_by: r.changed_by_name,
  }));
}

// ------------------------------------------------------------ owner alerts
async function alertRules() {
  const def = defaultRules();
  const s = await getSetting("alert_email", null);
  return s ? { cc: s.cc, ccTypes: s.ccTypes || [], fallback: s.fallback } : { cc: def.cc.join(", "), ccTypes: def.ccTypes, fallback: def.fallback.join(", ") };
}
async function runAlerts({ dryRun = false } = {}) {
  const cases = await repo.loadCases(null, { where: "c.closed_at IS NULL" });
  const todayIso = d.toISODate(d.today());
  const due = cases.map((c) => ({ c, ...(alertFor(c, todayIso) || {}) })).filter((x) => x.type);
  const keys = due.map((x) => x.dedupe);
  const sent = new Set(
    keys.length ? (await all("SELECT dedupe_key FROM alert_log WHERE ok AND dedupe_key = ANY($1)", [keys])).map((r) => r.dedupe_key) : []
  );
  const todo = due.filter((x) => !sent.has(x.dedupe)).sort((a, b) => (b.c.age || 0) - (a.c.age || 0));
  const result = { candidates: due.length, alreadySent: due.length - todo.length, sent: 0, failed: 0, items: [] };
  if (dryRun) {
    result.items = todo.map((x) => ({ case: x.c.csNumber || x.c.id, owner: x.c.owner, type: x.type }));
    return result;
  }
  const rules = await alertRules();
  for (const x of todo) {
    const c = x.c;
    const { subject, html } = caseAlertEmail(c, x.type);
    const { to, cc, noOwner } = recipientsFor(c, x.type, rules);
    const finalSubject = noOwner ? `[ไม่พบอีเมล Owner] ${subject}` : subject;
    let ok = true;
    let error = null;
    let dry = false;
    try {
      const r = await graph.sendMail({ to, cc, subject: finalSubject, html });
      dry = !!r.dryRun;
      result.sent++;
    } catch (e) {
      ok = false;
      error = String(e.response?.data?.error?.message || e.message).slice(0, 500);
      result.failed++;
    }
    if (!dry) {
      await q(
        `INSERT INTO alert_log (dedupe_key, case_id, team, cs_number, owner, owner_email, site, alert_type, case_age,
           to_list, cc_list, subject, ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [x.dedupe, c.id, c.team, c.csNumber || null, c.owner, c.ownerEmail, c.site, x.type, c.age, to.join(","),
          cc.join(","), finalSubject, ok, error]
      ).catch((e) => console.error("[v3 alerts] log:", e.message));
      if (ok) {
        const label = { r1: "แจ้งเตือนรอบ 1", r2: "แจ้งเตือนรอบ 2", overdue: "แจ้งเกิน Due" }[x.type];
        await tx((cl) => repo.addActivity(cl, c.id, null, { kind: "ระบบ", detail: `ส่ง email ${label} ถึง ${to.join(", ")}`, system: true }))
          .catch(() => {});
      }
    }
    result.items.push({ case: c.csNumber || c.id, owner: c.owner, type: x.type, ok });
    await sleep(config.mock ? 0 : 2500);
  }
  return result;
}

// ------------------------------------------------------------ Telegram summary
async function sendTelegram() {
  const cases = await repo.loadCases(null);
  return telegram.sendDailySummary({ cases, sources: await teams(), listChanges: listChanges });
}

// ------------------------------------------------------------ manager reports
function splitList(s) {
  return String(s || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /@/.test(x));
}

// ------------------------------------------------------------ customer (site) filter + summary sheet
function siteList(v) {
  const arr = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
}
function filterSites(cases, sites) {
  if (!sites.length) return cases;
  const want = new Set(sites.map((x) => x.toLowerCase()));
  return cases.filter((c) => want.has(String(c.site || "").toLowerCase()));
}
function sitesLabel(sites) {
  if (!sites.length) return "";
  return sites.length <= 3 ? sites.join(", ") : `${sites.slice(0, 3).join(", ")} และอีก ${sites.length - 3} ราย`;
}
/** Adds a per-customer summary sheet to a report workbook buffer. */
async function addCustomerSheet(buf, rep) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const by = new Map();
  const row = (c) => {
    const k = c.site || "(ไม่ระบุ)";
    if (!by.has(k)) by.set(k, { site: k, opened: 0, closed: 0, onTime: 0, open: 0, overdue: 0 });
    return by.get(k);
  };
  rep.openedCases.forEach((c) => row(c).opened++);
  rep.closedCases.forEach((c) => {
    const r = row(c);
    r.closed++;
    if (c.closedOnTime === true) r.onTime++;
  });
  rep.openCases.forEach((c) => {
    const r = row(c);
    r.open++;
    if (c.stage === "overdue") r.overdue++;
  });
  const ws = wb.addWorksheet("สรุปรายลูกค้า", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "ลูกค้า / Site", key: "site", width: 30 },
    { header: "เปิดใหม่ในช่วง", key: "opened", width: 14 },
    { header: "ปิดในช่วง", key: "closed", width: 12 },
    { header: "ปิดทัน SLA", key: "onTime", width: 12 },
    { header: "% ทัน SLA", key: "pct", width: 11 },
    { header: "ยังเปิดอยู่", key: "open", width: 12 },
    { header: "เกิน Due ขณะนี้", key: "overdue", width: 15 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  [...by.values()]
    .sort((a, b) => b.open + b.opened - (a.open + a.opened) || a.site.localeCompare(b.site))
    .forEach((r) => ws.addRow({ ...r, pct: r.closed ? Math.round((r.onTime / r.closed) * 100) / 100 : null }));
  ws.getColumn("pct").numFmt = "0%";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function sendReport({ title, recipients, cc, from, to, owner, sites = [], attachExcel = true, scheduleId = null, user = null }) {
  const cases = filterSites(await repo.loadCases(user), sites);
  const changes = await listChanges({ from: from.toISOString(), limit: 5000, caseIds: sites.length ? cases.map((c) => c.id) : undefined });
  const rep = await reports.buildReport({ from, to, owner, cases, changes });
  title = (title || "รายงานสถานะเคส") + (sites.length ? ` · ลูกค้า ${sitesLabel(sites)}` : "");
  const { subject, html } = reportEmail(rep, title);
  const toList = splitList(recipients);
  const ccList = splitList(cc);
  if (!toList.length) throw Object.assign(new Error("ไม่มีอีเมลผู้รับ"), { status: 400 });
  const fileName = `case-report-${d.toISODate(from)}_${d.toISODate(to)}.xlsx`;
  const attachments = attachExcel
    ? [{ name: fileName, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await addCustomerSheet(await reports.reportWorkbook(rep), rep) }]
    : [];
  let ok = true;
  let error = null;
  let dryRun = false;
  try {
    dryRun = !!(await graph.sendMail({ to: toList, cc: ccList, subject, html, attachments })).dryRun;
  } catch (e) {
    ok = false;
    error = String(e.response?.data?.error?.message || e.message).slice(0, 500);
  }
  await q(
    `INSERT INTO report_log (schedule_id, title, range_from, range_to, recipients, cc, file_name, ok, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [scheduleId, title, d.toISODate(from), d.toISODate(to), toList.join(","), ccList.join(","),
      attachExcel ? fileName : null, ok, dryRun ? "DRY_RUN_EMAIL=1 (ไม่ได้ส่งจริง)" : error]
  ).catch((e) => console.error("[v3 report] log:", e.message));
  if (!ok) throw new Error(error);
  return { ok, dryRun, subject, recipients: toList };
}

function scheduleMatchesNow(s, now) {
  const isoDow = ((now.getDay() + 6) % 7) + 1;
  if (s.frequency === "weekly" && Number(s.day_of_week) !== isoDow) return false;
  if (s.frequency === "monthly" && Number(s.day_of_month) !== now.getDate()) return false;
  const [hh, mm] = String(s.send_time || "08:30").split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

async function runDueSchedules(now = new Date()) {
  const out = [];
  const todayIso = d.toISODate(d.startOfDay(now));
  for (const s of await all("SELECT * FROM report_schedules WHERE enabled")) {
    if (s.last_period === todayIso || !scheduleMatchesNow(s, now)) continue;
    const { from, to } = reports.resolveRange(s.range_type, d.startOfDay(now));
    try {
      await sendReport({ title: s.name, recipients: s.recipients, cc: s.cc, from, to, attachExcel: s.attach_excel, scheduleId: s.id });
      out.push({ id: s.id, ok: true });
    } catch (e) {
      out.push({ id: s.id, ok: false, error: e.message });
    }
    await q("UPDATE report_schedules SET last_period=$1, last_sent_at=now() WHERE id=$2", [todayIso, s.id]);
  }
  return out;
}

// ------------------------------------------------------------ retention (2 years by default)
async function runRetention() {
  const years = Number(await getSetting("retention_years", 2)) || 2;
  const cut = `now() - interval '${years} years'`;
  const r = {};
  r.cases = (await q(`DELETE FROM cases WHERE closed_at IS NOT NULL AND closed_at < ${cut}`)).rowCount;
  r.changes = (await q(`DELETE FROM case_changes WHERE detected_at < ${cut}`)).rowCount;
  r.alerts = (await q(`DELETE FROM alert_log WHERE sent_at < ${cut}`)).rowCount;
  r.reports = (await q(`DELETE FROM report_log WHERE sent_at < ${cut}`)).rowCount;
  r.audit = (await q(`DELETE FROM audit_log WHERE at < ${cut}`)).rowCount;
  r.resets = (await q("DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'")).rowCount;
  return { years, ...r };
}

// ------------------------------------------------------------ yearly report
async function buildAnnualWorkbook(year, { toDate } = {}) {
  const from = new Date(year, 0, 1);
  const to = toDate || new Date(year, 11, 31);
  const cases = await repo.loadCases(null);
  const changes = await listChanges({ from: from.toISOString(), limit: 100000 });
  const rep = await reports.buildReport({ from, to, cases, changes });
  const buf = await reports.reportWorkbook(rep);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  // Monthly summary sheet first
  const ws = wb.addWorksheet("สรุปรายเดือน", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "เดือน", key: "m", width: 14 },
    { header: "เปิดใหม่", key: "opened", width: 10 },
    { header: "ปิด", key: "closed", width: 10 },
    { header: "ปิดทัน SLA", key: "onTime", width: 12 },
    { header: "% ทัน SLA", key: "pct", width: 11 },
  ];
  ws.getRow(1).font = { bold: true };
  const TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const totals = { opened: 0, closed: 0, onTime: 0 };
  for (let m = 0; m < 12; m++) {
    const a = new Date(year, m, 1);
    const b = new Date(year, m + 1, 0);
    if (a > to) break;
    const inM = (x) => x && x >= a && x <= b;
    const opened = cases.filter((c) => inM(c.startDate)).length;
    const closed = cases.filter((c) => c.stage === "closed" && inM(c.endDate));
    const onTime = closed.filter((c) => c.closedOnTime === true).length;
    totals.opened += opened;
    totals.closed += closed.length;
    totals.onTime += onTime;
    ws.addRow({ m: `${TH[m]} ${year + 543}`, opened, closed: closed.length, onTime, pct: closed.length ? Math.round((onTime / closed.length) * 100) : null });
  }
  const tr = ws.addRow({ m: "รวมทั้งปี", ...totals, pct: totals.closed ? Math.round((totals.onTime / totals.closed) * 100) : null });
  tr.font = { bold: true };
  // Open the file on the monthly summary tab.
  wb.views = [{ activeTab: wb.worksheets.length - 1, firstSheet: 0, visibility: "visible" }];
  return { rep, buffer: Buffer.from(await wb.xlsx.writeBuffer()), totals };
}

async function runAnnual(year = new Date().getFullYear() - 1, { test = false } = {}) {
  const cfg = await getSetting("annual_report", { recipients: "", cc: "" });
  const toDate = test ? d.today() : undefined;
  const { rep, buffer } = await buildAnnualWorkbook(year, { toDate });
  const fileName = `case-annual-${year}${test ? "-ytd" : ""}.xlsx`;
  const title = test ? `[ทดสอบ] รายงานประจำปี ${year + 543} (ถึงวันนี้)` : `รายงานประจำปี ${year + 543}`;
  const { subject, html } = reportEmail(rep, title);
  const toList = splitList(cfg.recipients);
  let ok = true;
  let error = null;
  if (toList.length) {
    try {
      await graph.sendMail({
        to: toList, cc: splitList(cfg.cc), subject, html,
        attachments: [{ name: fileName, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer }],
      });
    } catch (e) {
      ok = false;
      error = String(e.response?.data?.error?.message || e.message).slice(0, 500);
    }
  } else {
    ok = false;
    error = "ยังไม่ได้ตั้งอีเมลผู้รับรายงานรายปี";
  }
  if (!test) {
    await q(
      `INSERT INTO annual_reports (year, file_name, file, recipients, ok, error) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (year) DO UPDATE SET created_at=now(), file_name=EXCLUDED.file_name, file=EXCLUDED.file,
         recipients=EXCLUDED.recipients, ok=EXCLUDED.ok, error=EXCLUDED.error`,
      [year, fileName, buffer, toList.join(","), ok, error]
    );
  }
  return { year, ok, error, recipients: toList, fileName };
}

// ------------------------------------------------------------ scheduler
function job(name, expr, enabled, fn) {
  if (!enabled) return;
  cron.schedule(
    expr,
    async () => {
      const at = new Date().toISOString();
      try {
        lastRuns[name] = { at, ok: true, result: await fn() };
      } catch (e) {
        lastRuns[name] = { at, ok: false, error: e.message };
        console.error(`[v3 job] ${name}:`, e.message);
      }
    },
    { timezone: config.tz }
  );
}

// ------------------------------------------------------------ HTTPS certificate expiry
function certInfo() {
  const file = config3.https.cert;
  if (!config3.https.port || !file) return null;
  try {
    const x = new (require("crypto").X509Certificate)(require("fs").readFileSync(file));
    const validTo = new Date(x.validTo);
    return { subject: x.subject.replace(/\n/g, ", "), issuer: x.issuer.split("\n").find((l) => l.startsWith("O=")) || x.issuer, validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - Date.now()) / 86400000) };
  } catch (e) {
    return { error: e.message };
  }
}
async function checkCert() {
  const c = certInfo();
  if (!c || c.error || c.daysLeft > 21) return { ok: true, cert: c };
  const msg = `ใบรับรอง HTTPS ของ ${config3.baseUrl} จะหมดอายุในอีก ${c.daysLeft} วัน (${c.validTo.slice(0, 10)}) ต่ออายุด้วยคำสั่ง acme.sh --renew ตามขั้นตอนในคู่มือติดตั้ง`;
  await telegram.sendText("⚠️ " + msg).catch((e) => console.error("[cert] telegram:", e.message));
  const to = splitList(config3.bootstrapAdmin);
  if (to.length) await graph.sendMail({ to, cc: [], subject: `[Sino Case SLA] ใบรับรอง HTTPS เหลือ ${c.daysLeft} วัน`, html: `<p>${msg}</p>` }).catch((e) => console.error("[cert] mail:", e.message));
  return { ok: true, warned: true, cert: c };
}

function startJobs() {
  if (config3.disableScheduler) return console.log("[v3 jobs] scheduler disabled");
  const j = config3.jobs;
  job("alerts", config.alertCron, j.alerts, () => runAlerts());
  job("telegram", config.telegramCron, j.telegram, () => sendTelegram());
  job("reports", "*/5 * * * *", j.reports, () => runDueSchedules());
  job("retention", "0 2 * * *", j.retention, () => runRetention());
  job("annual", "0 6 1 1 *", j.annual, () => runAnnual());
  job("cert", "15 9 * * *", true, () => checkCert());
  console.log("[v3 jobs]", Object.entries(j).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(" "));
}

module.exports = {
  startJobs, lastRuns, runAlerts, sendTelegram, sendReport, runDueSchedules, runRetention, runAnnual,
  buildAnnualWorkbook, listChanges, teams, splitList, alertRules, certInfo, checkCert, siteList, filterSites, sitesLabel, addCustomerSheet,
};
