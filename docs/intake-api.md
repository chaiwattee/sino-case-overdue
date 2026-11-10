# Sino Case SLA: API สำหรับแชทบอท LINE OA

เอกสารนี้สำหรับทีมที่ดูแลแชทบอท LINE OA ใช้เชื่อมกับระบบรับแจ้งเคสของ Sino Case SLA

## สิ่งที่ต้องแลกเปลี่ยนกัน

ฝั่ง Sino Case SLA ส่งให้ทีม LINE OA

| รายการ | ค่า / วิธีส่ง |
|---|---|
| Base URL ของ API | `https://case.sinostech.co.th:9443/api/v1` |
| API key ทดสอบ (`sk_test_...`) | สร้างจากหน้า ตั้งค่า · ส่งทางช่องทางปลอดภัย ห้ามส่งใน chat หรือ email ธรรมดา |
| API key ใช้งานจริง (`sk_live_...`) | ส่งหลังทดสอบผ่าน ด้วยช่องทางปลอดภัยเดียวกัน |
| Webhook secret (`whsec_...`) | ใช้ตรวจลายเซ็น webhook · ส่งด้วยช่องทางปลอดภัย แยกจาก API key |
| รายการ event และ payload | ตามเอกสารนี้ (`case.claimed`, `intake.closed`, `case.resolved`) |

ทีม LINE OA ส่งกลับมา

| รายการ | ใช้ทำอะไร |
|---|---|
| Webhook URL (https, port 443) สำหรับรับ event จากเรา | ใส่ในหน้า ตั้งค่า → LINE OA และ API |
| IP ขาออกของเซิร์ฟเวอร์แชทบอท | ล็อก API key ให้เรียกได้จาก IP นี้เท่านั้น |
| ยืนยันว่าเซิร์ฟเวอร์แชทบอทเรียก `case.sinostech.co.th` port **9443** ได้ | บางเครือข่ายปิด port ที่ไม่ใช่ 443 |
| `lineUserId` ที่ส่งมาเป็น userId จาก Messaging API ของ OA ตัวที่ใช้งานจริง | userId ต่างกันตาม Provider ถ้าเปลี่ยน OA/Provider ลูกค้าจะถูกมองเป็นคนใหม่ |
| ผู้ติดต่อฝั่งเทคนิค (ชื่อ, email) | แจ้งเมื่อ webhook ส่งไม่สำเร็จ หรือเปลี่ยน key |
| แพ็กเกจ LINE OA / โควตา push message | ข้อความแจ้งลูกค้าทุกครั้งเป็น push (ไม่ใช่ reply) จึงนับโควตา |

ฝั่งแชทบอทต้องทำ

1. เมนู (Rich menu) "แจ้งเคส" → เรียก `GET /intake/line-users/{lineUserId}` ถ้า `known = false` ถามชื่อบริษัท ชื่อผู้ติดต่อ เบอร์โทร
2. เรียก `POST /intake/links` แล้วส่งลิงก์ให้ลูกค้า (แนะนำ Flex message ปุ่ม "กรอกฟอร์มแจ้งเคส")
3. Endpoint รับ webhook: ตรวจลายเซ็น, ตอบ HTTP 2xx ภายใน 10 วินาที, กันประมวลผลซ้ำด้วย `id`
4. เมื่อได้ webhook ส่ง push message ถึง `lineUserId` (ใช้ `message` สำเร็จรูปได้เลย หรือทำ Flex เอง)
5. ข้าม event ที่ `lineUserId` เป็น `null` (ลูกค้าที่แจ้งทาง email หรือลิงก์ ไม่ใช่ LINE)

## ภาพรวม

1. ลูกค้ากดเมนู "แจ้งเคส" ใน LINE OA
2. ครั้งแรก แชทบอทถามชื่อบริษัท ชื่อผู้ติดต่อ และเบอร์โทร (ใช้ `GET /intake/customers/match` ช่วยยืนยันชื่อบริษัท)
3. แชทบอทเรียก `POST /intake/links` ได้ลิงก์ฟอร์มที่ใช้ได้ครั้งเดียว แล้วส่งให้ลูกค้า (เช่น Flex message ปุ่ม "กรอกฟอร์มแจ้งเคส")
4. ลูกค้ากรอกฟอร์มบนเว็บของเรา ได้เลขรับแจ้ง เช่น `REQ-2026-0012`
5. เมื่อมี Engineer รับเคส ระบบส่ง webhook `case.claimed` ไปที่แชทบอท ให้แชทบอทส่งข้อความ LINE (push) ถึงลูกค้า

ครั้งต่อไป แชทบอทไม่ต้องถามชื่อบริษัทซ้ำ เรียก `POST /intake/links` ด้วย `lineUserId` อย่างเดียวได้ ระบบจำบริษัทและผู้ติดต่อไว้แล้ว

