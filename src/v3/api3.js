const express = require("express");
const bcrypt = require("bcryptjs");
const { config } = require("../config");
const { config3 } = require("./config3");
const { ser, stageCounts, slaStats } = require("../routes");
const { ownerId } = require("../cases");
const reports = require("../reports");
const graph = require("../graph");
const d = require("../dates");
const { q, one, all, getSetting, setSetting, audit, pool } = require("./db");
const perms = require("./perms");
const repo = require("./caserepo");
const jobs = require("./jobs");
const { importFromExcel } = require("./importer");
const { caseAlertEmail } = require("../emails");
const { recipientsFor, splitList: splitEmails } = require("../alertRecipients");
const userImport = require("./userimport");
const { requireUser, tempPassword, createResetLink, ssoReady } = require("./auth");

const api = express.Router();
const jsonSmall = express.json({ limit: "200kb" });
const jsonFile = express.json({ limit: "4mb" });
api.use((req, res, next) => (req.path === "/users/import" ? jsonFile : jsonSmall)(req, res, next));
api.use(requireUser());

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || (e.code === "23505" ? 409 : 500);
    const msg = e.code === "23505" ? "ข้อมูลซ้ำกับที่มีอยู่แล้ว (เช่น CS Number ซ้ำในทีมเดียวกัน)" : e.message || String(e);
    if (status >= 500) console.error(`[v3 api] ${req.method} ${req.path}:`, e);
    res.status(status).json({ ok: false, error: String(msg).slice(0, 400) });
  });
