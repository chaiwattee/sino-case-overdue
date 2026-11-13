// Cross-team case transfer. The managers of both teams confirm:
//   1. The case owner (or a manager of the current team) asks to move the case to another team, with a reason.
//   2. A manager of the current team approves (skipped when the person asking is that manager or an admin).
//   3. A manager of the new team accepts and picks who takes the case, or rejects it with a reason.
// Accepted -> the old case is closed with status "Transferred" on that day. Its SLA is judged on the old Due as usual,
// so a case moved before its Due counts as closed on time for the old team and one already past Due stays late
// (moving a case cannot clear an overdue one). A new case linked to the old one is opened for the new team and its
// 7-day SLA starts on the acceptance day. The customer's request, files and email thread move to the new case, the
// customer is told who the new engineer is by email (LINE customers too; nothing is sent to the LINE OA chatbot), and
// the satisfaction survey goes out only when the new case closes.
// While a request waits, the case stays with the old team and its SLA keeps running.
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const d = require("../dates");
const { q, one, all, tx, audit } = require("./db");
const repo = require("./caserepo");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (s, max = 2000) => String(s ?? "").trim().slice(0, max);
const th = (iso) => (iso ? d.thaiDate(d.fromISODate(String(iso).slice(0, 10))) : "-");
const caseUrl = (id) => `${config3.baseUrl}/#/case/${id}`;
const OPEN = ["source", "target"];
const STATUS_TH = { source: "รอ Manager ทีมเดิมอนุมัติ", target: "รอ Manager ทีมใหม่รับเคส", accepted: "โอนสำเร็จ", rejected: "ไม่อนุมัติ", cancelled: "ยกเลิก" };

const SEL = `SELECT t.*, c.case_no, c.cs_number, c.site, c.task, c.severity, c.owner_id, c.due_date, c.start_date,
    ow.display_name AS owner_name, ow.email AS owner_email,
    rq.display_name AS requested_by_name, rq.email AS requested_by_email,
    sb.display_name AS source_by_name, tb.display_name AS target_by_name, db.display_name AS decided_by_name,
    no.display_name AS new_owner_name, nc.case_no AS new_case_no, ft.label AS from_label, tt.label AS to_label
  FROM case_transfers t JOIN cases c ON c.id = t.case_id
  JOIN teams ft ON ft.code = t.from_team JOIN teams tt ON tt.code = t.to_team
  LEFT JOIN users ow ON ow.id = c.owner_id LEFT JOIN users rq ON rq.id = t.requested_by
  LEFT JOIN users sb ON sb.id = t.source_by LEFT JOIN users tb ON tb.id = t.target_by LEFT JOIN users db ON db.id = t.decided_by
  LEFT JOIN users no ON no.id = t.new_owner_id LEFT JOIN cases nc ON nc.id = t.new_case_id`;
const getRow = (id) => one(`${SEL} WHERE t.id = $1`, [id]);

/** Admins, and managers who belong to `team`. */
const manages = (user, team) => !!user && (user.role === "admin" || (user.role === "manager" && (user.teams || []).includes(team)));
/** Who has to act on a request in this state: the team's managers, or the admins when the team has none. */
async function deciders(team) {
  const m = await all("SELECT DISTINCT u.id, u.display_name, u.email FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = $1", [team]);
  return m.length ? m : all("SELECT id, display_name, email FROM users WHERE active AND role = 'admin'");
}
/** People in `team` who can own a case. */
const candidates = (team) =>
  all(
    `SELECT u.id, u.display_name, u.role FROM users u JOIN user_teams t ON t.user_id = u.id
     WHERE u.active AND t.team = $1 AND u.role IN ('engineer','manager') ORDER BY u.display_name`,
    [team]
  );
const teamOf = (code) => one("SELECT code, label FROM teams WHERE code = $1", [code]);

