# Sino Case Tracker (sino-case-overdue v2)

อ่าน tab **Case List** จาก 3 เอกสารใน SharePoint (engageteam) แล้ว

- ส่ง **email แจ้งเตือนถึง Owner** (CC `engineer@sinostech.co.th`) เมื่อเคสเปิดครบ **วันที่ 3**, **วันที่ 6** และ **ทุกวันหลังเกิน Due** จนกว่าจะปิดเคส
  (Due = Start date + 7 วัน, สถานะที่นับว่าปิด: Success, Cancel, N/A, Resolved)
- **ตรวจจับการแก้ Start date / Target date** ทุก 15 นาที → บันทึก log, แจ้ง engineer@ ทาง email และ Telegram
- **หน้าเว็บ Dashboard**: ภาพรวม, drill-down ราย Owner, Report & Export, ประวัติแก้ไขวันที่
- **Report ให้ Manager** ทาง email ตามรอบที่ตั้งบนหน้าเว็บ (รายวัน/สัปดาห์/เดือน) + ส่งหรือ export เองตามช่วงวันที่ (Excel / CSV)
- **Telegram** เหลือไว้ส่งสรุปภาพรวมประจำวัน (+ไฟล์ Excel เคสที่เปิดอยู่)

| เอกสาร | ไฟล์ | Item ID |
|---|---|---|
| Engage / NRX / CXone | ENGAGE_Engineer_Case_2026.xlsx | 01UECOVNA3CW3DHKJHMRDJ5T5MOYHMWTJ5 |
| Nexidia | NEXIDIA_Engineer_Case_2026 .xlsx | 01UECOVNHFEOPZ3565SFB2BAGI3YWRYY2C |
| WFM | WFM_Engineer_Case_2026 .xlsx | 01UECOVNACJWMEUG3FNJGJ75SXXKVR2NZB |

## ตารางเวลา (เวลาไทย, รันในตัวโปรแกรม ไม่ต้องใช้ cron-job.org แล้ว)

| งาน | เวลา |
|---|---|
| Sync ข้อมูล + ตรวจการแก้วันที่ | ทุก 15 นาที |
| Email แจ้งเตือน Owner | 08:00 ทุกวัน |
| Telegram สรุปภาพรวม | 08:05 ทุกวัน |
| Report ให้ Manager | ตามที่ตั้งบนหน้า Report (เช็คทุก 5 นาที) |

## ติดตั้งบน engsrv-mailreader

### 1. Azure app registration (ตัวเดิม)
เพิ่ม Application permission **Mail.Send** แล้วกด *Grant admin consent* (ต้องให้ IT/admin ของ tenant ทำ)
แนะนำให้จำกัดให้ส่งได้เฉพาะ mailbox ที่ใช้ ด้วย Exchange `New-ApplicationAccessPolicy`

### 2. Supabase
เปิด SQL Editor ของโปรเจกต์ `bbofkhxjafgljsbtcyrp` แล้วรัน `sql/001_case_list_v2.sql`
(สร้างตารางใหม่ชื่อขึ้นต้นด้วย `cl_` ไม่แตะตารางเดิม)

### 3. วางโค้ดและ .env
```bash
cd /home/chaiwat/apps/sino-case-overdue
git fetch && git checkout v2-email-dashboard   # หรือแตก zip ทับ
npm install
cp .env.example .env    # เติมค่าจาก .env เดิม + MAIL_SENDER, DASHBOARD_USER/PASS
```

### 4. ทดสอบก่อนส่งจริง (`DRY_RUN_EMAIL=1` ใน .env)
```bash
pm2 delete case-overdue
pm2 start server.js --name case-overdue --node-args="--env-file=.env"
pm2 save
curl "http://localhost:3001/debug?secret=$RUN_SECRET"            # ต้องเห็น sourcedocMatches: true ทั้ง 3 ไฟล์
curl "http://localhost:3001/run-alerts?dry=1&secret=$RUN_SECRET"  # ดูว่าจะส่งเคสไหนบ้าง (ยังไม่ส่ง)
```
ดู log ด้วย `pm2 logs case-overdue` — ตอน dry run จะขึ้น `[DRY RUN email] ...` แทนการส่งจริง
เมื่อพร้อม เปลี่ยน `DRY_RUN_EMAIL=0` แล้ว `pm2 restart case-overdue --update-env`

### 5. เปิดหน้าเว็บผ่าน Cloudflare Named Tunnel
เพิ่ม hostname ใน tunnel ที่มีอยู่ (`~/.cloudflared/config.yml`) ไว้**ก่อน**บรรทัด `http_status:404`
```yaml
  - hostname: case.baanpin.com
    service: http://localhost:3001
```
```bash
cloudflared tunnel route dns cwa-acc case.baanpin.com
pm2 restart <ชื่อ process ของ tunnel>
```
แล้วตั้ง `DASHBOARD_URL=https://case.baanpin.com` · หน้าเว็บถาม user/pass ตาม `DASHBOARD_USER` / `DASHBOARD_PASS`

### 6. ปิดงาน cron-job.org เดิม
ตัว `/run-check` เดิมยังใช้ได้ (ตอนนี้แปลว่า "ส่ง email แจ้งเตือน") แต่ระบบตั้งเวลาเองแล้ว ให้ปิด job เดิมเพื่อไม่ให้ซ้ำซ้อน

## Endpoint สำหรับรันเอง (ต้องใส่ `?secret=RUN_SECRET`)
- `/run-alerts` ส่งแจ้งเตือนตอนนี้ (`&dry=1` = ดูอย่างเดียว) — `/run-check` ทำแบบเดียวกัน
- `/run-telegram` ส่งสรุป Telegram ตอนนี้
- `/run-reports` ส่ง report ที่ถึงรอบ
- `/debug` เช็คการเข้าถึงไฟล์ทั้ง 3

## ทดลองบนเครื่องตัวเองด้วยข้อมูลจำลอง
```bash
npm install && npm run mock     # http://localhost:3001  (ไม่ต่อ Microsoft 365, ไม่ส่ง email จริง)
npm test
```

## หมายเหตุ
- ระบบไม่ส่งซ้ำ: รอบ 1 และรอบ 2 ส่งครั้งเดียวต่อเคส, เกิน Due ส่งวันละครั้ง (บันทึกใน `cl_alert_log`) ถ้าส่งไม่สำเร็จจะลองใหม่รอบถัดไป
- ถ้าแถวไหนไม่มี Owner Email จะส่งไปที่ engineer@ แทน พร้อมหัวข้อ `[ไม่พบอีเมล Owner]`
- "แก้ไฟล์ล่าสุดโดย" ใน log การแก้วันที่ มาจาก lastModifiedBy ของทั้งไฟล์ ถ้ามีหลายคนแก้ในช่วง 15 นาทีเดียวกันอาจไม่ใช่คนที่แก้แถวนั้นจริง
- ถ้า Target date ในไฟล์ไม่ตรงกับ Start date + 7 หน้าเว็บจะขึ้นเตือนในคอลัมน์ Due แต่ระบบยึด Start date + 7 เป็นหลัก
