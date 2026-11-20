"use strict";
// Closing or cancelling a case needs a manager's approval.
//  - The owner fills the close form as before (status, resolution, root cause, RCA ...); every check runs at request time.
//  - The case shows "รอ Manager อนุมัติปิด" and the owner's alert emails stop.
//  - Approved: the case closes with End date = the day the owner asked, so a request made before Due is on time
//    however long the approval took. Rejected (with a reason): the case stays open and the days keep counting.
//  - No approval needed: managers and admins closing a case, PM cases, and closes the system makes itself (transfers).
// Manager response: every close request, extension (manager step) and service request waiting for a manager is timed
// against RESPOND_DAYS working days; managerResponse() turns that into a separate 100-point score per manager.
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const d = require("../dates");
const { q, one, all, audit } = require("./db");
const repo = require("./caserepo");
const DB = { query: (sql, p) => q(sql, p) }; // addActivity takes a client

const RESPOND_DAYS = 1; // working days a manager has to answer
const sr = () => require("./sr");
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const th = (iso) => (iso ? d.thaiDate(d.fromISODate(String(iso).slice(0, 10))) : "-");
const todayIso = () => d.toISODate(d.today());
const isCloseStatus = (s) => config.closedStatuses.includes(String(s || "").toLowerCase());
const CANCEL = ["cancel", "cancelled", "n/a", "na"];
const kindOf = (status) => (CANCEL.includes(String(status).trim().toLowerCase()) ? "cancel" : "close");

const SEL = `SELECT x.*, c.case_no, c.site, c.task, c.team, c.owner_id, c.due_date, t.label AS team_label,
  rq.display_name AS requested_by_name, rq.email AS requested_by_email, dc.display_name AS decided_by_name
  FROM case_close_requests x JOIN cases c ON c.id = x.case_id JOIN teams t ON t.code = c.team
  LEFT JOIN users rq ON rq.id = x.requested_by LEFT JOIN users dc ON dc.id = x.decided_by`;
const ser = (r) => ({
  id: r.id, caseId: r.case_id, caseNo: r.case_no, site: r.site, task: r.task, team: r.team, teamLabel: r.team_label, kind: r.kind, toStatus: r.to_status,
  state: r.state, requestedBy: r.requested_by, requestedByName: r.requested_by_name, requestedAt: r.requested_at, reqDate: d.toISODate(new Date(r.req_date)),
  dueAtReq: r.due_at_req ? d.toISODate(new Date(r.due_at_req)) : null, onTime: r.due_at_req ? d.toISODate(new Date(r.req_date)) <= d.toISODate(new Date(r.due_at_req)) : true,
  resolution: (r.payload && r.payload.resolution) || "", decidedByName: r.decided_by_name || "", decidedAt: r.decided_at, note: r.note || "",
});

/** Does this person need a manager to approve closing this case? */
function needsApproval(user, kase) {
  if (["admin", "manager"].includes(user.role)) return false;
  if (kase.pmScheduleId) return false;
  return true;
}
const teamManagers = (team) =>
  all(`SELECT u.id, u.display_name, u.email FROM users u JOIN user_teams ut ON ut.user_id = u.id WHERE ut.team = $1 AND u.active AND u.role = 'manager'`, [team]);
async function canDecide(user, kase) {
  if (user.role === "admin") return true;
  if (user.role !== "manager") return false;
  return !!(await one("SELECT 1 FROM user_teams WHERE user_id = $1 AND team = $2", [user.id, kase.team]));
}

/** The same checks the close itself makes, so a request cannot be approved into an error later. */
async function precheck(kase, body) {
  repo.checkResolution(body.resolution);
  await require("./pm").checkClose(kase.id, body.status);
  await require("./customers").checkClose(body.site !== undefined ? body.site : kase.site);
  const cs = body.cs_number !== undefined ? body.cs_number : kase.csNumber;
  if (repo.rcaMod().needsRca(cs, body.status)) {
    if (body.rca) repo.rcaMod().checkRca(body.rca);
    else if (!kase.rcaText) throw bad(`เคสนี้มี CS Number (${cs}) ต้องบันทึก RCA จาก NICE ก่อนจึงจะปิดเคสได้ (ยกเว้นปิดเป็น Cancel หรือ N/A)`);
  }
}

