// Manager reports (scheduled + manual), Excel/CSV export.
const ExcelJS = require("exceljs");
const { config } = require("./config");
const graph = require("./graph");
const { store } = require("./store");
const { sync, getState } = require("./sync");
const { reportEmail } = require("./emails");
const { ownerId } = require("./cases");
const d = require("./dates");

function inRange(date, from, to) {
  return !!date && date >= from && date <= to;
}

function resolveRange(rangeType, ref = d.today()) {
  switch (rangeType) {
    case "yesterday":
      return { from: d.addDays(ref, -1), to: d.addDays(ref, -1) };
    case "last_7":
      return d.lastNDaysRange(7, ref);
    case "last_30":
      return d.lastNDaysRange(30, ref);
    case "month_to_date":
      return { from: new Date(ref.getFullYear(), ref.getMonth(), 1), to: ref };
    case "prev_month":
      return d.previousMonthRange(ref);
    case "prev_week":
    default:
      return d.previousWeekRange(ref);
  }
}

function rangeLabel(from, to) {
  return from.getTime() === to.getTime()
    ? d.thaiDate(from)
    : `${d.thaiDate(from, { year: from.getFullYear() !== to.getFullYear() })} – ${d.thaiDate(to)}`;
}

/**
 * Report numbers for [from, to] (inclusive local days).
 * owner: optional owner email/name to restrict to one person.
 */
async function buildReport({ from, to, owner, cases: given, changes: givenChanges } = {}) {
  let cases = given || getState().cases;
  if (owner) {
    const o = owner.toLowerCase();
    cases = cases.filter((c) => ownerId(c) === o || c.owner.toLowerCase() === o);
  }
  const closedDate = (c) => c.endDate || c.closedAt || null;

  const opened = cases.filter((c) => inRange(c.startDate, from, to));
  const closed = cases.filter((c) => c.stage === "closed" && inRange(closedDate(c), from, to));
  const closedOnTime = closed.filter((c) => c.closedOnTime === true);
  const openNow = cases.filter((c) => c.stage !== "closed");
  const overdueNow = cases
    .filter((c) => c.stage === "overdue")
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const byOwner = new Map();
  const row = (c) => {
    const id = ownerId(c);
    if (!byOwner.has(id))
      byOwner.set(id, {
        id,
        owner: c.owner || "(ไม่ระบุ)",
        email: c.ownerEmail,
        opened: 0,
        closed: 0,
        closedOnTime: 0,
        open: 0,
        overdue: 0,
      });
    return byOwner.get(id);
  };
  opened.forEach((c) => row(c).opened++);
  closed.forEach((c) => {
    row(c).closed++;
    if (c.closedOnTime) row(c).closedOnTime++;
  });
  openNow.forEach((c) => row(c).open++);
  overdueNow.forEach((c) => row(c).overdue++);

  let changes = [];
  try {
    const all = givenChanges || (await store.listChanges({ from: from.toISOString(), limit: 1000 }));
    const end = d.addDays(to, 1);
    changes = all.filter((ch) => new Date(ch.detected_at) >= from && new Date(ch.detected_at) < end);
    if (owner) {
      const o = owner.toLowerCase();
      changes = changes.filter(
        (ch) => (ch.owner_email || "").toLowerCase() === o || (ch.owner || "").toLowerCase() === o
      );
    }
  } catch (e) {
    console.error("[report] listChanges failed:", e.message);
  }

  return {
    from,
    to,
    rangeLabel: rangeLabel(from, to),
    generatedAt: new Date().toISOString(),
    kpis: {
      opened: opened.length,
      closed: closed.length,
      closedOnTime: closedOnTime.length,
      slaPct: closed.length ? Math.round((closedOnTime.length / closed.length) * 100) : null,
      openNow: openNow.length,
      overdueNow: overdueNow.length,
    },
    owners: [...byOwner.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    openedCases: opened,
    closedCases: closed,
    openCases: openNow,
    overdueCases: overdueNow,
    changes,
  };
}

const CASE_COLUMNS = [
  { header: "เอกสาร", key: "source", width: 12 },
  { header: "CS Number", key: "csNumber", width: 14 },
  { header: "Status", key: "status", width: 13 },
  { header: "สถานะ SLA", key: "stageLabel", width: 14 },
  { header: "Site", key: "site", width: 16 },
  { header: "Owner", key: "owner", width: 22 },
  { header: "Owner Email", key: "ownerEmail", width: 26 },
  { header: "Product", key: "product", width: 12 },
  { header: "Task/Case", key: "task", width: 40 },
  { header: "Start date", key: "startDate", width: 12 },
  { header: "Due (Start+7)", key: "dueDate", width: 13 },
  { header: "End date", key: "endDate", width: 12 },
  { header: "อายุเคส (วัน)", key: "age", width: 12 },
  { header: "เกิน Due (วัน)", key: "daysOverdue", width: 13 },
];

function caseRow(c) {
  return {
    ...c,
    startDate: c.startDate || null,
    dueDate: c.dueDate || null,
    endDate: c.endDate || c.closedAt || null,
    daysOverdue: c.daysOverdue || 0,
  };
}

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9ECF0" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  rows.forEach((r) => ws.addRow(r));
  columns.forEach((c, i) => {
    if (/date|due/i.test(c.key)) ws.getColumn(i + 1).numFmt = "dd/mm/yyyy";
  });
  return ws;
}

