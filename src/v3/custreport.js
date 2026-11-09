// Monthly support report for a customer, as a PDF (English, customer-facing).
// Contains only what the customer already knows about: case numbers, subjects, dates, SLA result and the resolution.
// Internal notes, activities, RCA text and engineer KPIs are never included.
const path = require("path");
const PDFDocument = require("pdfkit");
const { config } = require("../config");
const { config3 } = require("./config3");
const d = require("../dates");
const { q, one, all, audit } = require("./db");

const FONT_R = path.join(__dirname, "../../assets/fonts/Sarabun-Regular.ttf");
const FONT_B = path.join(__dirname, "../../assets/fonts/Sarabun-Bold.ttf");
const LOGO = path.join(__dirname, "../../public3/sinostech-logo.png");
const EXCLUDE = ["cancel", "n/a"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const C = { ink: "#18212F", muted: "#5B6675", line: "#D9DFE8", blue: "#1F5FBF", green: "#1C6B45", red: "#B3263A", row: "#F3F5F9" };

const seg = new Intl.Segmenter("th", { granularity: "word" });
/** Thai has no spaces between words, so lines are broken here between dictionary words (PDF wrapping only knows spaces). */
function fit(doc, text, width) {
  const out = [];
  for (const para of String(text ?? "").replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const { segment } of seg.segment(para)) {
      const next = line + segment;
      if (line && doc.widthOfString(next) > width) {
        out.push(line.trimEnd());
        line = segment.trimStart();
        // A single "word" wider than the column (long codes, URLs): cut it by characters.
        while (doc.widthOfString(line) > width && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && doc.widthOfString(line.slice(0, k)) > width) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = next;
    }
    out.push(line);
  }
  return out.join("\n");
}
const iso = (x) => (x ? d.toISODate(x instanceof Date ? x : d.fromISODate(x)) : "");
const day = (x) => {
  if (!x) return "-";
  const t = x instanceof Date ? x : d.fromISODate(String(x).slice(0, 10));
  return `${t.getDate()} ${MONTHS[t.getMonth()].slice(0, 3)} ${t.getFullYear()}`;
};
const monthName = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
function prevYm() {
  const t = d.today();
  const x = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
}

/** Numbers and case lists for one customer and month (all teams). */
async function data(site, ym) {
  const R = require("./kpi").monthRange(ym);
  const repo = require("./caserepo");
  const cases = (await repo.loadCases(null, { where: "lower(c.site) = lower($1) AND c.customer_unconfirmed IS NULL", params: [site] })).filter(
    (c) => !EXCLUDE.includes(String(c.status).trim().toLowerCase())
  );
  const inMonth = (x) => x && iso(x) >= R.fromIso && iso(x) <= R.toIso;
  const opened = cases.filter((c) => inMonth(c.startDate));
  const closed = cases.filter((c) => c.stage === "closed" && inMonth(c.endDate)).sort((a, b) => a.endDate - b.endDate);
  // Still open at the end of the month (or closed after it).
  const openAtEnd = cases
    .filter((c) => iso(c.startDate) <= R.toIso && (!c.endDate || iso(c.endDate) > R.toIso))
    .sort((a, b) => a.startDate - b.startDate);
  const onTime = closed.filter((c) => c.closedOnTime === true).length;
  const days = closed.map((c) => Math.max(0, d.daysBetween(c.startDate, c.endDate)));
  const csat = closed.length
    ? await one(`SELECT count(rating)::int AS n, round(avg(rating)::numeric, 1) AS avg FROM case_csat WHERE case_id = ANY($1)`, [closed.map((c) => c.id)])
    : { n: 0, avg: null };
  const bySev = {};
  [...opened].forEach((c) => (bySev[c.severity || "Not specified"] = (bySev[c.severity || "Not specified"] || 0) + 1));
  const byProduct = {};
  [...opened].forEach((c) => (byProduct[c.product || "Not specified"] = (byProduct[c.product || "Not specified"] || 0) + 1));
  return {
    site: cases[0] ? cases[0].site : site,
    ym: R.ym,
    month: monthName(R.ym),
    opened: opened.length,
    closed,
    openAtEnd,
    onTime,
    slaPct: closed.length ? Math.round((onTime / closed.length) * 100) : null,
    avgDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    csat: { n: csat.n, avg: csat.avg != null ? Number(csat.avg) : null },
    bySev,
    byProduct,
  };
}

/** Builds the PDF and returns it as a Buffer. */
async function pdf(site, ym) {
  const x = await data(site, ym);
  const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true, info: { Title: `Monthly Support Report · ${x.site} · ${x.month}`, Author: "SINO S-TECH LIMITED" } });
  const chunks = [];
  doc.on("data", (b) => chunks.push(b));
  const done = new Promise((res) => doc.on("end", res));
  doc.registerFont("R", FONT_R);
  doc.registerFont("B", FONT_B);
  const W = doc.page.width - 80;
  const L = 40;

  // Header
  try {
    doc.image(LOGO, L, 36, { width: 150 });
  } catch (e) {}
  doc.font("B").fontSize(18).fillColor(C.ink).text("Monthly Support Report", L, 40, { width: W, align: "right" });
  doc.font("R").fontSize(11).fillColor(C.muted).text(`${x.month} · issued ${day(d.today())}`, L, doc.y, { width: W, align: "right" });
  doc.moveTo(L, 86).lineTo(L + W, 86).lineWidth(2).strokeColor(C.blue).stroke();
  doc.font("B").fontSize(15).fillColor(C.ink).text(x.site, L, 98, { width: W });
  doc.font("R").fontSize(10).fillColor(C.muted).text(`Support cases from 1 to ${require("./kpi").monthRange(x.ym).to.getDate()} ${x.month}. SLA: each case is resolved within ${config.slaDays} days of being opened.`, L, doc.y + 2, { width: W });

  // Summary tiles
  const tiles = [
    ["New cases", String(x.opened)],
    ["Resolved", String(x.closed.length)],
    ["Resolved within SLA", x.slaPct == null ? "-" : `${x.slaPct}%`],
    ["Average days to resolve", x.avgDays == null ? "-" : String(x.avgDays)],
    ["Open at month end", String(x.openAtEnd.length)],
    ["Your satisfaction", x.csat.n ? `${x.csat.avg} / 5` : "-"],
  ];
  const ty = doc.y + 12;
  const tw = (W - 5 * 8) / 6;
  tiles.forEach(([l, v], i) => {
    const tx = L + i * (tw + 8);
    doc.roundedRect(tx, ty, tw, 58, 6).fillColor(C.row).fill();
    doc.font("R").fontSize(8.5).fillColor(C.muted).text(l, tx + 8, ty + 7, { width: tw - 16 });
    doc.font("B").fontSize(18).fillColor(i === 2 && x.slaPct != null && x.slaPct < 80 ? C.red : C.ink).text(v, tx + 8, ty + 28, { width: tw - 16 });
  });
  doc.y = ty + 72;

  const breakdown = (title, obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "-";
  doc.font("R").fontSize(9.5).fillColor(C.muted).text(`New cases by severity: ${breakdown("", x.bySev)}`, L, doc.y, { width: W });
  doc.text(`New cases by product: ${breakdown("", x.byProduct)}`, { width: W });

  // Tables
  function table(title, cols, rows, empty) {
    doc.moveDown(0.8);
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.font("B").fontSize(12).fillColor(C.ink).text(title, L, doc.y, { width: W });
    doc.moveDown(0.3);
    const head = () => {
      const y = doc.y;
      doc.rect(L, y, W, 18).fillColor(C.blue).fill();
      let cx = L;
      cols.forEach((c) => {
        doc.font("B").fontSize(8.5).fillColor("#FFFFFF").text(c.h, cx + 4, y + 4, { width: c.w - 8, lineBreak: false });
        cx += c.w;
      });
      doc.y = y + 18;
    };
    if (!rows.length) {
      doc.font("R").fontSize(10).fillColor(C.muted).text(empty, L, doc.y + 2, { width: W });
      return;
    }
    head();
    rows.forEach((r, ri) => {
      const cells = cols.map((c, i) => {
        doc.font(c.bold ? "B" : "R").fontSize(8.5);
        return { text: fit(doc, r[i] ?? "-", c.w - 9), w: c.w, color: c.color ? c.color(r) : C.ink, font: c.bold ? "B" : "R" };
      });
      const h = Math.max(...cells.map((c) => doc.font(c.font).fontSize(8.5).heightOfString(c.text, { width: c.w - 8 }))) + 8;
      if (doc.y + h > doc.page.height - 55) {
        doc.addPage();
        head();
      }
      const y = doc.y;
      if (ri % 2) doc.rect(L, y, W, h).fillColor(C.row).fill();
      let cx = L;
      cells.forEach((c) => {
        doc.font(c.font).fontSize(8.5).fillColor(c.color).text(c.text, cx + 4, y + 4, { width: c.w - 8 });
        cx += c.w;
      });
      doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.y = y + h;
    });
  }
  const ref = (c) => `${c.caseNo || "#" + c.id}${c.csNumber ? `\n${c.csNumber}` : ""}`;
  table(
    `Resolved in ${x.month} (${x.closed.length})`,
    [
      { h: "Case", w: 92, bold: true },
      { h: "Subject", w: 112 },
      { h: "Severity", w: 52 },
      { h: "Opened", w: 52 },
      { h: "Resolved", w: 52 },
      { h: "SLA", w: 40, color: (r) => (r[5] === "Met" ? C.green : C.red), bold: true },
      { h: "Resolution", w: W - 400 },
    ],
    x.closed.map((c) => [ref(c), c.task, c.severity || "-", day(c.startDate), day(c.endDate), c.closedOnTime ? "Met" : "Missed", c.resolution || "-"]),
    "No cases were resolved this month."
  );
  table(
    `Open at the end of ${x.month} (${x.openAtEnd.length})`,
    [
      { h: "Case", w: 92, bold: true },
      { h: "Subject", w: 161 },
      { h: "Severity", w: 55 },
      { h: "Opened", w: 60 },
      { h: "Target date", w: 62 },
      { h: "Engineer", w: W - 430 },
    ],
    x.openAtEnd.map((c) => [ref(c), c.task, c.severity || "-", day(c.startDate), day(c.dueDate), c.owner || "-"]),
    "No open cases at month end."
  );
  doc.moveDown(1.2);
  doc.font("R").fontSize(9).fillColor(C.muted).text(
    `“Resolved within SLA” compares each resolution date with the original target date (${config.slaDays} days from opening). Cancelled and duplicate requests are not included. For questions about this report please reply to the email it came with${config3.company.supportPhone ? ` or call ${config3.company.supportPhone}` : ""}.`,
    L, doc.y, { width: W }
  );

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing in the footer area must not start a new page
    doc.font("R").fontSize(8).fillColor(C.muted).text(`SINO S-TECH LIMITED · Support · ${x.site} · ${x.month}`, L, doc.page.height - 34, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, L + W / 2, doc.page.height - 34, { width: W / 2, align: "right", lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), data: x };
}

