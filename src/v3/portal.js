// Customer portal (/portal): customer accounts sign in with a username and password that Sino gives them, must set their
// own password at first sign-in and every 90 days, and see only the cases their company reported to us (by email or
// through the portal). Internal cases are never shown. Status is a short customer version, and only activities an
// engineer marked "show to customer" appear. All customer-facing text is English.
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const { config3 } = require("./config3");
const { one, q, all, audit } = require("./db");
const { sign, verify, tempPassword } = require("./auth");

const PSID = "psid";
const SESSION_HOURS = 8;
const EXPIRE_DAYS = 90;
const WARN_DAYS = 14;
const HISTORY = 5;
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const DUMMY = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);
const secure = config3.baseUrl.startsWith("https://");

const bad = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error("[portal]", e);
  res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Something went wrong. Please try again.", ...(e.code ? { code: e.code } : {}) });
});
const clean = (s, n = 500) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n);
const lower = (s) => String(s || "").toLowerCase();

// ------------------------------------------------------------ password policy
/** Returns the list of rules a new password breaks (empty = fine). */
function policyProblems(pw, { username = "", site = "" } = {}) {
  const p = String(pw || "");
  const out = [];
  if (p.length < 12) out.push("At least 12 characters");
  if (!/[A-Z]/.test(p)) out.push("An uppercase letter");
  if (!/[a-z]/.test(p)) out.push("A lowercase letter");
  if (!/[0-9]/.test(p)) out.push("A number");
  if (!/[^A-Za-z0-9]/.test(p)) out.push("A special character");
  const lp = p.toLowerCase();
  const words = [username, site, ...String(username).split(/[._@-]/)].map((w) => lower(w).trim()).filter((w) => w.length >= 3);
  if (words.some((w) => lp.includes(w))) out.push("Must not contain your username or company name");
  return out;
}
const POLICY_TEXT = [
  "At least 12 characters",
  "Uppercase and lowercase letters, a number and a special character",
  `Not one of your last ${HISTORY} passwords`,
  "Must not contain your username or company name",
  `Expires every ${EXPIRE_DAYS} days`,
];

// ------------------------------------------------------------ session
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, value, maxAgeSec) {
  const parts = [`${PSID}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${maxAgeSec}`);
  res.append("Set-Cookie", parts.join("; "));
}
const expiresAt = (u) => new Date(new Date(u.password_changed_at).getTime() + EXPIRE_DAYS * 86400000);
const mustChange = (u) => u.must_change || expiresAt(u) <= new Date();

async function current(req) {
  const p = verify(cookies(req)[PSID]);
  if (!p || p.kind !== "portal") return null;
  const u = await one("SELECT * FROM portal_users WHERE id = $1", [p.pid]);
  if (!u || !u.active || u.session_version !== p.v) return null;
  return u;
}
const need = ({ allowChange = false } = {}) => async (req, res, next) => {
  try {
    const u = await current(req);
    if (!u) return res.status(401).json({ ok: false, error: "Please sign in.", code: "LOGIN" });
    if (!allowChange && mustChange(u)) return res.status(403).json({ ok: false, error: "Please set a new password first.", code: "CHANGE_PASSWORD" });
    req.pu = u;
    next();
  } catch (e) {
    next(e);
  }
};
function meOf(u) {
  const exp = expiresAt(u);
  const days = Math.ceil((exp - Date.now()) / 86400000);
  return {
    username: u.username, name: u.display_name, company: u.site, email: u.email || "",
    mustChange: mustChange(u), firstLogin: u.must_change, passwordExpiresAt: exp.toISOString(),
    expiresInDays: days, warnExpiry: !u.must_change && days <= WARN_DAYS && days > 0, policy: POLICY_TEXT,
  };
}