function canAct(user, t) {
  if (t.status === "source") return manages(user, t.from_team);
  if (t.status === "target") return manages(user, t.to_team);
  return false;
}
const canCancel = (user, t) => OPEN.includes(t.status) && (t.requested_by === user.id || manages(user, t.from_team));
const canRequest = (user, c) => c.stage !== "closed" && (c.owner_id === user.id || manages(user, c.team));

function view(user, t) {
  return {
    id: t.id, caseId: t.case_id, caseNo: t.case_no, site: t.site, task: t.task, severity: t.severity, ownerName: t.owner_name,
    fromTeam: t.from_team, fromLabel: t.from_label, toTeam: t.to_team, toLabel: t.to_label, reason: t.reason,
    status: t.status, statusLabel: STATUS_TH[t.status], requestedBy: t.requested_by_name, requestedById: t.requested_by, requestedAt: t.requested_at,
    sourceBy: t.source_by_name, sourceAt: t.source_at, targetBy: t.target_by_name, targetAt: t.target_at,
    decidedBy: t.decided_by_name, decisionNote: t.decision_note, newOwner: t.new_owner_name, newCaseId: t.new_case_id, newCaseNo: t.new_case_no,
    dueDate: t.due_date ? d.toISODate(t.due_date instanceof Date ? t.due_date : d.fromISODate(String(t.due_date).slice(0, 10))) : null,
    can: { act: canAct(user, t), cancel: canCancel(user, t) },
  };
}

/** Everything the case page needs: open request, history, links to the case it came from / went to. */
async function forCaseView(user, c) {
  const rows = await all(`${SEL} WHERE t.case_id = $1 OR t.new_case_id = $1 ORDER BY t.requested_at DESC`, [c.id]);
  const mine = rows.filter((r) => r.case_id === c.id);
  const pending = mine.find((r) => OPEN.includes(r.status)) || null;
  const link = async (id) => (id ? one("SELECT c.id, c.case_no AS \"caseNo\", c.team, t.label AS \"teamLabel\" FROM cases c JOIN teams t ON t.code = c.team WHERE c.id = $1", [id]) : null);
  const out = {
    pending: pending ? view(user, pending) : null,
    history: rows.filter((r) => !OPEN.includes(r.status)).map((r) => view(user, r)),
    from: await link(c.transferredFrom),
    to: await link(c.transferredTo),
    canRequest: !pending && canRequest(user, c),
  };
  if (pending && pending.status === "target" && manages(user, pending.to_team)) out.pending.owners = await candidates(pending.to_team);
  return out;
}

/** True when `user` manages the team an open transfer of this case is waiting on (lets them open the case to decide). */
async function awaitsMe(user, caseId) {
  const t = await one("SELECT status, from_team, to_team FROM case_transfers WHERE case_id = $1 AND status = 'target'", [caseId]);
  return !!t && manages(user, t.to_team);
}

