// Import cases from the three Case List workbooks into PostgreSQL.
// mode "new"     : only add cases not imported yet (used during the parallel period)
// mode "refresh" : also update status / task / note / end date of cases imported earlier and not yet edited on the web
const { config } = require("../config");
const graph = require("../graph");
const { parseCaseList, isClosed } = require("../cases");
const d = require("../dates");
const { tx, audit } = require("./db");
const { ensureLookup } = require("./caserepo");

async function readAll() {
  const out = [];
  for (const src of config.sources) {
    let values;
    if (config.mock) values = require("../mock").mockSheet(src.key);
    else values = await graph.readSheetValues(src.itemId);
    out.push({ src, rows: parseCaseList(values, src) });
  }
  return out;
}

async function importFromExcel(actor, { mode = "new" } = {}) {
  const sheets = await readAll();
  const stat = { added: 0, updated: 0, skippedExisting: 0, skippedNoStart: 0, usersCreated: 0, perSource: {} };

  await tx(async (c) => {
    const userIds = new Map(
      (await c.query("SELECT id, lower(email) AS email FROM users")).rows.map((r) => [r.email, r.id])
    );
    async function ownerFor(row) {
      const email = (row.ownerEmail || "").toLowerCase();
      if (!email || !/@/.test(email)) return null;
      let id = userIds.get(email);
      if (!id) {
        id = (
          await c.query(
            "INSERT INTO users (email, display_name, role, auth_type, created_by) VALUES ($1,$2,'engineer','sso',$3) RETURNING id",
            [email, row.owner || email, actor?.id || null]
          )
        ).rows[0].id;
        userIds.set(email, id);
        stat.usersCreated++;
      }
      await c.query("INSERT INTO user_teams (user_id, team) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, row.source]);
      return id;
    }

    for (const { src, rows } of sheets) {
      const s = (stat.perSource[src.key] = { rows: rows.length, added: 0, updated: 0 });
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        if (!row.startDate) {
          stat.skippedNoStart++;
          continue;
        }
        const legacy = row.key;
        const existing = (await c.query("SELECT id, created_at, updated_at FROM cases WHERE legacy_key = $1", [legacy])).rows[0];
        const closed = isClosed(row);
        const endIso = closed ? d.toISODate(row.endDate || d.today()) : null;
        if (existing) {
          const untouched = Math.abs(new Date(existing.updated_at) - new Date(existing.created_at)) < 1000 || existing.imported;
          if (mode === "refresh" && untouched) {
            await c.query(
              `UPDATE cases SET status=$1, task=COALESCE(NULLIF($2,''), task), note=$3, end_date=$4,
                 closed_at = CASE WHEN $4::date IS NULL THEN NULL ELSE COALESCE(closed_at, now()) END
               WHERE id=$5`,
              [row.status || "In Progress", row.task, row.note || null, endIso, existing.id]
            );
            stat.updated++;
            s.updated++;
          } else stat.skippedExisting++;
          continue;
        }
        const site = row.site ? (await ensureLookup(c, "site", row.site, actor)).value : "(ไม่ระบุ)";
        if (row.product) await ensureLookup(c, "product", row.product, actor);
        const ownerId = await ownerFor(row);
        const startIso = d.toISODate(row.startDate);
        const ins = await c.query(
          `INSERT INTO cases (team, cs_number, status, site, product, owner_id, task, note, start_at, start_date, due_date,
             end_date, closed_at, legacy_key, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$9,$10,$11,$12,$13,$14, now(), now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [row.source, row.csNumber || null, row.status || "In Progress", site, row.product || null, ownerId,
            row.task || row.detail || "(ไม่มีชื่องาน)", row.note || null, startIso,
            d.toISODate(d.addDays(row.startDate, config.slaDays)), endIso, closed ? new Date() : null, legacy, actor?.id || null]
        );
        if (!ins.rows[0]) {
          stat.skippedExisting++; // same CS number already exists in this team
          continue;
        }
        const id = ins.rows[0].id;
        await c.query(
          "INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, startIso, "นำเข้าจาก Excel", row.detail || `นำเข้าจาก ${src.label} แถว ${row.rowNumber}`, !row.detail, actor?.id || null]
        );
        stat.added++;
        s.added++;
      }
    }
  });
  await audit(actor, "import_excel", mode, stat);
  return stat;
}

module.exports = { importFromExcel };
