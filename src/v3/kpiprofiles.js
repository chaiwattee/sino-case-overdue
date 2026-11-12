// KPI "profiles": each team is scored with one set of criteria.
//   support  — customer-case work (the original KPI): SLA, response, work points, diversity, backlog, notes
//   service  — internal service teams (Project Manager, Pre-sale, AI, Sales support): service requests done + done on time
//   response — no KPI (Sales): only a response score as the requester of service requests
//   none     — no KPI at all (e.g. DEV): nobody in the team is scored, ranked or measured; they still send and
//              receive service requests with the usual email / Teams notifications
// Admins change which team uses which profile and the weights; each change applies from a chosen month,
// so months already scored keep the settings they were scored with.
const d = require("../dates");
const { all, getSetting, setSetting, audit } = require("./db");

const PROFILES = {
  support: {
    label: "Support",
    hint: "งานเคสลูกค้า · เกณฑ์เดิม",
    parts: [
      ["sla", "ปิดเคสทัน SLA", 30],
      ["resp", "ความเร็วตอบสนอง", 15],
      ["work", "แต้มงาน (ปริมาณ × ความยาก)", 20],
      ["div", "ความหลากหลาย / Skill", 15],
      ["back", "งานค้างและการขยายเวลา", 10],
      ["doc", "คุณภาพการบันทึก", 10],
    ],
  },
  service: {
    label: "งานบริการภายใน",
    hint: "วัดจากคำขอบริการที่ได้รับมอบหมาย",
    parts: [
      ["volume", "ปริมาณงาน (คำขอที่ทำเสร็จ)", 50],
      ["ontime", "ทำได้ตามเวลาที่กำหนด", 50],
    ],
  },
  response: {
    label: "วัดเฉพาะการตอบกลับ",
    hint: "ไม่คิด KPI · ไม่มีเกรด · ไม่อยู่ในอันดับ",
    parts: [
      ["info", "ตอบเมื่อทีมขอข้อมูลเพิ่ม", 60],
      ["confirm", "ยืนยันรับงานที่เสร็จ", 25],
      ["waiting", "ไม่มีคำขอค้างรอตัวเอง", 15],
    ],
  },
  none: {
    label: "ไม่คิด KPI",
    hint: "ไม่มีคะแนน ไม่อยู่ในอันดับ ไม่วัดรายคน · ส่งและรับคำขอบริการพร้อมแจ้งเตือนตามปกติ",
    parts: [],
  },
};
const DEFAULT_TEAMS = { PROJMGR: "service", PRE_SALE: "service", AI: "service", SALES_SUPPORT: "service", SALES: "response", DEV: "none" };
const defaultWeights = () => Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, Object.fromEntries(p.parts.map(([pk, , w]) => [pk, w]))]));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function versions() {
  const s = await getSetting("kpi_profiles", null);
  return s && Array.isArray(s.versions) ? s.versions : [];
}
/** The settings that apply to month `ym` ("YYYY-MM"). */
async function configFor(ym) {
  const v = (await versions()).filter((x) => x.from <= ym).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
  const w = defaultWeights();
  if (v && v.weights) for (const k of Object.keys(w)) Object.assign(w[k], v.weights[k] || {});
  return { from: v ? v.from : null, teams: { ...DEFAULT_TEAMS, ...((v && v.teams) || {}) }, weights: w };
}
const teamProfile = (cfg, team) => cfg.teams[team] || "support";
/** A person in several teams: any customer-case team → support; else service; else response; only no-KPI teams → none. */
function personProfile(cfg, teams) {
  const ps = (teams || []).map((t) => teamProfile(cfg, t));
  if (!ps.length || ps.includes("support")) return "support";
  if (ps.includes("service")) return "service";
  return ps.includes("response") ? "response" : "none";
}
const partDefs = (cfg, profile) => PROFILES[profile].parts.map(([k, l]) => [k, l, cfg.weights[profile][k]]);

async function teamsOfUsers() {
  const rows = await all("SELECT user_id, array_agg(team ORDER BY team) AS teams FROM user_teams GROUP BY user_id");
  return new Map(rows.map((r) => [r.user_id, r.teams]));
}