const need = (perm) => async (req, res, next) => ((await perms.can(req.user, perm)) ? next() : res.status(403).json({ error: "ไม่มีสิทธิ์ทำรายการนี้" }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function visibleCases(user) {
  return repo.loadCases(user);
}
async function teamsList() {
  return all("SELECT code AS key, label FROM teams ORDER BY sort");
}

// ------------------------------------------------------------ me / lookups
api.get("/me", wrap(async (req, res) => {
  const m = await perms.matrix();
  res.json({
    user: req.user,
    perms: m[req.user.role],
    teams: await teamsList(),
    config: {
      slaDays: config.slaDays, alert1Day: config.alert1Day, alert2Day: config.alert2Day, alertCc: config.alertCc,
      dryRunEmail: config.dryRunEmail, sso: ssoReady(), jobs: config3.jobs,
    },
  });
}));

api.get("/lookups", wrap(async (req, res) => {
  const rows = await all("SELECT kind, value, is_new FROM lookups WHERE active ORDER BY kind, sort, lower(value)");
  const out = { site: [], product: [], status: [] };
  rows.forEach((r) => out[r.kind].push(r.value));
  out.severity = repo.SEVERITIES;
  res.json(out);
}));

api.get("/users/options", wrap(async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.display_name, u.email, array_remove(array_agg(t.team), NULL) AS teams
     FROM users u LEFT JOIN user_teams t ON t.user_id = u.id WHERE u.active
     GROUP BY u.id ORDER BY u.display_name`
  );
  res.json({ users: rows });
}));

// ------------------------------------------------------------ dashboard (same shapes as v2)
api.get("/status", wrap(async (req, res) => {
  res.json({ syncedAt: new Date().toISOString(), error: null, sources: await teamsList(), store: "postgres", dryRunEmail: config.dryRunEmail, lastRuns: jobs.lastRuns });
}));

api.get("/overview", wrap(async (req, res) => {
  let cases = await visibleCases(req.user);
  if (req.query.source) cases = cases.filter((c) => c.team === req.query.source);
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
  const ids = cases.map((c) => c.id);
  const [alerts, changes] = await Promise.all([
    all("SELECT * FROM alert_log WHERE sent_at >= $1 AND case_id = ANY($2) ORDER BY sent_at DESC LIMIT 200", [d.today().toISOString(), ids]),
    (await perms.can(req.user, "audit_view"))
      ? jobs.listChanges({ from: d.addDays(d.today(), -14).toISOString(), limit: 50, caseIds: ids })
      : [],
  ]);
  const teams = await teamsList();
  res.json({
    syncedAt: new Date().toISOString(),
    syncError: null,
    sources: teams,
    config: { slaDays: config.slaDays, alert1Day: config.alert1Day, alert2Day: config.alert2Day, alertCc: config.alertCc, alertRules: await jobs.alertRules(), dryRunEmail: config.dryRunEmail },
    kpis: { ...stageCounts(cases), sla: slaStats(cases) },
    owners: ownerRows,
    alertsToday: alerts.map((a) => ({ ...a, case_key: `v3:${a.case_id}` })),
    changes,
    topCases: open.filter((c) => c.stage === "overdue" || c.stage === "r2").sort((a, b) => (b.age || 0) - (a.age || 0)).slice(0, 10).map(ser3),
    runway: open.filter((c) => c.age != null).map((c) => ({
      id: c.id, csNumber: c.csNumber, site: c.site, owner: c.owner, ownerId: ownerId(c), age: c.age, stage: c.stage, daysOverdue: c.daysOverdue || 0,
    })),
  });
}));

function ser3(c) {
  return { ...ser(c), severity: c.severity, id: c.id, team: c.team, ownerUserId: c.owner_id, updatedAt: c.updatedAt, startAt: c.startAt };
}

api.get("/cases", wrap(async (req, res) => {
  let cases = await visibleCases(req.user);
  const qy = req.query;
  if (qy.mine === "1") cases = cases.filter((c) => c.owner_id === req.user.id);
  if (qy.severity) cases = cases.filter((c) => c.severity === qy.severity);
  if (qy.source) cases = cases.filter((c) => c.team === qy.source);
  if (qy.owner) cases = cases.filter((c) => ownerId(c) === String(qy.owner).toLowerCase());
  if (qy.stage) cases = cases.filter((c) => c.stage === qy.stage);
  if (qy.q) {
    const s = String(qy.q).toLowerCase();
    cases = cases.filter((c) => [c.csNumber, c.site, c.owner, c.task, c.product, c.note].some((v) => String(v || "").toLowerCase().includes(s)));
  }
  res.json({ cases: cases.map(ser3) });
}));

api.get("/owner/:id", wrap(async (req, res) => {
  const cases = await visibleCases(req.user);
  const id = String(req.params.id).toLowerCase();
  const mine = cases.filter((c) => ownerId(c) === id);
  if (!mine.length) return res.status(404).json({ error: "ไม่พบ Owner นี้" });
  const owners = [...new Map(cases.map((c) => [ownerId(c), { id: ownerId(c), owner: c.owner }])).values()].sort((a, b) =>
    String(a.owner).localeCompare(String(b.owner))
  );
  const ids = mine.map((c) => c.id);
  const since = d.addDays(d.today(), -60).toISOString();
  const [alerts, changes] = await Promise.all([
    all("SELECT * FROM alert_log WHERE sent_at >= $1 AND case_id = ANY($2) ORDER BY sent_at DESC", [since, ids]),
    jobs.listChanges({ from: since, caseIds: ids }),
  ]);
  const weeks = [];
  const monday = d.addDays(d.today(), -((d.today().getDay() + 6) % 7));
  for (let i = 3; i >= 0; i--) {
    const from = d.addDays(monday, -7 * i);
    const to = d.addDays(from, 6);
    const closed = mine.filter((c) => c.stage === "closed" && c.endDate >= from && c.endDate <= to);
    weeks.push({ from: d.toISODate(from), onTime: closed.filter((c) => c.closedOnTime === true).length, late: closed.filter((c) => c.closedOnTime === false).length });
  }
  const recent = d.addDays(d.today(), -30);
  res.json({
    id, owner: mine[0].owner, email: mine[0].ownerEmail, sources: [...new Set(mine.map((c) => c.sourceLabel))],
    kpis: { ...stageCounts(mine), sla: slaStats(mine) }, owners,
    cases: mine.filter((c) => c.stage !== "closed" || c.endDate >= recent)
      .sort((a, b) => (a.stage === "closed") - (b.stage === "closed") || (b.age || 0) - (a.age || 0)).map(ser3),
    alerts: alerts.map((a) => ({ ...a, case_key: `v3:${a.case_id}` })),
    changes, weeks,
  });
}));

api.get("/alerts", wrap(async (req, res) => {
  const ids = (await visibleCases(req.user)).map((c) => c.id);
  const days = Math.min(400, Number(req.query.days || 7));
  res.json({ alerts: await all("SELECT * FROM alert_log WHERE sent_at >= $1 AND case_id = ANY($2) ORDER BY sent_at DESC LIMIT 500", [d.addDays(d.today(), -days).toISOString(), ids]) });
}));

api.get("/changes", wrap(async (req, res) => {
  const lvl = await perms.level(req.user, "audit_view");
  if (lvl === "none") return res.status(403).json({ error: "ไม่มีสิทธิ์ดูประวัติแก้ไข" });
  const cases = await visibleCases(req.user);
  const ids = (lvl === "own" ? cases.filter((c) => c.owner_id === req.user.id) : cases).map((c) => c.id);
  const days = Math.min(800, Number(req.query.days || 30));
  res.json({ changes: await jobs.listChanges({ from: d.addDays(d.today(), -days).toISOString(), limit: 1000, caseIds: ids }) });
}));

// ------------------------------------------------------------ single case
async function loadVisible(req) {
  const c = await repo.getCase(Number(req.params.id));
  if (!c || !repo.canSee(req.user, c)) throw bad("ไม่พบเคสนี้ หรือไม่มีสิทธิ์ดู", 404);
  return c;
}

api.get("/case/:id", wrap(async (req, res) => {
  const c = await loadVisible(req);
  const u = req.user;
  const [acts, alerts, changes] = await Promise.all([
    repo.activities(c.id),
    all("SELECT alert_type, sent_at, to_list, ok FROM alert_log WHERE case_id = $1 ORDER BY sent_at DESC", [c.id]),
    (await perms.can(u, "audit_view", c)) ? jobs.listChanges({ caseIds: [c.id], limit: 200 }) : [],
  ]);
  res.json({
    case: ser3(c),
    activities: acts,
    alerts,
    changes,
    can: {
      edit: await perms.can(u, "case_edit", c),
      close: await perms.can(u, "case_close", c),
      reassign: await perms.can(u, "case_reassign", c),
      editStart: await perms.can(u, "case_edit_start", c),
      delete: await perms.can(u, "case_delete", c),
    },
  });
}));

api.post("/case", wrap(async (req, res) => {
  const u = req.user;
  if (!(await perms.can(u, "case_create"))) throw bad("ไม่มีสิทธิ์เปิดเคส", 403);
  const b = req.body || {};
  const team = b.team || (u.teams.length === 1 ? u.teams[0] : null);
  if (!team) throw bad("กรุณาเลือกทีม");
  if (u.role !== "admin" && !u.teams.includes(team)) throw bad("คุณไม่ได้อยู่ในทีมนี้", 403);
  if (!String(b.site || "").trim()) throw bad("กรุณาระบุ Site / ลูกค้า");
  if (!String(b.task || "").trim()) throw bad("กรุณาระบุ Task / Case");
  if (!repo.severityOf(b.severity)) throw bad("กรุณาเลือก Severity");
  let ownerIdNum = u.id;
  if (b.owner_id && Number(b.owner_id) !== u.id) {
    if (!(await perms.can(u, "case_reassign"))) throw bad("ไม่มีสิทธิ์เปิดเคสในชื่อคนอื่น", 403);
    ownerIdNum = Number(b.owner_id);
  }
  const closedStatus = config.closedStatuses.includes(String(b.status || "").toLowerCase());
  if (closedStatus && !(await perms.can(u, "case_close"))) throw bad("ไม่มีสิทธิ์ปิดเคส", 403);
  const r = await repo.createCase(u, { ...b, team }, { ownerId: ownerIdNum });
  await audit(u, "case_create", String(r.id), { cs: b.cs_number, site: b.site });
  res.json({ ok: true, id: r.id, newSite: r.newSite });
}));

api.put("/case/:id", wrap(async (req, res) => {
  const c = await loadVisible(req);
  const u = req.user;
  const b = req.body || {};
  if (!(await perms.can(u, "case_edit", c))) throw bad("ไม่มีสิทธิ์แก้ไขเคสนี้", 403);
  if (b.status && config.closedStatuses.includes(String(b.status).toLowerCase()) !== config.closedStatuses.includes(c.status.toLowerCase())) {
    if (!(await perms.can(u, "case_close", c))) throw bad("ไม่มีสิทธิ์ปิดหรือเปิดเคสนี้ใหม่", 403);
  }
  const allowReassign = await perms.can(u, "case_reassign", c);
  if ((b.owner_id && Number(b.owner_id) !== c.owner_id) || (b.team && b.team !== c.team)) {
    if (!allowReassign) throw bad("ไม่มีสิทธิ์เปลี่ยน Owner หรือทีม", 403);
  }
  const r = await repo.updateCase(u, c, b, { allowReassign });
  // Status and owner changes are already in case_changes; record the other edited fields here.
  const other = (r.changed || []).filter((f) => !["status", "owner", "owner_id", "end_date", "closed_at"].includes(f));
  if (other.length) await audit(u, "case_update", `${c.csNumber || "#" + c.id} · ${c.site || ""}`, { case_id: c.id, fields: other });
  res.json({ ok: true, ...r });
}));

api.post("/case/:id/activity", wrap(async (req, res) => {
  const c = await loadVisible(req);
  if (!(await perms.can(req.user, "case_edit", c))) throw bad("ไม่มีสิทธิ์เพิ่ม Activity ในเคสนี้", 403);
  const detail = String(req.body.detail || "").trim();
  if (detail.length < 3) throw bad("กรุณาใส่รายละเอียด");
  const date = d.fromISODate(req.body.date) || d.today();
  if (date > d.today()) throw bad("วันที่ทำต้องไม่เกินวันนี้");
  if (c.startDate && date < d.addDays(c.startDate, -30)) throw bad("วันที่ทำเก่ากว่าวันเปิดเคสมากเกินไป");
  await require("./db").tx((cl) =>
    repo.addActivity(cl, c.id, req.user, { date: d.toISODate(date), kind: String(req.body.kind || "ดำเนินการ").slice(0, 40), detail: detail.slice(0, 4000) })
  );
  res.json({ ok: true });
}));

api.post("/case/:id/start-date", wrap(async (req, res) => {
  const c = await loadVisible(req);
  if (!(await perms.can(req.user, "case_edit_start", c))) throw bad("ไม่มีสิทธิ์แก้ Start date", 403);
  await repo.editStartDate(req.user, c, req.body.date, req.body.reason);
  res.json({ ok: true });
}));

api.delete("/case/:id", wrap(async (req, res) => {
  const c = await loadVisible(req);
  if (!(await perms.can(req.user, "case_delete", c))) throw bad("ไม่มีสิทธิ์ลบเคส", 403);
  await repo.deleteCase(req.user, c, req.body?.reason);
  await audit(req.user, "case_delete", String(c.id), { cs: c.csNumber, reason: req.body?.reason });
  res.json({ ok: true });
}));

// ------------------------------------------------------------ reports & export
function rangeFrom(src) {
  const from = d.fromISODate(src.from);
  const to = d.fromISODate(src.to);
  if (!from || !to) throw bad("ต้องระบุช่วงวันที่ from และ to (YYYY-MM-DD)");
  if (from > to) throw bad("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด");
  return { from, to };
}

api.get("/reports/preview", wrap(async (req, res) => {
  const { from, to } = rangeFrom(req.query);
  const sites = jobs.siteList(req.query.site);
  let cases = jobs.filterSites(await visibleCases(req.user), sites);
  if ((await perms.level(req.user, "export")) === "own" && (await perms.level(req.user, "reports_manage")) === "none") cases = cases.filter((c) => c.owner_id === req.user.id);
  const changes = await jobs.listChanges({ from: from.toISOString(), limit: 5000, caseIds: cases.map((c) => c.id) });
  const rep = await reports.buildReport({ from, to, owner: req.query.owner || undefined, cases, changes });
  const customers = new Set([...rep.openedCases, ...rep.closedCases, ...rep.openCases].map((c) => c.site)).size;
  res.json({ rangeLabel: rep.rangeLabel, kpis: rep.kpis, owners: rep.owners, changes: rep.changes.length, customers, sites });
}));

api.get("/export", wrap(async (req, res) => {
  const lvl = await perms.level(req.user, "export");
  if (lvl === "none") throw bad("ไม่มีสิทธิ์ Export", 403);
  const { from, to } = rangeFrom(req.query);
  const sites = jobs.siteList(req.query.site);
  let cases = jobs.filterSites(await visibleCases(req.user), sites);
  let owner = req.query.owner || undefined;
  if (lvl === "own") {
    cases = cases.filter((c) => c.owner_id === req.user.id);
    owner = undefined;
  }
  const changes = await jobs.listChanges({ from: from.toISOString(), limit: 5000, caseIds: cases.map((c) => c.id) });
  const rep = await reports.buildReport({ from, to, owner, cases, changes });
  await audit(req.user, "export", `${d.toISODate(from)} – ${d.toISODate(to)}`, { format: req.query.format === "csv" ? "csv" : "xlsx", owner: owner || null, sites, cases: rep.openedCases.length + rep.closedCases.length + rep.openCases.length });
  const safe = (x) => String(x).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40);
  const tag = `${sites.length === 1 ? safe(sites[0]) + "_" : sites.length ? `${sites.length}-customers_` : ""}${d.toISODate(from)}_${d.toISODate(to)}`;
  const disp = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (req.query.format === "csv") {
    const scope = new Map();
    [...rep.openedCases, ...rep.closedCases, ...rep.openCases].forEach((c) => scope.set(c.key, c));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", disp(`case-export-${tag}.csv`));
    return res.send(reports.casesCsv([...scope.values()]));
  }
  const buf = await jobs.addCustomerSheet(await reports.reportWorkbook(rep), rep);
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.set("Content-Disposition", disp(`case-export-${tag}.xlsx`));
  res.send(buf);
}));

api.post("/reports/send", need("reports_manage"), wrap(async (req, res) => {
  const { from, to } = rangeFrom(req.body);
  await audit(req.user, "report_send", String(req.body.recipients || ""), { from: d.toISODate(from), to: d.toISODate(to), sites: jobs.siteList(req.body.sites), owner: req.body.owner || null });
  res.json(await jobs.sendReport({ title: req.body.title, recipients: req.body.recipients, cc: req.body.cc, from, to, owner: req.body.owner || undefined, sites: jobs.siteList(req.body.sites), attachExcel: req.body.attachExcel !== false, user: req.user }));
}));
api.get("/reports/history", need("reports_manage"), wrap(async (req, res) => {
  res.json({ reports: await all("SELECT * FROM report_log ORDER BY sent_at DESC LIMIT 50") });
}));

const SCHED = ["name", "enabled", "frequency", "day_of_week", "day_of_month", "send_time", "range_type", "recipients", "cc", "attach_excel"];
function cleanSchedule(b) {
  const s = {};
  SCHED.forEach((k) => b[k] !== undefined && (s[k] = b[k]));
  if (s.frequency && !["daily", "weekly", "monthly"].includes(s.frequency)) throw bad("frequency ไม่ถูกต้อง");
  if (s.send_time && !/^\d{2}:\d{2}$/.test(s.send_time)) throw bad("เวลาต้องเป็น HH:MM");
  if (s.day_of_month !== undefined) s.day_of_month = Math.min(28, Math.max(1, Number(s.day_of_month) || 1));
  if (s.day_of_week !== undefined) s.day_of_week = Math.min(7, Math.max(1, Number(s.day_of_week) || 1));
  return s;
}
api.get("/schedules", need("reports_manage"), wrap(async (req, res) => {
  const rows = await all("SELECT * FROM report_schedules ORDER BY id");
  res.json({
    schedules: rows.map((s) => {
      const r = reports.resolveRange(s.range_type);
      return { ...s, description: reports.describeSchedule(s), nextRange: reports.rangeLabel(r.from, r.to) };
    }),
  });
}));
api.post("/schedules", need("reports_manage"), wrap(async (req, res) => {
  const s = cleanSchedule(req.body);
  const cols = Object.keys(s);
  const row = await one(`INSERT INTO report_schedules (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`, Object.values(s));
  await audit(req.user, "schedule_create", row.name, s);
  res.json({ schedule: row });
}));
api.put("/schedules/:id", need("reports_manage"), wrap(async (req, res) => {
  const s = cleanSchedule(req.body);
  const cols = Object.keys(s);
  if (!cols.length) throw bad("ไม่มีข้อมูลที่จะแก้");
  const row = await one(`UPDATE report_schedules SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")} WHERE id=$${cols.length + 1} RETURNING *`, [...Object.values(s), Number(req.params.id)]);
  await audit(req.user, "schedule_update", row?.name, s);
  res.json({ schedule: row });
}));
api.delete("/schedules/:id", need("reports_manage"), wrap(async (req, res) => {
  const old = await one("DELETE FROM report_schedules WHERE id=$1 RETURNING name", [Number(req.params.id)]);
  await audit(req.user, "schedule_delete", old?.name);
  res.json({ ok: true });
}));
api.post("/schedules/:id/test", need("reports_manage"), wrap(async (req, res) => {
  const s = await one("SELECT * FROM report_schedules WHERE id=$1", [Number(req.params.id)]);
  if (!s) throw bad("ไม่พบรอบส่งนี้", 404);
  const { from, to } = reports.resolveRange(s.range_type);
  await audit(req.user, "schedule_test", s.name, { to: req.body?.to || s.recipients });
  res.json(await jobs.sendReport({ title: `[ทดสอบ] ${s.name}`, recipients: req.body?.to || s.recipients, cc: req.body?.to ? "" : s.cc, from, to, attachExcel: s.attach_excel, scheduleId: s.id }));
}));

// ------------------------------------------------------------ users (admin)
const ROLE_SET = new Set(perms.ROLES);
async function userRow(id) {
  return one(
    `SELECT u.id, u.email, u.display_name, u.role, u.auth_type, u.active, u.must_change_password, u.last_login_at, u.created_at,
            array_remove(array_agg(t.team ORDER BY t.team), NULL) AS teams,
            (SELECT count(*)::int FROM cases c WHERE c.owner_id = u.id AND c.closed_at IS NULL) AS open_cases
     FROM users u LEFT JOIN user_teams t ON t.user_id = u.id WHERE u.id = $1 GROUP BY u.id`,
    [id]
  );
}
api.get("/users", need("users_manage"), wrap(async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.email, u.display_name, u.role, u.auth_type, u.active, u.must_change_password, u.last_login_at,
            array_remove(array_agg(t.team ORDER BY t.team), NULL) AS teams,
            (SELECT count(*)::int FROM cases c WHERE c.owner_id = u.id AND c.closed_at IS NULL) AS open_cases
     FROM users u LEFT JOIN user_teams t ON t.user_id = u.id GROUP BY u.id ORDER BY u.active DESC, u.role, u.display_name`
  );
  res.json({ users: rows });
}));

api.get("/users/template", need("users_manage"), wrap(async (req, res) => {
  const buf = await userImport.template();
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.set("Content-Disposition", 'attachment; filename="users-template.xlsx"');
  res.send(Buffer.from(buf));
}));

// Body: { file: base64 xlsx, apply: boolean }. Without apply it only returns the plan.
api.post("/users/import", need("users_manage"), wrap(async (req, res) => {
  const b64 = String(req.body?.file || "").replace(/^data:[^,]*,/, "");
  if (!b64) throw bad("ไม่ได้แนบไฟล์");
  const rows = await userImport.parse(Buffer.from(b64, "base64"));
  if (!rows.length) throw bad("ไม่พบข้อมูลผู้ใช้ในไฟล์");
  const planned = await userImport.plan(rows, req.user);
  const count = (a) => planned.filter((p) => p.action === a).length;
  const summary = { create: count("create"), update: count("update"), same: count("same"), error: count("error") };
  if (!req.body.apply) return res.json({ ok: true, summary, rows: planned });
  if (summary.error) throw bad(`มี ${summary.error} แถวที่ผิด แก้ไฟล์แล้วนำเข้าใหม่`);
  const result = await userImport.apply(planned, req.user);
  res.json({ ok: true, summary, ...result });
}));

async function saveTeams(client, userId, teams) {
  if (!Array.isArray(teams)) return;
  const valid = (await client.query("SELECT code FROM teams")).rows.map((r) => r.code);
  await client.query("DELETE FROM user_teams WHERE user_id=$1", [userId]);
  for (const t of teams.filter((x) => valid.includes(x))) await client.query("INSERT INTO user_teams (user_id, team) VALUES ($1,$2)", [userId, t]);
}

api.post("/users", need("users_manage"), wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("อีเมลไม่ถูกต้อง");
  if (!ROLE_SET.has(b.role)) throw bad("บทบาทไม่ถูกต้อง");
  const auth = b.auth_type === "local" ? "local" : "sso";
  let temp = null;
  const id = await require("./db").tx(async (c) => {
    let hash = null;
    if (auth === "local") {
      temp = tempPassword();
      hash = await bcrypt.hash(temp, 12);
    }
    const r = await c.query(
      `INSERT INTO users (email, display_name, role, auth_type, password_hash, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [email, String(b.display_name || email).trim().slice(0, 120), b.role, auth, hash, auth === "local", req.user.id]
    );
    await saveTeams(c, r.rows[0].id, b.teams || []);
    return r.rows[0].id;
  });
  await audit(req.user, "user_create", email, { role: b.role, auth, teams: b.teams });
  res.json({ ok: true, user: await userRow(id), tempPassword: temp });
}));