const fileName = (site, ym) => `Support-Report_${String(site).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}_${ym}.pdf`;
const emails = (s) => String(s || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));

async function settingFor(site) {
  return (await one("SELECT * FROM customer_reports WHERE lower(site) = lower($1)", [site])) || { site, enabled: false, recipients: "", cc: "", last_ym: null, last_sent_at: null };
}

/** Email one customer's report. */
async function send(site, ym, { to, cc, by } = {}) {
  const s = await settingFor(site);
  const T = emails(to ?? s.recipients);
  const CC = emails(cc ?? s.cc).filter((x) => !T.includes(x));
  if (!T.length) throw Object.assign(new Error("ยังไม่ได้ใส่อีเมลผู้รับของลูกค้ารายนี้"), { status: 400 });
  const { buffer, data: x } = await pdf(site, ym);
  const { esc, fieldTable } = require("../emails");
  const cm = require("./customermail");
  const html = cm.layout(
    "#1F5FBF",
    `<p style="margin:0 0 14px">Dear ${esc(x.site)} team,</p>
<p style="margin:0 0 14px">Please find attached the support report for <strong>${esc(x.month)}</strong>.</p>
${fieldTable([["New cases", x.opened], ["Resolved", x.closed.length], ["Resolved within SLA", x.slaPct == null ? "-" : x.slaPct + "%"], ["Open at month end", x.openAtEnd.length]])}
<p style="margin:14px 0 0">If you have any questions, simply reply to this email.</p>`,
    { footer: "Support, SINO S-TECH LIMITED" }
  );
  await require("../graph").sendMail({
    to: T, cc: CC,
    subject: `Monthly Support Report · ${x.site} · ${x.month}`,
    html,
    attachments: [{ name: fileName(x.site, x.ym), contentType: "application/pdf", buffer }],
  });
  await q(
    `INSERT INTO customer_reports (site, last_ym, last_sent_at) VALUES ($1,$2,now())
     ON CONFLICT (site) DO UPDATE SET last_ym = $2, last_sent_at = now()`,
    [s.site, x.ym]
  );
  await audit(by || null, "customer_report_sent", x.site, { month: x.ym, to: T, cc: CC });
  return { ok: true, to: T, cc: CC, month: x.ym };
}

