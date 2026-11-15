"use strict";
// Two read-only views for managers:
//   /workload      what each person has open right now across cases, service requests and project tasks
//   /csat-report   customer satisfaction answers by customer, product and engineer, with an Excel export
const { all } = require("./db");
const perms = require("./perms");
const d = require("../dates");

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const todayIso = () => d.toISODate(d.today());
const num = (v) => Math.round((Number(v) || 0) * 10) / 10;
const canSee = (u) => ["admin", "manager", "observer"].includes(u.role);

async function workload(user, teamFilter) {
  if (!canSee(user)) throw bad("ไม่มีสิทธิ์", 403);
  const scope = perms.teamScope(user); // null = every team
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  const allowed = teams.filter((t) => !scope || scope.includes(t.code));
  const team = allowed.some((t) => t.code === teamFilter) ? teamFilter : "";
  const codes = team ? [team] : allowed.map((t) => t.code);
  const people = await all(
    `SELECT u.id, u.display_name, u.email, u.role, array_agg(DISTINCT t.team) AS teams FROM users u JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND u.role IN ('engineer','manager') AND t.team = ANY($1) GROUP BY u.id ORDER BY u.display_name`,
    [codes]
  );
  const ids = people.map((p) => p.id);
  const t0 = todayIso();
  const soon = d.toISODate(d.addDays(d.today(), 7));
  const by = (rows) => new Map(rows.map((r) => [r.uid, r]));
  const cases = by(await all(
    `SELECT owner_id AS uid, count(*)::int AS open, count(*) FILTER (WHERE due_date < $2)::int AS late, count(*) FILTER (WHERE due_date >= $2 AND due_date <= $3)::int AS soon,
            count(*) FILTER (WHERE pm_schedule_id IS NOT NULL)::int AS pm
       FROM cases WHERE closed_at IS NULL AND owner_id = ANY($1) GROUP BY owner_id`, [ids, t0, soon]));
  const srs = by(await all(
    `SELECT assignee_id AS uid, count(*)::int AS open, count(*) FILTER (WHERE target_date < $2)::int AS late, count(*) FILTER (WHERE target_date >= $2 AND target_date <= $3)::int AS soon,
            count(*) FILTER (WHERE project_task_id IS NOT NULL)::int AS project
       FROM service_requests WHERE status = 'in_progress' AND assignee_id = ANY($1) GROUP BY assignee_id`, [ids, t0, soon]));
  // Project tasks the PM does personally (tasks handed to a team are the service requests above).
  const tasks = by(await all(
    `SELECT p.pm_id AS uid, count(*)::int AS open, count(*) FILTER (WHERE t.due_date < $2)::int AS late, count(*) FILTER (WHERE t.due_date >= $2 AND t.due_date <= $3)::int AS soon,
            count(DISTINCT p.id)::int AS projects,
            COALESCE(sum(GREATEST(t.md_est - COALESCE((SELECT sum(e.md) FROM project_task_events e WHERE e.task_id = t.id), 0), 0)), 0) AS md_left
       FROM project_tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind = 'own' AND t.status IN ('todo','doing') AND p.status IN ('plan','active') AND t.start_date <= $3 AND p.pm_id = ANY($1) GROUP BY p.pm_id`, [ids, t0, soon]));
  const z = { open: 0, late: 0, soon: 0 };
  const rows = people.map((p) => {
    const c = cases.get(p.id) || z;
    const s = srs.get(p.id) || z;
    const k = tasks.get(p.id) || z;
    return {
      id: p.id, name: p.display_name, email: String(p.email || "").toLowerCase(), role: p.role, teams: p.teams.filter((x) => codes.includes(x)),
      cases: { open: c.open, late: c.late, soon: c.soon, pm: c.pm || 0 }, sr: { open: s.open, late: s.late, soon: s.soon, project: s.project || 0 },
      tasks: { open: k.open, late: k.late, soon: k.soon, projects: k.projects || 0, mdLeft: num(k.md_left) },
      total: c.open + s.open + k.open, late: c.late + s.late + k.late, soon: c.soon + s.soon + k.soon,
    };
  });
  // "Heavy" compares a person with the middle of the same list: at least 5 open items and 1.5× the median.
  const sorted = rows.map((r) => r.total).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : 0;
  rows.forEach((r) => (r.heavy = r.total >= 5 && r.total >= median * 1.5));
  rows.sort((a, b) => b.total - a.total || b.late - a.late || a.name.localeCompare(b.name));
  return { today: t0, soonUntil: soon, team, teams: allowed, median, max: Math.max(1, ...rows.map((r) => r.total)), people: rows };
}

