// Customer case intake.
//  1. The LINE OA chatbot (or the admin simulator, or an engineer's "manual link") asks for a one-time form link.
//  2. The customer fills the form -> a request (REQ-2026-0001) shows on every dashboard, team gets email + Telegram.
//  3. Anyone in the team claims it (or transfers it to an owner) -> it becomes a normal case and the 7-day SLA starts.
//  4. Not claimed after 1 hour -> team reminded every hour between 06:00 and 22:00 until someone claims it.
//  5. On claim an event goes to the chatbot (webhook) so it can tell the customer on LINE who took the case.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const telegram = require("../telegram");
const { esc, shell, fieldTable, button } = require("../emails");
const { splitList } = require("../alertRecipients");
const d = require("../dates");
const { q, one, all, tx, getSetting, setSetting, audit, requestContext } = require("./db");
const repo = require("./caserepo");
const mail = () => require("./mailintake");
const cm = require("./customermail");
const updateUrl = (id) => require("./intakeupdate").updateUrl(id);
const phoneOf = (i) => i.contact_phone || "-";
const contactLine = (i) => [i.contact_phone, i.contact_email].filter(Boolean).join(" · ") || "-";

// ------------------------------------------------------------ settings
const DEFAULTS = {
  linkMinutes: 60,
  manualLinkHours: 24, // links an engineer creates and emails to a customer (people read email later than chat)
  notifyTo: "", // empty = the CC list of owner alert emails
  telegram: true,
  reminder: { afterMinutes: 60, everyMinutes: 60, start: "06:00", end: "22:00" },
  linksPerLinePerHour: 3,
  linksPerKeyPerHour: 300,
  burst: { count: 5, minutes: 10 },
  attachMaxFiles: 5,
  attachMaxMb: 10,
  webhookUrl: "",
  webhookSecret: "",
  testNotifyTo: "", // empty = BOOTSTRAP_ADMIN_EMAIL
  retention: { rejectedDays: 90, attachDaysAfterClose: 365, claimedYears: 2 },
};
async function settings() {
  const s = (await getSetting("intake", null)) || {};
  const out = { ...DEFAULTS, ...s, reminder: { ...DEFAULTS.reminder, ...(s.reminder || {}) }, burst: { ...DEFAULTS.burst, ...(s.burst || {}) }, retention: { ...DEFAULTS.retention, ...(s.retention || {}) } };
  if (!out.webhookSecret) {
    out.webhookSecret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    await setSetting("intake", { ...s, webhookSecret: out.webhookSecret });
  }
  return out;
}

const SEV = {
  Critical: "ระบบหลักใช้งานไม่ได้ทั้งหมด หรือกระทบลูกค้าจำนวนมาก",
  High: "ฟังก์ชันสำคัญใช้ไม่ได้ กระทบการทำงานชัดเจน",
  Medium: "ใช้งานได้บางส่วน หรือมีวิธีเลี่ยงชั่วคราว",
  Low: "ปัญหาเล็กน้อย ไม่กระทบงานหลัก",
  "Request information": "สอบถาม ขอคำแนะนำ หรือขอข้อมูล ไม่ใช่ระบบเสีย",
};
const FILE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "log", "csv", "zip", "docx", "xlsx", "pptx", "har", "json", "xml"];
const FILE_DIR = path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"));

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clean = (s, max = 500) => (s === undefined || s === null ? "" : String(s).replace(/\u0000/g, "").trim().slice(0, max));
const bad = (msg, status = 400, extra) => Object.assign(new Error(msg), { status, extra });
const splitText = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;\n]+/)).map((x) => String(x).trim()).filter(Boolean);
const clientIp = () => (requestContext.getStore() || {}).ip || "";

// Normalised company name for matching what customers type ("ธนาคารกรุงไทย จำกัด (มหาชน)" -> "กรุงไทย").
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/บริษัท|บจก\.?|บมจ\.?|จำกัด|\(มหาชน\)|มหาชน|ธนาคาร|co\.?,?\s*ltd\.?|company|limited|public|plc\.?|bank|\bthe\b/g, "")
    .replace(/[\s.,()\-_/&'"]+/g, "");
}

async function siteList() {
  return (await all("SELECT value FROM lookups WHERE kind='site' AND active ORDER BY sort, lower(value)")).map((r) => r.value);
}
/** Find the site a customer meant. Returns site name or null. */
async function matchCustomer(text) {
  const n = norm(text);
  if (!n) return null;
  const sites = await siteList();
  const exact = sites.find((s) => norm(s) === n);
  if (exact) return exact;
  const alias = await one("SELECT site FROM intake_aliases WHERE norm = $1", [n]);
  if (alias && sites.includes(alias.site)) return alias.site;
  // "KTB (ธนาคารกรุงไทย)" style site names: match the part before or inside the brackets.
  const part = sites.find((s) => s.split(/[()]/).map(norm).filter(Boolean).includes(n));
  return part || null;
}

// ------------------------------------------------------------ links
function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}
const linkUrl = (token) => `${config3.baseUrl}/r/${token}`;

/**
 * Create a one-time form link. Used by the API (chatbot), the admin simulator and manual links.
 * input: { customer, lineUserId, lineDisplayName, contactName, contactPhone, contactEmail, externalRef }
 */
