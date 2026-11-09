// "Add details" link: one link per customer request (/u/<token>), sent in every customer email.
// The customer can add a call-back number, the affected system, urgency, details and screenshots
// as many times as needed while the case is open (and 7 days after it closes).
//  - Before a request is claimed, the details update the request (customer's urgency replaces the guess).
//  - After it is claimed, they become a case activity, files are kept with the request, and the owner is emailed.
//    The customer's urgency is shown to the owner; the case severity is never changed automatically.
// The token is an HMAC of the request id, so it can be rebuilt for any later email without storing it.
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const d = require("../dates");
const { q, one, all, audit, requestContext } = require("./db");
const repo = require("./caserepo");

const intake = () => require("./intake");
const bad = (msg, status = 400, extra) => Object.assign(new Error(msg), { status, extra });
const clean = (s, max = 500) => (s === undefined || s === null ? "" : String(s).replace(/\u0000/g, "").trim().slice(0, max));
const KEEP_DAYS_AFTER_CLOSE = 7;
const MAX_UPDATES_PER_DAY = 10;

// English labels for customers; values are the system's severities.
const SEV_EN = [
  ["Critical", "Critical", "The main system is down or many users are affected"],
  ["High", "High", "An important function does not work"],
  ["Medium", "Medium", "Partly working, or there is a workaround"],
  ["Low", "Low", "Minor issue, work is not affected"],
  ["Request information", "Question", "A question or a request for information"],
];

const mac = (id) => crypto.createHmac("sha256", config3.sessionSecret).update(`intake-update:${id}`).digest("base64url").slice(0, 24);
function tokenFor(id) {
  return `${Number(id).toString(36)}-${mac(id)}`;
}
function idFrom(token) {
  const m = /^([0-9a-z]{1,10})-([A-Za-z0-9_-]{24})$/.exec(String(token || ""));
  if (!m) return null;
  const id = parseInt(m[1], 36);
  const want = Buffer.from(mac(id));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : null;
}
const updateUrl = (id) => `${config3.baseUrl}/u/${tokenFor(id)}`;

async function load(token) {
  const id = idFrom(token);
  if (!id) throw bad("This link is not valid. Please use the button in the latest email from Sinostech Support.", 404, { code: "INVALID" });
  const i = await one(
    `SELECT i.*, c.case_no, c.closed_at, c.severity AS case_severity, c.owner_id AS case_owner_id
     FROM intakes i LEFT JOIN cases c ON c.id = i.case_id WHERE i.id = $1`,
    [id]
  );
  if (!i) throw bad("This request no longer exists.", 404, { code: "GONE" });
  if (i.status === "rejected" || i.status === "duplicate") throw bad(`Request ${i.req_no} was closed by the support team${i.duplicate_of ? ` (same as ${i.duplicate_of})` : ""}. Please reply to the email if you need help.`, 410, { code: "CLOSED" });
  if (i.closed_at && new Date(i.closed_at) < new Date(Date.now() - KEEP_DAYS_AFTER_CLOSE * 86400000)) throw bad(`Case ${i.case_no || i.req_no} was closed. To report a new problem, please send a new email.`, 410, { code: "CLOSED" });
  return i;
}

async function info(token) {
  const i = await load(token);
  const s = await intake().settings();
  const products = (await all("SELECT value FROM lookups WHERE kind = 'product' AND active ORDER BY sort, lower(value)")).map((r) => r.value);
  const afterHours = await intake().isAfterHours();
  const hours = await intake().businessHours();
  return {
    ok: true,
    reqNo: i.req_no,
    caseNo: i.case_no || null,
    subject: i.subject,
    customer: i.site || i.customer_text || "",
    reportedBy: i.contact_email || i.contact_name,
    createdAt: i.created_at,
    claimed: i.status === "claimed",
    closed: !!i.closed_at,
    test: i.is_test,
    current: { contactName: i.contact_name || "", phone: i.contact_phone || "", product: i.product || "" },
    products,
    severities: SEV_EN.map(([value, label, hint]) => ({ value, label, hint })),
    attachments: { maxFiles: s.attachMaxFiles, maxMb: s.attachMaxMb, ext: intake().FILE_EXT },
    afterHours,
    hours,
    hotline: afterHours ? await intake().hotlineForCustomers() : null,
    company: config3.company,
  };
}

