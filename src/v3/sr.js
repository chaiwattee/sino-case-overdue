// Internal service requests (SR-<year>-<month>-<run>) from staff of other teams.
//
// requester ──submit──▶ pending ──manager approves (target date, assignee, work type)──▶ in_progress ──assignee closes──▶ done
//                         │  ▲                                                             │   ▲                          │
//                         │  └── requester edits ◀── info (manager asks for more) ◀──┘      │   └ target moved (asked by the assignee, decided by a manager)
//                         └──▶ rejected / cancelled                                         └── overdue = in_progress past target          requester may reopen within 7 days
//
// Who sees what: requester → own requests; assignee → assigned; manager → requests to their teams (all, if they see all teams); admin → all.
// Emails to staff are in Thai. Reminders count working days (Mon–Fri minus the holiday list in settings).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");
const { config3 } = require("./config3");
const d = require("../dates");
const graph = require("../graph");
const telegram = require("../telegram");
const { esc, shell, fieldTable } = require("../emails");
const { q, one, all, tx, getSetting, setSetting, audit } = require("./db");
const perms = require("./perms");

const SEV = { urgent_high: "ด่วนมาก", urgent: "ด่วน", normal: "ปกติ" };
const SEV_HINT = { urgent_high: "งานหยุด หรือกระทบลูกค้าวันนี้", urgent: "กระทบงานกับลูกค้าในสัปดาห์นี้", normal: "วางแผนได้" };
const STATUS = { pending: "รออนุมัติ", info: "ขอข้อมูลเพิ่ม", in_progress: "กำลังดำเนินการ", done: "เสร็จแล้ว", rejected: "ไม่อนุมัติ", cancelled: "ยกเลิก" };
const OUTCOME = { delivered: "ส่งงานแล้ว", not_possible: "ทำไม่ได้", duplicate: "ซ้ำกับคำขออื่น" };
const RESOLUTION_MIN = 20;
const REOPEN_DAYS = 7;
const FILE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "log", "csv", "zip", "docx", "xlsx", "pptx", "json", "xml"];
const FILE_DIR = path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"), "sr");
const MAX_FILE_MB = 10;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (s, n = 2000) => String(s == null ? "" : s).replace(/\u0000/g, "").trim().slice(0, n);
const url = (id) => `${config3.baseUrl}/#/sr/${id}`;
const isoDay = (v) => (v ? (typeof v === "string" ? v.slice(0, 10) : d.toISODate(v)) : null);
const thai = (v) => (v ? d.thaiDate(v) : "-");
const DAY_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const thaiDay = (v) => (v ? `${DAY_TH[d.fromISODate(isoDay(v)).getDay()]} ${thai(isoDay(v))}` : "-");

// ------------------------------------------------------------ working days
async function holidays() {
  // Stored as "YYYY-MM-DD optional name" lines; only the date counts.
  return new Set(((await getSetting("holidays", null)) || []).map((x) => String(x).slice(0, 10)));
}
function isWorkday(iso, hol) {
  const day = d.fromISODate(iso).getDay();
  return day !== 0 && day !== 6 && !hol.has(iso);
}
function addWorkdays(iso, n, hol) {
  let t = d.fromISODate(iso);
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    t = d.addDays(t, step);
    if (isWorkday(d.toISODate(t), hol)) left--;
  }
  return d.toISODate(t);
}
/** Working days between two dates (a before b → positive). */
function workdaysBetween(a, b, hol) {
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  let [x, y] = sign > 0 ? [a, b] : [b, a];
  let n = 0;
  let t = d.fromISODate(x);
  while (d.toISODate(t) < y) {
    t = d.addDays(t, 1);
    if (isWorkday(d.toISODate(t), hol)) n++;
  }
  return sign * n;
}
const todayIso = () => d.toISODate(d.today());

// ------------------------------------------------------------ people
async function teamManagers(team) {
  const rows = await all(
    `SELECT DISTINCT u.id, u.email, u.display_name, u.phone FROM users u JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND u.role = 'manager' AND t.team = $1 ORDER BY u.display_name`,
    [team]
  );
  // No manager in the team yet: the admins approve.
  return rows.length ? rows : all("SELECT id, email, display_name, phone FROM users WHERE active AND role = 'admin' ORDER BY display_name");
}
async function assignees(team) {
  return all(
    `SELECT u.id, u.display_name, u.role, u.phone,
            (SELECT count(*)::int FROM service_requests s WHERE s.assignee_id = u.id AND s.status = 'in_progress') AS open_sr,
            (SELECT count(*)::int FROM cases c WHERE c.owner_id = u.id AND c.closed_at IS NULL) AS open_cases
       FROM users u JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND u.role IN ('engineer','manager') AND t.team = $1
      ORDER BY u.display_name`,
    [team]
  );
}
async function userTeams(userId) {
  return (await all("SELECT team FROM user_teams WHERE user_id = $1", [userId])).map((r) => r.team);
}
/** Manager of the request's team (or admin / a manager who sees every team). */
async function canManage(user, sr) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role !== "manager") return false;
  if (perms.seesAllTeams(user)) return true;
  return (await userTeams(user.id)).includes(sr.team);
}
async function canSee(user, sr) {
  if (!user) return false;
  if (sr.requester_id === user.id || sr.assignee_id === user.id) return true;
  if (user.role === "admin" || user.role === "observer") return true;
  return canManage(user, sr);
}
const profileMissing = (u) => ["phone", "department", "job_title"].filter((k) => !String(u[k] || "").trim());

// ------------------------------------------------------------ reading
const SR_COLS = `s.*, t.label AS team_label,
  r.display_name AS requester_name, r.email AS requester_email, r.phone AS requester_phone, r.department AS requester_department, r.job_title AS requester_title,
  a.display_name AS assignee_name, a.email AS assignee_email, a.phone AS assignee_phone,
  ap.display_name AS approved_by_name, cb.display_name AS closed_by_name, eb.display_name AS ext_by_name,
  pj.id AS project_id, pj.name AS project_name`;
const SR_FROM = `service_requests s JOIN teams t ON t.code = s.team JOIN users r ON r.id = s.requester_id
  LEFT JOIN users a ON a.id = s.assignee_id LEFT JOIN users ap ON ap.id = s.approved_by
  LEFT JOIN users cb ON cb.id = s.closed_by LEFT JOIN users eb ON eb.id = s.ext_by
  LEFT JOIN project_tasks pt ON pt.id = s.project_task_id LEFT JOIN projects pj ON pj.id = pt.project_id`;

