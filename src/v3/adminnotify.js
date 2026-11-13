"use strict";
// Who receives the system's own warnings (backup failed, the case mailbox cannot be read, a new department was asked for,
// the app stopped answering): every active admin, plus the addresses an admin adds in Settings so one person away
// does not mean nobody sees them.
const { all, getSetting, setSetting, audit } = require("./db");

const KEY = "admin_notify";
const MAX = 10;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

async function extra() {
  const s = (await getSetting(KEY, null)) || {};
  return Array.isArray(s.emails) ? s.emails : [];
}
/** Admin accounts first, then the extra addresses; lower case, no repeats. */
async function adminEmails() {
  const admins = (await all("SELECT email FROM users WHERE active AND role = 'admin' AND email IS NOT NULL")).map((r) => r.email);
  return [...new Set([...admins, ...(await extra())].map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
}

function mount(api, { wrap, need }) {
  api.get("/settings/admin-notify", need("settings_manage"), wrap(async (req, res) => {
    res.json({ emails: await extra(), admins: (await all("SELECT display_name, email FROM users WHERE active AND role = 'admin' ORDER BY display_name")).map((u) => ({ name: u.display_name, email: u.email })) });
  }));
  api.put("/settings/admin-notify", need("settings_manage"), wrap(async (req, res) => {
    const list = [...new Set(String(req.body?.emails || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = list.find((x) => !EMAIL.test(x) || x.length > 200);
    if (bad) throw Object.assign(new Error(`อีเมลไม่ถูกต้อง: ${bad}`), { status: 400 });
    if (list.length > MAX) throw Object.assign(new Error(`ใส่ได้ไม่เกิน ${MAX} อีเมล`), { status: 400 });
    await setSetting(KEY, { emails: list });
    await audit(req.user, "admin_notify_settings", null, { emails: list });
    res.json({ ok: true, emails: list });
  }));
}

module.exports = { adminEmails, mount };
