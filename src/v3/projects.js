// Projects & tasks for the Project Manager team.
//
// project ─┬─ milestone ─┬─ task "own" (the PM does it: todo → doing → done)
//          │             └─ task "sr"  (handed to a team: opens a service request; the task reads its status from it)
//          └─ documents
//
// Who: PM = a member of the PM team(s) (setting project_teams, default PROJMGR) or an admin. A PM edits the projects
// they run; a manager of the PM team edits every project. Managers of other teams and the people who got a task see
// those tasks only. Admin / observer / viewer see every project (viewer and engineers never see costs).
// KPI: a task is on time when it is done by kpi_due. A due date moved BEFORE it falls due moves kpi_due too; a date
// moved after it was already late does not (the work may still continue, but it counts as late).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config3 } = require("./config3");
const d = require("../dates");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const { q, one, all, tx, getSetting, setSetting, audit } = require("./db");
const perms = require("./perms");
const sr = require("./sr");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (s, n = 2000) => String(s == null ? "" : s).replace(/\u0000/g, "").trim().slice(0, n);
const isoDay = (v) => (v ? (typeof v === "string" ? v.slice(0, 10) : d.toISODate(v)) : null);
const thai = (v) => (v ? d.thaiDate(isoDay(v)) : "-");
const todayIso = () => d.toISODate(d.today());
const STATUS = { plan: "วางแผน", active: "กำลังดำเนินการ", delivered: "ส่งมอบแล้ว", cancelled: "ยกเลิก" };
const TASK_ST = { planned: "ยังไม่มอบงาน", pending: "รอรับงาน", todo: "ยังไม่เริ่ม", doing: "กำลังทำ", submitted: "ส่งงานแล้ว รอ PM ยืนยัน", done: "เสร็จ", cancelled: "ยกเลิก" };
const DOC_CATS = ["เอกสารเริ่มโครงการ", "สัญญา / ลงนาม", "ออกแบบระบบ", "รายงานการประชุม", "UAT / ส่งมอบ", "อื่น ๆ"];
const FILE_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "zip", "vsdx", "msg"];
const MAX_FILE_MB = 20;
const FILE_DIR = path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"), "projects");
const AUTO_OPEN_DAYS = 7; // working days before a task's start when an "auto" task opens its service request
const url = (id) => `${config3.baseUrl}/#/projects/${id}`;
const num = (v) => Math.round(Number(v || 0) * 10) / 10;

// ------------------------------------------------------------ settings & people
async function settings() {
  const s = (await getSetting("projects", null)) || {};
  return { teams: Array.isArray(s.teams) && s.teams.length ? s.teams : ["PROJMGR"], mdRate: Number(s.mdRate) || 0 };
}
const inTeams = (user, teams) => (user.teams || []).some((t) => teams.includes(t));
async function isPm(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return ["engineer", "manager"].includes(user.role) && inTeams(user, (await settings()).teams);
}
async function isPmLead(user) {
  if (user.role === "admin") return true;
  return user.role === "manager" && inTeams(user, (await settings()).teams);
}
async function canEdit(user, p) {
  if (!user || !p) return false;
  if (user.role === "admin") return true;
  if (p.pm_id === user.id && (await isPm(user))) return true;
  return isPmLead(user);
}
/** Full view of a project (every task, costs for PM / managers / admin). */
async function seesAll(user, p) {
  if (["admin", "observer", "viewer"].includes(user.role)) return true;
  return canEdit(user, p);
}
/** Costs (baht) are for the PM, managers and admins only. */
const costVisible = async (user, p) => user.role === "admin" || user.role === "manager" || (p ? await canEdit(user, p) : await isPm(user));
/** Tasks a non-PM may see in a project: those handed to their teams (manager) or to them (assignee). */
async function myTaskIds(user, projectId) {
  const rows = await all(
    `SELECT t.id FROM project_tasks t
       LEFT JOIN service_requests s ON s.project_task_id = t.id AND s.status NOT IN ('rejected','cancelled')
      WHERE t.project_id = $1 AND t.kind = 'sr' AND (s.assignee_id = $2 OR ($3 AND t.team = ANY($4)))`,
    [projectId, user.id, user.role === "manager", user.teams || []]
  );
  return rows.map((r) => r.id);
}
async function pmTeamManagers() {
  const { teams } = await settings();
  return all(`SELECT DISTINCT u.id, u.email, u.display_name FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = ANY($1)`, [teams]);
}
async function pmPeople() {
  const { teams } = await settings();
  return all(
    `SELECT DISTINCT u.id, u.display_name, u.email FROM users u LEFT JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND (u.role = 'admin' OR (u.role IN ('engineer','manager') AND t.team = ANY($1))) ORDER BY u.display_name`,
    [teams]
  );
}

// ------------------------------------------------------------ reading
const TASK_SQL = `SELECT t.*, s.id AS sr_id, s.sr_no, s.status AS sr_status, s.target_date AS sr_target, s.assignee_id, COALESCE(a.display_name, s.assignee_ext_name) AS assignee_name, COALESCE(a.email, s.assignee_ext_email) AS assignee_email,
    s.closed_at AS sr_closed_at, s.confirmed_at AS sr_confirmed_at, s.rating AS sr_rating, s.outcome AS sr_outcome, s.ext_target AS sr_ext_target, s.ext_reason AS sr_ext_reason,
    eb.display_name AS sr_ext_by, tm.label AS team_label, m.name AS milestone_name,
    (SELECT COALESCE(sum(e.md),0) FROM project_task_events e WHERE e.task_id = t.id) AS md_act
  FROM project_tasks t
  LEFT JOIN LATERAL (SELECT * FROM service_requests x WHERE x.project_task_id = t.id ORDER BY (x.status IN ('rejected','cancelled')), x.id DESC LIMIT 1) s ON true
  LEFT JOIN users a ON a.id = s.assignee_id LEFT JOIN users eb ON eb.id = s.ext_by
  LEFT JOIN teams tm ON tm.code = t.team LEFT JOIN project_milestones m ON m.id = t.milestone_id`;

/** The status a task shows: own tasks keep their own; handed-over tasks read the service request. */
function taskStatus(t) {
  if (t.kind === "own") return { status: t.status, doneAt: isoDay(t.done_at) };
  if (t.status === "cancelled") return { status: "cancelled", doneAt: null }; // cancelled by the PM
  if (!t.sr_id) return { status: "planned", doneAt: null };
  const closed = t.sr_closed_at ? d.toISODate(new Date(t.sr_closed_at)) : null;
  switch (t.sr_status) {
    case "pending": case "info": return { status: "pending", doneAt: null };
    case "in_progress": return { status: "doing", doneAt: null };
    case "done": return t.sr_outcome === "delivered" || !t.sr_outcome ? { status: t.sr_confirmed_at ? "done" : "submitted", doneAt: closed } : { status: "cancelled", doneAt: closed };
    default: return { status: "planned", doneAt: null, srGone: true }; // rejected / cancelled: the PM may hand it over again
  }
}
function serTask(t, hol, noKpi) {
  const st = taskStatus(t);
  const t0 = todayIso();
  const due = isoDay(t.due_date);
  const open = !["done", "submitted", "cancelled"].includes(st.status);
  const overdue = open && due < t0;
  return {
    id: t.id, projectId: t.project_id, milestoneId: t.milestone_id, milestone: t.milestone_name || "", name: t.name, detail: t.detail || "",
    kind: t.kind, team: t.team, teamLabel: t.team_label || "", severity: t.severity,
    start: isoDay(t.start_date), due, base: isoDay(t.base_date), kpiDue: isoDay(t.kpi_due), srOpen: t.sr_open,
    status: st.status, statusLabel: TASK_ST[st.status], doneAt: st.doneAt, srGone: !!st.srGone,
    overdue, overdueDays: overdue ? sr.workdaysBetween(due, t0, hol) : 0, daysLeft: open && !overdue ? sr.workdaysBetween(t0, due, hol) : null,
    onTime: st.doneAt ? st.doneAt <= isoDay(t.kpi_due) : null,
    sr: t.sr_id ? { id: t.sr_id, no: t.sr_no, status: t.sr_status, rating: t.sr_rating, ext: t.sr_ext_target ? { target: isoDay(t.sr_ext_target), reason: t.sr_ext_reason, by: t.sr_ext_by } : null } : null,
    assignee: t.assignee_id || t.assignee_name ? { id: t.assignee_id, name: t.assignee_name } : null,
    mdEst: num(t.md_est), mdAct: num(t.md_act), sort: t.sort,
    ownerText: t.owner_text || "", planNo: t.plan_no || null, pred: t.pred || "", pct: ["done", "submitted"].includes(st.status) ? 100 : t.kind === "own" ? t.pct || 0 : 0,
    noMd: !!(noKpi && t.kind === "sr" && noKpi.has(t.team)), // a team without KPI is not asked for man-days
  };
}
async function loadProject(id) {
  return one(`SELECT p.*, u.display_name AS pm_name, u.email AS pm_email FROM projects p LEFT JOIN users u ON u.id = p.pm_id WHERE p.id = $1`, [Number(id)]);
}
const serProject = (p) => ({
  id: p.id, name: p.name, customer: p.customer || "", template: p.template || "", pm: p.pm_id ? { id: p.pm_id, name: p.pm_name } : null,
  start: isoDay(p.start_date), end: isoDay(p.end_date), status: p.status, statusLabel: STATUS[p.status], description: p.description || "", deliveredAt: isoDay(p.delivered_at),
  report: { to: p.report_to || "", cc: p.report_cc || "", freq: p.report_freq || "off", note: p.report_note || "", last: isoDay(p.report_last) },
});
async function tasksOf(projectId, hol) {
  hol = hol || (await sr.holidays());
  const noKpi = await require("./kpiprofiles").noKpiTeams();
  return (await all(`${TASK_SQL} WHERE t.project_id = $1 ORDER BY m.sort NULLS LAST, m.due_date, t.sort, t.start_date, t.id`, [projectId])).map((t) => serTask(t, hol, noKpi));
}
function summary(tasks) {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const done = live.filter((t) => t.status === "done" || t.status === "submitted");
  return {
    total: live.length, done: done.length, overdue: live.filter((t) => t.overdue).length,
    onTime: done.filter((t) => t.onTime).length, mdEst: num(live.reduce((a, t) => a + t.mdEst, 0)), mdAct: num(tasks.reduce((a, t) => a + t.mdAct, 0)),
  };
}
function milestoneState(m, tasks) {
  const ts = tasks.filter((t) => t.milestoneId === m.id && t.status !== "cancelled");
  const done = ts.filter((t) => ["done", "submitted"].includes(t.status));
  const due = isoDay(m.due_date);
  if (ts.length && done.length === ts.length) {
    const last = done.map((t) => t.doneAt).sort().pop();
    return last <= due ? ["met", "ทันกำหนด"] : ["late", "เสร็จช้ากว่ากำหนด"];
  }
  if (due < todayIso()) return ["missed", "เลยกำหนด"];
  if (ts.some((t) => t.overdue)) return ["risk", "เสี่ยง: มี task เลยกำหนด"];
  return ["plan", "ตามแผน"];
}

