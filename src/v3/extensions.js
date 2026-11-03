// Case extensions: an owner asks a manager (chosen by name) for 7 more days with a reason.
// Approved -> Due + SLA days, cases.ext_count + 1, alert rounds start again for the new period.
// Every request, approval, rejection and cancellation is kept (case activities, case_changes, audit log).
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const d = require("../dates");
const { q, one, all, tx, audit } = require("./db");
const repo = require("./caserepo");
const perms = require("./perms");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (s, max = 2000) => String(s ?? "").trim().slice(0, max);
const th = (iso) => (iso ? d.thaiDate(d.fromISODate(String(iso).slice(0, 10))) : "-");

const EXT_SELECT = `SELECT e.*, rq.display_name AS requested_by_name, ap.display_name AS approver_name, ap.email AS approver_email,
    c.case_no, c.cs_number, c.site, c.task, c.owner_id, ow.display_name AS owner_name, ow.email AS owner_email
  FROM case_extensions e JOIN cases c ON c.id = e.case_id
  LEFT JOIN users rq ON rq.id = e.requested_by LEFT JOIN users ap ON ap.id = e.approver_id LEFT JOIN users ow ON ow.id = c.owner_id`;

async function approvers() {
  return all("SELECT id, display_name, email, role FROM users WHERE active AND role IN ('manager','admin') ORDER BY role = 'admin', display_name");
}
const forCase = (caseId) => all(`${EXT_SELECT} WHERE e.case_id = $1 ORDER BY e.seq, e.id`, [caseId]);
const forCases = (ids) => (ids.length ? all(`${EXT_SELECT} WHERE e.case_id = ANY($1) ORDER BY e.requested_at DESC`, [ids]) : []);

