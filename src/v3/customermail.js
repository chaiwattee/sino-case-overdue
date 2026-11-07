// Customer-facing emails (English). Team-facing emails stay in Thai elsewhere.
const { config } = require("../config");
const { config3 } = require("./config3");
const { esc, fieldTable } = require("../emails");

const BLUE = "#1F5FBF";
const GREEN = "#1C6B45";
const GREY = "#5B6675";
const testTag = (i) => (i && i.is_test ? "[TEST] " : "");

function layout(color, inner, { footer } = {}) {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#F3F5F9;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#18212F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #D9DFE8;border-radius:12px;overflow:hidden">
<tr><td style="height:6px;background:${color};font-size:0;line-height:0">&nbsp;</td></tr><tr><td style="padding:28px 30px;font-size:15px;line-height:1.65">
<p style="margin:0 0 16px"><img src="${esc(config3.baseUrl)}/sinostech-logo.png" alt="SINO S-TECH LIMITED" width="240" height="60" style="display:block;border:0"></p>
${inner}
<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #E2E5EA;font-size:13px;color:#5B6675">${footer || "Support, SINO S-TECH LIMITED · You can reply to this email with more information or attachments. Please keep the [REQ-…] number in the subject so it goes to the same case."}</p>
</td></tr></table></body></html>`;
}
const button = (url, label, solid = true) =>
  `<a href="${esc(url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;${solid ? `background:${BLUE};color:#FFFFFF;` : `background:#FFFFFF;color:${BLUE};border:1px solid ${BLUE};`}text-decoration:none;font-weight:700">${esc(label)}</a>`;
const greet = (i) => `<p style="margin:0 0 14px">Dear ${esc(i.contact_name || "Customer")},</p>`;
const ref = (s) => `<strong style="font-family:Consolas,monospace;color:${BLUE}">${esc(s)}</strong>`;

function addDetailsBox(url, { intro = true } = {}) {
  return `<div style="margin:16px 0;padding:14px 16px;background:#EEF3FB;border-radius:10px">
${intro ? `<p style="margin:0 0 4px;font-weight:700">Help us resolve it faster (optional)</p><p style="margin:0 0 10px;font-size:14px;color:#3B4452">Add a call-back number, the affected system, urgency or more screenshots. It takes about a minute.</p>` : ""}
${button(url, "Add details / screenshots")}</div>`;
}
const replyHint = `<p style="margin:0 0 10px"><strong>Prefer not to use the form?</strong> Reply to this email with your contact name and a call-back phone number.</p>`;

/** After-hours notice with the hotline numbers in escalation order (rows without a phone are not shown). */
function afterHoursBox(i, { hours, hotline }) {
  const lines = (hotline && hotline.lines) || [];
  const order = ["1st", "2nd", "3rd"];
  return `<div style="margin:16px 0;padding:14px 16px;background:#FFF4E5;border:1px solid #F5C27A;border-radius:10px;color:#3D2A00">
<p style="margin:0 0 6px;font-weight:700">We are currently outside business hours (${esc(hours.end)}–${esc(hours.start)})</p>
<p style="margin:0 0 4px;font-size:14px">• <strong>Non-urgent case:</strong> an engineer will contact you the next day.</p>
${lines.length ? `<p style="margin:0 0 8px;font-size:14px">• <strong>Urgent case:</strong> please call the hotline in this order. If nobody answers within ${hotline.waitMinutes} minutes, call the next number.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${lines
    .map((l, n) => `<tr><td style="padding:3px 14px 3px 0;color:#7A5600">${order[n]}</td><td style="padding:3px 12px 3px 0"><a href="tel:${esc(l.phone.replace(/[^+0-9]/g, ""))}" style="font-family:Consolas,monospace;font-size:18px;font-weight:700;color:#B4530A;text-decoration:none">${esc(l.phone)}</a></td><td style="padding:3px 0">${esc(l.label)}</td></tr>`)
    .join("")}</table>
<p style="margin:8px 0 0;font-size:13px;color:#7A5600">Please quote ${esc(i.req_no)} when you call.</p>` : ""}</div>`;
}

/** Auto-reply to a new request. */
function ackHtml(i, { updateUrl, afterHours, hours, hotline, files = [] }) {
  return layout(
    BLUE,
    `${greet(i)}<p style="margin:0 0 14px">We have received your case. Reference number ${ref(i.req_no)}</p>
${fieldTable([["Customer", i.site || "To be confirmed by our engineer"], ["Subject", i.subject], ...(files.length ? [["Files received", files.join(", ")]] : [])])}
${afterHours ? afterHoursBox(i, { hours, hotline }) : ""}
${addDetailsBox(updateUrl)}
${replyHint}
<p style="margin:0">We will email you again as soon as an engineer takes the case.</p>`
  );
}
const ackSubject = (i, base) => `${testTag(i)}[${i.req_no}] ${base}`;

/** An engineer took the case. */
function claimedHtml(i, kase, owner, { updateUrl }) {
  return layout(
    GREEN,
    `${greet(i)}<p style="margin:0 0 14px">An engineer has taken your case.</p>
${fieldTable([["Reference", `${i.req_no} → ${kase.caseNo}${kase.csNumber ? ` (${kase.csNumber})` : ""}`], ["Subject", i.subject], ["Engineer", owner.display_name], ...(owner.phone ? [["Engineer phone", owner.phone]] : []), ...(owner.email ? [["Engineer email", owner.email]] : []), ["Your call-back", i.contact_phone || i.contact_email || "-"]])}
<p style="margin:16px 0">${button(updateUrl, "Add details / screenshots", false)}</p>
<p style="margin:0">To add information, reply to this email or use the button above. It will be recorded in your case for the engineer.</p>`
  );
}
const claimedSubject = (i, kase, base) => `${testTag(i)}[${i.req_no} → ${kase.caseNo}] ${base}`;

/** Request closed without opening a case (duplicate / not a case). */
function closedHtml(i, message) {
  return layout(GREY, `${greet(i)}<p style="margin:0 0 14px;white-space:pre-wrap">${esc(message)}</p><p style="margin:0">If you still need help, simply reply to this email.</p>`);
}
function closedMessage(r, status, reason) {
  return status === "duplicate"
    ? `Your request ${r.req_no} is about the same issue as ${r.duplicate_of}, which we are already working on. We will follow up there.`
    : `Your request ${r.req_no} has been closed by the support team.${reason ? `\nNote from the team: ${reason}` : ""}`;
}

/** One-time form link an engineer sends by email. */
function linkEmailHtml({ name, customer, url, expiresAt, sender, note }) {
  const t = new Date(expiresAt);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: config.tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(t);
  return layout(
    BLUE,
    `<p style="margin:0 0 14px">Dear ${esc(name || "Customer")}${customer ? ` (${esc(customer)})` : ""},</p>
<p style="margin:0 0 14px">Please tell us about the problem using the form below. Every field has an example. You get a reference number as soon as you send it, and our team will contact you.</p>
${note ? `<p style="margin:0 0 14px;padding:12px 14px;background:#F6F7F9;border-radius:8px;white-space:pre-wrap">${esc(note)}</p>` : ""}
<p style="margin:18px 0">${button(url, "Open the case form")}</p>
<p style="margin:0 0 6px;font-size:13px;color:#5B6675">The link works once, until ${esc(fmt)}. If it has expired, please ask our team for a new one.</p>
<p style="margin:0;font-size:13px;color:#5B6675;word-break:break-all">If the button does not work, copy this link: ${esc(url)}</p>`,
    { footer: `Sent by ${esc(sender || "the Support team")} · Support, SINO S-TECH LIMITED` }
  );
}

module.exports = { layout, ackHtml, ackSubject, claimedHtml, claimedSubject, closedHtml, closedMessage, linkEmailHtml, testTag };