async function visibleProjects(user) {
  const s = await settings();
  if (["admin", "observer", "viewer"].includes(user.role) || (await isPmLead(user))) return all("SELECT id FROM projects ORDER BY id DESC");
  const pm = await isPm(user);
  return all(
    `SELECT DISTINCT p.id FROM projects p
       LEFT JOIN project_tasks t ON t.project_id = p.id AND t.kind = 'sr'
       LEFT JOIN service_requests x ON x.project_task_id = t.id AND x.status NOT IN ('rejected','cancelled')
      WHERE ($2 AND p.pm_id = $1) OR x.assignee_id = $1 OR ($3 AND t.team = ANY($4) AND x.id IS NOT NULL)
      ORDER BY p.id DESC`,
    [user.id, pm, user.role === "manager", (user.teams || []).filter((t) => !s.teams.includes(t))]
  );
}
async function projectFor(user, id, { edit = false } = {}) {
  const p = await loadProject(id);
  if (!p) throw bad("ไม่พบโปรเจกต์", 404);
  const full = await seesAll(user, p);
  const mine = full ? null : await myTaskIds(user, p.id);
  if (!full && !mine.length) throw bad("ไม่พบโปรเจกต์ หรือไม่มีสิทธิ์ดู", 404);
  if (edit && !(await canEdit(user, p))) throw bad("แก้ไขได้เฉพาะ PM ของโปรเจกต์ หรือ Manager ทีม PM", 403);
  return { p, full, mine };
}
async function taskFor(user, tid) {
  const t = await one("SELECT * FROM project_tasks WHERE id = $1", [Number(tid)]);
  if (!t) throw bad("ไม่พบ task", 404);
  const ctx = await projectFor(user, t.project_id);
  if (!ctx.full && !ctx.mine.includes(t.id)) throw bad("ไม่พบ task", 404);
  return { t, ...ctx };
}

// ------------------------------------------------------------ writing
function validDate(v, label) {
  const s = String(v || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label} ไม่ถูกต้อง`);
  return s;
}
async function addEvent(c, taskId, kind, text, data, userId, md = 0) {
  const r = await c.query("INSERT INTO project_task_events (task_id, kind, text, data, by_user, md) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [taskId, kind, text || null, data ? JSON.stringify(data) : null, userId || null, md || 0]);
  return r.rows[0].id;
}
async function touchActive(c, projectId) {
  await c.query("UPDATE projects SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'plan'", [projectId]);
}

async function createProject(user, b) {
  if (!(await isPm(user))) throw bad("สร้างโปรเจกต์ได้เฉพาะทีม Project Manager", 403);
  const name = clean(b.name, 200);
  if (name.length < 3) throw bad("ใส่ชื่อโปรเจกต์");
  const start = validDate(b.start, "วันเริ่ม");
  const end = validDate(b.end, "วันส่งมอบ");
  if (end < start) throw bad("วันส่งมอบต้องไม่ก่อนวันเริ่ม");
  let pmId = Number(b.pmId) || user.id;
  if (pmId !== user.id) {
    if (!(await isPmLead(user))) throw bad("เลือก PM คนอื่นได้เฉพาะ Manager ทีม PM", 403);
    if (!(await pmPeople()).some((u) => u.id === pmId)) throw bad("เลือก PM จากทีม Project Manager");
  }
  const tpl = b.templateId ? await one("SELECT * FROM project_templates WHERE id = $1", [Number(b.templateId)]) : null;
  const hol = await sr.holidays();
  const teams = new Set((await all("SELECT code FROM teams")).map((t) => t.code));
  const id = await tx(async (c) => {
    const r = await c.query(
      "INSERT INTO projects (name, customer, template, pm_id, start_date, end_date, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [name, clean(b.customer, 200) || null, tpl ? tpl.name : null, pmId, start, end, clean(b.description, 3000) || null, user.id]
    );
    const pid = r.rows[0].id;
    // A template's days are working days from the project start; a start on a holiday counts from the next working day.
    const day0 = sr.isWorkday(start, hol) ? start : sr.addWorkdays(start, 1, hol);
    const at = (n) => (n > 0 ? sr.addWorkdays(day0, n, hol) : day0);
    for (const [i, m] of ((tpl && tpl.milestones) || []).entries()) {
      const tasks = Array.isArray(m.tasks) ? m.tasks : [];
      const mdue = tasks.length ? at(Math.max(...tasks.map((x) => Number(x.end) || 0))) : end;
      const mr = await c.query("INSERT INTO project_milestones (project_id, name, due_date, sort) VALUES ($1,$2,$3,$4) RETURNING id", [pid, clean(m.name, 200) || `Milestone ${i + 1}`, mdue, i]);
      for (const [j, x] of tasks.entries()) {
        const team = x.team && teams.has(x.team) ? x.team : null;
        const s0 = at(Number(x.start) || 0);
        const e0 = at(Math.max(Number(x.end) || 0, Number(x.start) || 0));
        const tr = await c.query(
          `INSERT INTO project_tasks (project_id, milestone_id, name, kind, team, start_date, due_date, base_date, kpi_due, status, sr_open, md_est, sort, created_by, owner_text, plan_no, pred, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7,'todo',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [pid, mr.rows[0].id, clean(x.name, 200), team ? "sr" : "own", team, s0, e0, team ? "auto" : "now", num(x.md), j, user.id, clean(x.owner, 200) || null, Number.isInteger(x.no) ? x.no : null, clean(x.pred, 100) || null, String(x.detail || "").slice(0, 5000) || null]
        );
        await addEvent(c, tr.rows[0].id, "created", null, { template: tpl.name }, user.id);
      }
    }
    return pid;
  });
  await audit(user, "project_create", name, { id, template: tpl ? tpl.name : null });
  return id;
}
async function updateProject(user, p, b) {
  const name = clean(b.name ?? p.name, 200);
  if (name.length < 3) throw bad("ใส่ชื่อโปรเจกต์");
  const start = validDate(b.start ?? isoDay(p.start_date), "วันเริ่ม");
  const end = validDate(b.end ?? isoDay(p.end_date), "วันส่งมอบ");
  if (end < start) throw bad("วันส่งมอบต้องไม่ก่อนวันเริ่ม");
  let pmId = p.pm_id;
  if (b.pmId && Number(b.pmId) !== p.pm_id) {
    if (!(await isPmLead(user))) throw bad("เปลี่ยน PM ได้เฉพาะ Manager ทีม PM", 403);
    if (!(await pmPeople()).some((u) => u.id === Number(b.pmId))) throw bad("เลือก PM จากทีม Project Manager");
    pmId = Number(b.pmId);
  }
  let status = p.status;
  if (b.status && b.status !== p.status) {
    if (!["plan", "active", "cancelled", "delivered"].includes(b.status)) throw bad("สถานะไม่ถูกต้อง");
    if (b.status === "delivered") {
      const open = (await tasksOf(p.id)).filter((t) => !["done", "submitted", "cancelled"].includes(t.status));
      if (open.length) throw bad(`ยังมี ${open.length} task ที่ไม่เสร็จ ปิดหรือยกเลิก task ให้ครบก่อนส่งมอบ`);
    }
    status = b.status;
  }
  await q(
    `UPDATE projects SET name=$2, customer=$3, start_date=$4, end_date=$5, description=$6, pm_id=$7, status=$8,
       delivered_at = CASE WHEN $8 = 'delivered' THEN COALESCE(delivered_at, CURRENT_DATE) ELSE NULL END, updated_at=now() WHERE id=$1`,
    [p.id, name, clean(b.customer ?? p.customer, 200) || null, start, end, clean(b.description ?? p.description, 3000) || null, pmId, status]
  );
  if (pmId !== p.pm_id) {
    // Service requests already open keep their requester; new ones are asked by the new PM.
    await audit(user, "project_pm_change", name, { id: p.id, from: p.pm_id, to: pmId });
  }
  await audit(user, "project_update", name, { id: p.id, status });
}

async function addMilestone(user, p, b) {
  const name = clean(b.name, 200);
  if (!name) throw bad("ใส่ชื่อ milestone");
  const due = validDate(b.due, "วันที่ต้อง meet");
  const r = await one("SELECT COALESCE(max(sort),-1)+1 AS n FROM project_milestones WHERE project_id = $1", [p.id]);
  await q("INSERT INTO project_milestones (project_id, name, due_date, sort) VALUES ($1,$2,$3,$4)", [p.id, name, due, r.n]);
}
async function updateMilestone(user, mid, b) {
  const m = await one("SELECT * FROM project_milestones WHERE id = $1", [Number(mid)]);
  if (!m) throw bad("ไม่พบ milestone", 404);
  const { p } = await projectFor(user, m.project_id, { edit: true });
  if (b.remove) {
    if (await one("SELECT 1 FROM project_tasks WHERE milestone_id = $1", [m.id])) throw bad("ย้ายหรือลบ task ใน milestone นี้ก่อน");
    await q("DELETE FROM project_milestones WHERE id = $1", [m.id]);
    return p;
  }
  await q("UPDATE project_milestones SET name=$2, due_date=$3 WHERE id=$1", [m.id, clean(b.name ?? m.name, 200) || m.name, validDate(b.due ?? isoDay(m.due_date), "วันที่ต้อง meet")]);
  return p;
}