async function createLink(input, { apiKey = null, user = null, source = "api", isTest = false, minutes = null } = {}) {
  const s = await settings();
  const lineUserId = clean(input.lineUserId, 100) || null;
  let lineUser = null;
  if (lineUserId) {
    lineUser = await one("SELECT * FROM intake_line_users WHERE line_user_id = $1", [lineUserId]);
    if (lineUser && lineUser.blocked) throw bad("This LINE account cannot report cases. Please contact Sinostech Support.", 403, { code: "LINE_BLOCKED" });
    const recent = await one("SELECT count(*)::int AS n FROM intake_links WHERE line_user_id = $1 AND created_at > now() - interval '1 hour'", [lineUserId]);
    if (recent.n >= s.linksPerLinePerHour) throw bad(`You can request up to ${s.linksPerLinePerHour} links per hour. Please try again later.`, 429, { code: "RATE_LIMIT_LINE" });
  }
  if (apiKey) {
    const recent = await one("SELECT count(*)::int AS n FROM intake_links WHERE api_key_id = $1 AND created_at > now() - interval '1 hour'", [apiKey.id]);
    if (recent.n >= s.linksPerKeyPerHour) throw bad("This API key has reached its hourly link limit.", 429, { code: "RATE_LIMIT_KEY" });
  }

  const customerText = clean(input.customer, 200);
  let site = customerText ? await matchCustomer(customerText) : null;
  if (!customerText && lineUser && lineUser.site) site = lineUser.site; // returning customer, company remembered
  const contactName = clean(input.contactName, 120) || (lineUser && lineUser.contact_name) || "";
  const contactPhone = clean(input.contactPhone, 60) || (lineUser && lineUser.contact_phone) || "";

  const token = newToken();
  const expires = new Date(Date.now() + Number(minutes || s.linkMinutes || 60) * 60000);
  const row = await one(
    `INSERT INTO intake_links (token_hash, api_key_id, created_by, source, is_test, site, customer_text, line_user_id,
       contact_name, contact_phone, contact_email, external_ref, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [sha(token), apiKey ? apiKey.id : null, user ? user.id : null, source, isTest, site, customerText || (lineUser && lineUser.customer_text) || null,
      lineUserId, contactName || null, contactPhone || null, clean(input.contactEmail, 200) || null, clean(input.externalRef, 120) || null, expires]
  );
  if (lineUserId) {
    await q(
      `INSERT INTO intake_line_users (line_user_id, display_name, site, customer_text, contact_name, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (line_user_id) DO UPDATE SET last_seen = now(),
         display_name = COALESCE(EXCLUDED.display_name, intake_line_users.display_name),
         site = COALESCE(EXCLUDED.site, intake_line_users.site),
         customer_text = COALESCE(EXCLUDED.customer_text, intake_line_users.customer_text),
         contact_name = COALESCE(EXCLUDED.contact_name, intake_line_users.contact_name),
         contact_phone = COALESCE(EXCLUDED.contact_phone, intake_line_users.contact_phone)`,
      [lineUserId, clean(input.lineDisplayName, 120) || null, site, customerText || null, contactName || null, contactPhone || null]
    );
  }
  return {
    ok: true,
    url: linkUrl(token),
    expiresAt: expires.toISOString(),
    linkId: row.id,
    customer: site ? { matched: true, site } : { matched: false, text: customerText || null },
    test: isTest,
  };
}

async function linkByToken(token) {
  if (!token || token.length < 20 || token.length > 64) return null;
  return one("SELECT * FROM intake_links WHERE token_hash = $1", [sha(token)]);
}
function linkState(l) {
  if (!l) return { error: "This link was not found. Please request a new link in LINE.", status: 404, code: "NOT_FOUND" };
  if (l.used_at) return { error: "This link has already been used. To report something new, tap “Report a case” in LINE or ask our team for a new link.", status: 410, code: "USED" };
  if (new Date(l.expires_at) < new Date()) return { error: "This link has expired. Tap “Report a case” in LINE again, or ask our team for a new link.", status: 410, code: "EXPIRED" };
  return null;
}

async function siteSettings(site) {
  if (!site) return null;
  return one(
    `SELECT s.*, u.display_name AS owner_name, u.email AS owner_email FROM intake_sites s
     LEFT JOIN users u ON u.id = s.owner_id WHERE s.site = $1`,
    [site]
  );
}

/** Who looked after this customer's most recent case (active users only) — shown instead of a fixed site owner. */
async function recentOwner(site) {
  if (!site) return null;
  return one(
    `SELECT u.id, u.display_name, u.email, c.start_date FROM cases c JOIN users u ON u.id = c.owner_id AND u.active
     WHERE c.site = $1 ORDER BY c.start_at DESC NULLS LAST, c.id DESC LIMIT 1`,
    [site]
  );
}

/** What we know about a customer that matched no site: sender domain (or the whole personal email), or the name typed in LINE. */
function unknownCustomerLabel(i) {
  if (i.channel === "email" && i.contact_email) {
    const dom = String(i.contact_email).split("@")[1] || "";
    return require("./mailintake").PUBLIC_DOMAINS.includes(dom) ? i.contact_email : dom;
  }
  return i.customer_text || i.contact_name || "ไม่ระบุ";
}

// ------------------------------------------------------------ business hours and hotline
/** Outside business hours = outside the reminder window (default 22:00–06:00). */
async function isAfterHours(at = new Date()) {
  const s = await settings();
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: config.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  return !(hm >= s.reminder.start && hm < s.reminder.end);
}
async function businessHours() {
  const s = await settings();
  return { start: s.reminder.start, end: s.reminder.end };
}
const HOTLINE_DEFAULT = { lines: [{ phone: "", label: "On-duty engineer" }, { phone: "", label: "Team lead" }, { phone: "", label: "Manager" }], waitMinutes: 10, note: "" };
async function hotline() {
  const h = (await getSetting("hotline", null)) || {};
  const lines = [0, 1, 2].map((n) => ({ ...HOTLINE_DEFAULT.lines[n], ...((h.lines || [])[n] || {}) }));
  return { ...HOTLINE_DEFAULT, ...h, lines };
}
/** Numbers customers see (rows without a phone are hidden). */
async function hotlineForCustomers() {
  const h = await hotline();
  return { lines: h.lines.filter((l) => l.phone), waitMinutes: h.waitMinutes };
}
async function saveHotline(user, b) {
  const cur = await hotline();
  const lines = [0, 1, 2].map((n) => {
    const x = (Array.isArray(b.lines) ? b.lines[n] : null) || {};
    const phone = clean(x.phone, 40);
    if (phone && !/^[+0-9][0-9 ()\-]{5,}$/.test(phone)) throw bad(`เบอร์ลำดับที่ ${n + 1} ไม่ถูกต้อง`);
    return { phone, label: clean(x.label, 60) || HOTLINE_DEFAULT.lines[n].label };
  });
  const wait = Math.min(120, Math.max(1, Math.round(Number(b.waitMinutes) || 10)));
  const next = { lines, waitMinutes: wait, note: clean(b.note, 300), updatedBy: user.display_name, updatedAt: new Date().toISOString() };
  await setSetting("hotline", next);
  await audit(user, "hotline_update", null, { from: cur.lines.map((l) => l.phone), to: lines.map((l) => l.phone), labels: lines.map((l) => l.label), waitMinutes: wait });
  return next;
}

// ------------------------------------------------------------ request numbers
async function nextReqNo(client) {
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric" }).format(new Date()));
  const r = await client.query(
    `INSERT INTO intake_seq (year, last) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last = intake_seq.last + 1 RETURNING last`,
    [year]
  );
  return `REQ-${year}-${String(r.rows[0].last).padStart(4, "0")}`;
}

// ------------------------------------------------------------ files
async function saveFile(link, name, mime, buf) {
  const s = await settings();
  const ss = await siteSettings(link.site);
  if (!ss || !ss.attachments) throw bad("Attachments are not enabled for your company.", 403);
  const fileName = clean(name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "file";
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (!FILE_EXT.includes(ext)) throw bad(`.${ext} files are not accepted. Accepted: ${FILE_EXT.join(", ")}`);
  if (!buf || !buf.length) throw bad("The file is empty.");
  if (buf.length > s.attachMaxMb * 1024 * 1024) throw bad(`The file is larger than ${s.attachMaxMb} MB.`);
  const count = await one("SELECT count(*)::int AS n FROM intake_files WHERE link_id = $1", [link.id]);
  if (count.n >= s.attachMaxFiles) throw bad(`You can attach up to ${s.attachMaxFiles} files.`);
  const dir = path.join(FILE_DIR, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const stored = path.join(dir, crypto.randomBytes(16).toString("hex") + "." + ext);
  fs.writeFileSync(stored, buf, { mode: 0o640 });
  const r = await one(
    "INSERT INTO intake_files (link_id, file_name, mime, size, path) VALUES ($1,$2,$3,$4,$5) RETURNING id, file_name, size",
    [link.id, fileName, clean(mime, 100) || "application/octet-stream", buf.length, stored]
  );
  return r;
}
/** Store a file that arrived by email (no form link). Returns null when the type or size is not accepted. */
async function storeIntakeFile(intakeId, name, mime, buf) {
  const s = await settings();
  const fileName = clean(name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "file";
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (!FILE_EXT.includes(ext)) return { skipped: fileName, why: `ชนิด .${ext} ไม่รองรับ` };
  if (!buf || !buf.length) return { skipped: fileName, why: "ไฟล์ว่าง" };
  if (buf.length > s.attachMaxMb * 1024 * 1024) return { skipped: fileName, why: `ใหญ่เกิน ${s.attachMaxMb} MB` };
  const count = await one("SELECT count(*)::int AS n FROM intake_files WHERE intake_id = $1", [intakeId]);
  if (count.n >= 60) return { skipped: fileName, why: "ไฟล์แนบของเรื่องนี้เกิน 60 ไฟล์" };
  const dir = path.join(FILE_DIR, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const stored = path.join(dir, crypto.randomBytes(16).toString("hex") + "." + ext);
  fs.writeFileSync(stored, buf, { mode: 0o640 });
  return one("INSERT INTO intake_files (intake_id, file_name, mime, size, path) VALUES ($1,$2,$3,$4,$5) RETURNING id, file_name, size", [
    intakeId, fileName, clean(mime, 100) || "application/octet-stream", buf.length, stored,
  ]);
}
function removeStored(p) {
  try {
    if (p && p.startsWith(FILE_DIR)) fs.unlinkSync(p);
  } catch (e) {}
}

// ------------------------------------------------------------ submit (customer)
async function submit(token, b) {
  const link = await linkByToken(token);
  const st = linkState(link);
  if (st) throw bad(st.error, st.status, { code: st.code });
  if (clean(b.website)) throw bad("Could not send. Please try again."); // honeypot
  if (b.openedAt && Date.now() - Number(b.openedAt) < 4000) throw bad("Sent too quickly. Please check the form and send again.");

  const f = {
    contact_name: clean(b.contactName, 120),
    position: clean(b.position, 120),
    contact_email: clean(b.email, 200),
    contact_phone: clean(b.phone, 60),
    product: clean(b.product, 60),
    started_text: clean(b.startedText, 120),
    severity: repo.severityOf(b.severity),
    subject: clean(b.subject, 150),
    detail: clean(b.detail, 5000),
    affected: clean(b.affected, 120),
    customer_ref: clean(b.customerRef, 120),
  };
  const miss = [];
  if (!f.contact_name) miss.push("contact name");
  if (!f.contact_phone) miss.push("call-back number");
  if (!f.product) miss.push("affected system");
  if (!f.severity) miss.push("urgency");
  if (!f.subject) miss.push("subject");
  if (!f.detail) miss.push("details");
  if (miss.length) throw bad("Please fill in: " + miss.join(", "));
  if (f.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contact_email)) throw bad("Please check the email address.");
  if (!b.consent) throw bad("Please tick the consent box.");

  // Same subject from the same customer still open -> ask before creating a second request.
  if (!b.confirmDuplicate && link.site) {
    const dup = await one(
      `SELECT req_no FROM intakes WHERE site = $1 AND lower(subject) = lower($2) AND status IN ('pending','claiming','claimed')
         AND created_at > now() - interval '7 days' ORDER BY id DESC LIMIT 1`,
      [link.site, f.subject]
    );
    if (dup) throw bad(`This may be the same issue as ${dup.req_no}, which you already reported. If it is a different problem, choose “Send as a new case”.`, 409, { code: "DUPLICATE", reqNo: dup.req_no });
  }

  const s = await settings();
  const afterHours = await isAfterHours();
  const fileIds = (Array.isArray(b.files) ? b.files : []).map(Number).filter(Boolean).slice(0, s.attachMaxFiles);
  const created = await tx(async (c) => {
    const used = await c.query("UPDATE intake_links SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id", [link.id]);
    if (!used.rowCount) throw bad("This link has already been used or has expired.", 410, { code: "USED" });
    const prior = link.line_user_id
      ? (await c.query("SELECT 1 FROM intakes WHERE line_user_id = $1 LIMIT 1", [link.line_user_id])).rowCount
      : 1;
    const burst = (await c.query(`SELECT count(*)::int AS n FROM intakes WHERE NOT is_test AND created_at > now() - make_interval(mins => $1)`, [s.burst.minutes])).rows[0].n;
    const held = !link.is_test && burst >= s.burst.count;
    const reqNo = await nextReqNo(c);
    const r = await c.query(
      `INSERT INTO intakes (req_no, link_id, is_test, held, site, customer_text, line_user_id, new_line, external_ref,
         contact_name, position, contact_email, contact_phone, product, severity, started_text, affected, customer_ref, subject, detail, ip, channel, after_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
      [reqNo, link.id, link.is_test, held, link.site, link.customer_text, link.line_user_id, !prior, link.external_ref,
        f.contact_name, f.position || null, f.contact_email || null, f.contact_phone, f.product, f.severity, f.started_text || null,
        f.affected || null, f.customer_ref || null, f.subject, f.detail, clientIp() || null, link.line_user_id ? "line" : "link", afterHours]
    );
    if (fileIds.length) await c.query("UPDATE intake_files SET intake_id = $1 WHERE link_id = $2 AND id = ANY($3)", [r.rows[0].id, link.id, fileIds]);
    if (link.line_user_id) {
      await c.query("UPDATE intake_line_users SET contact_name = $2, contact_phone = $3, last_seen = now() WHERE line_user_id = $1", [link.line_user_id, f.contact_name, f.contact_phone]);
    }
    return r.rows[0];
  });
  // Files uploaded but not kept
  const stray = await all("SELECT id, path FROM intake_files WHERE link_id = $1 AND intake_id IS NULL", [link.id]);
  for (const x of stray) removeStored(x.path);
  if (stray.length) await q("DELETE FROM intake_files WHERE id = ANY($1)", [stray.map((x) => x.id)]);

  await audit(null, "intake_submit", created.req_no, { site: created.site, customer: created.customer_text, line: !!created.line_user_id, test: created.is_test, held: created.held });
  notifyNew(created).catch((e) => console.error("[intake] notify:", e.message));
  return { ok: true, afterHours, hours: afterHours ? await businessHours() : null, hotline: afterHours ? await hotlineForCustomers() : null, updateUrl: updateUrl(created.id),
    channel: created.line_user_id ? "line" : "link", contactEmail: created.contact_email, reqNo: created.req_no, createdAt: created.created_at, site: created.site, customerText: created.customer_text, subject: created.subject, severity: created.severity, product: created.product, contactName: created.contact_name, contactPhone: created.contact_phone };
}

