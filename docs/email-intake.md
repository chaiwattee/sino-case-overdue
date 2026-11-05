# รับแจ้งเคสทาง Email (service@sinostech.co.th)

ลูกค้าส่ง email ถึงกล่องรับแจ้งเคส ระบบอ่านทุก 2 นาที สร้างคำขอ REQ-ปี-เลขที่ และตอบกลับลูกค้าในเรื่องเดิมพร้อมเลขรับแจ้ง
คำขอเข้าหน้า "เคสจากลูกค้า" เหมือนคำขอจาก LINE OA ทีมรับเคสด้วยวิธีเดิม

## 1. สร้าง shared mailbox และจำกัดสิทธิ์แอป (Admin M365 ทำครั้งเดียว)

Shared mailbox ไม่ต้องใช้ license (เก็บได้ 50 GB) ใช้แอป Entra ตัวเดิมที่ระบบใช้ส่ง email
**ห้ามเพิ่ม Mail.Read / Mail.ReadWrite ในหน้า API permissions ของ Entra** เพราะจะอ่านได้ทุกกล่องในบริษัท ให้ใช้ RBAC for Applications ของ Exchange แทน

```powershell
# ถ้า Connect-ExchangeOnline โหลดไม่ขึ้น: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Connect-ExchangeOnline -UserPrincipalName <admin>@sinostech.co.th

New-Mailbox -Shared -Name "Sinostech Service" -DisplayName "Sinostech Service" -PrimarySmtpAddress service@sinostech.co.th
New-ManagementScope -Name "ServiceMailboxOnly" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'service@sinostech.co.th'"

# APP_ID = Application (client) ID ของแอประบบเคส, OBJECT_ID = Object ID ใน Enterprise applications (ไม่ใช่ App registrations)
New-ServicePrincipal -AppId <APP_ID> -ObjectId <OBJECT_ID> -DisplayName "Sino Case SLA"
New-ManagementRoleAssignment -App <APP_ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "ServiceMailboxOnly"
New-ManagementRoleAssignment -App <APP_ID> -Role "Application Mail.Send" -CustomResourceScope "ServiceMailboxOnly"

# ตรวจผล: Mail.ReadWrite และ Mail.Send ต้องขึ้น InScope = True
Test-ServicePrincipalAuthorization -Identity <APP_ID> -Resource service@sinostech.co.th
```

`New-ServicePrincipal` ขึ้นว่ามีอยู่แล้ว = เคยผูกไว้ ข้ามไปขั้นถัดไปได้
ถ้าเคยจำกัดสิทธิ์ส่ง email ของแอปด้วย ApplicationAccessPolicy (กลุ่มที่มีกล่องผู้ส่งแจ้งเตือน) ให้เพิ่ม service@ เข้ากลุ่มนั้นด้วย

ให้คนในทีมเปิดดูกล่องใน Outlook (ไม่จำเป็น):
```powershell
Add-MailboxPermission -Identity service@sinostech.co.th -User <name>@sinostech.co.th -AccessRights FullAccess
```

## 2. เปิดใช้ในระบบ

ตั้งค่า → รับแจ้งเคสจากลูกค้า: LINE OA, Email และ API → ส่วน "รับแจ้งเคสทาง Email"

1. ใส่โดเมน email ของลูกค้าที่รู้อยู่แล้วในตาราง "ลูกค้า" (เช่น KTB = `ktb.co.th`) ไม่ต้องครบทุกราย โดเมนที่ยังไม่ผูกก็รับเคสได้ (ดูข้อ 4 ด้านล่าง) โดเมน email ส่วนตัว (gmail.com ฯลฯ) ผูกไม่ได้
2. ใส่กล่องจดหมาย `service@sinostech.co.th` ติ๊ก "เปิดใช้" แล้วบันทึก
3. กด "อ่านกล่องตอนนี้" ถ้าขึ้น 403 / ErrorAccessDenied = สิทธิ์ขั้นที่ 1 ยังไม่ครบหรือยังไม่มีผล (รอได้ถึง 30 นาที)
4. ลองส่ง email จากบัญชีทดสอบของลูกค้า แล้วดูตาราง "email ล่าสุดที่ระบบอ่าน"

