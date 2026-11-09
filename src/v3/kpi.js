// Monthly KPI per owner, computed from what is already in the system (cases, activities, extensions,
// customer requests). Work types are found with an admin-editable keyword list, so no case text leaves the server.
//
// Score (100 + bonus 10):
//  1 SLA 30 · 2 Responsiveness 15 · 3 Weighted workload 15 · 4 Difficulty 10
//  5 Diversity/skill 10 (internal service requests count here as work types / new skills, nothing else) · 6 Backlog & extensions 10 · 7 Documentation 10 · + Team bonus 5 · + Customer satisfaction bonus 5
const { config } = require("../config");
const d = require("../dates");
const { q, one, all, getSetting, setSetting, audit } = require("./db");

// Deploy = planned patch / upgrade: prepared ahead and done in a window, weighted like Medium (+0.3 more when a "Deploy Patch" activity is logged).
const SEV_W = { Critical: 3, High: 2, Medium: 1.5, Low: 1, "Request information": 0.5, Deploy: 1.5 };
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
// A customer meeting (an activity of this kind with a real summary) counts as work and as a work type of its own.
// Customer meetings (an activity of these kinds with a real summary) count as work and as a work type of their own.
// Onsite (travel, half a day or more) is worth more than online. "Meeting กับลูกค้า" is the older single kind: counted as online.
const MEETING = "Meeting กับลูกค้า"; // the work type name
const MEETING_ONSITE = "Meeting Onsite กับลูกค้า";
const MEETING_ONLINE = "Meeting Online กับลูกค้า";
const MEETING_KINDS = [MEETING_ONSITE, MEETING_ONLINE, MEETING];
const MEETING_MIN = 30;
const MEET_W = { [MEETING_ONSITE]: 0.4, [MEETING_ONLINE]: 0.2, [MEETING]: 0.2 };
const isMeeting = (a) => MEETING_KINDS.includes(a.kind) && String(a.detail || "").trim().length >= MEETING_MIN;
// Deploying a patch / upgrade on the customer's system (with a real summary: version, systems, result, rollback): +0.3 once per case.
const DEPLOY = "Deploy Patch";
const DEPLOY_TYPE = "Upgrade / Patch"; // the work type it counts as
const isDeploy = (a) => a.kind === DEPLOY && String(a.detail || "").trim().length >= MEETING_MIN;
/** Extra work multiplier for a case's meetings: the 2 heaviest count (onsite 0.4, online 0.2), at most 0.6. */
const meetingBonus = (acts) => {
  const w = acts.filter(isMeeting).map((a) => MEET_W[a.kind]).sort((x, y) => y - x).slice(0, 2);
  return Math.min(0.6, w.reduce((s, x) => s + x, 0));
};

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
            c.closed_at, c.ext_count, c.legacy_key, c.resolution, c.team, c.cs_number, c.complexity, u.display_name AS owner_name, u.email AS owner_email, u.active,
            u.dedicated_customer
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
  // Customer satisfaction ratings answered in the month, by the owner of the case.
  const csat = await all(
    `SELECT c.owner_id, s.rating FROM case_csat s JOIN cases c ON c.id = s.case_id WHERE s.rating IS NOT NULL AND s.rated_at >= $1 AND s.rated_at < $2`,
    [R.fromIso, nextIso]
  ).catch(() => []);
  // Products each owner handled before this month (to spot new skills).
  const before = await all(
    `SELECT DISTINCT owner_id, upper(product) AS product FROM cases WHERE start_date < $1 AND product IS NOT NULL AND product <> ''`,
    [R.fromIso]
  );
  // Internal service requests delivered in the month: they widen the owner's work types (skill), no points of their own.
  const srBy = await require("./sr").kpiByAssignee(R.fromIso, R.toIso);
  const srTypesBefore = await all(
    `SELECT DISTINCT assignee_id, category FROM service_requests WHERE status = 'done' AND outcome = 'delivered' AND category IS NOT NULL
        AND (closed_at AT TIME ZONE 'Asia/Bangkok')::date < $1`,
    [R.fromIso]
  ).catch(() => []);
  const meetBefore = new Set(
    (
      await all(
        `SELECT DISTINCT c.owner_id FROM case_activities a JOIN cases c ON c.id = a.case_id
          WHERE a.kind = ANY($1) AND NOT a.is_system AND length(trim(a.detail)) >= $2 AND a.activity_date < $3`,
        [MEETING_KINDS, MEETING_MIN, R.fromIso]
      ).catch(() => [])
    ).map((r) => r.owner_id)
  );
  const deployBefore = new Set(
    (
      await all(
        `SELECT DISTINCT c.owner_id FROM case_activities a JOIN cases c ON c.id = a.case_id
          WHERE a.kind = $1 AND NOT a.is_system AND length(trim(a.detail)) >= $2 AND a.activity_date < $3`,
        [DEPLOY, MEETING_MIN, R.fromIso]
      ).catch(() => [])
    ).map((r) => r.owner_id)
  );
  const productsAll = (await all("SELECT count(*)::int AS n FROM lookups WHERE kind='product' AND active"))[0]?.n || 6;
  const sitesAll = (await all("SELECT count(*)::int AS n FROM lookups WHERE kind='site' AND active"))[0]?.n || 10;

  const actsBy = {};
  acts.forEach((a) => (actsBy[a.case_id] = actsBy[a.case_id] || []).push(a));
  const byOwner = new Map();
  for (const c of cases) {
    if (!byOwner.has(c.owner_id)) byOwner.set(c.owner_id, { id: c.owner_id, name: c.owner_name, email: c.owner_email, active: c.active, dedicated: c.dedicated_customer, cases: [] });
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

    // 3. Work (20): "work points" of closed cases = severity × difficulty, compared with the team median on a square-root
    //    curve (4× the points ≈ 2× the score), so many easy cases and a few hard ones end up close. Filled in below.
    const casePoints = (c) => {
      const h = human(c);
      // Customer meetings: onsite +0.4, online +0.2, the 2 heaviest count (at most +0.6), so meetings can't be padded.
      // "Remote / Onsite" technical work keeps its own +0.3; an onsite meeting is not counted twice.
      const onsiteWork = h.some((a) => /onsite/i.test(a.kind || "") && !MEETING_KINDS.includes(a.kind));
      const auto = 1 + (c.cs_number ? 0.5 : 0) + (onsiteWork ? 0.3 : 0) + meetingBonus(h) + (h.some(isDeploy) ? 0.3 : 0) + (c.end_date && d.daysBetween(d.fromISODate(c.start_date), d.fromISODate(c.end_date)) > 7 ? 0.2 : 0);
      return (SEV_W[c.severity] || 1) * auto * (c.complexity ? Number(c.complexity) : 1);
    };
    m.points = r1(closed.reduce((a, c) => a + casePoints(c), 0));
    m.weighted = m.points; // kept for older screens
    m.vendor = closed.filter((c) => c.cs_number).length;
    m.critical = handled.filter((c) => c.severity === "Critical").length;
    const teamCount = {};
    handled.forEach((c) => (teamCount[c.team] = (teamCount[c.team] || 0) + 1));
    m.team = Object.entries(teamCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

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
      // A case with a customer meeting this month also counts as the work type "Meeting กับลูกค้า".
      if (human(c).some((a) => isMeeting(a) && a.activity_date >= R.fromIso && a.activity_date <= R.toIso)) typeCount[MEETING] = (typeCount[MEETING] || 0) + 1;
    });
    const meetsIn = handled.flatMap((c) => human(c).filter((a) => isMeeting(a) && a.activity_date >= R.fromIso && a.activity_date <= R.toIso));
    m.meetingsOnsite = meetsIn.filter((a) => a.kind === MEETING_ONSITE).length;
    m.meetingsOnline = meetsIn.length - m.meetingsOnsite;
    m.meetings = meetsIn.length;
    const deploysIn = handled.filter((c) => human(c).some((a) => isDeploy(a) && a.activity_date >= R.fromIso && a.activity_date <= R.toIso));
    m.deploys = deploysIn.length;
    // A case with a patch deployed this month counts as the work type "Upgrade / Patch" (once, even if its text already says so).
    deploysIn.forEach((c) => {
      const t = categorize([c.task, ...human(c).map((a) => a.detail)].join(" "), cats);
      if (t !== DEPLOY_TYPE) typeCount[DEPLOY_TYPE] = (typeCount[DEPLOY_TYPE] || 0) + 1;
    });
    const srk = srBy.get(o.id);
    m.sr = srk ? { count: srk.count, onTime: srk.onTime, categories: srk.categories } : { count: 0, onTime: 0, categories: {} };
    if (srk) {
      for (const [cat, n] of Object.entries(srk.categories)) typeCount[cat] = (typeCount[cat] || 0) + n;
      for (const t of srk.titles) {
        const cat = categorize(t, cats);
        typeCount[cat] = (typeCount[cat] || 0) + 1;
      }
    }
    // Someone the manager assigned to one customer is not marked down for customer variety.
    const dv = [diversity(typeCount, cats.length + 2), diversity(prodCount, productsAll), ...(o.dedicated ? [] : [diversity(siteCount, sitesAll)])];
    m.dedicated = !!o.dedicated;
    m.diversity = Math.round((dv.reduce((a, b) => a + b, 0) / dv.length) * 100) / 100;
    const known = new Set(before.filter((b) => b.owner_id === o.id).map((b) => b.product));
    // Only once the owner has history in the system; otherwise every product would look "new".
    m.newSkills = known.size ? Object.keys(prodCount).filter((p) => !known.has(p)) : [];
    // A work type done for the first time through a service request counts as a new skill too.
    const srKnown = new Set(srTypesBefore.filter((x) => x.assignee_id === o.id).map((x) => x.category));
    if (known.size || srKnown.size) for (const cat of Object.keys(m.sr.categories)) if (!srKnown.has(cat) && !m.newSkills.includes(cat)) m.newSkills.push(cat);
    // First customer meeting ever (for someone with history in the system) is a new skill too.
    if (known.size && m.meetings && !meetBefore.has(o.id)) m.newSkills.push(MEETING);
    if (known.size && m.deploys && !deployBefore.has(o.id) && !m.newSkills.includes(DEPLOY)) m.newSkills.push(DEPLOY);
    const sDiv = 10.5 * m.diversity + Math.min(4.5, 1.5 * m.newSkills.length); // 15

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

    // + Customer satisfaction bonus (5): only rewards, never deducts (few customers answer, and some scores are about the product).
    //   Needs at least 2 answers in the month: average ≥4.5 → 5 · ≥4 → 3 · ≥3.5 → 1.
    const mine = csat.filter((x) => x.owner_id === o.id).map((x) => Number(x.rating));
    m.csatCount = mine.length;
    m.csatAvg = mine.length ? Math.round((mine.reduce((a, b) => a + b, 0) / mine.length) * 10) / 10 : null;
    m.csatLow = mine.filter((x) => x <= 2).length;
    const sCsat = mine.length >= 2 ? (m.csatAvg >= 4.5 ? 5 : m.csatAvg >= 4 ? 3 : m.csatAvg >= 3.5 ? 1 : 0) : 0;

    owners.push({
      id: o.id, name: o.name, email: o.email, active: o.active,
      handled: handled.length, metrics: m,
      types: typeCount, products: prodCount, sites: siteCount, kinds: kindCount,
      parts: { sla: sSla, resp: sResp, work: null, div: sDiv, back: sBack, doc: sDoc, bonus: sBonus, csat: sCsat },
    });
  }

  // Team-relative parts
  // Work points against the median of the same team (WFM is not compared with Nexidia).
  const medW = median(owners.map((o) => o.metrics.points).filter((x) => x > 0)) || 1;
  const teamMed = {};
  for (const t of new Set(owners.map((o) => o.metrics.team))) {
    const pts = owners.filter((o) => o.metrics.team === t).map((o) => o.metrics.points).filter((x) => x > 0);
    teamMed[t] = pts.length >= 2 ? median(pts) : medW; // a team of one is compared with everyone
  }
  owners.forEach((o) => {
    const med = teamMed[o.metrics.team] || medW;
    o.metrics.teamMedianPoints = r1(med);
    o.parts.work = 20 * Math.min(1, Math.sqrt(o.metrics.points / med) / 1.3);
  });

  const adj = await all("SELECT a.*, u.display_name AS by_name FROM kpi_adjustments a LEFT JOIN users u ON u.id = a.adjusted_by WHERE month = $1", [R.ym]);
  owners.forEach((o) => {
    const p = o.parts;
    const base = (p.sla ?? 15) + p.resp + p.work + p.div + p.back + p.doc;
    const a = adj.find((x) => x.user_id === o.id);
    o.adjust = a ? { points: a.points, reason: a.reason, by: a.by_name, at: a.updated_at } : null;
    o.base = r1(base);
    o.score = Math.round(clamp(base + p.bonus + p.csat + (a ? a.points : 0), 0, 110));
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
  if (m.deploys) good.push(`Deploy Patch ${m.deploys} เคส`);
  if (m.meetings) good.push(`Meeting กับลูกค้า ${m.meetings} ครั้ง (Onsite ${m.meetingsOnsite || 0} · Online ${m.meetingsOnline || 0})`);
  if (m.sr && m.sr.count) good.push(`ทำคำขอบริการภายในเสร็จ ${m.sr.count} งาน (ทันกำหนด ${m.sr.onTime}) นับเป็นทักษะ ไม่มีคะแนนแยก`);
  if (m.fastClaims) good.push(`รับเคสจากลูกค้าภายใน 1 ชม. ${m.fastClaims} เคส`);
  if (m.csatCount >= 2 && m.csatAvg >= 4) good.push(`ลูกค้าให้คะแนนพึงพอใจเฉลี่ย ${m.csatAvg}/5 (${m.csatCount} คำตอบ)`);
  if (m.slaPct != null && m.slaPct < 70) work.push(`ปิดทัน SLA เพียง ${m.slaPct}%`);
  if (m.overdueAtEnd) work.push(`มีเคสเกิน Due ณ สิ้นเดือน ${m.overdueAtEnd} เคส`);
  if (m.extensions >= 2) work.push(`ขอขยายเวลา ${m.extensions} ครั้ง`);
  if (m.csatLow) work.push(`ลูกค้าให้คะแนนพึงพอใจต่ำ (1–2) ${m.csatLow} ครั้ง`);
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
  const t = d.today();
  const last = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const ym = month || `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
  const r = await compute(ym);
  const recips = await all(
    `SELECT u.id, u.email, u.role, array_remove(array_agg(t.team), NULL) AS teams FROM users u LEFT JOIN user_teams t ON t.user_id = u.id
     WHERE u.active AND u.role IN ('manager','admin') AND u.email IS NOT NULL GROUP BY u.id`
  );
  if (!recips.length || !r.owners.length) return { ok: true, skipped: true, month: ym };
  // Admins get every owner; each manager gets the owners of their own teams. Same owner list = one email.
  const groups = new Map();
  for (const u of recips) {
    const mates = await require("./perms").teamMateIds(u);
    const owners = mates ? r.owners.filter((o) => mates.has(o.id)) : r.owners;
    if (!owners.length) continue;
    const key = owners.map((o) => o.id).join(",");
    if (!groups.has(key)) groups.set(key, { owners, to: [] });
    groups.get(key).to.push(u.email);
  }
  let sent = 0;
  for (const g of groups.values()) {
    await mailMonthly({ ym, r: { ...r, owners: g.owners }, to: g.to });
    sent += g.to.length;
  }
  return { ok: true, month: ym, to: sent, owners: r.owners.length };
}

async function mailMonthly({ ym, r, to }) {
  const graph = require("../graph");
  const { config3 } = require("./config3");
  const { esc, shell, button } = require("../emails");
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
<p style="margin:0 0 4px;font-size:19px;font-weight:700">KPI ราย User · ${esc(label)}</p>
<p style="margin:0 0 16px;color:#5B6576;font-size:14px">คำนวณจากข้อมูลเคสในระบบ${r.team.avgScore != null ? ` · ทีมเฉลี่ย ${r.team.avgScore}` : ""} · ปรับคะแนนได้ ±10 พร้อมเหตุผลในหน้า KPI</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:0 0 16px"><tr>${th("User")}${th("คะแนน", 1)}${th("ดูแล / ปิด", 1)}${th("ทัน SLA", 1)}${th("เกิน Due สิ้นเดือน", 1)}${th("หลากหลาย", 1)}</tr>${rows}</table>
${button(`${config3.baseUrl}/#/kpi?month=${ym}`, "เปิดหน้า KPI")}`
  );
  await graph.sendMail({ to, cc: [], subject: `[Sino Case SLA] KPI ราย User ${label} (ทดลองใช้)`, html });
}

