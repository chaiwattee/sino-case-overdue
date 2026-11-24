// Response times between us and NICE on cases with a CS Number, read from the case activities.
//   NICE side: from our reply ("ตอบ NICE") to NICE's next answer ("อัปเดตจาก NICE", or "NICE ตอบ (นอก email)").
//              Counted round the clock (default) or in our working time.
//   Sino side: from NICE's answer to our next reply or team activity. Counted in working time only:
//              Mon–Fri, not holidays, between the business hours of customer intake (default 08:30–17:30).
// Shown on the case NICE card and in Report → NICE / Sino Response. Information only: not part of the engineer KPI.
const { config } = require("../config");
const { config3 } = require("./config3");
const graph = require("../graph");
const { esc, shell, fieldTable, button } = require("../emails");
const { q, one, all, getSetting, setSetting, audit } = require("./db");

const IN = "อัปเดตจาก NICE";
const OUT = "ตอบ NICE";
const MANUAL = "NICE ตอบ (นอก email)";
const H = 3600000;
const DEF = {
  niceMode: "24h", // "24h" | "business"
  niceTargets: { Critical: 2, High: 24, Medium: 48, Low: 72 }, // hours
  sinoTargets: { Critical: 1, High: 4, Medium: 9, Low: 18 }, // working hours (9 = one working day)
  notify: true,
  workStart: "08:30",
  workEnd: "17:30",
};
const IMPACTS = ["Critical", "High", "Medium", "Low"];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function settings() {
  const s = (await getSetting("nice_response", null)) || {};
  return { ...DEF, ...s, niceTargets: { ...DEF.niceTargets, ...(s.niceTargets || {}) }, sinoTargets: { ...DEF.sinoTargets, ...(s.sinoTargets || {}) } };
}
async function saveSettings(user, b) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 720 ? Math.round(n * 10) / 10 : d; };
  const cur = await settings();
  const next = {
    niceMode: b.niceMode === "business" ? "business" : "24h",
    niceTargets: Object.fromEntries(IMPACTS.map((k) => [k, num(b.niceTargets?.[k], cur.niceTargets[k])])),
    sinoTargets: Object.fromEntries(IMPACTS.map((k) => [k, num(b.sinoTargets?.[k], cur.sinoTargets[k])])),
    notify: b.notify !== false,
    workStart: /^\d{2}:\d{2}$/.test(b.workStart || "") ? b.workStart : cur.workStart,
    workEnd: /^\d{2}:\d{2}$/.test(b.workEnd || "") ? b.workEnd : cur.workEnd,
  };
  if (next.workEnd <= next.workStart) throw bad("เวลาเลิกงานต้องหลังเวลาเริ่มงาน");
  await setSetting("nice_response", next);
  await audit(user, "nice_response_settings", null, next);
  return next;
}