function ser(s, hol, viewer) {
  const t = todayIso();
  const target = isoDay(s.target_date);
  const overdue = s.status === "in_progress" && target && target < t;
  const daysLeft = s.status === "in_progress" && target ? workdaysBetween(t, target, hol) : null;
  const closedIso = s.closed_at ? d.toISODate(new Date(s.closed_at)) : null;
  return {
    id: s.id, srNo: s.sr_no, team: s.team, teamLabel: s.team_label, title: s.title, detail: s.detail,
    severity: s.severity, severityLabel: SEV[s.severity], customer: s.customer || "",
    requestedDate: isoDay(s.requested_date), targetDate: target, targetReason: s.target_reason || "",
    status: overdue ? "overdue" : s.status, statusLabel: overdue ? "เลย Target" : STATUS[s.status], rawStatus: s.status,
    daysLeft, overdueDays: overdue ? workdaysBetween(target, t, hol) : 0,
    requester: { id: s.requester_id, name: s.requester_name, email: s.requester_email, phone: s.requester_phone || "", department: s.requester_department || "", title: s.requester_title || "" },
    assignee: s.assignee_id ? { id: s.assignee_id, name: s.assignee_name, email: s.assignee_email, phone: s.assignee_phone || "" } : null,
    approvedBy: s.approved_by_name || "", approvedAt: s.approved_at, managerNote: s.manager_note || "", category: s.category || "",
    requestKind: s.request_kind || "general", meetingMode: s.meeting_mode || "", meetingModeLabel: MEETING_MODE[s.meeting_mode] || "", meetingReason: s.meeting_reason || "",
    outcome: s.outcome, outcomeLabel: s.outcome ? OUTCOME[s.outcome] : "", resolution: s.resolution || "",
    closedBy: s.closed_by_name || "", closedAt: s.closed_at, reopenCount: s.reopen_count,
    confirmedAt: s.confirmed_at || null, rating: s.rating || null, ratingNote: s.rating_note || "",
    canReopenUntil: s.status === "done" && closedIso ? d.toISODate(d.addDays(d.fromISODate(closedIso), REOPEN_DAYS)) : null,
    ext: s.ext_target ? { target: isoDay(s.ext_target), reason: s.ext_reason, by: s.ext_by_name, at: s.ext_at } : null,
    onTime: s.status === "done" && target && closedIso ? closedIso <= target : null,
    createdAt: s.created_at, updatedAt: s.updated_at,
    mine: viewer ? s.requester_id === viewer.id : undefined,
    project: s.project_id ? { id: s.project_id, name: s.project_name, taskId: s.project_task_id } : null,
  };
}
async function load(id) {
  return one(`SELECT ${SR_COLS} FROM ${SR_FROM} WHERE s.id = $1`, [id]);
}
async function loadVisible(user, id) {
  const s = await load(Number(id));
  if (!s || !(await canSee(user, s))) throw bad("ไม่พบคำขอ หรือไม่มีสิทธิ์ดู", 404);
  return s;
}
async function list(user, scope) {
  const where = [];
  const vals = [];
  const v = (x) => (vals.push(x), `$${vals.length}`);
  if (scope === "mine") where.push(`s.requester_id = ${v(user.id)}`);
  else if (scope === "assigned") where.push(`s.assignee_id = ${v(user.id)}`);
  else {
    // team scope
    if (user.role === "admin" || user.role === "observer" || (user.role === "manager" && perms.seesAllTeams(user))) {
      /* all */
    } else if (user.role === "manager") where.push(`s.team = ANY(${v(await userTeams(user.id))})`);
    else where.push(`(s.requester_id = ${v(user.id)} OR s.assignee_id = $${vals.length})`);
  }
  const rows = await all(`SELECT ${SR_COLS} FROM ${SR_FROM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY s.created_at DESC LIMIT 500`, vals);
  const hol = await holidays();
  return rows.map((r) => ser(r, hol, user));
}
async function events(id) {
  const ev = await all(
    `SELECT e.id, e.kind, e.text, e.data, e.created_at, u.display_name AS by_name, u.role AS by_role
       FROM sr_events e LEFT JOIN users u ON u.id = e.by_user WHERE e.sr_id = $1 ORDER BY e.created_at, e.id`,
    [id]
  );
  const files = await all("SELECT id, event_id, file_name, size, mime, created_at FROM sr_files WHERE sr_id = $1 ORDER BY id", [id]);
  return { events: ev, files };
}
async function addEvent(c, srId, kind, text, data, userId) {
  const r = await c.query("INSERT INTO sr_events (sr_id, kind, text, data, by_user) VALUES ($1,$2,$3,$4,$5) RETURNING id", [srId, kind, text || null, data ? JSON.stringify(data) : null, userId || null]);
  return r.rows[0].id;
}

// ------------------------------------------------------------ notifications
const SEV_COLOR = { urgent_high: "#C0283C", urgent: "#C07A00", normal: "#1F5FBF" };
function body(s, lead, extra = [], { button = "เปิดคำขอ" } = {}) {
  const rows = [
    ["เลขคำขอ", s.sr_no],
    ["หัวข้อ", s.title],
    ["ผู้ขอ", `${s.requester_name}${s.requester_department ? ` (${s.requester_department})` : ""}`],
    ["ทีม", s.team_label],
    ["Severity", SEV[s.severity]],
    ...extra,
  ];
  return `<p style="margin:0 0 14px">${lead}</p>${fieldTable(rows)}
<p style="margin:18px 0 0"><a href="${esc(url(s.id))}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1F5FBF;color:#fff;text-decoration:none;font-weight:700">${esc(button)}</a></p>`;
}
async function send(to, cc, subject, color, html) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean).map((x) => x.toLowerCase()))];
  const T = uniq(to);
  const C = uniq(cc).filter((x) => !T.includes(x));
  if (!T.length) return;
  await graph.sendMail({ to: T, cc: C, subject: `[${subject.no}] ${subject.text}`, html: shell(color, html) }).catch((e) => console.error("[sr] mail:", e.message));
}
const tg = (text) => telegram.sendText(text).catch(() => {});
const emails = (rows) => rows.map((r) => r.email);

