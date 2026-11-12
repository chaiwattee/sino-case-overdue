// Microsoft Teams alerts through Teams Workflows ("Post to a channel when a webhook request is received").
// Each team pastes its channel's workflow URL; nothing reads Teams and no Graph permission is needed.
// Only Microsoft workflow hosts are accepted, so the setting cannot be used to make the server call other sites.
const axios = require("axios");
const { getSetting, setSetting, audit, all } = require("./db");
const { config3 } = require("./config3");

const KEY = "teams_notify";
const EVENTS = {
  intake: "เคสใหม่จากลูกค้า รอรับเคส",
  overdue: "สรุปเคสเกิน Due ทุกเช้า 08:30",
  sr: "คำขอบริการรออนุมัติ",
  ext: "คำขอขยายเวลารออนุมัติ",
  customer: "ลูกค้าใหม่รออนุมัติชื่อ",
  csat: "ลูกค้าให้คะแนนพึงพอใจ 1–2",
  due: "เคสใกล้ Due (วันนี้ / พรุ่งนี้) แท็กชื่อผู้รับผิดชอบ ทุกเช้า 08:30",
  transfer: "คำขอโอนเคสข้ามทีม รออนุมัติ / รับเคส",
};
const DEFAULT_EVENTS = ["intake", "overdue", "due", "sr", "csat", "transfer"];
const HOST_OK = /(^|\.)(logic\.azure\.com|powerplatform\.com|powerautomate\.com)$/i;

function validUrl(u) {
  if (!u) return "";
  let x;
  try {
    x = new URL(String(u).trim());
  } catch (e) {
    throw Object.assign(new Error("Webhook URL ไม่ถูกต้อง"), { status: 400 });
  }
  if (x.protocol !== "https:" || !HOST_OK.test(x.hostname))
    throw Object.assign(new Error("ใช้ได้เฉพาะลิงก์ Workflows ของ Microsoft (…logic.azure.com หรือ …powerplatform.com)"), { status: 400 });
  return x.toString();
}

/** {channels: {TEAM|"_default": {url, events: []}}} */
async function settings() {
  const s = (await getSetting(KEY, null)) || {};
  return { channels: s.channels || {} };
}

/** Where an event for `team` goes: the team's channel if it takes this event, else the shared channel. */
async function targets(team, event) {
  const { channels } = await settings();
  const out = [];
  const t = team && channels[team];
  if (t && t.url && (t.events || []).includes(event)) out.push(t.url);
  else if (!t || !t.url) {
    const d = channels._default;
    if (d && d.url && (d.events || []).includes(event)) out.push(d.url);
  }
  return out;
}

/** Adaptive card payload for a Teams workflow. facts = [[label, value]], actions = [[title, url]]. */
// lines: markdown lines shown as a list; mentions: [{name, email}] tagged where "<at>name</at>" appears in a line.
function payload({ title, color = "Default", text, facts = [], lines = [], mentions = [], actions = [] }) {
  const seen = new Set();
  const entities = mentions
    .filter((m) => m && m.email && m.name && !seen.has(m.email.toLowerCase()) && seen.add(m.email.toLowerCase()))
    .map((m) => ({ type: "mention", text: `<at>${m.name}</at>`, mentioned: { id: m.email, name: m.name } }));
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full", ...(entities.length ? { entities } : {}) },
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color, wrap: true },
            ...(text ? [{ type: "TextBlock", text, wrap: true, spacing: "Small" }] : []),
            ...(facts.length ? [{ type: "FactSet", facts: facts.map(([t, v]) => ({ title: String(t), value: String(v ?? "-") })) }] : []),
            ...lines.map((l, i) => ({ type: "TextBlock", text: l, wrap: true, spacing: i ? "Small" : "Medium" })),
          ],
          actions: actions.map(([t, url]) => ({ type: "Action.OpenUrl", title: t, url })),
        },
      },
    ],
  };
}

async function postTo(url, card) {
  if (require("../config").config.dryRunEmail) {
    console.log(`[DRY RUN teams] ${card.title}`);
    return { dryRun: true };
  }
  await axios.post(url, payload(card), { timeout: 10000, maxRedirects: 0, headers: { "Content-Type": "application/json" } });
  return { ok: true };
}

/** Send one card for an event; never throws (alerts must not break the action that caused them). */
async function notify(team, event, card) {
  let n = 0;
  try {
    for (const url of await targets(team, event)) await postTo(url, card).then(() => n++, (e) => console.error(`[teams] ${event}:`, e.message));
  } catch (e) {
    console.error("[teams]", e.message);
  }
  return n;
}