const r1 = (x) => Math.round(x * 10) / 10;
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Service-profile scores for month R. Returns owner objects shaped like the case KPI ones
 * (id, name, metrics, parts) for every active engineer / manager whose profile is "service".
 */
async function serviceOwners(R, cfg, teamsOf) {
  const users = await all("SELECT id, display_name AS name, email, active FROM users WHERE active AND role IN ('engineer','manager')");
  const people = users.filter((u) => personProfile(cfg, teamsOf.get(u.id)) === "service");
  if (!people.length) return [];
  const ids = people.map((u) => u.id);
  const nextIso = d.toISODate(d.addDays(R.to, 1));
  const done = await all(
    `SELECT s.id, s.assignee_id, s.team, s.outcome, s.category, s.target_date, (s.closed_at AT TIME ZONE 'Asia/Bangkok')::date AS closed,
            (SELECT (e.data->>'target') FROM sr_events e WHERE e.sr_id = s.id AND e.kind = 'approved' ORDER BY e.created_at LIMIT 1) AS first_target
       FROM service_requests s
      WHERE s.status = 'done' AND s.outcome <> 'duplicate' AND s.assignee_id = ANY($1)
        AND s.closed_at >= $2 AND s.closed_at < $3`,
    [ids, R.fromIso, nextIso]
  );
  const openNow = await all(
    `SELECT assignee_id, count(*)::int AS n, count(*) FILTER (WHERE target_date < CURRENT_DATE)::int AS late
       FROM service_requests WHERE status = 'in_progress' AND assignee_id = ANY($1) GROUP BY assignee_id`,
    [ids]
  );
  const ratings = await all(
    `SELECT assignee_id, rating FROM service_requests WHERE rating IS NOT NULL AND assignee_id = ANY($1) AND confirmed_at >= $2 AND confirmed_at < $3`,
    [ids, R.fromIso, nextIso]
  );
  const iso = (x) => (x instanceof Date ? d.toISODate(x) : x ? String(x).slice(0, 10) : null);
  const out = people.map((u) => {
    const mine = done.filter((s) => s.assignee_id === u.id);
    let on = 0, half = 0, late = 0;
    for (const s of mine) {
      const c = iso(s.closed);
      const first = iso(s.first_target) || iso(s.target_date);
      if (first && c <= first) on++;
      else if (iso(s.target_date) && c <= iso(s.target_date)) half++;
      else late++;
    }
    const rt = ratings.filter((x) => x.assignee_id === u.id).map((x) => Number(x.rating));
    const op = openNow.find((x) => x.assignee_id === u.id);
    const svcTeams = (teamsOf.get(u.id) || []).filter((t) => teamProfile(cfg, t) === "service");
    const cats = {};
    mine.forEach((s) => s.category && (cats[s.category] = (cats[s.category] || 0) + 1));
    const m = {
      team: svcTeams[0] || null,
      srDone: mine.length, srOnTime: on, srAfterExt: half, srLate: late,
      srOnTimePct: mine.length ? Math.round(((on + half / 2) / mine.length) * 100) : null,
      srOpen: op ? op.n : 0, srOverdueNow: op ? op.late : 0,
      ratingCount: rt.length, ratingAvg: rt.length ? r1(rt.reduce((a, b) => a + b, 0) / rt.length) : null,
      closed: mine.length,
    };
    return { id: u.id, name: u.name, email: u.email, active: u.active, handled: mine.length, profile: "service", metrics: m, types: cats, products: {}, sites: {}, kinds: {}, parts: {} };
  });
  // Volume against the median of the same team (a team of one is compared with every service person).
  const all0 = out.map((o) => o.metrics.srDone).filter((n) => n > 0);
  const medAll = median(all0) || 1;
  const w = cfg.weights.service;
  for (const o of out) {
    const same = out.filter((x) => x.metrics.team === o.metrics.team).map((x) => x.metrics.srDone).filter((n) => n > 0);
    const med = same.length >= 2 ? median(same) : medAll;
    o.metrics.teamMedianDone = r1(med);
    const m = o.metrics;
    o.parts.volume = m.srDone ? w.volume * Math.min(1, Math.sqrt(m.srDone / med) / 1.3) : 0;
    o.parts.ontime = m.srDone ? (w.ontime * (m.srOnTime + m.srAfterExt / 2)) / m.srDone : w.ontime / 2;
    o.parts.bonus = 0;
    // Requester satisfaction (5): rewards only, from 2 ratings in the month.
    o.parts.csat = m.ratingCount >= 2 ? (m.ratingAvg >= 4.5 ? 5 : m.ratingAvg >= 4 ? 3 : m.ratingAvg >= 3.5 ? 1 : 0) : 0;
  }
  return out.filter((o) => o.metrics.srDone || o.metrics.srOpen); // no work at all this month: not listed
}