## การยืนยันตัวตน

- Base URL: `https://case.sinostech.co.th:9443/api/v1`
- ทุกคำขอต้องมี header `X-Api-Key: sk_live_...` (Admin สร้างได้ที่ ตั้งค่า → รับแจ้งเคสจากลูกค้า: LINE OA และ API)
- ระหว่างทดสอบใช้ key `sk_test_...` เคสที่สร้างจะติดป้าย "ทดสอบ" และแจ้งเตือนเฉพาะผู้รับทดสอบ
- จำกัด IP ได้ต่อ key

## POST /intake/links

ขอลิงก์ฟอร์มที่ใช้ได้ครั้งเดียว (ค่าเริ่มต้นหมดอายุใน 60 นาที)

```http
POST /api/v1/intake/links
X-Api-Key: sk_live_xxx
Content-Type: application/json

{
  "lineUserId": "U4af4980629...",      // แนะนำให้ส่งทุกครั้ง ใช้จำลูกค้า
  "lineDisplayName": "Somying",          // ไม่บังคับ
  "customer": "กรุงไทย",                 // ชื่อบริษัทที่ลูกค้าพิมพ์ ไม่ต้องส่งถ้าเคยส่งแล้ว
  "contactName": "สมหญิง ใจดี",          // ไม่บังคับ แสดงในฟอร์มให้แก้ได้
  "contactPhone": "081-234-5678",       // ไม่บังคับ
  "externalRef": "chat-88123"           // ไม่บังคับ ส่งกลับใน webhook
}
```

ตอบกลับ

```json
{
  "ok": true,
  "url": "https://case.sinostech.co.th:9443/r/9fK2...pQ",
  "expiresAt": "2026-11-03T03:32:00.000Z",
  "customer": { "matched": true, "site": "KTB" },
  "test": false
}
```

- `customer.matched = false`: ชื่อไม่ตรงกับลูกค้าในระบบ ลิงก์ยังใช้ได้ เคสจะติดป้าย "ลูกค้าใหม่ รอ Admin ยืนยัน"
- ข้อผิดพลาด: `401 NO_KEY / BAD_KEY`, `403 IP_NOT_ALLOWED`, `403 LINE_BLOCKED` (Admin บล็อกบัญชี LINE นี้), `429 RATE_LIMIT_LINE` (ขอเกิน 3 ครั้งต่อชั่วโมงต่อ LINE), `429 RATE_LIMIT_KEY`
- ทุก error ตอบเป็น `{ "ok": false, "error": "English message you can show the customer", "code": "..." }`

## GET /intake/customers/match?q=กรุงไทย

```json
{ "q": "กรุงไทย", "match": { "name": "KTB" } }
```

`match` เป็น `null` เมื่อไม่พบ ใช้ถามลูกค้ายืนยัน เช่น "หมายถึง KTB ใช่ไหม"

## GET /intake/customers

รายชื่อลูกค้าและชื่อเรียกอื่น `{ "customers": [{ "name": "KTB", "aliases": ["กรุงไทย", "Krungthai"] }] }`

## GET /intake/line-users/{lineUserId}

```json
{ "known": true, "blocked": false, "customer": "KTB", "contactName": "สมหญิง ใจดี", "contactPhone": "081-234-5678" }
```

ใช้ตัดสินว่าต้องถามชื่อบริษัทหรือไม่ (`known = false` ให้ถาม)

## Webhook ถึงแชทบอท

Admin ใส่ URL (https) ที่หน้า ตั้งค่า → LINE OA และ API ระบบส่ง `POST` JSON

- ต้องตอบ HTTP 2xx ภายใน 10 วินาที ไม่ตามการ redirect (3xx นับว่าไม่สำเร็จ)
- ไม่สำเร็จจะลองส่งซ้ำแบบเว้นระยะ (2, 4, 8 … สูงสุด 240 นาที) รวมไม่เกิน 8 ครั้ง Admin กดส่งซ้ำเองได้
- event จาก API key ทดสอบมี `"test": true` ส่งไป URL เดียวกัน ให้แชทบอทแยกได้
- แนะนำให้ปฏิเสธคำขอที่ `X-Sino-Timestamp` ห่างจากเวลาปัจจุบันเกิน 5 นาที เพื่อกันคนอื่นนำคำขอเก่ามาส่งซ้ำ

Headers
- `X-Sino-Event`: `case.claimed`, `intake.closed` หรือ `case.resolved`
- `X-Sino-Timestamp`: unix seconds
- `X-Sino-Signature`: `sha256=` + HMAC-SHA256(webhook secret, `timestamp + "." + raw body`) เป็น hex

