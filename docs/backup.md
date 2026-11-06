# Backup และการกู้ระบบ

ระบบสร้าง backup ทุกคืน 01:30 และทดสอบ restore ทุกวันอาทิตย์ 03:15 ถ้าล้มเหลว ระบบแจ้ง Admin ทาง Telegram และ email ดูสถานะได้ที่ ตั้งค่า → Backup และทดสอบ restore

| ใน backup | ไม่อยู่ใน backup |
| --- | --- |
| ฐานข้อมูลทั้งหมด (เคส, Activity, ผู้ใช้, สิทธิ์, ค่าตั้ง, KPI, audit log) | `.env` (ค่าลับ) เก็บสำเนาเองใน password manager ของบริษัท |
| ไฟล์แนบจากลูกค้า (INTAKE_FILE_DIR) | ตัวโปรแกรม (อยู่ใน GitHub แล้ว) |

แต่ละ backup เป็นไฟล์เดียว `sino-case-YYYYMMDD-HHMMSS.scbk` เข้ารหัส AES-256-GCM ด้วย `BACKUP_KEY` เปิดดูได้เฉพาะคนที่มี key

## 1. ตั้งค่าครั้งแรกบน server (ทำครั้งเดียว)

```bash
cd ~/apps/case-v3

# 1) pg_dump ต้องมีบนเครื่อง และรุ่นต้องไม่ต่ำกว่าฐานข้อมูล
pg_dump --version

# 2) สร้าง BACKUP_KEY ลง .env โดยไม่แสดงค่าบนจอ
grep -q '^BACKUP_KEY=' .env || printf 'BACKUP_KEY=%s\n' "$(openssl rand -base64 30)" >> .env
chmod 600 .env

# 3) ให้ผู้ใช้ฐานข้อมูลของระบบสร้างฐานข้อมูลชั่วคราวได้ (ใช้ตอนทดสอบ restore)
#    ชื่อผู้ใช้คือส่วนหลัง postgres:// และก่อนเครื่องหมาย : ใน DATABASE_URL
sudo -u postgres psql -c 'ALTER ROLE case_app CREATEDB;'

pm2 restart case-v3
```

**สำคัญ: เก็บ BACKUP_KEY ไว้นอก server ทันที** ถ้า server เสียและไม่มี key ไฟล์ backup ทั้งหมดเปิดไม่ได้
เปิดดู key บนจอของคุณเองด้วย `grep '^BACKUP_KEY=' .env` แล้วบันทึกลง password manager ของบริษัท ห้ามส่งในแชตหรือ email

จากนั้นเข้า ตั้งค่า → Backup และทดสอบ restore แล้วกด "Backup ตอนนี้" ตามด้วย "ทดสอบ restore ตอนนี้" ต้องขึ้น "ทดสอบ restore ผ่าน" สีเขียว

- ขึ้น "ผ่านบางส่วน" = ข้อ 3 ยังไม่ได้ทำ ระบบตรวจได้แค่ว่าไฟล์อ่านได้และไม่เสียหาย
- ขึ้น "ไม่พบคำสั่ง pg_dump" = ติดตั้ง `postgresql-client-16` (รุ่นเดียวกับฐานข้อมูล) ถ้าฐานข้อมูลอยู่ใน Docker ให้ใส่ path ของ pg_dump / pg_restore ที่ใช้ได้ใน `.env` เป็น `BACKUP_PG_DUMP=` และ `BACKUP_PG_RESTORE=`
- ค่าที่ปรับได้ใน `.env`: `BACKUP_DIR` (ค่าเริ่มต้น `data/backups` ในโฟลเดอร์ app), `V3_BACKUP=0` ปิดงานอัตโนมัติทั้งหมด

## 2. เก็บสำเนานอกเครื่อง (แนะนำ)

backup ที่อยู่บน server เครื่องเดียวกันไม่ช่วยถ้าดิสก์พังหรือเครื่องหาย เลือกอย่างน้อย 1 ทาง

**ก. โฟลเดอร์ NAS หรือเครื่องอื่น** mount โฟลเดอร์นั้นบน server แล้วใส่ path เต็มในช่อง "คัดลอกไปโฟลเดอร์นอกเครื่องด้วย" ระบบลบไฟล์เก่าตามจำนวนวันที่ตั้งไว้ให้ด้วย

