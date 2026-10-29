// HTML email templates (inline styles only, for Outlook).
const { config } = require("./config");
const { thaiDate } = require("./dates");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const COLORS = {
  r1: { bar: "#D08A1E", bg: "#FBF1DC", fg: "#7A4A00" },
  r2: { bar: "#C2410C", bg: "#FDE7DC", fg: "#9A3412" },
  overdue: { bar: "#8E1B3A", bg: "#8E1B3A", fg: "#FFFFFF" },
  normal: { bar: "#4C8C77", bg: "#E6F0EC", fg: "#2F5D50" },
  closed: { bar: "#8A93A3", bg: "#ECEEF2", fg: "#4A5363" },
  no_start: { bar: "#8A93A3", bg: "#ECEEF2", fg: "#4A5363" },
};

function shell(barColor, inner) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#E9ECF0;font-family:'Segoe UI',Tahoma,sans-serif;color:#18212E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#FFFFFF;border:1px solid #D9DEE5;border-radius:10px;overflow:hidden">
<tr><td style="height:6px;background:${barColor};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.6">${inner}
<p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #E2E5EA;font-size:12px;color:#5B6576">Email นี้ส่งอัตโนมัติจาก Sino Case Tracker${
    config.dashboardUrl ? ` · <a href="${esc(config.dashboardUrl)}" style="color:#1F4FD1">เปิด Dashboard</a>` : ""
  }</p>
</td></tr></table></body></html>`;
}

function fieldTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E2E5EA;font-size:14px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:9px 14px;width:150px;background:#F6F7F9;color:#5B6576;border-bottom:1px solid #E2E5EA">${esc(
          k
        )}</td><td style="padding:9px 14px;border-bottom:1px solid #E2E5EA;font-weight:600">${esc(v)}</td></tr>`
    )
    .join("")}</table>`;
}

function button(href, label, primary = true) {
  if (!href) return "";
  const style = primary
    ? "background:#1F4FD1;color:#FFFFFF;border:1px solid #1F4FD1"
    : "background:#FFFFFF;color:#18212E;border:1px solid #C9CFD8";
  return `<a href="${esc(href)}" style="display:inline-block;padding:10px 18px;margin:0 8px 8px 0;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;${style}">${esc(
    label
  )}</a>`;
}

/** Alert to the case owner: type = r1 | r2 | overdue */
function caseAlertEmail(c, type) {
  const id = c.csNumber || `แถว ${c.no || c.rowNumber}`;
  let subject;
  let lead;
  if (type === "r1") {
    subject = `[แจ้งเตือนรอบ 1] เคส ${id} เหลือ ${c.daysLeft} วันก่อนครบกำหนด`;
    lead = `เคสด้านล่างเปิดมาแล้ว <strong>${c.age} วัน</strong> ต้องปิดภายใน ${config.slaDays} วัน (ครบกำหนด ${esc(
      thaiDate(c.dueDate)
    )})`;
  } else if (type === "r2") {
    subject = `[แจ้งเตือนรอบ 2] เคส ${id} เหลือ ${c.daysLeft} วันก่อนครบกำหนด`;
    lead = `เคสด้านล่างเปิดมาแล้ว <strong>${c.age} วัน</strong> และจะครบกำหนดปิดใน ${
      c.daysLeft === 0 ? "<strong>วันนี้</strong>" : `<strong>${c.daysLeft} วัน</strong>`
    } (${esc(thaiDate(c.dueDate))})`;
  } else {
    subject = `[เกินกำหนด] เคส ${id} เกิน Due มาแล้ว ${c.daysOverdue} วัน`;
    lead = `เคสด้านล่าง<strong>เกินกำหนดปิดมาแล้ว ${c.daysOverdue} วัน</strong> (ครบกำหนด ${esc(
      thaiDate(c.dueDate)
    )}) ระบบจะแจ้งเตือนทุกวันจนกว่าสถานะจะเป็นปิดเคส`;
  }
  if (c.site) subject += ` · ${c.site}`;

  const html = shell(
    COLORS[type].bar,
    `<p style="margin:0 0 12px">เรียน ${esc(c.owner || "Owner")}</p>
