// Cases stored in PostgreSQL. Rows are turned into the same "case object" shape the
// v2 code (withStage, emails, reports, telegram) already works with.
const { config } = require("../config");
const { config3 } = require("./config3");
const { withStage, isClosed } = require("../cases");
const d = require("../dates");
const { q, one, all, tx } = require("./db");

const CASE_SELECT = `
  SELECT c.*, t.label AS team_label, u.display_name AS owner_name, u.email AS owner_email,
         (SELECT a.detail FROM case_activities a WHERE a.case_id = c.id AND NOT a.is_system
           ORDER BY a.activity_date DESC, a.id DESC LIMIT 1) AS last_activity,
         (SELECT max(a.created_at) FROM case_activities a WHERE a.case_id = c.id) AS last_activity_at
  FROM cases c
  JOIN teams t ON t.code = c.team
  LEFT JOIN users u ON u.id = c.owner_id`;

const SEVERITIES = ["Critical", "High", "Medium", "Low", "Request information"];
const severityOf = (v) => SEVERITIES.find((x) => x.toLowerCase() === String(v || "").trim().toLowerCase()) || null;

function toCase(r) {
  const base = {
    key: `v3:${r.id}`,
    id: r.id,
    owner_id: r.owner_id,
    team: r.team,
    source: r.team,
    sourceLabel: r.team_label,
    rowNumber: r.id,
    no: String(r.id),
    status: r.status || "",
    site: r.site || "",
    owner: r.owner_name || "",
    ownerEmail: (r.owner_email || "").toLowerCase(),
    product: r.product || "",
    severity: r.severity || "",
    csNumber: r.cs_number || "",
    task: r.task || "",
    detail: r.last_activity || "",
    note: r.note || "",
    startDate: d.fromISODate(r.start_date),
    targetDate: d.fromISODate(r.due_date),
    endDate: d.fromISODate(r.end_date),
    startAt: r.start_at,
    updatedAt: r.last_activity_at && r.last_activity_at > r.updated_at ? r.last_activity_at : r.updated_at,
    caseUrl: `${config3.baseUrl}/#/case/${r.id}`,
    fileUrl: `${config3.baseUrl}/#/case/${r.id}`,
  };
  const c = withStage(base);
  c.closedAt = c.endDate;
  return c;
}

/** Cases visible to `user` (admin: all, others: their teams). Pass user=null for system jobs. */
async function loadCases(user, { where = "", params = [] } = {}) {
  const cond = [];
  const p = [...params];
  if (user && user.role !== "admin") {
    p.push(user.teams || []);
    cond.push(`c.team = ANY($${p.length})`);
  }
  if (where) cond.push(where);
  const rows = await all(`${CASE_SELECT} ${cond.length ? "WHERE " + cond.join(" AND ") : ""} ORDER BY c.start_date, c.id`, p);
  return rows.map(toCase);
}

async function getCase(id) {
  const r = await one(`${CASE_SELECT} WHERE c.id = $1`, [id]);
  return r ? toCase(r) : null;
}

function canSee(user, c) {
  return user.role === "admin" || (user.teams || []).includes(c.team);
}

async function activities(caseId) {
  return all(
    `SELECT a.id, a.activity_date, a.kind, a.detail, a.is_system, a.created_at, u.display_name AS by
     FROM case_activities a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.case_id = $1 ORDER BY a.activity_date DESC, a.id DESC`,
    [caseId]
  );
}

async function addActivity(client, caseId, user, { date, kind, detail, system = false }) {
  await client.query(
    "INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [caseId, date || d.toISODate(d.today()), kind, detail, system, user?.id || null]
  );
}

/** Make sure a site/product value exists in the dropdown; new ones are flagged for admin review. */
async function ensureLookup(client, kind, value, user) {
  const v = String(value || "").trim();
  if (!v) return null;
  const r = await client.query(
    `INSERT INTO lookups (kind, value, is_new, created_by, sort)
     VALUES ($1, $2, true, $3, 1000) ON CONFLICT (kind, lower(value)) DO NOTHING RETURNING id`,
    [kind, v, user?.id || null]
  );
  const existing = (await client.query("SELECT value FROM lookups WHERE kind=$1 AND lower(value)=lower($2)", [kind, v])).rows[0];
  return { value: existing ? existing.value : v, created: r.rowCount > 0 };
}