**ข. SharePoint** ใช้แอป Entra ตัวเดิม แต่จำกัดให้เขียนได้ site เดียว (ห้ามให้ Sites.ReadWrite.All หรือ Files.ReadWrite.All)

1. สร้าง SharePoint site (หรือใช้ site ที่มีอยู่) ที่ให้เฉพาะ IT เข้าได้
2. Entra → App registrations → แอประบบเคส → API permissions → Add → Microsoft Graph → Application → `Sites.Selected` → Grant admin consent
   (สิทธิ์นี้อย่างเดียวยังเข้า site ไหนไม่ได้เลย)
3. ใน Graph Explorer (login ด้วยบัญชี SharePoint admin) หา Site ID:
   `GET https://graph.microsoft.com/v1.0/sites/sinostech.sharepoint.com:/sites/<ชื่อ site>?$select=id`
4. ให้แอปเขียน site นั้นได้:
   `POST https://graph.microsoft.com/v1.0/sites/<Site ID>/permissions`
   ```json
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<Application (client) ID>", "displayName": "Sino Case SLA" } }] }
   ```
5. ใส่ Site ID ในหน้าตั้งค่า ติ๊ก "ส่งสำเนาขึ้น SharePoint ด้วย" บันทึก แล้วกด "Backup ตอนนี้"

ถ้าส่งสำเนาไม่สำเร็จ backup ในเครื่องยังอยู่ ระบบแจ้ง Admin พร้อมสาเหตุ

## 3. กู้ระบบลงเครื่องใหม่

ใช้เมื่อ server เดิมใช้ไม่ได้ ต้องมี: ไฟล์ `.scbk` ล่าสุด, BACKUP_KEY, สำเนา `.env` เดิม

```bash
# 1) ติดตั้ง Node 22, PostgreSQL 16, pm2 แล้ว clone โปรแกรม
git clone -b v3-web-input <repo> ~/apps/case-v3 && cd ~/apps/case-v3 && npm ci

# 2) คืน .env เดิม (มี BACKUP_KEY, DATABASE_URL, INTAKE_FILE_DIR) แล้ว chmod 600 .env

# 3) สร้างฐานข้อมูลว่าง ชื่อและผู้ใช้ตาม DATABASE_URL
sudo -u postgres psql -c "CREATE ROLE case_app LOGIN CREATEDB PASSWORD '<รหัสใน DATABASE_URL>';"
sudo -u postgres psql -c "CREATE DATABASE case_tracker OWNER case_app;"

# 4) ตรวจไฟล์ แล้ว restore (ฐานข้อมูลต้องว่าง ไม่งั้นระบบไม่ทำ)
node scripts/backup.js info /path/to/sino-case-YYYYMMDD-HHMMSS.scbk
node scripts/backup.js restore /path/to/sino-case-YYYYMMDD-HHMMSS.scbk --yes

# 5) เริ่มระบบ
pm2 start server-v3.js --name case-v3 && pm2 save
```

ถ้า INTAKE_FILE_DIR บนเครื่องใหม่ต่างจากเดิม ระบบปรับที่อยู่ไฟล์แนบในฐานข้อมูลให้เอง
ข้อมูลที่เกิดหลัง backup ล่าสุด (สูงสุดประมาณ 1 วัน) จะหาย email ลูกค้าที่ยังอยู่ในกล่อง service@ ระบบอ่านใหม่ได้ตามปกติ

## 4. ซ้อมกู้ระบบปีละครั้ง

การทดสอบรายสัปดาห์ restore ลงฐานข้อมูลชั่วคราวบนเครื่องเดิม แต่ไม่ได้ทดสอบว่าเครื่องใหม่ขึ้นระบบได้ ปีละครั้งให้ทำข้อ 3 บนเครื่องทดสอบ (หรือ VM) จาก backup ที่อยู่นอกเครื่อง แล้ว login ดูเคสล่าสุดว่าครบ

## คำสั่งอื่น

```bash
node scripts/backup.js run          # backup ทันที
node scripts/backup.js test         # ทดสอบ restore backup ล่าสุด
node scripts/backup.js list         # รายการไฟล์ backup
```
