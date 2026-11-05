// Customer requests by email.
// A shared mailbox (e.g. service@sinostech.co.th) is read through Microsoft Graph every 2 minutes:
//   - mail from a registered customer domain (somying@ktb.co.th -> KTB) becomes a request REQ-YYYY-NNNN,
//     the customer gets a reply in the same thread with the number;
//   - a reply that carries [REQ-YYYY-NNNN] in the subject is added to that request (or to its case);
//   - internal (@sinostech.co.th), automatic and bulk mail is ignored;
//   - unknown / personal domains open as normal requests (customer confirmed on the case later);
//     replies without a REQ number, floods and SPF/DMARC failures wait for an admin.
// Every processed message is moved to a folder so the inbox shows only what the system has not handled.
// The app's Graph permission must be limited to this one mailbox (Exchange RBAC for Applications).
const crypto = require("crypto");
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const telegram = require("../telegram");
const { esc, shell, fieldTable, button } = require("../emails");
const d = require("../dates");
const { q, one, all, tx, getSetting, setSetting, audit } = require("./db");
const repo = require("./caserepo");

const intake = () => require("./intake");

const DEFAULTS = {
  enabled: false,
  mailbox: "",
  autoReply: true,
  unknownDomain: "accept", // accept (normal request; customer confirmed on the case) | hold | ignore
  ignoreDomains: ["sinostech.co.th"],
  perSenderPerHour: 5,
  keepDays: 365,
  folder: "Sino Case - ประมวลผลแล้ว",
  startedAt: null,
};
const PUBLIC_DOMAINS = ["gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "icloud.com", "me.com", "msn.com", "hotmail.co.th", "yahoo.co.th"];

const clean = (s, max = 500) => (s === undefined || s === null ? "" : String(s).replace(/\u0000/g, "").trim().slice(0, max));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const lower = (s) => String(s || "").trim().toLowerCase();
const domainOf = (email) => lower(email).split("@")[1] || "";
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
const REQ_RE = /\[?\b(REQ-\d{4}-\d{4,})\b\]?/i;
const PREFIX_RE = /^\s*((re|fw|fwd|aw|sv|wg|tr|ตอบกลับ|ส่งต่อ)\s*(\[\d+\])?\s*:\s*)+/i;
const TAG_RE = /\[[^\]]*\b(REQ|CASE)-\d{4}-\d{4,}[^\]]*\]/gi;
const baseSubject = (s) => clean(s, 300).replace(/\[ทดสอบ\]\s*/g, "").replace(PREFIX_RE, "").replace(TAG_RE, "").replace(/\b(REQ|CASE)-\d{4}-\d{4,}\b/gi, "").replace(PREFIX_RE, "").replace(/\s+/g, " ").trim();

async function emailSettings() {
  const s = await intake().settings();
  const e = { ...DEFAULTS, ...(s.email || {}) };
  e.mailbox = lower(e.mailbox);
  e.ignoreDomains = (e.ignoreDomains || []).map(lower).filter(Boolean);
  return e;
}
async function saveEmailSettings(user, b) {
  const s = (await getSetting("intake", null)) || {};
  const cur = { ...DEFAULTS, ...(s.email || {}) };
  const mailbox = lower(b.mailbox);
  if (mailbox && !isEmail(mailbox)) throw bad("ชื่อกล่องจดหมายไม่ถูกต้อง");
  if (b.enabled && !mailbox) throw bad("กรุณาใส่กล่องจดหมายก่อนเปิดใช้");
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
  const next = {
    ...cur,
    enabled: !!b.enabled,
    mailbox,
    autoReply: b.autoReply !== false,
    unknownDomain: ["accept", "hold", "ignore"].includes(b.unknownDomain) ? b.unknownDomain : "accept",
    ignoreDomains: [...new Set(String(Array.isArray(b.ignoreDomains) ? b.ignoreDomains.join(",") : b.ignoreDomains || "").split(/[,;\s]+/).map((x) => lower(x).replace(/^@/, "")).filter(Boolean))],
    perSenderPerHour: num(b.perSenderPerHour, 1, 100, 5),
    keepDays: num(b.keepDays, 30, 3650, 365),
  };
  // Mail that arrived before the channel was switched on (or before the mailbox changed) is never turned into requests.
  if (next.enabled && (!cur.enabled || cur.mailbox !== mailbox || !cur.startedAt)) next.startedAt = new Date().toISOString();
  await setSetting("intake", { ...s, email: next });
  await audit(user, "intake_email_settings", mailbox, { enabled: next.enabled, autoReply: next.autoReply, unknownDomain: next.unknownDomain, ignoreDomains: next.ignoreDomains });
  return next;
}