<p style="margin:0 0 18px">${lead} กรุณาอัปเดตสถานะหรือปิดเคส${c.caseUrl ? "บนหน้าเว็บ" : "ใน Case List"}</p>
${fieldTable([
  ["เลขเคส (CS)", c.csNumber || "-"],
  ["ลูกค้า / Site", c.site || "-"],
  ["Product", c.product || "-"],
  ["Task / Case", c.task || "-"],
  ["รายละเอียด", c.detail || "-"],
  c.caseUrl ? ["ทีม", c.sourceLabel] : ["เอกสาร", `${c.sourceLabel} · tab ${config.sheetName} แถว ${c.rowNumber}`],
  ["วันเปิดเคส", thaiDate(c.startDate)],
  ["กำหนดปิด (Due)", thaiDate(c.dueDate)],
  ["สถานะปัจจุบัน", c.status || "-"],
])}
<p style="margin:18px 0 0">${
      c.caseUrl
        ? button(c.caseUrl, "เปิดเคสเพื่ออัปเดต")
        : button(
            config.dashboardUrl && `${config.dashboardUrl}/#/owner/${encodeURIComponent(c.ownerEmail || c.owner)}`,
            "ดูเคสบน Dashboard"
          ) + button(c.fileUrl, "เปิดเอกสาร Case List", false)
    }</p>`
  );
  return { subject, html };
}

const FIELD_TH = { start_date: "Start date", target_date: "Target date" };
const DIR_TH = { later: "เลื่อนออกไป", earlier: "เลื่อนเข้ามา", set: "ใส่ค่าใหม่", cleared: "ลบค่าออก" };

function isoToThai(s) {
  if (!s) return "(ว่าง)";
  const [y, m, d] = s.split("-").map(Number);
  return thaiDate(new Date(y, m - 1, d));
}

/** Digest of Start date / Target date edits found in one sync. */
function auditEmail(changes) {
  const subject = `[ตรวจพบการแก้ไขวันที่] ${changes.length} รายการ ใน Case List`;
  const rows = changes
    .map(
      (c) => `<tr>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3">${esc(c.cs_number || c.case_key)}<br><span style="color:#5B6576;font-size:12px">${esc(
        c.source
      )} · ${esc(c.site || "-")}</span></td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3">${esc(c.owner || "-")}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3">${esc(FIELD_TH[c.field] || c.field)}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3">${esc(isoToThai(c.old_value))} → <strong>${esc(
        isoToThai(c.new_value)
      )}</strong><br><span style="font-size:12px;color:${c.direction === "later" ? "#9A3412" : "#5B6576"}">${esc(
        DIR_TH[c.direction] || ""
      )}</span></td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;font-size:13px">${esc(c.last_modified_by || "-")}</td>
</tr>`
    )
    .join("");
  const html = shell(
    "#1F4FD1",
    `<p style="margin:0 0 12px;font-size:17px;font-weight:700">ตรวจพบการแก้ไข Start date / Target date</p>
<p style="margin:0 0 16px">Start date ถูก stamp อัตโนมัติครั้งเดียวตอนเปิดเคส การแก้ไขภายหลังจะทำให้นับวัน SLA ใหม่ จึงแจ้งให้ตรวจสอบ</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
<tr style="text-align:left;color:#5B6576;font-size:12px"><th style="padding:8px 10px;border-bottom:1px solid #E2E5EA">เคส</th><th style="padding:8px 10px;border-bottom:1px solid #E2E5EA">Owner</th><th style="padding:8px 10px;border-bottom:1px solid #E2E5EA">ช่อง</th><th style="padding:8px 10px;border-bottom:1px solid #E2E5EA">เดิม → ใหม่</th><th style="padding:8px 10px;border-bottom:1px solid #E2E5EA">แก้ไฟล์ล่าสุดโดย</th></tr>
${rows}</table>
<p style="margin:14px 0 0;font-size:12px;color:#5B6576">"แก้ไฟล์ล่าสุดโดย" คือผู้ที่บันทึกไฟล์ครั้งล่าสุด อาจไม่ใช่ผู้ที่แก้แถวนี้โดยตรงหากมีหลายคนแก้ไฟล์ในช่วงเดียวกัน</p>`
  );
  return { subject, html };
}

/** Manager report built from reports.buildReport() output. */
function reportEmail(rep, title) {
  const k = rep.kpis;
  const tile = (label, value, color) =>
    `<td style="padding:12px 14px;border:1px solid #E2E5EA;border-radius:8px;width:25%"><div style="font-size:12px;color:#5B6576">${esc(
      label
    )}</div><div style="font-size:24px;font-weight:700;color:${color}">${esc(value)}</div></td>`;
  const ownerRows = rep.owners
    .map(
      (o) => `<tr>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3">${esc(o.owner)}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;text-align:right">${o.opened}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;text-align:right">${o.closed}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;text-align:right">${o.closedOnTime}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;text-align:right">${o.open}</td>
