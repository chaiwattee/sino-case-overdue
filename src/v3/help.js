// Global search (Ctrl+K): data search (cases, CS numbers, requests, customers, people) and the how-to help.
// Help answers come only from these articles (built in, plus admin's own / edited ones in setting "help_articles"),
// so an answer always matches how the app works. Questions with no good answer can be sent to the admins.
const { one, all, q, audit } = require("./db");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// roles: who the article is for (empty = everyone). keywords: Thai + English words people type.
const DEFAULTS = [
  { id: "case-new", title: "เปิดเคสใหม่", roles: [], keywords: ["เปิดเคส", "สร้างเคส", "เคสใหม่", "new case", "create case", "แจ้งเคส"],
    steps: ["ไปที่ งานของฉัน › เคสของฉัน แล้วกด “เปิดเคสใหม่” (มุมขวาบน)", "เลือกลูกค้า ทีม Severity และ Product แล้วเขียนงานที่ต้องทำ", "ใส่ CS Number ถ้าเป็นเคสที่เปิดกับ NICE ด้วย ระบบจะดึง email จาก NICE เข้าเคสให้เอง", "กด บันทึก ระบบตั้ง Due ตาม SLA และเริ่มนับวัน"], href: "#/case/new", hrefLabel: "เปิดเคสใหม่" },
  { id: "case-overdue", title: "เคสเกิน Due ต้องทำอย่างไร", roles: [], keywords: ["เกิน due", "เกินกำหนด", "overdue", "เลย due", "ช้า", "late"],
    steps: ["เปิดเคสจาก งานของฉัน › กลุ่ม “เกิน Due” ในสรุปด้านบน", "ถ้ายังทำไม่เสร็จ กด “ขอขยาย Due” ใส่วันใหม่และเหตุผล", "Manager ตรวจ แล้วส่งต่อให้ Admin อนุมัติขั้นสุดท้าย", "ถ้าแก้เสร็จแล้ว กด “ขอปิดเคส” แทน · ระหว่างรออนุมัติ เคสยังนับว่าเกิน Due"], href: "#/mine?tab=open&stage=overdue", hrefLabel: "ไปที่เคสเกิน Due ของฉัน" },
  { id: "ext-request", title: "ขอขยาย Due เคส", roles: [], keywords: ["ขยาย", "ขยาย due", "ขยายเวลา", "เลื่อน due", "extend", "extension"],
    steps: ["เปิดเคสที่ต้องการ แล้วกด “ขอขยาย Due”", "เลือกวัน Due ใหม่ และเขียนเหตุผลให้ชัด (อย่างน้อย 10 ตัวอักษร)", "คำขอไปที่ Manager ของทีมก่อน แล้ว Admin อนุมัติขั้นสุดท้าย", "เมื่ออนุมัติแล้ว Due ของเคสเปลี่ยนและมีบันทึกใน Activity"], href: "#/mine", hrefLabel: "ไปที่งานของฉัน" },
  { id: "ext-approve", title: "อนุมัติการขยาย Due", roles: ["manager", "admin"], keywords: ["อนุมัติขยาย", "อนุมัติ due", "approve extension", "รออนุมัติ", "ขยาย"],
    steps: ["เปิด งานของฉัน: สรุปด้านบนมีกลุ่ม “รออนุมัติขยาย Due” (Manager) หรือ “ขยาย Due รอ Admin อนุมัติ” (Admin)", "กดกลุ่มนั้น หน้าจะเลื่อนไปที่รายการคำขอ", "อ่านเหตุผล แล้วกด อนุมัติ หรือ ไม่อนุมัติ (ใส่เหตุผล)", "Manager อนุมัติแล้วคำขอจะไปรอ Admin · ควรตอบภายใน 1 วันทำการ เพราะนับใน KPI การตอบของ Manager"], href: "#/mine", hrefLabel: "ไปที่งานรออนุมัติ" },
  { id: "close-request", title: "ขอปิดหรือยกเลิกเคส", roles: [], keywords: ["ปิดเคส", "ขอปิด", "ยกเลิกเคส", "close case", "cancel", "resolved", "success"],
    steps: ["เปิดเคส แล้วกด “ขอปิดเคส”", "เลือกผล (Success / Resolved / Cancel) และเขียนสรุปสิ่งที่ทำ", "Manager ของทีมอนุมัติ แล้วเคสจะปิด", "เมื่อเคสปิด ระบบส่งแบบสอบถามความพึงพอใจให้ลูกค้า (ถ้าเคสมาจากลูกค้า)"], href: "#/mine", hrefLabel: "ไปที่เคสของฉัน" },
  { id: "close-approve", title: "อนุมัติคำขอปิดเคส", roles: ["manager", "admin"], keywords: ["อนุมัติปิด", "approve close", "ปิดเคส", "รออนุมัติ"],
    steps: ["เปิด งานของฉัน แล้วกดกลุ่ม “รออนุมัติปิดเคส”", "อ่านสรุปของ Engineer และดูเคส", "กด อนุมัติ หรือ ส่งกลับ พร้อมความเห็น", "ตอบภายใน 1 วันทำการ เพื่อไม่ให้นับเป็นตอบช้า"], href: "#/mine", hrefLabel: "ไปที่งานรออนุมัติ" },
  { id: "activity", title: "บันทึกความคืบหน้า (Activity)", roles: [], keywords: ["activity", "อัปเดต", "update", "บันทึก", "ความคืบหน้า", "note"],
    steps: ["เปิดเคส แล้วเลื่อนไปที่ส่วน Activity", "เลือกประเภท เขียนสิ่งที่ทำ ผล และขั้นต่อไป", "ถ้าเคสมาจากลูกค้าและอยากให้ลูกค้าเห็นใน Portal ให้ติ๊ก “ลูกค้าเห็นใน Portal” (เขียนเป็นภาษาที่ลูกค้าอ่านได้)", "กด “เพิ่ม Activity”"], href: "#/mine", hrefLabel: "ไปที่เคสของฉัน" },
  { id: "transfer", title: "โอนเคสข้ามทีม", roles: [], keywords: ["โอน", "ย้ายทีม", "transfer", "ผิดทีม", "ทีมอื่น"],
    steps: ["เปิดเคส แล้วกด “โอนเคส”", "เลือกทีมปลายทางและเขียนเหตุผล", "Manager ทีมปลายทางรับหรือปฏิเสธ", "ถ้ารับ ระบบเปิดเคสใหม่ในทีมนั้นและปิดเคสเดิมเป็น Transferred"], href: "#/mine", hrefLabel: "ไปที่เคสของฉัน" },
  { id: "intake-claim", title: "รับเรื่องที่ลูกค้าแจ้ง (เคสจากลูกค้า)", roles: [], keywords: ["รับเรื่อง", "รับเคส", "claim", "intake", "เคสจากลูกค้า", "req", "คำขอรอรับ"],
    steps: ["ไปที่ งานของฉัน › เคสจากลูกค้า (หรือกล่อง “คำขอรอรับเรื่อง” ในสรุป)", "เปิดคำขอ ตรวจลูกค้าและรายละเอียด", "กด “รับเคสเอง” หรือ “โอนให้ User” ระบบเปิดเคสพร้อม Due", "ลูกค้าได้ email เลขเคสอัตโนมัติ"], href: "#/intake", hrefLabel: "ไปที่เคสจากลูกค้า" },
  { id: "sr", title: "ส่งคำขอบริการ (Service Request) ถึงทีมอื่น", roles: [], keywords: ["คำขอบริการ", "service request", "sr", "ขอให้ทีม", "ขอความช่วยเหลือ"],
    steps: ["ไปที่ งานของฉัน › คำขอบริการ แล้วกด “ส่งคำขอ”", "เลือกทีมที่จะขอ เขียนรายละเอียด และวันที่ต้องการ", "Manager ทีมนั้นมอบหมายคนทำ", "ติดตามสถานะได้ที่ “ที่ฉันขอ” · ผู้ขอแก้คำขอหรือเปลี่ยนทีมได้ถ้าขอผิดทีม"], href: "#/sr", hrefLabel: "ไปที่คำขอบริการ" },
  { id: "nice-auto", title: "email จาก NICE เข้าเคสอัตโนมัติ", roles: [], keywords: ["nice", "cs number", "cs", "email nice", "อัปเดตจาก nice"],
    steps: ["ใส่ CS Number ของ NICE ในเคส", "ทุก 3 นาที ระบบอ่าน email จาก NICE ที่ส่งเข้า support@ / nexidia@ / wfm@", "ข้อความใหม่ถูกบันทึกเป็น Activity “อัปเดตจาก NICE” ในเคสที่ CS Number ตรงกัน", "ถ้า Engineer ตอบ NICE ทาง email หรือ Portal ข้อความจะเข้าเป็น “ตอบ NICE” เช่นกัน"], href: "#/nice-response", hrefLabel: "ดู NICE / Sino Response" },
  { id: "nice-queue", title: "ผูก email NICE ที่ยังไม่ตรงกับเคส", roles: ["manager", "admin"], keywords: ["nice รอผูก", "ผูกเคส", "unmatched", "nice", "ไม่ตรงกับเคส"],
    steps: ["ไปที่ Report › NICE รอผูกเคส", "รายการที่ขึ้น “น่าจะเป็นทีมคุณ” อยู่ด้านบน", "กด “ผูกกับเคส…” แล้วใส่เลขเคสในทีมของคุณ หรือ “เปิดเคสใหม่จากนี้”", "ถ้าไม่ใช่ทีมคุณ กด “ไม่ใช่ทีมเรา” · ผูกผิดยกเลิกได้ภายใน 7 วัน"], href: "#/nice-queue", hrefLabel: "ไปที่ NICE รอผูกเคส" },
  { id: "nice-response", title: "ดูเวลาตอบระหว่าง NICE กับทีมเรา", roles: [], keywords: ["response", "เวลาตอบ", "nice response", "sino response", "ตอบ nice"],
    steps: ["ไปที่ Report › NICE / Sino Response", "เลือกแท็บ NICE Response หรือ Sino Response และเดือน", "ค้นหาเคสเดียวด้วย CS Number หรือเลขเคสในช่องค้นหาของหน้านั้น", "ฝั่งเรานับเฉพาะเวลาทำงาน 08:30–17:30 ไม่รวมเสาร์-อาทิตย์และวันหยุด"], href: "#/nice-response", hrefLabel: "ไปที่ NICE / Sino Response" },
  { id: "portal-account", title: "สร้างบัญชี Customer Portal ให้ลูกค้า", roles: ["admin", "manager"], keywords: ["portal", "บัญชีลูกค้า", "customer portal", "สร้าง user ลูกค้า", "รหัสผ่านลูกค้า"],
    steps: ["ไปที่ ภาพรวม › ราย ลูกค้า แล้วเลือกลูกค้า", "ในการ์ด Customer Portal กด “+ เพิ่มบัญชี” ใส่ username ชื่อ email", "ระบบแสดงรหัสผ่านเริ่มต้นครั้งเดียว: ส่งให้ลูกค้าผ่านช่องทางที่ปลอดภัย แยกจาก username", "ลูกค้าต้องตั้งรหัสใหม่เมื่อเข้าครั้งแรก · ต้องเป็น Admin หรือมีสิทธิ์จัดการรายชื่อลูกค้า"], href: "#/customer", hrefLabel: "ไปที่ราย ลูกค้า" },
  { id: "portal-reset", title: "ลูกค้าลืมรหัสผ่าน Portal หรือบัญชีถูกล็อก", roles: ["admin", "manager"], keywords: ["ลืมรหัส", "reset", "รีเซ็ต", "ล็อก", "locked", "portal"],
    steps: ["เปิดหน้าลูกค้า › การ์ด Customer Portal", "บัญชีที่ล็อกอยู่ กด “ปลดล็อก” · ลืมรหัส กด “รีเซ็ตรหัสผ่าน”", "ส่งรหัสเริ่มต้นใหม่ให้ลูกค้าผ่านช่องทางที่ปลอดภัย", "ลูกค้าต้องตั้งรหัสใหม่เมื่อเข้าครั้งถัดไป"], href: "#/customer", hrefLabel: "ไปที่ราย ลูกค้า" },
  { id: "portal-share", title: "ให้ลูกค้าเห็นข้อความใน Portal", roles: [], keywords: ["ลูกค้าเห็น", "portal", "แสดงให้ลูกค้า", "customer visible"],
    steps: ["ใช้ได้กับเคสที่ลูกค้าแจ้งมา (email / ฟอร์ม / Portal)", "ตอนเพิ่ม Activity ติ๊ก “ลูกค้าเห็นใน Portal” หรือกด “แสดงให้ลูกค้า” ที่ Activity เดิม", "ลูกค้าเห็นเฉพาะข้อความที่ติ๊ก ไม่เห็นข้อความภายใน"], href: "#/mine", hrefLabel: "ไปที่เคสของฉัน" },
  { id: "csat", title: "ดูความพึงพอใจของลูกค้า (CSAT)", roles: [], keywords: ["csat", "ความพึงพอใจ", "feedback", "คะแนน", "แบบสอบถาม"],
    steps: ["เมื่อเคสที่ลูกค้าแจ้งปิด ระบบส่งแบบสอบถามให้ลูกค้าทาง email", "คะแนนแสดงในการ์ด “ความพึงพอใจของลูกค้า” ในหน้าเคส", "ภาพรวมดูได้ที่ Report › ความพึงพอใจลูกค้า", "ลูกค้าแก้คะแนนได้จนลิงก์หมดอายุ: ระบบเก็บคะแนนล่าสุด"], href: "#/csat", hrefLabel: "ไปที่ความพึงพอใจลูกค้า" },
  { id: "kpi", title: "ดู KPI ของฉัน", roles: [], keywords: ["kpi", "คะแนน", "ผลงาน", "score"],
    steps: ["ไปที่ ทีมและผลงาน › KPI", "ดูคะแนนแต่ละด้าน: SLA, ตรงเวลา, งานค้าง", "เคสเกิน Due และคำขอบริการที่เลย Target ทำให้คะแนนลดลง", "อัปเดตเคส ปิดงาน หรือขอขยาย Due พร้อมเหตุผลก่อนเกินกำหนด"], href: "#/kpi", hrefLabel: "ไปที่ KPI" },
  { id: "manager-perf", title: "ดูผลงาน Manager", roles: ["admin", "observer"], keywords: ["ผลงาน manager", "manager performance", "การตอบอนุมัติ", "manager"],
    steps: ["ไปที่ ทีมและผลงาน › ผลงาน Manager", "เลือกเดือน", "ดูรออนุมัติตอนนี้ % ตอบทันเวลา ทีมเกิน Due ทีมปิดทัน SLA และ CSAT", "กดจำนวนที่ตอบช้าเพื่อดูรายการ"], href: "#/managers", hrefLabel: "ไปที่ผลงาน Manager" },
  { id: "export", title: "Export ข้อมูลเป็น Excel", roles: [], keywords: ["export", "excel", "ดาวน์โหลด", "รายงาน", "report"],
    steps: ["หน้าเคสของฉัน: กด “Export เคสของฉัน”", "รายงานอื่น: ไปที่ Report › Report & Export แล้วเลือกรายงานและช่วงวันที่", "บางหน้า (เช่น NICE / Sino Response) มีปุ่ม Export Excel ของหน้านั้น"], href: "#/reports", hrefLabel: "ไปที่ Report & Export" },
  { id: "customer-add", title: "เพิ่มชื่อลูกค้าใหม่", roles: [], keywords: ["เพิ่มลูกค้า", "ลูกค้าใหม่", "customer", "ชื่อลูกค้า"],
    steps: ["ตอนเปิดเคส ถ้าพิมพ์ชื่อลูกค้าที่ยังไม่มี ระบบจะถามเพิ่มลูกค้าใหม่", "ผู้มีสิทธิ์จัดการรายชื่อลูกค้าเพิ่มหรือปิดใช้ชื่อลูกค้าได้ที่หน้า ราย ลูกค้า", "ระบบเตือนเมื่อชื่อคล้ายกับที่มีอยู่ เพื่อกันชื่อซ้ำ"], href: "#/customer", hrefLabel: "ไปที่ราย ลูกค้า" },
  { id: "hotline", title: "เบอร์ Hotline ที่ลูกค้าเห็น", roles: ["admin"], keywords: ["hotline", "เบอร์", "โทร", "critical"],
    steps: ["ไปที่ ผู้ดูแลระบบ › ตั้งค่า › Hotline", "ใส่เบอร์ในแต่ละแถว (แถวที่ไม่มีเบอร์จะไม่แสดง)", "เบอร์แสดงใน email ตอบรับ หน้าแจ้งเคส และ Customer Portal (แนะนำให้โทรเมื่อเป็น Critical)"], href: "#/settings", hrefLabel: "ไปที่ตั้งค่า" },
  { id: "password", title: "เปลี่ยนรหัสผ่านของฉัน", roles: [], keywords: ["รหัสผ่าน", "password", "เปลี่ยนรหัส"],
    steps: ["กดชื่อของคุณมุมขวาบน", "เลือก “เปลี่ยนรหัสผ่าน” (เฉพาะบัญชีแบบรหัสผ่าน)", "บัญชี Microsoft 365 เปลี่ยนรหัสที่ Microsoft"] },
  { id: "search", title: "ใช้ช่องค้นหานี้", roles: [], keywords: ["ค้นหา", "search", "หา", "ctrl k"],
    steps: ["กด Ctrl+K หรือคลิกช่องค้นหาบนแถบเมนู", "พิมพ์ชื่อหน้า เลขเคส CS Number เลข REQ ชื่อลูกค้า หรือชื่อคน", "หรือพิมพ์คำถาม เช่น “ขอขยาย due ยังไง” ระบบตอบเป็นขั้นตอน", "ใช้ลูกศรเลือก Enter เปิด Esc ปิด"] },
];

