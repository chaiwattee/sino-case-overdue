// Preventive maintenance (PM): recurring jobs per customer (e.g. a system check every 3 months).
// On each round the system opens a case for the assigned User with the schedule's checklist; the case can only be closed
// once every checklist item is ticked (Cancel / N/A excepted).
const d = require("../dates");
const { q, one, all, tx, audit } = require("./db");
const perms = require("./perms");
const { config3 } = require("./config3");

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const clean = (v, n = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const SEL = `SELECT p.*, u.display_name AS owner_name, u.email AS owner_email, t.label AS team_label,
       c.case_no AS last_case_no, c.closed_at AS last_closed_at
  FROM pm_schedules p LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN teams t ON t.code = p.team LEFT JOIN cases c ON c.id = p.last_case_id`;

function addMonths(iso, n) {
  const t = d.fromISODate(iso);
  const day = t.getDate();
  const x = new Date(t.getFullYear(), t.getMonth() + n, 1);
  x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  return d.toISODate(x);
}
/** May set up and edit PM schedules: the "pm_manage" permission (admin and manager by role; other users one by one). */
const canManage = (user) => perms.can(user, "pm_manage");
const DEFAULT_SLA = 14; // days a PM case has from its Start date (ordinary cases: SLA_DAYS)

async function list(user) {
  const scope = perms.teamScope(user);
  const rows = scope ? await all(`${SEL} WHERE p.team = ANY($1) ORDER BY p.active DESC, p.next_date, p.id`, [scope]) : await all(`${SEL} ORDER BY p.active DESC, p.next_date, p.id`);
  rows.forEach((r) => delete r.ma_file_path); // server path stays on the server
  return rows;
}

// ------------------------------------------------------------ MA form (template file per schedule)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const MA_EXT = ["pdf", "docx", "doc", "xlsx", "xls"];
const MA_MAX = 10 * 1024 * 1024;
const maDir = () => path.join(require("./casefiles").DIR, "pm-forms");
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel" };

async function scheduleFor(user, id, { manage = false } = {}) {
  const p = await one("SELECT * FROM pm_schedules WHERE id = $1", [id]);
  if (!p) throw bad("ไม่พบงาน PM", 404);
  const scope = perms.teamScope(user);
  if (scope && !scope.includes(p.team)) throw bad("เฉพาะงาน PM ของทีมคุณ", 403);
  if (manage && !(await canManage(user))) throw bad("ไม่มีสิทธิ์ตั้งหรือแก้งาน PM", 403);
  return p;
}
function removeStored(file) {
  try {
    if (file && file.startsWith(maDir())) fs.unlinkSync(file);
  } catch (e) {}
}
async function setMaForm(user, id, b) {
  const p = await scheduleFor(user, id, { manage: true });
  const name = String(b.name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 150);
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name || !MA_EXT.includes(ext)) throw bad(`แบบฟอร์ม MA รองรับไฟล์ ${MA_EXT.map((x) => "." + x).join(" ")}`);
  const buf = Buffer.from(String(b.data || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw bad("ไฟล์ว่าง");
  if (buf.length > MA_MAX) throw bad("ไฟล์ใหญ่เกิน 10 MB");
  fs.mkdirSync(maDir(), { recursive: true, mode: 0o750 });
  const stored = path.join(maDir(), crypto.randomBytes(16).toString("hex") + "." + ext);
  fs.writeFileSync(stored, buf, { mode: 0o640 });
  await q("UPDATE pm_schedules SET ma_file_path = $2, ma_file_name = $3, ma_file_mime = $4, ma_file_size = $5, updated_at = now() WHERE id = $1", [p.id, stored, name, MIME[ext], buf.length]);
  removeStored(p.ma_file_path);
  await audit(user, "pm_ma_form", p.title, { id: p.id, file: name, size: buf.length });
  return { ok: true, fileName: name };
}
async function clearMaForm(user, id) {
  const p = await scheduleFor(user, id, { manage: true });
  await q("UPDATE pm_schedules SET ma_file_path = NULL, ma_file_name = NULL, ma_file_mime = NULL, ma_file_size = NULL, updated_at = now() WHERE id = $1", [p.id]);
  removeStored(p.ma_file_path);
  await audit(user, "pm_ma_form_remove", p.title, { id: p.id });
  return { ok: true };
}
function sendMaForm(res, p) {
  if (!p || !p.ma_file_path || !p.ma_file_path.startsWith(maDir()) || !fs.existsSync(p.ma_file_path)) throw bad("ไม่พบแบบฟอร์ม MA", 404);
  res.set("Content-Type", "application/octet-stream");
  res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(p.ma_file_name)}`);
  res.set("Cache-Control", "private, no-store");
  fs.createReadStream(p.ma_file_path).pipe(res);
}
/** Schedule of a PM case (or of the case it was transferred from), with its MA form. */
const scheduleOfCase = (caseId) =>
  one(
    `SELECT p.* FROM cases c JOIN pm_schedules p ON p.id = c.pm_schedule_id WHERE c.id = $1`,
    [caseId]
  );
/** MA form status on a case: { fileName, filled } or null when the schedule has no MA form. */
async function maFor(caseId) {
  const p = await scheduleOfCase(caseId);
  if (!p || !p.ma_file_name) return null;
  const n = await one(
    `SELECT count(*)::int AS n FROM case_files WHERE kind = 'ma' AND (case_id = $1 OR case_id = (SELECT transferred_from FROM cases WHERE id = $1))`,
    [caseId]
  );
  return { fileName: p.ma_file_name, filled: n.n };
}

function checkBody(b) {
  const title = clean(b.title, 200);
  if (title.length < 3) throw bad("ใส่ชื่องาน PM");
  const site = clean(b.site, 120);
  if (!site) throw bad("เลือกลูกค้า");
  const every = Number(b.every_months);
  if (!(every >= 1 && every <= 24)) throw bad("รอบต้องอยู่ระหว่าง 1–24 เดือน");
  const next = d.fromISODate(b.next_date);
  if (!next) throw bad("ใส่วันที่รอบถัดไป");
  const checklist = (Array.isArray(b.checklist) ? b.checklist : String(b.checklist || "").split("\n")).map((x) => clean(x, 300)).filter(Boolean).slice(0, 40);
  if (!checklist.length) throw bad("ใส่ checklist อย่างน้อย 1 ข้อ");
  const sla = b.sla_days == null || b.sla_days === "" ? DEFAULT_SLA : Number(b.sla_days);
  if (!(Number.isInteger(sla) && sla >= 1 && sla <= 90)) throw bad("SLA ของเคส PM ต้องอยู่ระหว่าง 1–90 วัน");
  return { sla_days: sla, title, site, product: clean(b.product, 60) || null, team: String(b.team || ""), owner_id: Number(b.owner_id) || null, every_months: every, next_date: d.toISODate(next), checklist, note: clean(b.note, 1000) || null, active: b.active !== false };
}

async function save(user, id, b) {
  if (!(await canManage(user))) throw bad("ไม่มีสิทธิ์ตั้งหรือแก้งาน PM", 403);
  const x = checkBody(b);
  if (!(await one("SELECT 1 FROM teams WHERE code = $1", [x.team]))) throw bad("เลือกทีม");
  if (!(await one("SELECT 1 FROM lookups WHERE kind = 'site' AND lower(value) = lower($1) AND NOT pending", [x.site]))) throw bad("เลือกลูกค้าจากรายการ (ลูกค้าที่อนุมัติแล้ว)");
  if (!x.owner_id) throw bad("เลือกผู้รับผิดชอบ");
  await perms.checkAssign(user, x.team, x.owner_id);
  if (id) {
    const old = await one("SELECT * FROM pm_schedules WHERE id = $1", [id]);
    if (!old) throw bad("ไม่พบงาน PM", 404);
    const scope = perms.teamScope(user);
    if (scope && !scope.includes(old.team)) throw bad("แก้ได้เฉพาะงาน PM ของทีมคุณ", 403);
    await q(
      `UPDATE pm_schedules SET title=$2, site=$3, product=$4, team=$5, owner_id=$6, every_months=$7, next_date=$8, checklist=$9, note=$10, active=$11, sla_days=$12, updated_at=now() WHERE id=$1`,
      [id, x.title, x.site, x.product, x.team, x.owner_id, x.every_months, x.next_date, x.checklist, x.note, x.active, x.sla_days]
    );
    await audit(user, "pm_update", x.title, { id, site: x.site, every: x.every_months, next: x.next_date, active: x.active, sla: x.sla_days });
    return id;
  }
  const r = await one(
    `INSERT INTO pm_schedules (title, site, product, team, owner_id, every_months, next_date, checklist, note, created_by, sla_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [x.title, x.site, x.product, x.team, x.owner_id, x.every_months, x.next_date, x.checklist, x.note, user.id, x.sla_days]
  );
  await audit(user, "pm_create", x.title, { id: r.id, site: x.site, every: x.every_months, next: x.next_date });
  return r.id;
}

/** A PM schedule made when a project is handed over. The project's PM may create it (normally only managers do):
 *  the owner must be a member of the chosen team, and that team's managers are told by email. */
async function createFromProject(user, b) {
  const x = checkBody(b);
  if (!(await one("SELECT 1 FROM teams WHERE code = $1", [x.team]))) throw bad("เลือกทีมที่ดูแล PM");
  if (!(await one("SELECT 1 FROM lookups WHERE kind = 'site' AND lower(value) = lower($1) AND NOT pending", [x.site]))) throw bad("เลือกลูกค้าจากรายชื่อลูกค้าในระบบ (ลูกค้าใหม่ให้เพิ่มและอนุมัติชื่อก่อน)");
  const owner = x.owner_id ? await one("SELECT u.id, u.display_name, u.email FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.id = $1 AND u.active AND u.role IN ('engineer','manager') AND t.team = $2", [x.owner_id, x.team]) : null;
  if (!owner) throw bad("เลือกผู้รับผิดชอบ PM จากสมาชิกทีมที่เลือก");
  const r = await one(
    `INSERT INTO pm_schedules (title, site, product, team, owner_id, every_months, next_date, checklist, note, created_by, project_id, sla_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [x.title, x.site, x.product, x.team, owner.id, x.every_months, x.next_date, x.checklist, x.note || `สร้างตอนส่งมอบโปรเจกต์ ${clean(b.project_name, 200)}`, user.id, Number(b.project_id) || null, x.sla_days]
  );
  await audit(user, "pm_create", x.title, { id: r.id, site: x.site, every: x.every_months, next: x.next_date, project: Number(b.project_id) || null });
  const mgrs = (await all("SELECT DISTINCT u.email FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = $1 AND u.email IS NOT NULL", [x.team])).map((m) => m.email);
  const { esc, shell, fieldTable, button } = require("../emails");
  const { config3 } = require("./config3");
  require("../graph")
    .sendMail({
      to: [owner.email].filter(Boolean), cc: mgrs.filter((e) => e !== owner.email),
      subject: `[งาน PM ใหม่] ${x.site} · ${x.title}`,
      html: shell("#1F5FBF", `<p style="margin:0 0 12px">${esc(user.display_name)} ส่งมอบโปรเจกต์ <strong>${esc(clean(b.project_name, 200))}</strong> และตั้งตาราง PM ของลูกค้าให้ทีมคุณ ระบบจะเปิดเคส PM ตามรอบ</p>${fieldTable([["ลูกค้า", x.site], ["งาน PM", x.title], ["ผู้รับผิดชอบ", owner.display_name], ["รอบ", `ทุก ${x.every_months} เดือน`], ["รอบแรก", d.thaiDate(x.next_date)]])}<p style="margin:16px 0 0">${button(`${config3.baseUrl}/#/pm`, "เปิดงาน PM")}</p>`),
    })
    .catch((e) => console.error("[pm] project mail:", e.message));
  return r.id;
}

/** Opens the case for one round and moves the schedule to the next round. */
async function openRound(p, { by = null, startDate } = {}) {
  const repo = require("./caserepo");
  let owner = p.owner_id && (await one("SELECT id, display_name, email FROM users WHERE id = $1 AND active", [p.owner_id]));
  if (!owner) owner = await one("SELECT u.id, u.display_name, u.email FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = $1 ORDER BY u.id LIMIT 1", [p.team]);
  const start = startDate || d.toISODate(d.today());
  const r = await repo.createCase(
    by,
    {
      team: p.team, site: p.site, product: p.product, severity: "Low", status: "In Progress",
      task: `[PM] ${p.title}`,
      note: `งาน PM ตามรอบ ทุก ${p.every_months} เดือน${p.note ? `\n${p.note}` : ""}`,
      detail: `เปิดอัตโนมัติจากงาน PM "${p.title}" (รอบวันที่ ${d.thaiDate(d.fromISODate(start))})\nChecklist:\n${p.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    },
    { ownerId: owner ? owner.id : null, startDate: start, slaDays: p.sla_days || DEFAULT_SLA }
  );
  await tx(async (c) => {
    await c.query("UPDATE cases SET pm_schedule_id = $2 WHERE id = $1", [r.id, p.id]);
    for (const [i, item] of p.checklist.entries()) await c.query("INSERT INTO case_checklist (case_id, seq, item) VALUES ($1,$2,$3)", [r.id, i + 1, item]);
    await c.query("UPDATE pm_schedules SET next_date = $2, last_case_id = $3, updated_at = now() WHERE id = $1", [p.id, addMonths(p.next_date instanceof Date ? d.toISODate(p.next_date) : String(p.next_date).slice(0, 10), p.every_months), r.id]);
  });
  const kase = await repo.getCase(r.id);
  await audit(by, "pm_open", `${kase.caseNo} · ${p.site}`, { pm: p.id, case_id: r.id });
  if (owner && owner.email) {
    const { shell, fieldTable, button } = require("../emails");
    await require("../graph")
      .sendMail({
        to: [owner.email], cc: [],
        subject: `[งาน PM] ${p.site} · ${p.title} · ${kase.caseNo}`,
        html: shell("#1F5FBF", `<p style="margin:0 0 12px">ระบบเปิดเคสงาน PM ตามรอบให้คุณแล้ว SLA ${kase.slaDays} วัน (ครบกำหนด ${d.thaiDate(kase.dueDate)}) ปิดเคสได้เมื่อติ๊ก checklist ครบ${p.ma_file_name ? ` และอัปโหลดแบบฟอร์ม MA (${p.ma_file_name}) ที่กรอกแล้ว ดาวน์โหลดแบบฟอร์มได้ในหน้าเคส` : ""}</p>
${fieldTable([["เคส", kase.caseNo], ["ลูกค้า", p.site], ["งาน", p.title], ["Checklist", p.checklist.map((c, i) => `${i + 1}. ${c}`).join("<br>")]])}
<p style="margin:16px 0 0">${button(kase.caseUrl, "เปิดเคส")}</p>`),
      })
      .catch((e) => console.error("[pm] mail:", e.message));
    require("./push").send([owner.id], { title: `งาน PM: ${p.site}`, body: `${kase.caseNo} · ${p.title}`, url: `/#/case/${r.id}`, tag: `case-${r.id}` }).catch(() => {});
  }
  return kase;
}

/** Daily job: open every round that is due. */
async function runDue() {
  const due = await all("SELECT * FROM pm_schedules WHERE active AND next_date <= current_date ORDER BY next_date, id");
  const out = { opened: 0, failed: 0 };
  for (const p of due) {
    try {
      // Catch up on a missed round only once (the server was off): start the case today.
      await openRound(p);
      out.opened++;
      // If several rounds were missed, skip ahead to the next future date.
      let s = await one("SELECT * FROM pm_schedules WHERE id = $1", [p.id]);
      let guard = 0;
      while (s && d.toISODate(s.next_date instanceof Date ? s.next_date : d.fromISODate(String(s.next_date))) <= d.toISODate(d.today()) && guard++ < 40) {
        await q("UPDATE pm_schedules SET next_date = $2 WHERE id = $1", [p.id, addMonths(d.toISODate(s.next_date instanceof Date ? s.next_date : d.fromISODate(String(s.next_date))), p.every_months)]);
        s = await one("SELECT * FROM pm_schedules WHERE id = $1", [p.id]);
      }
    } catch (e) {
      console.error("[pm]", p.id, e.message);
      out.failed++;
    }
  }
  return out;
}

// ------------------------------------------------------------ checklist on the case
const checklistFor = (caseId) =>
  all(`SELECT k.seq, k.item, k.done, k.note, k.done_at, u.display_name AS done_by FROM case_checklist k LEFT JOIN users u ON u.id = k.done_by WHERE k.case_id = $1 ORDER BY k.seq`, [caseId]);

/** Throws when a case with an unfinished checklist is being closed (Cancel / N/A are allowed). */
async function checkClose(caseId, status) {
  if (["cancel", "n/a"].includes(String(status || "").trim().toLowerCase())) return;
  const r = await one("SELECT count(*) FILTER (WHERE NOT done)::int AS left, count(*)::int AS total FROM case_checklist WHERE case_id = $1", [caseId]);
  if (r && r.left) throw bad(`ติ๊ก checklist ให้ครบก่อนปิดเคส (เหลือ ${r.left} จาก ${r.total} ข้อ) หรือปิดเป็น Cancel / N/A ถ้าไม่ได้ทำรอบนี้`);
  const ma = await maFor(caseId);
  if (ma && !ma.filled) throw bad(`อัปโหลดแบบฟอร์ม MA ที่กรอกแล้ว (${ma.fileName}) ในการ์ด Checklist งาน PM ก่อนปิดเคส หรือปิดเป็น Cancel / N/A ถ้าไม่ได้ทำรอบนี้`);
}

function mount(api, { wrap, loadVisible }) {
  api.get("/pm", wrap(async (req, res) => {
    res.json({ items: await list(req.user), canManage: await canManage(req.user), defaultSla: DEFAULT_SLA });
  }));
  api.post("/pm", wrap(async (req, res) => res.json({ ok: true, id: await save(req.user, null, req.body || {}) })));
  api.put("/pm/:id(\\d+)", wrap(async (req, res) => res.json({ ok: true, id: await save(req.user, Number(req.params.id), req.body || {}) })));
  api.post("/pm/:id(\\d+)/open-now", wrap(async (req, res) => {
    if (!(await canManage(req.user))) throw bad("ไม่มีสิทธิ์ตั้งหรือแก้งาน PM", 403);
    const p = await one("SELECT * FROM pm_schedules WHERE id = $1", [Number(req.params.id)]);
    if (!p) throw bad("ไม่พบงาน PM", 404);
    const scope = perms.teamScope(req.user);
    if (scope && !scope.includes(p.team)) throw bad("เฉพาะงาน PM ของทีมคุณ", 403);
    const k = await openRound(p, { by: req.user });
    res.json({ ok: true, caseId: k.id, caseNo: k.caseNo });
  }));
  api.post("/pm/:id(\\d+)/ma-form", wrap(async (req, res) => res.json(await setMaForm(req.user, Number(req.params.id), req.body || {}))));
  api.delete("/pm/:id(\\d+)/ma-form", wrap(async (req, res) => res.json(await clearMaForm(req.user, Number(req.params.id)))));
  api.get("/pm/:id(\\d+)/ma-form", wrap(async (req, res) => sendMaForm(res, await scheduleFor(req.user, Number(req.params.id)))));
  // The blank MA form from the case page (anyone who can see the case).
  api.get("/case/:id(\\d+)/ma-form", wrap(async (req, res) => {
    const c = await loadVisible(req);
    sendMaForm(res, await scheduleOfCase(c.id));
  }));
  api.put("/case/:id/checklist/:seq(\\d+)", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!(await perms.can(req.user, "case_edit", c))) throw bad("ไม่มีสิทธิ์แก้เคสนี้", 403);
    if (c.stage === "closed") throw bad("เคสปิดแล้ว");
    const seq = Number(req.params.seq);
    const done = !!(req.body && req.body.done);
    const note = clean(req.body && req.body.note, 500) || null;
    const row = await one(
      `UPDATE case_checklist SET done = $3, note = $4, done_by = CASE WHEN $3 THEN $5::int ELSE NULL END, done_at = CASE WHEN $3 THEN now() ELSE NULL END
       WHERE case_id = $1 AND seq = $2 RETURNING item`,
      [c.id, seq, done, note, req.user.id]
    );
    if (!row) throw bad("ไม่พบรายการ", 404);
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, current_date, 'Checklist', $2, true, $3)", [
      c.id, `${done ? "✓ ทำแล้ว" : "↺ ยกเลิกติ๊ก"}: ${seq}. ${row.item}${note ? ` (${note})` : ""}`, req.user.id,
    ]);
    res.json({ ok: true, checklist: await checklistFor(c.id) });
  }));
}

module.exports = { mount, runDue, openRound, checklistFor, checkClose, addMonths, list, maFor, createFromProject };