async function reportWorkbook(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sino Case Tracker";
  addSheet(
    wb,
    "สรุปราย Owner",
    [
      { header: "Owner", key: "owner", width: 24 },
      { header: "Email", key: "email", width: 28 },
      { header: "เปิดใหม่ในช่วงนี้", key: "opened", width: 16 },
      { header: "ปิดในช่วงนี้", key: "closed", width: 13 },
      { header: "ปิดทัน SLA", key: "closedOnTime", width: 12 },
      { header: "ยังเปิดอยู่", key: "open", width: 12 },
      { header: "เกิน Due ขณะนี้", key: "overdue", width: 15 },
    ],
    rep.owners
  );
  const scope = new Map();
  [...rep.openedCases, ...rep.closedCases, ...rep.openCases].forEach((c) => scope.set(c.key, c));
  addSheet(wb, "เคสทั้งหมด", CASE_COLUMNS, [...scope.values()].map(caseRow));
  addSheet(wb, "เกิน Due", CASE_COLUMNS, rep.overdueCases.map(caseRow));
  addSheet(
    wb,
    "การแก้ไขวันที่",
    [
      { header: "ตรวจพบเมื่อ", key: "detected", width: 18 },
      { header: "เอกสาร", key: "source", width: 12 },
      { header: "CS Number", key: "cs_number", width: 14 },
      { header: "Owner", key: "owner", width: 22 },
      { header: "ช่อง", key: "field", width: 12 },
      { header: "เดิม", key: "old_value", width: 12 },
      { header: "ใหม่", key: "new_value", width: 12 },
      { header: "ทิศทาง", key: "direction", width: 10 },
      { header: "แก้ไฟล์ล่าสุดโดย", key: "last_modified_by", width: 22 },
    ],
    rep.changes.map((c) => ({
      ...c,
      detected: new Date(c.detected_at).toLocaleString("th-TH"),
    }))
  );
  return wb.xlsx.writeBuffer();
}

