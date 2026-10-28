// Persistence: Supabase (PostgREST) in production, in-memory in MOCK_DATA mode.
// Tables are created by sql/001_case_list_v2.sql.
const axios = require("axios");
const { config } = require("./config");

const T = {
  snapshots: "cl_case_snapshots",
  changes: "cl_case_changes",
  alerts: "cl_alert_log",
  schedules: "cl_report_schedules",
  reports: "cl_report_log",
};

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function inList(values) {
  return `in.(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
}

// ---------------------------------------------------------------- Supabase
function supabaseStore() {
  const base = `${config.supabaseUrl}/rest/v1`;
  const headers = (extra = {}) => ({
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    "Content-Type": "application/json",
    ...extra,
  });
  const get = async (table, params) =>
    (await axios.get(`${base}/${table}`, { headers: headers(), params })).data;
  const post = async (table, rows, prefer = "return=minimal", params) => {
    if (Array.isArray(rows) && rows.length === 0) return [];
    return (
      await axios.post(`${base}/${table}`, rows, {
        headers: headers({ Prefer: prefer }),
        params,
      })
    ).data;
  };

  return {
    kind: "supabase",
    async getSnapshots(keys) {
      const map = {};
      for (const part of chunk([...new Set(keys)], 80)) {
        const rows = await get(T.snapshots, { case_key: inList(part), select: "*" });
        rows.forEach((r) => (map[r.case_key] = r));
      }
      return map;
    },
    async upsertSnapshots(rows) {
      for (const part of chunk(rows, 200)) {
        await post(T.snapshots, part, "resolution=merge-duplicates,return=minimal", {
          on_conflict: "case_key",
        });
      }
    },
    async insertChanges(rows) {
      await post(T.changes, rows);
    },
    async listChanges({ from, limit = 200 } = {}) {
      const params = { select: "*", order: "detected_at.desc", limit };
      if (from) params.detected_at = `gte.${from}`;
      return get(T.changes, params);
    },
    async sentAlertKeys(dedupeKeys) {
      const set = new Set();
      for (const part of chunk([...new Set(dedupeKeys)], 80)) {
        const rows = await get(T.alerts, {
          dedupe_key: inList(part),
          ok: "eq.true",
          select: "dedupe_key",
        });
        rows.forEach((r) => set.add(r.dedupe_key));
      }
      return set;
    },
    async insertAlert(row) {
      // A failed send is logged with ok=false and no dedupe key so it retries next run.
      await post(T.alerts, row);
    },
    async listAlerts({ from, caseKey, limit = 300 } = {}) {
      const params = { select: "*", order: "sent_at.desc", limit };
      if (from) params.sent_at = `gte.${from}`;
      if (caseKey) params.case_key = `eq.${caseKey}`;
      return get(T.alerts, params);
    },
    async listSchedules() {
      return get(T.schedules, { select: "*", order: "id.asc" });
    },
    async saveSchedule(s) {
      if (s.id) {
        const { id, ...rest } = s;
        return (
          await axios.patch(`${base}/${T.schedules}`, rest, {
            headers: headers({ Prefer: "return=representation" }),
            params: { id: `eq.${id}` },
          })
        ).data[0];
      }
      return (await post(T.schedules, s, "return=representation"))[0];
    },
    async deleteSchedule(id) {
      await axios.delete(`${base}/${T.schedules}`, {
        headers: headers(),
        params: { id: `eq.${id}` },
      });
    },
    async insertReport(row) {
      await post(T.reports, row);
    },
    async listReports({ limit = 50 } = {}) {
      return get(T.reports, { select: "*", order: "sent_at.desc", limit });
    },
  };
}

// ---------------------------------------------------------------- Memory
function memoryStore() {
  const db = { snapshots: {}, changes: [], alerts: [], schedules: [], reports: [], seq: 1 };
  const desc = (k) => (a, b) => String(b[k]).localeCompare(String(a[k]));
  return {
    kind: "memory",
    db,
    async getSnapshots(keys) {
      const map = {};
      keys.forEach((k) => db.snapshots[k] && (map[k] = db.snapshots[k]));
      return map;
    },
    async upsertSnapshots(rows) {
      rows.forEach((r) => (db.snapshots[r.case_key] = { ...db.snapshots[r.case_key], ...r }));
    },
    async insertChanges(rows) {
      rows.forEach((r) => db.changes.push({ id: db.seq++, detected_at: new Date().toISOString(), ...r }));
    },
    async listChanges({ from, limit = 200 } = {}) {
      return db.changes
        .filter((c) => !from || c.detected_at >= from)
        .sort(desc("detected_at"))
        .slice(0, limit);
    },
    async sentAlertKeys(keys) {
      const sent = new Set(db.alerts.filter((a) => a.ok).map((a) => a.dedupe_key));
      return new Set(keys.filter((k) => sent.has(k)));
    },
    async insertAlert(row) {
      db.alerts.push({ id: db.seq++, sent_at: new Date().toISOString(), ...row });
    },
    async listAlerts({ from, caseKey, limit = 300 } = {}) {
      return db.alerts
        .filter((a) => (!from || a.sent_at >= from) && (!caseKey || a.case_key === caseKey))
        .sort(desc("sent_at"))
        .slice(0, limit);
    },
    async listSchedules() {
      return [...db.schedules];
    },
    async saveSchedule(s) {
      if (s.id) {
        const i = db.schedules.findIndex((x) => x.id === Number(s.id));
        db.schedules[i] = { ...db.schedules[i], ...s, id: Number(s.id) };
        return db.schedules[i];
      }
      const row = { id: db.seq++, created_at: new Date().toISOString(), ...s };
      db.schedules.push(row);
      return row;
    },
    async deleteSchedule(id) {
      db.schedules = db.schedules.filter((x) => x.id !== Number(id));
    },
    async insertReport(row) {
      db.reports.push({ id: db.seq++, sent_at: new Date().toISOString(), ...row });
    },
    async listReports({ limit = 50 } = {}) {
      return db.reports.sort(desc("sent_at")).slice(0, limit);
    },
  };
}

const store = config.mock || !config.supabaseUrl ? memoryStore() : supabaseStore();

module.exports = { store };
