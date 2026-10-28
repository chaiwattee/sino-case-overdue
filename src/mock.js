// Fake Case List data for MOCK_DATA=1 (local preview without Microsoft 365).
const { addDays, today } = require("./dates");

const HEADER = [
  "No", "Status", "Site", "Owner", "Owner Email", "Product", "Target date", "CS Number",
  "Task/Case", "Activity/Detail", "Start date", "End date", "Note", "Aging (Days)", "Overdue",
];

const OWNERS = {
  ENGAGE: [["Engineer A", "eng.a@example.com"], ["Engineer B", "eng.b@example.com"], ["Engineer C", "eng.c@example.com"]],
  NEXIDIA: [["Engineer D", "eng.d@example.com"], ["Engineer E", "eng.e@example.com"]],
  WFM: [["Engineer F", "eng.f@example.com"], ["Engineer A", "eng.a@example.com"]],
};
const SITES = ["KBANK", "SCB", "KTB", "AIA", "TISCO", "OTO SKY", "BBL", "KTC"];
const PRODUCTS = { ENGAGE: ["ENGAGE", "NRX", "CX ONE QM"], NEXIDIA: ["NEXIDIA"], WFM: ["WFM"] };
const TASKS = ["Recording missing audio", "Agent cannot log in", "Report not refreshing", "Server disk alert", "License renewal check"];

const fmt = (dt) => (dt ? `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}` : "");

// Ages chosen to cover every stage: normal, round 1, round 2, overdue, closed.
const PLAN = {
  ENGAGE: [0, 1, 3, 4, 6, 7, 9, 12, -5, -8, -10, null],
  NEXIDIA: [2, 3, 6, 8, 11, -4, -9],
  WFM: [1, 5, 6, 10, -6, -12],
};

function mockSheet(sourceKey) {
  const rows = [HEADER];
  const t = today();
  const owners = OWNERS[sourceKey] || OWNERS.ENGAGE;
  (PLAN[sourceKey] || []).forEach((age, i) => {
    const [owner, email] = owners[i % owners.length];
    const closed = age !== null && age < 0;
    const realAge = age === null ? null : Math.abs(age);
    const start = realAge === null ? null : addDays(t, -realAge);
    const end = closed ? addDays(start, realAge > 8 ? 9 : 5) : null;
    rows.push([
      i + 1,
      closed ? (i % 2 ? "Resolved" : "Success") : i % 3 === 0 ? "Pending" : "In Progress",
      SITES[(i + sourceKey.length) % SITES.length],
      owner,
      email,
      PRODUCTS[sourceKey][i % PRODUCTS[sourceKey].length],
      start ? fmt(addDays(start, 7)) : "",
      `CS${5056000 + sourceKey.length * 100 + i}`,
      TASKS[i % TASKS.length],
      "Mock detail",
      fmt(start),
      fmt(end),
      "",
      realAge ?? "",
      "",
    ]);
  });
  // Empty pre-numbered template rows, like the real sheet.
  const first = rows.length;
  for (let n = first; n < first + 5; n++) rows.push([n, "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
  return rows;
}

module.exports = { mockSheet };