// ------------------------------------------------------------ workload history
// Nothing is stored for this: how much work was open on any past day follows from the dates already on each record
// (a case from its Start date to the day it was closed, a service request from approval to done, a PM's own project
// task from its start to the day it was finished), so the history goes back as far as the data does.
const { config } = require("../config");
const RANGES = { 3: 3, 6: 6, 12: 12 };
const MAX_YEARS = 5;
let histCache = new Map(); // key → { at, data }
const HIST_TTL = 10 * 60000;

async function dailyRows(from, to, codes) {
  const tz = config.tz || "Asia/Bangkok";
  return all(
    `WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d)
     SELECT to_char(d.d, 'YYYY-MM-DD') AS day, x.kind, x.team, count(*)::int AS n FROM days d JOIN (
       SELECT 'case' AS kind, c.team, c.start_date AS s, COALESCE((c.closed_at AT TIME ZONE $4)::date, 'infinity'::date) AS e FROM cases c WHERE c.start_date IS NOT NULL AND c.team = ANY($3)
       UNION ALL
       SELECT 'sr', r.team, (r.approved_at AT TIME ZONE $4)::date, COALESCE((r.closed_at AT TIME ZONE $4)::date, 'infinity'::date) FROM service_requests r
        WHERE r.approved_at IS NOT NULL AND r.status IN ('in_progress','done') AND r.team = ANY($3)
       UNION ALL
       SELECT 'task', (SELECT ut.team FROM user_teams ut WHERE ut.user_id = p.pm_id AND ut.team = ANY($3) ORDER BY ut.team LIMIT 1), t.start_date, COALESCE(t.done_at, 'infinity'::date)
         FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.kind = 'own' AND t.status <> 'cancelled' AND p.status <> 'cancelled'
     ) x ON x.s <= d.d AND x.e >= d.d AND x.team IS NOT NULL
     GROUP BY 1, 2, 3`,
    [from, to, codes, tz]
  );
}