// ------------------------------------------------------------ working time
async function calendar() {
  const st = await settings();
  const hol = new Set(((await getSetting("holidays", null)) || []).map((x) => String(x).slice(0, 10)));
  const mins = (t) => { const [h, m] = String(t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  return { start: mins(st.workStart), end: mins(st.workEnd), hol, label: `${st.workStart}–${st.workEnd}` };
}
const BKK = 7 * H;
/** Working milliseconds between two instants (Bangkok time, Mon–Fri, not holidays, within business hours). */
function workMs(a, b, cal) {
  if (!(b > a)) return 0;
  let total = 0;
  let day = new Date(Math.floor((a.getTime() + BKK) / 86400000) * 86400000); // Bangkok midnight, as UTC-shifted
  const endShift = b.getTime() + BKK;
  for (let i = 0; i < 400 && day.getTime() < endShift; i++, day = new Date(day.getTime() + 86400000)) {
    const iso = day.toISOString().slice(0, 10);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6 || cal.hol.has(iso)) continue;
    const s = day.getTime() + cal.start * 60000, e = day.getTime() + cal.end * 60000;
    const from = Math.max(s, a.getTime() + BKK), to = Math.min(e, endShift);
    if (to > from) total += to - from;
  }
  return total;
}
const dur = (ms, mode) => (mode === "business" ? null : ms);

// ------------------------------------------------------------ exchanges
/** Walk a case's activities: who holds the ball, and every answer with how long it took. */
function exchanges(acts, cal, s, impact, closedAt) {
  const rows = [];
  let ball = null, since = null, sinceBy = null;
  const sorted = acts.slice().sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  for (const a of sorted) {
    const t = new Date(a.created_at);
    const isIn = a.kind === IN || a.kind === MANUAL;
    const isOut = a.kind === OUT;
    const isTeam = !a.is_system && !isOut;
    if (isIn) {
      if (ball === "nice") rows.push(entry("nice", since, t, sinceBy, a, cal, s, impact));
      if (ball !== "sino") { ball = "sino"; since = t; sinceBy = a; }
    } else if (isOut || isTeam) {
      if (ball === "sino") rows.push(entry("sino", since, t, sinceBy, a, cal, s, impact));
      if (isOut) { ball = "nice"; since = t; sinceBy = a; }
      else if (ball === "sino") { ball = null; since = null; }
    }
  }
  if (closedAt && ball && since && new Date(closedAt) > since) ball = null;
  return { rows, ball, since, sinceBy };
}
function entry(side, from, to, startAct, endAct, cal, s, impact) {
  const ms = side === "sino" || s.niceMode === "business" ? workMs(from, to, cal) : to - from;
  const target = (side === "nice" ? s.niceTargets : s.sinoTargets)[impact || "Medium"] || (side === "nice" ? s.niceTargets.Medium : s.sinoTargets.Medium);
  return { side, from, to, hours: Math.round((ms / H) * 10) / 10, target, late: ms > target * H, by: endAct.by || null, startBy: startAct.by || null };
}
function current(x, cal, s, impact, now = new Date()) {
  if (!x.ball) return null;
  const ms = x.ball === "sino" || s.niceMode === "business" ? workMs(x.since, now, cal) : now - x.since;
  const target = (x.ball === "nice" ? s.niceTargets : s.sinoTargets)[impact || "Medium"];
  return { ball: x.ball, since: x.since, hours: Math.round((ms / H) * 10) / 10, target, late: ms > target * H, near: ms > target * H * 0.75, by: x.sinceBy && x.sinceBy.by };
}
const avg = (r) => (r.length ? Math.round((r.reduce((a, b) => a + b.hours, 0) / r.length) * 10) / 10 : null);

async function actsFor(ids) {
  if (!ids.length) return new Map();
  const rows = await all(
    `SELECT a.case_id, a.kind, a.is_system, a.created_at, u.display_name AS by
       FROM case_activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.case_id = ANY($1)`,
    [ids]
  );
  const m = new Map();
  rows.forEach((r) => (m.get(r.case_id) || m.set(r.case_id, []).get(r.case_id)).push(r));
  return m;
}
const OPEN_SQL = `lower(coalesce(c.status,'')) NOT IN (${config.closedStatuses.map((x) => `'${String(x).toLowerCase().replace(/'/g, "''")}'`).join(",")})`;

/** NICE card on one case. */
async function forCase(caseId, { full = false } = {}) {
  const c = await one(`SELECT c.id, c.cs_number, c.nice_impact, c.end_date, ${OPEN_SQL} AS open FROM cases c WHERE c.id = $1`, [caseId]);
  if (!c || !c.cs_number) return null;
  const [s, cal] = [await settings(), await calendar()];
  const acts = (await actsFor([c.id])).get(c.id) || [];
  if (!acts.some((a) => a.kind === IN || a.kind === OUT || a.kind === MANUAL)) return null;
  const x = exchanges(acts, cal, s, c.nice_impact, c.open ? null : c.end_date || new Date());
  const nice = x.rows.filter((r) => r.side === "nice"), sino = x.rows.filter((r) => r.side === "sino");
  return {
    now: c.open ? current(x, cal, s, c.nice_impact) : null,
    nice: { avg: avg(nice), n: nice.length, late: nice.filter((r) => r.late).length },
    sino: { avg: avg(sino), n: sino.length, late: sino.filter((r) => r.late).length },
    timeline: (full ? x.rows : x.rows.slice(-8)).slice().reverse(),
    targets: { nice: s.niceTargets[c.nice_impact || "Medium"], sino: s.sinoTargets[c.nice_impact || "Medium"] },
    niceMode: s.niceMode, hours: cal.label,
  };
}

