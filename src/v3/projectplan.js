"use strict";
// The Sinostech standard project plan sheet (TemplateProjectPlan): one layout for the blank form, for a
// project exported from the system, and for what the importer reads back.
//   A No. · B Activity / Task · C Owner (Who) · D Estimate Manday · E Predecessors / Dependency · F Start · G Finish
//   H % Comp. · I Status · J… one column per week (the bar is drawn by conditional formatting)
// A milestone is a full-width row: "Milestone 2 — Discovery & Design     |     15 Jun – 15 Aug 2026".

const STATUSES = ["Not Started", "In Progress", "Completed", "Delayed", "On Hold"];
const ST_FILL = { "Not Started": "FFE0E0E0", "In Progress": "FF7AC143", Completed: "FF4C9C2E", Delayed: "FFE74C3C", "On Hold": "FFF4B400" };
const GREEN = "FF4C9C2E";
const DARK = "FF2E6B17";
const INK = "FF1A1A1A";
const MAX_WEEKS = 78;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utc = (iso) => new Date(iso + "T00:00:00Z");
const isoOf = (d) => d.toISOString().slice(0, 10);
const short = (iso, year) => {
  const d = utc(iso);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
};
const mondayOf = (iso) => {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
};

/** "Milestone 2 — Discovery & Design | 15 Jun – 15 Aug 2026" → "Discovery & Design" */
function milestoneName(text) {
  return String(text || "").replace(/\s*\|.*$/s, "").replace(/^\s*milestone\s*\d*\s*[—–:\-]\s*/i, "").replace(/\s+/g, " ").trim();
}

/**
 * @param {{ sheet?: string, milestones: {name: string, tasks: {no?: number, name: string, owner?: string, md?: number, pred?: string,
 *   start: string, finish: string, pct?: number, status?: string}[]}[], help?: string[][] }} plan  dates are ISO days
 */
