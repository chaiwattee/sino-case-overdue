// Updates from NICE by email.
// NICE support writes to support@sinostech.co.th (a distribution list). A shared mailbox (e.g. nice-sync@) is a member
// of that list, so it gets a copy of everything. Every few minutes:
//   - mail from the NICE sender (passing SPF/DMARC) is read: CS number, who updated, when, impact and the "Latest Update" text;
//   - it is added to the case with that CS Number as an "อัปเดตจาก NICE" activity and the case owner is told;
//   - a CS number with no case waits in a queue for an admin (link to a case, open a new case, or skip);
//   - every other message is deleted at once (the team reads its own copy from support@), processed NICE mail after keepDays.
// The app's Graph permission must be limited to this one mailbox (Exchange RBAC for Applications).
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const { q, one, all, getSetting, setSetting, audit } = require("./db");

const KEY = "nice_mail";
const KIND = "อัปเดตจาก NICE";
const KIND_OUT = "ตอบ NICE"; // our engineer's own reply to NICE (copied to the mailbox by a mail flow rule / the DL)
const OUR_DOMAIN = "sinostech.co.th";
const NICE_RCPT = /@(?:[\w-]+\.)*(nice\.com|service-now\.com)$/i;
const DEFAULTS = { enabled: false, mailbox: "", senders: ["nice.customer.support@nice.com"], keepDays: 30, folder: "Sino Case - NICE ประมวลผลแล้ว" };
const CS_RE = /\bCS\d{6,9}\b/i;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const lower = (s) => String(s || "").trim().toLowerCase();
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
const live = () => !config.mock;
const mbPath = (mb) => `/users/${encodeURIComponent(mb)}`;

async function settings() {
  const s = { ...DEFAULTS, ...((await getSetting(KEY, null)) || {}) };
  s.mailbox = lower(s.mailbox);
  s.senders = (s.senders || []).map(lower).filter(Boolean);
  return s;
}
async function saveSettings(user, b) {
  const cur = await settings();
  const mailbox = lower(b.mailbox);
  if (mailbox && !isEmail(mailbox)) throw bad("ชื่อกล่องจดหมายไม่ถูกต้อง");
  if (b.enabled && !mailbox) throw bad("กรุณาใส่กล่องจดหมายก่อนเปิดใช้");
  if (/^support@/i.test(mailbox)) throw bad("support@ เป็น Distribution list อ่านด้วย Graph ไม่ได้ ใส่ shared mailbox ที่เป็นสมาชิกของ support@");
  const senders = [...new Set(String(Array.isArray(b.senders) ? b.senders.join(",") : b.senders || "").split(/[,;\s]+/).map(lower).filter(Boolean))];
  const badS = senders.find((x) => !isEmail(x));
  if (badS) throw bad(`email ผู้ส่งไม่ถูกต้อง: ${badS}`);
  if (!senders.length) throw bad("ใส่ email ผู้ส่งของ NICE อย่างน้อย 1 รายการ");
  const keep = Number(b.keepDays);
  const next = { ...cur, enabled: !!b.enabled, mailbox, senders, keepDays: Number.isFinite(keep) ? Math.min(365, Math.max(7, Math.round(keep))) : 30 };
  await setSetting(KEY, next);
  await audit(user, "nice_mail_settings", mailbox, { enabled: next.enabled, senders, keepDays: next.keepDays });
  return next;
}

