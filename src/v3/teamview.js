// Overview by team: one card per team (open / near due / overdue / closed this month / SLA / open service requests),
// and a team page with every member's workload. Admin and observer see every team; a manager sees their own teams.
// Engineers do not get this page (it shows teammates' numbers).
const d = require("../dates");
const { all } = require("./db");
const perms = require("./perms");
const repo = require("./caserepo");
const { stageCounts } = require("../routes");

const OPEN_SR = ["pending", "info", "in_progress"];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const canSee = (u) => ["admin", "manager", "observer"].includes(u.role);

function monthRange(ym) {
  const t = d.today();
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  const from = m ? new Date(+m[1], +m[2] - 1, 1) : new Date(t.getFullYear(), t.getMonth(), 1);
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 0);
  return { ym: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`, from, to };
}
function stats(list, R) {
  const k = stageCounts(list);
  const closed = list.filter((c) => c.stage === "closed" && c.endDate && c.endDate >= R.from && c.endDate <= R.to);
  const onTime = closed.filter((c) => c.closedOnTime === true).length;
  return { open: k.open, overdue: k.overdue, soon: k.r1 + k.r2, closed: closed.length, onTime, slaPct: closed.length ? Math.round((onTime / closed.length) * 100) : null };
}
const top = (list, n = 3) => {
  const m = {};
  list.forEach((c) => c.site && (m[c.site] = (m[c.site] || 0) + 1));
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
};

async function teamsFor(user) {
  const scope = perms.teamScope(user);
  const rows = await all("SELECT code, label FROM teams ORDER BY sort, code");
  return scope ? rows.filter((t) => scope.includes(t.code)) : rows;
}

function mount(api, { wrap }) {
  api.get("/teams/overview", wrap(async (req, res) => {
    if (!canSee(req.user)) throw bad("หน้านี้สำหรับ Manager, Observer และ Admin", 403);
    const R = monthRange(req.query.month);
    const teams = await teamsFor(req.user);
    const codes = teams.map((t) => t.code);
    const cases = (await repo.loadCases(req.user)).filter((c) => codes.includes(c.team));
    const [members, srs] = await Promise.all([
      all(`SELECT t.team, count(*)::int AS n FROM user_teams t JOIN users u ON u.id = t.user_id WHERE u.active AND u.role IN ('engineer','manager') AND t.team = ANY($1) GROUP BY t.team`, [codes]),
      all(`SELECT team, count(*)::int AS n FROM service_requests WHERE status = ANY($1) AND team = ANY($2) GROUP BY team`, [OPEN_SR, codes]),
    ]);
    const mem = Object.fromEntries(members.map((r) => [r.team, r.n]));
    const sr = Object.fromEntries(srs.map((r) => [r.team, r.n]));
    res.json({
      month: R.ym,
      total: { ...stats(cases, R), srOpen: srs.reduce((a, r) => a + r.n, 0) },
      teams: teams.map((t) => {
        const list = cases.filter((c) => c.team === t.code);
        return { code: t.code, label: t.label, members: mem[t.code] || 0, srOpen: sr[t.code] || 0, ...stats(list, R), topCustomers: top(list.filter((c) => c.stage !== "closed").length ? list.filter((c) => c.stage !== "closed") : list) };
      }),
    });
  }));

  api.get("/teams/overview/:code", wrap(async (req, res) => {
    if (!canSee(req.user)) throw bad("หน้านี้สำหรับ Manager, Observer และ Admin", 403);
    const teams = await teamsFor(req.user);
    const team = teams.find((t) => t.code === req.params.code);
    if (!team) throw bad("ไม่พบทีมนี้ หรือไม่ใช่ทีมของคุณ", 404);
    const R = monthRange(req.query.month);
    const cases = (await repo.loadCases(req.user)).filter((c) => c.team === team.code);
    const people = await all(
      `SELECT u.id, u.display_name AS name, u.email, u.role, u.avatar FROM users u JOIN user_teams t ON t.user_id = u.id
        WHERE u.active AND u.role IN ('engineer','manager') AND t.team = $1 ORDER BY u.display_name`,
      [team.code]
    );
    const srRows = await all(
      `SELECT assignee_id AS id, count(*)::int AS n FROM service_requests WHERE status = ANY($1) AND team = $2 AND assignee_id IS NOT NULL GROUP BY assignee_id`,
      [OPEN_SR, team.code]
    );
    const srBy = Object.fromEntries(srRows.map((r) => [r.id, r.n]));
    const members = people
      .map((p) => {
        const list = cases.filter((c) => c.owner_id === p.id);
        return { id: p.id, ownerKey: String(p.email || "").toLowerCase(), name: p.name, role: p.role, avatar: p.avatar, srOpen: srBy[p.id] || 0, ...stats(list, R), customers: top(list.filter((c) => c.stage !== "closed"), 3) };
      })
      .sort((a, b) => b.open - a.open || b.overdue - a.overdue || a.name.localeCompare(b.name));
    const srOpen = await all(`SELECT count(*)::int AS n FROM service_requests WHERE status = ANY($1) AND team = $2`, [OPEN_SR, team.code]);
    const urgent = cases
      .filter((c) => c.stage === "overdue" || c.stage === "r2" || c.stage === "r1")
      .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0) || (b.age || 0) - (a.age || 0))
      .slice(0, 30)
      .map((c) => ({ id: c.id, caseNo: c.caseNo, site: c.site, task: c.task, owner: c.owner, stage: c.stage, severity: c.severity, dueDate: c.dueDate ? d.toISODate(c.dueDate) : null, daysOverdue: c.daysOverdue || 0 }));
    res.json({ month: R.ym, team, teams, total: { ...stats(cases, R), srOpen: srOpen[0].n }, members, urgent });
  }));
}

module.exports = { mount };