async function notifySubmitted(s) {
  const mgrs = await teamManagers(s.team);
  await send([s.requester_email], [], { no: s.sr_no, text: `ได้รับคำขอแล้ว รอ Manager อนุมัติ · ${s.title}` }, "#1F5FBF",
    body(s, `เรียน คุณ${esc(s.requester_name)}<br>ระบบได้รับคำขอของคุณแล้ว ตอนนี้อยู่ระหว่างรอ Manager ทีม ${esc(s.team_label)} อนุมัติ<br>เมื่ออนุมัติแล้ว ระบบจะแจ้งชื่อผู้รับผิดชอบและวันที่ส่งงาน (Manager อาจปรับวันที่)`,
      [["วันที่ต้องการ", thaiDay(s.requested_date)], ["ผู้อนุมัติ", mgrs.map((m) => m.display_name).join(", ")]], { button: "ดูสถานะ / เพิ่มข้อมูล" }));
  const today = s.severity === "urgent_high" && isoDay(s.requested_date) === todayIso();
  await send(emails(mgrs), [], { no: s.sr_no, text: `${today ? "[ด่วนมาก ต้องการวันนี้] " : ""}[รออนุมัติ] จาก${s.requester_name} · ${SEV[s.severity]} · ต้องการ ${thai(s.requested_date)}` }, today ? "#B3263A" : "#C07A00",
    body(s, `${today ? "<strong style='color:#B3263A'>ด่วนมาก ผู้ขอต้องการงานภายในวันนี้ ผู้ขอจะโทรหาคุณเพื่อขออนุมัติ</strong><br>" : ""}มีคำขอบริการใหม่รอคุณอนุมัติ ตรวจรายละเอียด ปรับวันที่ส่งงานได้ และเลือกผู้รับผิดชอบ<br><span style='color:#5B6675;font-size:13px'>ถ้ายังไม่อนุมัติภายใน 1 วันทำการ ระบบเตือนซ้ำ</span>`,
      [["วันที่ต้องการ", thaiDay(s.requested_date)], ...meetingFacts(s), ["รายละเอียด", s.detail.slice(0, 600)]], { button: "ตรวจและอนุมัติ" }));
  await tg(`${today ? "🚨 ด่วนมาก ต้องการวันนี้ · " : ""}📝 คำขอบริการรออนุมัติ\n${s.sr_no} ${s.title}\nจาก ${s.requester_name}${s.requester_department ? ` (${s.requester_department})` : ""} · ทีม ${s.team_label} · ${SEV[s.severity]} · ต้องการ ${thai(s.requested_date)}`);
  require("./push").send(mgrs.map((m) => m.id), { title: `${today ? "ด่วนมาก · " : ""}คำขอบริการรออนุมัติ · ${s.sr_no}`, body: `${s.title} · จาก ${s.requester_name}`, url: `/#/sr/${s.id}`, tag: `sr-${s.id}` }).catch(() => {});
  await require("./teamsnotify").notify(s.team, "sr", {
    title: `${today ? "🚨 ด่วนมาก ต้องการวันนี้ · " : "📝 "}คำขอบริการรออนุมัติ · ${s.sr_no}`,
    color: today ? "Attention" : "Warning",
    text: s.title,
    facts: [["จาก", `${s.requester_name}${s.requester_department ? ` (${s.requester_department})` : ""}`], ["ทีม", s.team_label], ["ความเร่งด่วน", SEV[s.severity]], ["ต้องการ", thai(s.requested_date)], ...meetingFacts(s), ["ผู้อนุมัติ", mgrs.map((m) => m.display_name).join(", ")]],
    actions: [["ตรวจและอนุมัติ", url(s.id)]],
  });
}
async function notifyApproved(s, by) {
  const mgrs = await teamManagers(s.team);
  const moved = isoDay(s.target_date) !== isoDay(s.requested_date);
  await send([s.assignee_email, s.requester_email], emails(mgrs).filter((e) => e !== by.email), { no: s.sr_no, text: `[อนุมัติแล้ว] Target ${thai(s.target_date)} · ผู้รับผิดชอบ ${s.assignee_name}` }, "#1C6B45",
    body(s, `${esc(by.display_name)} อนุมัติคำขอแล้ว`, [
      ["Target date", `${thaiDay(s.target_date)}${moved ? ` (ผู้ขอต้องการ ${thai(s.requested_date)})` : ""}`],
      ...(moved && s.target_reason ? [["เหตุผลที่ปรับวันที่", s.target_reason]] : []),
      ["ผู้รับผิดชอบ", `${s.assignee_name}${s.assignee_phone ? ` · ${s.assignee_phone}` : ""}`],
      ...(s.manager_note ? [["หมายเหตุ", s.manager_note]] : []),
      ["รายละเอียด", s.detail.slice(0, 600)],
    ]));
  if (s.assignee_id) require("./push").send([s.assignee_id], { title: `งานใหม่ให้คุณ · ${s.sr_no}`, body: `${s.title} · Target ${thai(s.target_date)}`, url: `/#/sr/${s.id}`, tag: `sr-${s.id}` }).catch(() => {});
  await tg(`✅ อนุมัติคำขอบริการ ${s.sr_no} ${s.title}\nผู้รับผิดชอบ ${s.assignee_name} · Target ${thai(s.target_date)} · โดย ${by.display_name}`);
}
async function notifyInfo(s, by, note) {
  await send([s.requester_email], [], { no: s.sr_no, text: `Manager ขอข้อมูลเพิ่ม · ${s.title}` }, "#7A3B91",
    body(s, `${esc(by.display_name)} ขอข้อมูลเพิ่มก่อนอนุมัติ แก้คำขอแล้วกดส่งใหม่`, [["สิ่งที่ขอเพิ่ม", note]], { button: "แก้ไขคำขอ" }));
}
async function notifyRejected(s, by, reason) {
  await send([s.requester_email], [], { no: s.sr_no, text: `ไม่อนุมัติ · ${s.title}` }, "#5B6675", body(s, `${esc(by.display_name)} ไม่อนุมัติคำขอนี้`, [["เหตุผล", reason]]));
}
async function notifyResubmitted(s) {
  const mgrs = await teamManagers(s.team);
  await send(emails(mgrs), [], { no: s.sr_no, text: `[รออนุมัติ] ผู้ขอแก้ไขแล้ว · ${s.title}` }, "#C07A00", body(s, `${esc(s.requester_name)} แก้ไขคำขอตามที่ขอข้อมูลเพิ่มแล้ว`, [["วันที่ต้องการ", thaiDay(s.requested_date)]], { button: "ตรวจและอนุมัติ" }));
}
async function notifyUpdate(s, by, text, fileCount) {
  // Requester writes → assignee (or managers before approval). Team writes → requester.
  const fromRequester = by.id === s.requester_id;
  const to = fromRequester ? (s.assignee_email ? [s.assignee_email] : emails(await teamManagers(s.team))) : [s.requester_email];
  await send(to.filter((e) => e !== by.email), [], { no: s.sr_no, text: `${by.display_name} เพิ่มข้อมูล · ${s.title}` }, "#1F5FBF",
    body(s, `${esc(by.display_name)} เพิ่มข้อมูลในคำขอ`, [["ข้อความ", text || "-"], ...(fileCount ? [["ไฟล์แนบ", `${fileCount} ไฟล์`]] : [])]));
}
async function notifyClosed(s, by) {
  const mgrs = await teamManagers(s.team);
  const t = isoDay(s.target_date);
  const closedIso = d.toISODate(new Date(s.closed_at));
  const hol = await holidays();
  const timing = t ? (closedIso <= t ? (closedIso < t ? `ส่งก่อน Target ${workdaysBetween(closedIso, t, hol)} วันทำการ` : "ส่งตรง Target") : `ช้ากว่า Target ${workdaysBetween(t, closedIso, hol)} วันทำการ`) : "";
  await send([s.requester_email], emails(mgrs).filter((e) => e !== by.email), { no: s.sr_no, text: `[${OUTCOME[s.outcome]}] ${s.title}` }, "#1C6B45",
    body(s, `${esc(by.display_name)} ปิดคำขอแล้ว${timing ? ` · ${timing}` : ""}<br><span style="color:#5B6675;font-size:13px">ถ้างานยังไม่ตรงที่ขอ กด "ขอเปิดใหม่" ได้ภายใน ${REOPEN_DAYS} วัน</span>`,
      [["ผลลัพธ์", OUTCOME[s.outcome]], ["รายละเอียด", s.resolution]]));
  await tg(`🏁 ปิดคำขอบริการ ${s.sr_no} ${s.title}\n${OUTCOME[s.outcome]} โดย ${by.display_name}${timing ? ` · ${timing}` : ""}`);
}
async function notifyReopened(s, by, reason) {
  const mgrs = await teamManagers(s.team);
  await send([s.assignee_email], emails(mgrs), { no: s.sr_no, text: `[เปิดใหม่] ${s.title}` }, "#C07A00", body(s, `${esc(by.display_name)} ขอเปิดคำขอใหม่`, [["เหตุผล", reason], ["Target date", thaiDay(s.target_date)]]));
  await tg(`↩️ ผู้ขอเปิดคำขอบริการใหม่ ${s.sr_no} ${s.title}\nผู้รับผิดชอบ ${s.assignee_name} · เหตุผล: ${reason}`);
}
/** Who decides a request to move the target: the PM for a project task, else the team's managers — never the person
 *  who asked (another manager of the team, or the admins when the asker is the team's only manager). */