// ------------------------------------------------------------ parsing
function toText(m) {
  let t = String((m.body && m.body.content) || "");
  if (m.body && lower(m.body.contentType) === "html") {
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 [[URL:$1]]").replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return t.replace(/\r/g, "").replace(/[ \t ]+\n/g, "\n");
}
const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
/** NICE sometimes repeats the same update twice in the "Latest Update" box: keep one copy. */
function dedupe(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (let cut = Math.ceil(lines.length / 2) - 1; cut <= Math.floor(lines.length / 2) + 1; cut++) {
    if (cut <= 0 || cut >= lines.length) continue;
    const a = lines.slice(0, cut).join("\n"), b = lines.slice(cut).join("\n");
    if (norm(a) && norm(a) === norm(b)) return { text: a.trim(), merged: true };
  }
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), merged: false };
}
/** EST/EDT timestamp from the NICE mail ("2026-11-18 20:01:30 EST") as a Date. */
function niceTime(s, zone) {
  const off = /EDT/i.test(zone || "") ? "-04:00" : "-05:00";
  const t = new Date(`${s.replace(" ", "T")}${off}`);
  return isNaN(t) ? null : t;
}
function parse(m) {
  const subject = String(m.subject || "");
  const text = toText(m);
  const cs = ((subject.match(CS_RE) || text.match(CS_RE) || [])[0] || "").toUpperCase();
  const field = (name) => {
    const r = text.match(new RegExp(`${name}\\s*:\\s*([^\\n]*)`, "i"));
    return r ? r[1].trim() : "";
  };
  const upd = text.match(/has been (\w+(?: \w+)?) by\s+(.+?)\s+on\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*([A-Z]{2,4})?/i);
  let latest = "";
  const li = text.search(/Latest Update\s*:/i);
  if (li >= 0) {
    const rest = text.slice(li).replace(/^Latest Update\s*:/i, "");
    const end = rest.search(/\n\s*(Customer Name|Instance|Case Impact|Case Description)\s*:/i);
    latest = end >= 0 ? rest.slice(0, end) : rest.slice(0, 4000);
  } else if (/Customer Note\s*:/i.test(text)) {
    // "Wiser - Case … has been updated by customer": our engineer wrote on the NICE portal; the text is the Customer Note.
    const rest = text.slice(text.search(/Customer Note\s*:/i)).replace(/^Customer Note\s*:/i, "");
    const end = rest.search(/\n\s*(Click here to view the ticket|Kind Regards|If you wish to unsubscribe)/i);
    latest = end >= 0 ? rest.slice(0, end) : rest.slice(0, 8000);
  } else {
    // Resolved / closed mail: no "Latest Update" box; the notes follow the case fields, up to the portal line or sign-off.
    const di = text.search(/Case Description\s*:[^\n]*\n/i);
    if (di >= 0) {
      const rest = text.slice(di).replace(/^Case Description\s*:[^\n]*\n/i, "");
      const end = rest.search(/\n\s*(To track and view|Kind Regards|Customer Next Update\s*:)/i);
      latest = end >= 0 ? rest.slice(0, end) : rest.slice(0, 8000);
    }
  }
  const action = upd ? upd[1].toLowerCase() : "updated";
  const dd = dedupe(latest.replace(/\s*\[\[URL:[^\]]*\]\]/g, ""));
  const impact = (field("Case Impact") || (subject.match(/,\s*(Critical|High|Medium|Low)\s*$/i) || [])[1] || "").slice(0, 30);
  const portal = (text.match(/Self Service Portal[\s\S]{0,60}?\[\[URL:(https?:\/\/[^\]\s]+)\]\]/i) || [])[1] || "";
  return {
    cs,
    subject: subject.slice(0, 300),
    action,
    updatedBy: upd ? upd[2].trim().slice(0, 120) : "",
    niceAt: upd ? niceTime(upd[3].length === 16 ? upd[3] + ":00" : upd[3], upd[4]) : null,
    niceAtText: upd ? `${upd[3]}${upd[4] ? " " + upd[4] : ""}` : "",
    impact: impact ? impact[0].toUpperCase() + impact.slice(1).toLowerCase() : "",
    customer: (field("Customer Name") || field("Customer")).slice(0, 200),
    description: (field("Case Description") || field("Description")).slice(0, 500),
    byCustomer: /updated by customer/i.test(subject) || /Customer Note\s*:/i.test(text),
    body: (!["updated"].includes(action) && !/updated by customer/i.test(subject) ? `[NICE: ${action}]\n` : "") + dd.text.replace(/\n{3,}/g, "\n\n").slice(0, 8000),
    merged: dd.merged,
    portal: /^https:\/\//i.test(portal) ? portal.slice(0, 500) : "",
  };
}

