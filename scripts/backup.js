#!/usr/bin/env node
// Backup tools for the server shell (reads .env like the app; BACKUP_KEY must be set).
//
//   node scripts/backup.js run                     make a backup now
//   node scripts/backup.js test [file]             restore test (newest backup if no file given)
//   node scripts/backup.js list                    backups in BACKUP_DIR
//   node scripts/backup.js info <file>             decrypt, verify checksums, print the manifest
//   node scripts/backup.js restore <file> --yes    full restore into DATABASE_URL (must be an EMPTY database)
//                                                  + attachments into INTAKE_FILE_DIR
// Full steps for a new server: docs/backup.md
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Client } = require("pg");
const b = require("../src/v3/backup");
const { config3 } = require("../src/v3/config3");

const [cmd, arg, ...rest] = process.argv.slice(2);
const yes = rest.includes("--yes") || arg === "--yes";
const done = (code = 0) => setTimeout(() => process.exit(code), 50);
const fail = (m) => {
  console.error("✗ " + m);
  done(1);
};

async function main() {
  if (cmd === "run") {
    const r = await b.runBackup({ by: "cli" });
    console.log(r.ok ? `✓ ${r.name} · ${r.sizeText} · ${r.cases} เคส · ไฟล์แนบ ${r.files} ไฟล์` : `✗ ${r.error}`);
    return done(r.ok ? 0 : 1);
  }
  if (cmd === "test") {
    const r = await b.testRestore({ by: "cli", file: arg });
    console.log(r.ok ? `✓ ทดสอบ restore ${r.level === "full" ? "ผ่าน" : "ผ่านบางส่วน"} · ${r.name} · ${r.tables} ตาราง · ${r.cases} เคส · ไฟล์แนบ ${r.files}${r.note ? "\n  " + r.note : ""}` : `✗ ${r.error}`);
    return done(r.ok ? 0 : 1);
  }
  if (cmd === "list") {
    const s = await b.settings();
    for (const f of await b.listBackups(s.dir)) console.log(`${f.name}  ${(f.size / 1048576).toFixed(1)} MB  ${f.at}`);
    return done();
  }
  if (cmd === "info" || cmd === "restore") {
    if (!arg) return fail("ระบุไฟล์ .scbk");
    const file = path.resolve(arg);
    if (!fs.existsSync(file)) return fail(`ไม่พบไฟล์ ${file}`);
    const { dir, manifest } = await b.open(file, os.tmpdir());
    try {
      console.log(`✓ ถอดรหัสและ checksum ถูกต้อง · สร้างเมื่อ ${manifest.createdAt} บน ${manifest.host} · PostgreSQL ${manifest.pgVersion}`);
      console.log(`  ${Object.keys(manifest.counts).length} ตาราง · cases ${manifest.counts.cases || 0} · ไฟล์แนบ ${manifest.files} (${b.human(manifest.filesBytes || 0)}) จาก ${manifest.fileDir}`);
      if (cmd === "info") return done();

      const target = new URL(config3.databaseUrl);
      const c = new Client({ connectionString: config3.databaseUrl });
      await c.connect();
      const n = (await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n;
      await c.end();
      if (n > 0) return fail(`ฐานข้อมูล ${target.pathname.slice(1)} มีตารางอยู่แล้ว ${n} ตาราง restore ได้เฉพาะฐานข้อมูลว่าง (ดู docs/backup.md)`);
      const fdir = b.fileDir();
      if (!yes) {
        console.log(`\nจะ restore ลงฐานข้อมูล ${target.pathname.slice(1)} ที่ ${target.host} และแตกไฟล์แนบไปที่ ${fdir}`);
        return fail("ยังไม่ได้ทำอะไร ใส่ --yes ต่อท้ายเพื่อยืนยัน");
      }
      console.log("… กำลัง restore ฐานข้อมูล");
      await b.run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "-d", target.pathname.slice(1), path.join(dir, "db.dump")], { env: b.pgEnv() });
      console.log("… กำลังแตกไฟล์แนบ");
      fs.mkdirSync(fdir, { recursive: true, mode: 0o750 });
      await b.run("tar", ["-xf", path.join(dir, "files.tar"), "-C", fdir]);
      const c2 = new Client({ connectionString: config3.databaseUrl });
      await c2.connect();
      if (manifest.fileDir && path.resolve(manifest.fileDir) !== fdir) {
        const r = await c2.query("UPDATE intake_files SET path = $2 || substr(path, length($1) + 1) WHERE path LIKE $1 || '%'", [manifest.fileDir, fdir]);
        const r2 = await c2.query("UPDATE sr_files SET path = $2 || substr(path, length($1) + 1) WHERE path LIKE $1 || '%'", [manifest.fileDir, fdir]).catch(() => ({ rowCount: 0 }));
        console.log(`  ปรับที่อยู่ไฟล์แนบ ${r.rowCount + r2.rowCount} รายการ จาก ${manifest.fileDir} เป็น ${fdir}`);
      }
      const cases = (await c2.query("SELECT count(*)::int AS n FROM cases")).rows[0].n;
      await c2.end();
      console.log(`✓ restore เสร็จ · cases ${cases} (ใน backup ${manifest.counts.cases || 0}) · เริ่ม app ได้ด้วย pm2 start / pm2 restart`);
      return done();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  done(cmd ? 1 : 0);
}
main().catch((e) => fail(e.message));