// ------------------------------------------------------------ notifications
const intakeUrl = (i) => `${config3.baseUrl}/#/intake/${i.id}`;
const SEV_COLOR = { Critical: "#C0283C", High: "#C2410C", Medium: "#B07800", Low: "#1C6B45", "Request information": "#4A5361" };
const SEV_ICON = { Critical: "🔴", High: "🟠", Medium: "🟡", Low: "🟢", "Request information": "⚪" };
const customerName = (i) => i.site || `${i.customer_text || "ไม่ระบุบริษัท"} (ลูกค้าใหม่ รอยืนยัน)`;

async function teamRecipients(i) {
  if (i.is_test) {
    const s = await settings();
    return { to: splitList(s.testNotifyTo || config3.bootstrapAdmin), cc: [] };
  }
  const s = await settings();
  let to = splitList(s.notifyTo);
  // Requests that came in by email go to the address set in the email section (default support@), if any.
  if (i.channel === "email") {
    const e = await require("./mailintake").emailSettings();
    if (splitList(e.teamNotifyTo).length) to = splitList(e.teamNotifyTo);
  }
  if (!to.length) {
    const ae = await getSetting("alert_email", null);
    to = splitList((ae && ae.cc) || config.alertCc.join(","));
  }
  const ro = await recentOwner(i.site);
  const cc = ro && ro.email && !to.includes(ro.email.toLowerCase()) ? [ro.email] : [];
  return { to, cc };
}

function intakeFields(i) {
  return fieldTable([
    ["เลขรับแจ้ง", i.req_no],
    ["ลูกค้า", customerName(i)],
    ["ผู้ติดต่อ", `${i.contact_name}${i.position ? ` (${i.position})` : ""} · ${contactLine(i)}`],
    ["ช่องทาง", i.channel === "email" ? "Email" : i.line_user_id ? "LINE OA" : "ลิงก์ฟอร์ม"],
    ["ระบบ / Severity", `${i.product || "-"} · ${i.severity}`],
    ["เริ่มพบปัญหา", [i.started_text, i.affected ? `กระทบ ${i.affected}` : ""].filter(Boolean).join(" · ") || "-"],
    ["เลขอ้างอิงลูกค้า", i.customer_ref || "-"],
  ]);
}
const tag = (i) => [i.is_test ? "[ทดสอบ] " : "", i.new_line ? "[LINE ใหม่] " : "", !i.site ? "[ลูกค้าใหม่] " : ""].join("");

async function notifyNew(i) {
  const s = await settings();
  if (i.held) return notifyBurst();
  const { to, cc } = await teamRecipients(i);
  const ro = await recentOwner(i.site);
  const subject = `${tag(i)}[เคสใหม่จากลูกค้า] ${i.severity} · ${customerName(i)} · ${i.subject}`;
  const html = shell(
    SEV_COLOR[i.severity] || "#1F4FD1",
    `<p style="margin:0 0 14px">มีเคสใหม่จากลูกค้า <strong>รอรับเคส</strong> ใครในทีมก็รับได้ SLA 7 วันเริ่มนับเมื่อรับเคส${ro ? ` · ดูแลเคสล่าสุดของลูกค้ารายนี้: ${esc(ro.display_name)}` : ""}</p>
${intakeFields(i)}
<p style="margin:14px 0;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(i.detail)}</p>
${i.new_line ? `<p style="margin:0 0 12px;color:#7A4A00">เคสแรกจากบัญชี LINE นี้ กรุณาโทรยืนยันกับลูกค้าตอนรับเคส</p>` : ""}
${button(intakeUrl(i), "รับเคส / โอนให้ Owner")}`
  );
  if (to.length) await graph.sendMail({ to, cc, subject, html }).catch((e) => console.error("[intake] mail:", e.message));
  if (s.telegram && !i.is_test) {
    await telegram
      .sendText(
        `🆕 ${tag(i)}เคสใหม่จากลูกค้า · ${i.req_no}\n${SEV_ICON[i.severity] || ""} ${i.severity} · ${i.product || "-"}\n🏢 ${customerName(i)}\n👤 ${i.contact_name} · ${i.channel === "email" ? i.contact_email : phoneOf(i)}${i.channel === "email" ? " (email)" : ""}\n\n${i.subject}\n${ro ? `ดูแลเคสล่าสุด: ${ro.display_name}\n` : ""}รับเคส: ${intakeUrl(i)}`
      )
      .catch((e) => console.error("[intake] telegram:", e.message));
  }
}

