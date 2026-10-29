const express = require("express");
const crypto = require("crypto");
const { config, missingEnv } = require("./config");
const { sync, getState } = require("./sync");
const { store } = require("./store");
const { ownerId } = require("./cases");
const { runAlerts } = require("./alerts");
const reports = require("./reports");
const telegram = require("./telegram");
const graph = require("./graph");
const { lastRuns } = require("./scheduler");
const d = require("./dates");

const router = express.Router();

// ------------------------------------------------------------ helpers
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function basicAuth(req, res, next) {
  if (config.mock && !config.dashboardUser) return next();
  const [type, value] = String(req.headers.authorization || "").split(" ");
  if (type === "Basic" && value) {
    const [u, ...p] = Buffer.from(value, "base64").toString().split(":");
    if (safeEqual(u, config.dashboardUser) && safeEqual(p.join(":"), config.dashboardPass)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Sino Case Tracker", charset="UTF-8"');
  res.status(401).send("Authentication required");
}

function requireSecret(req, res, next) {
  if (!config.runSecret || !safeEqual(req.query.secret, config.runSecret))
    return res.status(401).json({ error: "unauthorized" });
  next();
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const msg = e.response?.data?.error?.message || e.message || String(e);
    console.error(`[api] ${req.method} ${req.path}:`, msg);
    res.status(500).json({ ok: false, error: msg.slice(0, 400) });
  });

function ser(c) {
  const iso = (x) => (x instanceof Date ? d.toISODate(x) : x || null);
  return {
    key: c.key,
    source: c.source,
    sourceLabel: c.sourceLabel,
    rowNumber: c.rowNumber,
    no: c.no,
    status: c.status,
    stage: c.stage,
    stageLabel: c.stageLabel,
    site: c.site,
    owner: c.owner,
    ownerEmail: c.ownerEmail,
    ownerId: ownerId(c),
    product: c.product,
    csNumber: c.csNumber,
    task: c.task,
    detail: c.detail,
    note: c.note,
    startDate: iso(c.startDate),
    targetDate: iso(c.targetDate),
    dueDate: iso(c.dueDate),
    endDate: iso(c.endDate || c.closedAt),
    age: c.age,
    daysLeft: c.daysLeft ?? null,
    daysOverdue: c.daysOverdue || 0,
    closedOnTime: c.closedOnTime ?? null,
    targetMismatch: c.targetMismatch,
    fileUrl: c.fileUrl,
  };
}

async function ensureData() {
  const st = getState();
  if (!st.syncedAt) await sync();
  return getState();
}

function filterCases(cases, q) {
  let out = cases;
  if (q.source) out = out.filter((c) => c.source === q.source);
  if (q.owner) out = out.filter((c) => ownerId(c) === String(q.owner).toLowerCase());
  if (q.from) {
    const f = d.fromISODate(q.from);
    if (f) out = out.filter((c) => c.stage !== "closed" || (c.startDate && c.startDate >= f));
  }
  return out;
}

function stageCounts(list) {
  const k = { open: 0, normal: 0, r1: 0, r2: 0, overdue: 0, no_start: 0, closed: 0 };
  list.forEach((c) => {
    k[c.stage] = (k[c.stage] || 0) + 1;
    if (c.stage !== "closed") k.open++;
  });
  return k;
}

function slaStats(list, days = 30) {
  const since = d.addDays(d.today(), -days);
  const closed = list.filter((c) => c.stage === "closed" && (c.endDate || c.closedAt) >= since);
  const onTime = closed.filter((c) => c.closedOnTime === true).length;
  return { closed: closed.length, onTime, pct: closed.length ? Math.round((onTime / closed.length) * 100) : null };
}

// ------------------------------------------------------------ public / ops
router.get("/health", (req, res) => res.json({ ok: true }));
router.get("/version", (req, res) => res.json({ version: "v2-email-dashboard" }));

router.get("/run-check", requireSecret, wrap(async (req, res) => res.json({ ok: true, ...(await runAlerts()) })));
router.get(
  "/run-alerts",
  requireSecret,
  wrap(async (req, res) => res.json({ ok: true, ...(await runAlerts({ dryRun: req.query.dry === "1" })) }))
);
router.get("/run-telegram", requireSecret, wrap(async (req, res) => res.json({ ok: true, ...(await telegram.sendDailySummary()) })));
router.get("/run-reports", requireSecret, wrap(async (req, res) => res.json({ ok: true, results: await reports.runDueSchedules() })));

router.get(
  "/debug",
  requireSecret,
  wrap(async (req, res) => {
    const out = { missingEnv: missingEnv(), store: store.kind, sources: [] };
    for (const s of config.sources) {
      const r = { key: s.key, itemId: s.itemId, expectedSourcedoc: s.sourcedoc };
      try {
        const meta = await graph.getFileMeta(s.itemId);
        r.name = meta.name;
        r.listItemUniqueId = meta.sharepointIds?.listItemUniqueId;
        r.sourcedocMatches =
          !!r.listItemUniqueId && r.listItemUniqueId.toLowerCase() === String(s.sourcedoc).toLowerCase();
        r.worksheets = await graph.listWorksheets(s.itemId);
      } catch (e) {
        r.error = e.response?.data?.error?.message || e.message;
      }
      out.sources.push(r);
    }
    res.json(out);
  })
);

// ------------------------------------------------------------ dashboard API
const api = express.Router();
api.use(basicAuth);
api.use(express.json());

api.post("/sync", wrap(async (req, res) => {
  const r = await sync();
  res.json({ ok: true, cases: r.cases.length, changes: r.changes.length, syncedAt: getState().syncedAt });
}));

api.get("/overview", wrap(async (req, res) => {
  const st = await ensureData();
  const cases = filterCases(st.cases, req.query);
  const open = cases.filter((c) => c.stage !== "closed");

  const owners = new Map();
  cases.forEach((c) => {
    const id = ownerId(c);
    if (!owners.has(id)) owners.set(id, { id, owner: c.owner || "(ไม่ระบุ)", email: c.ownerEmail, list: [] });
    owners.get(id).list.push(c);
  });
  const ownerRows = [...owners.values()]
    .map((o) => ({ id: o.id, owner: o.owner, email: o.email, ...stageCounts(o.list), sla: slaStats(o.list) }))
    .filter((o) => o.open > 0 || o.sla.closed > 0)
    .sort((a, b) => b.overdue - a.overdue || b.r2 - a.r2 || b.open - a.open);

  const todayStart = d.today().toISOString();
  const [alerts, changes] = await Promise.all([
    store.listAlerts({ from: todayStart, limit: 200 }).catch(() => []),
    store.listChanges({ from: d.addDays(d.today(), -14).toISOString(), limit: 50 }).catch(() => []),
  ]);

  res.json({
    syncedAt: st.syncedAt,
    syncError: st.error,
    sources: st.sources,
    config: {
      slaDays: config.slaDays,
      alert1Day: config.alert1Day,
      alert2Day: config.alert2Day,
      alertCc: config.alertCc,
      dryRunEmail: config.dryRunEmail,
    },
    runway: open
      .filter((c) => c.age != null)
      .map((c) => ({
        csNumber: c.csNumber,
        site: c.site,
        owner: c.owner,
        ownerId: ownerId(c),
        age: c.age,
        stage: c.stage,
        daysOverdue: c.daysOverdue || 0,
      })),
    kpis: { ...stageCounts(cases), sla: slaStats(cases) },
    owners: ownerRows,
    alertsToday: alerts,
    changes,
    topCases: open
      .filter((c) => c.stage === "overdue" || c.stage === "r2")
      .sort((a, b) => (b.age || 0) - (a.age || 0))
      .slice(0, 10)
      .map(ser),
  });
}));

api.get("/cases", wrap(async (req, res) => {
  const st = await ensureData();
  let cases = filterCases(st.cases, req.query);
  if (req.query.stage) cases = cases.filter((c) => c.stage === req.query.stage);
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    cases = cases.filter((c) =>
      [c.csNumber, c.site, c.owner, c.task, c.product].some((v) => String(v || "").toLowerCase().includes(q))
    );
  }
  res.json({ cases: cases.map(ser) });
}));