async function addFile(token, name, mime, buf) {
  const i = await load(token);
  const s = await intake().settings();
  const staged = await one("SELECT count(*)::int AS n FROM intake_files WHERE intake_id = $1 AND update_id IS NULL AND created_at > now() - interval '1 day'", [i.id]);
  if (staged.n >= s.attachMaxFiles * 2) throw bad(`You can attach up to ${s.attachMaxFiles} files at a time. Please send these details first.`);
  const r = await intake().storeIntakeFile(i.id, name, mime, buf);
  if (r && r.skipped) throw bad(`${r.skipped}: ${r.why === "ไฟล์ว่าง" ? "empty file" : /ใหญ่เกิน/.test(r.why) ? `larger than ${s.attachMaxMb} MB` : "this file type is not accepted"}`);
  await q("UPDATE intake_files SET update_id = NULL WHERE id = $1", [r.id]);
  return { id: r.id, name: r.file_name, size: r.size };
}
async function removeFile(token, fileId) {
  const i = await load(token);
  const f = await one("DELETE FROM intake_files WHERE id = $1 AND intake_id = $2 AND update_id IS NULL AND created_at > now() - interval '1 day' RETURNING path", [fileId, i.id]);
  if (f) intake().removeStored(f.path);
}

const SEV_LABEL = Object.fromEntries(SEV_EN.map(([v, l]) => [v, l]));

/** Apply details from the form (source "form"). Returns a summary for the confirmation page. */
async function submit(token, b, ip) {
  const i = await load(token);
  if (clean(b.website)) throw bad("Could not send. Please try again."); // honeypot
  const recent = await one("SELECT count(*)::int AS n FROM intake_updates WHERE intake_id = $1 AND created_at > now() - interval '1 day'", [i.id]);
  if (recent.n >= MAX_UPDATES_PER_DAY) throw bad("Too many updates today for this case. Please reply to the email instead.", 429);
  const f = {
    contactName: clean(b.contactName, 120),
    phone: clean(b.phone, 60),
    product: clean(b.product, 60),
    severity: repo.severityOf(b.severity) || "",
    startedText: clean(b.startedText, 120),
    affected: clean(b.affected, 120),
    detail: clean(b.detail, 5000),
  };
  if (f.phone && !/[0-9]{6,}/.test(f.phone.replace(/[^0-9]/g, ""))) throw bad("Please check the call-back number.");
  const fileIds = (Array.isArray(b.files) ? b.files : []).map(Number).filter(Boolean).slice(0, 20);
  const files = fileIds.length ? await all("SELECT id, file_name, mime, size, path FROM intake_files WHERE intake_id = $1 AND update_id IS NULL AND id = ANY($2)", [i.id, fileIds]) : [];
  const changed = Object.entries(f).filter(([, v]) => v);
  if (!changed.length && !files.length) throw bad("Please fill in at least one field or attach a file.");

  const u = await one("INSERT INTO intake_updates (intake_id, source, data, ip) VALUES ($1,'form',$2,$3) RETURNING id, created_at", [i.id, JSON.stringify({ ...f, files: files.map((x) => x.file_name) }), ip || null]);
  if (files.length) await q("UPDATE intake_files SET update_id = $2 WHERE id = ANY($1)", [files.map((x) => x.id), u.id]);
  const stamp = new Intl.DateTimeFormat("th-TH", { timeZone: config.tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(u.created_at));
  const lines = [
    f.severity ? `ความเร่งด่วนที่ลูกค้าเลือก: ${f.severity}${i.status === "claimed" && i.case_severity && i.case_severity !== f.severity ? ` (เคสตอนนี้ ${i.case_severity} · User ตัดสินใจ ระบบไม่เปลี่ยนให้)` : ""}` : "",
    f.contactName ? `ผู้ติดต่อ: ${f.contactName}` : "",
    f.phone ? `เบอร์ติดต่อกลับ: ${f.phone}` : "",
    f.product ? `ระบบ: ${f.product}` : "",
    f.startedText ? `เริ่มพบปัญหา: ${f.startedText}` : "",
    f.affected ? `ผู้ใช้ที่ได้รับผลกระทบ: ${f.affected}` : "",
    f.detail ? `\n${f.detail}` : "",
    files.length ? `\nไฟล์แนบ ${files.length} ไฟล์: ${files.map((x) => x.file_name).join(", ")}` : "",
  ].filter(Boolean);
  const text = lines.join("\n").trim();

  if (i.status === "claimed" && i.case_id) {
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, created_by, is_system) VALUES ($1,$2,$3,$4,NULL,true)", [
      i.case_id, d.toISODate(d.today()), "ติดต่อลูกค้า", `ลูกค้าเพิ่มข้อมูลทางฟอร์ม · ${stamp}\n${text}`.slice(0, 6000),
    ]);
    await q("UPDATE cases SET updated_at = now() WHERE id = $1", [i.case_id]);
    if (f.phone || f.contactName) await q("UPDATE intakes SET contact_phone = COALESCE(NULLIF($2,''), contact_phone), contact_name = COALESCE(NULLIF($3,''), contact_name) WHERE id = $1", [i.id, f.phone, f.contactName]);
    notifyOwner(i, { text, files, severity: f.severity }).catch((e) => console.error("[intake-update] owner mail:", e.message));
  } else {
    await q(
      `UPDATE intakes SET contact_name = COALESCE(NULLIF($2,''), contact_name), contact_phone = COALESCE(NULLIF($3,''), contact_phone),
         product = COALESCE(NULLIF($4,''), product), severity = COALESCE(NULLIF($5,''), severity),
         started_text = COALESCE(NULLIF($6,''), started_text), affected = COALESCE(NULLIF($7,''), affected),
         detail = left(detail || $8, 20000) WHERE id = $1`,
      [i.id, f.contactName, f.phone, f.product, f.severity, f.startedText, f.affected, `\n\n--- ข้อมูลเพิ่มจากลูกค้า (ฟอร์ม) · ${stamp} ---\n${text}`]
    );
  }
  await audit(null, "intake_update", i.req_no, { fields: changed.map(([k]) => k), files: files.length, claimed: i.status === "claimed" });
  return { ok: true, reqNo: i.req_no, caseNo: i.case_no || null, files: files.length, fields: changed.map(([k]) => k) };
}

