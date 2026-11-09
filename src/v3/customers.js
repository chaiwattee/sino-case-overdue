// New customers (Site) typed on a case: a manager of the case's team approves, renames or merges the name.
// Until then the case runs normally but cannot be closed, and the name stays out of other people's dropdown.
const { q, one, all, tx, audit } = require("./db");
const perms = require("./perms");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Managers of `team` (the admins when the team has none). */
async function approvers(team) {
  const rows = await all(
    `SELECT DISTINCT u.id, u.email, u.display_name FROM users u JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND u.role = 'manager' AND t.team = $1 AND u.email IS NOT NULL`,
    [team]
  );
  return rows.length ? rows : all("SELECT id, email, display_name FROM users WHERE active AND role = 'admin' AND email IS NOT NULL");
}
const canDecide = (user, team) => user.role === "admin" || (user.role === "manager" && (user.teams || []).includes(team));

/** Names in the list that look like `name` (shared word of 3+ letters, or one inside the other). */
async function similar(name, limit = 5) {
  const n = String(name).toLowerCase();
  const words = n.split(/[\s.,()\-/]+/).filter((w) => w.length >= 3);
  const rows = await all("SELECT id, value FROM lookups WHERE kind = 'site' AND active AND NOT pending AND lower(value) <> $1", [n]);
  return rows
    .map((r) => {
      const v = r.value.toLowerCase();
      const score = (v.includes(n) || n.includes(v) ? 3 : 0) + words.filter((w) => v.includes(w)).length;
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id, value }) => ({ id, value }));
}

/** Mark a site created from a case as pending and email the team's managers. */
async function onNewSite(user, site, kase) {
  const l = await one("UPDATE lookups SET pending = true, team = $2 WHERE kind = 'site' AND value = $1 AND is_new RETURNING *", [site, kase.team]);
  if (l) await notify(l, kase, user, false);
}