async function notifyBurst() {
  const s = await settings();
  const last = await getSetting("intake_burst_alert_at", null);
  if (last && Date.now() - new Date(last).getTime() < s.burst.minutes * 60000) return;
  await setSetting("intake_burst_alert_at", new Date().toISOString());
  const held = await one("SELECT count(*)::int AS n FROM intakes WHERE held AND status = 'pending'");
  const msg = `มีเคสจากลูกค้าเข้ามาผิดปกติ (ตั้งแต่ ${s.burst.count} เคสใน ${s.burst.minutes} นาที) ระบบพักไว้ ${held.n} เคส และหยุดแจ้งทีละเคส Admin / Manager ตรวจและกด “ยืนยันว่าเป็นเคสจริง” ได้ที่ ${config3.baseUrl}/#/intake?status=held`;
  const { to } = await teamRecipients({});
  if (to.length) await graph.sendMail({ to, cc: [], subject: "[Sino Case SLA] เคสจากลูกค้าเข้ามาผิดปกติ ระบบพักไว้ตรวจ", html: shell("#C0283C", `<p>${esc(msg)}</p>`) }).catch(() => {});
  if (s.telegram) await telegram.sendText("⚠️ " + msg).catch(() => {});
}

function waited(i, now = new Date()) {
  const m = Math.floor((now.getTime() - new Date(i.created_at).getTime()) / 60000);
  return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}

/** Hourly reminder for unclaimed requests (only between reminder.start and reminder.end, every day).
 *  Test requests (simulator / test API key) are reminded the same way but only to the test recipients. */
