// Customer satisfaction (CSAT): when a case that came from a customer request closes, the customer gets a
// "resolved" message with a 1–5 rating, in the same channel they used (email thread, new email, or LINE via the chatbot).
// Clicking a number only opens the page with that score picked; the score is saved when the customer presses Submit,
// so mail scanners that open links (Safe Links) never record a rating by themselves.
const crypto = require("crypto");
const express = require("express");
const { q, one, all, audit } = require("./db");
const { config3 } = require("./config3");
const { esc } = require("../emails");

const VALID_DAYS = 14;
const LOW = 2; // ratings at or below this alert the team's managers
const EXEMPT = ["cancel", "n/a"];
const LABELS = ["", "Very poor", "Poor", "OK", "Good", "Excellent"];
const FACES = ["", "😞", "🙁", "😐", "🙂", "😄"];

const rateUrl = (token) => (n) => `${config3.baseUrl}/csat/${token}${n ? `?r=${n}` : ""}`;

/** Called after a case closes. Sends at most one survey per case; never throws. */
async function onCaseClosed(caseId) {
  try {
    const repo = require("./caserepo");
    const kase = await repo.getCase(caseId);
    if (!kase || kase.stage !== "closed" || EXEMPT.includes(String(kase.status).trim().toLowerCase())) return { skipped: "status" };
    const i = await one("SELECT * FROM intakes WHERE case_id = $1 AND NOT is_test ORDER BY id LIMIT 1", [caseId]);
    if (!i) return { skipped: "not a customer case" };
    if (await one("SELECT 1 FROM case_csat WHERE case_id = $1", [caseId])) return { skipped: "already sent" };
    const token = crypto.randomBytes(18).toString("base64url");
    const cm = require("./customermail");
    const html = cm.resolvedHtml(i, kase, { rateUrl: rateUrl(token), days: VALID_DAYS });
    let channel = null;
    let sentTo = null;
    if (i.channel === "email") {
      const ok = await require("./mailintake")
        .onResolved(i, (base) => cm.resolvedSubject(i, kase, base), html)
        .catch((e) => (console.error("[csat] thread reply:", e.message), false));
      if (ok) (channel = "email"), (sentTo = i.contact_email);
    }
    if (!channel && i.line_user_id) {
      await require("./intake").enqueue("case.resolved", i, {
        event: "case.resolved",
        test: false,
        reqNo: i.req_no,
        caseId: kase.id,
        caseNo: kase.caseNo,
        customer: kase.site,
        subject: i.subject,
        resolution: kase.resolution || null,
        owner: { name: kase.owner },
        lineUserId: i.line_user_id,
        externalRef: i.external_ref,
        surveyUrl: rateUrl(token)(),
        message: `Your case ${i.req_no} (${kase.caseNo}) has been resolved. How satisfied are you with our support? Rate us 1–5: ${rateUrl(token)()}`,
      });
      (channel = "line"), (sentTo = i.line_user_id);
    }
    if (!channel && i.contact_email) {
      await require("../graph").sendMail({ to: [i.contact_email], cc: [], subject: cm.resolvedSubject(i, kase, i.subject), html });
      (channel = "link"), (sentTo = i.contact_email);
    }
    if (!channel) return { skipped: "no contact" };
    await q(
      `INSERT INTO case_csat (case_id, intake_id, token, channel, sent_to, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '${VALID_DAYS} days')
       ON CONFLICT (case_id) DO NOTHING`,
      [caseId, i.id, token, channel, sentTo]
    );
    await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system) VALUES ($1, current_date, 'แบบสอบถาม', $2, true)", [
      caseId, `ส่งแบบสอบถามความพึงพอใจให้ลูกค้า (${channel === "email" ? "ตอบใน email เดิม" : channel === "line" ? "LINE" : "email"})`,
    ]);
    return { sent: channel };
  } catch (e) {
    console.error("[csat]", e.message);
    return { error: e.message };
  }
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ""))) return null;
  return one(
    `SELECT s.*, c.case_no, c.site, c.task, c.team, u.display_name AS owner_name, i.req_no, i.subject, i.contact_name
     FROM case_csat s JOIN cases c ON c.id = s.case_id LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN intakes i ON i.id = s.intake_id
     WHERE s.token = $1`,
    [token]
  );
}