async function request(user, kase, b) {
  if (kase.stage === "closed") throw bad("เคสนี้ปิดแล้ว ขอขยายเวลาไม่ได้");
  const isOwner = kase.owner_id === user.id;
  if (!isOwner && (await perms.level(user, "case_edit")) !== "all") throw bad("เฉพาะ Owner ของเคสขอขยายเวลาได้", 403);
  const reason = clean(b.reason);
  if (reason.length < 5) throw bad("กรุณาระบุเหตุผลที่ต้องขยาย (อย่างน้อย 5 ตัวอักษร)");
  const approver = (await approvers()).find((u) => u.id === Number(b.approverId));
  if (!approver) throw bad("กรุณาเลือก Manager ที่จะอนุมัติ");
  if (approver.id === user.id && user.role !== "admin") throw bad("อนุมัติคำขอของตัวเองไม่ได้ เลือก Manager คนอื่น");
  const oldDue = d.toISODate(kase.dueDate);
  const newDue = d.toISODate(d.addDays(kase.dueDate, config.slaDays));
  const ext = await tx(async (c) => {
    const seq = (await c.query("SELECT count(*)::int AS n FROM case_extensions WHERE case_id = $1 AND status <> 'cancelled'", [kase.id])).rows[0].n + 1;
    const r = await c.query(
      `INSERT INTO case_extensions (case_id, seq, reason, requested_by, approver_id, old_due, new_due, days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [kase.id, seq, reason, user.id, approver.id, oldDue, newDue, config.slaDays]
    ).catch((e) => {
      if (e.code === "23505") throw bad("เคสนี้มีคำขอขยายเวลาที่รออนุมัติอยู่แล้ว");
      throw e;
    });
    await c.query("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,true,$5)", [
      kase.id, d.toISODate(d.today()), "ขอขยายเวลา", `คำขอขยายครั้งที่ ${seq} (${config.slaDays} วัน) Due ${th(oldDue)} → ${th(newDue)} ส่งให้ ${approver.display_name} อนุมัติ เหตุผล: ${reason}`, user.id,
    ]);
    return { id: r.rows[0].id, seq };
  });
  await audit(user, "case_ext_request", `${kase.caseNo} · ${kase.site || ""}`, { case_id: kase.id, seq: ext.seq, approver: approver.display_name, reason });
  const row = await one(`${EXT_SELECT} WHERE e.id = $1`, [ext.id]);
  mailRequest(row, kase).catch((e) => console.error("[ext] mail:", e.message));
  return { ok: true, id: ext.id, seq: ext.seq, newDue };
}

async function decide(user, id, b) {
  const e = await one(`${EXT_SELECT} WHERE e.id = $1`, [id]);
  if (!e) throw bad("ไม่พบคำขอนี้", 404);
  if (e.status !== "pending") throw bad("คำขอนี้พิจารณาไปแล้ว", 409);
  if (e.approver_id !== user.id && user.role !== "admin") throw bad(`คำขอนี้ส่งให้ ${e.approver_name} อนุมัติ`, 403);
  const approve = !!b.approve;
  const note = clean(b.note, 1000);
  if (!approve && note.length < 3) throw bad("กรุณาใส่ความเห็นเมื่อไม่อนุมัติ");
  const kase = await repo.getCase(e.case_id);
  await tx(async (c) => {
    const upd = await c.query("UPDATE case_extensions SET status = $2, decided_at = now(), decision_note = $3, approver_id = $4 WHERE id = $1 AND status = 'pending'", [
      id, approve ? "approved" : "rejected", note || null, user.id,
    ]);
    if (!upd.rowCount) throw bad("คำขอนี้พิจารณาไปแล้ว", 409);
    let newDue = e.new_due;
    if (approve) {
      // Extend from the Due the case has now (in case it changed since the request).
      const cur = (await c.query("SELECT due_date FROM cases WHERE id = $1 FOR UPDATE", [e.case_id])).rows[0];
      newDue = d.toISODate(d.addDays(d.fromISODate(cur.due_date), e.days));
      await c.query("UPDATE case_extensions SET old_due = $2, new_due = $3 WHERE id = $1", [id, cur.due_date, newDue]);
      await c.query("UPDATE cases SET due_date = $2, ext_count = ext_count + 1, updated_at = now() WHERE id = $1", [e.case_id, newDue]);
      await c.query(
        `INSERT INTO case_changes (case_id, cs_number, team, site, owner_name, owner_email, field, old_value, new_value, direction, reason, changed_by, changed_by_name, case_no)
         VALUES ($1,$2,$3,$4,$5,$6,'extension',$7,$8,'later',$9,$10,$11,$12)`,
        [kase.id, kase.csNumber || null, kase.team, kase.site, kase.owner, kase.ownerEmail, cur.due_date, newDue, `คำขอครั้งที่ ${e.seq}: ${e.reason}`, user.id, user.display_name, kase.caseNo]
      );
    }
    await c.query("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,true,$5)", [
      e.case_id, d.toISODate(d.today()), approve ? "อนุมัติขยายเวลา" : "ไม่อนุมัติขยายเวลา",
      approve ? `${user.display_name} อนุมัติคำขอขยายครั้งที่ ${e.seq} Due ใหม่ ${th(newDue)}${note ? ` ความเห็น: ${note}` : ""}` : `${user.display_name} ไม่อนุมัติคำขอขยายเวลา ความเห็น: ${note}`, user.id,
    ]);
  });
  await audit(user, approve ? "case_ext_approve" : "case_ext_reject", `${kase.caseNo} · ${kase.site || ""}`, { case_id: kase.id, seq: e.seq, note });
  const row = await one(`${EXT_SELECT} WHERE e.id = $1`, [id]);
  mailDecision(row, user).catch((err) => console.error("[ext] mail:", err.message));
  return { ok: true, status: row.status, newDue: row.new_due };
}

async function cancel(user, id) {
  const e = await one(`${EXT_SELECT} WHERE e.id = $1`, [id]);
  if (!e || e.status !== "pending") throw bad("ไม่มีคำขอที่รออนุมัติ", 409);
  if (e.requested_by !== user.id && user.role !== "admin") throw bad("ยกเลิกได้เฉพาะผู้ขอ", 403);
  await q("UPDATE case_extensions SET status = 'cancelled', decided_at = now() WHERE id = $1", [id]);
  await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,'ยกเลิกคำขอขยาย',$3,true,$4)", [
    e.case_id, d.toISODate(d.today()), `ยกเลิกคำขอขยายครั้งที่ ${e.seq}`, user.id,
  ]);
  await audit(user, "case_ext_cancel", e.case_no, { case_id: e.case_id, seq: e.seq });
  return { ok: true };
}

// ------------------------------------------------------------ emails
async function mailRequest(e, kase) {
  if (!e.approver_email) return;
  await graph.sendMail({
    to: [e.approver_email],
    cc: [e.owner_email].filter((x) => x && x !== e.approver_email),
    subject: `[ขออนุมัติขยายเวลา] ${e.case_no} · ${e.site || "-"} · คำขอครั้งที่ ${e.seq} (${e.days} วัน)`,
    html: shell(
      "#B07800",
      `<p style="margin:0 0 12px">เรียน ${esc(e.approver_name)}</p>
<p style="margin:0 0 14px">${esc(e.requested_by_name)} ขอขยายเวลาเคส <strong>${esc(e.case_no)}</strong> อีก ${e.days} วัน จาก Due <strong>${esc(th(e.old_due))}</strong> เป็น <strong>${esc(th(e.new_due))}</strong></p>
${fieldTable([["เลขเคส", `${e.case_no}${e.cs_number ? ` / ${e.cs_number}` : ""}`], ["ลูกค้า", e.site || "-"], ["งาน", e.task || "-"], ["Owner", e.owner_name || "-"], ["เปิดเคสมาแล้ว", `${kase.totalAge ?? kase.age ?? "-"} วัน`], ["ขยายไปแล้ว", `${kase.extCount || 0} ครั้ง`]])}
<p style="margin:14px 0;background:#F6F7F9;padding:12px 14px;border-radius:8px;white-space:pre-wrap"><strong>เหตุผล:</strong> ${esc(e.reason)}</p>
${button(`${config3.baseUrl}/#/case/${e.case_id}`, "เปิดเพื่ออนุมัติ")}`
    ),
  });
}
async function mailDecision(e, by) {
  const to = [e.owner_email].filter(Boolean);
  if (!to.length) return;
  const ok = e.status === "approved";
  await graph.sendMail({
    to,
    cc: [],
    subject: `[${ok ? "อนุมัติ" : "ไม่อนุมัติ"}ขยายเวลา] ${e.case_no} · ${e.site || "-"}${ok ? ` · Due ใหม่ ${th(e.new_due)}` : ""}`,
    html: shell(
      ok ? "#1C6B45" : "#9A1B30",
      `<p style="margin:0 0 12px">เรียน ${esc(e.owner_name || "Owner")}</p>
<p style="margin:0 0 14px">${esc(by.display_name)} ${ok ? `<strong>อนุมัติ</strong>ขยายเวลาเคส ${esc(e.case_no)} (คำขอครั้งที่ ${e.seq}) Due ใหม่ <strong>${esc(th(e.new_due))}</strong> ระบบเริ่มนับรอบแจ้งเตือนใหม่ (วันที่ ${config.alert1Day}, วันที่ ${config.alert2Day} และเมื่อเกิน Due)` : `<strong>ไม่อนุมัติ</strong>คำขอขยายเวลาเคส ${esc(e.case_no)} Due ยังเป็น ${esc(th(e.old_due))}`}</p>
${e.decision_note ? `<p style="margin:0 0 14px;background:#F6F7F9;padding:12px 14px;border-radius:8px"><strong>ความเห็น:</strong> ${esc(e.decision_note)}</p>` : ""}
${button(`${config3.baseUrl}/#/case/${e.case_id}`, "เปิดเคส")}`
    ),
  });
}

// ------------------------------------------------------------ reports
/** Adds extension counts to rep.owners and rep.extensions (requests made in the report range). */
async function augmentReport(rep, { caseIds } = {}) {
  const end = d.addDays(rep.to, 1);
  const p = [rep.from.toISOString(), end.toISOString()];
  let where = "e.requested_at >= $1 AND e.requested_at < $2 AND e.status <> 'cancelled'";
  if (caseIds) {
    p.push(caseIds);
    where += ` AND e.case_id = ANY($${p.length})`;
  }
  const rows = await all(`${EXT_SELECT} WHERE ${where} ORDER BY ow.display_name, e.requested_at`, p);
  rep.extensions = rows;
  const ownerKey = (r) => String(r.owner_email || r.owner_name || "").toLowerCase();
  const byOwner = new Map();
  rows.forEach((r) => {
    const k = ownerKey(r);
    const o = byOwner.get(k) || { cases: new Set(), count: 0, approved: 0, rejected: 0, pending: 0 };
    o.cases.add(r.case_id);
    o.count++;
    o[r.status]++;
    byOwner.set(k, o);
  });
  rep.owners.forEach((o) => {
    const x = byOwner.get(String(o.email || o.owner || "").toLowerCase()) || byOwner.get(String(o.id || "").toLowerCase());
    o.extCases = x ? x.cases.size : 0;
    o.extCount = x ? x.count : 0;
    o.extApproved = x ? x.approved : 0;
    o.extRejected = x ? x.rejected : 0;
    o.extPending = x ? x.pending : 0;
  });
  rep.kpis.extCount = rows.length;
  rep.kpis.extCases = new Set(rows.map((r) => r.case_id)).size;
  return rep;
}

const STATUS_TH = { pending: "รออนุมัติ", approved: "อนุมัติ", rejected: "ไม่อนุมัติ", cancelled: "ยกเลิก" };
function addSheet(wb, rep) {
  if (!rep.extensions) return;
  const ws = wb.addWorksheet("การขยายเวลา", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Owner", key: "owner", width: 22 },
    { header: "เลขเคส", key: "case_no", width: 16 },
    { header: "CS Number", key: "cs", width: 14 },
    { header: "ลูกค้า", key: "site", width: 16 },
    { header: "คำขอครั้งที่", key: "seq", width: 11 },
    { header: "ขอเมื่อ", key: "at", width: 17 },
    { header: "ผู้ขอ", key: "by", width: 20 },
    { header: "เหตุผล", key: "reason", width: 50 },
    { header: "Due เดิม", key: "old", width: 12 },
    { header: "Due ใหม่", key: "new", width: 12 },
    { header: "ผล", key: "status", width: 12 },
    { header: "ผู้พิจารณา", key: "approver", width: 20 },
    { header: "ความเห็น", key: "note", width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  rep.extensions.forEach((e) =>
    ws.addRow({
      owner: e.owner_name, case_no: e.case_no, cs: e.cs_number, site: e.site, seq: e.seq,
      at: new Date(e.requested_at).toLocaleString("sv-SE", { timeZone: config.tz }).slice(0, 16), by: e.requested_by_name, reason: e.reason,
      old: e.old_due, new: e.status === "approved" || e.status === "pending" ? e.new_due : "", status: STATUS_TH[e.status], approver: e.approver_name, note: e.decision_note,
    })
  );
  ws.getColumn("reason").alignment = { wrapText: true, vertical: "top" };
  ws.getColumn("note").alignment = { wrapText: true, vertical: "top" };
}

// ------------------------------------------------------------ routes (mounted on the v3 api router)
function mount(api, { wrap }) {
  api.get("/extensions/approvers", wrap(async (req, res) => res.json({ approvers: await approvers() })));
  api.get("/extensions/pending", wrap(async (req, res) => {
    const rows = await all(`${EXT_SELECT} WHERE e.status = 'pending' AND (e.approver_id = $1 OR e.requested_by = $1) ORDER BY e.requested_at`, [req.user.id]);
    res.json({ forMe: rows.filter((r) => r.approver_id === req.user.id), mine: rows.filter((r) => r.requested_by === req.user.id) });
  }));
  api.get("/case/:id(\\d+)/extensions", wrap(async (req, res) => {
    const c = await repo.getCase(Number(req.params.id));
    if (!c || !repo.canSee(req.user, c)) throw bad("ไม่พบเคสนี้", 404);
    res.json({ extensions: await forCase(c.id) });
  }));
  api.post("/case/:id(\\d+)/extensions", wrap(async (req, res) => {
    const c = await repo.getCase(Number(req.params.id));
    if (!c || !repo.canSee(req.user, c)) throw bad("ไม่พบเคสนี้", 404);
    res.json(await request(req.user, c, req.body || {}));
  }));
  api.post("/extensions/:id(\\d+)/decide", wrap(async (req, res) => res.json(await decide(req.user, Number(req.params.id), req.body || {}))));
  api.post("/extensions/:id(\\d+)/cancel", wrap(async (req, res) => res.json(await cancel(req.user, Number(req.params.id)))));
}

module.exports = { mount, forCase, forCases, approvers, request, decide, cancel, augmentReport, addSheet, STATUS_TH };