ตัวอย่างตรวจลายเซ็น (Node.js)

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(req.headers["x-sino-timestamp"] + "." + rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-sino-signature"]));
```

### case.claimed (ส่งข้อความ LINE ถึงลูกค้า)

```json
{
  "id": 41,
  "event": "case.claimed",
  "test": false,
  "reqNo": "REQ-2026-0012",
  "caseId": 812,
  "caseNo": "CASE-2026-0042",
  "csNumber": "CS5056901",
  "customer": "KTB",
  "subject": "Agent login เข้าระบบไม่ได้",
  "severity": "Critical",
  "owner": { "name": "ภาณุวัฒน์ ทูวาศิน", "phone": "08x-xxx-xxxx", "email": "engineer@sinostech.co.th" },
  "claimedAt": "2026-11-03T02:46:00.000Z",
  "lineUserId": "U4af4980629...",
  "externalRef": "chat-88123",
  "contact": { "name": "สมหญิง ใจดี", "phone": "081-234-5678" },
  "updateUrl": "https://case.sinostech.co.th:9443/u/c-Xy...",
  "message": "An engineer has taken your case.\nREQ-2026-0012 → CASE-2026-0042\nAgent login เข้าระบบไม่ได้\n\nEngineer: ภาณุวัฒน์ ทูวาศิน\nWe will contact you at 081-234-5678\n\nAdd details or screenshots: https://case.sinostech.co.th:9443/u/c-Xy..."
}
```

`message` เป็นข้อความสำเร็จรูปภาษาอังกฤษ ส่งให้ลูกค้าได้เลย หรือใช้ฟิลด์อื่นสร้าง Flex message เอง · `updateUrl` คือลิงก์ "Add details / screenshots" ของเคสนี้ ใช้ทำปุ่มให้ลูกค้าเพิ่มข้อมูลและรูปได้จนเคสปิด + 7 วัน

### intake.closed

ทีมปิดคำขอโดยไม่เปิดเคส (ซ้ำหรือไม่ใช่เคส) ส่งข้อความถึงลูกค้าเฉพาะเมื่อ `notifyCustomer = true`

```json
{ "id": 42, "event": "intake.closed", "reqNo": "REQ-2026-0013", "reason": "ซ้ำกับ REQ-2026-0012", "notifyCustomer": true, "lineUserId": "U4af...", "externalRef": "chat-88124", "message": "Your request REQ-2026-0013 is about the same issue as REQ-2026-0012, which we are already working on. We will follow up there." }
```

### case.resolved (เคสเสร็จ + แบบสอบถามความพึงพอใจ)

ส่งเมื่อ Engineer ปิดเคส ให้แชทบอทส่งข้อความพร้อมลิงก์ให้คะแนน 1–5 (ลิงก์ใช้ได้ 14 วัน)

```json
{
  "id": 57,
  "event": "case.resolved",
  "test": false,
  "reqNo": "REQ-2026-0012",
  "caseId": 812,
  "caseNo": "CASE-2026-0042",
  "customer": "KTB",
  "subject": "Agent login เข้าระบบไม่ได้",
  "resolution": "แก้ไข config SSO แล้ว ทดสอบ login ผ่าน",
  "owner": { "name": "ภาณุวัฒน์ ทูวาศิน" },
  "lineUserId": "U4af4980629...",
  "externalRef": "chat-88123",
  "surveyUrl": "https://case.sinostech.co.th:9443/csat/Ab3...",
  "message": "Your case REQ-2026-0012 (CASE-2026-0042) has been resolved. How satisfied are you with our support? Rate us 1–5: https://case.sinostech.co.th:9443/csat/Ab3..."
}
```

แนะนำทำ Flex message มีปุ่ม 1–5 หรือปุ่มเดียว "ให้คะแนน" เปิด `surveyUrl`

`id` ไม่ซ้ำกัน ใช้กันการประมวลผลซ้ำเมื่อระบบส่งซ้ำ

## ทดสอบก่อน LINE OA พร้อม

- หน้า ตั้งค่า → LINE OA และ API มี "จำลองแชทบอท" เรียก API เดียวกันและเปิดฟอร์มได้ทันที
- ยังไม่ตั้ง webhook URL ระบบเก็บเหตุการณ์ไว้ให้ดูในตาราง "เหตุการณ์ที่ส่งให้แชทบอท" (กด JSON ดู payload)
- ทดสอบด้วย curl

```bash
curl -X POST https://case.sinostech.co.th:9443/api/v1/intake/links \
  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"customer":"กรุงไทย","lineUserId":"Utest1","contactName":"ทดสอบ","contactPhone":"080-000-0000"}'
```
