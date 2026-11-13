// Role → permission matrix. Values: "all" | "own" | "none".
// Stored in settings.permissions so an admin can change it; these are the defaults.
const { getSetting, all, one } = require("./db");

const PERMS = [
  { key: "view", label: "ดูภาพรวมและรายการเคส", hint: "Dashboard, SLA runway, ราย User" },
  { key: "case_create", label: "เปิดเคสใหม่", hint: "Start date ถูกบันทึกอัตโนมัติ" },
  { key: "case_edit", label: "แก้ไขและอัปเดตเคส", hint: "Status, รายละเอียด, Activity" },
  { key: "case_close", label: "ปิดเคส", hint: "ระบบใส่ End date และหยุดแจ้งเตือน" },
  { key: "case_reassign", label: "เปลี่ยน User ของเคส", hint: "โอนเคสให้คนอื่น" },
  { key: "case_edit_start", label: "แก้ Start date", hint: "ต้องระบุเหตุผล บันทึกในประวัติ" },
  { key: "case_delete", label: "ลบเคส", hint: "ใช้กรณีบันทึกผิดหรือซ้ำ" },
  { key: "export", label: "Export Excel / CSV", hint: "ตามช่วงวันที่ที่เลือก" },
  { key: "reports_manage", label: "ส่ง Report และตั้งรอบส่ง", hint: "Report ให้ Manager ทาง email" },
  { key: "audit_view", label: "ดูประวัติแก้ไข", hint: "การแก้วันที่และการแก้เคสทั้งหมด" },
  { key: "users_manage", label: "จัดการผู้ใช้และรีเซ็ตรหัสผ่าน", hint: "เพิ่ม ปิดใช้งาน กำหนดบทบาท" },
  { key: "settings_manage", label: "ตั้งค่าระบบ", hint: "รายการ dropdown, การเก็บข้อมูล, รายงานรายปี" },
  { key: "sr_create", label: "ส่งคำขอบริการ (Service Request)", hint: "ขอให้ทีมอื่นทำงานให้ และติดตามคำขอของตัวเอง", binary: true },
  { key: "pm_manage", label: "ตั้งและแก้งาน PM ตามรอบ", hint: "เพิ่ม แก้ หยุด งาน PM, แบบฟอร์ม MA, เปิดเคสรอบนี้เลย", binary: true, perUser: true },
  { key: "hotline_edit", label: "แก้เบอร์ Hotline", hint: "เบอร์ใน email ตอบลูกค้าที่แจ้งเคสนอกเวลาทำการ", perUser: true },
];

const ROLES = ["admin", "manager", "observer", "engineer", "viewer"];
// Observer: sees all teams and all pages (KPI, reports, history) but can never change data.
const OBSERVER_LOCKED = ["case_create", "case_edit", "case_close", "case_reassign", "case_edit_start", "case_delete", "reports_manage", "users_manage", "settings_manage", "hotline_edit", "pm_manage"];
/** Roles that see every team without being a member. */
// Viewer: read-only, every team (no export / KPI / editing by default).
const seesAllTeams = (user) => !!user && (user.role === "admin" || user.role === "observer" || user.role === "viewer");

const DEFAULTS = {
  admin: Object.fromEntries(PERMS.map((p) => [p.key, "all"])),
  manager: {
    view: "all", case_create: "all", case_edit: "all", case_close: "all", case_reassign: "all",
    case_edit_start: "none", case_delete: "none", export: "all", reports_manage: "all",
    audit_view: "all", users_manage: "none", settings_manage: "none", hotline_edit: "all", sr_create: "all", pm_manage: "all",
  },
  engineer: {
    view: "all", case_create: "all", case_edit: "own", case_close: "own", case_reassign: "none",
    case_edit_start: "none", case_delete: "none", export: "own", reports_manage: "none",
    audit_view: "own", users_manage: "none", settings_manage: "none", sr_create: "all", pm_manage: "none",
  },
  observer: {
    view: "all", case_create: "none", case_edit: "none", case_close: "none", case_reassign: "none",
    case_edit_start: "none", case_delete: "none", export: "all", reports_manage: "none",
    audit_view: "all", users_manage: "none", settings_manage: "none", sr_create: "all", pm_manage: "none",
  },
  // Viewer: read-only on every team; exports cases (e.g. to send a customer their case list). No KPI.
  // They set up PM schedules (pm_manage; other users can be given it one by one). Sending service requests (sr_create) is off until an admin ticks it.
  viewer: {
    view: "all", case_create: "none", case_edit: "none", case_close: "none", case_reassign: "none",
    case_edit_start: "none", case_delete: "none", export: "all", reports_manage: "none",
    audit_view: "none", users_manage: "none", settings_manage: "none", sr_create: "none", pm_manage: "all",
  },
};

