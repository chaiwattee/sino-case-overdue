// Similar closed cases (to reuse a past fix) and the per-customer health page.
// Both read only the cases the signed-in person can already see.
const repo = require("./caserepo");
const d = require("../dates");
const { all } = require("./db");

// ------------------------------------------------------------ similar cases
const seg = new Intl.Segmenter("th", { granularity: "word" });
const STOP = new Set(
  ("ไม่ ได้ ที่ และ หรือ ของ ให้ ใน การ มี เป็น ว่า แล้ว ก็ จะ กับ ครับ ค่ะ คะ นะ จาก เรื่อง ช่วย ด้วย อยู่ ตรวจสอบ ปัญหา แจ้ง ลูกค้า เคส " +
    "the a an and or of to in on for is are be with from at by this that it not no please case issue problem check customer")
    .split(" ")
);
/** Word set of a text (Thai words are split with the ICU dictionary). */
function words(text) {
  const out = new Set();
  for (const s of seg.segment(String(text || "").toLowerCase())) {
    if (!s.isWordLike) continue;
    const w = s.segment.trim();
    if (w.length < 2 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

/** Closed cases most like `q` (task/symptom text): word overlap, plus a boost for the same customer and product. */
async function similar(user, { q, site, product, exclude, limit = 5 }) {
  const qw = words(q);
  if (!qw.size) return [];
  const cases = await repo.loadCases(user, { where: "c.closed_at IS NOT NULL AND c.closed_at > now() - interval '3 years'" });
  const out = [];
  for (const c of cases) {
    if (exclude && c.id === Number(exclude)) continue;
    if (["cancel", "n/a"].includes(String(c.status).toLowerCase())) continue;
    const tw = words(c.task);
    const rw = words(`${c.resolution} ${c.rcaText}`);
    let hit = 0;
    const matched = [];
    for (const w of qw) {
      if (tw.has(w)) (hit += 1), matched.push(w);
      else if (rw.has(w)) (hit += 0.5), matched.push(w);
    }
    if (!hit) continue;
    let score = hit / Math.max(qw.size, Math.min(tw.size, 8));
    if (site && c.site && c.site.toLowerCase() === String(site).toLowerCase()) score += 0.15;
    if (product && c.product && c.product.toLowerCase() === String(product).toLowerCase()) score += 0.1;
    if (score < 0.3) continue;
    out.push({
      id: c.id,
      caseNo: c.caseNo,
      csNumber: c.csNumber,
      site: c.site,
      product: c.product,
      severity: c.severity,
      task: c.task,
      owner: c.owner,
      closedAt: c.endDate ? d.toISODate(c.endDate) : null,
      resolution: (c.resolution || "").slice(0, 600),
      rootCause: c.rootCause || "",
      rcaCategory: c.rcaCategory || "",
      rca: (c.rcaText || "").slice(0, 400),
      sameSite: !!(site && c.site && c.site.toLowerCase() === String(site).toLowerCase()),
      score: Math.round(Math.min(1, score) * 100),
      matched: matched.slice(0, 6),
    });
  }
  return out.sort((a, b) => b.score - a.score || String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, limit);
}

// ------------------------------------------------------------ customer health
const ymOf = (dt) => d.toISODate(dt).slice(0, 7);

/** One customer's picture over the last 6 months, from the cases this person can see. */
async function customer(user, site) {
  const kpi = require("./kpi");
  const csat = require("./csat");
  const cases = await repo.loadCases(user, { where: "lower(c.site) = lower($1)", params: [site] });
  const today = d.today();
  const months = [];
  for (let n = 5; n >= 0; n--) {
    const x = new Date(today.getFullYear(), today.getMonth() - n, 1);
    months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  const from = months[0] + "-01";
  const recent = cases.filter((c) => d.toISODate(c.startDate) >= from || (c.endDate && d.toISODate(c.endDate) >= from) || c.stage !== "closed");
  const open = cases.filter((c) => c.stage !== "closed");
  const closed6 = cases.filter((c) => c.stage === "closed" && c.endDate && d.toISODate(c.endDate) >= from && !["cancel", "n/a"].includes(String(c.status).toLowerCase()));
  const byMonth = months.map((ym) => {
    const cl = closed6.filter((c) => ymOf(c.endDate) === ym);
    return {
      ym,
      opened: cases.filter((c) => ymOf(c.startDate) === ym).length,
      onTime: cl.filter((c) => c.closedOnTime === true).length,
      late: cl.filter((c) => c.closedOnTime === false).length,
    };
  });
  const onTime = closed6.filter((c) => c.closedOnTime === true).length;
  const slaPct = closed6.length ? Math.round((onTime / closed6.length) * 100) : null;
  const avgDays = closed6.length ? Math.round((closed6.reduce((a, c) => a + Math.max(0, d.daysBetween(c.startDate, c.endDate)), 0) / closed6.length) * 10) / 10 : null;
  const cats = await kpi.categories();
  const types = {};
  for (const c of recent) {
    const k = kpi.categorize(`${c.task} ${c.product}`, cats);
    types[k] = (types[k] || 0) + 1;
  }
  const products = {};
  for (const c of recent) if (c.product) products[c.product] = (products[c.product] || 0) + 1;
  const owners = {};
  for (const c of recent) if (c.owner) owners[c.owner] = (owners[c.owner] || 0) + 1;
  const sat = await csat.summary(cases.map((c) => c.id));
  const comments = cases.length
    ? await all(
        `SELECT s.rating, s.comment, s.rated_at, c.id AS case_id, c.case_no FROM case_csat s JOIN cases c ON c.id = s.case_id
         WHERE s.case_id = ANY($1) AND s.rating IS NOT NULL ORDER BY s.rated_at DESC LIMIT 5`,
        [cases.map((c) => c.id)]
      )
    : [];
  const rca = cases
    .filter((c) => c.rcaText)
    .sort((a, b) => String(b.rcaDate).localeCompare(String(a.rcaDate)))
    .slice(0, 5)
    .map((c) => ({ id: c.id, caseNo: c.caseNo, csNumber: c.csNumber, category: c.rcaCategory, date: c.rcaDate, text: c.rcaText.slice(0, 300) }));

  // Health: simple, explainable rules.
  const reasons = [];
  let level = 0;
  const flag = (l, text) => {
    level = Math.max(level, l);
    reasons.push({ level: l === 2 ? "bad" : "warn", text });
  };
  const overdue = open.filter((c) => c.stage === "overdue");
  const critOpen = open.filter((c) => c.severity === "Critical" || c.severity === "High");
  if (overdue.length) flag(overdue.length >= 2 ? 2 : 1, `มีเคสเกิน Due ${overdue.length} เคส`);
  if (critOpen.length) flag(1, `มีเคส Critical / High ที่ยังเปิดอยู่ ${critOpen.length} เคส`);
  if (slaPct != null && closed6.length >= 3 && slaPct < 70) flag(2, `ปิดทัน SLA ${slaPct}% (ต่ำกว่า 70%)`);
  else if (slaPct != null && closed6.length >= 3 && slaPct < 85) flag(1, `ปิดทัน SLA ${slaPct}% (ต่ำกว่า 85%)`);
  if (sat.avg != null && sat.rated >= 2 && sat.avg < 3) flag(2, `คะแนนพึงพอใจเฉลี่ย ${sat.avg}/5`);
  else if (sat.low) flag(1, `มีคะแนนพึงพอใจต่ำ (1–2) ${sat.low} ครั้ง`);
  const last3 = byMonth.slice(-3).reduce((a, m) => a + m.opened, 0);
  const prev3 = byMonth.slice(0, 3).reduce((a, m) => a + m.opened, 0);
  if (last3 >= 4 && last3 >= prev3 * 2) flag(1, `เคสเพิ่มขึ้น: 3 เดือนล่าสุด ${last3} เคส (ก่อนหน้า ${prev3})`);
  const topType = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
  if (topType && topType[1] >= 3 && recent.length && topType[1] / recent.length >= 0.5) flag(1, `ปัญหาซ้ำ: "${topType[0]}" ${topType[1]} เคส ควรดูต้นเหตุ`);
  if (!reasons.length) reasons.push({ level: "ok", text: cases.length ? "ไม่มีเรื่องต้องระวัง" : "ยังไม่มีเคสของลูกค้ารายนี้" });

  const ser = (c) => ({ id: c.id, caseNo: c.caseNo, csNumber: c.csNumber, task: c.task, product: c.product, severity: c.severity, owner: c.owner, stage: c.stage, stageLabel: c.stageLabel, startDate: d.toISODate(c.startDate), dueDate: c.dueDate ? d.toISODate(c.dueDate) : null, daysLeft: c.daysLeft, daysOverdue: c.daysOverdue });
  return {
    site,
    total: cases.length,
    health: ["ok", "warn", "bad"][level],
    reasons,
    open: open.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0) || (a.daysLeft ?? 99) - (b.daysLeft ?? 99)).map(ser),
    months: byMonth,
    stats: { opened6: byMonth.reduce((a, m) => a + m.opened, 0), closed6: closed6.length, slaPct, avgDays, open: open.length, overdue: overdue.length },
    types: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    products: Object.entries(products).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
    owners: Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
    csat: { ...sat, comments },
    rca,
    recentClosed: closed6.sort((a, b) => b.endDate - a.endDate).slice(0, 8).map((c) => ({ ...ser(c), closedAt: d.toISODate(c.endDate), onTime: c.closedOnTime, resolution: (c.resolution || "").slice(0, 200) })),
  };
}

/** Customers in the cases this person can see, with open/overdue counts (for the picker). */
async function customerList(user) {
  const cases = await repo.loadCases(user, { where: "c.site IS NOT NULL AND c.site <> '' AND (c.closed_at IS NULL OR c.closed_at > now() - interval '12 months')" });
  const m = new Map();
  for (const c of cases) {
    const k = c.site;
    const x = m.get(k) || { site: k, total: 0, open: 0, overdue: 0 };
    x.total++;
    if (c.stage !== "closed") x.open++;
    if (c.stage === "overdue") x.overdue++;
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || b.total - a.total || a.site.localeCompare(b.site, "th"));
}

function mount(api, { wrap }) {
  api.get("/cases/similar", wrap(async (req, res) => {
    const q = String(req.query.q || "").slice(0, 500);
    res.json({ items: await similar(req.user, { q, site: req.query.site, product: req.query.product, exclude: req.query.exclude }) });
  }));
  api.get("/customer", wrap(async (req, res) => {
    const site = String(req.query.site || "").trim().slice(0, 120);
    if (!site) return res.json({ list: await customerList(req.user) });
    res.json(await customer(req.user, site));
  }));
}

module.exports = { mount, similar, customer, customerList, words };