// ------------------------------------------------------------ customer view of cases
const CLOSED = ["Success", "Cancel", "N/A", "Transferred"];
/** The short status a customer sees. */
function statusOf(i) {
  if (i.status === "rejected") return { key: "closed", label: "Closed" };
  if (!i.case_id || !i.case_status) return { key: "received", label: "Received" };
  if (CLOSED.includes(i.case_status)) return { key: "closed", label: "Closed" };
  if (i.case_status === "Resolved") return { key: "resolved", label: "Resolved – awaiting confirmation" };
  if (i.case_status === "Pending") return { key: "waiting", label: "Awaiting information" };
  return { key: "progress", label: "In progress" };
}
const STEP = { received: 1, progress: 2, waiting: 2, resolved: 3, closed: 4 };
const CH = { link: "Web form", line: "LINE", email: "Email", portal: "Portal", api: "Web form" };

const LIST_SQL = `
  SELECT i.id, i.req_no, i.subject, i.detail, i.severity, i.product, i.channel, i.status, i.created_at, i.contact_name,
         i.case_id, c.case_no, c.status AS case_status, c.end_date,
         greatest(i.created_at, c.updated_at, (SELECT max(a.created_at) FROM case_activities a WHERE a.case_id = c.id AND a.customer_visible)) AS updated_at
    FROM intakes i LEFT JOIN cases c ON c.id = i.case_id
   WHERE lower(i.site) = lower($1) AND NOT i.is_test AND i.status <> 'duplicate'`;

function rowOut(r) {
  const s = statusOf(r);
  return {
    id: r.id, ref: r.case_no || r.req_no, reqNo: r.req_no, caseNo: r.case_no || null, subject: r.subject, severity: r.severity, product: r.product,
    channel: CH[r.channel] || "Web form", status: s.label, statusKey: s.key, step: STEP[s.key], createdAt: r.created_at, updatedAt: r.updated_at, reportedBy: r.contact_name,
  };
}

// ------------------------------------------------------------ routes
const router = express.Router();
router.use(express.json({ limit: "64kb" }));
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  // Same-origin JSON only: a plain form post from another site cannot carry this header.
  if (req.method !== "GET" && req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
  next();
});