const predOf = (v) => clean(String(v == null ? "" : v).replace(/[^0-9,;\s]/g, "").replace(/[;\s]+/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, ""), 100) || null;
const pctOf = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
async function addTask(user, p, b) {
  const name = clean(b.name, 200);
  if (name.length < 3) throw bad("ใส่ชื่องาน");
  const ms = await one("SELECT id FROM project_milestones WHERE id = $1 AND project_id = $2", [Number(b.milestoneId), p.id]);
  if (!ms) throw bad("เลือก milestone (เพิ่ม milestone ก่อนถ้ายังไม่มี)");
  const kind = b.kind === "sr" ? "sr" : "own";
  const start = validDate(b.start, "วันเริ่ม");
  const due = validDate(b.due, "กำหนดเสร็จ");
  if (due < start) throw bad("กำหนดเสร็จต้องไม่ก่อนวันเริ่ม");
  let team = null;
  if (kind === "sr") {
    team = clean(b.team, 40);
    if (!(await one("SELECT 1 FROM teams WHERE code = $1", [team]))) throw bad("เลือกทีมที่จะมอบงาน");
    if (!sr.SEV[b.severity || "normal"]) throw bad("เลือกความเร่งด่วน");
    if (kind === "sr" && clean(b.detail, 5000).length < 20) throw bad("อธิบายงานและสิ่งที่ต้องส่งมอบอย่างน้อย 20 ตัวอักษร (ทีมผู้รับจะเห็น)");
  }
  const md = Math.max(0, num(b.mdEst));
  const srOpen = b.srOpen === "auto" ? "auto" : "now";
  const tid = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO project_tasks (project_id, milestone_id, name, detail, kind, team, severity, start_date, due_date, base_date, kpi_due, sr_open, md_est, sort, created_by, owner_text, pred, pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$10,$11,(SELECT COALESCE(max(sort),-1)+1 FROM project_tasks WHERE milestone_id = $2),$12,$13,$14,$15) RETURNING id`,
      [p.id, ms.id, name, clean(b.detail, 5000) || null, kind, team, b.severity && sr.SEV[b.severity] ? b.severity : "normal", start, due, srOpen, md, user.id, kind === "own" ? clean(b.ownerText, 200) || null : null, predOf(b.pred), kind === "own" ? pctOf(b.pct) : 0]
    );
    await addEvent(c, r.rows[0].id, "created", null, null, user.id);
    return r.rows[0].id;
  });
  let srNo = null;
  if (kind === "sr" && srOpen === "now") srNo = (await openSr(user, tid)).sr_no;
  await audit(user, "project_task_add", `${p.name} · ${name}`, { project: p.id, task: tid, kind, team });
  return { id: tid, srNo };
}
async function updateTask(user, t, p, b) {
  const name = clean(b.name ?? t.name, 200);
  if (name.length < 3) throw bad("ใส่ชื่องาน");
  let mid = t.milestone_id;
  if (b.milestoneId && Number(b.milestoneId) !== t.milestone_id) {
    const ms = await one("SELECT id FROM project_milestones WHERE id = $1 AND project_id = $2", [Number(b.milestoneId), p.id]);
    if (!ms) throw bad("เลือก milestone");
    mid = ms.id;
  }
  const start = validDate(b.start ?? isoDay(t.start_date), "วันเริ่ม");
  const live = t.kind === "sr" ? await one("SELECT id FROM service_requests WHERE project_task_id = $1 AND status NOT IN ('rejected','cancelled')", [t.id]) : null;
  let team = t.team;
  if (t.kind === "sr" && b.team && b.team !== t.team) {
    if (live) throw bad("มอบงานไปแล้ว เปลี่ยนทีมไม่ได้ ยกเลิกคำขอบริการเดิมก่อน หรือใช้การเปลี่ยนผู้รับผิดชอบใน SR");
    if (!(await one("SELECT 1 FROM teams WHERE code = $1", [b.team]))) throw bad("เลือกทีม");
    team = b.team;
  }
  await q(
    `UPDATE project_tasks SET name=$2, detail=$3, milestone_id=$4, start_date=$5, md_est=$6, team=$7, severity=$8, sr_open=$9, owner_text=$10, pred=$11, pct=$12, updated_at=now() WHERE id=$1`,
    [t.id, name, clean(b.detail ?? t.detail, 5000) || null, mid, start, Math.max(0, num(b.mdEst ?? t.md_est)), team, b.severity && sr.SEV[b.severity] ? b.severity : t.severity, b.srOpen === "auto" || b.srOpen === "now" ? b.srOpen : t.sr_open,
      t.kind === "own" ? (b.ownerText === undefined ? t.owner_text : clean(b.ownerText, 200) || null) : null, b.pred === undefined ? t.pred : predOf(b.pred), t.kind === "own" ? (b.pct === undefined ? t.pct : pctOf(b.pct)) : 0]
  );
}

/** The project as the Sinostech standard plan sheet. Predecessors keep pointing at the right line after tasks move. */
async function planExport(p, tasks) {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const seqOf = new Map();
  live.forEach((t, i) => t.planNo && !seqOf.has(t.planNo) && seqOf.set(t.planNo, i + 1));
  const stOf = (t) => (["done", "submitted"].includes(t.status) ? "Completed" : t.overdue ? "Delayed" : ["doing", "pending"].includes(t.status) || t.pct > 0 ? "In Progress" : "Not Started");
  const names = [...new Set(live.map((t) => t.milestone || "ไม่อยู่ใน milestone"))];
  let n = 0;
  const numbered = live.map((t) => ({ t, no: ++n }));
  return PLAN.planWorkbook({
    milestones: names.map((name) => ({
      name,
      tasks: numbered.filter((x) => (x.t.milestone || "ไม่อยู่ใน milestone") === name).map(({ t, no }) => ({
        no, name: t.detail ? `${t.name}\n${t.detail}` : t.name, owner: t.kind === "own" ? t.ownerText || p.pm_name || "PM" : [t.teamLabel, t.assignee && t.assignee.name].filter(Boolean).join(" · "),
        md: t.mdEst || null, pred: String(t.pred || "").split(",").filter(Boolean).map((x) => seqOf.get(Number(x)) || x).join(","), start: t.start, finish: t.due, pct: t.pct, status: stOf(t),
      })),
    })),
  });
}

/** PM moves a due date (own task, or a handed-over task whose SR is not approved yet). After approval the
 *  assignee asks through the SR and the PM decides there. */
async function moveDue(user, t, p, b) {
  const due = validDate(b.due, "กำหนดเสร็จใหม่");
  const reason = clean(b.reason, 1000);
  if (reason.length < 10) throw bad("ใส่เหตุผลอย่างน้อย 10 ตัวอักษร");
  if (due === isoDay(t.due_date)) return;
  if (due < isoDay(t.start_date)) throw bad("กำหนดเสร็จต้องไม่ก่อนวันเริ่ม");
  const live = t.kind === "sr" ? await one("SELECT * FROM service_requests WHERE project_task_id = $1 AND status NOT IN ('rejected','cancelled')", [t.id]) : null;
  if (live && live.status !== "pending" && live.status !== "info") throw bad(`${live.sr_no} อนุมัติแล้ว การเลื่อนต้องให้ผู้รับผิดชอบกด “ขอเลื่อน Target” ใน SR แล้ว PM อนุมัติ`);
  const old = isoDay(t.due_date);
  const early = todayIso() <= old; // moved before it fell due → the KPI follows the new date
  await tx(async (c) => {
    await c.query(`UPDATE project_tasks SET due_date=$2, ${early ? "kpi_due=$2," : ""} reminded='{}'::jsonb, updated_at=now() WHERE id=$1`, [t.id, due]);
    await addEvent(c, t.id, "due", reason, { from: old, to: due, kpi: early }, user.id);
    if (live) await c.query("UPDATE service_requests SET requested_date=$2, updated_at=now() WHERE id=$1", [live.id, due]);
  });
}
/** Called by sr.js when the PM approves an assignee's request to move the target of a project SR. */
async function onSrTargetMoved(s, oldTarget, newTarget, askedAt, userId) {
  if (!s.project_task_id) return;
  const early = askedAt && d.toISODate(new Date(askedAt)) <= oldTarget;
  await tx(async (c) => {
    await c.query(`UPDATE project_tasks SET due_date=$2, ${early ? "kpi_due=$2," : ""} reminded='{}'::jsonb, updated_at=now() WHERE id=$1`, [s.project_task_id, newTarget]);
    await addEvent(c, s.project_task_id, "due", s.ext_reason || null, { from: oldTarget, to: newTarget, kpi: !!early, sr: s.sr_no }, userId);
  });
}

async function setStatus(user, t, p, b) {
  if (t.kind !== "own") {
    if (b.status === "cancelled") {
      const live = await one("SELECT * FROM service_requests WHERE project_task_id = $1 AND status NOT IN ('rejected','cancelled','done')", [t.id]);
      if (live && !["pending", "info"].includes(live.status)) throw bad(`${live.sr_no} กำลังดำเนินการอยู่ ติดต่อ Manager ทีม ${live.team} ก่อนยกเลิก`);
      await tx(async (c) => {
        if (live) {
          await c.query("UPDATE service_requests SET status='cancelled', updated_at=now() WHERE id=$1", [live.id]);
          await c.query("INSERT INTO sr_events (sr_id, kind, text, by_user) VALUES ($1,'cancelled',$2,$3)", [live.id, "ยกเลิก task ในโปรเจกต์", user.id]);
        }
        await c.query("UPDATE project_tasks SET status='cancelled', updated_at=now() WHERE id=$1", [t.id]);
        await addEvent(c, t.id, "status", clean(b.note, 500) || null, { status: "cancelled" }, user.id);
      });
      return;
    }
    throw bad("สถานะของ task ที่มอบงานเปลี่ยนตามคำขอบริการ (SR)");
  }
  const st = b.status;
  if (!["todo", "doing", "done", "cancelled"].includes(st)) throw bad("สถานะไม่ถูกต้อง");
  await tx(async (c) => {
    await c.query("UPDATE project_tasks SET status=$2, done_at = CASE WHEN $2 = 'done' THEN CURRENT_DATE ELSE NULL END, updated_at=now() WHERE id=$1", [t.id, st]);
    await addEvent(c, t.id, "status", clean(b.note, 500) || null, { status: st }, user.id);
    if (st === "doing" || st === "done") await touchActive(c, p.id);
  });
}

/** Opens the service request of a handed-over task (now, or by the daily job for "auto" tasks). */
async function openSr(user, taskId) {
  const t = await one("SELECT * FROM project_tasks WHERE id = $1", [taskId]);
  if (!t || t.kind !== "sr") throw bad("task นี้ไม่ได้มอบงาน");
  if (t.status === "cancelled") throw bad("task นี้ยกเลิกแล้ว");
  if (await one("SELECT 1 FROM service_requests WHERE project_task_id = $1 AND status NOT IN ('rejected','cancelled')", [t.id])) throw bad("เปิดคำขอบริการของ task นี้แล้ว");
  const p = await loadProject(t.project_id);
  const requester = p.pm_id ? await one("SELECT * FROM users WHERE id = $1 AND active", [p.pm_id]) : null;
  if (!requester) throw bad("โปรเจกต์นี้ยังไม่มี PM ที่ใช้งานอยู่");
  const ms = t.milestone_id ? await one("SELECT name, due_date FROM project_milestones WHERE id = $1", [t.milestone_id]) : null;
  const detail = [
    clean(t.detail, 4000) || t.name,
    "",
    `โปรเจกต์: ${p.name}${p.customer ? ` · ${p.customer}` : ""}`,
    ms ? `Milestone: ${ms.name} (ต้อง meet ${thai(ms.due_date)})` : "",
    `เริ่ม ${thai(t.start_date)} · กำหนดเสร็จ ${thai(t.due_date)}${Number(t.md_est) ? ` · ประมาณการ ${num(t.md_est)} man-day` : ""}`,
    `ดูโปรเจกต์: ${url(p.id)}`,
  ].filter((x) => x !== "").join("\n");
  const s = await sr.createFromProject({ requester, team: t.team, title: `[โปรเจกต์] ${t.name}`, detail, severity: t.severity, customer: p.customer, due: isoDay(t.due_date), taskId: t.id });
  await tx(async (c) => {
    await addEvent(c, t.id, "sr_opened", null, { sr: s.sr_no }, user ? user.id : null);
    await touchActive(c, p.id);
  });
  return s;
}

// ------------------------------------------------------------ activity & files
function saveFile(projectId, f) {
  const name = clean(f.name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!FILE_EXT.includes(ext)) throw bad(`ไฟล์ .${ext} ไม่รองรับ (รองรับ ${FILE_EXT.join(", ")})`);
  const buf = Buffer.from(String(f.data || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw bad(`${name} เป็นไฟล์ว่าง`);
  if (buf.length > MAX_FILE_MB * 1048576) throw bad(`${name} ใหญ่เกิน ${MAX_FILE_MB} MB`);
  const dir = path.join(FILE_DIR, String(projectId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const stored = path.join(dir, crypto.randomBytes(16).toString("hex") + "." + ext);
  fs.writeFileSync(stored, buf, { mode: 0o640 });
  return { name, mime: clean(f.type, 100) || "application/octet-stream", size: buf.length, stored };
}
async function storeFiles(c, projectId, files, userId, { taskId = null, eventId = null, category = null } = {}) {
  const list = (Array.isArray(files) ? files : []).slice(0, 10);
  const saved = [];
  try {
    for (const f of list) saved.push(saveFile(projectId, f));
  } catch (e) {
    saved.forEach((x) => fs.rmSync(x.stored, { force: true }));
    throw e;
  }
  for (const x of saved) await c.query("INSERT INTO project_files (project_id, task_id, event_id, category, file_name, mime, size, path, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [projectId, taskId, eventId, category, x.name, x.mime, x.size, x.stored, userId]);
  return saved.length;
}
/** Who may log activity / man-days on a task: the PM (any task), the assignee and the team's managers (handed-over tasks). */
async function canLog(user, t, p) {
  if (await canEdit(user, p)) return true;
  if (t.kind !== "sr" || ["viewer", "observer"].includes(user.role)) return false;
  const s = await one("SELECT assignee_id, team FROM service_requests WHERE project_task_id = $1 AND status NOT IN ('rejected','cancelled')", [t.id]);
  if (!s) return false;
  return s.assignee_id === user.id || (user.role === "manager" && (user.teams || []).includes(s.team));
}
async function addLog(user, t, p, b) {
  const text = clean(b.text, 3000);
  const noMd = t.kind === "sr" && (await require("./kpiprofiles").noKpiTeams()).has(t.team);
  const md = noMd ? 0 : Math.max(0, Math.min(30, num(b.md)));
  const files = Array.isArray(b.files) ? b.files : [];
  if (!text && !md && !files.length) throw bad("พิมพ์สิ่งที่ทำ ใส่ man-day หรือแนบไฟล์");
  if (md && Math.round(md * 2) !== md * 2) throw bad("man-day ใส่ทีละครึ่งวัน เช่น 0.5, 1, 1.5");
  await tx(async (c) => {
    const ev = await addEvent(c, t.id, "note", text || null, null, user.id, md);
    await storeFiles(c, p.id, files, user.id, { taskId: t.id, eventId: ev });
    await c.query("UPDATE project_tasks SET updated_at = now() WHERE id = $1", [t.id]);
  });
}
async function taskDetail(user, t, p, full) {
  const hol = await sr.holidays();
  const row = await one(`${TASK_SQL} WHERE t.id = $1`, [t.id]);
  const events = await all(
    `SELECT e.id, e.kind, e.text, e.md, e.data, e.created_at, u.display_name AS by_name FROM project_task_events e LEFT JOIN users u ON u.id = e.by_user WHERE e.task_id = $1 ORDER BY e.created_at, e.id`,
    [t.id]
  );
  const files = await all("SELECT id, event_id, file_name, size, mime, created_at FROM project_files WHERE task_id = $1 ORDER BY id", [t.id]);
  const edit = await canEdit(user, p);
  const task = serTask(row, hol, await require("./kpiprofiles").noKpiTeams());
  return {
    task, events: events.map((e) => ({ ...e, md: num(e.md) })), files,
    can: {
      edit, log: (await canLog(user, t, p)) && task.status !== "cancelled",
      status: edit && t.kind === "own" && t.status !== "cancelled",
      due: edit && task.status !== "cancelled" && (t.kind === "own" || !task.sr || ["pending", "info"].includes(task.sr.status) || task.srGone),
      openSr: edit && t.kind === "sr" && !task.sr && task.status !== "cancelled",
      reopenSr: edit && t.kind === "sr" && task.srGone,
      cancel: edit && task.status !== "cancelled" && task.status !== "done" && task.status !== "submitted",
    },
    reminders: reminderPlan(task, hol),
  };
}
function reminderPlan(task, hol) {
  if (["done", "submitted", "cancelled"].includes(task.status)) return [];
  const who = task.kind === "own" ? "PM" : "PM + ผู้รับผิดชอบ";
  return [
    [sr.addWorkdays(task.due, -3, hol), "ก่อนครบกำหนด 3 วันทำการ", who],
    [sr.addWorkdays(task.due, -1, hol), "ก่อนครบกำหนด 1 วันทำการ", who],
    [sr.addWorkdays(task.due, 1, hol), "เลยกำหนด (แจ้งทุกวันทำการ)", task.kind === "own" ? "PM + Manager ทีม PM" : "PM + ผู้รับผิดชอบ + Manager ทีมผู้รับ"],
  ].map(([date, label, to]) => ({ date, label, to, past: date <= todayIso() }));
}

// ------------------------------------------------------------ templates
async function saveTemplate(user, p, b) {
  if (!(await isPm(user))) throw bad("ไม่มีสิทธิ์", 403);
  const name = clean(b.name, 120);
  if (name.length < 3) throw bad("ตั้งชื่อ template");
  const hol = await sr.holidays();
  const day0 = isoDay(p.start_date);
  const off = (x) => Math.max(0, sr.workdaysBetween(day0, isoDay(x), hol));
  const ms = await all("SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY sort, due_date", [p.id]);
  const ts = await all("SELECT * FROM project_tasks WHERE project_id = $1 AND status <> 'cancelled' ORDER BY sort, start_date", [p.id]);
  const milestones = ms.map((m) => ({ name: m.name, tasks: ts.filter((t) => t.milestone_id === m.id).map((t) => ({ name: t.name, team: t.kind === "sr" ? t.team : null, start: off(t.start_date), end: off(t.base_date), md: num(t.md_est), ...(t.owner_text ? { owner: t.owner_text } : {}), ...(t.plan_no ? { no: t.plan_no } : {}), ...(t.pred ? { pred: t.pred } : {}), ...(t.detail ? { detail: t.detail } : {}) })) }));
  const ex = await one("SELECT id FROM project_templates WHERE name = $1", [name]);
  if (ex && !(await isPmLead(user))) throw bad("มี template ชื่อนี้แล้ว ตั้งชื่ออื่น (แก้ template เดิมได้เฉพาะ Manager ทีม PM)");
  await q(
    `INSERT INTO project_templates (name, milestones, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (name) DO UPDATE SET milestones = EXCLUDED.milestones, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [name, JSON.stringify(milestones), user.id]
  );
  await audit(user, "project_template_save", name, { from: p.id });
}

