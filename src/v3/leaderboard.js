// KPI ranking over 1 / 3 / 6 / 12 months, built from the monthly KPI (kpi.compute), plus user avatars.
//
// While on trial only admins, managers and observers see it (setting "leaderboard".visibility = "managers").
// With "all", everyone else sees the top N and their own row only; nobody else's low rank is shown to them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const d = require("../dates");
const { one, all, q, getSetting, setSetting, audit } = require("./db");
const kpi = require("./kpi");

const AVATAR_KEYS = ["fox", "owl", "tiger", "cat", "panda", "koala", "octo", "penguin", "lion", "frog", "dolphin", "unicorn", "rocket", "robot", "headset", "wrench", "coffee", "star"];
const AVATAR_DIR = path.resolve(process.env.INTAKE_FILE_DIR || path.join(__dirname, "..", "..", "data", "intake-files"), "avatars");
const PERIODS = [1, 3, 6, 12];
const DEFAULTS = { visibility: "managers", publicTop: 5, minCases: 5 };
const MANAGERS = ["admin", "manager", "observer"];
const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r1 = (x) => Math.round(x * 10) / 10;

async function settings() {
  return { ...DEFAULTS, ...((await getSetting("leaderboard", null)) || {}) };
}
const canSee = (user, s) => !!user && (MANAGERS.includes(user.role) || (s.visibility === "all" && ["engineer", "manager"].includes(user.role)));