const link = (hash) => `${config3.baseUrl}/${hash}`;

const md = (x) => String(x || "-").replace(/([*_\[\]<>])/g, "\\$1");
const tag = (c) => (c.ownerEmail && c.owner ? `<at>${c.owner}</at>` : md(c.owner));
const who = (list) => list.filter((c) => c.ownerEmail && c.owner).map((c) => ({ name: c.owner, email: c.ownerEmail }));
const caseLine = (c, tail) => `**[${md(c.caseNo || "#" + c.id)}](${link("#/case/" + c.id)})** ${md(c.site)} · ${md(c.task)} · ${tag(c)} · ${tail}`;

/** Morning cards per team channel: cases past Due, and cases due today / tomorrow with their owners tagged. */
async function overdueSummary() {
  const repo = require("./caserepo");
  const teams = await all("SELECT code, label FROM teams ORDER BY sort");
  const open = (await repo.loadCases(null)).filter((c) => c.stage !== "closed");
  const out = { overdue: 0, due: 0 };
  for (const t of teams) {
    const mine = open.filter((c) => c.team === t.code);
    const over = mine.filter((c) => c.stage === "overdue").sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
    if (over.length) {
      const shown = over.slice(0, 15);
      out.overdue += await notify(t.code, "overdue", {
        title: `⏰ เคสเกิน Due วันนี้ ${over.length} เคส · ${t.label}`,
        color: "Attention",
        lines: [...shown.map((c) => caseLine(c, `เกิน ${c.daysOverdue} วัน`)), ...(over.length > 15 ? [`และอีก ${over.length - 15} เคส`] : [])],
        mentions: who(shown),
        actions: [["เปิดภาพรวม", link(`#/?source=${encodeURIComponent(t.code)}`)]],
      });
    }
    const soon = mine.filter((c) => c.stage !== "overdue" && c.daysLeft != null && c.daysLeft <= 1 && !(c.periodStart && c.periodStart > new Date())).sort((a, b) => a.daysLeft - b.daysLeft);
    if (soon.length) {
      out.due += await notify(t.code, "due", {
        title: `📅 เคสครบ Due วันนี้ / พรุ่งนี้ ${soon.length} เคส · ${t.label}`,
        color: "Warning",
        text: "ปิดเคสหรือขอขยายเวลาก่อนเกิน Due",
        lines: soon.slice(0, 15).map((c) => caseLine(c, c.daysLeft === 0 ? "**ครบวันนี้**" : "ครบพรุ่งนี้")),
        mentions: who(soon.slice(0, 15)),
        actions: [["เปิดเคสของฉัน", link("#/mine")]],
      });
    }
  }
  return out;
}

function mount(api, { wrap, need }) {
  api.get("/teams-notify", need("settings_manage"), wrap(async (req, res) => {
    const s = await settings();
    const teams = await all("SELECT code, label FROM teams ORDER BY sort");
    res.json({ events: EVENTS, defaultEvents: DEFAULT_EVENTS, teams, channels: s.channels });
  }));
  api.put("/teams-notify", need("settings_manage"), wrap(async (req, res) => {
    const input = (req.body && req.body.channels) || {};
    const codes = new Set(["_default", ...(await all("SELECT code FROM teams")).map((t) => t.code)]);
    const channels = {};
    for (const [code, v] of Object.entries(input)) {
      if (!codes.has(code) || !v) continue;
      const url = validUrl(v.url);
      if (!url) continue;
      channels[code] = { url, events: (Array.isArray(v.events) ? v.events : []).filter((e) => EVENTS[e]) };
    }
    await setSetting(KEY, { channels });
    await audit(req.user, "teams_notify_update", null, { channels: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.events])) });
    res.json({ ok: true });
  }));
  api.post("/teams-notify/test", need("settings_manage"), wrap(async (req, res) => {
    const url = validUrl(req.body && req.body.url);
    if (!url) throw Object.assign(new Error("ใส่ Webhook URL ก่อน"), { status: 400 });
    try {
      const r = await postTo(url, { title: "✅ ทดสอบการเชื่อมต่อจาก Sino Case SLA", color: "Good", facts: [["ส่งโดย", req.user.display_name]], actions: [["เปิดระบบ", config3.baseUrl]] });
      res.json({ ok: true, ...r });
    } catch (e) {
      throw Object.assign(new Error(`ส่งไม่สำเร็จ: ${e.response ? "HTTP " + e.response.status : e.message}`), { status: 400 });
    }
  }));
}

module.exports = { mount, notify, overdueSummary, link, payload, EVENTS };