// ------------------------------------------------------------ Graph
const mbPath = (mb) => `/users/${encodeURIComponent(mb)}`;
const live = () => !config.mock;
let folderCache = { mb: null, id: null };

async function ensureFolder(e) {
  if (folderCache.mb === e.mailbox && folderCache.id) return folderCache.id;
  const name = e.folder.replace(/'/g, "''");
  const found = await graph.graph("get", `${mbPath(e.mailbox)}/mailFolders?$filter=displayName eq '${encodeURIComponent(name)}'&$select=id`);
  let id = found.value && found.value[0] && found.value[0].id;
  if (!id) id = (await graph.graph("post", `${mbPath(e.mailbox)}/mailFolders`, { displayName: e.folder })).id;
  folderCache = { mb: e.mailbox, id };
  return id;
}

const SELECT = "id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,hasAttachments,body,internetMessageHeaders";
async function listInbox(e) {
  const r = await graph.graph("get", `${mbPath(e.mailbox)}/mailFolders/inbox/messages?$top=20&$orderby=receivedDateTime asc&$select=${SELECT}`, undefined, {
    Prefer: 'outlook.body-content-type="text"',
  });
  return r.value || [];
}
async function attachmentsOf(e, m) {
  if (m.simAttachments) return m.simAttachments.map((a) => ({ ...a, buffer: Buffer.from(a.contentBytes || "", "base64") }));
  if (!m.hasAttachments || !live()) return [];
  const list = await graph.graph("get", `${mbPath(e.mailbox)}/messages/${m.id}/attachments?$select=id,name,contentType,size,isInline`);
  const out = [];
  for (const a of list.value || []) {
    if (a["@odata.type"] && a["@odata.type"] !== "#microsoft.graph.fileAttachment") {
      out.push({ name: a.name, skipped: "แนบเป็น email หรือรายการ Outlook" });
      continue;
    }
    if (a.isInline && a.size < 30 * 1024) continue; // logos and signature images
    const full = await graph.graph("get", `${mbPath(e.mailbox)}/messages/${m.id}/attachments/${a.id}`);
    out.push({ name: a.name, contentType: a.contentType, buffer: Buffer.from(full.contentBytes || "", "base64") });
  }
  return out;
}
async function moveDone(e, m, folderId) {
  if (!live() || m.simulated) return;
  await graph.graph("post", `${mbPath(e.mailbox)}/messages/${m.id}/move`, { destinationId: folderId });
}
async function findByMessageId(e, mid) {
  const r = await graph.graph("get", `${mbPath(e.mailbox)}/messages?$filter=internetMessageId eq '${encodeURIComponent(mid.replace(/'/g, "''"))}'&$select=id,subject`);
  return (r.value || [])[0] || null;
}

/** Reply in the customer's thread from the shared mailbox (keeps In-Reply-To so Outlook groups it). */
async function replyInThread(e, messageId, { subject, html, cc = [] }) {
  if (config.dryRunEmail || !live() || String(messageId).startsWith("sim-")) {
    console.log(`[DRY RUN email reply] in-reply-to=${messageId} subject=${subject}`);
    return { dryRun: true };
  }
  const orig = await findByMessageId(e, messageId);
  if (!orig) throw new Error("ไม่พบ email ต้นฉบับในกล่องจดหมาย");
  const draft = await graph.graph("post", `${mbPath(e.mailbox)}/messages/${orig.id}/createReply`, {});
  const patch = { subject, body: { contentType: "HTML", content: html } };
  if (cc.length) patch.ccRecipients = cc.map((address) => ({ emailAddress: { address } }));
  await graph.graph("patch", `${mbPath(e.mailbox)}/messages/${draft.id}`, patch);
  await graph.graph("post", `${mbPath(e.mailbox)}/messages/${draft.id}/send`, {});
  return { sent: true };
}

// ------------------------------------------------------------ reading a message
function headerMap(m) {
  const h = {};
  (m.internetMessageHeaders || []).forEach((x) => (h[lower(x.name)] = String(x.value || "")));
  return h;
}
function autoReason(m, from, h) {
  const local = from.split("@")[0];
  if (h["auto-submitted"] && lower(h["auto-submitted"]) !== "no") return "email อัตโนมัติ (Auto-Submitted)";
  if (/^(bulk|junk|list)$/.test(lower(h.precedence))) return "email แบบกระจาย (Precedence)";
  if (h["list-id"] || h["list-unsubscribe"]) return "จดหมายข่าว / mailing list";
  if (h["x-autoreply"] || h["x-autorespond"]) return "ตอบกลับอัตโนมัติ";
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+.-]|$)/.test(local)) return "ผู้ส่งเป็นระบบอัตโนมัติ";
  if (/^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|ตอบกลับอัตโนมัติ|undeliver(able|ed)|delivery (status notification|has failed)|mail delivery failed|ไม่สามารถส่ง)/i.test(m.subject || "")) return "ตอบกลับอัตโนมัติ / ส่งไม่ถึง";
  return null;
}
/** Plain text of the new part of a message: quoted history and long blank runs removed. */
function bodyText(m) {
  let t = String((m.body && m.body.content) || "");
  if (m.body && lower(m.body.contentType) === "html") {
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  const lines = t.replace(/\r/g, "").split("\n");
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (/^\s*-{2,}\s*(original message|ข้อความต้นฉบับ)\s*-{2,}/i.test(l)) break;
    if (/^\s*_{10,}\s*$/.test(l)) break;
    if (/^\s*On .{5,200} wrote:\s*$/i.test(l)) break;
    if (/^\s*(from|จาก)\s*:\s*\S/i.test(l) && /^\s*(sent|date|ส่ง|วันที่|to|ถึง)\s*:/i.test(lines[n + 1] || "")) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l.replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
}
function guessSeverity(text) {
  const t = lower(text);
  if (/(critical|ระบบล่ม|ล่มทั้งหมด|ใช้งานไม่ได้ทั้งหมด|system down|outage|ทั้งระบบใช้ไม่ได้)/.test(t)) return "Critical";
  if (/(urgent|ด่วน|ใช้งานไม่ได้|ใช้ไม่ได้|ไม่สามารถใช้งาน|login ไม่ได้|เข้าระบบไม่ได้|error)/.test(t)) return "High";
  if (/(สอบถาม|ขอข้อมูล|inquiry|question|ขอคำแนะนำ|how to|วิธีการ)/.test(t)) return "Request information";
  return "Medium";
}
async function guessProduct(text) {
  const t = lower(text);
  const products = (await all("SELECT value FROM lookups WHERE kind = 'product' AND active ORDER BY length(value) DESC")).map((r) => r.value);
  return products.find((p) => {
    const x = lower(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${x}([^a-z0-9]|$)`).test(t);
  }) || null;
}
async function siteForDomain(domain) {
  if (!domain || PUBLIC_DOMAINS.includes(domain)) return null;
  const r = await one("SELECT site FROM intake_sites WHERE $1 = ANY(domains) OR EXISTS (SELECT 1 FROM unnest(domains) x WHERE $1 LIKE '%.' || x) LIMIT 1", [domain]);
  return r ? r.site : null;
}

async function record(m, from, fromName, decision, reason, extra = {}) {
  await q(
    `INSERT INTO intake_emails (graph_id, message_id, conversation_id, from_email, from_name, subject, received_at, decision, reason, intake_id, case_id, is_test, replied)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (message_id) DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, intake_id = EXCLUDED.intake_id, case_id = EXCLUDED.case_id, replied = EXCLUDED.replied`,
    [m.id || null, m.internetMessageId, m.conversationId || null, from || null, fromName || null, clean(m.subject, 300), m.receivedDateTime || new Date().toISOString(),
      decision, reason || null, extra.intakeId || null, extra.caseId || null, !!m.isTest, !!extra.replied]
  );
}

async function saveAttachments(e, m, intakeId) {
  const files = await attachmentsOf(e, m);
  const kept = [];
  const skipped = [];
  for (const f of files) {
    if (f.skipped) {
      skipped.push(`${f.name} (${f.skipped})`);
      continue;
    }
    const r = await intake().storeIntakeFile(intakeId, f.name, f.contentType, f.buffer);
    if (r && r.skipped) skipped.push(`${r.skipped} (${r.why})`);
    else if (r) kept.push(r.file_name);
  }
  return { kept, skipped };
}
const filesNote = ({ kept, skipped }) =>
  [kept.length ? `ไฟล์แนบ: ${kept.join(", ")}` : "", skipped.length ? `ไฟล์ที่ไม่ได้เก็บ (ขอจากลูกค้าเพิ่มถ้าจำเป็น): ${skipped.join(", ")}` : ""].filter(Boolean).join("\n");

/** Decide what to do with one message. Returns { decision, reason, intakeId }. */
async function processMessage(e, m) {
  const from = lower(m.from && m.from.emailAddress && m.from.emailAddress.address);
  const fromName = clean(m.from && m.from.emailAddress && m.from.emailAddress.name, 120);
  const domain = domainOf(from);
  const h = headerMap(m);
  const subject = clean(m.subject, 300) || "(ไม่มีหัวข้อ)";
  const ignore = async (reason) => {
    await record(m, from, fromName, "ignored", reason);
    return { decision: "ignored", reason };
  };

  if (!from) return ignore("ไม่มีผู้ส่ง");
  if (from === e.mailbox) return ignore("ส่งจากกล่องนี้เอง");
  if (e.ignoreDomains.some((x) => domain === x || domain.endsWith("." + x))) return ignore(`โดเมนภายใน (@${domain})`);
  const auto = autoReason(m, from, h);
  if (auto) return ignore(auto);
  if (!m.simulated && e.startedAt && m.receivedDateTime && new Date(m.receivedDateTime) < new Date(e.startedAt)) return ignore("ได้รับก่อนเปิดใช้ช่องทางนี้");

  const text = bodyText(m);
  const site = await siteForDomain(domain);
  // Exchange Online stamps the sender checks; a failed SPF/DMARC may be someone pretending to be the customer.
  const authFail = /\b(dmarc=fail|spf=fail|compauth=fail)\b/i.test(h["authentication-results"] || "");

  // 1) Reply carrying [REQ-…] (or the same subject from the same sender within 3 days) -> add to that request.
  const tagged = (subject.match(REQ_RE) || [])[1];
  let target = null;
  if (tagged) {
    const i = await one("SELECT * FROM intakes WHERE req_no = $1", [tagged.toUpperCase()]);
    if (i && (lower(i.contact_email) === from || (site && site === i.site))) target = i;
  }
  if (!target && baseSubject(subject)) {
    const rows = await all(
      `SELECT * FROM intakes WHERE channel = 'email' AND lower(contact_email) = $1 AND status IN ('pending','claiming','claimed')
         AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 20`,
      [from]
    );
    target = rows.find((r) => lower(baseSubject(r.subject)) === lower(baseSubject(subject))) || null;
  }
  if (target && !authFail && target.status !== "rejected" && target.status !== "duplicate") return appendTo(e, m, target, { from, fromName, subject, text });

  // 2) New request — or held for an admin.
  let holdReason = null;
  if (authFail) holdReason = "ผู้ส่งไม่ผ่านการตรวจ SPF/DMARC อาจเป็น email ปลอม ตรวจกับลูกค้าก่อน";
  else if (!site && e.unknownDomain === "ignore") return ignore(`โดเมน @${domain} ยังไม่ผูกกับลูกค้า`);
  else if (!site && e.unknownDomain === "hold") {
    holdReason = PUBLIC_DOMAINS.includes(domain) ? `ส่งจาก email ส่วนตัว (@${domain}) ระบุบริษัทไม่ได้` : `โดเมน @${domain} ยังไม่ผูกกับลูกค้า`;
  } else if (h["in-reply-to"] || /^\s*(re|aw|sv|ตอบกลับ)\s*:/i.test(subject)) {
    holdReason = "ตอบกลับ email เดิมที่ไม่มีเลข REQ";
  } else {
    const recent = await one("SELECT count(*)::int AS n FROM intakes WHERE channel = 'email' AND lower(contact_email) = $1 AND created_at > now() - interval '1 hour'", [from]);
    if (recent.n >= e.perSenderPerHour) holdReason = `ผู้ส่งรายนี้ส่งเกิน ${e.perSenderPerHour} เรื่องใน 1 ชั่วโมง`;
  }
  const s = await intake().settings();
  const afterHours = await intake().isAfterHours(m.receivedDateTime ? new Date(m.receivedDateTime) : new Date());
  const all4 = `${subject}\n${text}`;
  const severity = guessSeverity(all4);
  const product = await guessProduct(all4);
  const created = await tx(async (c) => {
    if (!holdReason && !m.isTest) {
      const burst = (await c.query("SELECT count(*)::int AS n FROM intakes WHERE NOT is_test AND created_at > now() - make_interval(mins => $1)", [s.burst.minutes])).rows[0].n;
      if (burst >= s.burst.count) holdReason = `มีคำขอเข้ามาเกิน ${s.burst.count} เรื่องใน ${s.burst.minutes} นาที`;
    }
    const reqNo = await intake().nextReqNo(c);
    const r = await c.query(
      `INSERT INTO intakes (req_no, is_test, held, hold_reason, channel, site, customer_text, contact_name, contact_email, contact_phone, product, severity, subject, detail, after_hours)
       VALUES ($1,$2,$3,$4,'email',$5,$6,$7,$8,$14,$9,$10,$11,$12,$13) RETURNING *`,
      [reqNo, !!m.isTest, !!holdReason, holdReason, site, site ? null : (PUBLIC_DOMAINS.includes(domain) ? from : domain), fromName || from.split("@")[0], from, product, severity,
        clean(baseSubject(subject) || subject, 150), text || "(ไม่มีเนื้อหา ดูไฟล์แนบ)", afterHours, phonesIn(text || "")[0] || null]
    );
    return r.rows[0];
  });
  const files = await saveAttachments(e, m, created.id);
  const note = filesNote(files);
  if (note) await q("UPDATE intakes SET detail = detail || $2 WHERE id = $1", [created.id, `\n\n${note}`]);
  const i = await one("SELECT * FROM intakes WHERE id = $1", [created.id]);
  let replied = false;
  if (!i.held && e.autoReply) replied = await ack(e, i, m.internetMessageId, subject, files.kept).then(() => true, (err) => (console.error("[mail-intake] ack:", err.message), false));
  await record(m, from, fromName, i.held ? "held" : "created", i.held ? holdReason : null, { intakeId: i.id, replied });
  await audit(null, "intake_email", i.req_no, { from, site, held: i.held, reason: holdReason, test: i.is_test });
  if (i.held) notifyHeld(i).catch((err) => console.error("[mail-intake] held notify:", err.message));
  else intake().notifyNew(i).catch((err) => console.error("[mail-intake] notify:", err.message));
  return { decision: i.held ? "held" : "created", reason: holdReason, intakeId: i.id, reqNo: i.req_no };
}

/** Thai / international phone numbers in free text, in the order they appear. */
function phonesIn(text) {
  const re = /(?:\+?66[\s-]?|0)(?:\d[\s-]?){8,9}\d?/g;
  const out = [];
  for (const m of String(text || "").matchAll(re)) {
    const digits = m[0].replace(/[^0-9+]/g, "");
    if (digits.replace("+", "").length >= 9 && digits.replace("+", "").length <= 11 && !out.includes(m[0].trim())) out.push(m[0].trim().replace(/[\s-]+$/, ""));
  }
  return out;
}

async function appendTo(e, m, i, { from, fromName, subject, text }) {
  // A reply with a call-back number fills in the request's phone when it has none (the rest stay visible in the text).
  const phones = phonesIn(text);
  if (phones.length && !i.contact_phone) {
    await q("UPDATE intakes SET contact_phone = $2 WHERE id = $1 AND contact_phone IS NULL", [i.id, phones[0]]);
    i.contact_phone = phones[0];
  }
  if (phones.length) await q("INSERT INTO intake_updates (intake_id, source, data) VALUES ($1,'email',$2)", [i.id, JSON.stringify({ phones, from })]);
  const files = await saveAttachments(e, m, i.id);
  const note = filesNote(files);
  const stamp = new Intl.DateTimeFormat("th-TH", { timeZone: config.tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(m.receivedDateTime || Date.now()));
  const body = [text || "(ไม่มีเนื้อหา)", note].filter(Boolean).join("\n\n");
  let caseId = null;
  if (i.status === "claimed" && i.case_id) {
    caseId = i.case_id;
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, created_by, is_system) VALUES ($1,$2,$3,$4,NULL,true)", [
      i.case_id, d.toISODate(d.today()), "ติดต่อลูกค้า", `Email จากลูกค้า ${fromName ? fromName + " " : ""}<${from}> · ${stamp}\nเรื่อง: ${subject}\n\n${body}`.slice(0, 6000),
    ]);
    await q("UPDATE cases SET updated_at = now() WHERE id = $1", [i.case_id]);
    notifyOwnerOfReply(i, { from, fromName, subject, body }).catch((err) => console.error("[mail-intake] owner notify:", err.message));
  } else {
    await q("UPDATE intakes SET detail = left(detail || $2, 20000) WHERE id = $1", [i.id, `\n\n--- email เพิ่มเติมจาก ${from} · ${stamp} ---\n${body}`]);
  }
  await record(m, from, fromName, "appended", `เพิ่มใน ${i.req_no}${caseId ? " (บันทึกใน Activity ของเคส)" : ""}${phones.length ? ` · พบเบอร์ ${phones.join(", ")}` : ""}`, { intakeId: i.id, caseId });
  return { decision: "appended", intakeId: i.id, reqNo: i.req_no, caseId };
}

// ------------------------------------------------------------ customer-facing mail (English, see customermail.js)
const cm = require("./customermail");
const upd = () => require("./intakeupdate");

async function ack(e, i, messageId, subject, files = []) {
  const afterHours = i.after_hours;
  const html = cm.ackHtml(i, {
    updateUrl: upd().updateUrl(i.id),
    afterHours,
    hours: await intake().businessHours(),
    hotline: afterHours ? await intake().hotlineForCustomers() : null,
    files,
  });
  const r = await replyInThread(e, messageId, { subject: cm.ackSubject(i, baseSubject(subject) || i.subject), html });
  await q("UPDATE intake_emails SET replied = true WHERE intake_id = $1 AND decision IN ('created','held')", [i.id]);
  return r;
}

/** The first message of an email request (the one to reply to). */
async function originOf(i) {
  return one("SELECT message_id, subject FROM intake_emails WHERE intake_id = $1 AND decision IN ('created','held') ORDER BY id LIMIT 1", [i.id]);
}

/** Admin released a held email request: thank the customer now (the reply was held back). */
async function onReleased(i) {
  if (i.channel !== "email") return;
  const e = await emailSettings();
  const o = await originOf(i);
  if (!o || !e.autoReply || !e.mailbox) return;
  const done = await one("SELECT replied FROM intake_emails WHERE intake_id = $1 AND decision IN ('created','held') ORDER BY id LIMIT 1", [i.id]);
  if (done && done.replied) return;
  await ack(e, i, o.message_id, o.subject);
}

/** Case claimed: reply in the customer's thread. Returns false when it could not (caller falls back to a new email). */
async function onClaimed(i, kase, owner) {
  if (i.channel !== "email") return false;
  const e = await emailSettings();
  const o = await originOf(i);
  if (!o || !e.mailbox) return false;
  const html = cm.claimedHtml(i, kase, owner, { updateUrl: upd().updateUrl(i.id) });
  await replyInThread(e, o.message_id, { subject: cm.claimedSubject(i, kase, baseSubject(o.subject) || i.subject), html, cc: owner.email ? [owner.email] : [] });
  return true;
}

/** Request closed without a case and the team chose to tell the customer. */
async function onClosed(i, message) {
  if (i.channel !== "email") return false;
  const e = await emailSettings();
  const o = await originOf(i);
  if (!o || !e.mailbox) return false;
  await replyInThread(e, o.message_id, { subject: cm.ackSubject(i, baseSubject(o.subject) || i.subject), html: cm.closedHtml(i, message) });
  return true;
}

// ------------------------------------------------------------ team notifications
async function notifyHeld(i) {
  const { to } = await intake().teamRecipients({ is_test: i.is_test });
  // Admins and managers: both can release or close a held request.
  const leads = (await all("SELECT email FROM users WHERE active AND role IN ('admin','manager') AND email IS NOT NULL")).map((r) => r.email);
  const rcpt = [...new Set([...(i.is_test ? to : leads.length ? leads : to)])];
  const html = shell(
    "#B07800",
    `<p style="margin:0 0 14px">มี email แจ้งเคส <strong>พักไว้ให้ Admin / Manager ตรวจ</strong>: ${esc(i.hold_reason || "")}</p>
${fieldTable([["เลขรับแจ้ง", i.req_no], ["จาก", `${i.contact_name} <${i.contact_email}>`], ["หัวข้อ", i.subject]])}
<p style="margin:14px 0;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(String(i.detail).slice(0, 1500))}</p>
<p style="margin:0 0 12px">ถ้าเป็นเคสจริง กด “ยืนยันว่าเป็นเคสจริง” (ลูกค้าจะได้ email ตอบรับตอนนั้น และทีมรับเคสได้ตามปกติ) ถ้าไม่ใช่เคส กด “ปิดคำขอ” · ถ้าโดเมนนี้เป็นของลูกค้า แจ้ง Admin เพิ่มโดเมนในหน้าตั้งค่า เพื่อไม่ให้ถูกพักครั้งต่อไป</p>
${button(intake().intakeUrl(i), "ตรวจคำขอ")}`
  );
  if (rcpt.length) await graph.sendMail({ to: rcpt, cc: [], subject: `${i.is_test ? "[ทดสอบ] " : ""}[รอตรวจ] email แจ้งเคส ${i.req_no} จาก ${i.contact_email}`, html }).catch((err) => console.error("[mail-intake] held mail:", err.message));
}

async function notifyOwnerOfReply(i, { from, fromName, subject, body }) {
  const k = await one("SELECT c.id, c.case_no, u.email, u.display_name FROM cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = $1", [i.case_id]);
  if (!k || !k.email) return;
  await graph.sendMail({
    to: [k.email],
    cc: [],
    subject: `${i.is_test ? "[ทดสอบ] " : ""}[ลูกค้าตอบกลับ] ${k.case_no || i.req_no} · ${i.site || ""} · ${baseSubject(subject)}`,
    html: shell("#1F4FD1", `<p style="margin:0 0 14px">ลูกค้าตอบกลับทาง email ในเคส <strong>${esc(k.case_no || "")}</strong> ระบบบันทึกใน Activity ของเคสแล้ว</p>
${fieldTable([["จาก", `${fromName || ""} <${from}>`], ["หัวข้อ", subject]])}
<p style="margin:14px 0;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(String(body).slice(0, 3000))}</p>
${button(`${config3.baseUrl}/#/case/${k.id}`, "เปิดเคส")}`),
  });
}

// ------------------------------------------------------------ polling
let running = false;
async function poll({ manual = false } = {}) {
  const e = await emailSettings();
  if (!e.enabled || !e.mailbox) return { skipped: "ยังไม่เปิดใช้" };
  if (!live()) return { skipped: "โหมดข้อมูลจำลอง (MOCK_DATA) ไม่อ่านกล่องจริง" };
  if (running) return { busy: true };
  running = true;
  const out = { read: 0, created: 0, appended: 0, held: 0, ignored: 0, errors: 0 };
  try {
    const folderId = await ensureFolder(e);
    const msgs = await listInbox(e);
    for (const m of msgs) {
      out.read++;
      if (!m.internetMessageId) m.internetMessageId = `graph-${m.id}`;
      const seen = await one("SELECT decision FROM intake_emails WHERE message_id = $1", [m.internetMessageId]);
      if (seen && seen.decision === "error") continue; // left in the inbox until an admin retries
      try {
        if (!seen) {
          const r = await processMessage(e, m);
          out[r.decision] = (out[r.decision] || 0) + 1;
        }
        await moveDone(e, m, folderId);
      } catch (err) {
        out.errors++;
        console.error("[mail-intake] message:", err.message);
        const from = lower(m.from && m.from.emailAddress && m.from.emailAddress.address);
        await record(m, from, m.from && m.from.emailAddress && m.from.emailAddress.name, "error", String(err.message).slice(0, 300)).catch(() => {});
      }
    }
    await setSetting("intake_email_status", { at: new Date().toISOString(), okAt: new Date().toISOString(), error: null, last: out });
    return out;
  } catch (err) {
    const prev = (await getSetting("intake_email_status", null)) || {};
    const msg = err.response && err.response.data && err.response.data.error ? `${err.response.status} ${err.response.data.error.code}: ${err.response.data.error.message}` : err.message;
    await setSetting("intake_email_status", { ...prev, at: new Date().toISOString(), error: String(msg).slice(0, 400) });
    await alertStuck(prev, msg).catch(() => {});
    if (manual) throw bad(`อ่านกล่องจดหมายไม่สำเร็จ: ${msg}`, 502);
    return { error: msg };
  } finally {
    running = false;
  }
}

/** Tell admins when the mailbox could not be read for 30 minutes (at most every 6 hours). */
async function alertStuck(prev, msg) {
  const since = prev.okAt ? Date.now() - new Date(prev.okAt).getTime() : Infinity;
  if (since < 30 * 60000) return;
  const last = await getSetting("intake_email_alert_at", null);
  if (last && Date.now() - new Date(last).getTime() < 6 * 3600000) return;
  await setSetting("intake_email_alert_at", new Date().toISOString());
  const text = `อ่านกล่องจดหมายแจ้งเคสไม่ได้มากกว่า 30 นาที: ${msg}\nลูกค้าที่ส่ง email มาจะยังไม่ได้เลข REQ ตรวจที่ ${config3.baseUrl}/#/intake-admin`;
  await telegram.sendText("⚠️ " + text).catch(() => {});
  const admins = (await all("SELECT email FROM users WHERE active AND role = 'admin' AND email IS NOT NULL")).map((r) => r.email);
  if (admins.length) await graph.sendMail({ to: admins, cc: [], subject: "[Sino Case SLA] อ่านกล่องจดหมายแจ้งเคสไม่ได้", html: shell("#C0283C", `<p style="white-space:pre-wrap">${esc(text)}</p>`) }).catch(() => {});
}

/** Delete processed mail older than keepDays from the "processed" folder (the request keeps its own copy). */
async function cleanup() {
  const e = await emailSettings();
  if (!e.enabled || !e.mailbox || !live()) return { skipped: true };
  const folderId = await ensureFolder(e);
  const before = new Date(Date.now() - e.keepDays * 86400000).toISOString();
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const r = await graph.graph("get", `${mbPath(e.mailbox)}/mailFolders/${folderId}/messages?$filter=receivedDateTime lt ${before}&$select=id&$top=50`);
    const ids = (r.value || []).map((x) => x.id);
    if (!ids.length) break;
    for (const id of ids) {
      await graph.graph("delete", `${mbPath(e.mailbox)}/messages/${id}`);
      removed++;
    }
  }
  await q("DELETE FROM intake_emails WHERE created_at < now() - interval '2 years'");
  return { removed };
}

/** Admin test: run a made-up message through the same rules (nothing is read from or sent to the real mailbox). */
async function simulate(user, b) {
  const e = await emailSettings();
  const from = lower(b.from);
  if (!isEmail(from)) throw bad("กรุณาใส่ email ผู้ส่งที่ถูกต้อง");
  const m = {
    simulated: true,
    isTest: b.test !== false,
    id: null,
    internetMessageId: `sim-${crypto.randomBytes(8).toString("hex")}@test`,
    subject: clean(b.subject, 300),
    from: { emailAddress: { address: from, name: clean(b.name, 120) } },
    receivedDateTime: (() => {
      if (!/^\d{2}:\d{2}$/.test(String(b.at || ""))) return new Date().toISOString();
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.tz }).format(new Date());
      return new Date(`${day}T${b.at}:00+07:00`).toISOString();
    })(),
    body: { contentType: "text", content: clean(b.body, 8000) },
    internetMessageHeaders: [
      ...(b.inReplyTo ? [{ name: "In-Reply-To", value: "<earlier@customer>" }] : []),
      ...(b.auto ? [{ name: "Auto-Submitted", value: "auto-replied" }] : []),
      ...(b.spoof ? [{ name: "Authentication-Results", value: "spf=fail smtp.mailfrom=ktb.co.th; dmarc=fail action=none header.from=ktb.co.th" }] : []),
    ],
    simAttachments: b.withFile ? [{ name: "screenshot.png", contentType: "image/png", contentBytes: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") }] : [],
  };
  const r = await processMessage({ ...e, mailbox: e.mailbox || "service@example.invalid" }, m);
  await audit(user, "intake_email_simulate", from, { decision: r.decision, reqNo: r.reqNo || null });
  return r;
}

async function status() {
  const e = await emailSettings();
  const st = (await getSetting("intake_email_status", null)) || {};
  const recent = await all(
    `SELECT m.id, m.from_email, m.from_name, m.subject, m.received_at, m.decision, m.reason, m.is_test, m.replied, m.created_at, m.intake_id, m.case_id, i.req_no, c.case_no
     FROM intake_emails m LEFT JOIN intakes i ON i.id = m.intake_id LEFT JOIN cases c ON c.id = m.case_id ORDER BY m.id DESC LIMIT 60`
  );
  const counts = await one(
    `SELECT count(*) FILTER (WHERE decision = 'created')::int AS created, count(*) FILTER (WHERE decision = 'appended')::int AS appended,
            count(*) FILTER (WHERE decision = 'held')::int AS held, count(*) FILTER (WHERE decision = 'ignored')::int AS ignored,
            count(*) FILTER (WHERE decision = 'error')::int AS errors
     FROM intake_emails WHERE created_at > now() - interval '30 days' AND NOT is_test`
  );
  return { settings: e, status: st, recent, counts, mock: !live(), publicDomains: PUBLIC_DOMAINS };
}

async function retry(user, id) {
  const r = await one("DELETE FROM intake_emails WHERE id = $1 AND decision = 'error' RETURNING message_id", [id]);
  if (!r) throw bad("ลองใหม่ได้เฉพาะรายการที่ผิดพลาด");
  await audit(user, "intake_email_retry", r.message_id);
  return poll({ manual: true });
}

module.exports = {
  emailSettings, saveEmailSettings, poll, cleanup, simulate, status, retry, onReleased, onClaimed, onClosed,
  processMessage, bodyText, guessSeverity, siteForDomain, PUBLIC_DOMAINS, baseSubject, phonesIn,
};
