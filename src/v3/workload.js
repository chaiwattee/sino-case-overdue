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
    `SELECT u.id, u.display_name, u.role, array_agg(DISTINCT t.team) AS teams FROM users u JOIN user_teams t ON t.user_id = u.id
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
      id: p.id, name: p.display_name, role: p.role, teams: p.teams.filter((x) => codes.includes(x)),
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
