// Phone / browser notifications (Web Push) for the installed app (PWA).
// Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT) in .env; without them push stays off.
const webpush = require("web-push");
const { q, one, all, audit } = require("./db");
const { config } = require("../config");

const PUB = process.env.VAPID_PUBLIC_KEY || "";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const enabled = !!(PUB && PRIV);
if (enabled) {
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.BOOTSTRAP_ADMIN_EMAIL || "support@sinostech.co.th"}`, PUB, PRIV);
  } catch (e) {
    console.error("[push] VAPID keys invalid:", e.message);
  }
}
// Only the browsers' own push services (the server never calls an address a browser made up).
const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com|web\.push\.apple\.com)$/i;

/** Send one notification to these users' devices. Never throws. */
async function send(userIds, { title, body = "", url = "/", tag } = {}) {
  if (!enabled) return { sent: 0, off: true };
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { sent: 0 };
  const subs = await all("SELECT * FROM push_subscriptions WHERE user_id = ANY($1)", [ids]).catch(() => []);
  let sent = 0;
  const msg = JSON.stringify({ title: String(title).slice(0, 120), body: String(body).slice(0, 300), url, tag });
  for (const s of subs) {
    if (config.dryRunEmail) {
      console.log(`[DRY RUN push] user=${s.user_id} ${title}`);
      sent++;
      continue;
    }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { TTL: 86400, urgency: "high", timeout: 10000 });
      await q("UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1", [s.id]);
      sent++;
    } catch (e) {
      // Gone / expired subscriptions are removed; other errors are left for the next try.
      if (e.statusCode === 404 || e.statusCode === 410) await q("DELETE FROM push_subscriptions WHERE id = $1", [s.id]);
      else console.error("[push]", e.statusCode || "", e.message);
    }
  }
  return { sent };
}

/** Members of a team (or admins + managers when the team is not known). */
async function teamUsers(team) {
  const rows = team
    ? await all("SELECT DISTINCT u.id FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role IN ('admin','manager','engineer') AND t.team = $1", [team])
    : await all("SELECT id FROM users WHERE active AND role IN ('admin','manager')");
  return rows.map((r) => r.id);
}
async function teamManagerIds(team) {
  return (await all("SELECT DISTINCT u.id FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = $1", [team])).map((r) => r.id);
}

function mount(api, { wrap }) {
  api.get("/push", wrap(async (req, res) => {
    const n = await one("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [req.user.id]);
    res.json({ enabled, publicKey: enabled ? PUB : null, devices: n.n });
  }));
  api.post("/push/subscribe", wrap(async (req, res) => {
    if (!enabled) throw Object.assign(new Error("ระบบยังไม่เปิดการแจ้งเตือนบนมือถือ (Admin ต้องตั้ง VAPID key)"), { status: 400 });
    const s = req.body || {};
    let host = "";
    try {
      const u = new URL(String(s.endpoint || ""));
      if (u.protocol === "https:") host = u.hostname;
    } catch (e) {}
    if (!PUSH_HOST.test(host) || !s.keys || !s.keys.p256dh || !s.keys.auth) throw Object.assign(new Error("ข้อมูลการแจ้งเตือนจากเบราว์เซอร์ไม่ถูกต้อง"), { status: 400 });
    await q(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5`,
      [req.user.id, String(s.endpoint).slice(0, 1000), String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 100), String(req.headers["user-agent"] || "").slice(0, 300)]
    );
    await audit(req.user, "push_subscribe", null, { host });
    res.json({ ok: true });
  }));
  api.post("/push/unsubscribe", wrap(async (req, res) => {
    await q("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [req.user.id, String((req.body || {}).endpoint || "")]);
    res.json({ ok: true });
  }));
  api.post("/push/test", wrap(async (req, res) => {
    res.json({ ok: true, ...(await send([req.user.id], { title: "ทดสอบการแจ้งเตือน", body: "ถ้าเห็นข้อความนี้ แปลว่าการแจ้งเตือนบนเครื่องนี้ใช้ได้แล้ว", url: "/#/mine", tag: "test" })) });
  }));
}

module.exports = { mount, send, teamUsers, teamManagerIds, enabled };
