// Nightly backup of the database and the customer attachments, plus a weekly restore test.
//
// One backup = one encrypted file  sino-case-YYYYMMDD-HHMM.scbk  holding a tar of
//   db.dump        pg_dump custom format (every table, schema included)
//   files.tar      the attachment folder (INTAKE_FILE_DIR), paths relative to it
//   manifest.json  row counts per table, file count, sha256 of both parts, source folder
// Encryption: AES-256-GCM, key = scrypt(BACKUP_KEY, random salt). Without BACKUP_KEY no backup is written.
// .env is never included: keep a copy of it (and BACKUP_KEY) in the company password manager.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { Client } = require("pg");
const { config3 } = require("./config3");
const graph = require("../graph");
const telegram = require("../telegram");
const { esc, shell } = require("../emails");
const { q, all, getSetting, setSetting, audit } = require("./db");

const MAGIC = Buffer.from("SCBK1\n");
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEAD = MAGIC.length + SALT + IV;
const NAME_RE = /^sino-case-(\d{8})-(\d{4,6})\.scbk$/;

const DEFAULTS = {
  enabled: true,
  keepDays: 14,
  dir: process.env.BACKUP_DIR || path.join(__dirname, "..", "..", "data", "backups"),
  copyDir: "", // e.g. a mounted NAS folder; empty = off
  sharepoint: { enabled: false, siteId: "", folder: "Sino Case Backup" },
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fileDir = () => path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"));
const keyOk = () => String(process.env.BACKUP_KEY || "").length >= 20;

async function settings() {
  const s = (await getSetting("backup", null)) || {};
  // The folder always comes from BACKUP_DIR / the default, never from saved settings.
  return { ...DEFAULTS, ...s, dir: DEFAULTS.dir, sharepoint: { ...DEFAULTS.sharepoint, ...(s.sharepoint || {}) } };
}
async function save(user, b) {
  const cur = await settings();
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
  const copyDir = String(b.copyDir || "").trim();
  if (copyDir && !path.isAbsolute(copyDir)) throw bad("โฟลเดอร์สำรองนอกเครื่องต้องเป็น path เต็ม เช่น /mnt/nas/case-backup");
  const sp = b.sharepoint || {};
  const next = {
    ...cur,
    enabled: b.enabled !== false,
    keepDays: num(b.keepDays, 3, 365, 14),
    copyDir,
    sharepoint: { enabled: !!sp.enabled, siteId: String(sp.siteId || "").trim().slice(0, 300), folder: String(sp.folder || "Sino Case Backup").trim().replace(/^\/+|\/+$/g, "").slice(0, 200) || "Sino Case Backup" },
  };
  if (next.sharepoint.enabled && !next.sharepoint.siteId) throw bad("ใส่ Site ID ของ SharePoint ก่อนเปิดใช้");
  const { dir, ...stored } = next;
  await setSetting("backup", stored);
  await audit(user, "backup_settings", null, { enabled: next.enabled, keepDays: next.keepDays, copyDir: next.copyDir, sharepoint: next.sharepoint });
  return next;
}

// ------------------------------------------------------------ helpers
function pgEnv(url = config3.databaseUrl) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
}
function withDb(url, db) {
  const u = new URL(url);
  u.pathname = "/" + db;
  return u.toString();
}
/** Run a command; reject with its stderr on failure. Credentials go through env, never the argument list. */
function run(cmd, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env[`BACKUP_${cmd.toUpperCase().replace(/-/g, "_")}`] || cmd, args, { env: env || process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? `ไม่พบคำสั่ง ${cmd} บนเครื่อง (ติดตั้ง postgresql-client รุ่นเดียวกับฐานข้อมูล)` : e.message)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${(err || out).trim().split("\n").slice(-3).join(" ") || "exit " + code}`))));
  });
}
async function sha256(file) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}
const keyFor = (salt) => crypto.scryptSync(process.env.BACKUP_KEY, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

async function encryptFile(src, dest) {
  const salt = crypto.randomBytes(SALT);
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(salt), iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), c, out, { end: false });
  await new Promise((res, rej) => out.end(c.getAuthTag(), (e) => (e ? rej(e) : res())));
}
async function decryptFile(src, dest) {
  if (!keyOk()) throw new Error("ยังไม่ได้ตั้ง BACKUP_KEY");
  const st = await fsp.stat(src);
  if (st.size < HEAD + TAG) throw new Error("ไฟล์ backup สั้นผิดปกติ");
  const fh = await fsp.open(src, "r");
  const head = Buffer.alloc(HEAD);
  const tag = Buffer.alloc(TAG);
  await fh.read(head, 0, HEAD, 0);
  await fh.read(tag, 0, TAG, st.size - TAG);
  await fh.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("ไม่ใช่ไฟล์ backup ของระบบนี้");
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = head.subarray(MAGIC.length + SALT, HEAD);
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor(salt), iv);
  d.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: HEAD, end: st.size - TAG - 1 }), d, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (e) {
    await fsp.rm(dest, { force: true });
    throw new Error(/auth/i.test(e.message) ? "ถอดรหัสไม่ได้: BACKUP_KEY ไม่ตรงกับตอนสร้าง หรือไฟล์เสียหาย" : e.message);
  }
}
async function tableCounts(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = Number((await client.query(`SELECT count(*)::bigint AS n FROM "${t.replace(/"/g, '""')}"`)).rows[0].n);
  return out;
}
async function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        n++;
        bytes += (await fsp.stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { n, bytes };
}
const stamp = (t = new Date()) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(t);
  const g = (k) => p.find((x) => x.type === k).value;
  return `${g("year")}${g("month")}${g("day")}-${g("hour")}${g("minute")}${g("second")}`;
};
async function listBackups(dir) {
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => NAME_RE.test(n)).sort().reverse();
  const out = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(dir, name));
    out.push({ name, size: st.size, at: st.mtime.toISOString() });
  }
  return out;
}
async function tmpDir(base) {
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(path.join(base, ".work-"));
}
const human = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