// ------------------------------------------------------------ actions
async function request(user, kase, b) {
  if (kase.stage === "closed") throw bad("เคสนี้ปิดแล้ว โอนไม่ได้");
  if (!canRequest(user, kase)) throw bad("ขอโอนได้เฉพาะ User ของเคส หรือ Manager ของทีมนี้", 403);
  const to = await teamOf(clean(b.toTeam, 40));
  if (!to) throw bad("กรุณาเลือกทีมที่จะโอนไป");
  if (to.code === kase.team) throw bad("เลือกทีมอื่นที่ไม่ใช่ทีมปัจจุบัน");
  const reason = clean(b.reason, 1000);
  if (reason.length < 10) throw bad("กรุณาระบุเหตุผลที่ต้องโอน (อย่างน้อย 10 ตัวอักษร) ให้ทีมใหม่เข้าใจงาน");
  const direct = manages(user, kase.team); // the current team's manager (or an admin) is asking: their approval is the request itself
  const id = await tx(async (c) => {
    const r = await c
      .query(
        `INSERT INTO case_transfers (case_id, from_team, to_team, reason, requested_by, status, source_by, source_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [kase.id, kase.team, to.code, reason, user.id, direct ? "target" : "source", direct ? user.id : null, direct ? new Date() : null]
      )
      .catch((e) => {
        if (e.code === "23505") throw bad("เคสนี้มีคำขอโอนที่รอดำเนินการอยู่แล้ว");
        throw e;
      });
    await repo.addActivity(c, kase.id, user, {
      kind: "ขอโอนข้ามทีม",
      detail: `ขอโอนไปทีม ${to.label}${direct ? " (Manager ทีมเดิมอนุมัติแล้ว รอทีมใหม่รับเคส)" : " รอ Manager ทีมเดิมอนุมัติ"}\nเหตุผล: ${reason}`,
      system: true,
    });
    return r.rows[0].id;
  });
  await audit(user, "case_transfer_request", `${kase.caseNo} · ${kase.site || ""}`, { case_id: kase.id, to: to.code, reason, direct });
  const t = await getRow(id);
  notifyStep(t, user).catch((e) => console.error("[transfer] notify:", e.message));
  return { ok: true, id, status: t.status };
}

async function load(id) {
  const t = await getRow(id);
  if (!t) throw bad("ไม่พบคำขอนี้", 404);
  return t;
}

/** Manager of the current team approves: the request goes on to the new team. */
async function approveSource(user, id, b) {
  const t = await load(id);
  if (t.status !== "source") throw bad("คำขอนี้ไม่ได้รอ Manager ทีมเดิมแล้ว", 409);
  if (!manages(user, t.from_team)) throw bad(`ต้องเป็น Manager ของทีม ${t.from_label}`, 403);
  const note = clean(b.note, 1000);
  await tx(async (c) => {
    const u = await c.query("UPDATE case_transfers SET status = 'target', source_by = $2, source_at = now() WHERE id = $1 AND status = 'source'", [id, user.id]);
    if (!u.rowCount) throw bad("คำขอนี้มีคนดำเนินการไปแล้ว", 409);
    await repo.addActivity(c, t.case_id, user, { kind: "อนุมัติโอนข้ามทีม", detail: `${user.display_name} (ทีมเดิม) อนุมัติให้โอนไปทีม ${t.to_label} รอ Manager ทีมใหม่รับเคส${note ? `\nความเห็น: ${note}` : ""}`, system: true });
  });
  await audit(user, "case_transfer_source_ok", t.case_no, { case_id: t.case_id, to: t.to_team });
  const row = await getRow(id);
  notifyStep(row, user).catch((e) => console.error("[transfer] notify:", e.message));
  return { ok: true, status: row.status };
}

async function reject(user, id, b) {
  const t = await load(id);
  if (!OPEN.includes(t.status)) throw bad("คำขอนี้ดำเนินการไปแล้ว", 409);
  if (!canAct(user, t)) throw bad(t.status === "source" ? `ต้องเป็น Manager ของทีม ${t.from_label}` : `ต้องเป็น Manager ของทีม ${t.to_label}`, 403);
  const note = clean(b.note, 1000);
  if (note.length < 3) throw bad("กรุณาใส่เหตุผลที่ไม่อนุมัติ");
  const side = t.status === "source" ? "ทีมเดิม" : "ทีมใหม่";
  await tx(async (c) => {
    const u = await c.query("UPDATE case_transfers SET status = 'rejected', decided_by = $2, decision_note = $3, target_at = CASE WHEN status = 'target' THEN now() ELSE target_at END WHERE id = $1 AND status = $4", [id, user.id, note, t.status]);
    if (!u.rowCount) throw bad("คำขอนี้มีคนดำเนินการไปแล้ว", 409);
    await repo.addActivity(c, t.case_id, user, { kind: "ไม่อนุมัติโอนข้ามทีม", detail: `${user.display_name} (${side}) ไม่อนุมัติการโอนไปทีม ${t.to_label} เคสยังอยู่กับทีม ${t.from_label}\nเหตุผล: ${note}`, system: true });
  });
  await audit(user, "case_transfer_reject", t.case_no, { case_id: t.case_id, to: t.to_team, side, note });
  const row = await getRow(id);
  notifyClosed(row, user).catch((e) => console.error("[transfer] notify:", e.message));
  return { ok: true, status: row.status };
}

async function cancel(user, id) {
  const t = await load(id);
  if (!canCancel(user, t)) throw bad(OPEN.includes(t.status) ? "ยกเลิกได้เฉพาะผู้ขอ หรือ Manager ของทีมเดิม" : "คำขอนี้ดำเนินการไปแล้ว", OPEN.includes(t.status) ? 403 : 409);
  await tx(async (c) => {
    const u = await c.query("UPDATE case_transfers SET status = 'cancelled', decided_by = $2 WHERE id = $1 AND status = ANY($3)", [id, user.id, OPEN]);
    if (!u.rowCount) throw bad("คำขอนี้ดำเนินการไปแล้ว", 409);
    await repo.addActivity(c, t.case_id, user, { kind: "ยกเลิกคำขอโอน", detail: `${user.display_name} ยกเลิกคำขอโอนไปทีม ${t.to_label}`, system: true });
  });
  await audit(user, "case_transfer_cancel", t.case_no, { case_id: t.case_id, to: t.to_team });
  const row = await getRow(id);
  if (t.status === "target") notifyClosed(row, user).catch((e) => console.error("[transfer] notify:", e.message));
  return { ok: true, status: row.status };
}

/** Manager of the new team accepts and picks the new owner: close the old case, open the linked one. */
async function accept(user, id, b) {
  const t = await load(id);
  if (t.status !== "target") throw bad(t.status === "source" ? "ยังรอ Manager ทีมเดิมอนุมัติ" : "คำขอนี้ดำเนินการไปแล้ว", 409);
  if (!manages(user, t.to_team)) throw bad(`ต้องเป็น Manager ของทีม ${t.to_label}`, 403);
  const owner = (await candidates(t.to_team)).find((u) => u.id === Number(b.ownerId));
  if (!owner) throw bad(`กรุณาเลือก User ในทีม ${t.to_label} ที่จะรับเคส`);
  const note = clean(b.note, 1000);
  const kase = await repo.getCase(t.case_id);
  if (!kase || kase.stage === "closed") throw bad("เคสนี้ปิดไปแล้ว ยกเลิกคำขอโอนแทน", 409);
  if (kase.team !== t.from_team) throw bad("ทีมของเคสเปลี่ยนไปแล้วหลังขอโอน ยกเลิกแล้วขอใหม่", 409);

  // Claim the request first so a second click (or a second manager) cannot open two cases.
  const claimed = await one("UPDATE case_transfers SET status = 'accepted', target_by = $2, target_at = now(), new_owner_id = $3, decision_note = $4 WHERE id = $1 AND status = 'target' RETURNING id", [id, user.id, owner.id, note || null]);
  if (!claimed) throw bad("คำขอนี้มีคนดำเนินการไปแล้ว", 409);
  let newId;
  try {
    // CS Number is unique per team: if the new team already has it (a case moved back and forth), keep it in the note.
    let cs = kase.csNumber || null;
    let csNote = "";
    if (cs && (await one("SELECT 1 FROM cases WHERE team = $1 AND upper(cs_number) = upper($2)", [t.to_team, cs]))) {
      csNote = `\nCS Number ${cs} (ทีมนี้มีเคสที่ใช้เลขนี้อยู่แล้ว)`;
      cs = null;
    }
    const acts = await repo.activities(kase.id);
    const last = acts.find((a) => !a.is_system);
    const detail = [
      `รับโอนจากทีม ${t.from_label} · เคสเดิม ${kase.caseNo} (เปิด ${th(t.start_date)})`,
      `ผู้ขอโอน: ${t.requested_by_name || "-"} · User เดิม: ${kase.owner || "-"}`,
      `เหตุผล: ${t.reason}`,
      last ? `บันทึกล่าสุดของทีมเดิม (${th(last.activity_date)}): ${last.detail}` : "",
      note ? `ความเห็นทีมใหม่: ${note}` : "",
    ].filter(Boolean).join("\n");
    const r = await repo.createCase(
      user,
      {
        team: t.to_team, site: kase.site, product: kase.product || null, severity: kase.severity, cs_number: cs, task: kase.task,
        note: [kase.note, `รับโอนจาก ${kase.caseNo}${csNote}`].filter(Boolean).join("\n"), detail, status: "In Progress",
        customer_unconfirmed: kase.customerUnconfirmed || undefined,
      },
      { ownerId: owner.id, slaDays: kase.slaDays }
    );
    newId = r.id;
  } catch (e) {
    await q("UPDATE case_transfers SET status = 'target', target_by = NULL, target_at = NULL, new_owner_id = NULL, decision_note = NULL WHERE id = $1", [id]);
    throw e;
  }
  const newCase = await repo.getCase(newId);
  const today = d.toISODate(d.today());
  await tx(async (c) => {
    // The new case carries what is needed to work and close it: RCA from NICE, PM checklist, difficulty set by a manager.
    await c.query(
      `UPDATE cases n SET transferred_from = o.id, complexity = o.complexity, complexity_by = o.complexity_by, pm_schedule_id = o.pm_schedule_id,
         rca_text = o.rca_text, rca_category = o.rca_category, rca_date = o.rca_date, rca_file = o.rca_file, rca_file_name = o.rca_file_name,
         rca_file_mime = o.rca_file_mime, rca_by = o.rca_by, rca_at = o.rca_at
       FROM cases o WHERE n.id = $1 AND o.id = $2`,
      [newId, kase.id]
    );
    await c.query("INSERT INTO case_checklist (case_id, seq, item, done, note, done_by, done_at) SELECT $1, seq, item, done, note, done_by, done_at FROM case_checklist WHERE case_id = $2 ON CONFLICT DO NOTHING", [newId, kase.id]);
    await c.query("UPDATE pm_schedules SET last_case_id = $1 WHERE last_case_id = $2", [newId, kase.id]);
    // The customer's request, its files and email thread follow the case.
    await c.query("UPDATE intakes SET case_id = $1, owner_id = $3 WHERE case_id = $2", [newId, kase.id, owner.id]);
    await c.query("UPDATE intake_emails SET case_id = $1 WHERE case_id = $2", [newId, kase.id]);
    await c.query("UPDATE case_extensions SET status = 'cancelled', decided_at = now(), decision_note = 'ยกเลิกอัตโนมัติ: โอนเคสไปทีมอื่น' WHERE case_id = $1 AND status = 'pending'", [kase.id]);
    const resolution = `โอนไปทีม ${t.to_label} เป็นเคส ${newCase.caseNo} (User: ${owner.display_name}) อนุมัติโดย ${t.source_by_name || "-"} (ทีมเดิม) และ ${user.display_name} (ทีมใหม่)\nเหตุผล: ${t.reason}`;
    await c.query(
      `UPDATE cases SET status = $2, end_date = $3, closed_at = now(), resolution = $4, root_cause = NULL, resolved_by = $5, resolved_at = now(),
         transferred_to = $6, updated_at = now() WHERE id = $1`,
      [kase.id, repo.TRANSFERRED, today, resolution, user.id, newId]
    );
    await repo.addActivity(c, kase.id, user, { kind: "โอนข้ามทีม", detail: `ปิดเคสด้วยการโอน → ${newCase.caseNo} ทีม ${t.to_label} (User: ${owner.display_name})${note ? `\nความเห็นทีมใหม่: ${note}` : ""}`, system: true });
    await repo.logChange(c, kase, user, "status", kase.status, repo.TRANSFERRED, `โอนไปทีม ${t.to_label} (${newCase.caseNo})`);
    await repo.logChange(c, newCase, user, "team", t.from_team, t.to_team, `รับโอนจาก ${kase.caseNo}`);
    await c.query("UPDATE case_transfers SET new_case_id = $2 WHERE id = $1", [id, newId]);
  });
  await audit(user, "case_transfer_accept", `${kase.caseNo} → ${newCase.caseNo}`, { case_id: kase.id, new_case_id: newId, to: t.to_team, owner: owner.display_name });
  const row = await getRow(id);
  notifyAccepted(row, user, newCase).catch((e) => console.error("[transfer] notify:", e.message));
  tellCustomer(newId, owner.id).catch((e) => console.error("[transfer] customer:", e.message));
  return { ok: true, status: "accepted", newCaseId: newId, newCaseNo: newCase.caseNo };
}

/** The customer hears who the new engineer is, the same way they heard when the case was first taken. */
async function tellCustomer(newCaseId, ownerId) {
  const i = await one("SELECT * FROM intakes WHERE case_id = $1 ORDER BY id LIMIT 1", [newCaseId]);
  if (!i || i.is_test) return;
  const owner = await one("SELECT id, display_name, email, phone FROM users WHERE id = $1", [ownerId]);
  const kase = await repo.getCase(newCaseId);
  await require("./intake").notifyCustomerOwner(i, kase, owner, { claimedAt: new Date(), transfer: true });
}

// ------------------------------------------------------------ notifications
const facts = (t) => [
  ["เลขเคส", `${t.case_no}${t.cs_number ? ` / ${t.cs_number}` : ""}`],
  ["ลูกค้า", t.site || "-"],
  ["งาน", t.task || "-"],
  ["Severity", t.severity || "-"],
  ["User ปัจจุบัน", t.owner_name || "-"],
  ["โอนจาก → ไป", `${t.from_label} → ${t.to_label}`],
  ["Due ของทีมเดิม", th(t.due_date)],
  ["ผู้ขอ", t.requested_by_name || "-"],
];
const box = (label, text) => `<p style="margin:14px 0;background:#F6F7F9;padding:12px 14px;border-radius:8px;white-space:pre-wrap"><strong>${label}:</strong> ${esc(text)}</p>`;
const uniq = (xs) => [...new Set(xs.filter(Boolean).map((x) => String(x).toLowerCase()))];

async function send(to, cc, subject, html) {
  const T = uniq(to);
  const C = uniq(cc).filter((x) => !T.includes(x));
  if (!T.length) return;
  await graph.sendMail({ to: T, cc: C, subject, html });
}

/** A request now waits for someone: tell that team's managers (email, phone, Teams channel). */
async function notifyStep(t, by) {
  const team = t.status === "source" ? t.from_team : t.to_team;
  const label = t.status === "source" ? t.from_label : t.to_label;
  const who = await deciders(team);
  const ask = t.status === "source" ? `อนุมัติให้โอนเคสออกจากทีม ${t.from_label} ไปทีม ${t.to_label}` : `รับเคสเข้าทีม ${t.to_label} และเลือก User ที่จะดูแล`;
  await send(
    who.map((u) => u.email),
    [t.requested_by_email, t.owner_email],
    `[ขอโอนเคสข้ามทีม] ${t.case_no} · ${t.site || "-"} · ${t.from_label} → ${t.to_label}`,
    shell(
      "#B07800",
      `<p style="margin:0 0 12px">เรียน Manager ทีม ${esc(label)}</p>
<p style="margin:0 0 14px">${esc(t.requested_by_name || "-")} ขอโอนเคส <strong>${esc(t.case_no)}</strong> ข้ามทีม รอคุณ<strong>${esc(ask)}</strong></p>
${fieldTable(facts(t))}${box("เหตุผล", t.reason)}
${t.status === "target" && t.source_by_name ? `<p style="margin:0 0 14px">Manager ทีมเดิมอนุมัติแล้ว: ${esc(t.source_by_name)}</p>` : ""}
<p style="margin:0 0 14px">ระหว่างรอ เคสยังอยู่กับทีม ${esc(t.from_label)} และ SLA ยังนับต่อ เมื่อรับแล้ว ระบบปิดเคสเดิมด้วยการโอน และเปิดเคสใหม่ให้ทีม ${esc(t.to_label)} โดย SLA เริ่มนับจากวันที่รับ</p>
${button(caseUrl(t.case_id), t.status === "source" ? "เปิดเพื่ออนุมัติ" : "เปิดเพื่อรับเคส")}`
    )
  );
  require("./push").send(who.map((u) => u.id).filter((x) => x !== by.id), { title: `ขอโอนเคสข้ามทีม · ${t.case_no}`, body: `${t.site || ""} · ${t.from_label} → ${t.to_label} (${t.status === "source" ? "รออนุมัติ" : "รอรับเคส"})`, url: `/#/case/${t.case_id}`, tag: `transfer-${t.id}` }).catch(() => {});
  await require("./teamsnotify").notify(team, "transfer", {
    title: `🔀 ขอโอนเคส ${t.case_no} · ${t.from_label} → ${t.to_label}`,
    color: "Warning",
    text: t.reason,
    facts: [["ลูกค้า", t.site || "-"], ["งาน", t.task || "-"], ["ผู้ขอ", t.requested_by_name || "-"], ["รอ", STATUS_TH[t.status]]],
    actions: [["เปิดเคส", caseUrl(t.case_id)]],
  });
}

/** Rejected, or cancelled after it reached the new team: tell the people who asked and the old team's managers. */
async function notifyClosed(t, by) {
  const src = await deciders(t.from_team);
  const verb = t.status === "rejected" ? "ไม่อนุมัติ" : "ยกเลิก";
  await send(
    [t.requested_by_email, t.owner_email],
    src.map((u) => u.email),
    `[${verb}โอนเคส] ${t.case_no} · ${t.site || "-"} · ${t.from_label} → ${t.to_label}`,
    shell(
      "#9A1B30",
      `<p style="margin:0 0 14px">${esc(by.display_name)} <strong>${verb}</strong>คำขอโอนเคส <strong>${esc(t.case_no)}</strong> ไปทีม ${esc(t.to_label)} เคสยังอยู่กับทีม ${esc(t.from_label)} และ SLA นับต่อตามเดิม</p>
${fieldTable(facts(t))}${t.decision_note ? box("เหตุผล", t.decision_note) : ""}${button(caseUrl(t.case_id), "เปิดเคส")}`
    )
  );
  require("./push").send([t.requested_by, t.owner_id].filter((x) => x && x !== by.id), { title: `${verb}โอนเคส · ${t.case_no}`, body: `${t.from_label} → ${t.to_label}${t.decision_note ? ` · ${t.decision_note}` : ""}`, url: `/#/case/${t.case_id}`, tag: `transfer-${t.id}` }).catch(() => {});
}

async function notifyAccepted(t, by, newCase) {
  const [src, dst] = await Promise.all([deciders(t.from_team), deciders(t.to_team)]);
  const owner = await one("SELECT id, display_name, email FROM users WHERE id = $1", [t.new_owner_id]);
  await send(
    [owner && owner.email, t.owner_email, t.requested_by_email],
    [...src, ...dst].map((u) => u.email),
    `[โอนเคสสำเร็จ] ${t.case_no} → ${newCase.caseNo} · ${t.site || "-"} · ทีม ${t.to_label}`,
    shell(
      "#1C6B45",
      `<p style="margin:0 0 14px">${esc(by.display_name)} รับเคส <strong>${esc(t.case_no)}</strong> เข้าทีม ${esc(t.to_label)} แล้ว เป็นเคสใหม่ <strong>${esc(newCase.caseNo)}</strong> ผู้ดูแลคือ <strong>${esc(owner ? owner.display_name : "-")}</strong></p>
${fieldTable([...facts(t), ["เคสใหม่", newCase.caseNo], ["Due ของเคสใหม่", th(d.toISODate(newCase.dueDate))]])}${box("เหตุผล", t.reason)}
<p style="margin:0 0 14px">เคสเดิมปิดด้วยสถานะ Transferred ในวันนี้ SLA ของทีม ${esc(t.from_label)} นับตาม Due เดิม (${esc(th(t.due_date))})</p>
${button(caseUrl(newCase.id), "เปิดเคสใหม่")}`
    )
  );
  if (owner && owner.id !== by.id) require("./push").send([owner.id], { title: `รับโอนเคสให้คุณ · ${newCase.caseNo}`, body: `${t.site || ""} · ${t.task || ""} (จากทีม ${t.from_label})`, url: `/#/case/${newCase.id}`, tag: `case-${newCase.id}` }).catch(() => {});
  require("./push").send([t.owner_id, t.requested_by].filter((x) => x && x !== by.id && x !== (owner && owner.id)), { title: `โอนเคสสำเร็จ · ${t.case_no}`, body: `→ ${newCase.caseNo} ทีม ${t.to_label}`, url: `/#/case/${newCase.id}` }).catch(() => {});
  await require("./teamsnotify").notify(t.to_team, "transfer", {
    title: `✅ รับโอนเคส ${t.case_no} → ${newCase.caseNo}`,
    color: "Good",
    facts: [["ลูกค้า", t.site || "-"], ["งาน", t.task || "-"], ["จากทีม", t.from_label], ["User", owner ? owner.display_name : "-"], ["Due", th(d.toISODate(newCase.dueDate))]],
    actions: [["เปิดเคส", caseUrl(newCase.id)]],
  });
}

/** Weekday mornings: requests that have waited more than a day get one reminder per day to the managers who must act. */
async function runReminders() {
  const rows = await all(
    `${SEL} WHERE t.status = ANY($1) AND COALESCE(t.source_at, t.requested_at) < now() - interval '1 day'
       AND (t.reminded_at IS NULL OR t.reminded_at < now() - interval '20 hours')`,
    [OPEN]
  );
  for (const t of rows) {
    await notifyStep(t, { id: 0 }).catch((e) => console.error("[transfer] remind:", e.message));
    await q("UPDATE case_transfers SET reminded_at = now() WHERE id = $1", [t.id]);
  }
  return { reminded: rows.length };
}

// ------------------------------------------------------------ routes
function mount(api, { wrap, loadVisible }) {
  api.get("/case/:id(\\d+)/transfer", wrap(async (req, res) => res.json(await forCaseView(req.user, await loadVisible(req)))));
  api.post("/case/:id(\\d+)/transfer", wrap(async (req, res) => res.json(await request(req.user, await loadVisible(req), req.body || {}))));
  api.post("/transfers/:id(\\d+)/approve", wrap(async (req, res) => res.json(await approveSource(req.user, Number(req.params.id), req.body || {}))));
  api.post("/transfers/:id(\\d+)/accept", wrap(async (req, res) => res.json(await accept(req.user, Number(req.params.id), req.body || {}))));
  api.post("/transfers/:id(\\d+)/reject", wrap(async (req, res) => res.json(await reject(req.user, Number(req.params.id), req.body || {}))));
  api.post("/transfers/:id(\\d+)/cancel", wrap(async (req, res) => res.json(await cancel(req.user, Number(req.params.id)))));
  // Requests waiting for me (I manage the team that has to act) and my own requests still waiting.
  api.get("/transfers/pending", wrap(async (req, res) => {
    const u = req.user;
    const rows = await all(`${SEL} WHERE t.status = ANY($1) ORDER BY t.requested_at`, [OPEN]);
    const forMe = rows.filter((t) => canAct(u, t));
    const mine = rows.filter((t) => !canAct(u, t) && (t.requested_by === u.id || t.owner_id === u.id));
    res.json({ forMe: forMe.map((t) => view(u, t)), mine: mine.map((t) => view(u, t)) });
  }));
}

module.exports = { mount, forCaseView, awaitsMe, request, approveSource, accept, reject, cancel, runReminders, manages, STATUS_TH };
