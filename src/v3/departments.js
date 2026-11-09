// Departments (หน่วยงาน): a list the admin keeps, picked from a dropdown so names are spelled the same for everyone.
// A person whose department is missing picks "other" and types it; the admins get an email to add it.
const { q, one, all, getSetting, setSetting, audit } = require("./db");

const KEY = "departments";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);

/** [{name, active}] — first use seeds the list from the departments people already have. */
async function list() {
  const saved = await getSetting(KEY, null);
  if (Array.isArray(saved)) return saved;
  const seen = (await all("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department <> '' ORDER BY department")).map((r) => r.department);
  const seed = [...new Set(["Service", ...seen])].map((name) => ({ name, active: true }));
  await setSetting(KEY, seed);
  return seed;
}
const activeNames = async () => (await list()).filter((d) => d.active).map((d) => d.name);

/**
 * Check a department chosen on a profile. Returns {value, requested}: `requested` = a new name typed under "other".
 * Keeping the department one already has is always fine, even if the admin later closed it.
 */
async function check(dept, other, current) {
  const v = clean(dept);
  if (v === "__other") {
    const o = clean(other);
    if (o.length < 2) throw Object.assign(new Error("พิมพ์ชื่อหน่วยงานที่ต้องการให้เพิ่ม"), { status: 400 });
    return { value: o, requested: !(await activeNames()).includes(o) };
  }
  if (!v) return { value: null, requested: false };
  if (v === clean(current) || (await activeNames()).includes(v)) return { value: v, requested: false };
  throw Object.assign(new Error("เลือกหน่วยงานจากรายการ หรือเลือก \"อื่นๆ\" เพื่อขอให้เพิ่ม"), { status: 400 });
}

/** Email the admins that someone asked for a department that is not in the list yet. */
async function notifyRequest(user, name) {
  const admins = (await all("SELECT email FROM users WHERE active AND role = 'admin' AND email IS NOT NULL")).map((r) => r.email);
  if (!admins.length) return;
  const graph = require("../graph");
  const { esc, shell, button } = require("../emails");
  const { config3 } = require("./config3");
  await graph
    .sendMail({
      to: admins, cc: [],
      subject: `[Sino Case SLA] ขอเพิ่มหน่วยงาน: ${name}`,
      html: shell("#1F5FBF", `<p style="margin:0 0 12px">${esc(user.display_name)} (${esc(user.email)}) ไม่พบหน่วยงานของตัวเองในรายการ จึงขอให้เพิ่ม <strong>${esc(name)}</strong></p>
<p style="margin:0 0 16px;color:#5B6576;font-size:14px">ระบบบันทึกชื่อนี้ไว้ในบัญชีของเขาแล้ว ถ้าชื่อถูกต้อง เพิ่มเข้ารายการให้คนอื่นเลือกได้ ถ้าซ้ำกับหน่วยงานที่มีอยู่ แก้ในหน้าจัดการผู้ใช้</p>
${button(`${config3.baseUrl}/#/settings`, "เปิดหน้าตั้งค่า → หน่วยงาน")}`),
    })
    .catch((e) => console.error("[departments] notify:", e.message));
}

function mount(api, { wrap, need }) {
  api.get("/departments", wrap(async (req, res) => res.json({ list: await list() })));
  // Save the whole list. An item with `was` set renames it: people who had the old name move to the new one.
  api.put("/departments", need("settings_manage"), wrap(async (req, res) => {
    const input = Array.isArray(req.body?.list) ? req.body.list : [];
    const out = [];
    const seen = new Set();
    for (const x of input) {
      const name = clean(x.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, active: x.active !== false });
      const was = clean(x.was);
      if (was && was !== name) {
        const r = await q("UPDATE users SET department = $2 WHERE department = $1", [was, name]);
        if (r.rowCount) await audit(req.user, "department_rename", `${was} → ${name}`, { users: r.rowCount });
      }
    }
    if (!out.length) throw Object.assign(new Error("ต้องมีหน่วยงานอย่างน้อย 1 รายการ"), { status: 400 });
    await setSetting(KEY, out);
    await audit(req.user, "departments_update", null, { count: out.length });
    res.json({ ok: true, list: out });
  }));
}

module.exports = { mount, list, activeNames, check, notifyRequest };
