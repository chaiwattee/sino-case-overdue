// Photos and files the team attaches to a case (phone camera at the customer site, screenshots, logs).
// Stored on the server disk (not in the database); only people who can see the case can open them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { q, one, all, audit } = require("./db");

// Inside the attachment folder, so the nightly backup (which archives that whole folder) includes these too.
const DIR = path.resolve(process.env.CASE_FILE_DIR || path.join(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"), "case-files"));
const EXT = ["jpg", "jpeg", "png", "webp", "gif", "pdf", "txt", "log", "csv", "zip", "docx", "xlsx", "pptx", "msg", "eml"];
const IMG = /^image\/(png|jpe?g|gif|webp)$/;
const MAX = 10 * 1024 * 1024;
const PER_CASE = 50;
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

const list = (caseId) =>
  all(`SELECT f.id, f.file_name, f.mime, f.size, f.caption, f.created_at, f.created_by, u.display_name AS by FROM case_files f LEFT JOIN users u ON u.id = f.created_by WHERE f.case_id = $1 ORDER BY f.id DESC`, [caseId]);

function mount(api, { wrap, loadVisible, perms }) {
  api.post("/case/:id/files", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!(await perms.can(req.user, "case_edit", c))) throw bad("ไม่มีสิทธิ์แนบไฟล์ในเคสนี้", 403);
    const b = req.body || {};
    const name = String(b.name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 150) || "file";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!EXT.includes(ext)) throw bad(`ไม่รองรับไฟล์ .${ext} (รองรับ ${EXT.join(", ")})`);
    const buf = Buffer.from(String(b.data || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length) throw bad("ไฟล์ว่าง");
    if (buf.length > MAX) throw bad("ไฟล์ใหญ่เกิน 10 MB");
    const n = await one("SELECT count(*)::int AS n FROM case_files WHERE case_id = $1", [c.id]);
    if (n.n >= PER_CASE) throw bad(`แนบได้สูงสุด ${PER_CASE} ไฟล์ต่อเคส`);
    let mime = String(b.mime || "").slice(0, 100) || "application/octet-stream";
    // Trust the bytes, not the browser, for pictures (shown inline).
    const sig = buf.subarray(0, 12).toString("hex");
    const real = sig.startsWith("ffd8ff") ? "image/jpeg" : sig.startsWith("89504e47") ? "image/png" : sig.startsWith("47494638") ? "image/gif" : sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
    if (IMG.test(mime) && !real) mime = "application/octet-stream";
    if (real) mime = real;
    const dir = path.join(DIR, new Date().toISOString().slice(0, 7));
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const stored = path.join(dir, crypto.randomBytes(16).toString("hex") + "." + ext);
    fs.writeFileSync(stored, buf, { mode: 0o640 });
    const caption = String(b.caption || "").trim().slice(0, 300) || null;
    const r = await one("INSERT INTO case_files (case_id, file_name, mime, size, path, caption, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [c.id, name, mime, buf.length, stored, caption, req.user.id]);
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, current_date, 'แนบไฟล์', $2, true, $3)", [
      c.id, `แนบ${IMG.test(mime) ? "รูป" : "ไฟล์"} ${name}${caption ? ` · ${caption}` : ""}`, req.user.id,
    ]);
    await audit(req.user, "case_file_add", c.caseNo, { case_id: c.id, file: name, size: buf.length });
    res.json({ ok: true, id: r.id, files: await list(c.id) });
  }));
  api.get("/case/:id/files/:fid(\\d+)", wrap(async (req, res) => {
    const c = await loadVisible(req);
    const f = await one("SELECT * FROM case_files WHERE id = $1 AND case_id = $2", [Number(req.params.fid), c.id]);
    if (!f || !f.path.startsWith(DIR) || !fs.existsSync(f.path)) throw bad("ไม่พบไฟล์", 404);
    res.set("Content-Type", IMG.test(f.mime) ? f.mime : "application/octet-stream");
    res.set("Content-Disposition", `${IMG.test(f.mime) && !req.query.dl ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    res.set("Cache-Control", "private, max-age=3600");
    res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    fs.createReadStream(f.path).pipe(res);
  }));
  api.delete("/case/:id/files/:fid(\\d+)", wrap(async (req, res) => {
    const c = await loadVisible(req);
    const f = await one("SELECT * FROM case_files WHERE id = $1 AND case_id = $2", [Number(req.params.fid), c.id]);
    if (!f) throw bad("ไม่พบไฟล์", 404);
    if (f.created_by !== req.user.id && req.user.role !== "admin") throw bad("ลบได้เฉพาะคนที่แนบ หรือ Admin", 403);
    await q("DELETE FROM case_files WHERE id = $1", [f.id]);
    try {
      if (f.path.startsWith(DIR)) fs.unlinkSync(f.path);
    } catch (e) {}
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, current_date, 'แนบไฟล์', $2, true, $3)", [c.id, `ลบไฟล์ ${f.file_name}`, req.user.id]);
    await audit(req.user, "case_file_delete", c.caseNo, { case_id: c.id, file: f.file_name });
    res.json({ ok: true, files: await list(c.id) });
  }));
}

module.exports = { mount, list, DIR };