async function history(user, qy) {
  if (!canSee(user)) throw bad("ไม่มีสิทธิ์", 403);
  const scope = perms.teamScope(user);
  const teams = (await all("SELECT code, label FROM teams ORDER BY sort")).filter((t) => !scope || scope.includes(t.code));
  const team = teams.some((t) => t.code === qy.team) ? qy.team : "";
  const codes = team ? [team] : teams.map((t) => t.code);
  const range = RANGES[qy.range] ? Number(qy.range) : qy.range === "all" ? "all" : 6;
  const key = JSON.stringify([codes, range]);
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < HIST_TTL) return hit.data;

  const t0 = todayIso();
  const [y, m] = t0.split("-").map(Number);
  // The first day anything in these teams was open: a case, an approved service request, or a PM's own project task.
  const first = await all(
    `SELECT to_char(LEAST((SELECT min(start_date) FROM cases WHERE team = ANY($1)), (SELECT min(approved_at)::date FROM service_requests WHERE team = ANY($1)),
            (SELECT min(t.start_date) FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.kind = 'own' AND EXISTS (SELECT 1 FROM user_teams ut WHERE ut.user_id = p.pm_id AND ut.team = ANY($1)))), 'YYYY-MM-DD') AS d`,
    [codes]
  );
  let dataFrom = (first[0] && first[0].d) || t0;
  const floorYear = Math.max(Number(dataFrom.slice(0, 4)), y - MAX_YEARS + 1);
  const seasonFrom = `${floorYear}-01-01`;
  if (dataFrom < seasonFrom) dataFrom = seasonFrom;
  const monthStart = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  const back = (n) => {
    const d0 = new Date(Date.UTC(y, m - 1 - (n - 1), 1));
    return monthStart(d0.getUTCFullYear(), d0.getUTCMonth() + 1);
  };
  let from = range === "all" ? seasonFrom : back(range);
  if (from < seasonFrom) from = seasonFrom;

  // One pass over the whole span the page may need (the year-by-year table always uses every year).
  const rows = await dailyRows(seasonFrom, t0, codes);
  const dayMap = new Map(); // day → { case, sr, task, teams: {code: n} }
  for (const r of rows) {
    const o = dayMap.get(r.day) || dayMap.set(r.day, { case: 0, sr: 0, task: 0, teams: {} }).get(r.day);
    o[r.kind] += r.n;
    o.teams[r.team] = (o.teams[r.team] || 0) + r.n;
  }
  const days = [];
  for (let d0 = new Date(seasonFrom + "T00:00:00Z"); d0.toISOString().slice(0, 10) <= t0; d0.setUTCDate(d0.getUTCDate() + 1)) days.push(d0.toISOString().slice(0, 10));
  const zero = { case: 0, sr: 0, task: 0, teams: {} };
  const at = (d0) => dayMap.get(d0) || zero;
  const tot = (o) => o.case + o.sr + o.task;

  const flow = await all(
    `SELECT ym, sum(opened)::int AS opened, sum(closed)::int AS closed FROM (
       SELECT to_char(start_date, 'YYYY-MM') AS ym, count(*) AS opened, 0 AS closed FROM cases WHERE start_date >= $1 AND team = ANY($2) GROUP BY 1
       UNION ALL
       SELECT to_char((closed_at AT TIME ZONE $3)::date, 'YYYY-MM'), 0, count(*) FROM cases WHERE closed_at IS NOT NULL AND (closed_at AT TIME ZONE $3)::date >= $1 AND team = ANY($2) GROUP BY 1
     ) z GROUP BY ym`,
    [seasonFrom, codes, config.tz || "Asia/Bangkok"]
  );
  const flowOf = new Map(flow.map((r) => [r.ym, r]));

  const r1 = (v) => Math.round(v * 10) / 10;
  const byMonth = new Map();
  for (const d0 of days) {
    if (d0 < dataFrom) continue; // before the first record there is nothing to average
    const ym = d0.slice(0, 7);
    (byMonth.get(ym) || byMonth.set(ym, []).get(ym)).push(d0);
  }
  const monthStat = (ym, list) => {
    const totals = list.map((d0) => tot(at(d0)));
    const peak = Math.max(...totals);
    const low = Math.min(...totals);
    const avgOf = (f) => r1(list.reduce((a, d0) => a + f(at(d0)), 0) / list.length);
    const f = flowOf.get(ym) || { opened: 0, closed: 0 };
    return {
      ym, days: list.length, partial: ym === t0.slice(0, 7) || (ym === dataFrom.slice(0, 7) && dataFrom.slice(8) !== "01"), avg: avgOf(tot), avgCases: avgOf((o) => o.case), avgSr: avgOf((o) => o.sr), avgTasks: avgOf((o) => o.task),
      peak, peakDay: list[totals.indexOf(peak)], low, lowDay: list[totals.indexOf(low)], opened: f.opened, closed: f.closed,
      byTeam: Object.fromEntries(codes.map((c) => [c, avgOf((o) => o.teams[c] || 0)])),
    };
  };
  const allMonths = [...byMonth.entries()].map(([ym, list]) => monthStat(ym, list));
  const months = allMonths.filter((x) => x.ym >= from.slice(0, 7));
  const shown = days.filter((d0) => d0 >= from && d0 >= dataFrom);
  const totals = shown.map((d0) => tot(at(d0)));
  const peak = totals.length ? Math.max(...totals) : 0;
  const years = [...new Set(allMonths.map((x) => x.ym.slice(0, 4)))];
  const data = {
    today: t0, range, team, teams, from: shown[0] || t0, dataFrom,
    days: shown, cases: shown.map((d0) => at(d0).case), sr: shown.map((d0) => at(d0).sr), tasks: shown.map((d0) => at(d0).task),
    byTeam: team ? {} : Object.fromEntries(codes.map((c) => [c, shown.map((d0) => at(d0).teams[c] || 0)]).filter(([, v]) => v.some((n) => n > 0))),
    summary: { avg: totals.length ? r1(totals.reduce((a, b) => a + b, 0) / totals.length) : 0, peak, peakDay: shown[totals.indexOf(peak)] || null,
      busiest: months.filter((x) => !x.partial).sort((a, b) => b.avg - a.avg)[0] || null, quietest: months.filter((x) => !x.partial).sort((a, b) => a.avg - b.avg)[0] || null },
    months,
    // Same month across the years: average cases open at the same time, and how many cases came in.
    season: years.map((yy) => ({ year: yy, months: Array.from({ length: 12 }, (_, i) => {
      const x = allMonths.find((q) => q.ym === `${yy}-${String(i + 1).padStart(2, "0")}`);
      return x ? { avgCases: x.avgCases, opened: x.opened, partial: x.partial } : null;
    }) })),
  };
  histCache.set(key, { at: Date.now(), data });
  if (histCache.size > 60) histCache = new Map([[key, histCache.get(key)]]);
  return data;
}