// ------------------------------------------------------------ templates from Excel
// Column names the importer knows: the Sinostech standard plan (projectplan.js) first, then the older simple form.
// Compared in lower case with every space and line break removed.
const TPL_COLS = {
  no: ["no.", "no", "#", "ลำดับ"],
  milestone: ["milestone", "phase", "เฟส", "ขั้นตอน"],
  task: ["activity/task", "activity", "task", "taskname", "ชื่องาน", "งาน", "name"],
  owner: ["owner(who)", "owner", "who"],
  team: ["team", "ทีม", "resource", "resourcenames", "ผู้รับผิดชอบ"],
  start: ["start", "เริ่ม", "วันเริ่ม", "เริ่ม(วันทำการที่)", "startday"],
  end: ["finish", "end", "เสร็จ", "กำหนดเสร็จ", "เสร็จ(วันทำการที่)", "endday", "due"],
  md: ["estimatemanday", "estimateman-day", "man-day", "manday", "md", "work", "ประมาณการman-day"],
  pred: ["predecessors/dependency", "predecessors", "predecessor", "dependency"],
  pct: ["%comp.", "%comp", "%complete", "%"],
  status: ["status", "สถานะ"],
};
const MAX_TPL_ROWS = 1000;
const PLAN = require("./projectplan");
const STD_TEMPLATE = "Standard Project Plan";
/** The blank standard form: the Standard Project Plan template laid out from next Monday, ready to overwrite. */
async function templateForm() {
  const hol = await sr.holidays();
  const t0 = new Date(todayIso() + "T00:00:00Z");
  t0.setUTCDate(t0.getUTCDate() + ((8 - t0.getUTCDay()) % 7 || 7));
  let day0 = t0.toISOString().slice(0, 10);
  if (!sr.isWorkday(day0, hol)) day0 = sr.addWorkdays(day0, 1, hol);
  const at = (n) => (n > 0 ? sr.addWorkdays(day0, n, hol) : day0);
  const tpl = await one("SELECT milestones FROM project_templates WHERE name = $1", [STD_TEMPLATE]);
  const src = tpl && Array.isArray(tpl.milestones) && tpl.milestones.length ? tpl.milestones : [{ name: "Assessment & Planning", tasks: [{ name: "Kick-off meeting and implementation plan", start: 0, end: 0, md: 1 }] }];
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  return PLAN.planWorkbook({
    milestones: src.map((m) => ({ name: m.name, tasks: (m.tasks || []).map((t) => ({ no: t.no, name: t.name, owner: t.team || t.owner || "", md: t.md, pred: t.pred, start: at(Number(t.start) || 0), finish: at(Math.max(Number(t.end) || 0, Number(t.start) || 0)), pct: 0, status: "Not Started" })) })),
    help: [
      ["คอลัมน์", "วิธีกรอก"],
      ["แถว Milestone", "แถวสีเขียวเข้ม พิมพ์ชื่อ milestone ในคอลัมน์ A เช่น “Milestone 2 — Discovery & Design” (ข้อความหลังเครื่องหมาย | ไม่ถูกนำเข้า) · task ที่อยู่ใต้แถวนี้อยู่ใน milestone นี้"],
      ["No.", "ลำดับของ task ใช้อ้างในคอลัมน์ Predecessors"],
      ["Activity / Task", "ชื่องาน (ต้องมี) · แถวที่ช่องนี้ว่างจะถูกข้าม"],
      ["Owner (Who)", "ชื่อผู้รับผิดชอบ พิมพ์ได้อิสระ เช่น “SINO Weerachai / ลูกค้า” · ถ้าพิมพ์รหัสหรือชื่อทีมในตารางด้านล่างตรงตัว ระบบจะมอบงานให้ทีมนั้นผ่านคำขอบริการ (SR)"],
      ["Estimate Manday", "ประมาณการ man-day ใส่ทีละ 0.5 · เว้นว่างได้"],
      ["Predecessors / Dependency", "No. ของ task ที่ต้องเสร็จก่อน คั่นด้วย , · เว้นว่างได้"],
      ["Start / Finish", "วันที่จริง · ตอนบันทึกเป็น template ระบบแปลงเป็นจำนวนวันทำการนับจากวันแรกในไฟล์ เพื่อใช้กับโปรเจกต์ที่เริ่มวันอื่น"],
      ["% Comp. / Status", "ใช้ตอนนำเข้า task เข้าโปรเจกต์ที่กำลังทำอยู่ (Completed = เสร็จแล้ว, In Progress = กำลังทำ) · ไม่ถูกเก็บใน template"],
      ["คอลัมน์สัปดาห์ (J เป็นต้นไป)", "แถบสีวาดจาก Start / Finish อัตโนมัติ ไม่ต้องกรอก"],
      ["", ""],
      ["รหัสทีม", "ชื่อทีม"],
      ...teams.map((t) => [t.code, t.label]),
    ],
  });
}
/** Reads the first sheet of an .xlsx into template milestones. Returns { milestones, tasks, errors[] }. */
async function parseTemplate(file) {
  const buf = Buffer.from(String((file && file.data) || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw bad("เลือกไฟล์ Excel (.xlsx)");
  if (!/\.xlsx$/i.test(String(file.name || ""))) throw bad("รองรับเฉพาะไฟล์ .xlsx (ไฟล์จาก MS Project ให้ Export เป็น Excel ก่อน)");
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf).catch(() => { throw bad("อ่านไฟล์ไม่ได้ ตรวจว่าเป็น .xlsx ที่ไม่ได้ตั้งรหัสผ่าน"); });
  const ws = wb.worksheets[0];
  if (!ws) throw bad("ไฟล์ไม่มี sheet");
  const val = (c) => {
    if (c.isMerged && c.master && c.master.address !== c.address) return ""; // a merged cell repeats its first cell's value
    let v = c.value;
    if (v && typeof v === "object" && !(v instanceof Date)) v = v.result !== undefined ? v.result : v.text !== undefined ? v.text : Array.isArray(v.richText) ? v.richText.map((x) => x.text).join("") : "";
    return v == null ? "" : v;
  };
  // Header row: the first of the top 10 rows that has a "task" column.
  let head = 0;
  const col = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !head; r++) {
    const found = {};
    ws.getRow(r).eachCell((c, i) => {
      const t = String(val(c)).toLowerCase().replace(/\s+/g, "");
      for (const [k, names] of Object.entries(TPL_COLS)) if (!found[k] && names.includes(t)) found[k] = i;
    });
    if (found.task) {
      head = r;
      Object.assign(col, found);
    }
  }
  if (!head) throw bad("ไม่พบหัวคอลัมน์ “Activity / Task” ใช้แบบฟอร์มมาตรฐานที่ดาวน์โหลดจากระบบ (No., Activity / Task, Owner, Estimate Manday, Predecessors, Start, Finish, % Comp., Status)");
  if (!col.start || !col.end) throw bad("ต้องมีคอลัมน์ Start และ Finish");
  const teams = await all("SELECT code, label FROM teams");
  const pmTeams = (await settings()).teams;
  const teamOf = (raw) => {
    const t = String(raw || "").trim().toLowerCase();
    if (!t || t === "pm" || t === "-") return null;
    const m = teams.find((x) => x.code.toLowerCase() === t || x.label.toLowerCase() === t);
    if (!m) return undefined;
    return pmTeams.includes(m.code) ? null : m.code;
  };
  const rows = [];
  const errors = [];
  let ms = "";
  for (let r = head + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // "Task title\n- sub item\n- sub item": the first line is the task, the lines under it are its detail.
    const rawTask = String(val(row.getCell(col.task)) || "").replace(/\r/g, "");
    const name = clean(rawTask.split("\n")[0], 200);
    const detail = rawTask.split("\n").slice(1).map((x) => x.trim()).filter(Boolean).join("\n").slice(0, 5000);
    let mname = col.milestone ? clean(val(row.getCell(col.milestone)), 200) : "";
    // Standard plan: a milestone is a full-width row with its title in the first column and no task name.
    if (!name && !col.milestone) {
      const first = String(val(row.getCell(col.no || 1)) || "").trim();
      if (first && !/^\d+(\.\d+)?$/.test(first)) mname = clean(PLAN.milestoneName(first), 200);
    }
    if (mname) ms = mname;
    if (!name) continue; // an empty line, or a milestone-only line
    if (rows.length >= MAX_TPL_ROWS) {
      errors.push(`เกิน ${MAX_TPL_ROWS} task ต่อ template แถวที่ ${r} เป็นต้นไปไม่ได้นำเข้า`);
      break;
    }
    // "Owner (Who)" is free text: a team's code or name hands the task to that team, anything else stays a name on the PM's own task.
    const ownerRaw = col.owner ? clean(val(row.getCell(col.owner)), 200) : "";
    const ownerTeam = ownerRaw ? teamOf(ownerRaw) : null;
    const team = col.team ? teamOf(val(row.getCell(col.team))) : ownerTeam || null;
    const owner = ownerRaw && !ownerTeam ? ownerRaw : "";
    const no = col.no ? Number(val(row.getCell(col.no))) : NaN;
    const pred = col.pred ? clean(String(val(row.getCell(col.pred))).replace(/[^0-9,;\s]/g, "").replace(/[;\s]+/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, ""), 100) : "";
    let pct = col.pct ? Number(val(row.getCell(col.pct))) : 0;
    pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct <= 1 ? pct * 100 : pct))) : 0;
    const st = col.status ? String(val(row.getCell(col.status))).trim().toLowerCase() : "";
    if (team === undefined) errors.push(`แถว ${r}: ไม่รู้จักทีม “${clean(val(row.getCell(col.team)), 60)}” (ดูรหัสทีมใน sheet วิธีกรอก)`);
    const s0 = val(row.getCell(col.start));
    const e0 = val(row.getCell(col.end));
    const okv = (v) => v instanceof Date || (v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0);
    if (!okv(s0) || !okv(e0)) errors.push(`แถว ${r}: “เริ่ม” และ “เสร็จ” ต้องเป็นตัวเลข (วันทำการที่) หรือวันที่`);
    else if (s0 instanceof Date !== e0 instanceof Date) errors.push(`แถว ${r}: “เริ่ม” และ “เสร็จ” ต้องเป็นแบบเดียวกัน (ตัวเลขทั้งคู่ หรือวันที่ทั้งคู่)`);
    const md = col.md ? Number(val(row.getCell(col.md))) || 0 : 0;
    rows.push({ r, ms: ms || "งานทั้งหมด", name, team: team || null, s0, e0, md: Math.max(0, Math.round(md * 2) / 2), owner, no: Number.isInteger(no) && no > 0 ? no : null, pred, pct: st === "completed" ? 100 : pct, st, detail });
  }
  if (!rows.length) throw bad("ไม่พบ task ในไฟล์");
  // Dates → working days from the earliest date in the file.
  const dates = rows.flatMap((x) => [x.s0, x.e0]).filter((v) => v instanceof Date);
  if (dates.length && dates.length !== rows.length * 2 && !errors.length) errors.push("ใช้ตัวเลขหรือวันที่อย่างใดอย่างหนึ่งทั้งไฟล์ อย่าปนกัน");
  const hol = await sr.holidays();
  const isoOf = (v) => `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`; // Excel dates are UTC midnights
  const day0 = dates.length ? dates.map(isoOf).sort()[0] : null;
  const off = (v) => (v instanceof Date ? Math.max(0, sr.workdaysBetween(day0, isoOf(v), hol)) : Math.round(Number(v)));
  const milestones = [];
  for (const x of rows) {
    let m = milestones.find((k) => k.name === x.ms);
    if (!m) milestones.push((m = { name: x.ms, tasks: [] }));
    const start = off(x.s0);
    const end = off(x.e0);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) errors.push(`แถว ${x.r}: “เสร็จ” ก่อน “เริ่ม”`);
    m.tasks.push({ name: x.name, team: x.team, start: start || 0, end: Math.max(end || 0, start || 0), md: x.md, owner: x.owner, no: x.no, pred: x.pred, pct: x.pct, st: x.st, detail: x.detail, ...(day0 && x.s0 instanceof Date && x.e0 instanceof Date ? { sIso: isoOf(x.s0), eIso: isoOf(x.e0) } : {}) });
  }
  return { milestones, tasks: rows.length, errors: errors.slice(0, 30), moreErrors: Math.max(0, errors.length - 30), fromDates: !!day0 };
}
async function importTemplate(user, b) {
  if (!(await isPm(user))) throw bad("นำเข้า template ได้เฉพาะทีม Project Manager", 403);
  const name = clean(b.name, 120);
  if (name.length < 3) throw bad("ตั้งชื่อ template อย่างน้อย 3 ตัวอักษร");
  const out = await parseTemplate(b.file);
  const ex = await one("SELECT id FROM project_templates WHERE name = $1", [name]);
  const summary = {
    name, exists: !!ex, tasks: out.tasks, errors: out.errors, moreErrors: out.moreErrors, fromDates: out.fromDates,
    days: Math.max(0, ...out.milestones.flatMap((m) => m.tasks.map((t) => t.end))),
    md: num(out.milestones.reduce((a, m) => a + m.tasks.reduce((x, t) => x + t.md, 0), 0)),
    milestones: out.milestones.map((m) => ({ name: m.name, tasks: m.tasks.length, own: m.tasks.filter((t) => !t.team).length, sample: m.tasks.slice(0, 3).map((t) => t.name) })),
    teams: [...new Set(out.milestones.flatMap((m) => m.tasks.map((t) => t.team || "PM")))],
  };
  if (!b.save || out.errors.length) return { saved: false, ...summary };
  if (ex && !(await isPmLead(user))) throw bad("มี template ชื่อนี้แล้ว ตั้งชื่ออื่น (แทนที่ template เดิมได้เฉพาะ Manager ทีม PM หรือ Admin)");
  await q(
    `INSERT INTO project_templates (name, milestones, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (name) DO UPDATE SET milestones = EXCLUDED.milestones, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [name, JSON.stringify(out.milestones.map((m) => ({ name: m.name, tasks: m.tasks.map(({ name: n, team, start, end, md, owner, no, pred, detail }) => ({ name: n, team, start, end, md, ...(owner ? { owner } : {}), ...(no ? { no } : {}), ...(pred ? { pred } : {}), ...(detail ? { detail } : {}) })) }))), user.id]
  );
  await audit(user, "project_template_import", name, { tasks: out.tasks, milestones: out.milestones.length, file: clean(b.file && b.file.name, 150) });
  return { saved: true, ...summary };
}

/** Adds the tasks of an Excel file to an existing project. Real dates in the file are kept; day numbers count
 *  working days from the project's start. Milestones are matched by name, new ones are added. */
async function importTasks(user, p, b) {
  const out = await parseTemplate(b.file);
  const hol = await sr.holidays();
  const start = isoDay(p.start_date);
  const day0 = sr.isWorkday(start, hol) ? start : sr.addWorkdays(start, 1, hol);
  const at = (n) => (n > 0 ? sr.addWorkdays(day0, n, hol) : day0);
  const plan = out.milestones.map((m) => ({ name: m.name, tasks: m.tasks.map((t) => ({ ...t, s: t.sIso || at(t.start), e: t.eIso || at(t.end) })) }));
  const all0 = plan.flatMap((m) => m.tasks);
  const existing = await all("SELECT id, name FROM project_milestones WHERE project_id = $1", [p.id]);
  const dup = new Set((await all("SELECT lower(name) AS n FROM project_tasks WHERE project_id = $1 AND status <> 'cancelled'", [p.id])).map((r) => r.n));
  const summary = {
    tasks: out.tasks, errors: out.errors, moreErrors: out.moreErrors, fromDates: out.fromDates,
    from: all0.map((t) => t.s).sort()[0], to: all0.map((t) => t.e).sort().pop(),
    duplicates: all0.filter((t) => dup.has(t.name.toLowerCase())).length,
    milestones: plan.map((m) => ({ name: m.name, tasks: m.tasks.length, own: m.tasks.filter((t) => !t.team).length, isNew: !existing.some((e) => e.name.toLowerCase() === m.name.toLowerCase()), sample: m.tasks.slice(0, 3).map((t) => t.name) })),
  };
  if (!b.save || out.errors.length) return { saved: false, ...summary };
  await tx(async (c) => {
    let sort = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM project_milestones WHERE project_id = $1", [p.id])).rows[0].n;
    for (const m of plan) {
      let mid = (existing.find((e) => e.name.toLowerCase() === m.name.toLowerCase()) || {}).id;
      if (!mid) mid = (await c.query("INSERT INTO project_milestones (project_id, name, due_date, sort) VALUES ($1,$2,$3,$4) RETURNING id", [p.id, m.name, m.tasks.map((t) => t.e).sort().pop(), sort++])).rows[0].id;
      let k = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM project_tasks WHERE milestone_id = $1", [mid])).rows[0].n;
      for (const t of m.tasks) {
        const r = await c.query(
          `INSERT INTO project_tasks (project_id, milestone_id, name, kind, team, start_date, due_date, base_date, kpi_due, sr_open, md_est, sort, created_by, owner_text, plan_no, pred, pct, status, done_at, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          // The file's progress is kept for the PM's own tasks; a task handed to a team takes its status from the service request.
          [p.id, mid, t.name, t.team ? "sr" : "own", t.team, t.s, t.e, t.team ? "auto" : "now", t.md, k++, user.id, t.owner || null, t.no || null, t.pred || null, t.team ? 0 : t.pct || 0,
            t.team ? "todo" : t.st === "completed" ? "done" : t.st === "in progress" || (t.pct > 0 && t.pct < 100) ? "doing" : "todo", !t.team && t.st === "completed" ? t.e : null, t.detail || null]
        );
        await addEvent(c, r.rows[0].id, "created", null, { import: clean(b.file && b.file.name, 150) }, user.id);
      }
    }
  });
  await audit(user, "project_import", p.name, { id: p.id, tasks: out.tasks, file: clean(b.file && b.file.name, 150) });
  return { saved: true, ...summary };
}