let cache = null;
let cacheAt = 0;
let grantCache = null;

/** Permissions that can also be given to named users on top of their role (PERMS entries with perUser). */
const PER_USER = PERMS.filter((p) => p.perUser).map((p) => p.key);
async function grants() {
  if (grantCache && Date.now() - cacheAt < 30000) return grantCache;
  const saved = (await getSetting("permission_users", null)) || {};
  grantCache = Object.fromEntries(PER_USER.map((k) => [k, (saved[k] || []).map(Number).filter(Boolean)]));
  return grantCache;
}

async function matrix() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const saved = (await getSetting("permissions", null)) || {};
  const m = {};
  for (const r of ROLES) m[r] = { ...DEFAULTS[r], ...(saved[r] || {}) };
  // Admin always keeps user and settings management, so the system can't lock itself out.
  m.admin.users_manage = "all";
  m.admin.settings_manage = "all";
  for (const p of OBSERVER_LOCKED) m.observer[p] = "none";
  cache = m;
  cacheAt = Date.now();
  return m;
}
function invalidate() {
  cache = null;
  grantCache = null;
}

/** Level of a permission for a user: "all" | "own" | "none". */
async function level(user, perm) {
  if (!user) return "none";
  const l = (await matrix())[user.role]?.[perm] || "none";
  if (l !== "all" && PER_USER.includes(perm) && !(user.role === "observer" && OBSERVER_LOCKED.includes(perm)) && (await grants())[perm].includes(Number(user.id))) return "all";
  return l;
}

/** The role's levels with this user's own grants applied (for the UI). */
async function forUser(user) {
  const out = { ...(await matrix())[user.role] };
  for (const k of PER_USER) out[k] = await level(user, k);
  return out;
}

/** Can `user` do `perm` on a case (or in general when no case given)? */
async function can(user, perm, kase) {
  const l = await level(user, perm);
  if (l === "all") return true;
  if (l === "own") return kase ? kase.owner_id === user.id : true;
  return false;
}

// ---- Team scope: managers (and engineers) see and assign only people of their own teams; admin / observer see everyone.
/** Teams `user` works in, or null when they see every team. */
const teamScope = (user) => (seesAllTeams(user) ? null : user.teams || []);
/** Ids of active users who share a team with `user` (always includes `user`), or null = everyone. */
async function teamMateIds(user) {
  const t = teamScope(user);
  if (!t) return null;
  const rows = await all("SELECT DISTINCT user_id FROM user_teams WHERE team = ANY($1)", [t]);
  return new Set([user.id, ...rows.map((r) => r.user_id)]);
}
/** Is user `id` a member of `team`? */
async function inTeam(id, team) {
  return !!(await one("SELECT 1 FROM user_teams WHERE user_id = $1 AND team = $2", [Number(id), team]));
}
/** Throws 403 unless `user` may give work in `team` to user `ownerId`: the team must be theirs and the owner a member of it. */
async function checkAssign(user, team, ownerId) {
  const t = teamScope(user);
  if (!t) return;
  if (!t.includes(team)) throw Object.assign(new Error("มอบหมายงานได้เฉพาะในทีมของคุณ"), { status: 403 });
  if (Number(ownerId) !== user.id && !(await inTeam(ownerId, team))) throw Object.assign(new Error("เลือก User จากสมาชิกทีมนี้ (ผู้ใช้นี้ไม่ได้อยู่ในทีม)"), { status: 403 });
}

module.exports = { PERMS, ROLES, DEFAULTS, OBSERVER_LOCKED, PER_USER, seesAllTeams, teamScope, teamMateIds, inTeam, checkAssign, matrix, grants, forUser, level, can, invalidate };