// ------------------------------------------------------------ customer satisfaction
const validDay = (v, dflt) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : dflt);
async function csatReport(user, qy) {
  if (!canSee(user) && user.role !== "viewer") throw bad("ไม่มีสิทธิ์", 403);
  const scope = perms.teamScope(user);
  const teams = (await all("SELECT code, label FROM teams ORDER BY sort")).filter((t) => !scope || scope.includes(t.code));
  const team = teams.some((t) => t.code === qy.team) ? qy.team : "";
  const to = validDay(qy.to, todayIso());
  const from = validDay(qy.from, d.toISODate(d.addDays(d.today(), -90)));
  if (from > to) throw bad("วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด");
  const rows = await all(
    `SELECT s.id, s.rating, s.comment, s.sent_at, s.rated_at, c.id AS case_id, c.case_no, c.site, c.product, c.team, c.task, u.display_name AS owner, tm.label AS team_label
       FROM case_csat s JOIN cases c ON c.id = s.case_id LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN teams tm ON tm.code = c.team
      WHERE s.sent_at >= $1::date AND s.sent_at < ($2::date + 1) AND c.team = ANY($3) ORDER BY COALESCE(s.rated_at, s.sent_at) DESC`,
    [from, to, team ? [team] : teams.map((t) => t.code)]
  );
  const answered = rows.filter((r) => r.rating != null);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, r) => a + Number(r.rating), 0) / xs.length) * 100) / 100 : null);
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key] || "(ไม่ระบุ)";
      const g = m.get(k) || m.set(k, { name: k, sent: 0, list: [] }).get(k);
      g.sent++;
      if (r.rating != null) g.list.push(r);
    }
    return [...m.values()].map((g) => ({ name: g.name, sent: g.sent, answered: g.list.length, avg: avg(g.list), low: g.list.filter((r) => r.rating <= 2).length, high: g.list.filter((r) => r.rating >= 4).length }))
      .sort((a, b) => b.answered - a.answered || b.sent - a.sent || a.name.localeCompare(b.name));
  };
  const showOwner = user.role !== "viewer"; // viewers never see per-person results
  return {
    from, to, team, teams,
    summary: { sent: rows.length, answered: answered.length, rate: rows.length ? Math.round((answered.length / rows.length) * 100) : null, avg: avg(answered), low: answered.filter((r) => r.rating <= 2).length,
      dist: [1, 2, 3, 4, 5].map((n) => answered.filter((r) => Number(r.rating) === n).length) },
    byCustomer: group("site"), byProduct: group("product"), byOwner: showOwner ? group("owner") : [],
    answers: answered.slice(0, 300).map((r) => ({ caseId: r.case_id, caseNo: r.case_no, site: r.site, product: r.product, team: r.team_label || r.team, owner: showOwner ? r.owner || "" : "", task: r.task, rating: Number(r.rating), comment: r.comment || "", ratedAt: r.rated_at })),
  };
}
async function csatWorkbook(rep) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols;
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const gcols = (first) => [{ header: first, key: "name", width: 34 }, { header: "ส่งแบบสอบถาม", key: "sent", width: 16 }, { header: "ตอบ", key: "answered", width: 10 }, { header: "คะแนนเฉลี่ย", key: "avg", width: 14 }, { header: "คะแนน 4–5", key: "high", width: 12 }, { header: "คะแนน 1–2", key: "low", width: 12 }];
  const s = rep.summary;
  sheet("สรุป", [{ header: "รายการ", key: "k", width: 30 }, { header: "ค่า", key: "v", width: 24 }], [
    { k: "ช่วงวันที่", v: `${rep.from} ถึง ${rep.to}` }, { k: "ทีม", v: rep.team || "ทุกทีมที่เห็น" }, { k: "ส่งแบบสอบถาม", v: s.sent }, { k: "ลูกค้าตอบ", v: s.answered },
    { k: "อัตราการตอบ (%)", v: s.rate }, { k: "คะแนนเฉลี่ย", v: s.avg }, { k: "คะแนน 1–2", v: s.low }, ...s.dist.map((n, i) => ({ k: `ให้ ${i + 1} คะแนน`, v: n })),
  ]);
  sheet("ตามลูกค้า", gcols("ลูกค้า"), rep.byCustomer);
  sheet("ตาม Product", gcols("Product"), rep.byProduct);
  if (rep.byOwner.length) sheet("ตาม Engineer", gcols("Engineer"), rep.byOwner);
  sheet("คำตอบ", [{ header: "วันที่ตอบ", key: "ratedAt", width: 20 }, { header: "เคส", key: "caseNo", width: 18 }, { header: "ลูกค้า", key: "site", width: 26 }, { header: "Product", key: "product", width: 20 }, { header: "ทีม", key: "team", width: 20 },
    ...(rep.byOwner.length ? [{ header: "Engineer", key: "owner", width: 24 }] : []), { header: "คะแนน", key: "rating", width: 9 }, { header: "ความเห็น", key: "comment", width: 60 }, { header: "งาน", key: "task", width: 50 }], rep.answers);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function mount(api, { wrap }) {
  api.get("/workload/history", wrap(async (req, res) => res.json(await history(req.user, req.query || {}))));
  api.get("/workload", wrap(async (req, res) => res.json(await workload(req.user, String(req.query.team || "")))));
  api.get("/csat-report", wrap(async (req, res) => res.json(await csatReport(req.user, req.query || {}))));
  api.get("/csat-report.xlsx", wrap(async (req, res) => {
    const rep = await csatReport(req.user, req.query || {});
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=csat-${rep.from}_${rep.to}.xlsx`);
    res.send(await csatWorkbook(rep));
  }));
}

module.exports = { mount, workload, csatReport };