// ------------------------------------------------------------ cases
async function findCase(cs) {
  if (!cs) return null;
  return one(
    `SELECT c.id, c.case_no, c.site, c.task, c.owner_id, c.status, u.email AS owner_email, u.display_name AS owner_name
       FROM cases c LEFT JOIN users u ON u.id = c.owner_id
      WHERE lower(c.cs_number) = lower($1)
      ORDER BY (lower(coalesce(c.status,'')) IN ('success','resolved','cancel','n/a','transferred')), c.id DESC LIMIT 1`,
    [cs]
  );
}
// Times are shown in Bangkok time (UTC+7, no daylight saving).
const bkk = (t) => new Date(t.getTime() + 7 * 3600000).toISOString();
const bkkDate = (t) => bkk(t).slice(0, 10);
const bkkTime = (t) => `${bkk(t).slice(0, 10)} ${bkk(t).slice(11, 16)}`;
function detailOf(r) {
  const head = [r.updated_by ? `${r.updated_by} (NICE)` : "NICE", r.nice_at ? `${bkkTime(new Date(r.nice_at))} น.` : ""].filter(Boolean).join(" · ");
  return `${head}\n\n${r.body || "(ไม่มีข้อความ)"}${r.portal_url ? `\n\nSelf Service Portal: ${r.portal_url}` : ""}`;
}