async function extDeciders(s, askerId) {
  if (s.project_task_id) return all("SELECT id, email, display_name FROM users WHERE id = $1 AND active", [s.requester_id]);
  const mgrs = (await teamManagers(s.team)).filter((m) => m.id !== askerId);
  if (mgrs.length) return mgrs;
  return all("SELECT id, email, display_name FROM users WHERE active AND role = 'admin' AND id <> $1 ORDER BY display_name", [askerId || 0]);
}
async function canDecideExt(user, s) {
  if (!user || !s.ext_target) return false;
  if (s.project_task_id) return user.id === s.requester_id || user.role === "admin" || (user.role === "manager" && (await require("./projects").isPm(user)));
  if (user.role === "admin") return true;
  if (s.ext_by === user.id) return false;
  if (await canManage(user, s)) return true;
  // The asker is the team's only manager: the admins decide (handled above).
  return false;
}
async function notifyExtAsked(s, by) {
  const to = await extDeciders(s, by.id);
  await send(emails(to), [], { no: s.sr_no, text: `[ขอเลื่อน Target] ${thai(s.target_date)} → ${thai(s.ext_target)} · ${s.title}` }, "#C07A00",
    body(s, `${esc(by.display_name)} ขอเลื่อน Target${s.project_id ? ` ของงานในโปรเจกต์ <strong>${esc(s.project_name)}</strong> (PM เป็นผู้อนุมัติ)` : ""}`, [["Target เดิม", thaiDay(s.target_date)], ["ขอเป็น", thaiDay(s.ext_target)], ["เหตุผล", s.ext_reason]], { button: "อนุมัติ / ไม่อนุมัติ" }));
}
async function notifyExtDecided(s, by, ok, note, oldTarget) {
  await send([s.assignee_email, ...(ok ? [s.requester_email] : [])], [], { no: s.sr_no, text: ok ? `[Target เปลี่ยน] ${thai(oldTarget)} → ${thai(s.target_date)} · ${s.title}` : `ไม่อนุมัติการเลื่อน Target · ${s.title}` }, ok ? "#1C6B45" : "#5B6675",
    body(s, ok ? `${esc(by.display_name)} อนุมัติเลื่อน Target` : `${esc(by.display_name)} ไม่อนุมัติการเลื่อน Target ยังเป็นวันเดิม`, [["Target", thaiDay(s.target_date)], ...(note ? [["หมายเหตุ", note]] : [])]));
}

