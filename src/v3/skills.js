// Skill map: each User's level (0–4) in every product. Managers fill it on the page or with an Excel sheet;
// the page also shows how many cases each person actually handled per product, as a check on the levels.
const ExcelJS = require("exceljs");
const { q, one, all, tx, audit } = require("./db");
const perms = require("./perms");

const LEVELS = [
  { level: 0, label: "ยังทำไม่ได้", hint: "ไม่เคยทำ หรือยังไม่มีความรู้" },
  { level: 1, label: "พื้นฐาน", hint: "ทำตามคู่มือได้ ต้องมีคนช่วย" },
  { level: 2, label: "ทำเองได้", hint: "แก้เคสทั่วไปได้เอง" },
  { level: 3, label: "ชำนาญ", hint: "แก้ปัญหายาก ติดตั้ง / upgrade ได้" },
  { level: 4, label: "ผู้เชี่ยวชาญ", hint: "สอนคนอื่นได้ เป็นที่ปรึกษาของทีม" },
];
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const canEdit = (user) => user.role === "admin" || user.role === "manager";
const canView = (user) => ["admin", "manager", "observer"].includes(user.role);

async function products() {
  return (await all("SELECT value FROM lookups WHERE kind = 'product' AND active AND NOT pending ORDER BY sort, value")).map((r) => r.value);
}

/** Users and Managers the viewer may see on the map (a User sees only their own row). */
async function people(user, team) {
  const scope = perms.teamScope(user);
  const rows = await all(
    `SELECT u.id, u.display_name AS name, u.email, u.role, array_remove(array_agg(t.team ORDER BY t.team), NULL) AS teams
       FROM users u LEFT JOIN user_teams t ON t.user_id = u.id
      WHERE u.active AND u.role IN ('engineer', 'manager')
      GROUP BY u.id ORDER BY u.display_name`
  );
  return rows.filter((p) => {
    if (!canView(user)) return p.id === user.id;
    if (team && !p.teams.includes(team)) return false;
    return !scope || p.teams.some((t) => scope.includes(t));
  });
}

async function matrix(user, team) {
  const list = await people(user, team);
  const ids = list.map((p) => p.id);
  const prods = await products();
  const skills = {};
  const exp = {};
  if (ids.length) {
    for (const s of await all(
      `SELECT s.user_id, s.product, s.level, s.note, s.updated_at, u.display_name AS by FROM user_skills s LEFT JOIN users u ON u.id = s.updated_by WHERE s.user_id = ANY($1)`,
      [ids]
    ))
      (skills[s.user_id] ||= {})[s.product] = { level: s.level, note: s.note || "", at: s.updated_at, by: s.by || "" };
    // Cases each person owned per product in the last 12 months (not counting Cancel / N/A).
    for (const r of await all(
      `SELECT owner_id, product, count(*)::int AS n FROM cases
        WHERE owner_id = ANY($1) AND product IS NOT NULL AND start_date >= current_date - interval '12 months'
          AND lower(coalesce(status, '')) NOT IN ('cancel', 'n/a')
        GROUP BY owner_id, product`,
      [ids]
    ))
      (exp[r.owner_id] ||= {})[r.product] = r.n;
  }
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  const scope = perms.teamScope(user);
  return { levels: LEVELS, products: prods, people: list, skills, exp, canEdit: canEdit(user), canView: canView(user), teams: scope ? teams.filter((t) => scope.includes(t.code)) : teams };
}

async function checkTarget(user, userId) {
  const ok = (await people(user)).some((p) => p.id === userId);
  if (!ok) throw bad("แก้ได้เฉพาะคนในทีมของคุณ", 403);
}

async function setOne(user, { user_id, product, level, note }) {
  if (!canEdit(user)) throw bad("เฉพาะ Admin / Manager แก้ Skill ได้", 403);
  const uid = Number(user_id);
  await checkTarget(user, uid);
  if (!(await products()).includes(product)) throw bad("ไม่พบ Product นี้ในรายการ");
  if (level === null || level === "") {
    await q("DELETE FROM user_skills WHERE user_id = $1 AND product = $2", [uid, product]);
  } else {
    const lv = Number(level);
    if (!(lv >= 0 && lv <= 4 && Number.isInteger(lv))) throw bad("ระดับต้องเป็น 0–4");
    await q(
      `INSERT INTO user_skills (user_id, product, level, note, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id, product) DO UPDATE SET level = $3, note = $4, updated_by = $5, updated_at = now()`,
      [uid, product, lv, String(note || "").trim().slice(0, 300) || null, user.id]
    );
  }
  await audit(user, "skill_set", product, { user_id: uid, level: level === "" ? null : level });
}