const ymOf = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
function monthsBack(endYm, n) {
  const [y, m] = endYm.split("-").map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(ymOf(new Date(y, m - 1 - i, 1)));
  return out;
}
const label = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${TH_MON[m - 1]} ${String(y + 543).slice(2)}`;
};
const periodLabel = (ms) => (ms.length === 1 ? label(ms[0]) : `${label(ms[0])} – ${label(ms[ms.length - 1])}`);

/** Aggregate several months: score weighted by cases handled, parts likewise; badges inputs collected. */
function aggregate(monthly, ms, minCases) {
  const by = new Map();
  ms.forEach((ym, idx) => {
    for (const o of monthly.get(ym).owners) {
      if (!o.handled) continue;
      const a = by.get(o.id) || { id: o.id, name: o.name, email: o.email, handled: 0, w: 0, sum: 0, parts: {}, closed: 0, onTime: 0, newSkills: new Set(), sr: 0, months: [], scoredMonths: 0 };
      const w = Math.max(1, o.handled);
      a.handled += o.handled;
      a.w += w;
      a.sum += o.score * w;
      for (const [k, v] of Object.entries(o.parts)) if (v != null) a.parts[k] = (a.parts[k] || 0) + v * w;
      a.closed += o.metrics.closed || 0;
      a.onTime += o.metrics.onTime || 0;
      (o.metrics.newSkills || []).forEach((x) => a.newSkills.add(x));
      a.sr += (o.metrics.sr && o.metrics.sr.count) || 0;
      if (!o.insufficient) a.scoredMonths++;
      a.months[idx] = { ym, score: o.score, handled: o.handled };
      by.set(o.id, a);
    }
  });
  const rows = [...by.values()].map((a) => ({
    id: a.id, name: a.name, email: a.email,
    score: r1(a.sum / a.w),
    parts: Object.fromEntries(Object.entries(a.parts).map(([k, v]) => [k, r1(v / a.w)])),
    cases: a.handled, closed: a.closed,
    slaPct: a.closed ? Math.round((a.onTime / a.closed) * 100) : null,
    newSkills: [...a.newSkills], sr: a.sr,
    months: ms.map((ym, i) => a.months[i] || { ym, score: null, handled: 0 }),
    eligible: a.handled >= minCases && a.closed >= Math.min(3, minCases),
  }));
  rows.sort((x, y) => y.eligible - x.eligible || y.score - x.score || (y.slaPct ?? -1) - (x.slaPct ?? -1));
  let rank = 0;
  rows.forEach((r) => (r.rank = r.eligible ? ++rank : null));
  return rows;
}

async function build({ n, endYm, team, viewer }) {
  const s = await settings();
  const nowYm = ymOf(d.today());
  endYm = /^\d{4}-\d{2}$/.test(endYm || "") && endYm <= nowYm ? endYm : nowYm;
  n = PERIODS.includes(Number(n)) ? Number(n) : 1;
  const ms = monthsBack(endYm, n);
  // previous window of the same length; for a year, the same 12 months ending one month earlier
  const prevMs = n === 12 ? monthsBack(monthsBack(endYm, 2)[0], 12) : monthsBack(monthsBack(endYm, n + 1)[0], n);
  const streakMs = monthsBack(endYm, 3);
  const trendMs = monthsBack(endYm, 6);
  const need = [...new Set([...ms, ...prevMs, ...streakMs, ...trendMs])];
  const monthly = new Map();
  for (const ym of need) monthly.set(ym, await kpi.compute(ym)); // sequential: compute is DB-heavy

  const teamsOf = new Map();
  for (const r of await all("SELECT user_id, array_agg(team ORDER BY team) AS teams FROM user_teams GROUP BY user_id")) teamsOf.set(r.user_id, r.teams);
  const users = new Map((await all("SELECT id, display_name, avatar, role, active FROM users")).map((u) => [u.id, u]));
  // Managers and engineers rank only within their own teams; admin / observer see every team.
  const scope = require("./perms").teamScope(viewer);
  if (scope && team && !scope.includes(team)) team = "";
  const inTeam = (id) => {
    const ts = teamsOf.get(id) || [];
    if (team) return ts.includes(team);
    return !scope || ts.some((t) => scope.includes(t));
  };

  const filt = (rows) => {
    const out = rows.filter((r) => inTeam(r.id) && users.get(r.id)?.active !== false);
    let k = 0;
    out.forEach((r) => (r.rank = r.eligible ? ++k : null));
    return out;
  };
  const rows = filt(aggregate(monthly, ms, s.minCases));
  const prev = new Map(filt(aggregate(monthly, prevMs, s.minCases)).map((r) => [r.id, r]));
  const streak = streakMs.map((ym) => new Map(filt(aggregate(monthly, [ym], s.minCases)).map((r) => [r.id, r.rank])));

  for (const r of rows) {
    const p = prev.get(r.id);
    r.prevRank = p ? p.rank : null;
    r.delta = p && p.rank && r.rank ? p.rank - r.rank : null;
    r.scoreDelta = p ? r1(r.score - p.score) : null;
    const u = users.get(r.id) || {};
    r.name = u.display_name || r.name;
    r.avatar = u.avatar || null;
    r.teams = teamsOf.get(r.id) || [];
    r.trend = trendMs.map((ym) => {
      const o = monthly.get(ym).owners.find((x) => x.id === r.id);
      return { ym, label: label(ym), score: o && o.handled ? o.score : null };
    });
    const allScores = r.trend.map((t) => t.score).filter((x) => x != null);
    r.personalBest = n === 1 && r.trend[5].score != null && allScores.length >= 3 && r.trend[5].score >= Math.max(...allScores);
    r.badges = [];
  }
  // Badges: several ways to be recognised besides the top 3.
  const ranked = rows.filter((r) => r.rank);
  const improved = ranked.filter((r) => r.scoreDelta != null && r.scoreDelta > 0).sort((a, b) => b.scoreDelta - a.scoreDelta)[0];
  if (improved) improved.badges.push("improved");
  for (const r of ranked) {
    if (r.closed >= 3 && r.slaPct === 100) r.badges.push("sla100");
    if (r.newSkills.length) r.badges.push("skill");
    if ((r.parts.doc ?? 0) >= 9.5) r.badges.push("doc");
    if (streak.every((m) => (m.get(r.id) || 99) <= 5)) r.badges.push("streak");
    if (r.personalBest) r.badges.push("best");
  }
  // Race frames: running (cumulative) score month by month inside the window.
  const frames = ms.map((ym, i) => ({ ym, label: label(ym), rows: filt(aggregate(monthly, ms.slice(0, i + 1), 1)).map((r) => ({ id: r.id, score: r.score })) }));

  // What this viewer may see.
  const isMgr = MANAGERS.includes(viewer.role);
  const visible = isMgr ? rows : rows.filter((r) => (r.rank && r.rank <= s.publicTop) || r.id === viewer.id);
  const ids = new Set(visible.map((r) => r.id));
  return {
    period: { n, months: ms, label: periodLabel(ms), prevLabel: periodLabel(prevMs), current: endYm === nowYm },
    settings: s, isManager: isMgr, viewerId: viewer.id, team: team || "",
    teams: (await all("SELECT code, label FROM teams ORDER BY sort")).filter((t) => !scope || scope.includes(t.code)),
    rows: visible,
    hidden: rows.length - visible.length,
    frames: frames.map((f) => ({ ...f, rows: f.rows.filter((r) => ids.has(r.id)) })),
    partMax: { sla: 30, resp: 15, work: 20, div: 15, back: 10, doc: 10, bonus: 5, csat: 5 },
  };
}

// ------------------------------------------------------------ avatar photo
function savePhoto(userId, b64) {
  const buf = Buffer.from(String(b64 || "").replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length < 100 || buf.length > 400 * 1024) throw bad("รูปต้องไม่เกิน 400 KB (ระบบย่อเป็น 256×256 ให้แล้ว ลองรูปอื่น)");
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!isJpg && !isPng && !isWebp) throw bad("รองรับเฉพาะรูป JPG, PNG หรือ WebP");
  fs.mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o750 });
  const name = `u${userId}-${crypto.randomBytes(6).toString("hex")}.${isJpg ? "jpg" : isPng ? "png" : "webp"}`;
  fs.writeFileSync(path.join(AVATAR_DIR, name), buf, { mode: 0o640 });
  return name;
}
function removePhoto(avatar) {
  if (avatar && avatar.startsWith("photo:")) fs.rmSync(path.join(AVATAR_DIR, path.basename(avatar.slice(6))), { force: true });
}

function mount(api, { wrap, need }) {
  api.get("/kpi/leaderboard", wrap(async (req, res) => {
    const s = await settings();
    if (!canSee(req.user, s)) throw bad("อันดับ KPI ยังเปิดให้เฉพาะ Manager ในช่วงทดลอง", 403);
    res.json(await build({ n: req.query.n, endYm: req.query.month, team: String(req.query.team || "").slice(0, 40), viewer: req.user }));
  }));
  api.put("/kpi/leaderboard/settings", need("settings_manage"), wrap(async (req, res) => {
    const b = req.body || {};
    const cur = await settings();
    const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
    const next = { visibility: b.visibility === "all" ? "all" : "managers", publicTop: num(b.publicTop, 3, 20, cur.publicTop), minCases: num(b.minCases, 1, 50, cur.minCases) };
    await setSetting("leaderboard", next);
    await audit(req.user, "leaderboard_settings", null, next);
    res.json({ ok: true, settings: next });
  }));

  api.put("/profile/avatar", wrap(async (req, res) => {
    const b = req.body || {};
    const cur = (await one("SELECT avatar FROM users WHERE id = $1", [req.user.id])).avatar;
    let next = null;
    if (b.photo) next = "photo:" + savePhoto(req.user.id, b.photo);
    else if (b.avatar) {
      if (!AVATAR_KEYS.includes(b.avatar)) throw bad("ไม่มี avatar นี้");
      next = b.avatar;
    }
    await q("UPDATE users SET avatar = $2, updated_at = now() WHERE id = $1", [req.user.id, next]);
    if (cur !== next) removePhoto(cur);
    res.json({ ok: true, avatar: next });
  }));
  // Avatar photos are only for signed-in users (they are photos of staff).
  api.get("/avatar/:id(\\d+)", wrap(async (req, res) => {
    const u = await one("SELECT avatar FROM users WHERE id = $1", [Number(req.params.id)]);
    if (!u || !u.avatar || !u.avatar.startsWith("photo:")) throw bad("ไม่มีรูป", 404);
    const f = path.join(AVATAR_DIR, path.basename(u.avatar.slice(6)));
    if (!fs.existsSync(f)) throw bad("ไม่มีรูป", 404);
    const ext = path.extname(f).slice(1);
    res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(f).pipe(res);
  }));
}

module.exports = { mount, build, settings, canSee, AVATAR_KEYS };