async function logChange(client, kase, user, field, oldV, newV, reason) {
  let direction = null;
  if (field === "start_date") {
    direction = !oldV && newV ? "set" : oldV && !newV ? "cleared" : newV > oldV ? "later" : "earlier";
  }
  await client.query(
    `INSERT INTO case_changes (case_id, cs_number, team, site, owner_name, owner_email, field, old_value, new_value,
       direction, reason, changed_by, changed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [kase.id, kase.csNumber || null, kase.team, kase.site, kase.owner, kase.ownerEmail, field, oldV, newV, direction,
      reason || null, user?.id || null, user?.display_name || "system"]
  );
}

const clean = (s, max = 2000) => (s === undefined || s === null ? null : String(s).trim().slice(0, max));

async function createCase(user, body, { ownerId, startDate } = {}) {
  const today = d.today();
  const start = startDate ? d.fromISODate(startDate) : today;
  const due = d.addDays(start, config.slaDays);
  return tx(async (c) => {
    const site = await ensureLookup(c, "site", body.site, user);
    if (body.product) await ensureLookup(c, "product", body.product, user);
    const status = clean(body.status, 40) || "In Progress";
    const closed = config.closedStatuses.includes(status.toLowerCase());
    const r = await c.query(
      `INSERT INTO cases (team, cs_number, status, site, product, owner_id, task, note, start_date, due_date, end_date,
         closed_at, created_by, legacy_key, start_at, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15, now()), COALESCE($16, 'High')) RETURNING id`,
      [body.team, clean(body.cs_number, 60), status, site.value, clean(body.product, 60), ownerId || user?.id,
        clean(body.task, 300), clean(body.note), d.toISODate(start), d.toISODate(due),
        closed ? d.toISODate(body.end_date ? d.fromISODate(body.end_date) : today) : null, closed ? new Date() : null,
        user?.id || null, body.legacy_key || null, body.start_at || null, severityOf(body.severity)]
    );
    const id = r.rows[0].id;
    await addActivity(c, id, user, { date: d.toISODate(start), kind: "เปิดเคส", detail: clean(body.detail) || "เปิดเคส", system: !body.detail });
    return { id, newSite: site.created ? site.value : null };
  });
}

/** Update editable fields. Returns list of changed field names. */
async function updateCase(user, kase, body, { allowReassign }) {
  return tx(async (c) => {
    const sets = [];
    const vals = [];
    const changed = [];
    const set = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
      changed.push(col);
    };
    let newSite = null;
    if (body.site !== undefined && clean(body.site) && clean(body.site) !== kase.site) {
      const s = await ensureLookup(c, "site", body.site, user);
      if (s.created) newSite = s.value;
      set("site", s.value);
    }
    if (body.product !== undefined && clean(body.product) !== (kase.product || null)) {
      if (body.product) await ensureLookup(c, "product", body.product, user);
      set("product", clean(body.product, 60));
    }
    if (body.severity !== undefined) {
      const sev = severityOf(body.severity);
      if (!sev) throw Object.assign(new Error("Severity ไม่ถูกต้อง"), { status: 400 });
      if (sev !== kase.severity) {
        set("severity", sev);
        await logChange(c, kase, user, "severity", kase.severity || null, sev);
      }
    }
    if (body.cs_number !== undefined && clean(body.cs_number, 60) !== (kase.csNumber || null)) set("cs_number", clean(body.cs_number, 60));
    if (body.task !== undefined && clean(body.task, 300) && clean(body.task, 300) !== kase.task) set("task", clean(body.task, 300));
    if (body.note !== undefined && clean(body.note) !== (kase.note || null)) set("note", clean(body.note));

    if (body.status !== undefined && clean(body.status, 40) && clean(body.status, 40) !== kase.status) {
      const status = clean(body.status, 40);
      const wasClosed = isClosed(kase);
      const nowClosed = config.closedStatuses.includes(status.toLowerCase());
      set("status", status);
      if (nowClosed && !wasClosed) {
        set("end_date", d.toISODate(d.today()));
        vals.push(new Date());
        sets.push(`closed_at = $${vals.length}`);
      }
      if (!nowClosed && wasClosed) {
        sets.push("end_date = NULL", "closed_at = NULL");
      }
      await addActivity(c, kase.id, user, {
        kind: nowClosed ? "ปิดเคส" : "เปลี่ยน Status",
        detail: `Status: ${kase.status || "-"} → ${status}`,
        system: true,
      });
      await logChange(c, kase, user, "status", kase.status, status);
    }

    if (allowReassign && body.owner_id && Number(body.owner_id) !== kase.owner_id) {
      const nu = (await c.query("SELECT id, display_name FROM users WHERE id = $1 AND active", [Number(body.owner_id)])).rows[0];
      if (!nu) throw Object.assign(new Error("ไม่พบผู้ใช้ที่จะโอนเคสให้"), { status: 400 });
      set("owner_id", nu.id);
      await addActivity(c, kase.id, user, { kind: "โอนเคส", detail: `Owner: ${kase.owner || "-"} → ${nu.display_name}`, system: true });
      await logChange(c, kase, user, "owner", kase.owner, nu.display_name);
    }
    if (allowReassign && body.team && body.team !== kase.team) set("team", body.team);

    if (sets.length) {
      sets.push("updated_at = now()");
      vals.push(kase.id);
      await c.query(`UPDATE cases SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    }
    return { changed, newSite };
  });
}

async function editStartDate(user, kase, newDate, reason) {
  const start = d.fromISODate(newDate);
  if (!start) throw Object.assign(new Error("วันที่ไม่ถูกต้อง"), { status: 400 });
  if (!reason || String(reason).trim().length < 5) throw Object.assign(new Error("ต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร"), { status: 400 });
  const oldIso = d.toISODate(kase.startDate);
  const iso = d.toISODate(start);
  if (oldIso === iso) return;
  await tx(async (c) => {
    await c.query("UPDATE cases SET start_date=$1, due_date=$2, updated_at=now() WHERE id=$3", [
      iso, d.toISODate(d.addDays(start, config.slaDays)), kase.id,
    ]);
    await logChange(c, kase, user, "start_date", oldIso, iso, String(reason).trim());
    await addActivity(c, kase.id, user, { kind: "แก้ Start date", detail: `${oldIso} → ${iso} เหตุผล: ${String(reason).trim()}`, system: true });
  });
}

async function deleteCase(user, kase, reason) {
  await tx(async (c) => {
    await logChange(c, kase, user, "deleted", kase.csNumber || String(kase.id), null, reason || null);
    await c.query("DELETE FROM cases WHERE id = $1", [kase.id]);
  });
}

module.exports = {
  loadCases, getCase, canSee, activities, addActivity, createCase, updateCase, editStartDate, deleteCase,
  ensureLookup, logChange, toCase, CASE_SELECT, SEVERITIES, severityOf,
};