// ------------------------------------------------------------ Excel
const HEAD = { email: ["email", "อีเมล", "e-mail"], name: ["ชื่อ", "name", "ชื่อที่แสดง"], team: ["ทีม", "team", "teams"], note: ["หมายเหตุ", "note"] };
const norm = (v) => {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.text) return String(v.text).trim();
    if (v.richText) return v.richText.map((r) => r.text).join("").trim();
    if (v.result != null) return String(v.result).trim();
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, "").trim();
  }
  return String(v).trim();
};
const COLORS = ["FFF1F3F6", "FFDCE8FA", "FFAFCBF3", "FF6E9FE6", "FF2F64C4"];

async function template(user, team) {
  const m = await matrix(user, team);
  const teamLabel = Object.fromEntries(m.teams.map((t) => [t.code, t.label]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Skill Map");
  ws.columns = [
    { header: "Email", key: "email", width: 32 },
    { header: "ชื่อ", key: "name", width: 24 },
    { header: "ทีม", key: "team", width: 22 },
    ...m.products.map((p) => ({ header: p, key: "p:" + p, width: Math.max(10, p.length + 4) })),
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  head.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  head.height = 30;
  for (const p of m.people) {
    const row = { email: p.email, name: p.name, team: p.teams.map((t) => teamLabel[t] || t).join(", ") };
    for (const pr of m.products) {
      const s = m.skills[p.id] && m.skills[p.id][pr];
      row["p:" + pr] = s ? s.level : null;
    }
    ws.addRow(row);
  }
  const last = Math.max(2, m.people.length + 1);
  const firstCol = 4;
  const lastCol = 3 + m.products.length;
  for (let r = 2; r <= last; r++) {
    ws.getCell(r, 1).font = { color: { argb: "FF5B6675" } };
    for (let c = firstCol; c <= lastCol; c++) {
      const cell = ws.getCell(r, c);
      cell.dataValidation = { type: "whole", operator: "between", allowBlank: true, formulae: [0, 4], showErrorMessage: true, errorTitle: "ระดับ 0–4", error: "ใส่ตัวเลข 0 ถึง 4 (ดูความหมายใน sheet “ระดับ”)" };
      cell.alignment = { horizontal: "center" };
    }
  }
  if (m.products.length) {
    const ref = `${ws.getColumn(firstCol).letter}2:${ws.getColumn(lastCol).letter}${last}`;
    ws.addConditionalFormatting({
      ref,
      rules: LEVELS.map((l, i) => ({ type: "cellIs", operator: "equal", formulae: [String(l.level)], priority: i + 1, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: COLORS[l.level] } }, font: l.level >= 3 ? { color: { argb: "FFFFFFFF" }, bold: true } : {} } })),
    });
  }
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];
  const help = wb.addWorksheet("ระดับ");
  help.columns = [{ width: 10 }, { width: 18 }, { width: 70 }];
  [["ระดับ", "ชื่อ", "ความหมาย"], ...LEVELS.map((l) => [l.level, l.label, l.hint]), [], ["", "วิธีกรอก", "ใส่ตัวเลข 0–4 ในช่องของแต่ละ Product · ช่องที่เว้นว่างจะไม่เปลี่ยนค่าเดิมในระบบ"], ["", "", "อย่าแก้คอลัมน์ Email (ใช้จับคู่คน) และหัวคอลัมน์ Product · คอลัมน์ ชื่อ และ ทีม ไว้ดูเท่านั้น"], ["", "", "เพิ่ม Product ใหม่ได้ที่หน้าตั้งค่าของระบบก่อน แล้วดาวน์โหลดแม่แบบใหม่"]].forEach((r, i) => {
    const row = help.addRow(r);
    if (i === 0) row.font = { bold: true };
    if (i >= 1 && i <= 5) row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS[i - 1] } };
    row.alignment = { wrapText: true, vertical: "top" };
  });
  return wb.xlsx.writeBuffer();
}

