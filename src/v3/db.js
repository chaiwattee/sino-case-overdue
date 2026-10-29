const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");
const { config3 } = require("./config3");

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config3.databaseUrl, max: 10 });
pool.on("error", (e) => console.error("[db] idle client error:", e.message));

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, "..", "..", "sql", "v3");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await all("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    console.log(`[db] applied ${f}`);
  }
}

async function getSetting(key, def) {
  const r = await one("SELECT value FROM settings WHERE key = $1", [key]);
  return r ? r.value : def;
}
async function setSetting(key, value) {
  await q(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify(value)]
  );
}

// Request context (IP, browser) for audit entries, set by a middleware in server-v3.js.
const { AsyncLocalStorage } = require("async_hooks");
const requestContext = new AsyncLocalStorage();

async function audit(actor, action, target, detail) {
  const ctx = requestContext.getStore() || {};
  await q("INSERT INTO audit_log (actor_id, actor, action, target, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    actor?.id || null,
    actor?.display_name || actor?.email || (actor?.id ? `user #${actor.id}` : "system"),
    action,
    target || null,
    detail ? JSON.stringify(detail) : null,
    ctx.ip || null,
    ctx.ua ? String(ctx.ua).slice(0, 300) : null,
  ]).catch((e) => console.error("[audit]", e.message));
}

module.exports = { pool, q, one, all, tx, migrate, getSetting, setSetting, audit, requestContext };