async function notifyOwner(i, { text, files, severity }) {
  const o = await one("SELECT u.email, u.display_name, c.case_no, c.severity FROM cases c JOIN users u ON u.id = c.owner_id WHERE c.id = $1", [i.case_id]);
  if (!o || !o.email) return;
  // Images up to 3 MB each (8 MB in total) go with the email so the owner sees them on the phone.
  let total = 0;
  const attachments = [];
  for (const f of files) {
    if (!/^image\//.test(f.mime) || f.size > 3 * 1024 * 1024 || total + f.size > 8 * 1024 * 1024 || !fs.existsSync(f.path)) continue;
    total += f.size;
    attachments.push({ name: f.file_name, contentType: f.mime, buffer: fs.readFileSync(f.path) });
  }
  await graph.sendMail({
    to: [o.email],
    cc: [],
    subject: `${i.is_test ? "[ทดสอบ] " : ""}[ลูกค้าเพิ่มข้อมูล] ${o.case_no || i.req_no} · ${i.site || ""} · ${i.subject}`,
    attachments,
    html: shell("#1F4FD1", `<p style="margin:0 0 14px">ลูกค้าเพิ่มข้อมูลในเคส <strong>${esc(o.case_no || "")}</strong> ระบบบันทึกเป็น Activity แล้ว${severity && severity !== o.severity ? `<br><strong>ลูกค้าเลือกความเร่งด่วน ${esc(severity)}</strong> (เคสตอนนี้ ${esc(o.severity || "-")}) ปรับ Severity ได้ที่หน้าเคส` : ""}</p>
<p style="margin:0 0 14px;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(text)}</p>
${attachments.length ? `<p style="margin:0 0 14px">แนบรูปมากับ email นี้ ${attachments.length} รูป</p>` : ""}${button(`${config3.baseUrl}/#/case/${i.case_id}`, "เปิดเคส")}`),
  });
}

/** Files customers sent for a case (through its request), newest first — for the case page. */
async function filesForCase(caseId) {
  return all(
    `SELECT f.id, f.intake_id, f.file_name, f.mime, f.size, f.created_at, i.req_no, u.source
     FROM intake_files f JOIN intakes i ON i.id = f.intake_id LEFT JOIN intake_updates u ON u.id = f.update_id
     WHERE i.case_id = $1 ORDER BY f.created_at DESC, f.id DESC`,
    [caseId]
  );
}

// ------------------------------------------------------------ public routes (/api/public/update/...)
const router = express.Router();
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[intake-update]", e);
    res.status(status).json({ ok: false, error: status >= 500 ? "Something went wrong. Please try again." : e.message, ...(e.extra || {}), company: config3.company });
  });
router.get("/update/:token", wrap(async (req, res) => res.json(await info(req.params.token))));
router.post("/update/:token/files", express.raw({ type: () => true, limit: "25mb" }), wrap(async (req, res) => {
  if (req.get("X-Requested-With") !== "fetch") throw bad("Invalid request", 403);
  const name = decodeURIComponent(String(req.get("X-File-Name") || "file"));
  res.json({ ok: true, file: await addFile(req.params.token, name, req.get("Content-Type"), req.body) });
}));
router.delete("/update/:token/files/:id(\\d+)", wrap(async (req, res) => {
  await removeFile(req.params.token, Number(req.params.id));
  res.json({ ok: true });
}));
router.post("/update/:token", express.json({ limit: "64kb" }), wrap(async (req, res) => {
  if (req.get("X-Requested-With") !== "fetch") throw bad("Invalid request", 403);
  res.json(await submit(req.params.token, req.body || {}, (requestContext.getStore() || {}).ip || req.ip));
}));

module.exports = { router, tokenFor, idFrom, updateUrl, filesForCase, submit, info, SEV_EN };
