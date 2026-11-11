// Customer details + installed solution (several products) shown on the customer page.
// Everyone who sees the customer page reads it; admins and managers edit it.
const { q, one, all, tx, audit } = require("./db");

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const canEdit = (u) => ["admin", "manager"].includes(u.role);
const FIELDS = ["full_name", "location", "contact", "account_manager", "engineers", "contract_sla", "remote_access", "notes"];
const SUPPORT = ["MA", "Subscription", "Warranty", "ไม่มีสัญญา"];
const clip = (v, n = 300) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return s || null;
};
const isoOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

async function get(site) {
  const key = String(site || "").trim();
  const [profile, products, aliases] = await Promise.all([
    one("SELECT p.*, u.display_name AS updated_by_name FROM customer_profiles p LEFT JOIN users u ON u.id = p.updated_by WHERE lower(p.site) = lower($1)", [key]),
    all("SELECT * FROM customer_products WHERE lower(site) = lower($1) ORDER BY sort, id", [key]),
    all("SELECT alias FROM intake_aliases WHERE lower(site) = lower($1) ORDER BY alias", [key]).catch(() => []),
  ]);
  const iso = (x) => (x instanceof Date ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}` : x || null);
  return {
    profile: profile ? { ...Object.fromEntries(FIELDS.map((f) => [f, profile[f] || ""])), updatedBy: profile.updated_by_name || "", updatedAt: profile.updated_at } : null,
    products: products.map((p) => ({ id: p.id, product: p.product, category: p.category || "", version: p.version || "", modules: p.modules || [], supportKind: p.support_kind || "", supportUntil: iso(p.support_until), team: p.team || "", notes: p.notes || "" })),
    aliases: aliases.map((a) => a.alias),
  };
}

async function save(user, b) {
  if (!canEdit(user)) throw bad("แก้ข้อมูลลูกค้าได้เฉพาะ Admin และ Manager", 403);
  const site = clip(b.site, 120);
  if (!site) throw bad("ไม่ระบุลูกค้า");
  const p = b.profile || {};
  const vals = FIELDS.map((f) => clip(p[f], f === "notes" ? 2000 : 400));
  const products = (Array.isArray(b.products) ? b.products : []).slice(0, 40).map((x, i) => {
    const product = clip(x.product, 120);
    if (!product) throw bad(`แถวที่ ${i + 1}: ใส่ชื่อ Product`);
    const kind = clip(x.supportKind, 40);
    if (kind && !SUPPORT.includes(kind)) throw bad(`แถวที่ ${i + 1}: ประเภทสัญญาไม่ถูกต้อง`);
    const modules = (Array.isArray(x.modules) ? x.modules : String(x.modules || "").split(","))
      .map((m) => clip(m, 60))
      .filter(Boolean)
      .slice(0, 20);
    return [product, clip(x.category, 80), clip(x.version, 60), modules, kind, isoOk(x.supportUntil), clip(x.team, 40), clip(x.notes, 500), i];
  });
  await tx(async (c) => {
    await c.query(
      `INSERT INTO customer_profiles (site, ${FIELDS.join(", ")}, updated_by, updated_at)
       VALUES ($1, ${FIELDS.map((_, i) => "$" + (i + 2)).join(", ")}, $${FIELDS.length + 2}, now())
       ON CONFLICT (site) DO UPDATE SET ${FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(", ")}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [site, ...vals, user.id]
    );
    await c.query("DELETE FROM customer_products WHERE lower(site) = lower($1)", [site]);
    for (const r of products)
      await c.query(
        `INSERT INTO customer_products (site, product, category, version, modules, support_kind, support_until, team, notes, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [site, ...r]
      );
  });
  await audit(user, "customer.info", site, { products: products.map((r) => r[0]) });
  return get(site);
}

function mount(api, { wrap }) {
  api.get("/customer-info", wrap(async (req, res) => res.json({ ...(await get(req.query.site)), canEdit: canEdit(req.user), supportKinds: SUPPORT })));
  api.put("/customer-info", wrap(async (req, res) => res.json({ ok: true, ...(await save(req.user, req.body || {})), canEdit: true, supportKinds: SUPPORT })));
}

module.exports = { mount, get };