api.get("/owner/:id", wrap(async (req, res) => {
  const st = await ensureData();
  const id = String(req.params.id).toLowerCase();
  const mine = st.cases.filter((c) => ownerId(c) === id || (c.owner || "").toLowerCase() === id);
  if (!mine.length) return res.status(404).json({ error: "ไม่พบ Owner นี้" });

  const owners = [...new Map(st.cases.map((c) => [ownerId(c), { id: ownerId(c), owner: c.owner }])).values()].sort(
    (a, b) => String(a.owner).localeCompare(String(b.owner))
  );
  const keys = new Set(mine.map((c) => c.key));
  const [alerts, changes] = await Promise.all([
    store.listAlerts({ from: d.addDays(d.today(), -60).toISOString(), limit: 1000 }).catch(() => []),
    store.listChanges({ from: d.addDays(d.today(), -60).toISOString(), limit: 500 }).catch(() => []),
  ]);

  // Closed per week for the last 4 weeks (on time vs late).
  const weeks = [];
  const monday = d.addDays(d.today(), -((d.today().getDay() + 6) % 7));
  for (let i = 3; i >= 0; i--) {
    const from = d.addDays(monday, -7 * i);
    const to = d.addDays(from, 6);
    const closed = mine.filter((c) => c.stage === "closed" && (c.endDate || c.closedAt) >= from && (c.endDate || c.closedAt) <= to);
    weeks.push({
      from: d.toISODate(from),
      onTime: closed.filter((c) => c.closedOnTime === true).length,
      late: closed.filter((c) => c.closedOnTime === false).length,
    });
  }

  const recentClosedSince = d.addDays(d.today(), -30);
  res.json({
    id,
    owner: mine[0].owner,
    email: mine[0].ownerEmail,
    sources: [...new Set(mine.map((c) => c.sourceLabel))],
    kpis: { ...stageCounts(mine), sla: slaStats(mine) },
    owners,
    cases: mine
      .filter((c) => c.stage !== "closed" || (c.endDate || c.closedAt) >= recentClosedSince)
      .sort((a, b) => (a.stage === "closed") - (b.stage === "closed") || (b.age || 0) - (a.age || 0))
      .map(ser),
    alerts: alerts.filter((a) => keys.has(a.case_key)),
    changes: changes.filter((c) => keys.has(c.case_key)),
    weeks,
  });
}));