/** Response score of requesters (profile "response") for month R. `ids` limits the people computed. */
async function responseScores(R, cfg, ids) {
  const sr = require("./sr");
  const hol = await sr.holidays();
  const w = cfg.weights.response;
  const today = d.toISODate(d.today());
  const nextIso = d.toISODate(d.addDays(R.to, 1));
  const current = R.fromIso <= today && today <= R.toIso;
  const iso = (x) => d.toISODate(new Date(x));
  const asks = await all(
    `SELECT s.requester_id, s.id, s.sr_no, s.title, e.created_at AS asked_at, e.text,
            (SELECT min(x.created_at) FROM sr_events x WHERE x.sr_id = s.id AND x.created_at > e.created_at AND x.by_user = s.requester_id
                AND x.kind IN ('resubmitted','edited','update','cancelled')) AS replied_at
       FROM sr_events e JOIN service_requests s ON s.id = e.sr_id
      WHERE e.kind = 'info' AND s.requester_id = ANY($1) AND e.created_at >= $2 AND e.created_at < $3`,
    [ids, R.fromIso, nextIso]
  );
  const closed = await all(
    `SELECT requester_id, id, sr_no, title, closed_at, confirmed_at FROM service_requests
      WHERE status = 'done' AND outcome = 'delivered' AND requester_id = ANY($1) AND closed_at >= $2 AND closed_at < $3`,
    [ids, R.fromIso, nextIso]
  );
  const sent = await all(
    `SELECT requester_id, count(*)::int AS n FROM service_requests WHERE requester_id = ANY($1) AND created_at >= $2 AND created_at < $3 GROUP BY requester_id`,
    [ids, R.fromIso, nextIso]
  );
  // Waiting on the requester right now: info asked 2+ working days ago, or finished work not confirmed after 2 working days (within the 7-day window).
  const waitingRows = current
    ? await all(
        `SELECT s.requester_id, s.id, s.sr_no, s.title, s.status, s.closed_at,
                (SELECT max(e.created_at) FROM sr_events e WHERE e.sr_id = s.id AND e.kind = 'info') AS asked_at, s.team
           FROM service_requests s
          WHERE s.requester_id = ANY($1)
            AND (s.status = 'info' OR (s.status = 'done' AND s.outcome = 'delivered' AND s.confirmed_at IS NULL AND s.closed_at > now() - interval '7 days'))`,
        [ids]
      )
    : [];
  const out = new Map();
  for (const id of ids) {
    const a = asks.filter((x) => x.requester_id === id);
    const replies = [];
    let infoSum = 0, infoN = 0;
    for (const x of a) {
      const from = iso(x.asked_at);
      if (x.replied_at) {
        const wd = sr.workdaysBetween(from, iso(x.replied_at), hol);
        infoSum += wd <= 1 ? 1 : wd === 2 ? 0.6 : wd === 3 ? 0.3 : 0;
        infoN++;
        replies.push((new Date(x.replied_at) - new Date(x.asked_at)) / 3600000);
      } else if (sr.workdaysBetween(from, today, hol) > 1) infoN++; // still unanswered after a working day: 0
    }
    const cl = closed.filter((x) => x.requester_id === id);
    const decided = cl.filter((x) => x.confirmed_at || new Date(x.closed_at) < new Date(Date.now() - 7 * 86400000));
    const conf = decided.filter((x) => x.confirmed_at && new Date(x.confirmed_at) - new Date(x.closed_at) <= 7 * 86400000).length;
    const waiting = waitingRows
      .filter((x) => x.requester_id === id)
      .map((x) => {
        const since = iso(x.status === "info" ? x.asked_at : x.closed_at);
        return { id: x.id, srNo: x.sr_no, title: x.title, what: x.status === "info" ? "ทีมขอข้อมูลเพิ่ม" : "งานเสร็จ รอยืนยันรับงาน", days: sr.workdaysBetween(since, today, hol) };
      })
      .filter((x) => x.days >= 2)
      .sort((p, q) => q.days - p.days);
    const n = (sent.find((x) => x.requester_id === id) || {}).n || 0;
    const parts = {
      info: infoN ? (w.info * infoSum) / infoN : w.info,
      confirm: decided.length ? (w.confirm * conf) / decided.length : w.confirm,
      waiting: w.waiting * Math.max(0, 1 - 0.34 * waiting.length),
    };
    const any = n || a.length || cl.length || waiting.length;
    const med = median(replies);
    out.set(id, {
      score: any ? Math.round(parts.info + parts.confirm + parts.waiting) : null,
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r1(v)])),
      stats: { sent: n, asked: a.length, answered: replies.length, medianReplyHrs: replies.length ? r1(med) : null, closed: cl.length, confirmed: conf, decided: decided.length },
      waiting,
    });
  }
  return out;
}

