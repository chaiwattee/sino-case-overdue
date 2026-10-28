// Daily alert emails to case owners (CC engineer@) + audit notices.
const { config } = require("./config");
const graph = require("./graph");
const { store } = require("./store");
const { sync } = require("./sync");
const { caseAlertEmail, auditEmail } = require("./emails");
const { toISODate, today: todayFn } = require("./dates");

const SEND_GAP_MS = 2500; // keep well under Outlook's ~30 messages/minute limit
const sleep = (ms) => new Promise((r) => setTimeout(r, config.mock ? 0 : ms));

/**
 * Which alert a case should get today, and its de-duplication key.
 * Round 1 and round 2 go out once each; overdue goes out once per day.
 */
function alertFor(c, todayIso) {
  if (c.stage === "r1") return { type: "r1", dedupe: `${c.key}|r1` };
  if (c.stage === "r2") return { type: "r2", dedupe: `${c.key}|r2` };
  if (c.stage === "overdue") return { type: "overdue", dedupe: `${c.key}|overdue|${todayIso}` };
  return null;
}

async function runAlerts({ dryRun = false } = {}) {
  const { cases } = await sync();
  const todayIso = toISODate(todayFn());

  const due = [];
  for (const c of cases) {
    const a = alertFor(c, todayIso);
    if (a) due.push({ c, ...a });
  }
  const sent = await store.sentAlertKeys(due.map((d) => d.dedupe));
  const todo = due
    .filter((d) => !sent.has(d.dedupe))
    .sort((a, b) => (b.c.age || 0) - (a.c.age || 0));

  const result = { candidates: due.length, alreadySent: due.length - todo.length, sent: 0, failed: 0, items: [] };
  if (dryRun) {
    result.items = todo.map((d) => ({ case: d.c.csNumber || d.c.key, owner: d.c.owner, type: d.type }));
    return result;
  }

  for (const d of todo) {
    const c = d.c;
    const { subject, html } = caseAlertEmail(c, d.type);
    const to = c.ownerEmail ? [c.ownerEmail] : config.alertCc;
    const cc = c.ownerEmail ? config.alertCc : [];
    const finalSubject = c.ownerEmail ? subject : `[ไม่พบอีเมล Owner] ${subject}`;
    const row = {
      dedupe_key: d.dedupe,
      case_key: c.key,
      source: c.source,
      cs_number: c.csNumber || null,
      owner: c.owner || null,
      owner_email: c.ownerEmail || null,
      site: c.site || null,
      alert_type: d.type,
      case_age: c.age,
      to_list: to.join(","),
      cc_list: cc.join(","),
      subject: finalSubject,
      ok: true,
      error: null,
    };
    let dry = false;
    try {
      const r = await graph.sendMail({ to, cc, subject: finalSubject, html });
      dry = !!r.dryRun && !config.mock;
      result.sent++;
    } catch (e) {
      row.ok = false;
      row.error = String(e.response?.data?.error?.message || e.message).slice(0, 500);
      result.failed++;
      console.error(`[alerts] send failed for ${c.key}:`, row.error);
    }
    try {
      // In DRY_RUN_EMAIL mode nothing is logged, so the real send still happens after going live.
      if (!dry) await store.insertAlert(row);
    } catch (e) {
      console.error("[alerts] log write failed:", e.response?.data || e.message);
    }
    result.items.push({ case: c.csNumber || c.key, owner: c.owner, type: d.type, ok: row.ok });
    await sleep(SEND_GAP_MS);
  }
  return result;
}

/** Email the CC list (engineer@) about Start date / Target date edits. */
async function notifyChanges(changes) {
  if (!changes || changes.length === 0) return { sent: false };
  const { subject, html } = auditEmail(changes);
  try {
    await graph.sendMail({ to: config.alertCc, cc: [], subject, html });
    return { sent: true, count: changes.length };
  } catch (e) {
    console.error("[audit] email failed:", e.response?.data || e.message);
    return { sent: false, error: e.message };
  }
}

module.exports = { runAlerts, notifyChanges, alertFor };