api.put("/users/:id", need("users_manage"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cur = await one("SELECT * FROM users WHERE id=$1", [id]);
  if (!cur) throw bad("ไม่พบผู้ใช้", 404);
  if (id === req.user.id && (b.active === false || (b.role && b.role !== "admin"))) throw bad("ปิดใช้งานหรือลดสิทธิ์บัญชีตัวเองไม่ได้");
  if (b.role && !ROLE_SET.has(b.role)) throw bad("บทบาทไม่ถูกต้อง");
  await require("./db").tx(async (c) => {
    const sets = [];
    const vals = [];
    const set = (col, v) => {
      vals.push(v);
      sets.push(`${col}=$${vals.length}`);
    };
    if (b.display_name !== undefined) set("display_name", String(b.display_name).trim().slice(0, 120) || cur.email);
    if (b.role !== undefined) set("role", b.role);
    if (b.active !== undefined) {
      set("active", !!b.active);
      if (!b.active) sets.push("session_version = session_version + 1");
    }
    if (sets.length) {
      sets.push("updated_at = now()");
      vals.push(id);
      await c.query(`UPDATE users SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    }
    await saveTeams(c, id, b.teams);
  });
  await audit(req.user, "user_update", cur.email, b);
  res.json({ ok: true, user: await userRow(id) });
}));

api.delete("/users/:id", need("users_manage"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad("ลบบัญชีตัวเองไม่ได้");
  const u = await userRow(id);
  if (!u) throw bad("ไม่พบผู้ใช้", 404);
  if (u.open_cases > 0) throw bad(`ผู้ใช้นี้ยังมีเคสเปิดอยู่ ${u.open_cases} เคส โอนเคสหรือปิดใช้งานบัญชีแทน`);
  await q("DELETE FROM users WHERE id=$1", [id]);
  await audit(req.user, "user_delete", u.email);
  res.json({ ok: true });
}));

api.post("/users/:id/reset", need("users_manage"), wrap(async (req, res) => {
  const u = await one("SELECT id, email, display_name, auth_type FROM users WHERE id=$1", [Number(req.params.id)]);
  if (!u) throw bad("ไม่พบผู้ใช้", 404);
  if (u.auth_type !== "local") throw bad("บัญชี Microsoft รีเซ็ตรหัสผ่านที่ Microsoft Entra");
  if (req.body?.method === "temp") {
    const temp = tempPassword();
    await q("UPDATE users SET password_hash=$1, must_change_password=true, session_version=session_version+1 WHERE id=$2", [await bcrypt.hash(temp, 12), u.id]);
    await audit(req.user, "password_temp", u.email);
    return res.json({ ok: true, tempPassword: temp });
  }
  const link = await createResetLink(u.id);
  await graph.sendMail({
    to: [u.email], cc: [], subject: "ตั้งรหัสผ่านใหม่ · Sino Case SLA",
    html: `<p>เรียน ${u.display_name}</p><p>กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ ลิงก์ใช้ได้ 24 ชั่วโมงและใช้ได้ครั้งเดียว</p><p><a href="${link}">${link}</a></p><p>ถ้าไม่ได้ขอรีเซ็ตรหัสผ่าน แจ้ง Admin ของระบบ</p>`,
  });
  await audit(req.user, "password_link", u.email);
  res.json({ ok: true, sentTo: u.email });
}));

api.post("/users/:id/signout", need("users_manage"), wrap(async (req, res) => {
  const u = await one("UPDATE users SET session_version = session_version + 1 WHERE id=$1 RETURNING email", [Number(req.params.id)]);
  await audit(req.user, "user_signout", u?.email);
  res.json({ ok: true });
}));

api.get("/permissions", wrap(async (req, res) => {
  res.json({ perms: perms.PERMS, roles: perms.ROLES, matrix: await perms.matrix(), counts: await all("SELECT role, count(*)::int AS n FROM users WHERE active GROUP BY role") });
}));
api.put("/permissions", need("users_manage"), wrap(async (req, res) => {
  const m = req.body?.matrix || {};
  const clean = {};
  for (const r of perms.ROLES) {
    clean[r] = {};
    for (const p of perms.PERMS) {
      const v = m[r]?.[p.key];
      if (["all", "own", "none"].includes(v)) clean[r][p.key] = v;
    }
  }
  await setSetting("permissions", clean);
  perms.invalidate();
  await audit(req.user, "permissions_update", null, clean);
  res.json({ ok: true, matrix: await perms.matrix() });
}));


// ------------------------------------------------------------ owner alert email: preview + test send
async function sampleCase(type) {
  const cases = await repo.loadCases(null, { where: "c.closed_at IS NULL" });
  const real = cases.find((c) => c.stage === type);
  if (real) return { c: real, sample: false };
  const age = type === "r1" ? config.alert1Day : type === "r2" ? config.alert2Day : config.slaDays + 2;
  const start = d.addDays(d.today(), -age);
  return {
    sample: true,
    c: {
      key: "sample", id: 0, csNumber: "CS0000000", site: "ลูกค้าตัวอย่าง", task: "ตัวอย่างงาน", status: "In Progress",
      owner: "Owner ตัวอย่าง", ownerEmail: "owner@sinostech.co.th", source: "ENGAGE", sourceLabel: "Engage / NRX / CXone",
      startDate: start, targetDate: d.addDays(start, config.slaDays), dueDate: d.addDays(start, config.slaDays), age, stage: type,
      daysLeft: Math.max(0, config.slaDays - age), daysOverdue: Math.max(0, age - config.slaDays),
      caseUrl: `${config3.baseUrl}/#/mine`,
    },
  };
}
api.get("/alert-email/preview", need("settings_manage"), wrap(async (req, res) => {
  const type = ["r1", "r2", "overdue"].includes(req.query.type) ? req.query.type : "r1";
  const { c, sample } = await sampleCase(type);
  const { subject, html } = caseAlertEmail(c, type);
  const r = recipientsFor(c, type, await jobs.alertRules());
  res.json({ type, sample, subject, html, to: r.to, cc: r.cc, case: c.csNumber });
}));
api.post("/alert-email/test", need("settings_manage"), wrap(async (req, res) => {
  const type = ["r1", "r2", "overdue"].includes(req.body?.type) ? req.body.type : "r1";
  const { c } = await sampleCase(type);
  const { subject, html } = caseAlertEmail(c, type);
  const r = await graph.sendMail({ to: [req.user.email], cc: [], subject: `[ทดสอบ] ${subject}`, html });
  await audit(req.user, "alert_email_test", type);
  res.json({ ok: true, to: req.user.email, dryRun: !!r.dryRun });
}));

// ------------------------------------------------------------ settings (admin)
api.get("/settings", need("settings_manage"), wrap(async (req, res) => {
  const years = Number(await getSetting("retention_years", 2));
  const [lookups, stats, annual, size] = await Promise.all([
    all("SELECT l.id, l.kind, l.value, l.is_new, l.active, l.created_at, u.display_name AS created_by FROM lookups l LEFT JOIN users u ON u.id=l.created_by ORDER BY l.kind, l.is_new DESC, l.sort, lower(l.value)"),
    one(`SELECT count(*)::int AS cases, min(start_date) AS oldest,
           count(*) FILTER (WHERE closed_at IS NOT NULL AND closed_at < now() - make_interval(years => $1))::int AS to_delete
         FROM cases`, [years]),
    all("SELECT year, created_at, file_name, recipients, ok, error, length(file) AS bytes FROM annual_reports ORDER BY year DESC"),
    one("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
  ]);
  res.json({
    retentionYears: years,
    annual: await getSetting("annual_report", { recipients: "", cc: "" }),
    alertEmail: await jobs.alertRules(),
    cert: jobs.certInfo(),
    lookups, stats: { ...stats, dbSize: size.size }, annualReports: annual, jobs: config3.jobs,
  });
}));
api.put("/settings", need("settings_manage"), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.retentionYears !== undefined) {
    const y = Number(b.retentionYears);
    if (![1, 2, 3, 5].includes(y)) throw bad("ระยะเวลาเก็บข้อมูลต้องเป็น 1, 2, 3 หรือ 5 ปี");
    await setSetting("retention_years", y);
  }
  if (b.alertEmail) {
    const a = b.alertEmail;
    const bads = String(a.cc || "").concat(",", a.fallback || "").split(/[,;\s]+/).filter((x) => x && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (bads.length) throw bad(`อีเมลไม่ถูกต้อง: ${bads.join(", ")}`);
    const ccTypes = (Array.isArray(a.ccTypes) ? a.ccTypes : []).filter((t) => ["r1", "r2", "overdue"].includes(t));
    if (!splitEmails(a.fallback).length && !splitEmails(a.cc).length) throw bad("ต้องมีอีเมลอย่างน้อย 1 อีเมล สำหรับเคสที่ไม่มีอีเมล Owner");
    await setSetting("alert_email", { cc: splitEmails(a.cc).join(", "), ccTypes, fallback: splitEmails(a.fallback).join(", ") });
  }
  if (b.annual) await setSetting("annual_report", { recipients: String(b.annual.recipients || ""), cc: String(b.annual.cc || "") });
  await audit(req.user, "settings_update", null, b);
  res.json({ ok: true });
}));
api.post("/lookups", need("settings_manage"), wrap(async (req, res) => {
  const kind = req.body?.kind;
  const value = String(req.body?.value || "").trim();
  if (!["site", "product", "status"].includes(kind) || !value) throw bad("ข้อมูลไม่ครบ");
  await q("INSERT INTO lookups (kind, value, created_by, sort) VALUES ($1,$2,$3,500)", [kind, value, req.user.id]);
  await audit(req.user, "lookup_add", value, { kind });
  res.json({ ok: true });
}));
api.put("/lookups/:id", need("settings_manage"), wrap(async (req, res) => {
  const b = req.body || {};
  const cur = await one("SELECT * FROM lookups WHERE id=$1", [Number(req.params.id)]);
  if (!cur) throw bad("ไม่พบรายการ", 404);
  const value = b.value !== undefined ? String(b.value).trim() : cur.value;
  await q("UPDATE lookups SET value=$1, active=$2, is_new=$3 WHERE id=$4", [value, b.active ?? cur.active, b.is_new ?? false, cur.id]);
  if (value !== cur.value && cur.kind === "site") {
    // Renaming a customer (e.g. fixing a typo) updates the cases that use it.
    await q("UPDATE cases SET site=$1 WHERE site=$2", [value, cur.value]);
  }
  await audit(req.user, "lookup_update", value !== cur.value ? `${cur.value} -> ${value}` : value, { kind: cur.kind, active: b.active ?? cur.active });
  res.json({ ok: true });
}));
api.post("/lookups/:id/merge", need("settings_manage"), wrap(async (req, res) => {
  const src = await one("SELECT * FROM lookups WHERE id=$1", [Number(req.params.id)]);
  const dst = await one("SELECT * FROM lookups WHERE id=$1", [Number(req.body?.into)]);
  if (!src || !dst || src.kind !== dst.kind) throw bad("เลือกรายการที่จะรวมไม่ถูกต้อง");
  const col = { site: "site", product: "product", status: "status" }[src.kind];
  const n = (await q(`UPDATE cases SET ${col}=$1 WHERE ${col}=$2`, [dst.value, src.value])).rowCount;
  await q("DELETE FROM lookups WHERE id=$1", [src.id]);
  await audit(req.user, "lookup_merge", `${src.value} -> ${dst.value}`, { cases: n });
  res.json({ ok: true, moved: n });
}));

api.post("/import", need("settings_manage"), wrap(async (req, res) => {
  res.json({ ok: true, ...(await importFromExcel(req.user, { mode: req.body?.mode === "refresh" ? "refresh" : "new" })) });
}));
api.post("/annual/test", need("settings_manage"), wrap(async (req, res) => {
  await audit(req.user, "annual_test", String(new Date().getFullYear()));
  res.json(await jobs.runAnnual(new Date().getFullYear(), { test: true }));
}));
api.get("/annual/:year/file", need("settings_manage"), wrap(async (req, res) => {
  const r = await one("SELECT file_name, file FROM annual_reports WHERE year=$1", [Number(req.params.year)]);
  if (!r) throw bad("ไม่พบไฟล์", 404);
  await audit(req.user, "annual_download", r.file_name);
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.set("Content-Disposition", `attachment; filename="${r.file_name}"`);
  res.send(r.file);
}));
// ------------------------------------------------------------ audit log (admin)
const AUDIT_GROUPS = {
  login: ["login", "login_failed", "login_locked", "login_denied", "logout"],
  users: ["user_create", "user_update", "user_delete", "user_import", "user_signout", "password_temp", "password_link", "password_changed", "password_reset_done", "permissions_update", "bootstrap_admin"],
  cases: ["case_create", "case_update", "case_delete", "case_status", "case_owner", "case_start_date", "case_severity", "case_deleted", "import_excel"],
  data: ["export", "report_send", "schedule_create", "schedule_update", "schedule_delete", "schedule_test", "annual_download"],
  settings: ["settings_update", "lookup_add", "lookup_update", "lookup_merge", "annual_test", "alert_email_test"],
};
async function auditRows(qry) {
  const days = Math.min(3650, Math.max(1, Number(qry.days) || 30));
  const params = [days];
  let where = "at >= now() - make_interval(days => $1)";
  if (qry.group && AUDIT_GROUPS[qry.group]) {
    params.push(AUDIT_GROUPS[qry.group]);
    where += ` AND action = ANY($${params.length})`;
  }
  if (qry.q) {
    params.push(`%${String(qry.q).toLowerCase()}%`);
    where += ` AND (lower(coalesce(actor,'')) LIKE $${params.length} OR lower(coalesce(target,'')) LIKE $${params.length} OR lower(coalesce(ip,'')) LIKE $${params.length} OR lower(coalesce(detail::text,'')) LIKE $${params.length})`;
  }
  return all(
    `SELECT * FROM (
       SELECT 'a' || id AS id, at, actor_id, actor, action, target, detail, ip, user_agent FROM audit_log
       UNION ALL
       SELECT 'c' || id, detected_at, changed_by, changed_by_name,
              CASE field WHEN 'status' THEN 'case_status' WHEN 'owner' THEN 'case_owner' WHEN 'start_date' THEN 'case_start_date'
                         WHEN 'deleted' THEN 'case_deleted' WHEN 'severity' THEN 'case_severity' ELSE 'case_' || field END,
              coalesce(cs_number, '#' || case_id) || coalesce(' · ' || site, ''),
              jsonb_strip_nulls(jsonb_build_object('old', old_value, 'new', new_value, 'reason', reason, 'case_id', case_id)),
              NULL, NULL
       FROM case_changes
     ) x WHERE ${where} ORDER BY at DESC LIMIT 2000`,
    params
  );
}
api.get("/audit", need("users_manage"), wrap(async (req, res) => {
  const rows = await auditRows(req.query);
  if (req.query.format === "csv") {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["เวลา", "ผู้ทำ", "การกระทำ", "เป้าหมาย", "รายละเอียด", "IP", "เบราว์เซอร์"].map(cell).join(",")];
    rows.forEach((r) => lines.push([new Date(r.at).toLocaleString("sv-SE", { timeZone: config.tz }), r.actor, r.action, r.target, r.detail ? JSON.stringify(r.detail) : "", r.ip, r.user_agent].map(cell).join(",")));
    await audit(req.user, "export", "audit log", { format: "csv", rows: rows.length });
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="audit-log-${d.toISODate(d.today())}.csv"`);
    return res.send("\ufeff" + lines.join("\r\n"));
  }
  res.json({ audit: rows, groups: Object.keys(AUDIT_GROUPS) });
}));

module.exports = { api, pool };
