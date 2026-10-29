// Bulk add/update users from an Excel sheet (Admin only).
const ExcelJS = require("exceljs");
const bcrypt = require("bcryptjs");
const { all, tx, audit } = require("./db");
const { tempPassword } = require("./auth");

const ROLE_ALIASES = {
  admin: "admin", แอดมิน: "admin", ผู้ดูแลระบบ: "admin",
  manager: "manager", ผู้จัดการ: "manager",
  engineer: "engineer", วิศวกร: "engineer", owner: "engineer",
  viewer: "viewer", ดูอย่างเดียว: "viewer",
};
const HEADERS = {
  email: ["email", "อีเมล", "e-mail", "owner email"],
  name: ["ชื่อที่แสดง", "ชื่อ", "name", "display name", "ชื่อ-นามสกุล"],
  role: ["บทบาท", "role"],
  teams: ["ทีม", "team", "teams"],
  auth: ["วิธีเข้าระบบ", "login", "auth", "auth type", "เข้าระบบด้วย"],
};
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

async function template() {
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Users");
  ws.columns = [
    { header: "Email", key: "email", width: 34 },
    { header: "ชื่อที่แสดง", key: "name", width: 26 },
    { header: "บทบาท", key: "role", width: 14 },
    { header: "ทีม", key: "teams", width: 28 },
    { header: "วิธีเข้าระบบ", key: "auth", width: 16 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  ws.addRow({ email: "somchai.k@sinostech.co.th", name: "Somchai K.", role: "Engineer", teams: teams[0]?.code || "ENGAGE", auth: "Microsoft" });
  ws.addRow({ email: "manager@sinostech.co.th", name: "Team Manager", role: "Manager", teams: teams.map((t) => t.code).join(", "), auth: "Microsoft" });
  ws.addRow({ email: "partner@example.com", name: "Vendor Partner", role: "Viewer", teams: teams[1]?.code || "NEXIDIA", auth: "Password" });
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`C${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Admin,Manager,Engineer,Viewer"'] };
    ws.getCell(`E${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Microsoft,Password"'] };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const help = wb.addWorksheet("วิธีกรอก");
  help.columns = [{ width: 18 }, { width: 90 }];
  [
    ["คอลัมน์", "คำอธิบาย"],
    ["Email", "จำเป็น ใช้เป็นตัวระบุผู้ใช้ ถ้ามีอยู่แล้วระบบจะอัปเดตชื่อ บทบาท และทีมแทนการสร้างใหม่"],
    ["ชื่อที่แสดง", "ไม่บังคับ ถ้าเว้นว่าง ผู้ใช้ใหม่จะใช้อีเมลเป็นชื่อ ผู้ใช้เดิมคงชื่อเดิม"],
    ["บทบาท", "Admin, Manager, Engineer หรือ Viewer ถ้าเว้นว่าง ผู้ใช้ใหม่เป็น Engineer ผู้ใช้เดิมคงบทบาทเดิม"],
    ["ทีม", `ใส่รหัสทีมคั่นด้วย , ได้หลายทีม: ${teams.map((t) => `${t.code} (${t.label})`).join(", ")} หรือ ALL = ทุกทีม ถ้าเว้นว่าง ผู้ใช้เดิมคงทีมเดิม`],
    ["วิธีเข้าระบบ", "Microsoft = บัญชีบริษัท (ค่าเริ่มต้น) · Password = คนนอกบริษัท ระบบสร้างรหัสชั่วคราวให้และบังคับเปลี่ยนตอนเข้าครั้งแรก"],
    ["", "ระบบไม่ลบหรือปิดใช้งานผู้ใช้จากไฟล์นี้ และไม่เปลี่ยนวิธีเข้าระบบของผู้ใช้เดิม"],
  ].forEach((r, i) => {
    const row = help.addRow(r);
    if (i === 0) row.font = { bold: true };
    row.alignment = { wrapText: true, vertical: "top" };
  });
  return wb.xlsx.writeBuffer();
}

async function parse(buf) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (e) {
    throw Object.assign(new Error("อ่านไฟล์ไม่ได้ ต้องเป็นไฟล์ .xlsx"), { status: 400 });
  }
  const ws = wb.getWorksheet("Users") || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error("ไม่พบ sheet ในไฟล์"), { status: 400 });
  let headerRow = 0;
  const col = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    ws.getRow(r).eachCell((cell, c) => {
      const h = norm(cell.value).toLowerCase();
      for (const [k, names] of Object.entries(HEADERS)) if (!col[k] && names.includes(h)) col[k] = c;
    });
    if (col.email) headerRow = r;
  }
  if (!headerRow) throw Object.assign(new Error("ไม่พบคอลัมน์ Email ในไฟล์ ใช้แม่แบบจากปุ่มดาวน์โหลด"), { status: 400 });
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (col[k] ? norm(row.getCell(col[k]).value) : "");
    const rec = { row: r, email: get("email").replace(/^mailto:/i, "").toLowerCase(), name: get("name"), role: get("role"), teams: get("teams"), auth: get("auth") };
    if (!rec.email && !rec.name && !rec.role && !rec.teams) continue;
    rows.push(rec);
  }
  if (rows.length > 500) throw Object.assign(new Error("นำเข้าได้ครั้งละไม่เกิน 500 คน"), { status: 400 });
  return rows;
}