/** Reads the sheet and compares it with the system: returns what would change and any errors. */
async function plan(user, buf) {
  if (!canEdit(user)) throw bad("เฉพาะ Admin / Manager นำเข้า Skill ได้", 403);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (e) {
    throw bad("อ่านไฟล์ไม่ได้ ต้องเป็นไฟล์ .xlsx");
  }
  const ws = wb.getWorksheet("Skill Map") || wb.worksheets[0];
  if (!ws) throw bad("ไม่พบ sheet ในไฟล์");
  const prods = await products();
  const prodByKey = new Map(prods.map((p) => [p.toLowerCase(), p]));
  const col = {};
  const prodCols = [];
  const unknown = [];
  ws.getRow(1).eachCell((cell, c) => {
    const h = norm(cell.value);
    const k = h.toLowerCase();
    const fixed = Object.entries(HEAD).find(([, names]) => names.includes(k));
    if (fixed) col[fixed[0]] = c;
    else if (prodByKey.has(k)) prodCols.push({ c, product: prodByKey.get(k) });
    else if (h) unknown.push(h);
  });
  if (!col.email) throw bad("ไม่พบคอลัมน์ Email ในแถวแรก ใช้แม่แบบจากปุ่มดาวน์โหลด");
  if (!prodCols.length) throw bad("ไม่พบคอลัมน์ Product ที่ตรงกับในระบบ");
  const visible = new Map((await people(user)).map((p) => [p.email.toLowerCase(), p]));
  const allUsers = new Map((await all("SELECT id, lower(email) AS email FROM users")).map((u) => [u.email, u.id]));
  const ids = [...visible.values()].map((p) => p.id);
  const current = {};
  if (ids.length) for (const s of await all("SELECT user_id, product, level FROM user_skills WHERE user_id = ANY($1)", [ids])) (current[s.user_id] ||= {})[s.product] = s.level;
  const rows = [];
  const seen = new Set();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const email = norm(row.getCell(col.email).value).replace(/^mailto:/i, "").toLowerCase();
    const cells = prodCols.map((pc) => ({ product: pc.product, raw: norm(row.getCell(pc.c).value) }));
    if (!email && cells.every((x) => !x.raw)) continue;
    const out = { row: r, email, name: "", changes: [], errors: [] };
    const p = visible.get(email);
    if (!email) out.errors.push("ไม่มี Email");
    else if (!p) out.errors.push(allUsers.has(email) ? "คนนี้ไม่อยู่ในทีมของคุณ หรือไม่ใช่ User / Manager" : "ไม่พบ Email นี้ในระบบ");
    else if (seen.has(email)) out.errors.push("Email ซ้ำในไฟล์");
    seen.add(email);
    if (p) out.name = p.name;
    for (const x of cells) {
      if (!x.raw) continue;
      const lv = Number(x.raw);
      if (!(Number.isInteger(lv) && lv >= 0 && lv <= 4)) {
        out.errors.push(`${x.product}: “${x.raw}” ต้องเป็น 0–4`);
        continue;
      }
      const before = p && current[p.id] ? current[p.id][x.product] : undefined;
      if (before !== lv) out.changes.push({ product: x.product, from: before ?? null, to: lv });
    }
    out.userId = p ? p.id : null;
    rows.push(out);
  }
  if (rows.length > 500) throw bad("นำเข้าได้ครั้งละไม่เกิน 500 คน");
  const summary = { people: rows.length, changes: rows.reduce((n, r) => n + r.changes.length, 0), errors: rows.filter((r) => r.errors.length).length, unknownColumns: unknown };
  return { rows, summary };
}

async function apply(user, planned) {
  if (planned.summary.errors) throw bad(`มี ${planned.summary.errors} แถวที่ผิด แก้ไฟล์แล้วนำเข้าใหม่`);
  let n = 0;
  await tx(async (c) => {
    for (const r of planned.rows)
      for (const ch of r.changes) {
        await c.query(
          `INSERT INTO user_skills (user_id, product, level, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (user_id, product) DO UPDATE SET level = $3, updated_by = $4, updated_at = now()`,
          [r.userId, ch.product, ch.to, user.id]
        );
        n++;
      }
  });
  await audit(user, "skill_import", null, { people: planned.rows.length, changes: n });
  return { applied: n };
}

function mount(api, { wrap }) {
  api.get("/skills", wrap(async (req, res) => res.json(await matrix(req.user, req.query.team || ""))));
  api.put("/skills", wrap(async (req, res) => {
    await setOne(req.user, req.body || {});
    res.json({ ok: true });
  }));
  api.get("/skills/template", wrap(async (req, res) => {
    if (!canEdit(req.user)) throw bad("เฉพาะ Admin / Manager", 403);
    const buf = await template(req.user, req.query.team || "");
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", `attachment; filename="skill-map-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  }));
  // Body: { file: base64 xlsx, apply: boolean }. Without apply it only returns the plan.
  api.post("/skills/import", wrap(async (req, res) => {
    const b64 = String((req.body && req.body.file) || "").replace(/^data:[^,]*,/, "");
    if (!b64) throw bad("ไม่ได้แนบไฟล์");
    const planned = await plan(req.user, Buffer.from(b64, "base64"));
    if (!planned.rows.length) throw bad("ไม่พบข้อมูลในไฟล์");
    if (!(req.body && req.body.apply)) return res.json({ ok: true, ...planned });
    res.json({ ok: true, summary: planned.summary, ...(await apply(req.user, planned)) });
  }));
}

module.exports = { mount, matrix, template, plan, apply, LEVELS };