api.get("/alerts", wrap(async (req, res) => {
  const days = Number(req.query.days || 7);
  res.json({
    alerts: await store.listAlerts({
      from: d.addDays(d.today(), -days).toISOString(),
      caseKey: req.query.caseKey,
      limit: 500,
    }),
  });
}));

api.get("/changes", wrap(async (req, res) => {
  const days = Number(req.query.days || 30);
  res.json({ changes: await store.listChanges({ from: d.addDays(d.today(), -days).toISOString(), limit: 500 }) });
}));

// ---- report schedules
const SCHEDULE_FIELDS = [
  "name", "enabled", "frequency", "day_of_week", "day_of_month", "send_time",
  "range_type", "recipients", "cc", "attach_excel",
];

function cleanSchedule(body) {
  const s = {};
  SCHEDULE_FIELDS.forEach((f) => body[f] !== undefined && (s[f] = body[f]));
  if (s.frequency && !["daily", "weekly", "monthly"].includes(s.frequency)) throw new Error("frequency ไม่ถูกต้อง");
  if (s.send_time && !/^\d{2}:\d{2}$/.test(s.send_time)) throw new Error("เวลาต้องเป็น HH:MM");
  if (s.day_of_month !== undefined) s.day_of_month = Math.min(28, Math.max(1, Number(s.day_of_month) || 1));
  if (s.day_of_week !== undefined) s.day_of_week = Math.min(7, Math.max(1, Number(s.day_of_week) || 1));
  return s;
}

