#!/usr/bin/env node
// Final Excel import for the cutover: adds new rows and refreshes imported cases that were not edited on the web.
const { importFromExcel } = require("../src/v3/importer");
const { pool } = require("../src/v3/db");

(async () => {
  const r = await importFromExcel({ id: null, display_name: "ย้ายระบบอัตโนมัติ" }, { mode: "refresh" });
  console.log(`import: added ${r.added}, updated ${r.updated}, already there ${r.skippedExisting}, no start date ${r.skippedNoStart}, users created ${r.usersCreated}`);
  for (const [team, s] of Object.entries(r.perSource || {})) console.log(`  ${team}: rows ${s.rows}, added ${s.added}, updated ${s.updated}`);
  await pool.end();
})().catch(async (e) => {
  console.error("import FAILED:", e.response?.data?.error?.message || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