/** Add a stored NICE mail row to a case as an activity, update the case's NICE fields and tell the owner. */
async function importInto(row, kase, { notify = true, user = null } = {}) {
  const at = row.nice_at ? new Date(row.nice_at) : new Date(row.received_at || Date.now());
  if (lower(row.sender).endsWith("@" + OUR_DOMAIN)) {
    // Our reply: a team activity under the engineer's name (clears "รอฝั่งเรา"); nobody is notified.
    const u = await one("SELECT id FROM users WHERE lower(email) = $1", [lower(row.sender)]);
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,false,$5)", [
      kase.id, bkkDate(at), KIND_OUT, `${bkkTime(at)} น. · ${/updated by customer/i.test(row.subject || "") ? "อัปเดตบน NICE Portal" : "ส่งถึง NICE ทาง email"}${!u && row.updated_by ? ` · ${row.updated_by}` : ""}\n\n${row.body || "(ไม่มีข้อความ)"}`, u ? u.id : user ? user.id : null,
    ]);
    await q("UPDATE nice_mails SET status = 'imported', case_id = $2, reason = NULL WHERE id = $1", [row.id, kase.id]);
    return;
  }
  await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,true,$5)", [
    kase.id, bkkDate(at), KIND, detailOf(row), user ? user.id : null,
  ]);
  await q(
    `UPDATE cases SET nice_impact = COALESCE(NULLIF($2,''), nice_impact),
            nice_last_at = GREATEST(COALESCE(nice_last_at, $3), $3) WHERE id = $1`,
    [kase.id, row.impact || "", at]
  );
  await q("UPDATE nice_mails SET status = 'imported', case_id = $2, reason = NULL, handled_by = $3, handled_at = CASE WHEN $3::int IS NULL THEN handled_at ELSE now() END WHERE id = $1", [
    row.id, kase.id, user ? user.id : null,
  ]);
  if (notify) await notifyOwner(row, kase).catch((e) => console.warn("[nice-mail] notify:", e.message));
}
async function notifyOwner(row, kase) {
  if (!kase.owner_id) return;
  const ref = kase.case_no || `#${kase.id}`;
  await require("./push").send([kase.owner_id], {
    title: `NICE อัปเดตเคส ${row.cs_number}`,
    body: `${ref} · ${String(row.body || "").replace(/\s+/g, " ").slice(0, 140)}`,
    url: `/#/case/${kase.id}`,
    tag: `nice-${kase.id}`,
  });
  if (!kase.owner_email) return;
  await graph.sendMail({
    to: [kase.owner_email],
    cc: [],
    subject: `[NICE อัปเดต] ${ref} · ${row.cs_number}${kase.site ? " · " + kase.site : ""}`,
    html: shell("#7C3AED", `<p style="margin:0 0 14px">NICE อัปเดตเคส <strong>${esc(row.cs_number)}</strong> ระบบบันทึกใน Activity ของเคส ${esc(ref)} แล้ว</p>
${fieldTable([["จาก", row.updated_by || "NICE"], ["เวลา", row.nice_at ? bkkTime(new Date(row.nice_at)) + " น." : "-"], ["Impact", row.impact || "-"]])}
<p style="margin:14px 0;white-space:pre-wrap;background:#F6F7F9;padding:12px 14px;border-radius:8px">${esc(String(row.body || "").slice(0, 3000))}</p>
${button(`${config3.baseUrl}/#/case/${kase.id}`, "เปิดเคส")}`),
  });
}

// ------------------------------------------------------------ one message
function headerMap(m) {
  const h = {};
  (m.internetMessageHeaders || []).forEach((x) => (h[lower(x.name)] = String(x.value || "")));
  return h;
}
/** Returns "deleted" (not from NICE), or the stored row's status. */
async function processMessage(s, m) {
  const from = lower(m.from && m.from.emailAddress && m.from.emailAddress.address);
  const mid = m.internetMessageId || `graph-${m.id}`;
  if (from.endsWith("@" + OUR_DOMAIN)) return processReply(m, from, mid);
  if (!s.senders.includes(from)) {
    // Looks like a NICE case mail from an address not in the list: keep it and show it to the admin instead of deleting.
    if (!CS_RE.test(String(m.subject || "")) || !/nice/i.test(`${m.subject || ""} ${from}`)) return "deleted";
    if (await one("SELECT id FROM nice_mails WHERE message_id = $1", [mid])) return "duplicate";
    const p = parse(m);
    await q(
      `INSERT INTO nice_mails (message_id, cs_number, status, reason, sender, subject, received_at)
       VALUES ($1,$2,'ignored',$3,$4,$5,$6) ON CONFLICT (message_id) DO NOTHING`,
      [mid, p.cs || null, `ผู้ส่ง ${from} ไม่อยู่ในรายการผู้ส่งที่ยอมรับ (เพิ่มในตั้งค่าแล้วกู้ email กลับเข้า Inbox)`, from, p.subject, m.receivedDateTime || new Date().toISOString()]
    );
    return "ignored";
  }
  if (await one("SELECT id FROM nice_mails WHERE message_id = $1", [mid])) return "duplicate";
  const h = headerMap(m);
  const authFail = /\b(dmarc=fail|spf=fail|compauth=fail)\b/i.test(h["authentication-results"] || "");
  const p = parse(m);
  // NICE echoes an update made by one of us ("updated by Pipat …"). With no text it adds nothing; with text it is a
  // copy of the reply we already took from the engineer's own mail (or one posted on the portal): skip it when that
  // reply is already in the case, otherwise keep it as our reply.
  let echo = null;
  if (p.updatedBy) {
    echo = await one("SELECT id, email FROM users WHERE lower(display_name) = lower($1) AND active LIMIT 1", [p.updatedBy]).catch(() => null);
    // Name on NICE differs from ours (e.g. Thai display name): try the first name against the email (pipat@…).
    if (!echo && p.byCustomer) {
      const first = lower(p.updatedBy.split(/\s+/)[0]).replace(/[^a-z]/g, "");
      if (first.length >= 3) echo = await one(`SELECT id, email FROM users WHERE lower(email) LIKE $1 AND active LIMIT 1`, [`${first}%@${OUR_DOMAIN}`]).catch(() => null);
    }
  }
  let status = authFail ? "ignored" : !p.cs ? "ignored" : "unmatched";
  let reason = authFail ? "ไม่ผ่านการตรวจผู้ส่ง (SPF/DMARC)" : !p.cs ? "ไม่พบเลข CS" : null;
  let sender = from;
  if ((echo || p.byCustomer) && status === "unmatched") {
    const who = echo ? lower(echo.email) : `customer@${OUR_DOMAIN}`;
    // Same text already in (the engineer's own email reached us too): keep one copy.
    const key = norm(p.body).slice(0, 160);
    const dup = key && (await one(
      `SELECT 1 FROM nice_mails WHERE lower(cs_number) = lower($1) AND sender LIKE $2 AND status IN ('imported','unmatched') AND left(regexp_replace(lower(body), '\\s+', ' ', 'g'), 160) = $3`,
      [p.cs, `%@${OUR_DOMAIN}`, key]
    ));
    if (!p.body.trim()) { status = "ignored"; reason = `แจ้งเตือนการอัปเดตจากทีมเรา (${p.updatedBy}) ไม่มีข้อความ`; }
    else if (dup) { status = "ignored"; reason = `ข้อความเดียวกับที่บันทึกแล้ว (${p.updatedBy})`; }
    else sender = who; // our engineer's update (portal note or echo): record it as our reply
  }
  const row = await one(
    `INSERT INTO nice_mails (message_id, cs_number, status, reason, sender, subject, updated_by, nice_at, impact, customer, description, body, portal_url, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (message_id) DO NOTHING RETURNING *`,
    [mid, p.cs || null, status, reason, sender, p.subject, p.updatedBy || null, p.niceAt, p.impact || null, p.customer || null, p.description || null, p.body, p.portal || null, m.receivedDateTime || new Date().toISOString()]
  );
  if (!row || status !== "unmatched") return row ? status : "duplicate";
  const kase = await findCase(p.cs);
  if (!kase) return "unmatched";
  await importInto(row, kase);
  return "imported";
}

/** Text the engineer typed: cut the quoted history and the usual sign-off block. */
function replyText(text) {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^\s*(From|จาก|Sent|ส่ง)\s*:/i.test(l) || /^\s*On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^_{8,}\s*$/.test(l));
  return dedupe((cut >= 0 ? lines.slice(0, cut) : lines).join("\n")).text;
}
/** Our engineer's mail to NICE (CS number in the subject, NICE among the recipients). Anything else from us is deleted. */
async function processReply(m, from, mid) {
  const subject = String(m.subject || "");
  const cs = ((subject.match(CS_RE) || [])[0] || "").toUpperCase();
  const rcpts = [...(m.toRecipients || []), ...(m.ccRecipients || [])].map((r) => lower(r.emailAddress && r.emailAddress.address));
  if (!cs || !rcpts.some((a) => NICE_RCPT.test(a))) return "deleted";
  if (await one("SELECT id FROM nice_mails WHERE message_id = $1", [mid])) return "duplicate";
  const body = replyText(toText(m)).slice(0, 8000);
  const row = await one(
    `INSERT INTO nice_mails (message_id, cs_number, status, sender, subject, updated_by, nice_at, body, received_at)
     VALUES ($1,$2,'unmatched',$3,$4,(SELECT display_name FROM users WHERE lower(email) = $3),$5,$6,$5) ON CONFLICT (message_id) DO NOTHING RETURNING *`,
    [mid, cs, from, subject.slice(0, 300), m.receivedDateTime || new Date().toISOString(), body]
  );
  if (!row) return "duplicate";
  const kase = await findCase(cs);
  if (!kase) return "unmatched";
  await importInto(row, kase);
  return "imported";
}

