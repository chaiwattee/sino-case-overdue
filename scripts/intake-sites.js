#!/usr/bin/env node
// One-off bulk edit of "ลูกค้า: ชื่อเรียก โดเมน email ทีม และไฟล์แนบ" (intake customer settings) through Excel.
//
//   node scripts/intake-sites.js export customers.xlsx          write the current list
//   node scripts/intake-sites.js import customers.xlsx          check only: shows what would change and any errors
//   node scripts/intake-sites.js import customers.xlsx --apply  write the changes (a backup JSON is saved first)
//   node scripts/intake-sites.js restore backup-....json         put the backup back
//
// Same rules as the page: names are separated by commas, a domain may belong to one customer only,
// public mail domains (gmail.com …) are refused, a name that another customer already uses is refused.
// Run from the app folder with the app's .env loaded:  set -a && . ./.env && set +a
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { q, one, all, tx, pool } = require("../src/v3/db");
const { norm, siteList } = require("../src/v3/intake");
const { PUBLIC_DOMAINS } = require("../src/v3/mailintake");

const split = (v) => String(v ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
const yes = (v) => /^(y|yes|true|1|✓|ใช่|แนบได้)$/i.test(String(v ?? "").trim());
const SAME = "ตามทีมของผู้รับ";

async function load() {
  const sites = await siteList();
  const rows = await all("SELECT site, team, attachments, domains FROM intake_sites");
  const al = await all("SELECT site, alias FROM intake_aliases ORDER BY id");
  const open = await all(`SELECT site, count(*)::int AS n FROM cases WHERE lower(coalesce(status,'')) NOT IN ('success','resolved','cancel','n/a','transferred') GROUP BY site`);
  const teams = await all("SELECT code, label FROM teams ORDER BY sort, label").catch(() => all("SELECT code, label FROM teams ORDER BY label"));
  const by = Object.fromEntries(rows.map((r) => [r.site, r]));
  return {
    teams,
    list: sites.map((s) => ({
      site: s,
      aliases: al.filter((a) => a.site === s).map((a) => a.alias),
      domains: (by[s] && by[s].domains) || [],
      team: (by[s] && by[s].team) || "",
      attachments: !!(by[s] && by[s].attachments),
      open: (open.find((o) => o.site === s) || {}).n || 0,
    })),
  };
}

async function exportFile(file) {
  const { teams, list } = await load();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ลูกค้า");
  ws.columns = [
    { header: "Site (ห้ามแก้)", key: "site", width: 28 },
    { header: "ชื่อเรียกอื่น (คั่นด้วย ,)", key: "aliases", width: 40 },
    { header: "โดเมน email (คั่นด้วย ,)", key: "domains", width: 36 },
    { header: "ทีมของเคส", key: "team", width: 26 },
    { header: "แนบไฟล์ (Y/N)", key: "att", width: 14 },
    { header: "เคสเปิด (ดูอย่างเดียว)", key: "open", width: 18 },
  ];
  const label = (code) => (teams.find((t) => t.code === code) || {}).label || SAME;
  list.forEach((r) => ws.addRow({ site: r.site, aliases: r.aliases.join(", "), domains: r.domains.join(", "), team: r.team ? label(r.team) : SAME, att: r.attachments ? "Y" : "N", open: r.open }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const tl = wb.addWorksheet("ทีม");
  tl.columns = [{ header: "ทีมของเคส (เลือกจากรายการนี้)", key: "l", width: 30 }, { header: "code", key: "c", width: 16 }];
  tl.addRow({ l: SAME, c: "" });
  teams.forEach((t) => tl.addRow({ l: t.label, c: t.code }));
  const n = teams.length + 2;
  for (let i = 2; i <= list.length + 1; i++) {
    ws.getCell(`D${i}`).dataValidation = { type: "list", allowBlank: true, formulae: [`'ทีม'!$A$2:$A$${n}`] };
    ws.getCell(`E${i}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Y,N"'] };
    ws.getCell(`A${i}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6FA" } };
    ws.getCell(`F${i}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6FA" } };
  }
  await wb.xlsx.writeFile(file);
  console.log(`export: ${list.length} ลูกค้า -> ${file}`);
}

async function readFile(file, teams) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("ลูกค้า") || wb.worksheets[0];
  const out = [];
  const text = (c) => { const v = c.value; return v && typeof v === "object" ? (v.richText ? v.richText.map((x) => x.text).join("") : v.text ?? v.result ?? "") : v ?? ""; };
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const site = String(text(row.getCell(1))).trim();
    if (!site) return;
    const t = String(text(row.getCell(4))).trim();
    const team = !t || t === SAME ? "" : (teams.find((x) => x.label.toLowerCase() === t.toLowerCase() || x.code.toLowerCase() === t.toLowerCase()) || { code: null, bad: t }).code;
    out.push({ line: i, site, aliases: [...new Set(split(text(row.getCell(2))))], domains: [...new Set(split(text(row.getCell(3))).map((d) => d.toLowerCase().replace(/^.*@/, "")))], team, teamText: t, attachments: yes(text(row.getCell(5))) });
  });
  return out;
}

async function importFile(file, apply) {
  const { teams, list } = await load();
  const cur = Object.fromEntries(list.map((r) => [r.site, r]));
  const rows = await readFile(file, teams);
  const errors = [];
  const changes = [];
  const domainOwner = {};
  const aliasOwner = {};
  for (const r of rows) {
    const e = (m) => errors.push(`แถว ${r.line} (${r.site}): ${m}`);
    if (!cur[r.site]) { e("ไม่พบ Site นี้ในระบบ (ห้ามแก้ชื่อในคอลัมน์ Site)"); continue; }
    if (r.team === null) e(`ทีม “${r.teamText}” ไม่ถูกต้อง เลือกจากแผ่น "ทีม"`);
    for (const d of r.domains) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) e(`โดเมน “${d}” ไม่ถูกต้อง ใส่แบบ ktb.co.th`);
      else if (PUBLIC_DOMAINS.includes(d)) e(`ใส่ ${d} ไม่ได้ เพราะเป็น email ส่วนตัว`);
      else if (domainOwner[d] && domainOwner[d] !== r.site) e(`โดเมน ${d} ซ้ำกับ ${domainOwner[d]}`);
      else domainOwner[d] = r.site;
    }
    for (const a of r.aliases) {
      const n = norm(a);
      if (!n) continue;
      if (aliasOwner[n] && aliasOwner[n] !== r.site) e(`ชื่อเรียก “${a}” ซ้ำกับ ${aliasOwner[n]}`);
      else aliasOwner[n] = r.site;
    }
    const c = cur[r.site];
    const diff = [];
    if (c.aliases.join("|") !== r.aliases.join("|")) diff.push(`ชื่อเรียก: [${c.aliases.join(", ")}] → [${r.aliases.join(", ")}]`);
    if ([...c.domains].sort().join("|") !== [...r.domains].sort().join("|")) diff.push(`โดเมน: [${c.domains.join(", ")}] → [${r.domains.join(", ")}]`);
    if ((c.team || "") !== (r.team || "") && r.team !== null) diff.push(`ทีม: ${c.team || SAME} → ${r.team || SAME}`);
    if (c.attachments !== r.attachments) diff.push(`แนบไฟล์: ${c.attachments ? "Y" : "N"} → ${r.attachments ? "Y" : "N"}`);
    if (diff.length) changes.push({ r, diff });
  }
  // Names / domains held by customers that are not in the file are still taken.
  const inFile = new Set(rows.map((r) => r.site));
  for (const c of list.filter((x) => !inFile.has(x.site))) {
    c.domains.forEach((d) => domainOwner[d] && domainOwner[d] !== c.site && errors.push(`โดเมน ${d} ผูกกับ ${c.site} (ไม่อยู่ในไฟล์) อยู่แล้ว`));
    c.aliases.forEach((a) => { const n = norm(a); if (aliasOwner[n] && aliasOwner[n] !== c.site) errors.push(`ชื่อเรียก “${a}” ใช้กับ ${c.site} (ไม่อยู่ในไฟล์) อยู่แล้ว`); });
  }
  console.log(`อ่านไฟล์: ${rows.length} แถว · เปลี่ยน ${changes.length} ลูกค้า · error ${errors.length}`);
  changes.forEach((x) => console.log(`\n${x.r.site}\n  ${x.diff.join("\n  ")}`));
  if (errors.length) {
    console.log("\nERROR (ยังไม่ได้บันทึกอะไร แก้ในไฟล์แล้วรันใหม่):\n  " + errors.join("\n  "));
    process.exitCode = 1;
    return;
  }
  if (!apply) return console.log(changes.length ? "\nตรวจแล้วไม่มี error · รันอีกครั้งพร้อม --apply เพื่อบันทึก" : "\nไม่มีอะไรเปลี่ยน");
  if (!changes.length) return console.log("ไม่มีอะไรเปลี่ยน");
  const backup = path.resolve(`backup-intake-sites-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backup, JSON.stringify({ sites: await all("SELECT * FROM intake_sites"), aliases: await all("SELECT site, alias, norm FROM intake_aliases") }, null, 1));
  fs.chmodSync(backup, 0o600);
  await tx(async (c) => {
    for (const { r } of changes) {
      await c.query(
        `INSERT INTO intake_sites (site, owner_id, team, attachments, domains, updated_at) VALUES ($1, NULL, $2, $3, $4, now())
         ON CONFLICT (site) DO UPDATE SET team = EXCLUDED.team, attachments = EXCLUDED.attachments, domains = EXCLUDED.domains, updated_at = now()`,
        [r.site, r.team || null, r.attachments, r.domains]
      );
      await c.query("DELETE FROM intake_aliases WHERE site = $1", [r.site]);
    }
    for (const { r } of changes)
      for (const a of r.aliases) { const n = norm(a); if (n) await c.query("INSERT INTO intake_aliases (site, alias, norm) VALUES ($1,$2,$3)", [r.site, a, n]); }
    await c.query("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1, 'intake_sites_import', $2, $3)", ["script", path.basename(file), JSON.stringify({ changed: changes.map((x) => x.r.site), backup: path.basename(backup) })]);
  });
  console.log(`\nบันทึกแล้ว ${changes.length} ลูกค้า · backup: ${backup}`);
}

async function restore(file) {
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  await tx(async (c) => {
    await c.query("DELETE FROM intake_aliases");
    await c.query("DELETE FROM intake_sites");
    for (const s of b.sites) await c.query("INSERT INTO intake_sites (site, owner_id, team, attachments, domains, updated_at) VALUES ($1,$2,$3,$4,$5,$6)", [s.site, s.owner_id, s.team, s.attachments, s.domains, s.updated_at]);
    for (const a of b.aliases) await c.query("INSERT INTO intake_aliases (site, alias, norm) VALUES ($1,$2,$3)", [a.site, a.alias, a.norm]);
  });
  console.log(`คืนค่าจาก ${file}: ${b.sites.length} ลูกค้า, ${b.aliases.length} ชื่อเรียก`);
}

(async () => {
  const [cmd, file, flag] = process.argv.slice(2);
  try {
    if (cmd === "export" && file) await exportFile(file);
    else if (cmd === "import" && file) await importFile(file, flag === "--apply");
    else if (cmd === "restore" && file) await restore(file);
    else console.log("ใช้: node scripts/intake-sites.js export|import|restore <file> [--apply]");
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