ระบบอ่านเฉพาะ email ที่เข้ามาหลังกดเปิดใช้ อ่านแล้วย้ายไปโฟลเดอร์ "Sino Case - ประมวลผลแล้ว" และลบออกจากกล่องเมื่อเก่ากว่าที่ตั้งไว้ (ค่าเริ่มต้น 365 วัน) เนื้อหาและไฟล์แนบยังอยู่ในคำขอ

## 3. กฎที่ระบบใช้

| email ที่เข้ามา | ผล |
| --- | --- |
| จากโดเมนลูกค้าที่ผูกไว้ เรื่องใหม่ | สร้างคำขอ แจ้งทีม ตอบลูกค้าพร้อมเลข REQ |
| หัวเรื่องมี `[REQ-…]` หรือหัวเรื่องเดิมจากผู้ส่งเดิมภายใน 3 วัน | เพิ่มในเรื่องเดิม ถ้ารับเคสแล้วบันทึกเป็น Activity ของเคสและแจ้ง Owner |
| โดเมนภายใน (@sinostech.co.th), out-of-office, noreply, mailer-daemon, จดหมายข่าว | ข้าม |
| โดเมนที่ยังไม่ผูก, email ส่วนตัว (Gmail ฯลฯ) | สร้างคำขอตามปกติ ตอบลูกค้าทันที (ช่อง Customer ใน email เขียนว่า "To be confirmed") คำขอติดป้าย "ลูกค้ายังไม่ยืนยัน" |
| ตอบกลับ email เก่าที่ไม่มีเลข REQ, ส่งถี่เกิน, ไม่ผ่าน SPF/DMARC | สร้างคำขอแต่พักไว้ให้ Admin / Manager ตรวจ ไม่ตอบลูกค้าจนกว่าจะกด "ยืนยันว่าเป็นเคสจริง" |

- ระบบเดา Severity และระบบ (Product) จากเนื้อหา ทีมแก้ได้ตอนรับเคส
- เมื่อรับเคส ระบบตอบลูกค้าในเรื่องเดิม หัวเรื่อง `[REQ-… → CASE-…]` และ CC Owner
- ปิดคำขอโดยไม่เปิดเคส ติ๊ก "ตอบ email แจ้งลูกค้าด้วย" ได้
- อ่านกล่องไม่ได้นานเกิน 30 นาที ระบบแจ้ง Admin ทาง Telegram และ email (ไม่เกินทุก 6 ชั่วโมง)
- ทดสอบโดยไม่ใช้กล่องจริง: ปุ่ม "จำลอง email เข้า" ในหน้าเดียวกัน

## 4. ลูกค้าที่ยังไม่ผูกโดเมน

1. Engineer กด "รับเคสเอง" ได้เลย ช่องลูกค้าเลือก "ยังไม่ทราบ ยืนยันภายหลังบนหน้าเคส" ได้ SLA เริ่มนับทันที
2. หน้าเคสมีแถบสีเหลือง "ลูกค้ายังไม่ยืนยัน" พร้อมชื่อ เบอร์ และ email ผู้แจ้ง โทรถามลูกค้าแล้วกด "ยืนยันลูกค้า"
3. Admin และ Manager ติ๊ก "จำโดเมน @… ไว้กับลูกค้ารายนี้" ได้ email ครั้งต่อไปจากโดเมนนั้นเข้าลูกค้ารายนั้นทันที (Engineer ไม่เห็นตัวเลือกนี้ email ส่วนตัวจำไม่ได้)
4. ดูเคสที่ยังไม่ยืนยันทั้งหมด: ค้นหาเคส → ปุ่ม "ลูกค้ายังไม่ยืนยัน"

ถ้าอยากให้พักไว้ก่อนแบบเดิม เปลี่ยน "email จากโดเมนที่ยังไม่ผูกกับลูกค้า" ในหน้าตั้งค่าเป็น "พักไว้ให้ Admin / Manager ตรวจ"