async function articles() {
  const r = await one("SELECT value FROM settings WHERE key = 'help_articles'").catch(() => null);
  const custom = (r && r.value && Array.isArray(r.value.items)) ? r.value.items : [];
  const byId = new Map(DEFAULTS.map((a) => [a.id, { ...a, builtIn: true }]));
  for (const c of custom) byId.set(c.id, { ...(byId.get(c.id) || {}), ...c, builtIn: byId.has(c.id) });
  return [...byId.values()];
}

function clean(s, n) { return String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n); }

function mount(api, { wrap }) {
  api.get("/help", wrap(async (req, res) => {
    const role = req.user.role;
    const list = (await articles()).filter((a) => !a.hidden && (!a.roles || !a.roles.length || a.roles.includes(role) || role === "admin"));
    res.json({ items: list.map(({ id, title, keywords, steps, href, hrefLabel, roles }) => ({ id, title, keywords, steps, href, hrefLabel, roles })) });
  }));

  // Data search. Each part respects what the user may see.
  api.get("/search", wrap(async (req, res) => {
    const u = req.user;
    const t = clean(req.query.q, 80);
    if (t.length < 2) return res.json({ cases: [], requests: [], customers: [], people: [] });
    const like = `%${t.toLowerCase()}%`;
    const repo = require("./caserepo");
    const seesCases = !["requester"].includes(u.role);
    const cases = seesCases
      ? (await repo.loadCases(u, { where: "(lower(c.case_no) LIKE $1 OR lower(coalesce(c.cs_number,'')) LIKE $1 OR lower(c.site) LIKE $1 OR lower(c.task) LIKE $1)", params: [like] }))
          .sort((a, b) => (b.stage !== "closed") - (a.stage !== "closed") || b.id - a.id).slice(0, 8)
          .map((c) => ({ id: c.id, ref: c.caseNo || c.case_no, cs: c.csNumber || c.cs_number || "", site: c.site, task: c.task, status: c.status, stage: c.stage, owner: c.owner || "" }))
      : [];
    const requests = seesCases
      ? await all(`SELECT i.id, i.req_no, i.site, i.subject, i.status FROM intakes i WHERE NOT i.is_test AND (lower(i.req_no) LIKE $1 OR lower(coalesce(i.site,'')) LIKE $1 OR lower(i.subject) LIKE $1) ORDER BY i.id DESC LIMIT 5`, [like])
      : [];
    const customers = await all("SELECT value AS site FROM lookups WHERE kind = 'site' AND active AND lower(value) LIKE $1 ORDER BY value LIMIT 5", [like]);
    const people = ["requester"].includes(u.role) ? [] : await all("SELECT id, display_name, role FROM users WHERE active AND (lower(display_name) LIKE $1 OR lower(email) LIKE $1) ORDER BY display_name LIMIT 5", [like]);
    res.json({ cases, requests, customers, people });
  }));

  // "No answer for my question": goes to the admins' list.
  api.post("/help/ask", wrap(async (req, res) => {
    const text = clean(req.body?.q, 300);
    if (text.length < 3) throw bad("พิมพ์คำถามก่อน");
    const recent = await one("SELECT count(*)::int AS n FROM help_questions WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [req.user.id]);
    if (recent.n >= 10) throw bad("ส่งคำถามมากเกินไป ลองใหม่ภายหลัง", 429);
    await q("INSERT INTO help_questions (user_id, question, page) VALUES ($1, $2, $3)", [req.user.id, text, clean(req.body?.page, 120)]);
    res.json({ ok: true });
  }));

  // Admin: edit articles and see the questions people asked.
  const admin = (req) => { if (req.user.role !== "admin") throw bad("เฉพาะ Admin", 403); };
  api.get("/help-admin", wrap(async (req, res) => {
    admin(req);
    const qs = await all(`SELECT h.id, h.question, h.page, h.created_at, h.done, u.display_name FROM help_questions h LEFT JOIN users u ON u.id = h.user_id
      ORDER BY h.done, h.id DESC LIMIT 200`);
    res.json({ items: await articles(), questions: qs });
  }));
  api.put("/help-admin/article", wrap(async (req, res) => {
    admin(req);
    const b = req.body || {};
    const id = clean(b.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, "-") || `a-${Date.now().toString(36)}`;
    const steps = (Array.isArray(b.steps) ? b.steps : String(b.steps || "").split("\n")).map((s) => clean(s, 400)).filter(Boolean).slice(0, 12);
    const title = clean(b.title, 120);
    if (!title || !steps.length) throw bad("ต้องมีหัวข้อและอย่างน้อย 1 ขั้นตอน");
    const href = clean(b.href, 200);
    if (href && !/^#\//.test(href)) throw bad("ลิงก์ต้องเป็นหน้าในระบบ เช่น #/mine");
    const item = {
      id, title, steps, href: href || "", hrefLabel: clean(b.hrefLabel, 60),
      keywords: (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || "").split(",")).map((k) => clean(k, 40).toLowerCase()).filter(Boolean).slice(0, 30),
      roles: (Array.isArray(b.roles) ? b.roles : []).filter((r) => ["admin", "manager", "engineer", "observer", "viewer", "requester"].includes(r)),
      hidden: !!b.hidden,
    };
    const r = await one("SELECT value FROM settings WHERE key = 'help_articles'").catch(() => null);
    const items = ((r && r.value && r.value.items) || []).filter((x) => x.id !== id);
    items.push(item);
    await q("INSERT INTO settings (key, value) VALUES ('help_articles', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [{ items }]);
    await audit(req.user, "help_article_save", id, { title });
    res.json({ ok: true, id });
  }));
  api.post("/help-admin/question/:id(\\d+)/done", wrap(async (req, res) => {
    admin(req);
    await q("UPDATE help_questions SET done = true WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  }));
}

module.exports = { mount, DEFAULTS };
