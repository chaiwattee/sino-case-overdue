// Sessions (signed cookie), Microsoft SSO (OIDC auth-code + PKCE) and local password accounts.
const crypto = require("crypto");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const express = require("express");
const { config3 } = require("./config3");
const { one, q, all, audit } = require("./db");

const SID = "sid";
const OIDC = "oidc";
const secure = config3.baseUrl.startsWith("https://");

// ------------------------------------------------------------ cookies
function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", config3.sessionSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const want = crypto.createHmac("sha256", config3.sessionSecret).update(body).digest("base64url");
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((p) => {
      const i = p.indexOf("=");
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  res.append("Set-Cookie", parts.join("; "));
}

const ssoMaxMs = () => config3.ssoSessionHours * 3600000;

async function startSession(res, user, remember = true) {
  // Password accounts: 7 days (or 1 day). Microsoft accounts: short, so access ends soon after the M365 account is removed.
  const ms = user.auth_type === "sso" ? ssoMaxMs() : (remember ? config3.sessionDays : 1) * 86400000;
  const now = Date.now();
  const token = sign({ uid: user.id, v: user.session_version, iat: now, exp: now + ms });
  setCookie(res, SID, token, Math.floor(ms / 1000));
  await q("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
}

const USER_COLS = "id, email, display_name, role, auth_type, must_change_password, active, session_version, phone, department, job_title, profile_confirmed_at, avatar, lang";

async function loadUser(id) {
  const u = await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  if (!u) return null;
  u.teams = (await all("SELECT team FROM user_teams WHERE user_id = $1 ORDER BY team", [id])).map((r) => r.team);
  return u;
}

/** Express middleware: attaches req.user or answers 401. */
function requireUser({ allowMustChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const s = verify(cookies(req)[SID]);
      const user = s && (await loadUser(s.uid));
      if (!user || !user.active || user.session_version !== s.v) {
        return res.status(401).json({ error: "กรุณาเข้าสู่ระบบ", code: "LOGIN" });
      }
      // Also cuts off Microsoft sessions issued before this limit existed (no iat) or older than the limit.
      if (user.auth_type === "sso" && (!s.iat || Date.now() - s.iat > ssoMaxMs())) {
        return res.status(401).json({ error: "กรุณาเข้าสู่ระบบอีกครั้ง", code: "LOGIN" });
      }
      if (user.must_change_password && !allowMustChange) {
        return res.status(403).json({ error: "กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน", code: "MUST_CHANGE" });
      }
      // Simple CSRF guard: state-changing requests must come from our own fetch() calls.
      if (!["GET", "HEAD"].includes(req.method) && req.get("X-Requested-With") !== "fetch") {
        return res.status(403).json({ error: "คำขอไม่ถูกต้อง" });
      }
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ------------------------------------------------------------ password rules / rate limit
function passwordProblem(pw) {
  if (!pw || pw.length < 10) return "รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข";
  return null;
}
const attempts = new Map(); // key -> [timestamps]
function tooMany(key, limit = 5, windowMs = 15 * 60000) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  attempts.set(key, list);
  return list.length >= limit;
}
function noteFail(key) {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}

function tempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  const bytes = crypto.randomBytes(12);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "7";
}

// ------------------------------------------------------------ routes
const router = express.Router();
// Body parsers only for the sign-in routes: this router is mounted for every request, and a parser here would read
// (and size-limit) every body first, so file uploads elsewhere failed with "request entity too large".
router.use("/auth", express.json({ limit: "50kb" }));
router.use("/auth", express.urlencoded({ extended: false, limit: "10kb" }));

function ssoReady() {
  return !!(config3.sso.clientId && config3.sso.clientSecret && config3.sso.tenantId);
}

router.get("/auth/config", (req, res) => res.json({ sso: ssoReady(), company: config3.company }));

router.get("/auth/login", (req, res) => {
  if (!ssoReady()) return res.redirect("/login.html?e=sso_off");
  const state = b64u(crypto.randomBytes(16));
  const nonce = b64u(crypto.randomBytes(16));
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const remember = req.query.remember !== "0";
  setCookie(res, OIDC, sign({ state, nonce, verifier, remember, exp: Date.now() + 10 * 60000 }), 600);
  const p = new URLSearchParams({
    client_id: config3.sso.clientId,
    response_type: "code",
    redirect_uri: `${config3.baseUrl}/auth/callback`,
    response_mode: "query",
    scope: "openid profile email User.Read",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  res.redirect(`https://login.microsoftonline.com/${config3.sso.tenantId}/oauth2/v2.0/authorize?${p}`);
});

router.get("/auth/callback", async (req, res) => {
  const back = (code) => res.redirect(`/login.html?e=${code}`);
  try {
    const saved = verify(cookies(req)[OIDC]);
    setCookie(res, OIDC, "", 0);
    if (req.query.error) return back("ms_" + encodeURIComponent(String(req.query.error).slice(0, 40)));
    if (!saved || saved.state !== req.query.state || !req.query.code) return back("state");

    const tok = await axios.post(
      `https://login.microsoftonline.com/${config3.sso.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: config3.sso.clientId,
        client_secret: config3.sso.clientSecret,
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: `${config3.baseUrl}/auth/callback`,
        code_verifier: saved.verifier,
      }),
      { timeout: 20000 }
    );
    // The id_token comes straight from Microsoft's token endpoint over TLS, so its claims are trusted;
    // we still check audience, tenant, nonce and expiry.
    const claims = JSON.parse(Buffer.from(tok.data.id_token.split(".")[1], "base64url").toString());
    if (claims.aud !== config3.sso.clientId || claims.tid !== config3.sso.tenantId) return back("aud");
    if (claims.nonce !== saved.nonce || claims.exp * 1000 < Date.now()) return back("nonce");
    const email = String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase();
    if (!email) return back("noemail");

    let user = await one(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1`, [email]);
    if (!user) {
      const count = Number((await one("SELECT count(*)::int AS n FROM users")).n);
      if (config3.bootstrapAdmin && email === config3.bootstrapAdmin && count === 0) {
        user = await one(
          `INSERT INTO users (email, display_name, role, auth_type) VALUES ($1,$2,'admin','sso') RETURNING ${USER_COLS}`,
          [email, claims.name || email]
        );
        await q("INSERT INTO user_teams (user_id, team) SELECT $1, code FROM teams", [user.id]);
        await audit(user, "bootstrap_admin", email);
      } else if (config3.requesterDomains.includes(email.split("@")[1])) {
        // Staff from other teams: a "requester" account is made on first sign-in. They only see their own service requests.
        user = await one(
          `INSERT INTO users (email, display_name, role, auth_type) VALUES ($1,$2,'requester','sso') RETURNING ${USER_COLS}`,
          [email, claims.name || email]
        );
        await audit(user, "requester_created", email, { via: "sso" });
      } else {
        await audit(null, "login_denied", email, { reason: "not_registered" });
        return back("notuser");
      }
    }
    if (!user.active) {
      await audit(user, "login_failed", email, { method: "sso", reason: "disabled" });
      return back("disabled");
    }
    // Signed in by email link before, now has a Microsoft account: switch to Microsoft sign-in.
    if (user.auth_type === "email") {
      await q("UPDATE users SET auth_type = 'sso', updated_at = now() WHERE id = $1", [user.id]);
      user.auth_type = "sso";
    }
    if (user.auth_type !== "sso") return back("uselocal");
    if (claims.name && claims.name !== user.display_name && user.display_name === user.email) {
      await q("UPDATE users SET display_name = $1 WHERE id = $2", [claims.name, user.id]);
    }
    // Department, job title and phone from the company directory fill blanks only (the user confirms or edits them).
    if (tok.data.access_token && (!user.phone || !user.department || !user.job_title)) {
      try {
        const me = (await axios.get("https://graph.microsoft.com/v1.0/me?$select=department,jobTitle,mobilePhone,businessPhones", { headers: { Authorization: `Bearer ${tok.data.access_token}` }, timeout: 10000 })).data;
        const phone = me.mobilePhone || (me.businessPhones || [])[0] || null;
        await q(
          `UPDATE users SET department = COALESCE(NULLIF(department, ''), $2), job_title = COALESCE(NULLIF(job_title, ''), $3), phone = COALESCE(NULLIF(phone, ''), $4) WHERE id = $1`,
          [user.id, (me.department || "").slice(0, 120) || null, (me.jobTitle || "").slice(0, 120) || null, (phone || "").slice(0, 60) || null]
        );
      } catch (e) {
        console.warn("[sso] profile from directory:", e.response?.status || e.message);
      }
    }
    await startSession(res, user, saved.remember);
    await audit(user, "login", email, { method: "sso" });
    res.redirect("/");
  } catch (e) {
    console.error("[sso] callback failed:", e.response?.data?.error_description || e.message);
    back("failed");
  }
});

router.post("/auth/local", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const key = `${req.ip}|${email}`;
  if (tooMany(key)) {
    await audit(null, "login_locked", email, { method: "password" });
    return res.status(429).json({ error: "ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่" });
  }
  const user = await one(`SELECT ${USER_COLS}, password_hash FROM users WHERE lower(email) = $1`, [email]);
  const ok = user && user.auth_type === "local" && user.password_hash && (await bcrypt.compare(password, user.password_hash));
  if (!ok || !user.active) {
    noteFail(key);
    await audit(user || null, "login_failed", email, { method: "password", reason: !user ? "unknown_email" : !user.active ? "disabled" : user.auth_type === "sso" ? "sso_account" : "wrong_password" });
    if (user && user.auth_type === "sso") return res.status(400).json({ error: "บัญชีนี้ใช้ปุ่มเข้าด้วยบัญชี Microsoft" });
    if (user && user.auth_type === "email") return res.status(400).json({ error: "บัญชีนี้เข้าด้วยลิงก์ทาง email กด \"รับลิงก์เข้าระบบทาง email\"" });
    return res.status(401).json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  attempts.delete(key);
  await startSession(res, user, req.body.remember !== false);
  await audit(user, "login", email, { method: "password" });
  res.json({ ok: true, mustChange: user.must_change_password });
});

// ------------------------------------------------------------ sign-in link by email (staff without Microsoft 365)
// Step 1 asks for a link; step 2 is a POST from the login page, so mail scanners that open links do not use it up.
const LINK_MINUTES = 15;
const linkHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
router.post("/auth/email-link", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const generic = { ok: true, message: `ถ้า ${email} ใช้งานระบบได้ จะได้รับ email ลิงก์เข้าระบบภายใน 1–2 นาที ลิงก์ใช้ได้ ${LINK_MINUTES} นาที ครั้งเดียว` };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "ใส่ email ให้ถูกต้อง" });
  const domain = email.split("@")[1];
  if (!config3.requesterDomains.includes(domain)) return res.status(400).json({ error: `ใช้ได้เฉพาะ email ของบริษัท (@${config3.requesterDomains.join(", @")})` });
  if (tooMany(`link-ip:${req.ip}`, 10, 3600000)) return res.status(429).json({ error: "ขอลิงก์บ่อยเกินไป รอสักครู่แล้วลองใหม่" });
  noteFail(`link-ip:${req.ip}`);
  if (tooMany(`link:${email}`, 3, 3600000)) return res.json(generic); // quietly: no more mail to this address this hour
  noteFail(`link:${email}`);
  const user = await one(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1`, [email]);
  const graph = require("../graph");
  const { shell } = require("../emails");
  try {
    if (user && (!user.active || user.role !== "requester")) {
      // Accounts with other roles keep their own sign-in method; tell them which one instead of sending a link.
      const how = !user.active ? "บัญชีนี้ถูกปิดใช้งาน ติดต่อ Admin" : user.auth_type === "sso" ? "บัญชีนี้เข้าด้วยปุ่ม \"เข้าสู่ระบบด้วยบัญชีบริษัท\" (Microsoft)" : "บัญชีนี้เข้าด้วยอีเมลและรหัสผ่านของระบบ ถ้าลืมรหัสผ่านติดต่อ Admin";
      await graph.sendMail({ to: [email], cc: [], subject: "Sino Case SLA: วิธีเข้าสู่ระบบของคุณ", html: shell("#5B6675", `<p style="margin:0">มีการขอลิงก์เข้าระบบด้วย email นี้<br>${how}</p><p style="margin:14px 0 0;color:#5B6675;font-size:13px">ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร</p>`) });
      await audit(user, "email_link_refused", email, { reason: !user.active ? "disabled" : "role_" + user.role });
      return res.json(generic);
    }
    const token = b64u(crypto.randomBytes(32));
    await q("DELETE FROM login_links WHERE expires_at < now() - interval '1 day'");
    await q(`INSERT INTO login_links (email, token_hash, ip, expires_at) VALUES ($1,$2,$3, now() + interval '${LINK_MINUTES} minutes')`, [email, linkHash(token), req.ip]);
    const url = `${config3.baseUrl}/login.html?link=${token}`;
    await graph.sendMail({
      to: [email], cc: [],
      subject: "Sino Case SLA: ลิงก์เข้าสู่ระบบ",
      html: shell("#1F5FBF", `<p style="margin:0 0 14px">กดปุ่มด้านล่างเพื่อเข้าสู่ระบบ Sino Case SLA (คำขอบริการ)<br>ลิงก์ใช้ได้ <strong>${LINK_MINUTES} นาที</strong> และใช้ได้ครั้งเดียว</p>
<p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#1F5FBF;color:#fff;text-decoration:none;font-weight:700">เข้าสู่ระบบ</a></p>
<p style="margin:0;color:#5B6675;font-size:13px">ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร ไม่มีใครเข้าบัญชีได้หากไม่มีลิงก์นี้<br>ห้ามส่งต่อ email นี้ให้ผู้อื่น</p>`),
    });
    await audit(user || null, "email_link_sent", email, { newUser: !user });
  } catch (e) {
    console.error("[auth] email link:", e.message);
    return res.status(502).json({ error: "ส่ง email ไม่สำเร็จ ลองใหม่อีกครั้ง หรือติดต่อ Admin" });
  }
  res.json(generic);
});
router.post("/auth/email-link/use", async (req, res) => {
  const token = String(req.body.token || "");
  if (tooMany(`link-use:${req.ip}`, 20, 15 * 60000)) return res.status(429).json({ error: "ลองหลายครั้งเกินไป รอ 15 นาที" });
  const row = await one(
    "UPDATE login_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email",
    [linkHash(token)]
  );
  if (!row) {
    noteFail(`link-use:${req.ip}`);
    return res.status(400).json({ error: "ลิงก์หมดอายุหรือถูกใช้ไปแล้ว ขอลิงก์ใหม่ได้ที่หน้านี้" });
  }
  const email = row.email.toLowerCase();
  let user = await one(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1`, [email]);
  if (user && (!user.active || user.role !== "requester")) {
    await audit(user, "email_link_refused", email, { at: "use" });
    return res.status(403).json({ error: !user.active ? "บัญชีนี้ถูกปิดใช้งาน ติดต่อ Admin" : "บัญชีนี้ใช้วิธีเข้าสู่ระบบแบบอื่น" });
  }
  if (!user) {
    user = await one(
      `INSERT INTO users (email, display_name, role, auth_type) VALUES ($1,$2,'requester','email') RETURNING ${USER_COLS}`,
      [email, email.split("@")[0]]
    );
    await audit(user, "requester_created", email, { via: "email_link" });
  }
  await startSession(res, user, true);
  await audit(user, "login", email, { method: "email_link" });
  res.json({ ok: true });
});

router.post("/auth/logout", async (req, res) => {
  const s = verify(cookies(req)[SID]);
  if (s && s.uid) {
    const u = await one("SELECT id, email, display_name FROM users WHERE id=$1", [s.uid]).catch(() => null);
    if (u) await audit(u, "logout", u.email);
  }
  setCookie(res, SID, "", 0);
  res.json({ ok: true });
});

router.post("/auth/change-password", requireUser({ allowMustChange: true }), async (req, res) => {
  const u = await one("SELECT id, auth_type, password_hash, must_change_password FROM users WHERE id = $1", [req.user.id]);
  if (u.auth_type !== "local") return res.status(400).json({ error: "บัญชี Microsoft เปลี่ยนรหัสผ่านที่ Microsoft" });
  if (!u.must_change_password && !(await bcrypt.compare(String(req.body.current || ""), u.password_hash || ""))) {
    return res.status(400).json({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
  }
  const problem = passwordProblem(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  const hash = await bcrypt.hash(req.body.password, 12);
  const r = await one(
    `UPDATE users SET password_hash=$1, must_change_password=false, session_version=session_version+1, updated_at=now()
     WHERE id=$2 RETURNING ${USER_COLS}`,
    [hash, u.id]
  );
  await startSession(res, r, true);
  await audit(req.user, "password_changed", req.user.email);
  res.json({ ok: true });
});

router.post("/auth/reset", async (req, res) => {
  const token = String(req.body.token || "");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await one("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1", [hash]);
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "ลิงก์หมดอายุหรือถูกใช้ไปแล้ว ขอลิงก์ใหม่จาก Admin" });
  }
  const problem = passwordProblem(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  await q(
    "UPDATE users SET password_hash=$1, must_change_password=false, session_version=session_version+1, updated_at=now() WHERE id=$2",
    [await bcrypt.hash(req.body.password, 12), row.user_id]
  );
  await q("UPDATE password_resets SET used_at = now() WHERE token_hash = $1", [hash]);
  await audit({ id: row.user_id }, "password_reset_done", String(row.user_id));
  res.json({ ok: true });
});

async function createResetLink(userId) {
  const token = b64u(crypto.randomBytes(32));
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await q("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '24 hours')", [
    hash,
    userId,
  ]);
  return `${config3.baseUrl}/login.html?reset=${token}`;
}

module.exports = { router, requireUser, loadUser, passwordProblem, tempPassword, createResetLink, ssoReady, sign, verify };
