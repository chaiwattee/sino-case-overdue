// Work summary at the top of "งานของฉัน" (manager side: approvals waiting + the team at a glance) and the admin
// "ผลงาน Manager" page: per manager, approvals now and this month (from closereq.managerResponse), the team's
// overdue cases, SLA on-time rate and customer satisfaction for the month.
const { one, all } = require("./db");
const d = require("../dates");
const closereq = require("./closereq");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || "")) || [null, ...d.toISODate(d.today()).slice(0, 7).split("-")];
  const from = new Date(`${m[1]}-${m[2]}-01T00:00:00+07:00`);
  const to = new Date(from);
  to.setMonth(to.getMonth() + 1);
  return { month: `${m[1]}-${m[2]}`, from, to, fromDate: `${m[1]}-${m[2]}-01`, toDate: d.toISODate(new Date(to.getTime() - 86400000 + 7 * 3600000)) };
}

/** Team figures for a set of teams: open / overdue now, SLA on-time and CSAT in the month. */
async function teamStats(teams, r) {
  if (!teams.length) return { open: 0, overdue: 0, closed: 0, onTime: 0, sla: null, csat: null, csatN: 0 };
  // Same stage rules as the case pages (extensions included).
  const cases = await require("./caserepo").loadCases(null, { where: "c.team = ANY($1)", params: [teams] });
  const open = cases.filter((c) => c.stage !== "closed");
  const closed = await one(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE end_date <= due_date)::int AS ok FROM cases
      WHERE team = ANY($1) AND end_date BETWEEN $2 AND $3 AND lower(status) = ANY($4)`, [teams, r.fromDate, r.toDate, require("../config").config.closedStatuses]);
  const cs = await one(
    `SELECT round(avg(s.rating)::numeric, 1) AS avg, count(s.rating)::int AS n FROM case_csat s JOIN cases c ON c.id = s.case_id
      WHERE c.team = ANY($1) AND s.rated_at >= $2 AND s.rated_at < $3`, [teams, r.from.toISOString(), r.to.toISOString()]).catch(() => ({ avg: null, n: 0 }));
  return {
    open: open.length, overdue: open.filter((c) => c.stage === "overdue").length,
    closed: closed.n, onTime: closed.ok, sla: closed.n ? Math.round((closed.ok / closed.n) * 100) : null,
    csat: cs.avg != null ? Number(cs.avg) : null, csatN: cs.n,
  };
}

async function managerRows(r, onlyId) {
  const mgrs = await all(`SELECT u.id, u.display_name AS name, array_remove(array_agg(ut.team ORDER BY ut.team), NULL) AS teams
    FROM users u LEFT JOIN user_teams ut ON ut.user_id = u.id WHERE u.active AND u.role = 'manager' ${onlyId ? "AND u.id = $1" : ""} GROUP BY u.id ORDER BY u.display_name`, onlyId ? [onlyId] : []);
  const resp = new Map((await closereq.managerResponse(r.from, r.to)).map((x) => [x.id, x]));
  const out = [];
  for (const m of mgrs) {
    const a = resp.get(m.id) || { total: 0, onTime: 0, late: 0, pending: 0, score: null, avgLate: 0, items: [] };
    // Waiting now (any month): close requests of the manager's teams, extensions sent to them.
    const now = await one(
      `SELECT (SELECT count(*)::int FROM case_close_requests x JOIN cases c ON c.id = x.case_id WHERE x.state = 'pending' AND c.team = ANY($1) AND x.requested_by <> $2) AS close,
              (SELECT count(*)::int FROM case_extensions e WHERE e.status = 'pending' AND e.stage = 'manager' AND e.approver_id = $2) AS ext,
              (SELECT min(x.requested_at) FROM case_close_requests x JOIN cases c ON c.id = x.case_id WHERE x.state = 'pending' AND c.team = ANY($1) AND x.requested_by <> $2) AS oldest`,
      [m.teams, m.id]);
    out.push({
      id: m.id, name: m.name, teams: m.teams,
      waiting: now.close + now.ext, waitingClose: now.close, waitingExt: now.ext, oldestWaiting: now.oldest,
      answered: a.total, onTime: a.onTime, late: a.late, score: a.total ? a.score : null, lateItems: a.items,
      team: await teamStats(m.teams, r),
    });
  }
  return out;
}

function mount(api, { wrap }) {
  // Manager part of the My Work summary (engineers build theirs from data the page already has).
  api.get("/mywork/summary", wrap(async (req, res) => {
    const u = req.user;
    if (u.role !== "manager") return res.json({ role: u.role });
    const r = monthRange();
    const [row] = await managerRows(r, u.id);
    const teams = u.teams || [];
    const extra = await one(
      `SELECT (SELECT count(*)::int FROM intakes i LEFT JOIN intake_sites s ON lower(s.site) = lower(i.site)
                WHERE i.status = 'pending' AND NOT i.is_test AND (s.team IS NULL OR s.team = ANY($1))) AS intake,
              (SELECT count(*)::int FROM service_requests WHERE status = 'pending' AND team = ANY($1)) AS sr_pending`, [teams]);
    res.json({ role: "manager", month: r.month, me: row || null, intake: extra.intake, srPending: extra.sr_pending });
  }));
  api.get("/reports/managers", wrap(async (req, res) => {
    if (!["admin", "observer"].includes(req.user.role)) throw bad("หน้านี้สำหรับ Admin", 403);
    const r = monthRange(req.query.month);
    res.json({ month: r.month, respondDays: closereq.RESPOND_DAYS, rows: await managerRows(r) });
  }));
}

module.exports = { mount, managerRows, teamStats };
