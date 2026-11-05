// Monthly KPI per owner, computed from what is already in the system (cases, activities, extensions,
// customer requests). Work types are found with an admin-editable keyword list, so no case text leaves the server.
//
// Score (100 + bonus 5):
//  1 SLA 30 · 2 Responsiveness 15 · 3 Weighted workload 15 · 4 Difficulty 10
//  5 Diversity/skill 10 · 6 Backlog & extensions 10 · 7 Documentation 10 · + Team bonus 5
const { config } = require("../config");
const d = require("../dates");
const { q, one, all, getSetting, setSetting, audit } = require("./db");

const SEV_W = { Critical: 3, High: 2, Medium: 1.5, Low: 1, "Request information": 0.5 };
const DEFAULT_CATEGORIES = [
  { name: "Login / สิทธิ์ผู้ใช้", keywords: "login, log in, เข้าระบบ, password, รหัสผ่าน, สิทธิ์, permission, account, sso, user, ผู้ใช้, lock" },
  { name: "Report / Dashboard", keywords: "report, รายงาน, dashboard, export, ยอด, สถิติ, refresh" },
  { name: "Recording / QM", keywords: "record, บันทึกเสียง, playback, qm, quality, evaluation, ฟังเสียง, screen" },
  { name: "Call flow / IVR / Routing", keywords: "ivr, routing, route, queue, skill, โอนสาย, ตัดสาย, สายหลุด, call flow, acd" },
  { name: "Integration / API", keywords: "api, integration, crm, cti, connector, interface, webhook, sync" },
  { name: "ระบบช้า / ค้าง / Error", keywords: "ช้า, slow, ค้าง, hang, timeout, error, crash, down, ใช้งานไม่ได้, outage" },
  { name: "Telephony / Network", keywords: "sip, voip, trunk, network, เครือข่าย, phone, โทรศัพท์, headset, softphone, เสียง" },
  { name: "Config / Change request", keywords: "config, ตั้งค่า, change, เพิ่ม, แก้ไข, ปรับ, setup, migrate" },
  { name: "Upgrade / Patch", keywords: "upgrade, patch, update, version, อัปเกรด, hotfix, release" },
  { name: "License / ขอข้อมูล", keywords: "license, ไลเซนส์, สอบถาม, quotation, quote, ขอข้อมูล, renewal, ต่ออายุ" },
];
const OTHER = "อื่นๆ";

async function categories() {
  const s = await getSetting("kpi_categories", null);
  return (s && s.length ? s : DEFAULT_CATEGORIES).map((c) => ({
    name: c.name,
    keywords: c.keywords,
    words: String(c.keywords || "").split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean),
  }));
}
function categorize(text, cats) {
  const t = String(text || "").toLowerCase();
  let best = null;
  let hits = 0;
  for (const c of cats) {
    const n = c.words.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
    if (n > hits) {
      best = c.name;
      hits = n;
    }
  }
  return best || OTHER;
}