api.get("/schedules", wrap(async (req, res) => {
  const list = await store.listSchedules();
  res.json({
    schedules: list.map((s) => ({
      ...s,
      description: reports.describeSchedule(s),
      nextRange: (() => {
        const r = reports.resolveRange(s.range_type);
        return reports.rangeLabel(r.from, r.to);
      })(),
    })),
  });
}));
api.post("/schedules", wrap(async (req, res) => res.json({ schedule: await store.saveSchedule(cleanSchedule(req.body)) })));
api.put("/schedules/:id", wrap(async (req, res) =>
  res.json({ schedule: await store.saveSchedule({ ...cleanSchedule(req.body), id: Number(req.params.id) }) })
));
api.delete("/schedules/:id", wrap(async (req, res) => {
  await store.deleteSchedule(Number(req.params.id));
  res.json({ ok: true });
}));
api.post("/schedules/:id/test", wrap(async (req, res) => {
  const s = (await store.listSchedules()).find((x) => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: "ไม่พบรอบส่งนี้" });
  const { from, to } = reports.resolveRange(s.range_type);
  const r = await reports.sendReport({
    title: `[ทดสอบ] ${s.name}`,
    recipients: req.body?.to || s.recipients,
    cc: req.body?.to ? "" : s.cc,
    from,
    to,
    attachExcel: s.attach_excel !== false,
    scheduleId: s.id,
  });
  res.json(r);
}));

// ---- manual report / export
function rangeFromQuery(q) {
  const from = d.fromISODate(q.from);
  const to = d.fromISODate(q.to);
  if (!from || !to) throw new Error("ต้องระบุช่วงวันที่ from และ to (YYYY-MM-DD)");
  if (from > to) throw new Error("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด");
  return { from, to };
}

api.post("/reports/send", wrap(async (req, res) => {
  const { from, to } = rangeFromQuery(req.body);
  res.json(
    await reports.sendReport({
      title: req.body.title || "รายงานสถานะเคส",
      recipients: req.body.recipients,
      cc: req.body.cc,
      from,
      to,
      owner: req.body.owner || undefined,
      attachExcel: req.body.attachExcel !== false,
    })
  );
}));

api.get("/reports/preview", wrap(async (req, res) => {
  await ensureData();
  const { from, to } = rangeFromQuery(req.query);
  const rep = await reports.buildReport({ from, to, owner: req.query.owner || undefined });
  res.json({ rangeLabel: rep.rangeLabel, kpis: rep.kpis, owners: rep.owners, changes: rep.changes.length });
}));

api.get("/reports/history", wrap(async (req, res) => res.json({ reports: await store.listReports({ limit: 50 }) })));

api.get("/export", wrap(async (req, res) => {
  await ensureData();
  const { from, to } = rangeFromQuery(req.query);
  const rep = await reports.buildReport({ from, to, owner: req.query.owner || undefined });
  const tag = `${d.toISODate(from)}_${d.toISODate(to)}`;
  if (req.query.format === "csv") {
    const scope = new Map();
    [...rep.openedCases, ...rep.closedCases, ...rep.openCases].forEach((c) => scope.set(c.key, c));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="case-export-${tag}.csv"`);
    return res.send(reports.casesCsv([...scope.values()]));
  }
  const buf = await reports.reportWorkbook(rep);
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.set("Content-Disposition", `attachment; filename="case-export-${tag}.xlsx"`);
  res.send(Buffer.from(buf));
}));

api.get("/status", wrap(async (req, res) => {
  const st = getState();
  res.json({
    syncedAt: st.syncedAt,
    error: st.error,
    sources: st.sources,
    store: store.kind,
    mock: config.mock,
    dryRunEmail: config.dryRunEmail,
    schedules: { alert: config.alertCron, sync: config.syncCron, telegram: config.telegramCron },
    lastRuns,
  });
}));

module.exports = { router, api, basicAuth, ser, stageCounts, slaStats };