async function plan(rows, actor) {
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  const existing = await all(
    `SELECT u.id, lower(u.email) AS email, u.display_name, u.role, u.auth_type, u.active,
            array_remove(array_agg(t.team ORDER BY t.team), NULL) AS teams
     FROM users u LEFT JOIN user_teams t ON t.user_id = u.id GROUP BY u.id`
  );
  const byEmail = new Map(existing.map((u) => [u.email, u]));
  const seen = new Set();
  const teamOf = (s) => {
    const x = s.trim().toLowerCase();
    if (!x) return null;
    return teams.find((t) => t.code.toLowerCase() === x || t.label.toLowerCase() === x || t.label.toLowerCase().split(/\s*\/\s*/)[0] === x) || null;
  };
  return rows.map((r) => {
    const out = { ...r, errors: [], notes: [] };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) out.errors.push("อีเมลไม่ถูกต้อง");
    if (seen.has(r.email)) out.errors.push("อีเมลซ้ำในไฟล์");
    seen.add(r.email);
    let role = null;
    if (r.role) {
      role = ROLE_ALIASES[r.role.toLowerCase()] || null;
      if (!role) out.errors.push(`บทบาท “${r.role}” ไม่รู้จัก`);
    }
    let teamCodes = null;
    if (r.teams) {
      if (/^(all|ทุกทีม|\*)$/i.test(r.teams.trim())) teamCodes = teams.map((t) => t.code);
      else {
        teamCodes = [];
        for (const part of r.teams.split(/[,;\n]+/)) {
          if (!part.trim()) continue;
          const t = teamOf(part);
          if (t) teamCodes.includes(t.code) || teamCodes.push(t.code);
          else out.errors.push(`ทีม “${part.trim()}” ไม่รู้จัก`);
        }
      }
    }
    let auth = null;
    if (r.auth) {
      const a = r.auth.toLowerCase();
      auth = /password|local|รหัส/.test(a) ? "local" : /microsoft|sso|entra|บริษัท/.test(a) ? "sso" : null;
      if (!auth) out.errors.push(`วิธีเข้าระบบ “${r.auth}” ไม่รู้จัก (Microsoft หรือ Password)`);
    }
    const cur = byEmail.get(r.email);
    if (!cur) {
      out.action = "create";
      out.final = { display_name: r.name || r.email, role: role || "engineer", teams: teamCodes || [], auth_type: auth || "sso" };
      if (!teamCodes || !teamCodes.length) out.notes.push("ยังไม่มีทีม จะยังไม่เห็นเคสใด");
    } else {
      out.userId = cur.id;
      const changes = [];
      const final = { display_name: cur.display_name, role: cur.role, teams: cur.teams, auth_type: cur.auth_type };
      if (r.name && r.name !== cur.display_name) changes.push("ชื่อ"), (final.display_name = r.name);
      if (role && role !== cur.role) {
        if (cur.id === actor.id) out.errors.push("เปลี่ยนบทบาทของบัญชีตัวเองไม่ได้");
        else changes.push("บทบาท"), (final.role = role);
      }
      if (teamCodes && [...teamCodes].sort().join() !== [...cur.teams].sort().join()) changes.push("ทีม"), (final.teams = teamCodes);
      if (auth && auth !== cur.auth_type) out.notes.push("ไม่เปลี่ยนวิธีเข้าระบบของผู้ใช้เดิม");
      if (!cur.active) out.notes.push("บัญชีนี้ปิดใช้งานอยู่ (ไฟล์นี้ไม่เปิดให้)");
      out.action = changes.length ? "update" : "same";
      out.changes = changes;
      out.final = final;
    }
    if (out.errors.length) {
      out.action = "error";
      delete out.final;
      out.notes = [];
    }
    return out;
  });
}

async function apply(planned, actor) {
  const created = [];
  let updated = 0;
  await tx(async (c) => {
    const valid = (await c.query("SELECT code FROM teams")).rows.map((r) => r.code);
    const setTeams = async (id, teams) => {
      await c.query("DELETE FROM user_teams WHERE user_id=$1", [id]);
      for (const t of teams.filter((x) => valid.includes(x))) await c.query("INSERT INTO user_teams (user_id, team) VALUES ($1,$2)", [id, t]);
    };
    for (const p of planned) {
      if (p.action === "create") {
        const f = p.final;
        let temp = null;
        let hash = null;
        if (f.auth_type === "local") {
          temp = tempPassword();
          hash = await bcrypt.hash(temp, 12);
        }
        const r = await c.query(
          `INSERT INTO users (email, display_name, role, auth_type, password_hash, must_change_password, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [p.email, f.display_name.slice(0, 120), f.role, f.auth_type, hash, f.auth_type === "local", actor.id]
        );
        await setTeams(r.rows[0].id, f.teams);
        created.push({ email: p.email, display_name: f.display_name, auth_type: f.auth_type, tempPassword: temp });
      } else if (p.action === "update") {
        const f = p.final;
        await c.query("UPDATE users SET display_name=$1, role=$2, updated_at=now() WHERE id=$3", [f.display_name.slice(0, 120), f.role, p.userId]);
        if (p.changes.includes("ทีม")) await setTeams(p.userId, f.teams);
        updated++;
      }
    }
  });
  await audit(actor, "user_import", null, { created: created.length, updated });
  return { created, updated };
}

module.exports = { template, parse, plan, apply };