// ------------------------------------------------------------ files
function saveFile(srId, f) {
  const name = clean(f.name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!FILE_EXT.includes(ext)) throw bad(`ไฟล์ .${ext} ไม่รองรับ (รองรับ ${FILE_EXT.join(", ")})`);
  const buf = Buffer.from(String(f.data || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw bad(`${name} เป็นไฟล์ว่าง`);
  if (buf.length > MAX_FILE_MB * 1048576) throw bad(`${name} ใหญ่เกิน ${MAX_FILE_MB} MB`);
  const dir = path.join(FILE_DIR, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const stored = path.join(dir, crypto.randomBytes(16).toString("hex") + "." + ext);
  fs.writeFileSync(stored, buf, { mode: 0o640 });
  return { name, mime: clean(f.type, 100) || "application/octet-stream", size: buf.length, stored, srId };
}
async function storeFiles(c, srId, eventId, files, userId) {
  const list = (Array.isArray(files) ? files : []).slice(0, 10);
  const saved = [];
  try {
    for (const f of list) saved.push(saveFile(srId, f));
  } catch (e) {
    saved.forEach((x) => fs.rmSync(x.stored, { force: true }));
    throw e;
  }
  for (const x of saved) await c.query("INSERT INTO sr_files (sr_id, event_id, file_name, mime, size, path, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7)", [srId, eventId, x.name, x.mime, x.size, x.stored, userId]);
  return saved.length;
}

// ------------------------------------------------------------ actions
function validDate(v, label) {
  const s = String(v || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !d.fromISODate(s)) throw bad(`${label} ไม่ถูกต้อง`);
  return s;
}
// Asking the team to join a meeting is allowed, but needs a reason: meetings with customers are normally routine work
// of the requester's own side, so the team should only be pulled in when its technical knowledge is really needed.
const MEETING_REASON_MIN = 40;
function meetingOf(b) {
  if (b.requestKind !== "meeting") return { kind: "general", mode: null, reason: null };
  const mode = ["onsite", "online"].includes(b.meetingMode) ? b.meetingMode : null;
  if (!mode) throw bad("เลือกว่าเป็น Meeting แบบ Onsite หรือ Online");
  const reason = clean(b.meetingReason, 1000);
  if (reason.length < MEETING_REASON_MIN) throw bad(`ใส่เหตุผลที่ต้องให้ทีมเข้าร่วม Meeting อย่างน้อย ${MEETING_REASON_MIN} ตัวอักษร (Meeting ปกติเป็นงาน routine จึงต้องมีเหตุผลประกอบ)`);
  return { kind: "meeting", mode, reason };
}
const MEETING_MODE = { onsite: "Onsite (ที่ลูกค้า)", online: "Online" };
const meetingFacts = (s) => (s.request_kind === "meeting" ? [["ประเภทคำขอ", `ขอให้เข้าร่วม Meeting · ${MEETING_MODE[s.meeting_mode] || "-"}`], ["เหตุผลที่ต้องให้ทีมเข้าร่วม", s.meeting_reason || "-"]] : []);

async function create(user, b) {
  const miss = profileMissing(user);
  if (miss.length) throw bad("กรอกข้อมูลของคุณ (หน่วยงาน ตำแหน่ง เบอร์โทร) ให้ครบก่อนส่งคำขอ", 428);
  const team = clean(b.team, 40);
  if (!(await one("SELECT 1 FROM teams WHERE code = $1", [team]))) throw bad("เลือกทีมที่ต้องการขอ");
  const title = clean(b.title, 200);
  const detail = clean(b.detail, 5000);
  if (title.length < 5) throw bad("ใส่หัวข้ออย่างน้อย 5 ตัวอักษร");
  if (detail.length < 20) throw bad("อธิบายงานที่ต้องการอย่างน้อย 20 ตัวอักษร");
  if (!SEV[b.severity]) throw bad("เลือก Severity");
  const mt = meetingOf(b);
  const hol = await holidays();
  const date = validDate(b.requestedDate, "วันที่ต้องการ");
  // "Very urgent" may ask for today (the requester is told to call the Manager); otherwise from the next working day.
  const sameDay = b.severity === "urgent_high" && date === todayIso();
  const minDate = addWorkdays(todayIso(), 1, hol);
  if (!sameDay && date < minDate) throw bad(b.severity === "urgent_high" ? `วันที่ต้องการต้องเป็นวันนี้ หรือตั้งแต่ ${thai(minDate)}` : `วันที่ต้องการต้องตั้งแต่ ${thai(minDate)} (วันทำการถัดไป) · ถ้าต้องการวันนี้ เลือก Severity "ด่วนมาก"`);
  if (!sameDay && !isWorkday(date, hol)) throw bad("วันที่ต้องการตรงกับวันหยุด เลือกวันทำการ");
  const id = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO service_requests (team, title, detail, severity, customer, requested_date, requester_id, request_kind, meeting_mode, meeting_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [team, title, detail, b.severity, clean(b.customer, 120) || null, date, user.id, mt.kind, mt.mode, mt.reason]
    );
    const srId = r.rows[0].id;
    const ev = await addEvent(c, srId, "submitted", null, { requestedDate: date, severity: b.severity }, user.id);
    await storeFiles(c, srId, ev, b.files, user.id);
    return srId;
  });
  const s = await load(id);
  await audit(user, "sr_create", s.sr_no, { team, severity: b.severity });
  notifySubmitted(s).catch((e) => console.error("[sr] notify submitted:", e.message));
  return s;
}
/** A service request opened by a project task (src/v3/projects.js): the PM is the requester, the task's due date is
 *  the date wanted and becomes the target when the team approves. No profile or date checks: the PM planned it. */
async function createFromProject({ requester, team, title, detail, severity, customer, due, taskId }) {
  const id = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO service_requests (team, title, detail, severity, customer, requested_date, requester_id, request_kind, project_task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'general',$8) RETURNING id`,
      [team, clean(title, 200), clean(detail, 5000), SEV[severity] ? severity : "normal", clean(customer, 120) || null, due, requester.id, taskId]
    );
    await addEvent(c, r.rows[0].id, "submitted", null, { requestedDate: due, severity, project: true }, requester.id);
    return r.rows[0].id;
  });
  const s = await load(id);
  await audit(requester, "sr_create", s.sr_no, { team, severity, projectTask: taskId });
  notifySubmitted(s).catch((e) => console.error("[sr] notify submitted:", e.message));
  return s;
}
async function edit(user, s, b) {
  if (s.requester_id !== user.id) throw bad("แก้ได้เฉพาะผู้ขอ", 403);
  // From a project task: the task's name, detail and due date are kept (they change on the project page); the PM can
  // still answer "ขอข้อมูลเพิ่ม" with a note and files and send it back.
  if (s.project_task_id) b = { note: b.note, files: b.files };
  if (!["pending", "info"].includes(s.status)) throw bad("แก้คำขอได้เฉพาะตอนรออนุมัติหรือถูกขอข้อมูลเพิ่ม เพิ่มข้อมูลด้วยช่อง \"เพิ่มข้อมูล\" แทน");
  const hol = await holidays();
  const title = clean(b.title ?? s.title, 200);
  const detail = clean(b.detail ?? s.detail, 5000);
  if (title.length < 5 || detail.length < 20) throw bad("หัวข้ออย่างน้อย 5 ตัวอักษร และรายละเอียดอย่างน้อย 20 ตัวอักษร");
  const sev = b.severity && SEV[b.severity] ? b.severity : s.severity;
  const mt = b.requestKind !== undefined ? meetingOf(b) : { kind: s.request_kind || "general", mode: s.meeting_mode, reason: s.meeting_reason };
  const date = b.requestedDate ? validDate(b.requestedDate, "วันที่ต้องการ") : isoDay(s.requested_date);
  if (date !== isoDay(s.requested_date) && date < addWorkdays(todayIso(), 1, hol) && !(sev === "urgent_high" && date === todayIso())) throw bad("วันที่ต้องการต้องเป็นวันทำการถัดไปเป็นต้นไป (ด่วนมาก เลือกวันนี้ได้)");
  const wasInfo = s.status === "info";
  await tx(async (c) => {
    await c.query(`UPDATE service_requests SET title=$2, detail=$3, severity=$4, requested_date=$5, customer=$6, request_kind=$7, meeting_mode=$8, meeting_reason=$9, status='pending', updated_at=now() WHERE id=$1`, [s.id, title, detail, sev, date, clean(b.customer ?? s.customer, 120) || null, mt.kind, mt.mode, mt.reason]);
    const ev = await addEvent(c, s.id, wasInfo ? "resubmitted" : "edited", clean(b.note, 1000) || null, null, user.id);
    await storeFiles(c, s.id, ev, b.files, user.id);
  });
  const n = await load(s.id);
  if (wasInfo) notifyResubmitted(n).catch(() => {});
  return n;
}
async function addUpdate(user, s, b) {
  if (["rejected", "cancelled"].includes(s.status)) throw bad("คำขอนี้ปิดไปแล้ว");
  const text = clean(b.text, 3000);
  const files = Array.isArray(b.files) ? b.files : [];
  if (!text && !files.length) throw bad("พิมพ์ข้อความหรือแนบไฟล์");
  const n = await tx(async (c) => {
    const ev = await addEvent(c, s.id, user.id === s.requester_id ? "update" : "note", text || null, null, user.id);
    const k = await storeFiles(c, s.id, ev, files, user.id);
    await c.query("UPDATE service_requests SET updated_at = now() WHERE id = $1", [s.id]);
    return k;
  });
  notifyUpdate(s, user, text, n).catch(() => {});
}
async function cancel(user, s, b) {
  if (s.requester_id !== user.id) throw bad("ยกเลิกได้เฉพาะผู้ขอ", 403);
  if (!["pending", "info"].includes(s.status)) throw bad("ยกเลิกได้เฉพาะคำขอที่ยังไม่อนุมัติ");
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET status='cancelled', updated_at=now() WHERE id=$1", [s.id]);
    await addEvent(c, s.id, "cancelled", clean(b.reason, 500) || null, null, user.id);
  });
}
async function approve(user, s, b) {
  if (!(await canManage(user, s))) throw bad("อนุมัติได้เฉพาะ Manager ของทีมนี้", 403);
  if (!["pending", "info"].includes(s.status)) throw bad(`คำขอนี้${STATUS[s.status]}แล้ว`);
  const hol = await holidays();
  // A project task keeps the due date the PM planned; moving it later goes through "ขอเลื่อน Target" to the PM.
  const project = !!s.project_task_id;
  const target = project ? isoDay(s.requested_date) : validDate(b.targetDate || isoDay(s.requested_date), "Target date");
  if (!project && target < todayIso()) throw bad("Target date ต้องไม่ใช่วันที่ผ่านมาแล้ว");
  if (!project && !isWorkday(target, hol) && !(target === todayIso() && s.severity === "urgent_high")) throw bad("Target date ตรงกับวันหยุด เลือกวันทำการ");
  const reason = project ? "" : clean(b.targetReason, 500);
  if (target !== isoDay(s.requested_date) && reason.length < 5) throw bad("ปรับ Target ต่างจากที่ผู้ขอต้องการ ใส่เหตุผลให้ผู้ขอทราบ");
  const a = await one("SELECT u.id FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.id = $1 AND u.active AND u.role IN ('engineer','manager') AND t.team = $2", [Number(b.assigneeId), s.team]);
  if (!a) throw bad("เลือกผู้รับผิดชอบจากสมาชิกทีมนี้");
  const category = clean(b.category, 80) || null;
  // Only the first manager wins; a second click sees the new status.
  const r = await q(
    `UPDATE service_requests SET status='in_progress', target_date=$2, target_reason=$3, assignee_id=$4, approved_by=$5, approved_at=now(), manager_note=$6, category=$7, updated_at=now()
      WHERE id=$1 AND status IN ('pending','info')`,
    [s.id, target, reason || null, a.id, user.id, clean(b.note, 1000) || null, category]
  );
  if (!r.rowCount) throw bad("มี Manager คนอื่นดำเนินการคำขอนี้แล้ว รีเฟรชหน้า", 409);
  await q("INSERT INTO sr_events (sr_id, kind, text, data, by_user) VALUES ($1,'approved',$2,$3,$4)", [s.id, clean(b.note, 1000) || null, JSON.stringify({ target, requested: isoDay(s.requested_date), reason, assigneeId: a.id, category }), user.id]);
  const n = await load(s.id);
  await audit(user, "sr_approve", n.sr_no, { target, assignee: n.assignee_name });
  notifyApproved(n, user).catch((e) => console.error("[sr] notify approved:", e.message));
  return n;
}
async function askInfo(user, s, b) {
  if (!(await canManage(user, s))) throw bad("เฉพาะ Manager ของทีมนี้", 403);
  if (s.status !== "pending") throw bad("ขอข้อมูลเพิ่มได้เฉพาะคำขอที่รออนุมัติ");
  const note = clean(b.note, 1000);
  if (note.length < 5) throw bad("บอกผู้ขอว่าต้องการข้อมูลอะไรเพิ่ม");
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET status='info', updated_at=now() WHERE id=$1", [s.id]);
    await addEvent(c, s.id, "info", note, null, user.id);
  });
  notifyInfo(s, user, note).catch(() => {});
}
async function reject(user, s, b) {
  if (!(await canManage(user, s))) throw bad("เฉพาะ Manager ของทีมนี้", 403);
  if (!["pending", "info"].includes(s.status)) throw bad("ไม่อนุมัติได้เฉพาะคำขอที่ยังไม่อนุมัติ");
  const reason = clean(b.reason, 1000);
  if (reason.length < 5) throw bad("ใส่เหตุผลที่ไม่อนุมัติ");
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET status='rejected', closed_by=$2, closed_at=now(), resolution=$3, updated_at=now() WHERE id=$1", [s.id, user.id, reason]);
    await addEvent(c, s.id, "rejected", reason, null, user.id);
  });
  await audit(user, "sr_reject", s.sr_no, { reason });
  notifyRejected(s, user, reason).catch(() => {});
}
async function reassign(user, s, b) {
  if (!(await canManage(user, s))) throw bad("เฉพาะ Manager ของทีมนี้", 403);
  if (s.status !== "in_progress") throw bad("เปลี่ยนผู้รับผิดชอบได้เฉพาะคำขอที่กำลังดำเนินการ");
  const a = await one("SELECT u.id, u.display_name FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.id = $1 AND u.active AND u.role IN ('engineer','manager') AND t.team = $2", [Number(b.assigneeId), s.team]);
  if (!a) throw bad("เลือกผู้รับผิดชอบจากสมาชิกทีมนี้");
  if (a.id === s.assignee_id) return;
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET assignee_id=$2, updated_at=now() WHERE id=$1", [s.id, a.id]);
    await addEvent(c, s.id, "reassigned", clean(b.note, 500) || null, { from: s.assignee_name, to: a.display_name }, user.id);
  });
  const n = await load(s.id);
  await send([n.assignee_email], [s.assignee_email, n.requester_email], { no: n.sr_no, text: `ผู้รับผิดชอบใหม่: ${n.assignee_name} · ${n.title}` }, "#1F5FBF", body(n, `${esc(user.display_name)} มอบหมายคำขอนี้ให้ ${esc(n.assignee_name)} (เดิม ${esc(s.assignee_name)})`, [["Target date", thaiDay(n.target_date)]]));
}
async function askExtension(user, s, b) {
  if (s.assignee_id !== user.id && !(await canManage(user, s))) throw bad("ขอเลื่อนได้เฉพาะผู้รับผิดชอบ", 403);
  if (s.status !== "in_progress") throw bad("ขอเลื่อนได้เฉพาะคำขอที่กำลังดำเนินการ");
  if (s.ext_target) throw bad("มีคำขอเลื่อนที่รอ Manager อยู่แล้ว");
  const hol = await holidays();
  const target = validDate(b.targetDate, "วันที่ใหม่");
  if (target <= isoDay(s.target_date)) throw bad("วันที่ใหม่ต้องหลัง Target เดิม");
  if (!isWorkday(target, hol)) throw bad("วันที่ใหม่ตรงกับวันหยุด");
  const reason = clean(b.reason, 1000);
  if (reason.length < 10) throw bad("ใส่เหตุผลอย่างน้อย 10 ตัวอักษร");
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET ext_target=$2, ext_reason=$3, ext_by=$4, ext_at=now(), updated_at=now() WHERE id=$1", [s.id, target, reason, user.id]);
    await addEvent(c, s.id, "ext_asked", reason, { from: isoDay(s.target_date), to: target }, user.id);
  });
  notifyExtAsked(await load(s.id), user).catch(() => {});
}
async function decideExtension(user, s, b) {
  if (!s.ext_target) throw bad("ไม่มีคำขอเลื่อน Target");
  if (!(await canDecideExt(user, s))) throw bad(s.project_task_id ? "งานจากโปรเจกต์ PM ของโปรเจกต์เป็นผู้อนุมัติการเลื่อน" : s.ext_by === user.id ? "อนุมัติคำขอเลื่อนของตัวเองไม่ได้ ให้ Manager คนอื่นในทีม (หรือ Admin) อนุมัติ" : "เฉพาะ Manager ของทีมนี้", 403);
  const ok = !!b.approve;
  const note = clean(b.note, 500);
  const old = isoDay(s.target_date);
  await tx(async (c) => {
    await c.query(
      `UPDATE service_requests SET ${ok ? "target_date = ext_target, reminded = '{}'::jsonb," : ""} ext_target=NULL, ext_reason=NULL, ext_by=NULL, ext_at=NULL, updated_at=now() WHERE id=$1`,
      [s.id]
    );
    await addEvent(c, s.id, ok ? "ext_approved" : "ext_rejected", note || null, { from: old, to: isoDay(s.ext_target) }, user.id);
  });
  if (ok) await require("./projects").onSrTargetMoved(s, old, isoDay(s.ext_target), s.ext_at, user.id).catch((e) => console.error("[sr] project due:", e.message));
  notifyExtDecided(await load(s.id), user, ok, note, old).catch(() => {});
}
async function close(user, s, b) {
  if (s.assignee_id !== user.id && !(await canManage(user, s))) throw bad("ปิดคำขอได้เฉพาะผู้รับผิดชอบหรือ Manager", 403);
  if (s.status !== "in_progress") throw bad("ปิดได้เฉพาะคำขอที่กำลังดำเนินการ");
  if (!OUTCOME[b.outcome]) throw bad("เลือกผลลัพธ์");
  const resolution = clean(b.resolution, 3000);
  if (resolution.length < RESOLUTION_MIN) throw bad(`ใส่เหตุผล / สิ่งที่ส่งมอบอย่างน้อย ${RESOLUTION_MIN} ตัวอักษร`);
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET status='done', outcome=$2, resolution=$3, closed_by=$4, closed_at=now(), ext_target=NULL, ext_reason=NULL, ext_by=NULL, ext_at=NULL, updated_at=now() WHERE id=$1", [s.id, b.outcome, resolution, user.id]);
    const ev = await addEvent(c, s.id, "closed", resolution, { outcome: b.outcome }, user.id);
    await storeFiles(c, s.id, ev, b.files, user.id);
  });
  const n = await load(s.id);
  await audit(user, "sr_close", n.sr_no, { outcome: b.outcome });
  notifyClosed(n, user).catch((e) => console.error("[sr] notify closed:", e.message));
}
/** The requester confirms the finished work and rates it 1–5 (used in the KPI of internal service teams). */
async function confirmDone(user, s, b) {
  if (s.requester_id !== user.id) throw bad("ยืนยันรับงานได้เฉพาะผู้ขอ", 403);
  if (s.status !== "done") throw bad("ยืนยันรับงานได้เฉพาะคำขอที่เสร็จแล้ว");
  if (s.confirmed_at) throw bad("ยืนยันรับงานไปแล้ว");
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad("เลือกคะแนน 1–5");
  const note = clean(b.note, 1000);
  if (rating <= 2 && note.length < 5) throw bad("ให้คะแนน 1–2 ช่วยบอกเหตุผลสั้นๆ ให้ทีมปรับปรุง");
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET confirmed_at = now(), rating = $2, rating_note = $3, updated_at = now() WHERE id = $1", [s.id, rating, note || null]);
    await addEvent(c, s.id, "confirmed", note || null, { rating }, user.id);
  });
  await audit(user, "sr_confirm", s.sr_no, { rating });
}
async function reopen(user, s, b) {
  if (s.requester_id !== user.id) throw bad("ขอเปิดใหม่ได้เฉพาะผู้ขอ", 403);
  if (s.status !== "done") throw bad("เปิดใหม่ได้เฉพาะคำขอที่เสร็จแล้ว");
  if (s.confirmed_at) throw bad("ยืนยันรับงานแล้ว เปิดใหม่ไม่ได้ ส่งคำขอใหม่แทน");
  const until = d.toISODate(d.addDays(d.fromISODate(d.toISODate(new Date(s.closed_at))), REOPEN_DAYS));
  if (todayIso() > until) throw bad(`เปิดใหม่ได้ภายใน ${REOPEN_DAYS} วันหลังปิด (ถึง ${thai(until)}) ส่งคำขอใหม่แทน`);
  const reason = clean(b.reason, 1000);
  if (reason.length < 10) throw bad("บอกว่างานยังไม่ตรงที่ขออย่างไร อย่างน้อย 10 ตัวอักษร");
  const hol = await holidays();
  // The assignee gets at least one more working day.
  const target = isoDay(s.target_date) > todayIso() ? isoDay(s.target_date) : addWorkdays(todayIso(), 2, hol);
  await tx(async (c) => {
    await c.query("UPDATE service_requests SET status='in_progress', outcome=NULL, closed_by=NULL, closed_at=NULL, confirmed_at=NULL, rating=NULL, rating_note=NULL, target_date=$2, reopen_count=reopen_count+1, reminded='{}'::jsonb, updated_at=now() WHERE id=$1", [s.id, target]);
    await addEvent(c, s.id, "reopened", reason, { target }, user.id);
  });
  notifyReopened(await load(s.id), user, reason).catch(() => {});
}

// ------------------------------------------------------------ reminders (job, every working day 08:30)
async function runReminders() {
  const hol = await holidays();
  const t = todayIso();
  if (!isWorkday(t, hol)) return { skipped: "วันหยุด" };
  const out = { approval: 0, before: 0, due: 0, overdue: 0 };
  const mark = (id, k) => q("UPDATE service_requests SET reminded = reminded || jsonb_build_object($2::text, $3::text) WHERE id = $1", [id, k, t]);

  // Waiting for approval for more than one working day.
  for (const s of await all(`SELECT ${SR_COLS} FROM ${SR_FROM} WHERE s.status = 'pending'`)) {
    const since = d.toISODate(new Date(s.updated_at));
    if (workdaysBetween(since, t, hol) < 1 || s.reminded.approval === t) continue;
    const mgrs = await teamManagers(s.team);
    await send(emails(mgrs), [], { no: s.sr_no, text: `[ค้างอนุมัติ ${workdaysBetween(since, t, hol)} วันทำการ] ${s.title}` }, "#C07A00", body(s, "คำขอนี้ยังรออนุมัติ", [["วันที่ต้องการ", thaiDay(s.requested_date)]], { button: "ตรวจและอนุมัติ" }));
    await tg(`⏳ คำขอบริการค้างอนุมัติ ${s.sr_no} ${s.title}\nทีม ${s.team_label} · จาก ${s.requester_name} · ต้องการ ${thai(s.requested_date)}`);
    await mark(s.id, "approval");
    out.approval++;
  }
  for (const s of await all(`SELECT ${SR_COLS} FROM ${SR_FROM} WHERE s.status = 'in_progress' AND s.target_date IS NOT NULL`)) {
    const target = isoDay(s.target_date);
    const left = workdaysBetween(t, target, hol);
    const mgrs = emails(await teamManagers(s.team));
    if (left === 1 && s.reminded.before !== t) {
      await send([s.assignee_email], mgrs, { no: s.sr_no, text: `[ใกล้ครบกำหนด] ครบ Target พรุ่งนี้ (${thaiDay(target)})` }, "#C07A00", body(s, "คำขอนี้ยังไม่ปิด และครบ Target ในวันทำการถัดไป", [["ผู้รับผิดชอบ", s.assignee_name], ["Target date", thaiDay(target)]]));
      await tg(`⏰ คำขอบริการครบ Target วันทำการถัดไป\n${s.sr_no} ${s.title}\nผู้รับผิดชอบ ${s.assignee_name} · Target ${thaiDay(target)}`);
      await mark(s.id, "before");
      out.before++;
    } else if (left === 0 && target === t && s.reminded.due !== t) {
      await send([s.assignee_email], [], { no: s.sr_no, text: `[ครบกำหนดวันนี้] ${s.title}` }, "#C07A00", body(s, "คำขอนี้ครบ Target วันนี้", [["Target date", thaiDay(target)]]));
      await tg(`📌 คำขอบริการครบ Target วันนี้\n${s.sr_no} ${s.title}\nผู้รับผิดชอบ ${s.assignee_name}`);
      await mark(s.id, "due");
      out.due++;
    } else if (target < t && s.reminded.overdue !== t) {
      const late = workdaysBetween(target, t, hol);
      await send([s.assignee_email], mgrs, { no: s.sr_no, text: `[เลย Target ${late} วันทำการ] ${s.title}` }, "#C0283C", body(s, `คำขอนี้เลย Target มาแล้ว ${late} วันทำการ ปิดคำขอเมื่อส่งงาน หรือขอเลื่อน Target พร้อมเหตุผล`, [["ผู้รับผิดชอบ", s.assignee_name], ["Target date", thaiDay(target)]]));
      await tg(`🔴 คำขอบริการเลย Target ${late} วันทำการ\n${s.sr_no} ${s.title}\nผู้รับผิดชอบ ${s.assignee_name} · Target ${thaiDay(target)}`);
      await mark(s.id, "overdue");
      out.overdue++;
    }
  }
  return out;
}

// ------------------------------------------------------------ KPI input (skill only, no points of its own)
/** Requests closed as delivered in [fromIso, toIso], per assignee: { count, onTime, categories:{name:n} }. */
async function kpiByAssignee(fromIso, toIso) {
  const rows = await all(
    `SELECT assignee_id, category, title, (closed_at AT TIME ZONE 'Asia/Bangkok')::date AS closed, target_date
       FROM service_requests WHERE status = 'done' AND outcome = 'delivered' AND assignee_id IS NOT NULL
        AND (closed_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1 AND $2`,
    [fromIso, toIso]
  ).catch(() => []);
  const by = new Map();
  for (const r of rows) {
    const o = by.get(r.assignee_id) || { count: 0, onTime: 0, categories: {}, titles: [] };
    o.count++;
    if (isoDay(r.closed) <= isoDay(r.target_date)) o.onTime++;
    if (r.category) o.categories[r.category] = (o.categories[r.category] || 0) + 1;
    else o.titles.push(r.title);
    by.set(r.assignee_id, o);
  }
  return by;
}

// ------------------------------------------------------------ HTTP
function mount(api, { wrap }) {
  const visible = async (req) => loadVisible(req.user, req.params.id);
  const reply = async (req, res, s) => {
    const hol = await holidays();
    const fresh = await load(s.id);
    const { events: ev, files } = await events(s.id);
    const manage = await canManage(req.user, fresh);
    res.json({
      sr: ser(fresh, hol, req.user), events: ev, files,
      can: {
        manage,
        edit: fresh.requester_id === req.user.id && ["pending", "info"].includes(fresh.status),
        cancel: fresh.requester_id === req.user.id && ["pending", "info"].includes(fresh.status),
        update: !["rejected", "cancelled"].includes(fresh.status),
        approve: manage && ["pending", "info"].includes(fresh.status),
        close: fresh.status === "in_progress" && (fresh.assignee_id === req.user.id || manage),
        extend: fresh.status === "in_progress" && !fresh.ext_target && (fresh.assignee_id === req.user.id || manage),
        decideExt: await canDecideExt(req.user, fresh),
        reassign: manage && fresh.status === "in_progress",
        reopen: fresh.requester_id === req.user.id && fresh.status === "done" && !fresh.confirmed_at && ser(fresh, hol).canReopenUntil >= todayIso(),
        confirm: fresh.requester_id === req.user.id && fresh.status === "done" && !fresh.confirmed_at,
      },
      assignees: manage ? await assignees(fresh.team) : [],
    });
  };

  api.get("/profile", wrap(async (req, res) => {
    const u = await one("SELECT id, email, display_name, role, phone, department, job_title, profile_confirmed_at FROM users WHERE id = $1", [req.user.id]);
    res.json({ profile: u, missing: profileMissing(u), departments: await require("./departments").activeNames() });
  }));
  api.put("/profile", wrap(async (req, res) => {
    const b = req.body || {};
    const phone = clean(b.phone, 60);
    if (phone && (phone.replace(/\D/g, "").length < 6 || !/^[+0-9(]/.test(phone))) throw bad("เบอร์โทรไม่ถูกต้อง เช่น 081-234-5678 หรือ 02-123-4567 ต่อ 105");
    const deps = require("./departments");
    const cur = await one("SELECT department FROM users WHERE id = $1", [req.user.id]);
    const dep = await deps.check(b.department, b.department_other, cur && cur.department);
    if (dep.requested) await deps.notifyRequest(req.user, dep.value);
    const vals = [req.user.id, clean(b.display_name, 120) || null, phone || null, dep.value, clean(b.job_title, 120) || null];
    await q(`UPDATE users SET display_name = COALESCE($2, display_name), phone = $3, department = $4, job_title = $5, profile_confirmed_at = now(), updated_at = now() WHERE id = $1`, vals);
    await audit(req.user, "profile_update", req.user.email, { phone: !!phone, department: vals[3], job_title: vals[4] });
    const u = await one("SELECT id, email, display_name, role, phone, department, job_title, profile_confirmed_at FROM users WHERE id = $1", [req.user.id]);
    res.json({ ok: true, profile: u, missing: profileMissing(u) });
  }));

  api.get("/sr/meta", wrap(async (req, res) => {
    const hol = await holidays();
    const teams = await all("SELECT code, label FROM teams ORDER BY sort");
    const managers = {};
    const managerPhones = {};
    for (const t of teams) {
      const ms = await teamManagers(t.code);
      managers[t.code] = ms.map((m) => m.display_name);
      managerPhones[t.code] = ms.map((m) => ({ name: m.display_name, phone: m.phone || "" }));
    }
    const cats = (await require("./kpi").categories()).map((c) => c.name);
    const u = await one("SELECT phone, department, job_title FROM users WHERE id = $1", [req.user.id]);
    const counts = await one(
      `SELECT count(*) FILTER (WHERE status IN ('pending','info'))::int AS pending, count(*) FILTER (WHERE status = 'in_progress')::int AS open
         FROM service_requests WHERE team = ANY($1)`,
      [req.user.role === "admin" || perms.seesAllTeams(req.user) ? teams.map((t) => t.code) : await userTeams(req.user.id)]
    );
    res.json({
      teams, managers, managerPhones, today: todayIso(), severities: Object.entries(SEV).map(([k, v]) => ({ key: k, label: v, hint: SEV_HINT[k] })), categories: cats,
      minDate: addWorkdays(todayIso(), 1, hol), holidays: [...hol].sort(), profileMissing: profileMissing(u), resolutionMin: RESOLUTION_MIN,
      canManage: req.user.role === "admin" || req.user.role === "manager", counts, fileExt: FILE_EXT, maxFileMb: MAX_FILE_MB,
    });
  }));
  api.get("/sr", wrap(async (req, res) => {
    const scope = ["mine", "assigned", "team"].includes(req.query.scope) ? req.query.scope : req.user.role === "requester" ? "mine" : "team";
    res.json({ items: await list(req.user, req.user.role === "requester" ? "mine" : scope) });
  }));
  api.post("/sr", wrap(async (req, res) => {
    const s = await create(req.user, req.body || {});
    res.json({ ok: true, id: s.id, srNo: s.sr_no });
  }));
  api.get("/sr/:id", wrap(async (req, res) => reply(req, res, await visible(req))));
  const act = (fn) => wrap(async (req, res) => {
    const s = await visible(req);
    await fn(req.user, s, req.body || {});
    await reply(req, res, s);
  });
  api.put("/sr/:id", act(edit));
  api.post("/sr/:id/update", act(addUpdate));
  api.post("/sr/:id/cancel", act(cancel));
  api.post("/sr/:id/approve", act(approve));
  api.post("/sr/:id/info", act(askInfo));
  api.post("/sr/:id/reject", act(reject));
  api.post("/sr/:id/reassign", act(reassign));
  api.post("/sr/:id/extend", act(askExtension));
  api.post("/sr/:id/extend/decide", act(decideExtension));
  api.post("/sr/:id/close", act(close));
  api.post("/sr/:id/reopen", act(reopen));
  api.post("/sr/:id/confirm", act(confirmDone));
  api.get("/sr-files/:fid", wrap(async (req, res) => {
    const f = await one("SELECT * FROM sr_files WHERE id = $1", [Number(req.params.fid)]);
    if (!f) throw bad("ไม่พบไฟล์", 404);
    await loadVisible(req.user, f.sr_id);
    if (!f.path.startsWith(FILE_DIR) || !fs.existsSync(f.path)) throw bad("ไม่พบไฟล์", 404);
    res.setHeader("Content-Type", f.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${/^image\/(png|jpe?g|gif|webp)$/.test(f.mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    fs.createReadStream(f.path).pipe(res);
  }));
  api.get("/settings/holidays", wrap(async (req, res) => res.json({ holidays: ((await getSetting("holidays", null)) || []).map(String).sort() })));
  api.put("/settings/holidays", wrap(async (req, res) => {
    if (!(await perms.can(req.user, "settings_manage"))) throw bad("ไม่มีสิทธิ์", 403);
    const seen = new Set();
    const list = (req.body?.holidays || []).map((x) => clean(x, 80)).filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x) && !seen.has(x.slice(0, 10)) && seen.add(x.slice(0, 10))).sort();
    await setSetting("holidays", list);
    await audit(req.user, "holidays_update", null, { count: list.length });
    res.json({ ok: true, holidays: list });
  }));
}

/** Requests a requester-only account may make (everything else is refused). */
const REQUESTER_PATHS = [/^\/me$/, /^\/departments$/, /^\/profile(\/avatar|\/lang)?$/, /^\/push(\/subscribe|\/unsubscribe|\/test)?$/, /^\/avatar\/\d+$/, /^\/sr(\/|$)/, /^\/sr-files\//, /^\/kpi\/response$/];

module.exports = { mount, runReminders, kpiByAssignee, createFromProject, REQUESTER_PATHS, SEV, STATUS, OUTCOME, isWorkday, addWorkdays, workdaysBetween, holidays, profileMissing };