async function notify(l, kase, user, reminder) {
  const to = (await approvers(l.team)).map((u) => u.email);
  if (!to.length) return;
  const graph = require("../graph");
  const { esc, shell, button, fieldTable } = require("../emails");
  const { config3 } = require("./config3");
  const sim = await similar(l.value);
  const cases = kase ? [kase] : await all("SELECT id, case_no, task FROM cases WHERE site = $1 ORDER BY id LIMIT 5", [l.value]);
  const first = cases[0];
  await graph
    .sendMail({
      to, cc: [],
      subject: `[Sino Case SLA] ${reminder ? "เตือน: " : ""}ลูกค้าใหม่รออนุมัติ · ${l.value}`,
      html: shell("#B76E00", `<p style="margin:0 0 12px">${reminder ? "ยังรอการตรวจชื่อลูกค้าใหม่" : `${esc(user ? user.display_name : "-")} เปิดเคสด้วยชื่อลูกค้าที่ยังไม่มีในรายการ`} เคสทำงานต่อได้ แต่ <strong>ปิดเคสไม่ได้จนกว่าจะอนุมัติ</strong></p>
${fieldTable([["ลูกค้าใหม่", l.value], ["เคส", cases.map((c) => c.case_no || c.caseNo || "#" + c.id).join(", ") || "-"], ["ชื่อใกล้เคียงในรายการ", sim.map((s) => s.value).join(", ") || "ไม่มี"]])}
<p style="margin:14px 0 16px;color:#5B6576;font-size:14px">อนุมัติเป็นลูกค้าใหม่ แก้ชื่อ หรือรวมกับลูกค้าที่มีอยู่ ได้จากหน้าเคส</p>
${first ? button(`${config3.baseUrl}/#/case/${first.id}`, "ตรวจชื่อลูกค้า") : ""}`),
    })
    .catch((e) => console.error("[customers] notify:", e.message));
  await q("UPDATE lookups SET reminded_at = now() WHERE id = $1", [l.id]);
  await require("./teamsnotify").notify(l.team, "customer", {
    title: `🏢 ${reminder ? "เตือน: " : ""}ลูกค้าใหม่รออนุมัติ · ${l.value}`,
    color: "Warning",
    text: "เคสทำงานต่อได้ แต่ปิดเคสไม่ได้จนกว่า Manager จะอนุมัติชื่อ",
    facts: [["เปิดโดย", user ? user.display_name : "-"], ["เคส", cases.map((c) => c.case_no || c.caseNo || "#" + c.id).join(", ") || "-"], ["ชื่อใกล้เคียง", sim.map((s) => s.value).join(", ") || "ไม่มี"]],
    actions: first ? [["ตรวจชื่อลูกค้า", `${config3.baseUrl}/#/case/${first.id}`]] : [],
  });
}

/** Throws when a case cannot close because its customer is still waiting for approval. */
async function checkClose(site) {
  const l = site && (await one("SELECT value FROM lookups WHERE kind = 'site' AND lower(value) = lower($1) AND pending", [site]));
  if (l) throw bad(`ปิดเคสไม่ได้: ลูกค้า "${l.value}" ยังรอ Manager อนุมัติ ระบบแจ้ง Manager แล้ว กด "เตือน Manager อีกครั้ง" บนหน้าเคสได้`);
}

/** Daily reminder (workday mornings) for names still waiting. */
async function remindAll() {
  const rows = await all("SELECT * FROM lookups WHERE kind = 'site' AND pending AND (reminded_at IS NULL OR reminded_at < now() - interval '20 hours')");
  for (const l of rows) await notify(l, null, null, true);
  return { reminded: rows.length };
}

function mount(api, { wrap }) {
  // Pending names the viewer can decide on, with their cases and look-alike names.
  api.get("/customers/pending", wrap(async (req, res) => {
    const rows = await all("SELECT l.id, l.value, l.team, l.created_at, u.display_name AS created_by FROM lookups l LEFT JOIN users u ON u.id = l.created_by WHERE l.kind = 'site' AND l.pending ORDER BY l.created_at");
    const mine = rows.filter((r) => canDecide(req.user, r.team) || req.user.role === "observer");
    for (const r of mine) {
      r.cases = await all("SELECT id, case_no AS \"caseNo\", task FROM cases WHERE site = $1 ORDER BY id", [r.value]);
      r.similar = await similar(r.value);
      r.canDecide = canDecide(req.user, r.team);
    }
    res.json({ list: mine });
  }));

  api.get("/customers/pending/by-name", wrap(async (req, res) => {
    const l = await one("SELECT id, value, team, created_at FROM lookups WHERE kind = 'site' AND pending AND lower(value) = lower($1)", [String(req.query.site || "")]);
    if (!l) return res.json({ pending: null });
    res.json({ pending: { ...l, similar: await similar(l.value), canDecide: canDecide(req.user, l.team), all: (await all("SELECT id, value FROM lookups WHERE kind = 'site' AND active AND NOT pending ORDER BY lower(value)")) } });
  }));

  // action: approve | rename (value) | merge (into = lookup id)
  api.post("/customers/:id(\\d+)/decide", wrap(async (req, res) => {
    const l = await one("SELECT * FROM lookups WHERE id = $1 AND kind = 'site' AND pending", [Number(req.params.id)]);
    if (!l) throw bad("รายการนี้ถูกจัดการไปแล้ว รีเฟรชหน้า", 409);
    if (!canDecide(req.user, l.team)) throw bad("อนุมัติได้เฉพาะ Manager ของทีมเคสนี้หรือ Admin", 403);
    const b = req.body || {};
    let final = l.value;
    let note;
    await tx(async (c) => {
      if (b.action === "merge") {
        const dst = (await c.query("SELECT * FROM lookups WHERE id = $1 AND kind = 'site' AND NOT pending", [Number(b.into)])).rows[0];
        if (!dst) throw bad("เลือกลูกค้าที่จะรวม");
        final = dst.value;
        await c.query("DELETE FROM lookups WHERE id = $1", [l.id]);
        note = `รวมลูกค้า "${l.value}" เข้ากับ "${dst.value}"`;
      } else if (b.action === "rename") {
        const v = String(b.value || "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (v.length < 2) throw bad("พิมพ์ชื่อลูกค้าที่ถูกต้อง");
        const clash = (await c.query("SELECT 1 FROM lookups WHERE kind = 'site' AND lower(value) = lower($1) AND id <> $2", [v, l.id])).rows[0];
        if (clash) throw bad(`มีลูกค้า "${v}" อยู่แล้ว เลือก "รวมกับลูกค้าที่มีอยู่" แทน`);
        final = v;
        await c.query("UPDATE lookups SET value = $2, pending = false, is_new = false WHERE id = $1", [l.id, v]);
        note = `อนุมัติลูกค้าใหม่ โดยแก้ชื่อจาก "${l.value}" เป็น "${v}"`;
      } else {
        await c.query("UPDATE lookups SET pending = false, is_new = false WHERE id = $1", [l.id]);
        note = `อนุมัติลูกค้าใหม่ "${l.value}"`;
      }
      const cases = (await c.query("UPDATE cases SET site = $2, updated_at = now() WHERE site = $1 RETURNING id", [l.value, final])).rows;
      for (const k of cases)
        await c.query("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, $4, 'ลูกค้าใหม่', $2, true, $3)", [k.id, `${note} โดย ${req.user.display_name}`, req.user.id, require("../dates").toISODate(require("../dates").today())]);
    });
    await audit(req.user, "customer_decide", `${l.value} -> ${final}`, { action: b.action || "approve" });
    res.json({ ok: true, site: final });
  }));

  // "Remind the manager again" from the case page (at most once an hour per name).
  api.post("/customers/:id(\\d+)/remind", wrap(async (req, res) => {
    const l = await one("SELECT * FROM lookups WHERE id = $1 AND kind = 'site' AND pending", [Number(req.params.id)]);
    if (!l) throw bad("ลูกค้ารายนี้ไม่ได้รออนุมัติแล้ว", 409);
    if (l.reminded_at && Date.now() - new Date(l.reminded_at) < 3600000) throw bad("เพิ่งส่งเตือนไปไม่ถึง 1 ชั่วโมง รอสักครู่แล้วลองใหม่");
    await notify(l, null, req.user, true);
    res.json({ ok: true });
  }));
}

module.exports = { mount, onNewSite, checkClose, remindAll, similar };
