#!/usr/bin/env node
// One-time cutover helper: copy v2 history (Supabase cl_*) into the v3 PostgreSQL database.
//   - alert log: so v3 does not resend round 1 / round 2 emails that v2 already sent
//   - Start date / Target date change history
//   - manager report schedules (only if v3 has none yet)
// Cases are matched by v3 cases.legacy_key = v2 case_key, so run it AFTER the final Excel import.
// Safe to run more than once (rows already copied are skipped).
//
// Usage (in ~/apps/case-v3):  node scripts/migrate-v2-history.js            # dry run, prints counts
//                             node scripts/migrate-v2-history.js --apply    # writes to v3
const { store } = require("../src/store");
const { config } = require("../src/config");
const { q, all, one, pool } = require("../src/v3/db");

const APPLY = process.argv.includes("--apply");
const SINCE = (process.argv.find((a) => a.startsWith("--since=")) || "--since=2026-01-01").slice(8);

(async () => {
  if (!config.supabaseUrl && !process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is not set (copy it from the v2 .env)");
  const cases = await all("SELECT id, legacy_key FROM cases WHERE legacy_key IS NOT NULL");
  const byKey = new Map(cases.map((c) => [c.legacy_key, c.id]));
  console.log(`v3 cases imported from Excel: ${cases.length}`);

  // ---------------------------------------------------------------- alerts
  const alerts = await store.listAlerts({ from: `${SINCE}T00:00:00+07:00`, limit: 1000 });
  if (alerts.length >= 1000) console.warn("WARNING: 1000 alert rows returned (API page limit). Re-run with a later --since=YYYY-MM-DD to be sure nothing is missed.");
  let aCopied = 0, aSkipped = 0, aNoCase = 0;
  for (const a of alerts) {
    const id = byKey.get(a.case_key);
    if (!id) {
      aNoCase++;
      continue;
    }
    // v2 key "<case_key>|r1" -> v3 key "v3:<id>|r1" (same shape v3 uses for de-duplication)
    const suffix = String(a.dedupe_key).slice(String(a.case_key).length);
    const dedupe = `v3:${id}${suffix}`;
    const exists = await one("SELECT 1 FROM alert_log WHERE dedupe_key=$1 AND sent_at=$2", [dedupe, a.sent_at]);
    if (exists) {
      aSkipped++;
      continue;
    }
    if (APPLY) {
      await q(
        `INSERT INTO alert_log (sent_at, dedupe_key, case_id, team, cs_number, owner, owner_email, site, alert_type, case_age,
           to_list, cc_list, subject, ok, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT DO NOTHING`,
        [a.sent_at, dedupe, id, a.source, a.cs_number, a.owner, a.owner_email, a.site, a.alert_type, a.case_age,
          a.to_list, a.cc_list, a.subject, a.ok, a.error ? `[v2] ${a.error}` : null]
      );
    }
    aCopied++;
  }
  console.log(`alerts: ${alerts.length} in v2 since ${SINCE} -> ${APPLY ? "copied" : "would copy"} ${aCopied}, already there ${aSkipped}, case not in v3 ${aNoCase}`);

  // ---------------------------------------------------------------- date changes
  const changes = await store.listChanges({ from: `${SINCE}T00:00:00+07:00`, limit: 1000 });
  let cCopied = 0, cSkipped = 0;
  for (const ch of changes) {
    const id = byKey.get(ch.case_key) || null;
    const exists = await one("SELECT 1 FROM case_changes WHERE detected_at=$1 AND field=$2 AND coalesce(cs_number,'')=coalesce($3,'')", [ch.detected_at, ch.field, ch.cs_number]);
    if (exists) {
      cSkipped++;
      continue;
    }
    if (APPLY) {
      await q(
        `INSERT INTO case_changes (detected_at, case_id, cs_number, team, site, owner_name, owner_email, field, old_value, new_value,
           direction, reason, changed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [ch.detected_at, id, ch.cs_number, ch.source, ch.site, ch.owner, ch.owner_email, ch.field, ch.old_value, ch.new_value,
          ch.direction, "แก้ใน Excel (ระบบเดิม)", ch.last_modified_by || "Excel"]
      );
    }
    cCopied++;
  }
  console.log(`date changes: ${changes.length} in v2 -> ${APPLY ? "copied" : "would copy"} ${cCopied}, already there ${cSkipped}`);

  // ---------------------------------------------------------------- report schedules
  const v3n = Number((await one("SELECT count(*)::int AS n FROM report_schedules")).n);
  const v2s = await store.listSchedules();
  if (v3n > 0) console.log(`report schedules: v3 already has ${v3n}, skipped (v2 has ${v2s.length})`);
  else {
    for (const s of v2s) {
      if (APPLY)
        await q(
          `INSERT INTO report_schedules (name, enabled, frequency, day_of_week, day_of_month, send_time, range_type, recipients, cc,
             attach_excel, last_period, last_sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [s.name, s.enabled, s.frequency, s.day_of_week, s.day_of_month, s.send_time, s.range_type, s.recipients, s.cc,
            s.attach_excel, s.last_period, s.last_sent_at]
        );
    }
    console.log(`report schedules: ${APPLY ? "copied" : "would copy"} ${v2s.length}`);
  }
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to write.");
  await pool.end();
})().catch(async (e) => {
  console.error("FAILED:", e.response?.data || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
