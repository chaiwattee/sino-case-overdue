// Role → permission matrix. Values: "all" | "own" | "none".
// Stored in settings.permissions so an admin can change it; these are the defaults.
const { getSetting } = require("./db");

const PERMS = [
  { key: "view", label: "ดูภาพรวมและรายการเคส", hint: "Dashboard, SLA runway, ราย Owner" },
  { key: "case_create", label: "เปิดเคสใหม่", hint: "Start date ถูกบันทึกอัตโนมัติ" },
  { key: "case_edit", label: "แก้ไขและอัปเดตเคส", hint: "Status, รายละเอียด, Activity" },
  { key: "case_close", label: "ปิดเคส", hint: "ระบบใส่ End date และหยุดแจ้งเตือน" },
  { key: "case_reassign", label: "เปลี่ยน Owner ของเคส", hint: "โอนเคสให้คนอื่น" },
  { key: "case_edit_start", label: "แก้ Start date", hint: "ต้องระบุเหตุผล บันทึกในประวัติ" },
  { key: "case_delete", label: "ลบเคส", hint: "ใช้กรณีบันทึกผิดหรือซ้ำ" },
  { key: "export", label: "Export Excel / CSV", hint: "ตามช่วงวันที่ที่เลือก" },
  { key: "reports_manage", label: "ส่ง Report และตั้งรอบส่ง", hint: "Report ให้ Manager ทาง email" },
  { key: "audit_view", label: "ดูประวัติแก้ไข", hint: "การแก้วันที่และการแก้เคสทั้งหมด" },
  { key: "users_manage", label: "จัดการผู้ใช้และรีเซ็ตรหัสผ่าน", hint: "เพิ่ม ปิดใช้งาน กำหนดบทบาท" },
  { key: "settings_manage", label: "ตั้งค่าระบบ", hint: "รายการ dropdown, การเก็บข้อมูล, รายงานรายปี" },
];

const ROLES = ["admin", "manager", "engineer", "viewer"];

const DEFAULTS = {
  admin: Object.fromEntries(PERMS.map((p) => [p.key, "all"])),
  manager: {
    view: "all", case_create: "all", case_edit: "all", case_close: "all", case_reassign: "all",
    case_edit_start: "none", case_delete: "none", export: "all", reports_manage: "all",
    audit_view: "all", users_manage: "none", settings_manage: "none",
  },
  engineer: {
    view: "all", case_create: "all", case_edit: "own", case_close: "own", case_reassign: "none",
    case_edit_start: "none", case_delete: "none", export: "own", reports_manage: "none",
    audit_view: "own", users_manage: "none", settings_manage: "none",
  },
  viewer: {
    view: "all", case_create: "none", case_edit: "none", case_close: "none", case_reassign: "none",
    case_edit_start: "none", case_delete: "none", export: "none", reports_manage: "none",
    audit_view: "none", users_manage: "none", settings_manage: "none",
  },
};

let cache = null;
let cacheAt = 0;

async function matrix() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const saved = (await getSetting("permissions", null)) || {};
  const m = {};
  for (const r of ROLES) m[r] = { ...DEFAULTS[r], ...(saved[r] || {}) };
  // Admin always keeps user and settings management, so the system can't lock itself out.
  m.admin.users_manage = "all";
  m.admin.settings_manage = "all";
  cache = m;
  cacheAt = Date.now();
  return m;
}
function invalidate() {
  cache = null;
}

/** Level of a permission for a user: "all" | "own" | "none". */
async function level(user, perm) {
  if (!user) return "none";
  return (await matrix())[user.role]?.[perm] || "none";
}

/** Can `user` do `perm` on a case (or in general when no case given)? */
async function can(user, perm, kase) {
  const l = await level(user, perm);
  if (l === "all") return true;
  if (l === "own") return kase ? kase.owner_id === user.id : true;
  return false;
}

module.exports = { PERMS, ROLES, DEFAULTS, matrix, level, can, invalidate };