/** Waiting rows whose CS number now has a case (opened or edited since): import them. */
async function matchWaiting(onlyCs) {
  const rows = await all(
    `SELECT * FROM nice_mails WHERE status = 'unmatched' ${onlyCs ? "AND lower(cs_number) = lower($1)" : ""} ORDER BY coalesce(nice_at, received_at), id LIMIT 200`,
    onlyCs ? [onlyCs] : []
  );
  let n = 0;
  for (const r of rows) {
    const kase = await findCase(r.cs_number);
    if (!kase) continue;
    await importInto(r, kase);
    n++;
  }
  return n;
}

// ------------------------------------------------------------ mailbox
let folderCache = { mb: null, id: null };
async function ensureFolder(s) {
  if (folderCache.mb === s.mailbox && folderCache.id) return folderCache.id;
  const name = s.folder.replace(/'/g, "''");
  const found = await graph.graph("get", `${mbPath(s.mailbox)}/mailFolders?$filter=displayName eq '${encodeURIComponent(name)}'&$select=id`);
  let id = found.value && found.value[0] && found.value[0].id;
  if (!id) id = (await graph.graph("post", `${mbPath(s.mailbox)}/mailFolders`, { displayName: s.folder })).id;
  folderCache = { mb: s.mailbox, id };
  return id;
}
const SELECT = "id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,internetMessageHeaders";

let running = false;
async function poll({ manual = false } = {}) {
  const s = await settings();
  if (!s.enabled || !s.mailbox) return { skipped: "ยังไม่เปิดใช้" };
  if (!live()) return { skipped: "โหมดข้อมูลจำลอง (MOCK_DATA) ไม่อ่านกล่องจริง", matched: await matchWaiting() };
  if (running) return { busy: true };
  running = true;
  const out = { read: 0, imported: 0, unmatched: 0, ignored: 0, deleted: 0, duplicate: 0, errors: 0 };
  try {
    const folderId = await ensureFolder(s);
    for (let round = 0; round < 5; round++) {
      const r = await graph.graph("get", `${mbPath(s.mailbox)}/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime asc&$select=${SELECT}`);
      const msgs = r.value || [];
      if (!msgs.length) break;
      for (const m of msgs) {
        out.read++;
        try {
          const st = await processMessage(s, m);
          out[st] = (out[st] || 0) + 1;
          if (st === "deleted") await graph.graph("delete", `${mbPath(s.mailbox)}/messages/${m.id}`);
          else await graph.graph("post", `${mbPath(s.mailbox)}/messages/${m.id}/move`, { destinationId: folderId });
        } catch (err) {
          out.errors++;
          console.error("[nice-mail] message:", err.message);
        }
      }
      if (out.errors) break; // leave the rest for the next run
    }
    out.matched = await matchWaiting();
    await setSetting("nice_mail_status", { at: new Date().toISOString(), okAt: new Date().toISOString(), error: null, last: out });
    return out;
  } catch (err) {
    const prev = (await getSetting("nice_mail_status", null)) || {};
    const msg = err.response && err.response.data && err.response.data.error ? `${err.response.status} ${err.response.data.error.code}: ${err.response.data.error.message}` : err.message;
    await setSetting("nice_mail_status", { ...prev, at: new Date().toISOString(), error: String(msg).slice(0, 400) });
    if (manual) throw bad(`อ่านกล่องจดหมาย NICE ไม่สำเร็จ: ${msg}`, 502);
    return { error: msg };
  } finally {
    running = false;
  }
}

/** Processed NICE mail older than keepDays is deleted from the mailbox (the case keeps the text). */
async function cleanup() {
  const s = await settings();
  if (!s.enabled || !s.mailbox || !live()) return { skipped: true };
  const folderId = await ensureFolder(s);
  const before = new Date(Date.now() - s.keepDays * 86400000).toISOString();
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const r = await graph.graph("get", `${mbPath(s.mailbox)}/mailFolders/${folderId}/messages?$filter=receivedDateTime lt ${before}&$select=id&$top=50`);
    const ids = (r.value || []).map((x) => x.id);
    if (!ids.length) break;
    for (const id of ids) {
      await graph.graph("delete", `${mbPath(s.mailbox)}/messages/${id}`);
      removed++;
    }
  }
  await q("DELETE FROM nice_mails WHERE created_at < now() - interval '2 years'");
  return { removed };
}