/** Job (2nd of the month): last month's report to every customer that has it turned on. */
async function sendAll() {
  const ym = prevYm();
  const rows = await all("SELECT site FROM customer_reports WHERE enabled AND recipients <> '' AND (last_ym IS NULL OR last_ym < $1)", [ym]);
  const out = { sent: 0, failed: [] };
  for (const r of rows) {
    try {
      await send(r.site, ym);
      out.sent++;
    } catch (e) {
      console.error("[customer report]", r.site, e.message);
      out.failed.push(r.site);
    }
  }
  return out;
}

function mount(api, { wrap, need, perms }) {
  const canSend = async (user) => (await perms.level(user, "reports_manage")) === "all";
  api.get("/customer/report", wrap(async (req, res) => {
    const site = String(req.query.site || "").trim();
    const s = await settingFor(site);
    res.json({ setting: s, canEdit: await canSend(req.user), months: [0, 1, 2, 3, 4, 5].map((n) => { const t = d.today(); const x = new Date(t.getFullYear(), t.getMonth() - n, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; }), defaultMonth: prevYm() });
  }));
  api.get("/customer/report.pdf", wrap(async (req, res) => {
    if ((await perms.level(req.user, "export")) !== "all" && !(await canSend(req.user))) throw Object.assign(new Error("ไม่มีสิทธิ์ดาวน์โหลด Report ลูกค้า"), { status: 403 });
    const site = String(req.query.site || "").trim();
    if (!site) throw Object.assign(new Error("ไม่ได้ระบุลูกค้า"), { status: 400 });
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : prevYm();
    const { buffer, data: x } = await pdf(site, ym);
    await audit(req.user, "customer_report_download", x.site, { month: ym });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `${req.query.dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName(x.site, ym))}`);
    res.send(buffer);
  }));
  api.put("/customer/report", need("reports_manage"), wrap(async (req, res) => {
    const b = req.body || {};
    const site = String(b.site || "").trim();
    if (!(await one("SELECT 1 FROM lookups WHERE kind = 'site' AND lower(value) = lower($1)", [site]))) throw Object.assign(new Error("ไม่พบลูกค้ารายนี้ในรายการ"), { status: 400 });
    const to = emails(b.recipients);
    if (b.enabled && !to.length) throw Object.assign(new Error("ใส่อีเมลผู้รับของลูกค้าอย่างน้อย 1 คนก่อนเปิดส่งอัตโนมัติ"), { status: 400 });
    await q(
      `INSERT INTO customer_reports (site, enabled, recipients, cc, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (site) DO UPDATE SET enabled = $2, recipients = $3, cc = $4, updated_by = $5, updated_at = now()`,
      [site, !!b.enabled, to.join(", "), emails(b.cc).join(", "), req.user.id]
    );
    await audit(req.user, "customer_report_setting", site, { enabled: !!b.enabled, to, cc: emails(b.cc) });
    res.json({ ok: true, setting: await settingFor(site) });
  }));
  api.post("/customer/report/send", need("reports_manage"), wrap(async (req, res) => {
    const b = req.body || {};
    const ym = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : prevYm();
    res.json(await send(String(b.site || "").trim(), ym, { to: b.to, cc: b.cc, by: req.user }));
  }));
}

module.exports = { mount, pdf, data, send, sendAll, prevYm };
