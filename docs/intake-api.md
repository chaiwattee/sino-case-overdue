# Sino Case SLA: API สำหรับแชทบอท LINE OA

เอกสารนี้สำหรับทีมที่ดูแลแชทบอท LINE OA ใช้เชื่อมกับระบบรับแจ้งเคสของ Sino Case SLA

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

Admin ใส่ URL (https) ที่หน้า ตั้งค่า → LINE OA และ API ระบบส่ง `POST` JSON และลองส่งซ้ำสูงสุด 8 ครั้งถ้าไม่ได้ HTTP 2xx

Headers
- `X-Sino-Event`: `case.claimed` หรือ `intake.closed`
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
  "owner": { "name": "ภาณุวัฒน์ ทูวาศิน" },
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