function validate(b, teams) {
  const from = String(b.from || "");
  if (!/^\d{4}-\d{2}$/.test(from)) throw bad("เลือกเดือนที่เริ่มใช้");
  const codes = new Set(teams.map((t) => t.code));
  const tm = {};
  for (const [k, v] of Object.entries(b.teams || {})) {
    if (!codes.has(k)) continue;
    if (!PROFILES[v]) throw bad(`ชุดเกณฑ์ของทีม ${k} ไม่ถูกต้อง`);
    tm[k] = v;
  }
  const weights = {};
  for (const [p, def] of Object.entries(PROFILES)) {
    const src = (b.weights || {})[p] || {};
    weights[p] = {};
    let sum = 0;
    for (const [k, label, dflt] of def.parts) {
      const v = src[k] == null ? dflt : Number(src[k]);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw bad(`${def.label}: ${label} ต้องเป็นเลข 0–100`);
      weights[p][k] = v;
      sum += v;
    }
    if (def.parts.length && sum !== 100) throw bad(`${def.label}: น้ำหนักรวมต้องเท่ากับ 100 (ตอนนี้ ${sum})`);
  }
  return { from, teams: tm, weights };
}

function mount(api, { wrap, need }) {
  api.get("/kpi/profiles", need("settings_manage"), wrap(async (req, res) => {
    const t = d.today();
    const ym = req.query.month || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
    const cfg = await configFor(ym);
    const teams = await all("SELECT code, label FROM teams ORDER BY sort, code");
    res.json({
      month: ym, from: cfg.from,
      profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, { label: p.label, hint: p.hint, parts: partDefs(cfg, k) }])),
      teams: teams.map((x) => ({ ...x, profile: teamProfile(cfg, x.code) })),
      versions: (await versions()).map((v) => ({ from: v.from, by: v.by, at: v.at })).sort((a, b) => (a.from < b.from ? 1 : -1)),
    });
  }));
  api.put("/kpi/profiles", need("settings_manage"), wrap(async (req, res) => {
    const teams = await all("SELECT code FROM teams");
    const v = validate(req.body || {}, teams);
    const list = (await versions()).filter((x) => x.from !== v.from);
    list.push({ ...v, by: req.user.display_name || req.user.email, at: new Date().toISOString() });
    await setSetting("kpi_profiles", { versions: list });
    await audit(req.user, "kpi.profiles", v.from, v);
    res.json({ ok: true });
  }));
}

module.exports = { PROFILES, configFor, teamProfile, personProfile, partDefs, teamsOfUsers, serviceOwners, responseScores, mount };