/** Shannon evenness of counts against the number of options that were possible (0..1). */
function diversity(counts, options) {
  const vals = Object.values(counts).filter((v) => v > 0);
  const n = vals.reduce((a, b) => a + b, 0);
  const k = Math.min(options, n);
  if (n < 2 || k < 2) return 0;
  const h = -vals.reduce((a, v) => a + (v / n) * Math.log(v / n), 0);
  return Math.min(1, h / Math.log(k));
}
const median = (xs) => {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => Math.round(x * 10) / 10;
function grade(s) {
  if (s == null) return null;
  return s >= 85 ? "A" : s >= 80 ? "A-" : s >= 75 ? "B+" : s >= 70 ? "B" : s >= 60 ? "C" : "D";
}

function monthRange(ym) {
  const [y, m] = String(ym || "").split("-").map(Number);
  const now = d.today();
  const Y = y || now.getFullYear();
  const M = m || now.getMonth() + 1;
  const from = new Date(Y, M - 1, 1);
  const to = new Date(Y, M, 0);
  return { ym: `${Y}-${String(M).padStart(2, "0")}`, from, to, fromIso: d.toISODate(from), toIso: d.toISODate(to) };
}

/** Compute KPI for every owner who had cases in the month. Returns { month, owners: [...], team }. */
async function compute(ym) {
  const R = monthRange(ym);
  const cats = await categories();
  const nextIso = d.toISODate(d.addDays(R.to, 1));
  // Cases the owner worked on in the month: open at any point during it.
  const cases = await all(
    `SELECT c.id, c.case_no, c.owner_id, c.site, c.product, c.severity, c.task, c.start_date, c.due_date, c.end_date, c.start_at, c.created_at,
            c.closed_at, c.ext_count, c.legacy_key, c.resolution, u.display_name AS owner_name, u.email AS owner_email, u.active
       FROM cases c JOIN users u ON u.id = c.owner_id
      WHERE c.start_date <= $2 AND (c.end_date IS NULL OR c.end_date >= $1)`,
    [R.fromIso, R.toIso]
  );
  const ids = cases.map((c) => c.id);
  const acts = ids.length
    ? await all(
        `SELECT case_id, activity_date, kind, detail, is_system, created_at FROM case_activities WHERE case_id = ANY($1) ORDER BY created_at`,
        [ids]
      )
    : [];
  const exts = await all(
    `SELECT e.case_id, e.status, e.decided_at, c.owner_id FROM case_extensions e JOIN cases c ON c.id = e.case_id
      WHERE e.status = 'approved' AND e.decided_at >= $1 AND e.decided_at < $2`,
    [R.fromIso, nextIso]
  );
  const intakes = await all(
    `SELECT claimed_by, created_at, claimed_at FROM intakes WHERE status = 'claimed' AND NOT is_test AND claimed_at >= $1 AND claimed_at < $2`,
    [R.fromIso, nextIso]
  ).catch(() => []);
  // Products each owner handled before this month (to spot new skills).
  const before = await all(
    `SELECT DISTINCT owner_id, upper(product) AS product FROM cases WHERE start_date < $1 AND product IS NOT NULL AND product <> ''`,
    [R.fromIso]
  );
  const productsAll = (await all("SELECT count(*)::int AS n FROM lookups WHERE kind='product' AND active"))[0]?.n || 6;
  const sitesAll = (await all("SELECT count(*)::int AS n FROM lookups WHERE kind='site' AND active"))[0]?.n || 10;

  const actsBy = {};
  acts.forEach((a) => (actsBy[a.case_id] = actsBy[a.case_id] || []).push(a));
  const byOwner = new Map();
  for (const c of cases) {
    if (!byOwner.has(c.owner_id)) byOwner.set(c.owner_id, { id: c.owner_id, name: c.owner_name, email: c.owner_email, active: c.active, cases: [] });
    byOwner.get(c.owner_id).cases.push(c);
  }

  const owners = [];
  for (const o of byOwner.values()) {
    const handled = o.cases;
    const closed = handled.filter((c) => c.end_date && c.end_date >= R.fromIso && c.end_date <= R.toIso);
    const startedIn = handled.filter((c) => c.start_date >= R.fromIso);
    // Work notes written by people (not system entries or rows copied from the old Excel file).
    const human = (c) => (actsBy[c.id] || []).filter((a) => !a.is_system && !/นำเข้า|import/i.test(a.kind || ""));
    const m = {};

    // 1. SLA (30): against the original Due (start + SLA days); closed within an extension = half; Critical counts double.
    let wSum = 0;
    let wGot = 0;
    let onTime = 0;
    closed.forEach((c) => {
      const origDue = d.toISODate(d.addDays(d.fromISODate(c.start_date), config.slaDays));
      const ok = c.end_date <= origDue;
      const inExt = !ok && c.ext_count > 0 && c.end_date <= c.due_date;
      const w = c.severity === "Critical" ? 2 : 1;
      wSum += w;
      wGot += w * (ok ? 1 : inExt ? 0.5 : 0);
      if (ok) onTime++;
    });
    m.closed = closed.length;
    m.onTime = onTime;
    m.slaPct = closed.length ? Math.round((onTime / closed.length) * 100) : null;
    const sSla = wSum ? (30 * wGot) / wSum : null;

    // 2. Responsiveness (15): first human activity after opening (8) + how often open cases get updated (7).
    const firstHrs = startedIn
      .filter((c) => !c.legacy_key) // imported cases have no real "first response" time
      .map((c) => {
        const a = human(c)[0];
        const t0 = new Date(c.start_at || c.created_at);
        return a ? (new Date(a.created_at) - t0) / 3600000 : null;
      })
      .filter((x) => x != null && x >= 0);
    m.firstResponseHrs = firstHrs.length ? r1(median(firstHrs)) : null;
    const fr = m.firstResponseHrs;
    const sFirst = fr == null ? 4 : fr <= 4 ? 8 : fr <= 8 ? 6 : fr <= 24 ? 4 : fr <= 48 ? 2 : 0;
    let openDays = 0;
    let updates = 0;
    handled.forEach((c) => {
      const s = c.start_date > R.fromIso ? c.start_date : R.fromIso;
      const e = c.end_date && c.end_date < R.toIso ? c.end_date : R.toIso;
      openDays += Math.max(1, d.daysBetween(d.fromISODate(s), d.fromISODate(e)) + 1);
      updates += human(c).filter((a) => a.activity_date >= R.fromIso && a.activity_date <= R.toIso).length;
    });
    m.updateEveryDays = updates ? r1(openDays / updates) : null;
    const ue = m.updateEveryDays;
    const sUpd = ue == null ? 0 : ue <= 2 ? 7 : ue <= 3 ? 5 : ue <= 5 ? 3 : 1;
    const sResp = sFirst + sUpd;

    // 3. Weighted workload (15) vs team median — filled in after all owners are known.
    m.weighted = r1(closed.reduce((a, c) => a + (SEV_W[c.severity] || 1), 0));

    // 4. Difficulty (10) vs team average — share of Critical/High or Vendor/Onsite cases.
    const hard = handled.filter((c) => ["Critical", "High"].includes(c.severity) || human(c).some((a) => /vendor|remote|onsite/i.test(a.kind || ""))).length;
    m.hardShare = handled.length ? hard / handled.length : 0;
    m.critical = handled.filter((c) => c.severity === "Critical").length;

    // 5. Diversity (10): work types, products and customers; +1.5 per product new to this owner (max 3).
    const typeCount = {};
    const prodCount = {};
    const siteCount = {};
    const kindCount = {};
    handled.forEach((c) => {
      const text = [c.task, ...human(c).map((a) => a.detail)].join(" ");
      const t = categorize(text, cats);
      typeCount[t] = (typeCount[t] || 0) + 1;
      if (c.product) prodCount[c.product.toUpperCase()] = (prodCount[c.product.toUpperCase()] || 0) + 1;
      if (c.site) siteCount[c.site] = (siteCount[c.site] || 0) + 1;
      human(c).forEach((a) => (kindCount[a.kind] = (kindCount[a.kind] || 0) + 1));
    });
    const dv = [diversity(typeCount, cats.length + 1), diversity(prodCount, productsAll), diversity(siteCount, sitesAll)];
    m.diversity = Math.round((dv.reduce((a, b) => a + b, 0) / 3) * 100) / 100;
    const known = new Set(before.filter((b) => b.owner_id === o.id).map((b) => b.product));
    // Only once the owner has history in the system; otherwise every product would look "new".
    m.newSkills = known.size ? Object.keys(prodCount).filter((p) => !known.has(p)) : [];
    const sDiv = 7 * m.diversity + Math.min(3, 1.5 * m.newSkills.length);

    // 6. Backlog & extensions (10): overdue at month end and approved extensions in the month.
    m.overdueAtEnd = handled.filter((c) => (!c.end_date || c.end_date > R.toIso) && c.due_date < R.toIso).length;
    m.extensions = exts.filter((e) => e.owner_id === o.id).length;
    const sBack = clamp(10 - 2 * m.overdueAtEnd - Math.min(3, m.extensions), 0, 10);

    // 7. Documentation (10): closed cases with a Resolution / ending with a real note (5) + ≥3 meaningful activities per case (5).
    const noted = closed.filter((c) => {
      if (String(c.resolution || "").trim().length >= 20) return true;
      const h = human(c);
      const last = h[h.length - 1];
      return last && String(last.detail || "").trim().length >= 20;
    }).length;
    const meaningful = handled.reduce((a, c) => a + human(c).filter((x) => String(x.detail || "").trim().length >= 10).length, 0);
    m.actsPerCase = handled.length ? r1(meaningful / handled.length) : 0;
    const sDoc = (closed.length ? (5 * noted) / closed.length : 2.5) + 5 * Math.min(1, m.actsPerCase / 3);

    // + Team bonus (5): customer requests claimed within an hour.
    const fast = intakes.filter((i) => i.claimed_by === o.id && new Date(i.claimed_at) - new Date(i.created_at) <= 3600000).length;
    m.fastClaims = fast;
    const sBonus = Math.min(5, Math.floor(fast / 2));

    owners.push({
      id: o.id, name: o.name, email: o.email, active: o.active,
      handled: handled.length, metrics: m,
      types: typeCount, products: prodCount, sites: siteCount, kinds: kindCount,
      parts: { sla: sSla, resp: sResp, work: null, hard: null, div: sDiv, back: sBack, doc: sDoc, bonus: sBonus },
    });
  }

  // Team-relative parts
  const medW = median(owners.map((o) => o.metrics.weighted).filter((x) => x > 0)) || 1;
  const avgHard = owners.length ? owners.reduce((a, o) => a + o.metrics.hardShare, 0) / owners.length : 0;
  owners.forEach((o) => {
    const ratio = o.metrics.weighted / medW;
    o.parts.work = ratio >= 1.5 ? 15 : ratio >= 1 ? 10 + (ratio - 1) * 10 : 10 * ratio;
    o.parts.hard = clamp(5 + (5 * (o.metrics.hardShare - avgHard)) / Math.max(avgHard, 0.1), 0, 10);
  });

  const adj = await all("SELECT a.*, u.display_name AS by_name FROM kpi_adjustments a LEFT JOIN users u ON u.id = a.adjusted_by WHERE month = $1", [R.ym]);
  owners.forEach((o) => {
    const p = o.parts;
    const base = (p.sla ?? 15) + p.resp + p.work + p.hard + p.div + p.back + p.doc;
    const a = adj.find((x) => x.user_id === o.id);
    o.adjust = a ? { points: a.points, reason: a.reason, by: a.by_name, at: a.updated_at } : null;
    o.base = r1(base);
    o.score = Math.round(clamp(base + p.bonus + (a ? a.points : 0), 0, 105));
    o.insufficient = o.metrics.closed < 3;
    o.grade = o.insufficient ? null : grade(o.score);
    Object.keys(p).forEach((k) => (p[k] = p[k] == null ? null : r1(p[k])));
    o.summary = summarize(o, owners);
  });
  owners.sort((a, b) => (a.insufficient - b.insufficient) || b.score - a.score);
  const scored = owners.filter((o) => !o.insufficient);
  return {
    month: R.ym, from: R.fromIso, to: R.toIso,
    owners,
    team: {
      avgScore: scored.length ? Math.round(scored.reduce((a, o) => a + o.score, 0) / scored.length) : null,
      medianWeighted: r1(medW),
      avgDiversity: owners.length ? Math.round((owners.reduce((a, o) => a + o.metrics.diversity, 0) / owners.length) * 100) / 100 : null,
    },
    categories: cats.map((c) => ({ name: c.name, keywords: c.keywords })),
  };
}

const top = (obj, n = 2) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
function summarize(o, all) {
  const m = o.metrics;
  if (!o.handled) return "";
  const avgFirst = median(all.map((x) => x.metrics.firstResponseHrs));
  const good = [];
  const work = [];
  if (m.slaPct != null && m.slaPct >= 85) good.push(`ปิดทัน SLA ${m.slaPct}%`);
  if (m.firstResponseHrs != null && avgFirst != null && m.firstResponseHrs <= avgFirst) good.push(`ตอบสนองเร็ว (${m.firstResponseHrs} ชม.)`);
  if (m.critical) good.push(`รับเคส Critical ${m.critical} เคส`);
  if (m.newSkills.length) good.push(`ทำ ${m.newSkills.join(", ")} เป็นครั้งแรก`);
  if (m.fastClaims) good.push(`รับเคสจากลูกค้าภายใน 1 ชม. ${m.fastClaims} เคส`);
  if (m.slaPct != null && m.slaPct < 70) work.push(`ปิดทัน SLA เพียง ${m.slaPct}%`);
  if (m.overdueAtEnd) work.push(`มีเคสเกิน Due ณ สิ้นเดือน ${m.overdueAtEnd} เคส`);
  if (m.extensions >= 2) work.push(`ขอขยายเวลา ${m.extensions} ครั้ง`);
  if (m.updateEveryDays != null && m.updateEveryDays > 3) work.push(`อัปเดตเคสห่าง (ทุก ${m.updateEveryDays} วัน)`);
  if (m.diversity < 0.35 && o.handled >= 4) work.push("งานกระจุกอยู่ไม่กี่ประเภท");
  const types = top(o.types).filter((t) => t !== OTHER);
  const prods = top(o.products);
  const sites = top(o.sites, 3);
  return [
    `${o.name} ดูแล ${o.handled} เคส ปิด ${m.closed} เคส` +
      (types.length ? ` เน้นงาน ${types.join(" และ ")}` : "") +
      (prods.length ? ` บน ${prods.join(", ")}` : "") +
      (sites.length ? ` ของลูกค้า ${sites.join(", ")}` : ""),
    good.length ? `จุดเด่น: ${good.join(" · ")}` : "",
    work.length ? `ควรพัฒนา: ${work.join(" · ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Last 6 months of total score for one owner (computed on the fly). */
async function trend(userId, ym, n = 6) {
  const R = monthRange(ym);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(R.from.getFullYear(), R.from.getMonth() - i, 1);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const res = await compute(k);
    const o = res.owners.find((x) => x.id === userId);
    out.push({ month: k, score: o ? o.score : null, insufficient: o ? o.insufficient : true });
  }
  return out;
}

// ------------------------------------------------------------ monthly email to managers
async function sendMonthly({ month } = {}) {
  const graph = require("../graph");
  const { config3 } = require("./config3");
  const { esc, shell, button } = require("../emails");
  const t = d.today();
  const last = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const ym = month || `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
  const r = await compute(ym);
  const to = (await all("SELECT email FROM users WHERE active AND role IN ('manager','admin') AND email IS NOT NULL")).map((u) => u.email);
  if (!to.length || !r.owners.length) return { ok: true, skipped: true, month: ym };
  const [y, m] = ym.split("-").map(Number);
  const label = `${["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."][m - 1]} ${y + 543}`;
  const td = (v, right) => `<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;${right ? "text-align:right" : ""}">${v}</td>`;
  const rows = r.owners
    .map((o) => `<tr>${td(`<strong>${esc(o.name)}</strong>`)}${td(`<strong>${o.score}</strong> ${o.grade || '<span style="color:#5B6576">ข้อมูลไม่พอ</span>'}`, 1)}${td(`${o.handled} / ${o.metrics.closed}`, 1)}${td(o.metrics.slaPct == null ? "-" : o.metrics.slaPct + "%", 1)}${td(o.metrics.overdueAtEnd, 1)}${td(o.metrics.diversity.toFixed(2), 1)}</tr>`)
    .join("");
  const th = (t, right) => `<th style="padding:8px 10px;border-bottom:1px solid #E2E5EA;font-weight:600;color:#5B6576;font-size:12px;${right ? "text-align:right" : "text-align:left"}">${t}</th>`;
  const html = shell(
    "#1764D8",
    `<p style="margin:0 0 10px;padding:8px 12px;background:#FBF0D2;color:#7A5600;border-radius:8px;font-size:13px"><strong>ทดลองใช้</strong> · เกณฑ์และคะแนนอยู่ระหว่างทดลอง ยังไม่ใช้ประเมินผลงานจริง</p>
<p style="margin:0 0 4px;font-size:19px;font-weight:700">KPI ราย Owner · ${esc(label)}</p>
<p style="margin:0 0 16px;color:#5B6576;font-size:14px">คำนวณจากข้อมูลเคสในระบบ${r.team.avgScore != null ? ` · ทีมเฉลี่ย ${r.team.avgScore}` : ""} · ปรับคะแนนได้ ±10 พร้อมเหตุผลในหน้า KPI</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:0 0 16px"><tr>${th("Owner")}${th("คะแนน", 1)}${th("ดูแล / ปิด", 1)}${th("ทัน SLA", 1)}${th("เกิน Due สิ้นเดือน", 1)}${th("หลากหลาย", 1)}</tr>${rows}</table>
${button(`${config3.baseUrl}/#/kpi?month=${ym}`, "เปิดหน้า KPI")}`
  );
  await graph.sendMail({ to, cc: [], subject: `[Sino Case SLA] KPI ราย Owner ${label} (ทดลองใช้)`, html });
  return { ok: true, month: ym, to: to.length, owners: r.owners.length };
}

// ------------------------------------------------------------ routes
function mount(api, { wrap, need }) {
  const canAll = (u) => ["admin", "manager", "observer"].includes(u.role);
  const canAdjust = (u) => ["admin", "manager"].includes(u.role);
  api.get("/kpi", wrap(async (req, res) => {
    const r = await compute(req.query.month);
    if (!canAll(req.user)) r.owners = r.owners.filter((o) => o.id === req.user.id);
    res.json({ ...r, canAll: canAll(req.user), canAdjust: canAdjust(req.user), canEditCategories: req.user.role === "admin" });
  }));
  api.get("/kpi/trend/:id(\\d+)", wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!canAll(req.user) && id !== req.user.id) return res.status(403).json({ error: "ดูได้เฉพาะ KPI ของตัวเอง" });
    res.json({ trend: await trend(id, req.query.month) });
  }));
  api.put("/kpi/adjust", wrap(async (req, res) => {
    if (!canAdjust(req.user)) return res.status(403).json({ error: "เฉพาะ Manager หรือ Admin" });
    const b = req.body || {};
    const month = monthRange(b.month).ym;
    const points = Math.round(Number(b.points) || 0);
    if (Math.abs(points) > 10) return res.status(400).json({ error: "ปรับได้ไม่เกิน ±10 คะแนน" });
    const reason = String(b.reason || "").trim().slice(0, 500);
    if (points && reason.length < 5) return res.status(400).json({ error: "กรุณาระบุเหตุผลที่ปรับคะแนน" });
    if (Number(b.userId) === req.user.id && req.user.role !== "admin") return res.status(400).json({ error: "ปรับคะแนนของตัวเองไม่ได้" });
    if (!points) await q("DELETE FROM kpi_adjustments WHERE month = $1 AND user_id = $2", [month, b.userId]);
    else
      await q(
        `INSERT INTO kpi_adjustments (month, user_id, points, reason, adjusted_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (month, user_id) DO UPDATE SET points = EXCLUDED.points, reason = EXCLUDED.reason, adjusted_by = EXCLUDED.adjusted_by, updated_at = now()`,
        [month, b.userId, points, reason, req.user.id]
      );
    await audit(req.user, "kpi_adjust", `${month} · user #${b.userId}`, { points, reason });
    res.json({ ok: true });
  }));
  api.post("/kpi/send", need("settings_manage"), wrap(async (req, res) => res.json(await sendMonthly({ month: req.body?.month }))));
  api.put("/kpi/categories", need("settings_manage"), wrap(async (req, res) => {
    const list = (Array.isArray(req.body?.categories) ? req.body.categories : [])
      .map((c) => ({ name: String(c.name || "").trim().slice(0, 60), keywords: String(c.keywords || "").trim().slice(0, 1000) }))
      .filter((c) => c.name && c.keywords);
    await setSetting("kpi_categories", list.length ? list : null);
    await audit(req.user, "kpi_categories", null, { count: list.length });
    res.json({ ok: true });
  }));
}

module.exports = { compute, trend, mount, sendMonthly, categorize, diversity, monthRange, DEFAULT_CATEGORIES, grade };