// ------------------------------------------------------------ hand-over: deliver + the customer's PM schedule
async function deliver(user, p, b) {
  const open = (await tasksOf(p.id)).filter((t) => !["done", "submitted", "cancelled"].includes(t.status));
  if (open.length) throw bad(`ยังมี ${open.length} task ที่ไม่เสร็จ ปิดหรือยกเลิก task ให้ครบก่อนส่งมอบ`);
  const date = validDate(b.date || todayIso(), "วันที่ส่งมอบ");
  let pmId = null;
  if (b.pm) pmId = await require("./pm").createFromProject(user, { ...b.pm, project_id: p.id, project_name: p.name });
  await q("UPDATE projects SET status = 'delivered', delivered_at = $2, updated_at = now() WHERE id = $1", [p.id, date]);
  await audit(user, "project_deliver", p.name, { id: p.id, date, pmSchedule: pmId });
  return { pmSchedule: pmId };
}

// ------------------------------------------------------------ progress report for the customer (PDF, English like the support report)
const emailsOf = (x) => String(x || "").split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
const REPORT_FREQ = { off: "ไม่ส่งอัตโนมัติ", monthly: "วันทำการแรกของเดือน", biweekly: "ทุก 2 สัปดาห์" };
async function reportData(p) {
  const hol = await sr.holidays();
  const tasks = (await tasksOf(p.id, hol)).filter((t) => t.status !== "cancelled");
  const ms = await all("SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY sort, due_date, id", [p.id]);
  const t0 = todayIso();
  const since = isoDay(p.report_last) || d.toISODate(d.addDays(d.today(), -31));
  const fin = (t) => ["done", "submitted"].includes(t.status);
  const done = tasks.filter(fin);
  const STATE = { met: "Completed on schedule", late: "Completed late", missed: "Behind schedule", risk: "Needs attention", plan: "On track" };
  return {
    name: p.name, customer: p.customer || "", pm: p.pm_name || "", start: isoDay(p.start_date), end: isoDay(p.end_date), status: p.status, deliveredAt: isoDay(p.delivered_at),
    total: tasks.length, done: done.length, pct: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
    milestones: ms.map((m) => {
      const ts = tasks.filter((t) => t.milestoneId === m.id);
      const [state] = milestoneState(m, tasks);
      return { name: m.name, due: isoDay(m.due_date), total: ts.length, done: ts.filter(fin).length, state, stateLabel: STATE[state] };
    }),
    finished: done.filter((t) => t.doneAt && t.doneAt > since).sort((a, b) => a.doneAt.localeCompare(b.doneAt)).slice(0, 40),
    next: tasks.filter((t) => !fin(t)).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 12),
    since, today: t0, note: p.report_note || "",
  };
}
async function reportPdf(p) {
  const PDFDocument = require("pdfkit");
  const x = await reportData(p);
  const C = { ink: "#18212F", muted: "#5B6675", line: "#D9DFE8", blue: "#1F5FBF", green: "#1C6B45", red: "#B3263A", amber: "#B07800", row: "#F3F5F9" };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (v) => {
    if (!v) return "-";
    const t = d.fromISODate(v);
    return `${t.getDate()} ${MON[t.getMonth()]} ${t.getFullYear()}`;
  };
  const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true, info: { Title: `Project Progress Report · ${x.name}`, Author: "SINO S-TECH LIMITED" } });
  const chunks = [];
  doc.on("data", (b) => chunks.push(b));
  const end = new Promise((res) => doc.on("end", res));
  doc.registerFont("R", path.join(__dirname, "../../assets/fonts/Sarabun-Regular.ttf"));
  doc.registerFont("B", path.join(__dirname, "../../assets/fonts/Sarabun-Bold.ttf"));
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const fit = (text, width) => {
    const out = [];
    for (const para of String(text ?? "").replace(/\r/g, "").split("\n")) {
      let line = "";
      for (const { segment } of seg.segment(para)) {
        if (line && doc.widthOfString(line + segment) > width) {
          out.push(line.trimEnd());
          line = segment.trimStart();
        } else line += segment;
      }
      out.push(line);
    }
    return out.join("\n");
  };
  const W = doc.page.width - 80;
  const L = 40;
  const room = (h) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };
  try {
    doc.image(path.join(__dirname, "../../public3/sinostech-logo.png"), L, 36, { width: 150 });
  } catch (e) {}
  doc.font("B").fontSize(18).fillColor(C.ink).text("Project Progress Report", L, 40, { width: W, align: "right" });
  doc.font("R").fontSize(11).fillColor(C.muted).text(`As of ${day(x.today)}`, L, doc.y, { width: W, align: "right" });
  doc.moveTo(L, 86).lineTo(L + W, 86).lineWidth(2).strokeColor(C.blue).stroke();
  doc.font("B").fontSize(15).fillColor(C.ink).text(fit(x.name, W), L, 98, { width: W });
  doc.font("R").fontSize(10).fillColor(C.muted).text(`${x.customer ? x.customer + " · " : ""}Planned ${day(x.start)} to ${day(x.end)}${x.deliveredAt ? ` · Delivered ${day(x.deliveredAt)}` : ""}`, L, doc.y + 2, { width: W });

  // Summary tiles
  const metMs = x.milestones.filter((m) => m.state === "met" || m.state === "late").length;
  const tiles = [["Overall progress", `${x.pct}%`], ["Work items completed", `${x.done} / ${x.total}`], ["Milestones completed", `${metMs} / ${x.milestones.length}`], [x.deliveredAt ? "Delivered" : "Planned delivery", day(x.deliveredAt || x.end)]];
  const ty = doc.y + 12;
  const tw = (W - 3 * 8) / 4;
  tiles.forEach(([l, v], i) => {
    const tx0 = L + i * (tw + 8);
    doc.roundedRect(tx0, ty, tw, 52, 6).fillColor(C.row).fill();
    doc.font("R").fontSize(9).fillColor(C.muted).text(l, tx0 + 10, ty + 8, { width: tw - 20 });
    doc.font("B").fontSize(i === 3 ? 13 : 17).fillColor(C.ink).text(v, tx0 + 10, ty + (i === 3 ? 26 : 22), { width: tw - 20 });
  });
  doc.roundedRect(L, ty + 62, W, 8, 4).fillColor(C.line).fill();
  if (x.pct > 0) doc.roundedRect(L, ty + 62, Math.max(8, (W * x.pct) / 100), 8, 4).fillColor(C.green).fill();
  doc.y = ty + 84;

  const heading = (t) => {
    room(60);
    doc.font("B").fontSize(12).fillColor(C.ink).text(t, L, doc.y + 6, { width: W });
    doc.moveDown(0.3);
  };
  // Milestones
  heading("Milestones");
  const cols = [[0, W * 0.4, "Milestone"], [W * 0.4, W * 0.18, "Target date"], [W * 0.58, W * 0.2, "Progress"], [W * 0.78, W * 0.22, "Status"]];
  let y = doc.y;
  doc.rect(L, y, W, 20).fillColor(C.row).fill();
  cols.forEach(([cx, cw, label]) => doc.font("B").fontSize(9).fillColor(C.muted).text(label, L + cx + 6, y + 5, { width: cw - 12 }));
  y += 20;
  for (const m of x.milestones) {
    doc.font("R").fontSize(10);
    const name = fit(m.name, cols[0][1] - 12);
    const h = Math.max(22, doc.heightOfString(name, { width: cols[0][1] - 12 }) + 10);
    if (y + h > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }
    doc.fillColor(C.ink).text(name, L + 6, y + 5, { width: cols[0][1] - 12 });
    doc.text(day(m.due), L + cols[1][0] + 6, y + 5, { width: cols[1][1] - 12 });
    const bw = cols[2][1] - 60;
    doc.roundedRect(L + cols[2][0] + 6, y + 9, bw, 6, 3).fillColor(C.line).fill();
    if (m.done) doc.roundedRect(L + cols[2][0] + 6, y + 9, Math.max(6, (bw * m.done) / Math.max(1, m.total)), 6, 3).fillColor(C.green).fill();
    doc.fillColor(C.muted).fontSize(9).text(`${m.done}/${m.total}`, L + cols[2][0] + bw + 12, y + 6, { width: 44 });
    doc.font("B").fontSize(9.5).fillColor({ met: C.green, late: C.amber, missed: C.red, risk: C.amber, plan: C.blue }[m.state]).text(m.stateLabel, L + cols[3][0] + 6, y + 6, { width: cols[3][1] - 12 });
    doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
    y += h;
  }
  if (!x.milestones.length) {
    doc.font("R").fontSize(10).fillColor(C.muted).text("No milestones defined yet.", L + 6, y + 6);
    y += 24;
  }
  doc.y = y + 6;
  const list = (title, rows, empty) => {
    heading(title);
    if (!rows.length) return doc.font("R").fontSize(10).fillColor(C.muted).text(empty, L, doc.y, { width: W });
    for (const [a, b2] of rows) {
      doc.font("R").fontSize(10);
      const txt = fit(a, W - 130);
      const h = doc.heightOfString(txt, { width: W - 130 }) + 4;
      room(h);
      const yy = doc.y;
      doc.fillColor(C.blue).text("•", L, yy, { width: 10 });
      doc.fillColor(C.ink).text(txt, L + 12, yy, { width: W - 130 });
      doc.fillColor(C.muted).text(b2, L + W - 110, yy, { width: 110, align: "right" });
      doc.y = yy + h;
    }
  };
  list(`Completed since ${day(x.since)}`, x.finished.map((t) => [t.name, day(t.doneAt)]), "No work items were completed in this period.");
  list("Coming up next", x.next.map((t) => [t.name, `Target ${day(t.due)}`]), x.total ? "All work items are complete." : "Work items have not been planned yet.");
  if (x.note.trim()) {
    heading("What we need from you");
    doc.font("R").fontSize(10).fillColor(C.ink).text(fit(x.note, W - 20), L + 10, doc.y, { width: W - 20 });
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // writing in the footer area must not start a new page
    doc.font("R").fontSize(8.5).fillColor(C.muted).text(`SINO S-TECH LIMITED${x.pm ? ` · Project Manager: ${x.pm}` : ""} · Page ${i + 1} of ${range.count}`, L, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  await end;
  return { buffer: Buffer.concat(chunks), data: x };
}
const reportFile = (p) => `Project-Report_${String(p.name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60)}_${todayIso()}.pdf`;
async function sendReport(p, { by = null } = {}) {
  const T = emailsOf(p.report_to);
  if (!T.length) throw bad("ใส่อีเมลผู้รับของลูกค้าก่อน");
  const CC = [...new Set([...emailsOf(p.report_cc), ...(p.pm_email ? [p.pm_email.toLowerCase()] : [])])].filter((e) => !T.includes(e));
  const { buffer, data: x } = await reportPdf(p);
  const html = require("./customermail").layout(
    "#1F5FBF",
    `<p style="margin:0 0 14px">Dear ${esc(x.customer || "Customer")} team,</p>
<p style="margin:0 0 14px">Please find attached the progress report for <strong>${esc(x.name)}</strong>.</p>
${fieldTable([["Overall progress", `${x.pct}%`], ["Work items completed", `${x.done} of ${x.total}`], ["Planned delivery", x.end]])}
${x.note.trim() ? `<p style="margin:14px 0 6px"><strong>What we need from you</strong></p><p style="margin:0;white-space:pre-wrap">${esc(x.note)}</p>` : ""}
<p style="margin:14px 0 0">If you have any questions, simply reply to this email.</p>`,
    { footer: `${x.pm ? esc(x.pm) + ", " : ""}Project Management, SINO S-TECH LIMITED` }
  );
  await graph.sendMail({ to: T, cc: CC, subject: `Project Progress Report · ${x.name}`, html, attachments: [{ name: reportFile(p), contentType: "application/pdf", buffer }] });
  await q("UPDATE projects SET report_last = CURRENT_DATE WHERE id = $1", [p.id]);
  await audit(by, "project_report_send", p.name, { id: p.id, to: T, auto: !by });
  return { to: T, cc: CC };
}
/** Scheduled reports: monthly on the first working day, or every 14 days. */
async function runReports(hol, t0) {
  let sent = 0;
  const firstWork = sr.isWorkday(t0.slice(0, 8) + "01", hol) ? t0.slice(0, 8) + "01" : sr.addWorkdays(t0.slice(0, 8) + "01", 1, hol);
  for (const row of await all("SELECT id FROM projects WHERE status IN ('plan','active') AND report_freq <> 'off' AND COALESCE(report_to,'') <> ''")) {
    const p = await loadProject(row.id);
    const last = isoDay(p.report_last);
    const due = p.report_freq === "monthly" ? t0 >= firstWork && (!last || last < firstWork) : !last || d.toISODate(d.addDays(d.fromISODate(last), 14)) <= t0;
    if (!due) continue;
    await sendReport(p).then(() => sent++, (e) => console.error("[projects] report:", p.name, e.message));
  }
  return sent;
}

// ------------------------------------------------------------ reminders (job, working days 08:40)
async function runReminders() {
  const hol = await sr.holidays();
  const t0 = todayIso();
  if (!sr.isWorkday(t0, hol)) return { skipped: "วันหยุด" };
  const out = { opened: 0, digests: 0, assignees: 0, errors: 0, reports: 0 };
  out.reports = await runReports(hol, t0).catch((e) => (console.error("[projects] reports:", e.message), 0));
  // 1) "Auto" tasks open their service request AUTO_OPEN_DAYS working days before they start.
  const auto = await all(
    `SELECT t.id, t.start_date FROM project_tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind = 'sr' AND t.sr_open = 'auto' AND t.status <> 'cancelled' AND p.status IN ('plan','active')
        AND NOT EXISTS (SELECT 1 FROM service_requests s WHERE s.project_task_id = t.id)`
  );
  for (const t of auto) {
    if (sr.addWorkdays(isoDay(t.start_date), -AUTO_OPEN_DAYS, hol) > t0) continue;
    try {
      await openSr(null, t.id);
      out.opened++;
    } catch (e) {
      out.errors++;
      console.error("[projects] auto open:", e.message);
    }
  }
  // 2) One digest per PM: tasks 3 and 1 working days before due, and overdue tasks. Assignees get the 3-day note;
  //    the 1-day and overdue notes for handed-over tasks already come from the service-request reminders.
  const projects = await all("SELECT p.*, u.email AS pm_email, u.display_name AS pm_name FROM projects p JOIN users u ON u.id = p.pm_id AND u.active WHERE p.status IN ('plan','active')");
  const leads = (await pmTeamManagers()).map((m) => m.email);
  for (const p of projects) {
    const tasks = await tasksOf(p.id, hol);
    const rows = [];
    let ownLate = false;
    for (const t of tasks) {
      if (["done", "submitted", "cancelled"].includes(t.status)) continue;
      const left = t.due < t0 ? -1 : sr.workdaysBetween(t0, t.due, hol);
      const key = t.overdue ? "overdue" : left === 3 ? "d3" : left === 1 ? "d1" : null;
      if (!key) continue;
      const raw = await one("SELECT reminded FROM project_tasks WHERE id = $1", [t.id]);
      if ((raw.reminded || {})[key] === t0) continue;
      rows.push([t, key]);
      if (key === "overdue" && t.kind === "own") ownLate = true;
      if (key === "d3" && t.assignee) {
        const a = await one("SELECT email FROM users WHERE id = $1 AND active", [t.assignee.id]);
        if (a && a.email) {
          await graph.sendMail({ to: [a.email], cc: [], subject: `[${t.sr.no}] ครบกำหนดอีก 3 วันทำการ (${thai(t.due)}) · ${t.name}`,
            html: shell("#C07A00", `<p style="margin:0 0 12px">งานจากโปรเจกต์ <strong>${esc(p.name)}</strong> ครบกำหนดอีก 3 วันทำการ</p>${fieldTable([["งาน", t.name], ["เลขคำขอ", t.sr.no], ["กำหนดเสร็จ", thai(t.due)], ["PM", p.pm_name]])}<p style="margin:16px 0 0">${button(`${config3.baseUrl}/#/sr/${t.sr.id}`, "เปิดคำขอ")}</p>`) }).catch(() => out.errors++);
          out.assignees++;
        }
      }
    }
    if (!rows.length) continue;
    const label = { overdue: "เลยกำหนด", d3: "อีก 3 วันทำการ", d1: "อีก 1 วันทำการ" };
    const color = { overdue: "#A5162E", d3: "#7A5600", d1: "#9A3412" };
    const td = (v, st = "") => `<td style="padding:8px 10px;border-bottom:1px solid #E2E5EA;${st}">${v}</td>`;
    const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;border:1px solid #E2E5EA"><tr style="background:#F6F7F9;color:#5B6576">${td("Task")}${td("ผู้รับผิดชอบ")}${td("กำหนดเสร็จ")}${td("สถานะ")}</tr>${rows
      .map(([t, k]) => `<tr>${td(`<strong>${esc(t.name)}</strong>${t.sr ? `<br><span style="color:#5B6576">${esc(t.sr.no)}</span>` : ""}`)}${td(t.kind === "own" ? "PM" : `${esc(t.teamLabel)}${t.assignee ? `<br>${esc(t.assignee.name)}` : ""}`)}${td(thai(t.due))}${td(k === "overdue" ? `เลย ${t.overdueDays} วันทำการ` : label[k], `color:${color[k]};font-weight:600`)}</tr>`)
      .join("")}</table>`;
    const late = rows.filter(([, k]) => k === "overdue").length;
    const subject = `[โปรเจกต์] ${p.name} · ${late ? `เลยกำหนด ${late} task` : `ใกล้ครบกำหนด ${rows.length} task`}`;
    await graph.sendMail({ to: [p.pm_email], cc: ownLate ? leads.filter((e) => e !== p.pm_email) : [], subject,
      html: shell(late ? "#C0283C" : "#C07A00", `<p style="margin:0 0 14px">สรุป task ที่ต้องติดตามวันนี้ของโปรเจกต์ <strong>${esc(p.name)}</strong>${p.customer ? ` (${esc(p.customer)})` : ""}</p>${table}<p style="margin:16px 0 0">${button(url(p.id), "เปิดโปรเจกต์")}</p>`) })
      .catch((e) => { out.errors++; console.error("[projects] digest:", e.message); });
    await require("./teamsnotify").notify((await settings()).teams[0], "project", {
      title: `📋 ${subject}`, color: late ? "Attention" : "Warning", text: `PM ${p.pm_name}`,
      facts: rows.slice(0, 8).map(([t, k]) => [t.name, `${k === "overdue" ? `เลย ${t.overdueDays} วันทำการ` : label[k]} · ${thai(t.due)}`]),
      actions: [["เปิดโปรเจกต์", url(p.id)]],
    });
    for (const [t, k] of rows) await q("UPDATE project_tasks SET reminded = reminded || jsonb_build_object($2::text, $3::text) WHERE id = $1", [t.id, k, t0]);
    out.digests++;
  }
  return out;
}

// ------------------------------------------------------------ KPI input for the PM (service profile)
/** Project tasks finished in [fromIso, toIso] per PM: { done, onTime, moved }. */
async function kpiByPm(fromIso, toIso) {
  const rows = await all(
    `SELECT p.pm_id, t.kind, t.kpi_due, t.base_date, t.due_date, t.done_at,
            (SELECT (x.closed_at AT TIME ZONE 'Asia/Bangkok')::date FROM service_requests x WHERE x.project_task_id = t.id AND x.status = 'done' AND x.outcome = 'delivered' ORDER BY x.id DESC LIMIT 1) AS sr_done
       FROM project_tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status <> 'cancelled' AND p.pm_id IS NOT NULL`
  ).catch(() => []);
  const by = new Map();
  for (const r of rows) {
    const done = isoDay(r.kind === "own" ? r.done_at : r.sr_done);
    if (!done || done < fromIso || done > toIso) continue;
    const o = by.get(r.pm_id) || { done: 0, onTime: 0, moved: 0 };
    o.done++;
    if (done <= isoDay(r.kpi_due)) o.onTime++;
    if (isoDay(r.due_date) !== isoDay(r.base_date)) o.moved++;
    by.set(r.pm_id, o);
  }
  return by;
}

// ------------------------------------------------------------ Excel (man-days)
async function mdWorkbook(p, tasks, rate) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Man-day");
  ws.columns = [
    { header: "Milestone", key: "ms", width: 24 }, { header: "Task", key: "name", width: 40 }, { header: "ทีม", key: "team", width: 22 },
    { header: "ผู้รับผิดชอบ", key: "who", width: 22 }, { header: "กำหนดเสร็จ", key: "due", width: 14 }, { header: "สถานะ", key: "st", width: 20 },
    { header: "ประมาณการ (MD)", key: "est", width: 15 }, { header: "ใช้จริง (MD)", key: "act", width: 13 }, ...(rate ? [{ header: "ต้นทุนจริง (บาท)", key: "cost", width: 16 }] : []),
  ];
  for (const t of tasks) ws.addRow({ ms: t.milestone, name: t.name, team: t.kind === "own" ? "PM" : t.teamLabel, who: t.kind === "own" ? (p.pm_name || "") : t.assignee ? t.assignee.name : "", due: t.due, st: t.statusLabel, est: t.mdEst, act: t.mdAct, cost: rate ? t.mdAct * rate : undefined });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------ HTTP
function mount(api, { wrap }) {
  const noRequester = (req) => {
    if (req.user.role === "requester") throw bad("ไม่มีสิทธิ์", 403);
  };
  api.get("/projects/meta", wrap(async (req, res) => {
    noRequester(req);
    const s = await settings();
    res.json({
      canCreate: await isPm(req.user), isLead: await isPmLead(req.user), pmTeams: s.teams, mdRate: (await costVisible(req.user)) ? s.mdRate : null,
      templates: (await all("SELECT id, name, milestones, updated_at FROM project_templates ORDER BY name")).map((t) => ({ id: t.id, name: t.name, milestones: t.milestones })),
      teams: await all("SELECT code, label FROM teams ORDER BY sort"), people: await pmPeople(),
      members: (await isPm(req.user)) ? await all("SELECT u.id, u.display_name, t.team FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role IN ('engineer','manager') ORDER BY u.display_name") : [], docCats: DOC_CATS, fileExt: FILE_EXT, maxFileMb: MAX_FILE_MB,
      severities: Object.entries(sr.SEV).map(([k, v]) => ({ key: k, label: v })), holidays: [...(await sr.holidays())].sort(), today: todayIso(), autoOpenDays: AUTO_OPEN_DAYS,
    });
  }));
  api.get("/project-templates/form.xlsx", wrap(async (req, res) => {
    if (!(await isPm(req.user))) throw bad("ไม่มีสิทธิ์", 403);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=TemplateProjectPlan.xlsx");
    res.end(await templateForm());
  }));
  api.post("/project-templates/import", wrap(async (req, res) => res.json({ ok: true, ...(await importTemplate(req.user, req.body || {})) })));
  api.get("/projects", wrap(async (req, res) => {
    noRequester(req);
    const ids = (await visibleProjects(req.user)).map((r) => r.id);
    const hol = await sr.holidays();
    const items = [];
    for (const id of ids) {
      const p = await loadProject(id);
      const full = await seesAll(req.user, p);
      let tasks = await tasksOf(p.id, hol);
      if (!full) {
        const mine = await myTaskIds(req.user, p.id);
        tasks = tasks.filter((t) => mine.includes(t.id));
      }
      items.push({ ...serProject(p), full, mine: p.pm_id === req.user.id, summary: summary(tasks) });
    }
    res.json({ items });
  }));
  api.post("/projects", wrap(async (req, res) => res.json({ ok: true, id: await createProject(req.user, req.body || {}) })));
  api.get("/projects/:id", wrap(async (req, res) => {
    noRequester(req);
    const { p, full, mine } = await projectFor(req.user, req.params.id);
    const hol = await sr.holidays();
    let tasks = await tasksOf(p.id, hol);
    if (!full) tasks = tasks.filter((t) => mine.includes(t.id));
    const ms = await all("SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY sort, due_date, id", [p.id]);
    const milestones = ms.map((m) => {
      const [state, label] = milestoneState(m, tasks);
      return { id: m.id, name: m.name, due: isoDay(m.due_date), state, stateLabel: label, total: tasks.filter((t) => t.milestoneId === m.id && t.status !== "cancelled").length, done: tasks.filter((t) => t.milestoneId === m.id && ["done", "submitted"].includes(t.status)).length };
    });
    const docs = await all(
      `SELECT f.id, f.task_id, f.category, f.file_name, f.size, f.mime, f.created_at, u.display_name AS by_name, t.name AS task_name, f.by_user
         FROM project_files f LEFT JOIN users u ON u.id = f.by_user LEFT JOIN project_tasks t ON t.id = f.task_id WHERE f.project_id = $1 ${full ? "" : "AND (f.task_id IS NULL OR f.task_id = ANY($2))"} ORDER BY f.created_at DESC`,
      full ? [p.id] : [p.id, mine]
    );
    const s = await settings();
    const edit = await canEdit(req.user, p);
    res.json({
      project: serProject(p), full, milestones, tasks, docs, summary: summary(tasks),
      cost: full && (await costVisible(req.user, p)) ? { rate: s.mdRate } : null,
      can: { edit, upload: full && req.user.role !== "viewer" && req.user.role !== "observer", deliver: edit && p.status !== "delivered", template: edit && (await isPm(req.user)) },
    });
  }));
  api.put("/projects/:id", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    await updateProject(req.user, p, req.body || {});
    res.json({ ok: true });
  }));
  api.post("/projects/:id/milestones", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    await addMilestone(req.user, p, req.body || {});
    res.json({ ok: true });
  }));
  api.put("/project-milestones/:mid", wrap(async (req, res) => {
    await updateMilestone(req.user, req.params.mid, req.body || {});
    res.json({ ok: true });
  }));
  api.post("/projects/:id/tasks", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    res.json({ ok: true, ...(await addTask(req.user, p, req.body || {})) });
  }));
  api.post("/projects/:id/template", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    await saveTemplate(req.user, p, req.body || {});
    res.json({ ok: true });
  }));
  api.get("/projects/:id/plan.xlsx", wrap(async (req, res) => {
    const { p, full } = await projectFor(req.user, req.params.id);
    if (!full) throw bad("ดาวน์โหลดแผนทั้งโปรเจกต์ได้เฉพาะผู้ที่เห็นทั้งโปรเจกต์", 403);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=ProjectPlan-${p.id}.xlsx`);
    res.send(await planExport(p, await tasksOf(p.id)));
  }));
  api.post("/projects/:id/import", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    res.json({ ok: true, ...(await importTasks(req.user, p, req.body || {})) });
  }));
  api.post("/projects/:id/deliver", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    res.json({ ok: true, ...(await deliver(req.user, p, req.body || {})) });
  }));
  api.get("/projects/:id/report.pdf", wrap(async (req, res) => {
    const { p, full } = await projectFor(req.user, req.params.id);
    if (!full) throw bad("ไม่มีสิทธิ์", 403);
    const { buffer } = await reportPdf(p);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(reportFile(p))}`);
    res.end(buffer);
  }));
  api.put("/projects/:id/report", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    const b = req.body || {};
    const words = (v) => String(v || "").split(/[,;\s]+/).filter(Boolean);
    const bad1 = [...words(b.to), ...words(b.cc)].find((x) => !emailsOf(x).length);
    if (bad1) throw bad(`อีเมลไม่ถูกต้อง: ${bad1}`);
    const freq = REPORT_FREQ[b.freq] ? b.freq : "off";
    if (freq !== "off" && !emailsOf(b.to).length) throw bad("ใส่อีเมลผู้รับของลูกค้าก่อนเปิดการส่งอัตโนมัติ");
    await q("UPDATE projects SET report_to=$2, report_cc=$3, report_freq=$4, report_note=$5, updated_at=now() WHERE id=$1", [p.id, emailsOf(b.to).join(", ") || null, emailsOf(b.cc).join(", ") || null, freq, clean(b.note, 2000) || null]);
    await audit(req.user, "project_report_settings", p.name, { id: p.id, freq, to: emailsOf(b.to) });
    res.json({ ok: true });
  }));
  api.post("/projects/:id/report/send", wrap(async (req, res) => {
    const { p } = await projectFor(req.user, req.params.id, { edit: true });
    res.json({ ok: true, ...(await sendReport(await loadProject(p.id), { by: req.user })) });
  }));
  api.get("/projects/:id/manday.xlsx", wrap(async (req, res) => {
    const { p, full } = await projectFor(req.user, req.params.id);
    if (!full || req.user.role === "viewer") throw bad("ไม่มีสิทธิ์", 403);
    const s = await settings();
    const showCost = await costVisible(req.user, p);
    const buf = await mdWorkbook(p, await tasksOf(p.id), showCost ? s.mdRate : 0);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`manday-${p.name}.xlsx`)}`);
    res.end(buf);
  }));
  api.post("/projects/:id/files", wrap(async (req, res) => {
    const { p, full } = await projectFor(req.user, req.params.id);
    if (!full || ["viewer", "observer"].includes(req.user.role)) throw bad("อัปโหลดเอกสารได้เฉพาะ PM, Manager ทีม PM และ Admin", 403);
    const cat = DOC_CATS.includes(req.body?.category) ? req.body.category : "อื่น ๆ";
    const n = await tx((c) => storeFiles(c, p.id, req.body?.files, req.user.id, { category: cat }));
    if (!n) throw bad("เลือกไฟล์ก่อน");
    await audit(req.user, "project_files", p.name, { id: p.id, files: n, category: cat });
    res.json({ ok: true, files: n });
  }));
  api.get("/project-files/:fid", wrap(async (req, res) => {
    const f = await one("SELECT * FROM project_files WHERE id = $1", [Number(req.params.fid)]);
    if (!f) throw bad("ไม่พบไฟล์", 404);
    const { full, mine } = await projectFor(req.user, f.project_id);
    if (!full && f.task_id && !mine.includes(f.task_id)) throw bad("ไม่พบไฟล์", 404);
    if (!f.path.startsWith(FILE_DIR) || !fs.existsSync(f.path)) throw bad("ไม่พบไฟล์", 404);
    res.setHeader("Content-Type", f.mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${/^image\/(png|jpe?g|gif|webp)$/.test(f.mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    fs.createReadStream(f.path).pipe(res);
  }));
  api.delete("/project-files/:fid", wrap(async (req, res) => {
    const f = await one("SELECT * FROM project_files WHERE id = $1", [Number(req.params.fid)]);
    if (!f) throw bad("ไม่พบไฟล์", 404);
    const { p } = await projectFor(req.user, f.project_id);
    if (f.by_user !== req.user.id && !(await canEdit(req.user, p))) throw bad("ลบได้เฉพาะคนที่อัปโหลด หรือ PM", 403);
    await q("DELETE FROM project_files WHERE id = $1", [f.id]);
    fs.rmSync(f.path, { force: true });
    await audit(req.user, "project_file_delete", f.file_name, { project: p.id });
    res.json({ ok: true });
  }));

  const onTask = (fn, { edit = true } = {}) => wrap(async (req, res) => {
    const { t, p, full } = await taskFor(req.user, req.params.tid);
    if (edit && !(await canEdit(req.user, p))) throw bad("แก้ไขได้เฉพาะ PM ของโปรเจกต์", 403);
    const out = await fn(req.user, t, p, req.body || {}, full);
    res.json({ ok: true, ...(out || {}), ...(await taskDetail(req.user, await one("SELECT * FROM project_tasks WHERE id = $1", [t.id]), p, full)) });
  });
  api.get("/project-tasks/:tid", onTask(() => null, { edit: false }));
  api.put("/project-tasks/:tid", onTask(updateTask));
  api.post("/project-tasks/:tid/status", onTask(setStatus));
  api.post("/project-tasks/:tid/due", onTask(moveDue));
  api.post("/project-tasks/:tid/open-sr", onTask(async (u, t) => ({ srNo: (await openSr(u, t.id)).sr_no })));
  api.post("/project-tasks/:tid/log", onTask(async (u, t, p, b, full) => {
    if (!(await canLog(u, t, p))) throw bad("บันทึกได้เฉพาะ PM ผู้รับผิดชอบ หรือ Manager ทีมผู้รับ", 403);
    await addLog(u, t, p, b);
  }, { edit: false }));

  api.get("/settings/projects", wrap(async (req, res) => {
    if (!(await perms.can(req.user, "settings_manage"))) throw bad("ไม่มีสิทธิ์", 403);
    res.json({ ...(await settings()), templates: await all("SELECT id, name, jsonb_array_length(milestones) AS milestones, updated_at FROM project_templates ORDER BY name") });
  }));
  api.put("/settings/projects", wrap(async (req, res) => {
    if (!(await perms.can(req.user, "settings_manage"))) throw bad("ไม่มีสิทธิ์", 403);
    const codes = new Set((await all("SELECT code FROM teams")).map((t) => t.code));
    const teams = (Array.isArray(req.body?.teams) ? req.body.teams : []).filter((t) => codes.has(t));
    if (!teams.length) throw bad("เลือกทีม Project Manager อย่างน้อย 1 ทีม");
    const mdRate = Math.max(0, Math.round(Number(req.body?.mdRate) || 0));
    await setSetting("projects", { teams, mdRate });
    if (Array.isArray(req.body?.removeTemplates)) for (const id of req.body.removeTemplates) await q("DELETE FROM project_templates WHERE id = $1", [Number(id)]);
    await audit(req.user, "projects_settings", null, { teams, mdRate });
    res.json({ ok: true });
  }));
}

/** Open own tasks of a PM (for "งานของฉัน"). */
async function ownTasksOf(user) {
  if (!(await isPm(user))) return [];
  const hol = await sr.holidays();
  const rows = await all(`${TASK_SQL} JOIN projects pj ON pj.id = t.project_id WHERE pj.pm_id = $1 AND t.kind = 'own' AND t.status IN ('todo','doing') AND pj.status IN ('plan','active') ORDER BY t.due_date`, [user.id]);
  const names = new Map((await all("SELECT id, name FROM projects WHERE pm_id = $1", [user.id])).map((p) => [p.id, p.name]));
  return rows.map((t) => ({ ...serTask(t, hol), project: names.get(t.project_id) || "" }));
}
async function hasProjects(user) {
  if (user.role === "requester") return false;
  if (["admin", "observer", "viewer"].includes(user.role) || (await isPm(user))) return true;
  return (await visibleProjects(user)).length > 0;
}

module.exports = { mount, runReminders, kpiByPm, onSrTargetMoved, ownTasksOf, hasProjects, isPm, settings, TASK_ST };