function page(body, title = "Customer satisfaction") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · SINO S-TECH</title>
<style>
:root{--ink:#18212F;--mut:#5B6675;--line:#D9DFE8;--blue:#1F5FBF;--bg:#F3F5F9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font:15px/1.6 "Segoe UI",Tahoma,Arial,sans-serif;color:var(--ink)}
.card{max-width:560px;margin:24px auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px 24px}
@media(max-width:600px){.card{margin:0;border-radius:0;border-left:0;border-right:0;padding:22px 16px}}
h1{font-size:20px;margin:6px 0 4px}.mut{color:var(--mut);font-size:14px}
.ref{font-family:Consolas,monospace;color:var(--blue)}
.rate{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:18px 0}
.rate label{display:block;border:1.5px solid var(--line);border-radius:12px;padding:10px 2px;text-align:center;cursor:pointer;user-select:none}
.rate input{position:absolute;opacity:0;pointer-events:none}
.rate .f{font-size:28px;line-height:1.2;display:block}.rate b{display:block}.rate small{font-size:11px;color:var(--mut)}
.rate input:checked+label{border-color:var(--blue);background:#EEF3FB;box-shadow:0 0 0 2px #1F5FBF33}
.rate input:focus-visible+label{outline:2px solid var(--blue);outline-offset:2px}
textarea{width:100%;min-height:96px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--blue);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.ok{background:#E8F5EE;border:1px solid #9FD3B5;color:#14532D;border-radius:10px;padding:12px 14px;margin:0 0 14px}
img{display:block;margin:0 0 10px}
</style></head><body><main class="card"><img src="/sinostech-logo.png" alt="SINO S-TECH LIMITED" width="200" height="50">${body}</main></body></html>`;
}

function formHtml(s, picked, { saved } = {}) {
  const r = Number(picked) || s.rating || 0;
  const radios = [1, 2, 3, 4, 5]
    .map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}"${n === r ? " checked" : ""} required><label for="r${n}"><span class="f">${FACES[n]}</span><b>${n}</b><small>${LABELS[n]}</small></label>`)
    .join("");
  return page(`${saved ? `<p class="ok">Thank you! Your rating has been saved. You can change it until the link expires.</p>` : ""}
<h1>How satisfied are you with our support?</h1>
<p class="mut">Case <span class="ref">${esc(s.req_no || "")}${s.case_no ? ` → ${esc(s.case_no)}` : ""}</span>${s.subject ? ` · ${esc(s.subject)}` : ""}<br>Engineer: ${esc(s.owner_name || "-")}</p>
<form method="post" action="/csat/${esc(s.token)}">
<div class="rate" role="radiogroup" aria-label="Rating 1 to 5">${radios}</div>
<label for="c" class="mut">Comment (optional)</label>
<textarea id="c" name="comment" maxlength="1000" placeholder="What went well, or what could we do better?">${esc(s.comment || "")}</textarea>
<button type="submit">${s.rating ? "Update my rating" : "Submit"}</button>
</form>`);
}

const gone = () => page(`<h1>This link has expired</h1><p class="mut">Thank you for your time. If you still need help, please reply to our email or contact the support team.</p>`, "Link expired");

/** Public routes, registered before the login wall. */
function attach(app) {
  app.get("/csat/:token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    const s = await byToken(req.params.token).catch(() => null);
    if (!s || new Date(s.expires_at) < new Date()) return res.status(404).send(gone());
    res.send(formHtml(s, req.query.r));
  });
  app.post("/csat/:token", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const s = await byToken(req.params.token);
      if (!s || new Date(s.expires_at) < new Date()) return res.status(404).send(gone());
      const rating = Number(req.body && req.body.rating);
      if (!(rating >= 1 && rating <= 5)) return res.status(400).send(formHtml(s, 0));
      const comment = String((req.body && req.body.comment) || "").replace(/\r/g, "").trim().slice(0, 1000) || null;
      const first = !s.rating;
      await q("UPDATE case_csat SET rating = $2, comment = $3, rated_at = now() WHERE id = $1", [s.id, rating, comment]);
      await q("INSERT INTO case_activities (case_id, activity_date, kind, detail, is_system) VALUES ($1, current_date, 'แบบสอบถาม', $2, true)", [
        s.case_id, `ลูกค้า${first ? "ให้" : "แก้"}คะแนนความพึงพอใจ ${rating}/5${comment ? `\nความเห็น: ${comment}` : ""}`,
      ]);
      await audit(null, "csat_rated", s.case_no, { case_id: s.case_id, rating });
      if (rating <= LOW && !s.alerted_at) alertLow({ ...s, rating, comment }).catch((e) => console.error("[csat] alert:", e.message));
      res.send(formHtml({ ...s, rating, comment }, rating, { saved: true }));
    } catch (e) {
      console.error("[csat] save:", e.message);
      res.status(500).send(page(`<h1>Something went wrong</h1><p class="mut">Please try again in a moment.</p>`));
    }
  });
}

