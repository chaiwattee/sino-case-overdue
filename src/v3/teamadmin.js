// Teams: add, rename and order them from Settings (Admin). A team can be deleted only while nothing uses it.
const { q, one, all, tx, audit, getSetting, setSetting } = require("./db");

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const CODE = /^[A-Z][A-Z0-9_]{1,19}$/;
const cleanLabel = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);

async function list() {
  return all(
    `SELECT t.code, t.label, t.sort,
            (SELECT count(*)::int FROM user_teams u JOIN users x ON x.id = u.user_id WHERE u.team = t.code AND x.active) AS users,
            (SELECT count(*)::int FROM cases c WHERE c.team = t.code AND c.closed_at IS NULL) AS open_cases,
            (SELECT count(*)::int FROM cases c WHERE c.team = t.code) AS cases,
            (SELECT count(*)::int FROM service_requests s WHERE s.team = t.code) AS requests
       FROM teams t ORDER BY t.sort, t.code`
  );
}

/** A code from the name when none is given: "NPM & CXone PM" -> "NPM_CXONE_PM". */
function codeFrom(label) {
  const c = String(label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  return /^[A-Z]/.test(c) ? c : c ? "T_" + c.slice(0, 18) : "";
}

function mount(api, { wrap, need }) {
  const admin = need("settings_manage");
  api.get("/teams-admin", admin, wrap(async (req, res) => res.json({ teams: await list() })));

  api.post("/teams-admin", admin, wrap(async (req, res) => {
    const label = cleanLabel(req.body && req.body.label);
    if (label.length < 2) throw bad("ใส่ชื่อทีม");
    const code = String((req.body && req.body.code) || codeFrom(label)).trim().toUpperCase();
    if (!CODE.test(code)) throw bad("รหัสทีมใช้ A–Z, 0–9 และ _ ขึ้นต้นด้วยตัวอักษร 2–20 ตัว");
    if (await one("SELECT 1 FROM teams WHERE code = $1", [code])) throw bad(`มีรหัสทีม ${code} แล้ว`);
    if (await one("SELECT 1 FROM teams WHERE lower(label) = lower($1)", [label])) throw bad(`มีทีมชื่อ "${label}" แล้ว`);
    const max = await one("SELECT coalesce(max(sort), 0)::int AS m FROM teams");
    await q("INSERT INTO teams (code, label, sort) VALUES ($1,$2,$3)", [code, label, max.m + 1]);
    await audit(req.user, "team_create", code, { label });
    res.json({ ok: true, code, teams: await list() });
  }));

  api.put("/teams-admin/:code", admin, wrap(async (req, res) => {
    const code = String(req.params.code);
    const t = await one("SELECT * FROM teams WHERE code = $1", [code]);
    if (!t) throw bad("ไม่พบทีม", 404);
    const label = cleanLabel(req.body && req.body.label);
    if (label.length < 2) throw bad("ใส่ชื่อทีม");
    if (await one("SELECT 1 FROM teams WHERE lower(label) = lower($1) AND code <> $2", [label, code])) throw bad(`มีทีมชื่อ "${label}" แล้ว`);
    await q("UPDATE teams SET label = $2 WHERE code = $1", [code, label]);
    if (label !== t.label) await audit(req.user, "team_rename", code, { from: t.label, to: label });
    res.json({ ok: true, teams: await list() });
  }));

  // Order: the full list of codes in the new order.
  api.put("/teams-admin-order", admin, wrap(async (req, res) => {
    const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(String) : [];
    const codes = (await all("SELECT code FROM teams")).map((r) => r.code);
    if (order.length !== codes.length || !codes.every((c) => order.includes(c))) throw bad("ลำดับทีมไม่ครบ");
    await tx(async (c) => {
      for (const [i, code] of order.entries()) await c.query("UPDATE teams SET sort = $2 WHERE code = $1", [code, i + 1]);
    });
    await audit(req.user, "team_order", null, { order });
    res.json({ ok: true, teams: await list() });
  }));

  api.delete("/teams-admin/:code", admin, wrap(async (req, res) => {
    const code = String(req.params.code);
    const t = (await list()).find((x) => x.code === code);
    if (!t) throw bad("ไม่พบทีม", 404);
    if (t.cases || t.requests) throw bad(`ลบไม่ได้: ทีมนี้มีเคส ${t.cases} เคส / คำขอบริการ ${t.requests} รายการ (เปลี่ยนชื่อทีมแทนได้)`);
    try {
      await tx(async (c) => {
        await c.query("DELETE FROM user_teams WHERE team = $1", [code]);
        await c.query("DELETE FROM teams WHERE code = $1", [code]);
      });
    } catch (e) {
      if (e.code === "23503") throw bad("ลบไม่ได้: ยังมีข้อมูลที่ใช้ทีมนี้อยู่ (เช่น งาน PM) เปลี่ยนชื่อทีมแทนได้");
      throw e;
    }
    // Teams alert settings for this team are dropped too.
    const tn = await getSetting("teams_notify", null);
    if (tn && tn.channels && tn.channels[code]) {
      delete tn.channels[code];
      await setSetting("teams_notify", tn);
    }
    await audit(req.user, "team_delete", code, { label: t.label, users: t.users });
    res.json({ ok: true, teams: await list() });
  }));
}

module.exports = { mount, list, codeFrom };