router.post("/login", wrap(async (req, res) => {
  const username = clean(req.body?.username, 120);
  const password = String(req.body?.password || "");
  const u = username ? await one("SELECT * FROM portal_users WHERE lower(username) = lower($1)", [username]) : null;
  const fail = "Incorrect username or password.";
  if (!u || !u.active) {
    await bcrypt.compare(password, DUMMY); // same timing for unknown users
    await audit(null, "portal_login_fail", username.slice(0, 60), { reason: u ? "inactive" : "unknown" });
    throw bad(fail, 401);
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const min = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
    throw bad(`This account is locked after too many attempts. Please try again in ${min} minute${min > 1 ? "s" : ""}, or contact Sino S-Tech.`, 423, { code: "LOCKED" });
  }
  if (!(await bcrypt.compare(password, u.password_hash))) {
    const n = u.failed_count + 1;
    const lock = n >= MAX_FAILS;
    await q("UPDATE portal_users SET failed_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1", [u.id, lock ? 0 : n, lock, LOCK_MIN]);
    await audit(null, lock ? "portal_locked" : "portal_login_fail", u.username, { site: u.site });
    // Same answer as an unknown username (no "attempts left"), so the page does not reveal which usernames exist.
    throw bad(lock ? `Too many attempts. This account is locked for ${LOCK_MIN} minutes.` : fail, 401);
  }
  await q("UPDATE portal_users SET failed_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [u.id]);
  const now = Date.now();
  setCookie(res, sign({ kind: "portal", pid: u.id, v: u.session_version, iat: now, exp: now + SESSION_HOURS * 3600000 }), SESSION_HOURS * 3600);
  await audit(null, "portal_login", u.username, { site: u.site });
  res.json({ ok: true, me: meOf(u) });
}));

router.post("/logout", (req, res) => {
  setCookie(res, "", 0);
  res.json({ ok: true });
});

router.get("/me", need({ allowChange: true }), wrap(async (req, res) => res.json({ ok: true, me: meOf(req.pu) })));

router.post("/password", need({ allowChange: true }), wrap(async (req, res) => {
  const u = req.pu;
  const cur = String(req.body?.current || ""), pw = String(req.body?.password || ""), pw2 = String(req.body?.confirm || "");
  if (!(await bcrypt.compare(cur, u.password_hash))) throw bad("Your current password is incorrect.");
  if (pw !== pw2) throw bad("The new passwords do not match.");
  const probs = policyProblems(pw, { username: u.username, site: u.site });
  if (probs.length) throw bad("The new password needs: " + probs.join(", ") + ".");
  if (await bcrypt.compare(pw, u.password_hash)) throw bad("The new password must be different from the current one.");
  const hist = await all("SELECT hash FROM portal_password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [u.id, HISTORY]);
  for (const h of hist) if (await bcrypt.compare(pw, h.hash)) throw bad(`You used this password recently. Please choose one that is not one of your last ${HISTORY}.`);
  const hash = await bcrypt.hash(pw, 11);
  await q("INSERT INTO portal_password_history (user_id, hash) VALUES ($1, $2)", [u.id, u.password_hash]);
  await q("DELETE FROM portal_password_history WHERE user_id = $1 AND id NOT IN (SELECT id FROM portal_password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2)", [u.id, HISTORY]);
  const r = await one("UPDATE portal_users SET password_hash = $2, must_change = false, password_changed_at = now(), session_version = session_version + 1 WHERE id = $1 RETURNING *", [u.id, hash]);
  const now = Date.now();
  setCookie(res, sign({ kind: "portal", pid: r.id, v: r.session_version, iat: now, exp: now + SESSION_HOURS * 3600000 }), SESSION_HOURS * 3600);
  await audit(null, "portal_password_change", u.username, { site: u.site });
  res.json({ ok: true, me: meOf(r) });
}));

router.get("/cases", need(), wrap(async (req, res) => {
  const rows = await all(`${LIST_SQL} ORDER BY i.id DESC LIMIT 300`, [req.pu.site]);
  res.json({ ok: true, company: req.pu.site, cases: rows.map(rowOut) });
}));

async function loadOwn(req) {
  const id = Number(req.params.id);
  const r = id ? await one(`${LIST_SQL} AND i.id = $2`, [req.pu.site, id]) : null;
  if (!r) throw bad("Case not found.", 404);
  return r;
}

router.get("/cases/:id(\\d+)", need(), wrap(async (req, res) => {
  const r = await loadOwn(req);
  const updates = r.case_id
    ? await all(
        `SELECT a.id, a.detail, a.created_at, a.kind, a.portal_user_id, pu.display_name AS customer_name
           FROM case_activities a LEFT JOIN portal_users pu ON pu.id = a.portal_user_id
          WHERE a.case_id = $1 AND a.customer_visible ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, [r.case_id])
    : [];
  const list = updates.map((a) => ({ at: a.created_at, text: a.portal_user_id ? String(a.detail).replace(/^[^\n]*?\(Portal\): /, "") : a.detail, from: a.portal_user_id ? a.customer_name || "You" : "Sino S-Tech Support", mine: !!a.portal_user_id }));
  if (r.case_id) list.push({ at: r.created_at, text: `We received your request and assigned it case number ${r.case_no}.`, from: "Sino S-Tech Support", mine: false, system: true });
  list.push({ at: r.created_at, text: `Request ${r.req_no} submitted by ${r.contact_name || "your team"} via ${CH[r.channel] || "web form"}.`, from: "System", mine: false, system: true });
  res.json({ ok: true, case: { ...rowOut(r), detail: r.detail, canReply: !!r.case_id && statusOf(r).key !== "closed" }, updates: list });
}));

router.post("/cases/:id(\\d+)/reply", need(), wrap(async (req, res) => {
  const r = await loadOwn(req);
  if (!r.case_id) throw bad("You can reply once an engineer has been assigned. Please wait for the case number.");
  if (statusOf(r).key === "closed") throw bad("This case is closed. Please report a new case.");
  const text = clean(req.body?.text, 3000);
  if (text.length < 2) throw bad("Please type a message.");
  const recent = await one("SELECT count(*)::int AS n FROM case_activities WHERE portal_user_id = $1 AND created_at > now() - interval '10 minutes'", [req.pu.id]);
  if (recent.n >= 10) throw bad("Too many messages. Please wait a few minutes.", 429);
  await q(
    `INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by, customer_visible, portal_user_id)
     VALUES ($1, (now() AT TIME ZONE 'Asia/Bangkok')::date, 'ข้อความจากลูกค้า', $2, false, NULL, true, $3)`,
    [r.case_id, `${req.pu.display_name} (Portal): ${text}`, req.pu.id]
  );
  const kase = await one("SELECT owner_id, case_no FROM cases WHERE id = $1", [r.case_id]);
  if (kase?.owner_id) {
    await require("./push").send([kase.owner_id], { title: `ลูกค้าตอบใน Portal · ${kase.case_no}`, body: `${req.pu.display_name} (${req.pu.site}): ${text.slice(0, 140)}`, url: `/#/case/${r.case_id}`, tag: `portal-${r.case_id}` }).catch(() => {});
  }
  await audit(null, "portal_reply", r.case_no || r.req_no, { user: req.pu.username });
  res.json({ ok: true });
}));

router.get("/form", need(), wrap(async (req, res) => {
  const products = (await all("SELECT value FROM lookups WHERE kind='product' AND active ORDER BY sort, lower(value)")).map((r) => r.value);
  const { SEV_EN } = require("./intakeupdate");
  res.json({ ok: true, products, severities: SEV_EN.map(([value, label, hint]) => ({ value, label, hint })), contact: { name: req.pu.display_name, email: req.pu.email || "", phone: req.pu.phone || "" } });
}));

// New case: goes through the same intake as the web form and email, so the team is notified and claims it as usual.
router.post("/cases", need(), wrap(async (req, res) => {
  const u = req.pu, b = req.body || {};
  const recent = await one("SELECT count(*)::int AS n FROM intakes WHERE portal_user_id = $1 AND created_at > now() - interval '1 hour'", [u.id]);
  if (recent.n >= 10) throw bad("You have reported many cases in the last hour. Please try again later or call our hotline.", 429);
  const intake = require("./intake");
  const link = await intake.createLink({ contactName: b.contactName || u.display_name, contactEmail: b.email || u.email, contactPhone: b.phone || u.phone }, { source: "portal", minutes: 10 });
  await q("UPDATE intake_links SET site = $2 WHERE id = $1", [link.linkId, u.site]);
  const token = link.url.split("/r/")[1];
  const r = await intake.submit(token, {
    contactName: clean(b.contactName, 120) || u.display_name, email: clean(b.email, 200) || u.email, phone: clean(b.phone, 60) || u.phone,
    position: b.position, product: b.product, severity: b.severity, subject: b.subject, detail: b.detail, startedText: b.startedText,
    affected: b.affected, customerRef: b.customerRef, consent: true, confirmDuplicate: !!b.confirmDuplicate,
  });
  const row = await one("UPDATE intakes SET channel = 'portal', portal_user_id = $2 WHERE req_no = $1 RETURNING id", [r.reqNo, u.id]);
  await audit(null, "portal_case_new", r.reqNo, { user: u.username, site: u.site });
  res.json({ ok: true, id: row.id, reqNo: r.reqNo, afterHours: r.afterHours, hotline: r.hotline });
}));

// ------------------------------------------------------------ staff: accounts (admin or "จัดการรายชื่อลูกค้า")
function mountStaff(api, { wrap: w }) {
  const canManage = async (user) => user.role === "admin" || (await require("./perms").level(user, "customer_manage")) === "all";
  const guard = async (req) => { if (!(await canManage(req.user))) throw bad("ไม่มีสิทธิ์จัดการบัญชี Portal ของลูกค้า (ต้องเป็น Admin หรือมีสิทธิ์จัดการรายชื่อลูกค้า)", 403); };
  const out = (u) => ({
    id: u.id, site: u.site, username: u.username, name: u.display_name, email: u.email, phone: u.phone, active: u.active,
    mustChange: u.must_change, passwordChangedAt: u.password_changed_at, expiresAt: expiresAt(u), locked: !!(u.locked_until && new Date(u.locked_until) > new Date()),
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
  });
  api.get("/portal-accounts", w(async (req, res) => {
    const manage = await canManage(req.user);
    const site = clean(req.query.site, 200);
    const rows = await all(`SELECT * FROM portal_users ${site ? "WHERE lower(site) = lower($1)" : ""} ORDER BY lower(site), lower(username)`, site ? [site] : []);
    res.json({ ok: true, canManage: manage, portalUrl: `${config3.baseUrl}/portal`, accounts: manage ? rows.map(out) : rows.map((u) => ({ id: u.id, site: u.site, username: u.username, name: u.display_name, active: u.active })) });
  }));
  api.post("/portal-accounts", w(async (req, res) => {
    await guard(req);
    const b = req.body || {};
    const site = clean(b.site, 200), username = clean(b.username, 60).toLowerCase(), name = clean(b.name, 120);
    if (!site || !(await one("SELECT 1 FROM lookups WHERE kind = 'site' AND lower(value) = lower($1)", [site]))) throw bad("ไม่พบลูกค้านี้ในรายชื่อ");
    if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)) throw bad("Username ใช้ a-z 0-9 . _ - ยาว 3–60 ตัว ขึ้นต้นด้วยตัวอักษรหรือตัวเลข");
    if (!name) throw bad("กรุณาใส่ชื่อผู้ใช้");
    const email = clean(b.email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("รูปแบบ email ไม่ถูกต้อง");
    if (await one("SELECT 1 FROM portal_users WHERE lower(username) = $1", [username])) throw bad("Username นี้มีแล้ว");
    const temp = tempPassword();
    const u = await one(
      `INSERT INTO portal_users (site, username, display_name, email, phone, password_hash, must_change, created_by)
       VALUES ((SELECT value FROM lookups WHERE kind='site' AND lower(value) = lower($1) LIMIT 1), $2, $3, $4, $5, $6, true, $7) RETURNING *`,
      [site, username, name, email || null, clean(b.phone, 60) || null, await bcrypt.hash(temp, 11), req.user.id]
    );
    await audit(req.user, "portal_account_create", username, { site: u.site });
    res.json({ ok: true, account: out(u), tempPassword: temp });
  }));
  api.post("/portal-accounts/:id(\\d+)/reset", w(async (req, res) => {
    await guard(req);
    const temp = tempPassword();
    const u = await one(
      "UPDATE portal_users SET password_hash = $2, must_change = true, failed_count = 0, locked_until = NULL, session_version = session_version + 1 WHERE id = $1 RETURNING *",
      [Number(req.params.id), await bcrypt.hash(temp, 11)]
    );
    if (!u) throw bad("ไม่พบบัญชี", 404);
    await audit(req.user, "portal_account_reset", u.username, { site: u.site });
    res.json({ ok: true, account: out(u), tempPassword: temp });
  }));
  api.put("/portal-accounts/:id(\\d+)", w(async (req, res) => {
    await guard(req);
    const b = req.body || {};
    const u = await one(
      `UPDATE portal_users SET active = coalesce($2, active), display_name = coalesce(nullif($3,''), display_name), email = coalesce($4, email), phone = coalesce($5, phone),
         locked_until = CASE WHEN $6 THEN NULL ELSE locked_until END, failed_count = CASE WHEN $6 THEN 0 ELSE failed_count END,
         session_version = CASE WHEN $2 = false THEN session_version + 1 ELSE session_version END
       WHERE id = $1 RETURNING *`,
      [Number(req.params.id), typeof b.active === "boolean" ? b.active : null, clean(b.name, 120), b.email === undefined ? null : clean(b.email, 200), b.phone === undefined ? null : clean(b.phone, 60), !!b.unlock]
    );
    if (!u) throw bad("ไม่พบบัญชี", 404);
    await audit(req.user, "portal_account_update", u.username, { site: u.site, active: b.active, unlock: !!b.unlock });
    res.json({ ok: true, account: out(u) });
  }));
}

function attach(app) {
  app.use("/api/portal", router);
  const page = path.join(__dirname, "../../public3/portal.html");
  app.get(["/portal", "/portal/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(page);
  });
  app.get("/portal.js", (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(__dirname, "../../public3/portal.js")); });
}

module.exports = { attach, mountStaff, policyProblems, statusOf };