<td style="padding:8px 10px;border-bottom:1px solid #EEF0F3;text-align:right;color:#8E1B3A;font-weight:700">${o.overdue}</td>
</tr>`
    )
    .join("");
  const overdueRows = rep.overdueCases
    .slice(0, 30)
    .map(
      (c) => `<tr>
<td style="padding:7px 10px;border-bottom:1px solid #EEF0F3">${esc(c.csNumber || "-")}</td>
<td style="padding:7px 10px;border-bottom:1px solid #EEF0F3">${esc(c.site || "-")}</td>
<td style="padding:7px 10px;border-bottom:1px solid #EEF0F3">${esc(c.owner || "-")}</td>
<td style="padding:7px 10px;border-bottom:1px solid #EEF0F3;text-align:right;color:#8E1B3A;font-weight:700">${c.daysOverdue} วัน</td>
</tr>`
    )
    .join("");
  const th = (t, right) =>
    `<th style="padding:8px 10px;border-bottom:1px solid #E2E5EA;font-weight:600;${right ? "text-align:right" : "text-align:left"}">${t}</th>`;

  const subject = `${title} · ${rep.rangeLabel}`;
  const html = shell(
    "#18212E",
    `<p style="margin:0 0 4px;font-size:19px;font-weight:700">${esc(title)}</p>
<p style="margin:0 0 18px;color:#5B6576;font-size:14px">ช่วงข้อมูล ${esc(rep.rangeLabel)} · SLA ปิดเคสภายใน ${config.slaDays} วัน</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 0 18px"><tr>
${tile("เปิดเคสในช่วงนี้", k.opened, "#18212E")}${tile("ปิดในช่วงนี้", k.closed, "#2F5D50")}${tile(
      "ปิดทัน SLA",
      k.slaPct === null ? "-" : `${k.slaPct}%`,
      "#1F4FD1"
    )}${tile("เกิน Due ขณะนี้", k.overdueNow, "#8E1B3A")}
</tr></table>
<p style="margin:0 0 8px;font-weight:700">แยกตาม Owner</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:0 0 18px">
<tr style="color:#5B6576;font-size:12px">${th("Owner")}${th("เปิดใหม่", 1)}${th("ปิด", 1)}${th("ปิดทัน SLA", 1)}${th(
      "ยังเปิดอยู่",
      1
    )}${th("เกิน Due", 1)}</tr>
${ownerRows || `<tr><td colspan="6" style="padding:10px;color:#5B6576">ไม่มีข้อมูลในช่วงนี้</td></tr>`}
</table>
${
  rep.overdueCases.length
    ? `<p style="margin:0 0 8px;font-weight:700">เคสที่เกิน Due ขณะนี้ (${rep.overdueCases.length})</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:0 0 18px">
<tr style="color:#5B6576;font-size:12px">${th("CS")}${th("ลูกค้า")}${th("Owner")}${th("เกิน", 1)}</tr>${overdueRows}</table>`
    : ""
}
${
  rep.changes.length
    ? `<p style="margin:0;font-size:14px">มีการแก้ไข Start date / Target date <strong>${rep.changes.length} ครั้ง</strong> ในช่วงนี้ (ดูรายละเอียดในไฟล์แนบ)</p>`
    : ""
}`
  );
  return { subject, html };
}

module.exports = { caseAlertEmail, auditEmail, reportEmail, COLORS, esc };