/** Report for one month: answers that finished in the month, and cases waiting now. */
async function report(user, { month, team }) {
  const m = /^\d{4}-\d{2}$/.test(month || "") ? month : new Date(Date.now() + BKK).toISOString().slice(0, 7);
  const from = new Date(`${m}-01T00:00:00+07:00`);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const prevFrom = new Date(from); prevFrom.setMonth(prevFrom.getMonth() - 1);
  const scopeAll = ["admin", "observer"].includes(user.role);
  const teams = scopeAll ? null : user.teams || [];
  const params = [prevFrom];
  let where = `c.cs_number IS NOT NULL AND c.cs_number <> '' AND EXISTS (SELECT 1 FROM case_activities a WHERE a.case_id = c.id AND a.kind IN ('${IN}','${OUT}','${MANUAL}') AND a.created_at >= $1)`;
  if (teams) { params.push(teams); where += ` AND c.team = ANY($${params.length})`; }
  if (team) { params.push(team); where += ` AND c.team = $${params.length}`; }
  const cases = await all(
    `SELECT c.id, c.case_no, c.cs_number, c.site, c.team, c.nice_impact, c.end_date, ${OPEN_SQL} AS open, u.display_name AS owner
       FROM cases c LEFT JOIN users u ON u.id = c.owner_id WHERE ${where}`, params);
  const [s, cal] = [await settings(), await calendar()];
  const acts = await actsFor(cases.map((c) => c.id));
  const done = [], prev = [], waiting = [];
  for (const c of cases) {
    const x = exchanges(acts.get(c.id) || [], cal, s, c.nice_impact, c.open ? null : c.end_date || new Date());
    for (const r of x.rows) {
      const row = { ...r, caseId: c.id, caseNo: c.case_no, cs: c.cs_number, site: c.site, team: c.team, impact: c.nice_impact || "Medium", owner: c.owner };
      if (r.to >= from && r.to < to) done.push(row);
      else if (r.to >= prevFrom && r.to < from) prev.push(row);
    }
    if (c.open) { const n = current(x, cal, s, c.nice_impact); if (n) waiting.push({ ...n, caseId: c.id, caseNo: c.case_no, cs: c.cs_number, site: c.site, team: c.team, impact: c.nice_impact || "Medium", owner: c.owner }); }
  }
  const side = (k) => {
    const r = done.filter((x) => x.side === k), p = prev.filter((x) => x.side === k);
    const byImpact = IMPACTS.map((i) => { const z = r.filter((x) => x.impact === i); return { impact: i, n: z.length, avg: avg(z), target: (k === "nice" ? s.niceTargets : s.sinoTargets)[i], onTime: z.length ? Math.round((z.filter((x) => !x.late).length / z.length) * 100) : null }; });
    const people = {};
    if (k === "sino") r.forEach((x) => { const n = x.by || "-"; (people[n] = people[n] || []).push(x); });
    const weeks = {};
    r.forEach((x) => { const d = new Date(x.to.getTime() + BKK); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const w = d.toISOString().slice(0, 10); (weeks[w] = weeks[w] || []).push(x); });
    return {
      n: r.length, avg: avg(r), prevAvg: avg(p), onTime: r.length ? Math.round((r.filter((x) => !x.late).length / r.length) * 100) : null, late: r.filter((x) => x.late).length,
      byImpact,
      people: Object.entries(people).map(([name, z]) => ({ name, n: z.length, avg: avg(z), late: z.filter((x) => x.late).length })).sort((a, b) => b.avg - a.avg),
      weeks: Object.entries(weeks).sort().map(([w, z]) => ({ week: w, avg: avg(z), n: z.length })),
      waiting: waiting.filter((w) => w.ball === k).sort((a, b) => b.hours - a.hours),
      rows: r.sort((a, b) => b.to - a.to).slice(0, 300),
    };
  };
  return { month: m, settings: s, hours: cal.label, nice: side("nice"), sino: side("sino") };
}