/** Called from PUT /case/:id when the owner closes the case: store the request instead of closing. */
async function request(user, kase, body) {
  if (kase.pendingCloseId) throw bad("เคสนี้มีคำขอปิดที่รอ Manager อนุมัติอยู่แล้ว");
  const status = String(body.status).trim();
  await precheck(kase, body);
  const kind = kindOf(status);
  const r = await one(
    `INSERT INTO case_close_requests (case_id, kind, to_status, payload, requested_by, req_date, due_at_req) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [kase.id, kind, status, JSON.stringify(body), user.id, todayIso(), kase.dueDate ? d.toISODate(kase.dueDate) : null]
  ).catch((e) => {
    if (e.code === "23505") throw bad("เคสนี้มีคำขอปิดที่รอ Manager อนุมัติอยู่แล้ว");
    throw e;
  });
  await repo.addActivity(DB, kase.id, user, {
    kind: kind === "cancel" ? "ขอยกเลิกเคส" : "ขอปิดเคส",
    detail: `${user.display_name} ขอ${kind === "cancel" ? "ยกเลิก" : "ปิด"}เคส (Status ${status}) รอ Manager อนุมัติ${body.resolution ? `\nResolution: ${String(body.resolution).trim()}` : ""}`,
    system: true,
  });
  await audit(user, "case_close_request", kase.caseNo, { case_id: kase.id, status });
  const row = await one(`${SEL} WHERE x.id = $1`, [r.id]);
  mailRequest(row).catch((e) => console.error("[close] mail:", e.message));
  require("./teamsnotify").notify(kase.team, "ext", {
    title: `🔒 ขอ${kind === "cancel" ? "ยกเลิก" : "ปิด"}เคส ${kase.caseNo} รอ Manager อนุมัติ`, color: "Warning", text: String(body.resolution || "").slice(0, 300),
    facts: [["ลูกค้า", kase.site || "-"], ["งาน", kase.task || "-"], ["ผู้ขอ", user.display_name], ["Status", status], ["Due", th(row.due_at_req)]],
    actions: [["เปิดเพื่ออนุมัติ", `${config3.baseUrl}/#/case/${kase.id}`]],
  });
  return { ok: true, pendingClose: true, id: r.id };
}

async function decide(user, id, b) {
  const x = await one(`${SEL} WHERE x.id = $1`, [id]);
  if (!x) throw bad("ไม่พบคำขอนี้", 404);
  if (x.state !== "pending") throw bad("คำขอนี้พิจารณาไปแล้ว", 409);
  const kase = await repo.getCase(x.case_id);
  if (!(await canDecide(user, kase))) throw bad("อนุมัติได้เฉพาะ Manager ของทีมนี้หรือ Admin", 403);
  if (x.requested_by === user.id && user.role !== "admin") throw bad("อนุมัติคำขอของตัวเองไม่ได้", 403);
  const approve = !!b.approve;
  const note = String(b.note || "").trim().slice(0, 1000);
  if (!approve && note.length < 3) throw bad("กรุณาใส่เหตุผลเมื่อไม่อนุมัติ");
  const upd = await q("UPDATE case_close_requests SET state = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1 AND state = 'pending'", [id, approve ? "approved" : "rejected", user.id, note || null]);
  if (!upd.rowCount) throw bad("คำขอนี้พิจารณาไปแล้ว", 409);
  if (approve) {
    const owner = (await one("SELECT * FROM users WHERE id = $1", [x.requested_by])) || user;
    try {
      // Applied as the owner (Resolution by the owner), End date = the day they asked.
      await repo.updateCase(owner, kase, x.payload, { allowReassign: false, endDate: d.toISODate(new Date(x.req_date)), approvedBy: user });
    } catch (e) {
      await q("UPDATE case_close_requests SET state = 'pending', decided_by = NULL, decided_at = NULL, note = NULL WHERE id = $1", [id]);
      throw e;
    }
  } else {
    await repo.addActivity(DB, kase.id, user, { kind: "ไม่อนุมัติปิดเคส", detail: `${user.display_name} ไม่อนุมัติคำขอ${x.kind === "cancel" ? "ยกเลิก" : "ปิด"}เคส เหตุผล: ${note} · เคสยังเปิดอยู่ วันนับต่อจาก Due เดิม`, system: true });
  }
  await audit(user, approve ? "case_close_approve" : "case_close_reject", kase.caseNo, { case_id: kase.id, note });
  const row = await one(`${SEL} WHERE x.id = $1`, [id]);
  mailDecision(row, user).catch((e) => console.error("[close] mail:", e.message));
  return { ok: true, state: row.state, endDate: approve ? d.toISODate(new Date(x.req_date)) : null };
}

