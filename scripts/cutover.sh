#!/usr/bin/env bash
# One-time switch from v2 (Excel) to v3 (web input). Scheduled by cron for Sun 1 Nov 2026 20:00.
#   bash scripts/cutover.sh --check   # rehearsal: checks everything, changes nothing
#   bash scripts/cutover.sh           # the real run (normally started by cron)
# If the import or the history copy fails it stops BEFORE touching v2, so the old system keeps running.
set -uo pipefail
APP="$HOME/apps/case-v3"
cd "$APP" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/usr/local/bin:/usr/bin:/bin"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
LOG="$APP/cutover-$(date +%F-%H%M)$([ $CHECK = 1 ] && echo -check).log"
DONE="$APP/.cutover-done"
exec > >(tee -a "$LOG") 2>&1
notify() { node scripts/notify.js "$1" "$LOG" || true; }
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
step() { echo; echo "== $(date '+%F %T') $*"; }

if [ -f "$DONE" ] && [ $CHECK = 0 ]; then echo "cutover already done ($(cat "$DONE")), nothing to do"; exit 0; fi

step "checks"
ok=1
command -v node >/dev/null && echo "node $(node -v)" || { echo "node not found"; ok=0; }
command -v pm2  >/dev/null && echo "pm2 found" || { echo "pm2 not found"; ok=0; }
for k in DATABASE_URL BASE_URL RUN_SECRET TENANT_ID CLIENT_ID CLIENT_SECRET MAIL_SENDER; do
  [ -n "$(envval $k)" ] && echo "env $k: set" || { echo "env $k: MISSING"; ok=0; }
done
curl -s -m 10 http://127.0.0.1:3011/health | grep -q '"ok":true' && echo "v3 running" || { echo "v3 NOT responding on 3011"; ok=0; }
timeout 60 pm2 jlist 2>/dev/null | grep -q '"name":"case-overdue"' && echo "v2 (case-overdue) found in pm2" || echo "v2 not found in pm2 (will skip stopping it)"
if [ $ok = 0 ]; then notify "❌ ย้ายระบบ: ตรวจสอบก่อนเริ่มไม่ผ่าน ยังไม่ได้เปลี่ยนอะไร ระบบเดิมทำงานตามปกติ"; exit 1; fi

if [ $CHECK = 1 ]; then
  step "rehearsal: copy v2 history (dry run, no writes)"
  node scripts/migrate-v2-history.js || { notify "❌ ซ้อมย้ายระบบ: อ่านประวัติจากระบบเดิมไม่ได้"; exit 1; }
  step "rehearsal: alerts v3 would send now (dry run)"
  curl -s -m 60 "http://127.0.0.1:3011/run-alerts?dry=1&secret=$(envval RUN_SECRET)"; echo
  notify "✅ ซ้อมย้ายระบบผ่าน (ยังไม่ได้เปลี่ยนอะไร) จะย้ายจริงตามเวลาที่ตั้งไว้"
  exit 0
fi

step "1/5 final import from Excel"
node scripts/cutover-import.js || { notify "❌ ย้ายระบบไม่สำเร็จ: นำเข้าจาก Excel ล้มเหลว ระบบเดิมยังทำงานตามปกติ"; exit 1; }

step "2/5 copy v2 alert and date-change history"
node scripts/migrate-v2-history.js --apply || { notify "❌ ย้ายระบบไม่สำเร็จ: คัดลอกประวัติล้มเหลว ระบบเดิมยังทำงานตามปกติ"; exit 1; }

step "3/5 stop v2"
timeout 60 pm2 stop case-overdue || echo "warning: pm2 stop returned an error"
timeout 60 pm2 save || echo "warning: pm2 save returned an error"

step "4/5 turn on v3 alerts, Telegram and reports"
cp .env ".env.bak-cutover-$(date +%F-%H%M)"
for k in ALERTS TELEGRAM REPORTS; do
  if grep -q "^V3_$k=" .env; then sed -i -E "s/^V3_$k=.*/V3_$k=1/" .env; else echo "V3_$k=1" >> .env; fi
done
grep -E '^V3_(ALERTS|TELEGRAM|REPORTS)=' .env
timeout 90 pm2 restart case-v3 --update-env || echo "warning: pm2 restart returned an error"
timeout 60 pm2 save || true
for i in $(seq 1 20); do curl -s -m 5 http://127.0.0.1:3011/health | grep -q '"ok":true' && break; sleep 3; done
timeout 30 pm2 logs case-v3 --lines 5 --nostream 2>/dev/null | grep -a "jobs" || true

step "5/5 alerts v3 will send at the next run (dry run)"
curl -s -m 60 "http://127.0.0.1:3011/run-alerts?dry=1&secret=$(envval RUN_SECRET)"; echo

date '+%F %T' > "$DONE"
crontab -l 2>/dev/null | grep -v 'scripts/cutover.sh' | crontab - || true
notify "✅ ย้ายระบบเสร็จ: ใช้ $(envval BASE_URL) แทน Excel แล้ว ระบบเดิมหยุดทำงาน email แจ้งเตือนรอบถัดไปส่งจาก v3"
echo "done"