async function runReminders({ now = new Date() } = {}) {
  const s = await settings();
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: config.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  if (!(hm >= s.reminder.start && hm < s.reminder.end)) return { skipped: `นอกช่วง ${s.reminder.start}-${s.reminder.end}`, at: hm };
  const out = {};
  for (const isTest of [false, true]) {
    const due = await all(
      `SELECT * FROM intakes WHERE status = 'pending' AND NOT held AND is_test = $4
         AND created_at <= $1::timestamptz - make_interval(mins => $2)
         AND (last_reminded_at IS NULL OR last_reminded_at <= $1::timestamptz - make_interval(mins => $3) + interval '1 minute')`,
      [now.toISOString(), s.reminder.afterMinutes, s.reminder.everyMinutes, isTest]
    );
    if (!due.length) continue;
    // Requests waiting longer than reminder.afterMinutes, oldest first, in one message.
    const pending = due.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const { to } = await teamRecipients({ is_test: isTest });
    const rows = pending
      .map((i) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #E2E5EA"><a href="${esc(intakeUrl(i))}" style="color:#1F4FD1">${esc(i.req_no)}</a></td><td style="padding:8px 10px;border-bottom:1px solid #E2E5EA">${esc(i.severity)}</td><td style="padding:8px 10px;border-bottom:1px solid #E2E5EA"><strong>${esc(customerName(i))}</strong><br>${esc(i.subject)}</td><td style="padding:8px 10px;border-bottom:1px solid #E2E5EA;color:#A5162E;font-weight:600">${waited(i, now)}</td></tr>`)
      .join("");
    const every = s.reminder.everyMinutes % 60 ? `${s.reminder.everyMinutes} นาที` : `${s.reminder.everyMinutes / 60} ชั่วโมง`;
    const html = shell(
      "#C2410C",
      `<p style="margin:0 0 14px">ยังไม่มีคนรับเคสจากลูกค้า <strong>${pending.length} เคส</strong> ระบบจะเตือนทุก ${every} (${s.reminder.start}–${s.reminder.end}) จนกว่าจะมีคนรับ</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;border:1px solid #E2E5EA"><tr style="background:#F6F7F9;color:#5B6576"><td style="padding:8px 10px">เลขรับแจ้ง</td><td style="padding:8px 10px">Severity</td><td style="padding:8px 10px">ลูกค้า / หัวข้อ</td><td style="padding:8px 10px">รอมาแล้ว</td></tr>${rows}</table>
<p style="margin:14px 0 0">${button(`${config3.baseUrl}/#/intake`, "เปิดรายการรอรับเคส")}</p>`
    );
    if (to.length) await graph.sendMail({ to, cc: [], subject: `${isTest ? "[ทดสอบ] " : ""}[ยังไม่มีคนรับ] เคสจากลูกค้า ${pending.length} เคส รอรับเคส`, html }).catch((e) => console.error("[intake] reminder mail:", e.message));
    if (s.telegram && !isTest) {
      await telegram
        .sendText(`⏰ ยังไม่มีคนรับเคสจากลูกค้า ${pending.length} เคส\n\n${pending.map((i) => `${SEV_ICON[i.severity] || ""} ${i.req_no} · ${customerName(i)} · รอ ${waited(i, now)}\n${i.subject}`).join("\n\n")}\n\nรับเคส: ${config3.baseUrl}/#/intake`)
        .catch((e) => console.error("[intake] reminder telegram:", e.message));
    }
    await q("UPDATE intakes SET last_reminded_at = $2, reminder_count = reminder_count + 1 WHERE id = ANY($1)", [pending.map((i) => i.id), now]);
    if (!isTest) await audit(null, "intake_reminder", null, { count: pending.length });
    out[isTest ? "test" : "sent"] = pending.length;
  }
  return Object.keys(out).length ? out : { sent: 0 };
}

// ------------------------------------------------------------ claim / transfer / reject
async function claim(user, id, b) {
  const ownerId = Number(b.ownerId) || user.id;
  const owner = await one("SELECT u.id, u.display_name, u.email, u.phone, u.active, array_remove(array_agg(t.team), NULL) AS teams FROM users u LEFT JOIN user_teams t ON t.user_id = u.id WHERE u.id = $1 GROUP BY u.id", [ownerId]);
  if (!owner || !owner.active) throw bad("ไม่พบผู้ใช้ที่เลือก");
  const locked = await one("UPDATE intakes SET status = 'claiming' WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
  if (!locked) {
    const cur = await one("SELECT i.status, u.display_name FROM intakes i LEFT JOIN users u ON u.id = i.claimed_by WHERE i.id = $1", [id]);
    if (!cur) throw bad("ไม่พบคำขอนี้", 404);
    throw bad(cur.status === "claimed" ? `มีคนรับเคสนี้ไปแล้ว (${cur.display_name || "-"})` : "คำขอนี้ไม่ได้อยู่ในสถานะรอรับเคส", 409);
  }
  const i = locked;
  try {
    const chosen = clean(b.site, 120) || i.site;
    // Customer not known yet: take the case now, confirm the customer on the case page after calling back.
    const unknownWho = chosen ? null : unknownCustomerLabel(i);
    const site = chosen || `ยังไม่ยืนยัน (${unknownWho})`;
    const ss = await siteSettings(site);
    const team = clean(b.team, 40) || (ss && ss.team) || (owner.teams || [])[0];
    if (!team) throw bad("กรุณาเลือกทีม");
    if (owner.id !== user.id) await require("./perms").checkAssign(user, team, owner.id);
    const files = await all("SELECT id, file_name FROM intake_files WHERE intake_id = $1", [i.id]);
    const head = [
      `เคสจากลูกค้า ${i.req_no}`,
      `ผู้ติดต่อ: ${i.contact_name}${i.position ? ` (${i.position})` : ""} · ${contactLine(i)}`,
      i.channel === "email" ? "ช่องทาง: Email (ลูกค้าตอบกลับ email เรื่องนี้ ระบบบันทึกเป็น Activity ให้)" : "",
      i.started_text ? `เริ่มพบปัญหา: ${i.started_text}` : "",
      i.affected ? `ผลกระทบ: ${i.affected}` : "",
      i.customer_ref ? `เลขอ้างอิงลูกค้า: ${i.customer_ref}` : "",
    ].filter(Boolean);
    const tail = files.length ? `ไฟล์แนบ ${files.length} ไฟล์: ${files.map((f) => f.file_name).join(", ")} (ดูที่ ${config3.baseUrl}/#/intake/${i.id})` : "";
    const detail = [head.join("\n"), i.detail, tail].filter(Boolean).join("\n\n").trim();
    const { id: caseId } = await repo.createCase(
      user,
      {
        team, site, product: i.product, severity: repo.severityOf(b.severity) || i.severity, cs_number: clean(b.csNumber, 60) || null,
        task: i.subject, detail, note: `จากลูกค้า ${i.req_no}`, status: "In Progress", customer_unconfirmed: unknownWho,
      },
      { ownerId: owner.id }
    );
    if (clean(b.note)) {
      await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, created_by) VALUES ($1,$2,$3,$4,$5)", [caseId, d.toISODate(d.today()), "ดำเนินการ", clean(b.note, 2000), user.id]);
    }
    const done = await one(
      `UPDATE intakes SET status = 'claimed', claimed_at = now(), claimed_by = $2, owner_id = $3, case_id = $4, site = $5
       WHERE id = $1 RETURNING *`,
      [i.id, user.id, owner.id, caseId, chosen || null]
    );
    if (i.line_user_id && chosen && !i.site) await q("UPDATE intake_line_users SET site = $2 WHERE line_user_id = $1 AND site IS NULL", [i.line_user_id, site]);
    await audit(user, "intake_claim", i.req_no, { caseId, owner: owner.display_name, transfer: owner.id !== user.id });
    const kase = await repo.getCase(caseId);
    notifyClaimed(done, kase, user, owner).catch((e) => console.error("[intake] claim notify:", e.message));
    return { ok: true, caseId, caseNo: kase.caseNo, reqNo: i.req_no, owner: owner.display_name };
  } catch (e) {
    await q("UPDATE intakes SET status = 'pending' WHERE id = $1 AND status = 'claiming'", [i.id]);
    throw e;
  }
}

async function notifyClaimed(i, kase, by, owner) {
  const s = await settings();
  const transfer = owner.id !== by.id;
  if (transfer && owner.email) {
    await graph
      .sendMail({
        to: [owner.email],
        cc: [],
        subject: `${i.is_test ? "[ทดสอบ] " : ""}[โอนเคสให้คุณ] ${i.severity} · ${kase.site} · ${i.subject}`,
        html: shell(SEV_COLOR[i.severity] || "#1F4FD1", `<p style="margin:0 0 14px">${esc(by.display_name)} โอนเคสจากลูกค้า ${esc(kase.site)} ให้คุณเป็น Owner SLA 7 วันเริ่มนับวันนี้</p>${intakeFields(i)}
<p style="margin:14px 0;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(i.detail)}</p>${button(kase.caseUrl, "เปิดเคสเพื่ออัปเดต")}`),
      })
      .catch((e) => console.error("[intake] owner mail:", e.message));
  }
  if (s.telegram && !i.is_test) {
    const mins = Math.round((new Date(i.claimed_at) - new Date(i.created_at)) / 60000);
    await telegram
      .sendText(`✅ รับเคสแล้ว ${i.req_no} → ${kase.caseNo}${kase.csNumber ? ` (${kase.csNumber})` : ""}\n${kase.site} · ${i.severity} · Owner: ${owner.display_name}\nโดย ${by.display_name} · รอรับ ${mins < 60 ? mins + " นาที" : Math.floor(mins / 60) + " ชม. " + (mins % 60) + " นาที"}`)
      .catch(() => {});
  }
  // Requests that came by email: reply in the customer's own thread from the shared mailbox.
  let threaded = false;
  if (i.channel === "email") threaded = await mail().onClaimed(i, kase, owner).catch((e) => (console.error("[intake] email thread reply:", e.message), false));
  // Customers who came through an emailed link (not LINE) get the "case accepted" message by email instead.
  if (!threaded && !i.line_user_id && i.contact_email) {
    await graph
      .sendMail({
        to: [i.contact_email],
        cc: owner.email ? [owner.email] : [],
        subject: cm.claimedSubject(i, kase, `An engineer has taken your case: ${i.subject}`),
        html: cm.claimedHtml(i, kase, owner, { updateUrl: updateUrl(i.id) }),
      })
      .catch((e) => console.error("[intake] customer claim mail:", e.message));
  }
  await enqueue("case.claimed", i, {
    event: "case.claimed",
    test: i.is_test,
    reqNo: i.req_no,
    caseId: kase.id,
    caseNo: kase.caseNo,
    csNumber: kase.csNumber || null,
    customer: i.site,
    subject: i.subject,
    severity: kase.severity,
    owner: { name: owner.display_name, phone: owner.phone || null, email: owner.email },
    claimedAt: new Date(i.claimed_at).toISOString(),
    lineUserId: i.line_user_id,
    externalRef: i.external_ref,
    contact: { name: i.contact_name, phone: i.contact_phone },
    updateUrl: updateUrl(i.id),
    message: `An engineer has taken your case.\n${i.req_no} → ${kase.caseNo}\n${i.subject}\n\nEngineer: ${owner.display_name}${owner.phone ? `\nEngineer phone: ${owner.phone}` : ""}\nWe will contact you at ${i.contact_phone || i.contact_email}\n\nAdd details or screenshots: ${updateUrl(i.id)}`,
  });
}

async function reject(user, id, b) {
  const status = b.duplicateOf ? "duplicate" : "rejected";
  const reason = clean(b.reason, 500);
  if (!reason && !b.duplicateOf) throw bad("กรุณาระบุเหตุผล");
  const r = await one(
    `UPDATE intakes SET status = $2, closed_reason = $3, duplicate_of = $4, claimed_by = $5, claimed_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, reason || null, clean(b.duplicateOf, 60) || null, user.id]
  );
  if (!r) throw bad("คำขอนี้ไม่ได้อยู่ในสถานะรอรับเคส", 409);
  await audit(user, "intake_reject", r.req_no, { status, reason, duplicateOf: r.duplicate_of });
  if (r.channel === "email" && b.notifyCustomer) {
    await mail().onClosed(r, cm.closedMessage(r, status, reason)).catch((e) => console.error("[intake] email close reply:", e.message));
  }
  await enqueue("intake.closed", r, {
    event: "intake.closed",
    test: r.is_test,
    reqNo: r.req_no,
    reason: status === "duplicate" ? `ซ้ำกับ ${r.duplicate_of}` : reason,
    lineUserId: r.line_user_id,
    externalRef: r.external_ref,
    notifyCustomer: !!b.notifyCustomer,
    message: cm.closedMessage(r, status, reason),
  });
  return { ok: true };
}

// ------------------------------------------------------------ webhook outbox
async function enqueue(event, i, payload) {
  const s = await settings();
  await q("INSERT INTO intake_outbox (event, intake_id, is_test, payload, status) VALUES ($1,$2,$3,$4,$5)", [
    event, i.id, !!i.is_test, JSON.stringify(payload), s.webhookUrl ? "pending" : "no_url",
  ]);
  if (s.webhookUrl) deliver().catch((e) => console.error("[intake] webhook:", e.message));
}

let delivering = false;
async function deliver() {
  if (delivering) return { busy: true };
  delivering = true;
  try {
    const s = await settings();
    if (!s.webhookUrl) return { skipped: "no url" };
    const rows = await all("SELECT * FROM intake_outbox WHERE status = 'pending' AND next_at <= now() ORDER BY id LIMIT 20");
    let ok = 0;
    for (const r of rows) {
      const body = JSON.stringify({ id: r.id, ...r.payload });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac("sha256", s.webhookSecret).update(ts + "." + body).digest("hex");
      try {
        const res = await axios.post(s.webhookUrl, body, {
          timeout: 10000,
          headers: { "Content-Type": "application/json", "X-Sino-Event": r.event, "X-Sino-Timestamp": ts, "X-Sino-Signature": `sha256=${sig}` },
          validateStatus: () => true,
          maxRedirects: 0,
        });
        if (res.status >= 200 && res.status < 300) {
          await q("UPDATE intake_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, response = $2, last_error = NULL WHERE id = $1", [r.id, String(JSON.stringify(res.data) || "").slice(0, 500)]);
          ok++;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        const attempts = r.attempts + 1;
        await q(
          `UPDATE intake_outbox SET attempts = $2, last_error = $3, status = CASE WHEN $2 >= 8 THEN 'failed' ELSE 'pending' END,
             next_at = now() + make_interval(mins => $4) WHERE id = $1`,
          [r.id, attempts, String(e.message).slice(0, 300), Math.min(240, 2 ** attempts)]
        );
      }
    }
    return { sent: ok, tried: rows.length };
  } finally {
    delivering = false;
  }
}

// ------------------------------------------------------------ retention
async function runRetention() {
  const s = await settings();
  const r = s.retention;
  const out = {};
  const oldFiles = await all(
    `SELECT f.id, f.path FROM intake_files f
     LEFT JOIN intakes i ON i.id = f.intake_id LEFT JOIN cases c ON c.id = i.case_id
     WHERE (f.intake_id IS NULL AND f.created_at < now() - interval '2 days')
        OR (i.status IN ('rejected','duplicate') AND i.claimed_at < now() - make_interval(days => $1))
        OR (c.closed_at IS NOT NULL AND c.closed_at < now() - make_interval(days => $2))`,
    [r.rejectedDays, r.attachDaysAfterClose]
  );
  oldFiles.forEach((f) => removeStored(f.path));
  if (oldFiles.length) await q("DELETE FROM intake_files WHERE id = ANY($1)", [oldFiles.map((f) => f.id)]);
  out.files = oldFiles.length;
  out.rejected = (await q("DELETE FROM intakes WHERE status IN ('rejected','duplicate') AND claimed_at < now() - make_interval(days => $1)", [r.rejectedDays])).rowCount;
  out.claimed = (await q("DELETE FROM intakes WHERE status = 'claimed' AND claimed_at < now() - make_interval(years => $1)", [r.claimedYears])).rowCount;
  out.links = (await q("DELETE FROM intake_links l WHERE l.created_at < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM intakes i WHERE i.link_id = l.id)")).rowCount;
  out.outbox = (await q("DELETE FROM intake_outbox WHERE created_at < now() - interval '90 days' AND status <> 'pending'")).rowCount;
  return out;
}

// ------------------------------------------------------------ API keys
async function createKey(user, { name, isTest, allowedIps }) {
  const raw = `${isTest ? "sk_test_" : "sk_live_"}${crypto.randomBytes(24).toString("base64url")}`;
  const ips = splitText(allowedIps);
  const r = await one(
    "INSERT INTO intake_api_keys (name, key_hash, key_last4, is_test, allowed_ips, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [clean(name, 80) || "LINE OA Chatbot", sha(raw), raw.slice(-4), !!isTest, ips, user.id]
  );
  await audit(user, "intake_key_create", clean(name, 80), { id: r.id, test: !!isTest, ips });
  return { id: r.id, key: raw };
}
async function keyFromRequest(req) {
  const raw = String(req.get("X-Api-Key") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  if (!raw) throw bad("Send the API key in the X-Api-Key header", 401, { code: "NO_KEY" });
  const k = await one("SELECT * FROM intake_api_keys WHERE key_hash = $1 AND revoked_at IS NULL", [sha(raw)]);
  if (!k) throw bad("Invalid or revoked API key", 401, { code: "BAD_KEY" });
  const ip = clientIp();
  if (k.allowed_ips.length && !k.allowed_ips.includes(ip)) throw bad(`IP ${ip} ไม่อยู่ในรายการที่อนุญาตของ API key นี้`, 403, { code: "IP_NOT_ALLOWED" });
  q("UPDATE intake_api_keys SET last_used_at = now() WHERE id = $1", [k.id]).catch(() => {});
  return k;
}

// ------------------------------------------------------------ routers
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error(`[intake] ${req.method} ${req.path}:`, e);
    res.status(status).json({ ok: false, error: status >= 500 ? "เกิดข้อผิดพลาด กรุณาลองใหม่" : e.message, ...(e.extra || {}) });
  });

// Machine API for the chatbot: /api/v1/intake/...
const apiV1 = express.Router();
apiV1.use(express.json({ limit: "20kb" }));
apiV1.post("/intake/links", wrap(async (req, res) => {
  const key = await keyFromRequest(req);
  const out = await createLink(req.body || {}, { apiKey: key, source: "api", isTest: key.is_test });
  await audit(null, "intake_link", key.name, { linkId: out.linkId, matched: out.customer.matched, test: key.is_test });
  delete out.linkId;
  res.json(out);
}));
apiV1.get("/intake/customers", wrap(async (req, res) => {
  await keyFromRequest(req);
  const aliases = await all("SELECT site, alias FROM intake_aliases ORDER BY site, alias");
  res.json({ customers: (await siteList()).map((s) => ({ name: s, aliases: aliases.filter((a) => a.site === s).map((a) => a.alias) })) });
}));
apiV1.get("/intake/customers/match", wrap(async (req, res) => {
  await keyFromRequest(req);
  const site = await matchCustomer(req.query.q);
  res.json({ q: clean(req.query.q, 200), match: site ? { name: site } : null });
}));
apiV1.get("/intake/line-users/:id", wrap(async (req, res) => {
  await keyFromRequest(req);
  const u = await one("SELECT line_user_id, site, customer_text, contact_name, contact_phone, blocked FROM intake_line_users WHERE line_user_id = $1", [req.params.id]);
  res.json({ known: !!(u && u.site), blocked: !!(u && u.blocked), customer: u ? u.site : null, contactName: u ? u.contact_name : null, contactPhone: u ? u.contact_phone : null });
}));
apiV1.use((req, res) => res.status(404).json({ ok: false, error: "not found" }));

// Customer form (no login): /api/public/intake/:token
const publicApi = express.Router();
publicApi.get("/intake/:token", wrap(async (req, res) => {
  const link = await linkByToken(req.params.token);
  const st = linkState(link);
  if (st) return res.status(st.status).json({ ok: false, error: st.error, code: st.code, company: config3.company });
  const s = await settings();
  const ss = await siteSettings(link.site);
  const products = (await all("SELECT value FROM lookups WHERE kind='product' AND active ORDER BY sort, lower(value)")).map((r) => r.value);
  res.json({
    ok: true,
    customer: link.site || link.customer_text || "",
    matched: !!link.site,
    contactName: link.contact_name || "",
    contactPhone: link.contact_phone || "",
    contactEmail: link.contact_email || "",
    expiresAt: link.expires_at,
    test: link.is_test,
    channel: link.line_user_id ? "line" : "link",
    company: config3.company,
    products,
    severities: require("./intakeupdate").SEV_EN.map(([value, , hint]) => ({ value, hint })),
    attachments: ss && ss.attachments ? { maxFiles: s.attachMaxFiles, maxMb: s.attachMaxMb, ext: FILE_EXT } : null,
  });
}));
publicApi.post("/intake/:token/files", express.raw({ type: () => true, limit: "25mb" }), wrap(async (req, res) => {
  if (req.get("X-Requested-With") !== "fetch") throw bad("Invalid request", 403);
  const link = await linkByToken(req.params.token);
  const st = linkState(link);
  if (st) throw bad(st.error, st.status, { code: st.code });
  const name = decodeURIComponent(String(req.get("X-File-Name") || "file"));
  res.json({ ok: true, file: await saveFile(link, name, req.get("Content-Type"), req.body) });
}));
publicApi.delete("/intake/:token/files/:id", wrap(async (req, res) => {
  const link = await linkByToken(req.params.token);
  if (linkState(link)) return res.json({ ok: true });
  const f = await one("DELETE FROM intake_files WHERE id = $1 AND link_id = $2 AND intake_id IS NULL RETURNING path", [req.params.id, link.id]);
  if (f) removeStored(f.path);
  res.json({ ok: true });
}));
publicApi.post("/intake/:token", express.json({ limit: "64kb" }), wrap(async (req, res) => {
  if (req.get("X-Requested-With") !== "fetch") throw bad("Invalid request", 403);
  res.json(await submit(req.params.token, req.body || {}));
}));
publicApi.use((req, res) => res.status(404).json({ ok: false, error: "not found" }));

// ------------------------------------------------------------ internal (logged-in) routes, mounted on the v3 api router
function mountInternal(api, { need, wrap: w }) {
  const LIST = `SELECT i.*, cb.display_name AS claimed_by_name, ow.display_name AS owner_name, c.cs_number, c.case_no,
      ro.id AS recent_owner_id, ro.display_name AS recent_owner_name, ro.start_date AS recent_owner_date, s.team AS site_team,
      (SELECT count(*)::int FROM intake_files f WHERE f.intake_id = i.id) AS files
    FROM intakes i LEFT JOIN users cb ON cb.id = i.claimed_by LEFT JOIN users ow ON ow.id = i.owner_id
    LEFT JOIN cases c ON c.id = i.case_id LEFT JOIN intake_sites s ON s.site = i.site
    LEFT JOIN LATERAL (SELECT u2.id, u2.display_name, c2.start_date FROM cases c2 JOIN users u2 ON u2.id = c2.owner_id AND u2.active
      WHERE c2.site = i.site AND c2.id IS DISTINCT FROM i.case_id ORDER BY c2.start_at DESC NULLS LAST, c2.id DESC LIMIT 1) ro ON true`;

  api.get("/intake", w(async (req, res) => {
    const st = String(req.query.status || "pending");
    let where = "i.status = 'pending'";
    if (st === "claimed") where = "i.status = 'claimed' AND i.claimed_at > now() - interval '30 days'";
    else if (st === "closed") where = "i.status IN ('rejected','duplicate') AND i.claimed_at > now() - interval '90 days'";
    else if (st === "held") where = "i.status = 'pending' AND i.held";
    const rows = await all(`${LIST} WHERE ${where} ORDER BY i.created_at ${st === "pending" || st === "held" ? "ASC" : "DESC"} LIMIT 300`);
    const counts = await one(
      `SELECT count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='pending' AND held)::int AS held,
              count(*) FILTER (WHERE status='claimed' AND claimed_at > now() - interval '30 days')::int AS claimed,
              count(*) FILTER (WHERE status IN ('rejected','duplicate') AND claimed_at > now() - interval '90 days')::int AS closed
       FROM intakes`
    );
    res.json({ items: rows, counts, now: new Date().toISOString() });
  }));
  api.get("/intake/count", w(async (req, res) => res.json(await one("SELECT count(*)::int AS pending FROM intakes WHERE status = 'pending'"))));
  api.get("/intake/:id(\\d+)", w(async (req, res) => {
    const r = await one(`${LIST} WHERE i.id = $1`, [req.params.id]);
    if (!r) throw bad("ไม่พบคำขอนี้", 404);
    const files = await all("SELECT id, file_name, mime, size FROM intake_files WHERE intake_id = $1 ORDER BY id", [r.id]);
    const prior = r.line_user_id ? await all("SELECT id, req_no, subject, status, created_at FROM intakes WHERE line_user_id = $1 AND id <> $2 ORDER BY id DESC LIMIT 5", [r.line_user_id, r.id]) : [];
    const usable = !["rejected", "duplicate"].includes(r.status);
    res.json({ item: r, files, prior, updateUrl: usable ? updateUrl(r.id) : null });
  }));
  api.get("/intake/:id(\\d+)/files/:fid(\\d+)", w(async (req, res) => {
    const f = await one("SELECT * FROM intake_files WHERE id = $1 AND intake_id = $2", [req.params.fid, req.params.id]);
    if (!f || !fs.existsSync(f.path)) throw bad("ไม่พบไฟล์ (อาจถูกลบตามรอบเก็บข้อมูล)", 404);
    const inline = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$/.test(f.mime);
    res.set("Content-Type", inline ? f.mime : "application/octet-stream");
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    res.set("Content-Security-Policy", "sandbox");
    fs.createReadStream(f.path).pipe(res);
  }));
  api.post("/intake/:id(\\d+)/claim", need("case_create"), w(async (req, res) => res.json(await claim(req.user, Number(req.params.id), req.body || {}))));
  api.post("/intake/:id(\\d+)/reject", need("case_create"), w(async (req, res) => res.json(await reject(req.user, Number(req.params.id), req.body || {}))));
  // Release a held request: admins and managers (anyone who can reassign cases).
  api.post("/intake/:id(\\d+)/release", need("case_reassign"), w(async (req, res) => {
    const r = await one("UPDATE intakes SET held = false WHERE id = $1 AND held RETURNING *", [req.params.id]);
    if (r) {
      await audit(req.user, "intake_release", r.req_no);
      notifyNew(r).catch(() => {});
      mail().onReleased(r).catch((e) => console.error("[intake] email ack on release:", e.message));
    }
    res.json({ ok: true });
  }));
  // Engineer: one-time link to send by email/chat (customers not on LINE, or pilots before LINE OA is ready).
  api.post("/intake/manual-link", need("case_create"), w(async (req, res) => {
    const b = req.body || {};
    if (!clean(b.customer)) throw bad("กรุณาเลือกลูกค้า");
    const email = clean(b.contactEmail, 200);
    if (b.sendEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("กรุณาใส่อีเมลลูกค้าที่ถูกต้อง");
    const s = await settings();
    const out = await createLink({ customer: b.customer, contactName: b.contactName, contactPhone: b.contactPhone, contactEmail: email }, { user: req.user, source: "manual", isTest: !!b.test, minutes: s.manualLinkHours * 60 });
    if (b.sendEmail) {
      const r = await graph.sendMail({
        to: [email],
        cc: req.user.email ? [req.user.email] : [],
        subject: `${b.test ? "[TEST] " : ""}Sinostech Support: case form link`,
        html: cm.linkEmailHtml({ name: clean(b.contactName, 120), customer: out.customer.site || b.customer, url: out.url, expiresAt: out.expiresAt, sender: req.user.display_name, note: clean(b.message, 1000) }),
      });
      out.emailed = { to: email, cc: req.user.email || null, dryRun: !!r.dryRun };
    }
    await audit(req.user, "intake_link_manual", b.customer, { linkId: out.linkId, test: !!b.test, emailedTo: b.sendEmail ? email : null });
    res.json(out);
  }));

  // ---------- hotline (shown to everyone, editable with its own permission)
  api.get("/hotline", w(async (req, res) => res.json({ hotline: await hotline(), hours: await businessHours() })));
  api.put("/hotline", need("hotline_edit"), w(async (req, res) => res.json({ ok: true, hotline: await saveHotline(req.user, req.body || {}) })));

  // ---------- admin
  const admin = need("settings_manage");
  api.get("/intake-admin", admin, w(async (req, res) => {
    const s = await settings();
    const sites = await siteList();
    const ss = await all("SELECT s.*, u.display_name AS owner_name FROM intake_sites s LEFT JOIN users u ON u.id = s.owner_id");
    const aliases = await all("SELECT * FROM intake_aliases ORDER BY site, alias");
    const open = await all("SELECT site, count(*)::int AS n FROM cases WHERE closed_at IS NULL GROUP BY site");
    const keys = await all("SELECT k.id, k.name, k.key_last4, k.is_test, k.allowed_ips, k.created_at, k.last_used_at, k.revoked_at, u.display_name AS created_by, (SELECT count(*)::int FROM intake_links l WHERE l.api_key_id = k.id AND l.created_at > now() - interval '1 day') AS links_today FROM intake_api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at NULLS FIRST, k.id");
    const lineUsers = await all(
      `SELECT l.*, (SELECT count(*)::int FROM intakes i WHERE i.line_user_id = l.line_user_id) AS requests,
              (SELECT req_no FROM intakes i WHERE i.line_user_id = l.line_user_id ORDER BY id DESC LIMIT 1) AS last_req
       FROM intake_line_users l ORDER BY (l.site IS NULL) DESC, l.blocked DESC, l.last_seen DESC LIMIT 300`
    );
    const outbox = await all("SELECT o.*, i.req_no FROM intake_outbox o LEFT JOIN intakes i ON i.id = o.intake_id ORDER BY o.id DESC LIMIT 50");
    res.json({
      settings: { ...s, webhookSecret: s.webhookSecret },
      sites: sites.map((name) => {
        const x = ss.find((r) => r.site === name) || {};
        return { site: name, owner_id: x.owner_id || null, owner_name: x.owner_name || null, team: x.team || null, attachments: !!x.attachments, domains: x.domains || [], aliases: aliases.filter((a) => a.site === name).map((a) => a.alias), open: (open.find((o) => o.site === name) || {}).n || 0 };
      }),
      keys,
      lineUsers,
      outbox,
      apiBase: `${config3.baseUrl}/api/v1`,
      fileExt: FILE_EXT,
      email: await mail().status(),
    });
  }));
  api.put("/intake-admin/settings", admin, w(async (req, res) => {
    const b = req.body || {};
    const cur = (await getSetting("intake", null)) || {};
    const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
    const hm = (v, def) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : def);
    const next = {
      ...cur,
      linkMinutes: num(b.linkMinutes, 10, 24 * 60, 60),
      manualLinkHours: num(b.manualLinkHours, 1, 168, 24),
      notifyTo: splitList(b.notifyTo || "").join(", "),
      testNotifyTo: splitList(b.testNotifyTo || "").join(", "),
      telegram: !!b.telegram,
      reminder: { afterMinutes: num(b.reminder?.afterMinutes, 15, 24 * 60, 60), everyMinutes: num(b.reminder?.everyMinutes, 15, 24 * 60, 60), start: hm(b.reminder?.start, "06:00"), end: hm(b.reminder?.end, "22:00") },
      linksPerLinePerHour: num(b.linksPerLinePerHour, 1, 50, 3),
      burst: { count: num(b.burst?.count, 2, 500, 5), minutes: num(b.burst?.minutes, 1, 240, 10) },
      attachMaxFiles: num(b.attachMaxFiles, 1, 10, 5),
      attachMaxMb: num(b.attachMaxMb, 1, 20, 10),
      webhookUrl: /^https:\/\/[^\s]+$/.test(String(b.webhookUrl || "")) ? String(b.webhookUrl).trim().slice(0, 500) : b.webhookUrl ? (() => { throw bad("Webhook URL ต้องขึ้นต้นด้วย https://"); })() : "",
    };
    if (b.rotateSecret) next.webhookSecret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    await setSetting("intake", next);
    if (next.webhookUrl && !cur.webhookUrl) await q("UPDATE intake_outbox SET status = 'pending', next_at = now() WHERE status = 'no_url'");
    await audit(req.user, "intake_settings", null, { ...next, webhookSecret: b.rotateSecret ? "rotated" : undefined });
    res.json({ ok: true });
  }));
  api.put("/intake-admin/sites", admin, w(async (req, res) => {
    const b = req.body || {};
    const site = clean(b.site, 120);
    if (!(await siteList()).includes(site)) throw bad("ไม่พบ Site นี้");
    const domains = [...new Set(splitText(b.domains).map((x) => clean(x, 120).toLowerCase().replace(/^.*@/, "")).filter(Boolean))];
    const badDom = domains.find((x) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x));
    if (badDom) throw bad(`โดเมน “${badDom}” ไม่ถูกต้อง ใส่แบบ ktb.co.th`);
    const pub = domains.find((x) => mail().PUBLIC_DOMAINS.includes(x));
    if (pub) throw bad(`ใส่ ${pub} ไม่ได้ เพราะเป็น email ส่วนตัวที่ใครก็สมัครได้`);
    const taken = domains.length ? await one("SELECT site, x FROM intake_sites, unnest(domains) x WHERE site <> $1 AND x = ANY($2) LIMIT 1", [site, domains]) : null;
    if (taken) throw bad(`โดเมน ${taken.x} ผูกกับลูกค้า ${taken.site} อยู่แล้ว`);
    await q(
      `INSERT INTO intake_sites (site, owner_id, team, attachments, domains, updated_at) VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (site) DO UPDATE SET team = EXCLUDED.team, attachments = EXCLUDED.attachments, domains = EXCLUDED.domains, updated_at = now()`,
      [site, null, clean(b.team, 40) || null, !!b.attachments, domains]
    );
    const aliases = [...new Set(splitText(b.aliases).map((a) => clean(a, 120)).filter(Boolean))];
    await tx(async (c) => {
      await c.query("DELETE FROM intake_aliases WHERE site = $1", [site]);
      for (const a of aliases) {
        const n = norm(a);
        if (!n) continue;
        const r = await c.query("INSERT INTO intake_aliases (site, alias, norm) VALUES ($1,$2,$3) ON CONFLICT (norm) DO NOTHING", [site, a, n]);
        if (!r.rowCount) throw bad(`ชื่อเรียก “${a}” ถูกใช้กับลูกค้ารายอื่นแล้ว`);
      }
    });
    await audit(req.user, "intake_site", site, { team: b.team, attachments: !!b.attachments, aliases, domains });
    res.json({ ok: true });
  }));
  api.put("/intake-admin/email", admin, w(async (req, res) => res.json({ ok: true, settings: await mail().saveEmailSettings(req.user, req.body || {}) })));
  api.post("/intake-admin/email/poll", admin, w(async (req, res) => res.json({ ok: true, ...(await mail().poll({ manual: true })) })));
  api.post("/intake-admin/email/simulate", admin, w(async (req, res) => res.json({ ok: true, ...(await mail().simulate(req.user, req.body || {})) })));
  api.post("/intake-admin/email/:id(\\d+)/retry", admin, w(async (req, res) => res.json({ ok: true, ...(await mail().retry(req.user, Number(req.params.id))) })));
  api.post("/intake-admin/keys", admin, w(async (req, res) => res.json({ ok: true, ...(await createKey(req.user, req.body || {})) })));
  api.delete("/intake-admin/keys/:id(\\d+)", admin, w(async (req, res) => {
    const r = await one("UPDATE intake_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name", [req.params.id]);
    if (r) await audit(req.user, "intake_key_revoke", r.name, { id: Number(req.params.id) });
    res.json({ ok: true });
  }));
  api.put("/intake-admin/keys/:id(\\d+)", admin, w(async (req, res) => {
    const ips = splitText(req.body?.allowedIps);
    await q("UPDATE intake_api_keys SET allowed_ips = $2 WHERE id = $1", [req.params.id, ips]);
    await audit(req.user, "intake_key_ips", String(req.params.id), { ips });
    res.json({ ok: true });
  }));
  api.put("/intake-admin/line-users/:id", admin, w(async (req, res) => {
    const b = req.body || {};
    const site = b.site ? clean(b.site, 120) : null;
    if (site && !(await siteList()).includes(site)) throw bad("ไม่พบ Site นี้");
    const r = await one("UPDATE intake_line_users SET site = COALESCE($2, site), blocked = COALESCE($3, blocked) WHERE line_user_id = $1 RETURNING *", [req.params.id, site, typeof b.blocked === "boolean" ? b.blocked : null]);
    if (!r) throw bad("ไม่พบบัญชี LINE นี้", 404);
    if (site) await q("UPDATE intakes SET site = $2 WHERE line_user_id = $1 AND site IS NULL AND status = 'pending'", [req.params.id, site]);
    await audit(req.user, "intake_line_user", req.params.id, { site, blocked: b.blocked });
    res.json({ ok: true });
  }));
  api.post("/intake-admin/simulate", admin, w(async (req, res) => {
    const b = req.body || {};
    const out = await createLink(b, { user: req.user, source: "simulator", isTest: b.test !== false });
    await audit(req.user, "intake_simulate", b.customer, { linkId: out.linkId, test: b.test !== false });
    res.json(out);
  }));
  api.post("/intake-admin/outbox/:id(\\d+)/retry", admin, w(async (req, res) => {
    await q("UPDATE intake_outbox SET status = 'pending', next_at = now(), attempts = 0 WHERE id = $1", [req.params.id]);
    res.json({ ok: true, ...(await deliver()) });
  }));
  api.post("/intake-admin/reminders/run", admin, w(async (req, res) => res.json({ ok: true, ...(await runReminders()) })));
  api.delete("/intake-admin/test-data", admin, w(async (req, res) => {
    const files = await all("SELECT f.path FROM intake_files f JOIN intakes i ON i.id = f.intake_id WHERE i.is_test");
    files.forEach((f) => removeStored(f.path));
    const n = (await q("DELETE FROM intakes WHERE is_test AND status <> 'claimed'")).rowCount;
    await q("DELETE FROM intake_outbox WHERE is_test");
    await q("DELETE FROM intake_emails WHERE is_test");
    await audit(req.user, "intake_test_cleanup", null, { removed: n });
    res.json({ ok: true, removed: n });
  }));
}

module.exports = {
  apiV1, publicApi, mountInternal, createLink, submit, claim, reject, runReminders, deliver, runRetention, matchCustomer, norm, settings, nextReqNo,
  FILE_EXT, unknownCustomerLabel, storeIntakeFile, removeStored, notifyNew, isAfterHours, businessHours, hotline, hotlineForCustomers, teamRecipients, customerName, intakeUrl, SEV_COLOR, siteList,
};
