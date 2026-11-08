// RCA from NICE. A case with a CS Number was opened with NICE, so it can only be closed once the RCA
// NICE sent back is recorded (summary, cause category, date received, optional file).
// Closing as Cancel / N/A is exempt: NICE does not issue an RCA for those.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const d = require("../dates");

const RCA_MIN = 30;
const RCA_CATEGORIES = [
  "Software bug (NICE)",
  "Configuration",
  "Network / Infrastructure",
  "Hardware",
  "Customer environment",
  "Third-party / Integration",
  "ไม่พบสาเหตุ (No root cause found)",
];
const RCA_EXEMPT = ["cancel", "n/a"];
const RCA_DIR = path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"), "rca");
const MAX_FILE = 10 * 1024 * 1024;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** True when closing with this status needs an RCA (case has a CS Number and the status is not Cancel / N/A). */
const needsRca = (csNumber, status) => !!String(csNumber || "").trim() && !RCA_EXEMPT.includes(String(status || "").trim().toLowerCase());

/** Validate {text, category, date}; returns cleaned values or throws a 400 with a message the user can act on. */
function checkRca(r) {
  const x = r || {};
  const text = String(x.text || "").trim();
  if (text.length < RCA_MIN) throw bad(`เคสนี้มี CS Number ต้องใส่สรุป RCA จาก NICE อย่างน้อย ${RCA_MIN} ตัวอักษรก่อนปิดเคส`);
  const category = RCA_CATEGORIES.find((c) => c === String(x.category || "").trim());
  if (!category) throw bad("เลือกหมวดสาเหตุของ RCA");
  const date = d.fromISODate(String(x.date || ""));
  if (!date) throw bad("ใส่วันที่ NICE ส่ง RCA");
  if (date > d.addDays(d.today(), 1)) throw bad("วันที่ NICE ส่ง RCA อยู่ในอนาคต");
  return { text: text.slice(0, 6000), category, date: d.toISODate(date) };
}

const TYPES = [
  { ext: "pdf", mime: "application/pdf", ok: (b) => b.slice(0, 5).toString() === "%PDF-" },
  { ext: "png", mime: "image/png", ok: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: "webp", mime: "image/webp", ok: (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP" },
  { ext: "msg", mime: "application/vnd.ms-outlook", ok: (b, n) => /\.msg$/i.test(n) && b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ok: (b, n) => /\.docx$/i.test(n) && b.slice(0, 2).toString() === "PK" },
  { ext: "eml", mime: "message/rfc822", ok: (b, n) => /\.eml$/i.test(n) && /^[\x20-\x7e\r\n\t]{0,200}?(from|received|return-path|date|subject|mime-version|message-id):/im.test(b.slice(0, 2000).toString("latin1")) },
];

function saveFile(caseId, file) {
  const name = String(file.name || "rca").replace(/[\\/\r\n\0]/g, "_").slice(0, 160);
  const buf = Buffer.from(String(file.data || "").replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length < 20) throw bad("ไฟล์ RCA ว่างหรืออ่านไม่ได้");
  if (buf.length > MAX_FILE) throw bad("ไฟล์ RCA ต้องไม่เกิน 10 MB");
  const t = TYPES.find((x) => x.ok(buf, name));
  if (!t) throw bad("ไฟล์ RCA รองรับ PDF, รูป (PNG/JPG/WebP), email (.msg/.eml) หรือ Word (.docx)");
  fs.mkdirSync(RCA_DIR, { recursive: true, mode: 0o750 });
  const stored = `c${caseId}-${crypto.randomBytes(6).toString("hex")}.${t.ext}`;
  fs.writeFileSync(path.join(RCA_DIR, stored), buf, { mode: 0o640 });
  return { stored, name, mime: t.mime };
}
const removeFile = (stored) => stored && fs.rmSync(path.join(RCA_DIR, path.basename(stored)), { force: true });

function mount(api, { wrap, loadVisible, perms, repo, tx, audit }) {
  // Save / update the RCA (also before closing, when NICE sends it early). Optional file; removeFile drops the old one.
  api.put("/case/:id(\\d+)/rca", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!(await perms.can(req.user, "case_edit", c))) throw bad("ไม่มีสิทธิ์แก้ไขเคสนี้", 403);
    const b = req.body || {};
    const r = checkRca(b);
    const f = b.file && b.file.data ? saveFile(c.id, b.file) : null;
    const old = c.rcaFile;
    const dropOld = f || b.removeFile;
    try {
      await tx(async (cl) => {
        await cl.query(
          `UPDATE cases SET rca_text = $2, rca_category = $3, rca_date = $4, rca_by = $5, rca_at = now(), updated_at = now()
             ${f ? ", rca_file = $6, rca_file_name = $7, rca_file_mime = $8" : b.removeFile ? ", rca_file = NULL, rca_file_name = NULL, rca_file_mime = NULL" : ""}
           WHERE id = $1`,
          [c.id, r.text, r.category, r.date, req.user.id, ...(f ? [f.stored, f.name, f.mime] : [])]
        );
        await repo.addActivity(cl, c.id, req.user, {
          kind: c.rcaText ? "แก้ RCA จาก NICE" : "บันทึก RCA จาก NICE",
          detail: `RCA (${r.category}, NICE ส่ง ${r.date}):\n${r.text}${f ? `\nไฟล์: ${f.name}` : ""}`,
        });
      });
    } catch (e) {
      if (f) removeFile(f.stored);
      throw e;
    }
    if (dropOld && old) removeFile(old);
    await audit(req.user, "case_rca", `${c.caseNo || "#" + c.id}`, { case_id: c.id, category: r.category, file: f ? f.name : undefined });
    res.json({ ok: true });
  }));

  api.get("/case/:id(\\d+)/rca/file", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!c.rcaFile) throw bad("ไม่มีไฟล์ RCA", 404);
    const f = path.join(RCA_DIR, path.basename(c.rcaFile));
    if (!fs.existsSync(f)) throw bad("ไม่พบไฟล์ RCA", 404);
    const inline = /^image\/|^application\/pdf$/.test(c.rcaFileMime || "");
    res.setHeader("Content-Type", c.rcaFileMime || "application/octet-stream");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(c.rcaFileName || path.basename(f))}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Cache-Control", "private, max-age=300");
    fs.createReadStream(f).pipe(res);
  }));
}

module.exports = { mount, needsRca, checkRca, RCA_MIN, RCA_CATEGORIES, RCA_EXEMPT, MAX_FILE };