// ------------------------------------------------------------ routes
function mount(api, { wrap, need }) {
  const canAll = (u) => ["admin", "manager", "observer"].includes(u.role);
  const canAdjust = (u) => ["admin", "manager"].includes(u.role);
  api.get("/kpi", wrap(async (req, res) => {
    const r = await compute(req.query.month);
    if (!canAll(req.user)) r.owners = r.owners.filter((o) => o.id === req.user.id);
    else {
      const mates = await require("./perms").teamMateIds(req.user); // a manager sees the engineers of their own teams
      if (mates) r.owners = r.owners.filter((o) => mates.has(o.id));
    }
    res.json({ ...r, canAll: canAll(req.user), canAdjust: canAdjust(req.user), canEditCategories: req.user.role === "admin" });
  }));
  api.get("/kpi/trend/:id(\\d+)", wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!canAll(req.user) && id !== req.user.id) return res.status(403).json({ error: "ดูได้เฉพาะ KPI ของตัวเอง" });
    const mates = await require("./perms").teamMateIds(req.user);
    if (mates && !mates.has(id)) return res.status(403).json({ error: "ดูได้เฉพาะ KPI ของคนในทีมคุณ" });
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
    const mates = await require("./perms").teamMateIds(req.user);
    if (mates && !mates.has(Number(b.userId))) return res.status(403).json({ error: "ปรับคะแนนได้เฉพาะคนในทีมคุณ" });
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

module.exports = { compute, trend, mount, sendMonthly, categories, categorize, diversity, monthRange, DEFAULT_CATEGORIES, grade };