// ------------------------------------------------------------ status kept in settings
let busy = null;
async function record(kind, result) {
  const s = (await getSetting("backup_status", null)) || {};
  s[kind] = result;
  s.history = [{ kind, ...result }, ...(s.history || [])].slice(0, 30);
  await setSetting("backup_status", s);
}
async function alert(subject, text) {
  await telegram.sendText(`⚠️ ${subject}\n${text}`).catch(() => {});
  const admins = (await all("SELECT email FROM users WHERE active AND role = 'admin' AND email IS NOT NULL")).map((r) => r.email);
  if (admins.length) await graph.sendMail({ to: admins, cc: [], subject: `[Sino Case SLA] ${subject}`, html: shell("#C0283C", `<p style="white-space:pre-wrap">${esc(text)}\n\nดูสถานะ: ${esc(config3.baseUrl)}/#/settings</p>`) }).catch(() => {});
}

// ------------------------------------------------------------ backup
async function runBackup({ by = "schedule" } = {}) {
  const s = await settings();
  if (!s.enabled && by === "schedule") return { skipped: "ปิดใช้งาน" };
  if (busy) throw bad(`กำลัง${busy}อยู่ รอสักครู่`, 409);
  busy = "สำรองข้อมูล";
  const started = Date.now();
  let work;
  try {
    if (!keyOk()) throw new Error("ยังไม่ได้ตั้ง BACKUP_KEY ใน .env (อย่างน้อย 20 ตัวอักษร) ระบบจึงยังไม่สร้าง backup");
    await fsp.mkdir(s.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(s.dir, 0o700).catch(() => {});
    work = await tmpDir(s.dir);
    const dump = path.join(work, "db.dump");
    const files = path.join(work, "files.tar");
    // Counts first, then the dump: anything written in between is in the dump but not counted, which the test allows (>=).
    const c = new Client({ connectionString: config3.databaseUrl });
    await c.connect();
    const counts = await tableCounts(c);
    const pgVersion = (await c.query("SHOW server_version")).rows[0].server_version;
    await c.end();
    await run("pg_dump", ["-Fc", "-Z", "6", "--no-owner", "--no-privileges", "-f", dump], { env: pgEnv() });
    const fdir = fileDir();
    const fc = await countFiles(fdir);
    if (fc.n) await run("tar", ["-cf", files, "-C", fdir, "."]);
    else await run("tar", ["-cf", files, "-T", "/dev/null"]);
    const manifest = {
      format: 1, app: "sino-case-v3", createdAt: new Date().toISOString(), host: os.hostname(), pgVersion,
      counts, fileDir: fdir, files: fc.n, filesBytes: fc.bytes,
      sha256: { "db.dump": await sha256(dump), "files.tar": await sha256(files) },
    };
    await fsp.writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const bundle = path.join(work, "bundle.tar");
    await run("tar", ["-cf", bundle, "-C", work, "manifest.json", "db.dump", "files.tar"]);
    const name = `sino-case-${stamp()}.scbk`;
    const dest = path.join(s.dir, name);
    await encryptFile(bundle, dest + ".part");
    await fsp.rename(dest + ".part", dest);
    const size = (await fsp.stat(dest)).size;

    const copies = [];
    if (s.copyDir) {
      try {
        await fsp.mkdir(s.copyDir, { recursive: true, mode: 0o700 });
        await fsp.copyFile(dest, path.join(s.copyDir, name + ".part"));
        await fsp.rename(path.join(s.copyDir, name + ".part"), path.join(s.copyDir, name));
        await prune(s.copyDir, s.keepDays);
        copies.push({ to: s.copyDir, ok: true });
      } catch (e) {
        copies.push({ to: s.copyDir, ok: false, error: e.message });
      }
    }
    if (s.sharepoint.enabled) {
      try {
        await uploadSharePoint(s.sharepoint, dest, name);
        await pruneSharePoint(s.sharepoint, s.keepDays).catch(() => {});
        copies.push({ to: "SharePoint", ok: true });
      } catch (e) {
        copies.push({ to: "SharePoint", ok: false, error: graphError(e) });
      }
    }
    const removed = await prune(s.dir, s.keepDays);
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    const result = { ok: copies.every((x) => x.ok), at: new Date().toISOString(), by, name, size, sizeText: human(size), seconds: Math.round((Date.now() - started) / 1000), cases: counts.cases || 0, rows, files: fc.n, copies, removed };
    if (!result.ok) result.error = copies.filter((x) => !x.ok).map((x) => `สำเนาไป ${x.to} ไม่สำเร็จ: ${x.error}`).join(" · ");
    await record("backup", result);
    if (!result.ok) await alert("Backup สำเร็จในเครื่อง แต่ส่งสำเนาออกนอกเครื่องไม่สำเร็จ", result.error);
    return result;
  } catch (e) {
    const result = { ok: false, at: new Date().toISOString(), by, error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    await record("backup", result);
    await alert("Backup ไม่สำเร็จ", e.message);
    if (by !== "schedule") throw bad(e.message, 500);
    return result;
  } finally {
    busy = null;
    if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Delete backups older than keepDays, always keeping the newest 3. */
async function prune(dir, keepDays) {
  const list = await listBackups(dir);
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  for (const b of list.slice(3)) {
    if (new Date(b.at).getTime() < cutoff) {
      await fsp.rm(path.join(dir, b.name), { force: true });
      removed.push(b.name);
    }
  }
  for (const n of await fsp.readdir(dir).catch(() => [])) if (n.endsWith(".part") || n.startsWith(".work-")) {
    const p = path.join(dir, n);
    const st = await fsp.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 6 * 3600000) await fsp.rm(p, { recursive: true, force: true });
  }
  return removed;
}

// ------------------------------------------------------------ SharePoint copy (app permission Sites.Selected on one site only)
const graphError = (e) => (e.response && e.response.data && e.response.data.error ? `${e.response.status} ${e.response.data.error.code}: ${e.response.data.error.message}` : e.message);
const spPath = (sp, name) => `/sites/${encodeURIComponent(sp.siteId)}/drive/root:/${sp.folder.split("/").map(encodeURIComponent).join("/")}${name ? "/" + encodeURIComponent(name) : ""}`;
async function uploadSharePoint(sp, file, name) {
  const axios = require("axios");
  const size = (await fsp.stat(file)).size;
  const session = await graph.graph("post", `${spPath(sp, name)}:/createUploadSession`, { item: { "@microsoft.graph.conflictBehavior": "replace" } });
  const CHUNK = 320 * 1024 * 32; // 10 MiB, a multiple of 320 KiB as Graph requires
  const fh = await fsp.open(file, "r");
  try {
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      await axios.put(session.uploadUrl, buf, { headers: { "Content-Length": len, "Content-Range": `bytes ${pos}-${pos + len - 1}/${size}` }, maxBodyLength: Infinity, timeout: 120000 });
    }
  } finally {
    await fh.close();
  }
}
async function pruneSharePoint(sp, keepDays) {
  const r = await graph.graph("get", `${spPath(sp)}:/children?$select=id,name,createdDateTime&$top=200`);
  const items = (r.value || []).filter((x) => NAME_RE.test(x.name)).sort((a, b) => b.name.localeCompare(a.name));
  const cutoff = Date.now() - keepDays * 86400000;
  for (const it of items.slice(3)) if (new Date(it.createdDateTime).getTime() < cutoff) await graph.graph("delete", `/sites/${encodeURIComponent(sp.siteId)}/drive/items/${it.id}`);
}

// ------------------------------------------------------------ open a backup (used by the test and by scripts/backup.js)
/** Decrypt + unpack a backup into a new folder; verify both checksums. Returns { dir, manifest }. */
async function open(file, base) {
  const dir = await tmpDir(base || path.dirname(file));
  const bundle = path.join(dir, "bundle.tar");
  await decryptFile(file, bundle);
  await run("tar", ["-xf", bundle, "-C", dir]);
  await fsp.rm(bundle, { force: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
  for (const part of ["db.dump", "files.tar"]) {
    if ((await sha256(path.join(dir, part))) !== manifest.sha256[part]) throw new Error(`${part} ใน backup เสียหาย (checksum ไม่ตรง)`);
  }
  return { dir, manifest };
}
async function tarCount(file) {
  const out = await run("tar", ["-tf", file]);
  return out.split("\n").filter((l) => l && !l.endsWith("/")).length;
}

// ------------------------------------------------------------ restore test
/** Restore the newest backup into a throwaway database, compare row counts with the manifest, then drop it.
 *  Needs CREATEDB on the app's database user; without it only the archive itself is checked ("archive" level). */
async function testRestore({ by = "schedule", file } = {}) {
  if (busy) throw bad(`กำลัง${busy}อยู่ รอสักครู่`, 409);
  busy = "ทดสอบ restore";
  const s = await settings();
  const started = Date.now();
  const scratch = `case_restore_test_${crypto.randomBytes(4).toString("hex")}`;
  let opened;
  let created = false;
  const admin = new Client({ connectionString: config3.databaseUrl });
  try {
    const list = await listBackups(s.dir);
    const pick = file ? list.find((x) => x.name === file) : list[0];
    if (!pick) throw new Error("ยังไม่มีไฟล์ backup ให้ทดสอบ");
    const ageH = (Date.now() - new Date(pick.at).getTime()) / 3600000;
    opened = await open(path.join(s.dir, pick.name), s.dir);
    const m = opened.manifest;
    const dump = path.join(opened.dir, "db.dump");
    const tarFiles = await tarCount(path.join(opened.dir, "files.tar"));
    if (tarFiles !== m.files) throw new Error(`ไฟล์แนบใน backup มี ${tarFiles} ไฟล์ แต่ตอนสร้างนับได้ ${m.files}`);
    await run("pg_restore", ["-l", dump]);

    await admin.connect();
    let level = "full";
    try {
      await admin.query(`CREATE DATABASE ${scratch}`);
      created = true;
    } catch (e) {
      if (!/permission denied|must be|createdb/i.test(e.message)) throw e;
      level = "archive";
    }
    const diffs = [];
    if (created) {
      const url = withDb(config3.databaseUrl, scratch);
      await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "-d", scratch, dump], { env: pgEnv(url) });
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const got = await tableCounts(c);
        for (const [t, n] of Object.entries(m.counts)) {
          // Rows written between the count and the dump may be in the dump too, so more is fine; fewer is not.
          if (got[t] === undefined) diffs.push(`ตาราง ${t} ไม่มีใน restore`);
          else if (got[t] < n) diffs.push(`${t}: backup ${n} แถว แต่ restore ได้ ${got[t]}`);
        }
        const ref = await c.query("SELECT count(*)::int AS n FROM intake_files").catch(() => ({ rows: [{ n: null }] }));
        if (ref.rows[0].n !== null && ref.rows[0].n > tarFiles) diffs.push(`ฐานข้อมูลอ้างถึงไฟล์แนบ ${ref.rows[0].n} ไฟล์ แต่ใน backup มี ${tarFiles}`);
      } finally {
        await c.end().catch(() => {});
      }
    }
    if (diffs.length) throw new Error("ข้อมูลที่ restore ได้ไม่ครบ: " + diffs.join(" · "));
    const result = {
      ok: true, level, at: new Date().toISOString(), by, name: pick.name, backupAgeHours: Math.round(ageH),
      seconds: Math.round((Date.now() - started) / 1000), cases: m.counts.cases || 0, files: m.files, tables: Object.keys(m.counts).length,
      note: level === "archive" ? "ตรวจได้แค่ไฟล์ backup อ่านได้และ checksum ตรง ยังไม่ได้ลอง restore จริง เพราะผู้ใช้ฐานข้อมูลของระบบไม่มีสิทธิ์ CREATEDB" : "",
    };
    if (ageH > 36) result.warning = `backup ล่าสุดเก่า ${Math.round(ageH)} ชั่วโมง`;
    await record("test", result);
    if (result.warning) await alert("Backup ล่าสุดเก่าเกินไป", `${result.warning} ตรวจว่างาน backup ทุกคืนยังทำงานอยู่`);
    return result;
  } catch (e) {
    const result = { ok: false, at: new Date().toISOString(), by, error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    await record("test", result);
    await alert("ทดสอบ restore ไม่ผ่าน", e.message);
    if (by !== "schedule") throw bad(e.message, 500);
    return result;
  } finally {
    busy = null;
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${scratch}`).catch((e) => console.error("[backup] drop scratch:", e.message));
    await admin.end().catch(() => {});
    if (opened) await fsp.rm(opened.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function status() {
  const s = await settings();
  const st = (await getSetting("backup_status", null)) || {};
  return { settings: s, keySet: keyOk(), fileDir: fileDir(), busy, backup: st.backup || null, test: st.test || null, history: (st.history || []).slice(0, 12), files: (await listBackups(s.dir)).slice(0, 30) };
}

module.exports = { settings, save, runBackup, testRestore, status, open, decryptFile, listBackups, pgEnv, withDb, run, fileDir, human, NAME_RE };