async function planWorkbook(plan) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(plan.sheet || "Project Plan", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:2" } });
  const all = plan.milestones.flatMap((m) => m.tasks);
  const days = all.flatMap((t) => [t.start, t.finish]).filter(Boolean).sort();
  const first = mondayOf(days[0] || isoOf(new Date()));
  const last = utc(days[days.length - 1] || isoOf(new Date()));
  const weeks = [];
  for (let d = new Date(first); d <= last && weeks.length < MAX_WEEKS; d.setUTCDate(d.getUTCDate() + 7)) weeks.push(new Date(d));
  while (weeks.length < 8) weeks.push(new Date(weeks[weeks.length - 1].getTime() + 7 * 86400000));
  const W0 = 10; // column J
  const lastCol = W0 + weeks.length - 1;

  [6.5, 49, 21, 11, 13, 11, 11, 9, 13].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (let c = W0; c <= lastCol; c++) ws.getColumn(c).width = 4.5;

  const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const head = ["No.", "Activity / Task", "Owner (Who)", "Estimate\nManday", "Predecessors\n/Dependency", "Start", "Finish", "%\nComp.", "Status"];
  head.forEach((h, i) => {
    ws.mergeCells(1, i + 1, 2, i + 1);
    const c = ws.getCell(1, i + 1);
    c.value = h;
    c.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = border;
    ws.getCell(2, i + 1).border = border;
  });
  // Week columns: the month over its weeks, the Monday under it.
  let from = 0;
  weeks.forEach((w, i) => {
    const c = ws.getCell(2, W0 + i);
    c.value = w;
    c.numFmt = "d/m";
    c.font = { name: "Arial", size: 8, bold: true, color: { argb: INK } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF5DC" } };
    c.border = border;
    const next = weeks[i + 1];
    if (!next || next.getUTCMonth() !== w.getUTCMonth()) {
      if (i > from) ws.mergeCells(1, W0 + from, 1, W0 + i);
      const m = ws.getCell(1, W0 + from);
      m.value = `${MON[w.getUTCMonth()]} ${w.getUTCFullYear()}`;
      m.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
      m.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
      m.alignment = { horizontal: "center", vertical: "middle" };
      for (let k = from; k <= i; k++) ws.getCell(1, W0 + k).border = border;
      from = i + 1;
    }
  });
  ws.getRow(1).height = 24;
  ws.getRow(2).height = 19.5;

  let r = 3;
  let seq = 0;
  plan.milestones.forEach((m, mi) => {
    const ds = m.tasks.flatMap((t) => [t.start, t.finish]).filter(Boolean).sort();
    ws.mergeCells(r, 1, r, 9);
    const c = ws.getCell(r, 1);
    c.value = `Milestone ${mi + 1} — ${m.name}${ds.length ? `     |     ${short(ds[0])} – ${short(ds[ds.length - 1], true)}` : ""}`;
    c.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    c.alignment = { horizontal: "left", vertical: "middle" };
    for (let k = 1; k <= lastCol; k++) ws.getCell(r, k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK } };
    ws.getRow(r).height = 18;
    r++;
    for (const t of m.tasks) {
      seq++;
      const vals = [t.no || seq, t.name, t.owner || "", t.md || null, t.pred || "", t.start ? utc(t.start) : null, t.finish ? utc(t.finish) : null, Math.max(0, Math.min(100, Number(t.pct) || 0)) / 100, STATUSES.includes(t.status) ? t.status : "Not Started"];
      vals.forEach((v, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = v;
        cell.font = { name: "Arial", size: 9, bold: i === 0, color: { argb: INK } };
        cell.alignment = { horizontal: i === 1 || i === 2 ? "left" : "center", vertical: "middle", wrapText: true };
        cell.border = border;
        if (i === 5 || i === 6) cell.numFmt = "d-mmm-yy";
        if (i === 7) cell.numFmt = "0%";
      });
      for (let k = W0; k <= lastCol; k++) ws.getCell(r, k).border = border;
      ws.getRow(r).height = Math.min(300, Math.max(25.5, 13 * String(t.name).split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 52)), 0)));
      r++;
    }
  });
  const end = Math.max(r - 1, 3) + 40; // room to add tasks: formats keep working on the empty lines below
  const colL = ws.getColumn(lastCol).letter;
  ws.dataValidations.add(`I3:I${end}`, { type: "list", allowBlank: true, formulae: [`"${STATUSES.join(",")}"`] });
  ws.dataValidations.add(`H3:H${end}`, { type: "decimal", operator: "between", allowBlank: true, formulae: [0, 1], showErrorMessage: true, error: "0% – 100%" });
  ws.addConditionalFormatting({
    ref: `I3:I${end}`,
    rules: STATUSES.map((s, i) => ({ type: "expression", priority: i + 1, formulae: [`EXACT(I3,"${s}")`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: ST_FILL[s] } }, font: { color: { argb: s === "Not Started" || s === "On Hold" ? INK : "FFFFFFFF" } } } })),
  });
  ws.addConditionalFormatting({
    ref: `J3:${colL}${end}`,
    rules: [
      { type: "expression", priority: 10, formulae: ['AND(J$2<=$G3,J$2+6>=$F3,$F3<>"",$I3="Completed")'], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: ST_FILL.Completed } } } },
      { type: "expression", priority: 11, formulae: ['AND(J$2<=$G3,J$2+6>=$F3,$F3<>"",$I3="Delayed")'], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: ST_FILL.Delayed } } } },
      { type: "expression", priority: 12, formulae: ['AND(J$2<=$G3,J$2+6>=$F3,$F3<>"")'], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: ST_FILL["In Progress"] } } } },
    ],
  });
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];

  if (plan.help && plan.help.length) {
    const h = wb.addWorksheet("วิธีกรอก");
    h.columns = [{ width: 28 }, { width: 100 }];
    plan.help.forEach((row) => h.addRow(row));
    h.getRow(1).font = { bold: true };
    h.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { planWorkbook, milestoneName, STATUSES };
