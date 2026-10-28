const { config } = require("./config");
const { parseExcelDate, daysBetween, addDays, toISODate, today: todayFn } = require("./dates");

const STAGES = {
  normal: { label: "ปกติ", order: 1 },
  r1: { label: "แจ้งรอบ 1", order: 2 },
  r2: { label: "แจ้งรอบ 2", order: 3 },
  overdue: { label: "เกิน Due", order: 4 },
  no_start: { label: "ไม่มี Start date", order: 0 },
  closed: { label: "ปิดแล้ว", order: -1 },
};

const COLS = {
  no: ["no", "no."],
  status: ["status"],
  site: ["site", "customer"],
  owner: ["owner"],
  ownerEmail: ["owner email", "email", "owner e-mail"],
  product: ["product"],
  targetDate: ["target date", "due date"],
  csNumber: ["cs number", "cs no", "cs no.", "case number"],
  task: ["task/case", "task", "case"],
  detail: ["activity/detail", "detail", "activity"],
  startDate: ["start date", "open date"],
  endDate: ["end date", "close date", "closed date"],
  note: ["note", "remark"],
};

function str(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function headerIndex(headers) {
  const norm = headers.map((h) => str(h).toLowerCase());
  const idx = {};
  for (const [field, names] of Object.entries(COLS)) {
    idx[field] = norm.findIndex((h) => names.includes(h));
  }
  return idx;
}

/** Turn the raw usedRange values of one Case List tab into case objects. */
function parseCaseList(values, source) {
  if (!values || values.length < 2) return [];
  // The header is the first row that contains "Owner" and "Start date".
  let headerRow = values.findIndex((r) => {
    const n = (r || []).map((c) => str(c).toLowerCase());
    return n.includes("owner") && n.includes("start date");
  });
  if (headerRow < 0) headerRow = 0;
  const idx = headerIndex(values[headerRow]);
  const get = (r, f) => (idx[f] >= 0 ? r[idx[f]] : "");

  const out = [];
  for (let i = headerRow + 1; i < values.length; i++) {
    const r = values[i] || [];
    const c = {
      source: source.key,
      sourceLabel: source.label || source.key,
      rowNumber: i + 1, // 1-based sheet row
      no: str(get(r, "no")),
      status: str(get(r, "status")),
      site: str(get(r, "site")),
      owner: str(get(r, "owner")),
      ownerEmail: str(get(r, "ownerEmail")).toLowerCase(),
      product: str(get(r, "product")),
      csNumber: str(get(r, "csNumber")),
      task: str(get(r, "task")),
      detail: str(get(r, "detail")),
      note: str(get(r, "note")),
      startDate: parseExcelDate(get(r, "startDate")),
      targetDate: parseExcelDate(get(r, "targetDate")),
      endDate: parseExcelDate(get(r, "endDate")),
    };
    // Template rows are pre-numbered; only keep rows someone actually filled in.
    if (!c.site && !c.owner && !c.csNumber && !c.task) continue;
    c.key = caseKey(c);
    out.push(c);
  }
  return out;
}

function caseKey(c) {
  if (c.csNumber) return `${c.source}:cs:${c.csNumber.toUpperCase()}`;
  if (c.no) return `${c.source}:no:${c.no}`;
  return `${c.source}:row:${c.rowNumber}`;
}

function isClosed(c) {
  return config.closedStatuses.includes(c.status.toLowerCase());
}

/** Add computed SLA fields (age, due, stage …) as of `today`. */
function withStage(c, today = todayFn()) {
  const x = { ...c };
  x.dueDate = c.startDate ? addDays(c.startDate, config.slaDays) : null;
  if (isClosed(c)) {
    x.stage = "closed";
    const closedOn = c.endDate || null;
    x.closedOnTime = closedOn && x.dueDate ? closedOn <= x.dueDate : null;
    x.age = c.startDate ? daysBetween(c.startDate, closedOn || today) : null;
  } else if (!c.startDate) {
    x.stage = "no_start";
    x.age = null;
  } else {
    x.age = daysBetween(c.startDate, today);
    x.daysLeft = daysBetween(today, x.dueDate);
    x.daysOverdue = x.daysLeft < 0 ? -x.daysLeft : 0;
    if (x.daysLeft < 0) x.stage = "overdue";
    else if (x.age >= config.alert2Day) x.stage = "r2";
    else if (x.age >= config.alert1Day) x.stage = "r1";
    else x.stage = "normal";
  }
  x.stageLabel = STAGES[x.stage].label;
  // Target date in the sheet should equal Start date + SLA days.
  x.targetMismatch =
    !!(c.targetDate && x.dueDate && toISODate(c.targetDate) !== toISODate(x.dueDate));
  return x;
}

function ownerId(c) {
  return (c.ownerEmail || c.owner || "(ไม่ระบุ)").toLowerCase();
}

module.exports = { STAGES, parseCaseList, withStage, isClosed, caseKey, ownerId };