/** Read again the NICE mails stored with no text (formats the reader did not know yet), from the mailbox copy
 *  (kept keepDays). The empty activity is replaced by the real text. */
async function reread(user) {
  const s = await settings();
  if (!s.enabled || !s.mailbox) throw bad("ยังไม่ได้เปิดใช้");
  if (!live()) throw bad("โหมดข้อมูลจำลอง อ่านกล่องจริงไม่ได้");
  const rows = await all(`SELECT * FROM nice_mails WHERE coalesce(length(body),0) = 0 AND message_id NOT LIKE 'sim-%' AND created_at > now() - ($1 || ' days')::interval ORDER BY id`, [String(s.keepDays)]);
  const out = { checked: rows.length, fixed: 0, notFound: 0, stillEmpty: 0 };
  for (const r of rows) {
    const id = r.message_id.replace(/'/g, "''");
    const found = await graph.graph("get", `${mbPath(s.mailbox)}/messages?$filter=internetMessageId eq '${encodeURIComponent(id)}'&$select=${SELECT}`).catch(() => ({ value: [] }));
    const m = (found.value || [])[0];
    if (!m) { out.notFound++; continue; }
    if (!parse(m).body.trim()) { out.stillEmpty++; continue; }
    if (r.case_id) {
      const a = await one(
        `SELECT id FROM case_activities WHERE case_id = $1 AND kind IN ($2, $3) AND detail LIKE '%(ไม่มีข้อความ)%' AND ($4::text IS NULL OR detail LIKE $4 || '%') ORDER BY abs(extract(epoch FROM created_at - $5::timestamptz)) LIMIT 1`,
        [r.case_id, KIND, KIND_OUT, r.updated_by, r.created_at]
      );
      if (a) await q("DELETE FROM case_activities WHERE id = $1", [a.id]);
    }
    await q("DELETE FROM nice_mails WHERE id = $1", [r.id]);
    await processMessage(s, m);
    out.fixed++;
  }
  await audit(user, "nice_mail_reread", null, out);
  return out;
}

// ------------------------------------------------------------ case page
/** NICE summary for one case: impact, last update and whether NICE is waiting for us (no team activity since). */
async function forCase(caseId) {
  const r = await one(
    `SELECT c.nice_impact, c.nice_last_at, c.cs_number,
            (SELECT max(created_at) FROM case_activities WHERE case_id = c.id AND kind = $2) AS nice_act_at,
            (SELECT max(created_at) FROM case_activities WHERE case_id = c.id AND NOT is_system) AS team_act_at
       FROM cases c WHERE c.id = $1`,
    [caseId, KIND]
  );
  if (!r || !r.nice_last_at) return null;
  const waiting = r.nice_act_at && (!r.team_act_at || new Date(r.team_act_at) < new Date(r.nice_act_at));
  return { impact: r.nice_impact || "", lastAt: r.nice_last_at, waitingSince: waiting ? r.nice_act_at : null };
}

// ------------------------------------------------------------ routes
function mount(api, { wrap, need, loadVisible }) {
  const admin = need("settings_manage");
  api.get("/nice-admin", admin, wrap(async (req, res) => {
    const s = await settings();
    const stats = await all("SELECT status, count(*)::int AS n FROM nice_mails WHERE created_at > now() - interval '7 days' GROUP BY status");
    const recent = await all(
      `SELECT n.id, n.cs_number, n.status, n.reason, n.updated_by, n.nice_at, n.received_at, n.subject, c.case_no, n.case_id
         FROM nice_mails n LEFT JOIN cases c ON c.id = n.case_id ORDER BY n.id DESC LIMIT 30`
    );
    res.json({ settings: s, status: await getSetting("nice_mail_status", null), stats: Object.fromEntries(stats.map((x) => [x.status, x.n])), recent, mock: !live() });
  }));
  api.put("/nice-admin", admin, wrap(async (req, res) => res.json({ ok: true, settings: await saveSettings(req.user, req.body || {}) })));
  api.post("/nice-admin/reread", admin, wrap(async (req, res) => res.json({ ok: true, ...(await reread(req.user)) })));
  api.post("/nice-admin/poll", admin, wrap(async (req, res) => res.json({ ok: true, ...(await poll({ manual: true })) })));
  // Admin test: run a pasted NICE email through the same parser (nothing is read from the real mailbox).
  api.post("/nice-admin/simulate", admin, wrap(async (req, res) => {
    const s = await settings();
    const b = req.body || {};
    const m = {
      id: "sim", internetMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, subject: String(b.subject || ""),
      from: { emailAddress: { address: s.senders[0] || DEFAULTS.senders[0] } }, receivedDateTime: new Date().toISOString(),
      body: { contentType: /<\w+[^>]*>/.test(b.body || "") ? "html" : "text", content: String(b.body || "").slice(0, 100000) },
    };
    const parsed = parse(m);
    if (b.dryRun) return res.json({ ok: true, parsed });
    const st = await processMessage(s, m);
    await audit(req.user, "nice_mail_simulate", parsed.cs || "-", { status: st });
    res.json({ ok: true, status: st, parsed });
  }));
  api.get("/nice/unmatched", admin, wrap(async (req, res) => {
    res.json({ items: await all("SELECT id, cs_number, subject, updated_by, nice_at, received_at, impact, customer, description, body FROM nice_mails WHERE status = 'unmatched' ORDER BY id DESC LIMIT 100") });
  }));
  api.post("/nice/unmatched/:id(\\d+)/link", admin, wrap(async (req, res) => {
    const row = await one("SELECT * FROM nice_mails WHERE id = $1 AND status = 'unmatched'", [Number(req.params.id)]);
    if (!row) throw bad("ไม่พบรายการ หรือจัดการไปแล้ว", 404);
    const ref = String(req.body?.case || "").trim();
    const kase = await one(
      `SELECT c.id, c.case_no, c.site, c.owner_id, c.cs_number, u.email AS owner_email FROM cases c LEFT JOIN users u ON u.id = c.owner_id
        WHERE ${/^\d+$/.test(ref) ? "c.id = $1::int" : "lower(c.case_no) = lower($1)"}`,
      [ref]
    );
    if (!kase) throw bad("ไม่พบเคสนี้");
    if (kase.cs_number && lower(kase.cs_number) !== lower(row.cs_number)) throw bad(`เคสนี้มี CS Number ${kase.cs_number} อยู่แล้ว ไม่ตรงกับ ${row.cs_number}`);
    if (!kase.cs_number) {
      await q("UPDATE cases SET cs_number = $2, updated_at = now() WHERE id = $1", [kase.id, row.cs_number]);
      await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, current_date, 'แก้ไขเคส', $2, true, $3)", [
        kase.id, `ใส่ CS Number ${row.cs_number} จากการผูก email NICE`, req.user.id,
      ]);
    }
    await importInto(row, kase, { user: req.user });
    const more = await matchWaiting(row.cs_number);
    await audit(req.user, "nice_mail_link", row.cs_number, { case_id: kase.id, more });
    res.json({ ok: true, caseId: kase.id, more });
  }));
  api.post("/nice/unmatched/:id(\\d+)/skip", admin, wrap(async (req, res) => {
    const r = await one("UPDATE nice_mails SET status = 'skipped', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'unmatched' RETURNING cs_number", [Number(req.params.id), req.user.id]);
    if (!r) throw bad("ไม่พบรายการ หรือจัดการไปแล้ว", 404);
    await audit(req.user, "nice_mail_skip", r.cs_number, {});
    res.json({ ok: true });
  }));
  // Case page: pull now (reads the mailbox, then imports anything waiting for this CS number).
  api.post("/case/:id(\\d+)/nice-pull", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!c.csNumber) throw bad("เคสนี้ยังไม่มี CS Number");
    const s = await settings();
    if (!s.enabled) throw bad("ยังไม่ได้เปิดใช้การดึงอัปเดตจาก NICE (Admin ตั้งค่าได้ที่ ตั้งค่าระบบ)");
    const r = await poll().catch((e) => ({ error: e.message }));
    const matched = await matchWaiting(c.csNumber);
    res.json({ ok: true, matched, poll: r, nice: await forCase(c.id) });
  }));
}

module.exports = { KIND, KIND_OUT, processMessage, settings, saveSettings, parse, dedupe, poll, cleanup, forCase, matchWaiting, mount };