async function cancelReq(user, id) {
  const x = await one(`${SEL} WHERE x.id = $1`, [id]);
  if (!x || x.state !== "pending") throw bad("ไม่มีคำขอที่รออนุมัติ", 409);
  if (x.requested_by !== user.id && user.role !== "admin") throw bad("ยกเลิกได้เฉพาะผู้ขอ", 403);
  await q("UPDATE case_close_requests SET state = 'cancelled', decided_at = now() WHERE id = $1", [id]);
  await repo.addActivity(DB, x.case_id, user, { kind: "ถอนคำขอปิดเคส", detail: `${user.display_name} ถอนคำขอปิดเคส`, system: true });
  return { ok: true };
}

/** Requests the person can approve (managers: their teams; admins: all). */
async function pendingFor(user) {
  if (user.role === "admin") return (await all(`${SEL} WHERE x.state = 'pending' ORDER BY x.requested_at`)).map(ser);
  if (user.role !== "manager") return [];
  return (await all(`${SEL} WHERE x.state = 'pending' AND c.team IN (SELECT team FROM user_teams WHERE user_id = $1) AND x.requested_by <> $1 ORDER BY x.requested_at`, [user.id])).map(ser);
}

// ------------------------------------------------------------ emails
async function mailRequest(x) {
  const to = (await teamManagers(x.team)).map((m) => m.email).filter(Boolean);
  if (!to.length) return;
  const what = x.kind === "cancel" ? "ยกเลิก" : "ปิด";
  await graph.sendMail({
    to, cc: [],
    subject: `[ขอ${what}เคส รออนุมัติ] ${x.case_no} · ${x.site || "-"}`,
    html: shell("#B07800", `<p style="margin:0 0 14px">${esc(x.requested_by_name)} ขอ${what}เคส <strong>${esc(x.case_no)}</strong> (Status ${esc(x.to_status)}) กรุณาอนุมัติหรือไม่อนุมัติภายใน ${RESPOND_DAYS} วันทำการ เวลาตอบของ Manager นับใน KPI การตอบสนองของ Manager</p>
${fieldTable([["ลูกค้า", x.site || "-"], ["งาน", x.task || "-"], ["Due", th(x.due_at_req)], ["ขอเมื่อ", th(x.req_date)], ["ทันเวลา", d.toISODate(new Date(x.req_date)) <= (x.due_at_req ? d.toISODate(new Date(x.due_at_req)) : "9999") ? "ทัน (ถ้าอนุมัติ End date = วันที่ขอ)" : "เลย Due แล้ว"]])}
${x.payload && x.payload.resolution ? `<p style="margin:14px 0;background:#F6F7F9;padding:12px 14px;border-radius:8px;white-space:pre-wrap"><strong>Resolution:</strong> ${esc(x.payload.resolution)}</p>` : ""}
${button(`${config3.baseUrl}/#/case/${x.case_id}`, "เปิดเพื่ออนุมัติ")}`),
  });
}
async function mailDecision(x, by) {
  if (!x.requested_by_email) return;
  const ok = x.state === "approved";
  await graph.sendMail({
    to: [x.requested_by_email], cc: [],
    subject: `[${ok ? "อนุมัติ" : "ไม่อนุมัติ"}ปิดเคส] ${x.case_no} · ${x.site || "-"}`,
    html: shell(ok ? "#1C6B45" : "#9A1B30", `<p style="margin:0 0 14px">${esc(by.display_name)} ${ok ? `<strong>อนุมัติ</strong>คำขอปิดเคส ${esc(x.case_no)} End date ${esc(th(x.req_date))} (วันที่คุณขอปิด)` : `<strong>ไม่อนุมัติ</strong>คำขอปิดเคส ${esc(x.case_no)} เคสยังเปิดอยู่ และวันนับต่อจาก Due เดิม`}</p>
${x.note ? `<p style="margin:0 0 14px;background:#F6F7F9;padding:12px 14px;border-radius:8px"><strong>ความเห็น:</strong> ${esc(x.note)}</p>` : ""}
${button(`${config3.baseUrl}/#/case/${x.case_id}`, "เปิดเคส")}`),
  });
}

// ------------------------------------------------------------ manager response (KPI)
/** Working days between two moments (Bangkok days), weekends and company holidays not counted. */
function wdLate(fromTs, toTs, hol) {
  const a = d.toISODate(new Date(fromTs)), b = d.toISODate(new Date(toTs));
  return Math.max(0, sr().workdaysBetween(a, b, hol));
}
/**
 * Per manager, for items that reached them in [from, to): how many they answered within RESPOND_DAYS working days.
 * Close requests and service requests count for every manager of the team (any of them may answer) unless one
 * answered; an extension counts for the manager it was sent to. Still unanswered and past the limit = late.
 */
async function managerResponse(from, to) {
  const hol = await sr().holidays();
  const now = new Date();
  const mgrs = await all(`SELECT u.id, u.display_name AS name, u.email, array_remove(array_agg(ut.team), NULL) AS teams
    FROM users u LEFT JOIN user_teams ut ON ut.user_id = u.id WHERE u.active AND u.role = 'manager' GROUP BY u.id`);
  const byTeam = new Map();
  mgrs.forEach((m) => m.teams.forEach((t) => byTeam.set(t, [...(byTeam.get(t) || []), m.id])));
  const acc = new Map(mgrs.map((m) => [m.id, { id: m.id, name: m.name, teams: m.teams, total: 0, onTime: 0, late: 0, pending: 0, lateDays: 0, items: [] }]));
  const add = (ids, item) => {
    for (const id of ids) {
      const a = acc.get(id);
      if (!a) continue;
      a.total++;
      if (item.pending) a.pending++;
      if (item.late) { a.late++; a.lateDays += item.days; } else if (!item.pending) a.onTime++;
      if (item.late) a.items.push(item);
    }
  };
  const judge = (askedAt, answeredAt) => {
    const days = wdLate(askedAt, answeredAt || now, hol);
    return { pending: !answeredAt, days, late: days > RESPOND_DAYS };
  };
  const [f, t] = [from.toISOString(), to.toISOString()];
  for (const x of await all(`SELECT x.requested_at, x.decided_at, x.decided_by, x.state, c.team, c.case_no FROM case_close_requests x JOIN cases c ON c.id = x.case_id
      WHERE x.requested_at >= $1 AND x.requested_at < $2 AND x.state <> 'cancelled'`, [f, t])) {
    const j = judge(x.requested_at, x.decided_at);
    const who = x.decided_by && acc.has(x.decided_by) ? [x.decided_by] : x.decided_by ? [] : byTeam.get(x.team) || [];
    add(who, { kind: "ปิดเคส", ref: x.case_no, ...j });
  }
  for (const e of await all(`SELECT e.requested_at, coalesce(e.forwarded_at, CASE WHEN e.stage = 'manager' THEN e.decided_at END) AS answered, e.approver_id, c.case_no
      FROM case_extensions e JOIN cases c ON c.id = e.case_id WHERE e.requested_at >= $1 AND e.requested_at < $2 AND e.status <> 'cancelled'`, [f, t])) {
    add([e.approver_id], { kind: "ขยายเวลา", ref: e.case_no, ...judge(e.requested_at, e.answered) });
  }
  // Moved to another team by the requester (sent to the wrong team): the new team counts from the move.
  for (const s of await all(`SELECT s.created_at, s.forwarded_at, s.forwarded_by, coalesce(s.approved_at, CASE WHEN s.status = 'rejected' THEN s.closed_at END) AS answered, s.approved_by, s.closed_by, s.team, s.sr_no
      FROM service_requests s WHERE s.created_at >= $1 AND s.created_at < $2 AND s.status <> 'cancelled'`, [f, t])) {
    const by = s.approved_by || (s.answered ? s.closed_by : null);
    add(by && acc.has(by) ? [by] : by ? [] : byTeam.get(s.team) || [], { kind: "คำขอบริการ", ref: s.sr_no, ...judge(s.forwarded_at || s.created_at, s.answered) });
  }
  return [...acc.values()].filter((a) => a.total).map((a) => ({
    ...a, score: Math.round(((a.total - a.late) / a.total) * 100), avgLate: a.late ? Math.round((a.lateDays / a.late) * 10) / 10 : 0, items: a.items.slice(0, 20),
  })).sort((x, y) => x.score - y.score || y.late - x.late);
}

// ------------------------------------------------------------ routes
function mount(api, { wrap }) {
  api.get("/close-requests/pending", wrap(async (req, res) => res.json({ items: await pendingFor(req.user) })));
  api.get("/case/:id(\\d+)/close-request", wrap(async (req, res) => {
    const c = await repo.getCase(Number(req.params.id));
    if (!c || !repo.canSee(req.user, c)) throw bad("ไม่พบเคสนี้", 404);
    const rows = (await all(`${SEL} WHERE x.case_id = $1 ORDER BY x.id DESC LIMIT 10`, [c.id])).map(ser);
    res.json({ pending: rows.find((r) => r.state === "pending") || null, history: rows.filter((r) => r.state !== "pending"), canDecide: await canDecide(req.user, c), needsApproval: needsApproval(req.user, c) });
  }));
  api.post("/close-requests/:id(\\d+)/decide", wrap(async (req, res) => res.json(await decide(req.user, Number(req.params.id), req.body || {}))));
  api.post("/close-requests/:id(\\d+)/cancel", wrap(async (req, res) => res.json(await cancelReq(req.user, Number(req.params.id)))));
  api.get("/kpi/manager-response", wrap(async (req, res) => {
    if (!["admin", "manager", "observer"].includes(req.user.role)) throw bad("ไม่มีสิทธิ์", 403);
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || "")) || [null, ...d.toISODate(d.today()).slice(0, 7).split("-")];
    const from = new Date(`${m[1]}-${m[2]}-01T00:00:00+07:00`);
    const to = new Date(from);
    to.setMonth(to.getMonth() + 1);
    let rows = await managerResponse(from, to);
    if (req.user.role === "manager") rows = rows.filter((r) => r.id === req.user.id || r.teams.some((t) => (req.user.teams || []).includes(t)));
    res.json({ month: `${m[1]}-${m[2]}`, respondDays: RESPOND_DAYS, rows });
  }));
}

module.exports = { mount, needsApproval, isCloseStatus, request, decide, cancelReq, pendingFor, managerResponse, RESPOND_DAYS };