/** Low score: email the managers of the case's team and post to Teams. */
async function alertLow(s) {
  const graph = require("../graph");
  const { shell, fieldTable, button } = require("../emails");
  const to = (await all("SELECT DISTINCT u.email FROM users u JOIN user_teams t ON t.user_id = u.id WHERE u.active AND u.role = 'manager' AND t.team = $1 AND u.email IS NOT NULL", [s.team]).catch(() => [])).map((r) => r.email);
  const url = `${config3.baseUrl}/#/case/${s.case_id}`;
  const facts = [["เคส", `${s.req_no || ""} → ${s.case_no || "#" + s.case_id}`], ["ลูกค้า", s.site || "-"], ["งาน", s.task || "-"], ["User", s.owner_name || "-"], ["คะแนน", `${s.rating}/5 ${FACES[s.rating]}`], ["ความเห็นลูกค้า", s.comment || "-"]];
  if (to.length)
    await graph.sendMail({
      to, cc: [],
      subject: `[Sino Case SLA] ลูกค้าให้คะแนนพึงพอใจต่ำ ${s.rating}/5 · ${s.site || ""} · ${s.case_no || ""}`,
      html: shell("#B3263A", `<p style="margin:0 0 12px">ลูกค้าให้คะแนนความพึงพอใจ <strong>${s.rating}/5</strong> ควรโทรติดตามลูกค้าภายใน 1 วันทำการ</p>${fieldTable(facts)}<p style="margin:16px 0 0">${button(url, "เปิดเคส")}</p>`),
    });
  await require("./teamsnotify").notify(s.team, "csat", { title: `😞 ลูกค้าให้คะแนนพึงพอใจ ${s.rating}/5 · ${s.site || ""}`, color: "Attention", facts, actions: [["เปิดเคส", url]] });
  const push = require("./push");
  push.send(await push.teamManagerIds(s.team), { title: `ลูกค้าให้คะแนนพึงพอใจ ${s.rating}/5`, body: `${s.site || ""} · ${s.case_no || ""}${s.comment ? ` · ${s.comment}` : ""}`, url: `/#/case/${s.case_id}`, tag: `case-${s.case_id}` }).catch(() => {});
  await q("UPDATE case_csat SET alerted_at = now() WHERE id = $1", [s.id]);
}

/** CSAT for one case (case page). */
const forCase = (caseId) => one("SELECT channel, sent_to, sent_at, expires_at, rating, comment, rated_at FROM case_csat WHERE case_id = $1", [caseId]);

/** Summary over rated surveys of the given case ids. */
async function summary(caseIds) {
  if (!caseIds.length) return { sent: 0, rated: 0, avg: null, low: 0 };
  const r = await one(
    `SELECT count(*)::int AS sent, count(rating)::int AS rated, round(avg(rating)::numeric, 2) AS avg, count(*) FILTER (WHERE rating <= ${LOW})::int AS low
     FROM case_csat WHERE case_id = ANY($1)`,
    [caseIds]
  );
  return { sent: r.sent, rated: r.rated, avg: r.avg != null ? Number(r.avg) : null, low: r.low };
}

module.exports = { onCaseClosed, attach, forCase, summary, byToken, LABELS };