function csvEscape(v) {
  if (v instanceof Date) v = d.toISODate(v);
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function casesCsv(cases) {
  const lines = [CASE_COLUMNS.map((c) => csvEscape(c.header)).join(",")];
  cases.map(caseRow).forEach((r) => lines.push(CASE_COLUMNS.map((c) => csvEscape(r[c.key])).join(",")));
  return "﻿" + lines.join("\r\n"); // BOM so Excel opens Thai text correctly
}

function splitList(s) {
  return String(s || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /@/.test(x));
}

async function sendReport({ title, recipients, cc, from, to, owner, attachExcel = true, scheduleId = null }) {
  await sync();
  const rep = await buildReport({ from, to, owner });
  const { subject, html } = reportEmail(rep, title || "รายงานสถานะเคส");
  const toList = splitList(recipients);
  const ccList = splitList(cc);
  if (toList.length === 0) throw new Error("ไม่มีอีเมลผู้รับ");
  const fileName = `case-report-${d.toISODate(from)}_${d.toISODate(to)}.xlsx`;
  const attachments = attachExcel
    ? [
        {
          name: fileName,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: await reportWorkbook(rep),
        },
      ]
    : [];
  let ok = true;
  let error = null;
  let dryRun = false;
  try {
    const r = await graph.sendMail({ to: toList, cc: ccList, subject, html, attachments });
    dryRun = !!r.dryRun;
  } catch (e) {
    ok = false;
    error = String(e.response?.data?.error?.message || e.message).slice(0, 500);
  }
  await store
    .insertReport({
      schedule_id: scheduleId,
      title: title || "รายงานสถานะเคส",
      range_from: d.toISODate(from),
      range_to: d.toISODate(to),
      recipients: toList.join(","),
      cc: ccList.join(","),
      file_name: attachExcel ? fileName : null,
      ok,
      error: dryRun ? "DRY_RUN_EMAIL=1 (ไม่ได้ส่งจริง)" : error,
    })
    .catch((e) => console.error("[report] log failed:", e.message));
  if (!ok) throw new Error(error);
  return { ok, dryRun, subject, recipients: toList };
}

// ------------------------------------------------------------ Schedules
const WEEKDAY_TH = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];

function scheduleMatchesToday(s, now = new Date()) {
  const isoDow = ((now.getDay() + 6) % 7) + 1; // Mon=1 … Sun=7
  if (s.frequency === "weekly" && Number(s.day_of_week) !== isoDow) return false;
  if (s.frequency === "monthly" && Number(s.day_of_month) !== now.getDate()) return false;
  const [hh, mm] = String(s.send_time || "08:30").split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

function describeSchedule(s) {
  const time = s.send_time || "08:30";
  if (s.frequency === "daily") return `ทุกวัน ${time}`;
  if (s.frequency === "monthly") return `วันที่ ${s.day_of_month} ของเดือน ${time}`;
  return `ทุกวัน${WEEKDAY_TH[s.day_of_week] || "จันทร์"} ${time}`;
}

async function runDueSchedules(now = new Date()) {
  const results = [];
  const todayIso = d.toISODate(d.startOfDay(now));
  let schedules = [];
  try {
    schedules = await store.listSchedules();
  } catch (e) {
    console.error("[schedules] list failed:", e.message);
    return results;
  }
  for (const s of schedules) {
    if (!s.enabled || s.last_period === todayIso || !scheduleMatchesToday(s, now)) continue;
    const { from, to } = resolveRange(s.range_type, d.startOfDay(now));
    try {
      await sendReport({
        title: s.name,
        recipients: s.recipients,
        cc: s.cc,
        from,
        to,
        attachExcel: s.attach_excel !== false,
        scheduleId: s.id,
      });
      results.push({ id: s.id, ok: true });
    } catch (e) {
      results.push({ id: s.id, ok: false, error: e.message });
    }
    // Mark the period done either way so a broken address does not resend every 5 minutes.
    await store.saveSchedule({ id: s.id, last_period: todayIso, last_sent_at: new Date().toISOString() });
  }
  return results;
}

module.exports = {
  buildReport,
  reportWorkbook,
  casesCsv,
  sendReport,
  resolveRange,
  rangeLabel,
  runDueSchedules,
  describeSchedule,
  caseRow,
};