// ------------------------------------------------------------ reminders
/** Tell the owner once when a case passes the target (either side). */
async function remind() {
  const s = await settings();
  if (!s.notify || config.mock) return { skipped: true };
  const cases = await all(
    `SELECT c.id, c.case_no, c.cs_number, c.site, c.nice_impact, c.owner_id, u.email AS owner_email FROM cases c LEFT JOIN users u ON u.id = c.owner_id
      WHERE ${OPEN_SQL} AND c.cs_number IS NOT NULL AND c.nice_last_at > now() - interval '60 days'`);
  if (!cases.length) return { sent: 0 };
  const cal = await calendar();
  const acts = await actsFor(cases.map((c) => c.id));
  const sent = (await getSetting("nice_response_sent", null)) || {};
  let n = 0;
  for (const c of cases) {
    const now = current(exchanges(acts.get(c.id) || [], cal, s, c.nice_impact, null), cal, s, c.nice_impact);
    if (!now || !now.late || !c.owner_id) continue;
    const key = `${c.id}:${now.ball}:${now.since.toISOString()}`;
    if (sent[key]) continue;
    sent[key] = Date.now();
    n++;
    const who = now.ball === "nice" ? "NICE ยังไม่ตอบ" : "NICE รอทีมเราตอบ";
    const ref = c.case_no || `#${c.id}`;
    await require("./push").send([c.owner_id], { title: `${who} · ${c.cs_number}`, body: `${ref} · ${c.site || ""} · ${fmt(now.hours)} (เป้า ${fmt(now.target)})`, url: `/#/case/${c.id}`, tag: `niceresp-${c.id}` }).catch(() => {});
    if (c.owner_email)
      await graph.sendMail({ to: [c.owner_email], cc: [], subject: `[${who}] ${ref} · ${c.cs_number}`,
        html: shell("#C98A00", `<p style="margin:0 0 14px">${esc(who)} เกินเป้าแล้ว${now.ball === "nice" ? " ลองเร่ง NICE ทาง Self Service Portal" : " ช่วยตอบ NICE"}</p>
${fieldTable([["เคส", ref], ["CS", c.cs_number], ["Impact", c.nice_impact || "-"], ["รอมาแล้ว", fmt(now.hours) + (now.ball === "sino" ? " (เวลาทำงาน)" : "")], ["เป้า", fmt(now.target)]])}
${button(`${config3.baseUrl}/#/case/${c.id}`, "เปิดเคส")}`) }).catch((e) => console.warn("[niceresp] mail:", e.message));
  }
  const cutoff = Date.now() - 90 * 86400000;
  Object.keys(sent).forEach((k) => sent[k] < cutoff && delete sent[k]);
  await setSetting("nice_response_sent", sent);
  return { sent: n };
}
function fmt(h) {
  if (h == null) return "-";
  if (h < 1) return `${Math.round(h * 60)} นาที`;
  if (h < 24) return `${Math.round(h * 10) / 10} ชม.`;
  const d = Math.floor(h / 24), r = Math.round(h - d * 24);
  return `${d} วัน${r ? ` ${r} ชม.` : ""}`;
}

function mount(api, { wrap, need, loadVisible }) {
  api.get("/nice-response/settings", need("settings_manage"), wrap(async (req, res) => res.json({ settings: await settings(), hours: (await calendar()).label })));
  api.put("/nice-response/settings", need("settings_manage"), wrap(async (req, res) => res.json({ ok: true, settings: await saveSettings(req.user, req.body || {}) })));
  // Search one case by CS Number or our case number: the whole back-and-forth with NICE.
  api.get("/reports/nice-response/search", wrap(async (req, res) => {
    if (["viewer", "requester"].includes(req.user.role)) throw bad("ไม่มีสิทธิ์ดูรายงานนี้", 403);
    const t = String(req.query.q || "").trim().slice(0, 60);
    if (t.length < 3) throw bad("พิมพ์อย่างน้อย 3 ตัวอักษร");
    const params = [`%${t.toLowerCase()}%`];
    let where = "(lower(c.cs_number) LIKE $1 OR lower(c.case_no) LIKE $1) AND coalesce(c.cs_number,'') <> ''";
    if (!["admin", "observer"].includes(req.user.role)) { params.push(req.user.teams || []); where += ` AND c.team = ANY($2)`; }
    const cases = await all(
      `SELECT c.id, c.case_no, c.cs_number, c.site, c.team, c.task, c.status, c.nice_impact, u.display_name AS owner
         FROM cases c LEFT JOIN users u ON u.id = c.owner_id WHERE ${where} ORDER BY c.id DESC LIMIT 10`, params);
    const items = [];
    for (const c of cases) items.push({ caseId: c.id, caseNo: c.case_no, cs: c.cs_number, site: c.site, team: c.team, task: c.task, status: c.status, impact: c.nice_impact || "Medium", owner: c.owner, resp: await forCase(c.id, { full: true }) });
    res.json({ items });
  }));
  api.get("/reports/nice-response", wrap(async (req, res) => {
    if (["viewer", "requester"].includes(req.user.role)) throw bad("ไม่มีสิทธิ์ดูรายงานนี้", 403);
    res.json(await report(req.user, { month: req.query.month, team: req.query.team || "" }));
  }));
  // Talked to NICE outside email (phone / Teams): stop the NICE clock.
  api.post("/case/:id(\\d+)/nice-manual", wrap(async (req, res) => {
    const c = await loadVisible(req);
    if (!c.csNumber) throw bad("เคสนี้ยังไม่มี CS Number");
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    if (note.length < 5) throw bad("สรุปสั้นๆ ว่า NICE ตอบว่าอะไร");
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system, created_by) VALUES ($1, current_date, $2, $3, true, $4)", [c.id, MANUAL, note, req.user.id]);
    await audit(req.user, "nice_manual_answer", c.csNumber, { case_id: c.id });
    res.json({ ok: true, response: await forCase(c.id) });
  }));
}

module.exports = { settings, saveSettings, forCase, report, remind, workMs, exchanges, mount, fmt, IN, OUT, MANUAL };
