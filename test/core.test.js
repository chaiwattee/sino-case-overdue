process.env.MOCK_DATA = "1";
process.env.DISABLE_SCHEDULER = "1";
const test = require("node:test");
const assert = require("node:assert");
const d = require("../src/dates");
const { parseCaseList, withStage } = require("../src/cases");
const { alertFor, runAlerts } = require("../src/alerts");
const { store } = require("../src/store");
const { sync, getState } = require("../src/sync");

const HEADER = ["No", "Status", "Site", "Owner", "Owner Email", "Product", "Target date", "CS Number",
  "Task/Case", "Activity/Detail", "Start date", "End date", "Note"];
const fmt = (dt) => `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
const src = { key: "T", label: "Test" };

function caseWithAge(age, status = "In Progress") {
  const start = d.addDays(d.today(), -age);
  const [c] = parseCaseList([HEADER, [1, status, "KBANK", "A", "a@x.com", "P", "", "CS1", "t", "", fmt(start), "", ""]], src);
  return withStage(c);
}

test("dates: dd/mm/yyyy, serial numbers and Buddhist years", () => {
  assert.strictEqual(d.toISODate(d.parseExcelDate("28/10/2026")), "2026-10-28");
  assert.strictEqual(d.toISODate(d.parseExcelDate(46323)), "2026-10-28");
  assert.strictEqual(d.toISODate(d.parseExcelDate("28/10/2569")), "2026-10-28");
  assert.strictEqual(d.parseExcelDate("31/02/2026"), null);
  assert.strictEqual(d.parseExcelDate(""), null);
});

test("parse: skips empty pre-numbered template rows", () => {
  const rows = parseCaseList([HEADER, [1, "", "", "", "", "", "", "", "", "", "", "", ""], [2, "Pending", "SCB", "B", "", "", "", "", "x", "", "", "", ""]], src);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, "T:no:2");
});

test("stage boundaries: day 0-2 normal, 3-5 r1, 6-7 r2, 8+ overdue", () => {
  const expect = { 0: "normal", 2: "normal", 3: "r1", 5: "r1", 6: "r2", 7: "r2", 8: "overdue", 12: "overdue" };
  for (const [age, stage] of Object.entries(expect)) {
    assert.strictEqual(caseWithAge(Number(age)).stage, stage, `age ${age}`);
  }
  assert.strictEqual(caseWithAge(7).daysLeft, 0);
  assert.strictEqual(caseWithAge(10).daysOverdue, 3);
  assert.strictEqual(caseWithAge(9, "Resolved").stage, "closed");
  assert.strictEqual(caseWithAge(9, "cancel").stage, "closed");
});

test("alert keys: r1/r2 once, overdue once per day", () => {
  assert.strictEqual(alertFor(caseWithAge(4), "2026-10-28").dedupe, "T:cs:CS1|r1");
  assert.strictEqual(alertFor(caseWithAge(6), "2026-10-28").dedupe, "T:cs:CS1|r2");
  assert.strictEqual(alertFor(caseWithAge(9), "2026-10-28").dedupe, "T:cs:CS1|overdue|2026-10-28");
  assert.strictEqual(alertFor(caseWithAge(1), "2026-10-28"), null);
});

test("mock run: alerts are not sent twice the same day", async () => {
  const first = await runAlerts();
  assert.ok(first.sent > 0);
  assert.strictEqual(first.failed, 0);
  const second = await runAlerts();
  assert.strictEqual(second.sent, 0);
  assert.strictEqual(second.alreadySent, first.candidates);
});

test("start date edit is detected and logged", async () => {
  await sync();
  const c = getState().cases.find((x) => x.startDate && x.stage !== "closed");
  // Pretend the snapshot had an earlier start date.
  const snap = store.db.snapshots[c.key];
  const old = d.toISODate(d.addDays(c.startDate, -3));
  snap.start_date = old;
  const r = await sync();
  const ch = r.changes.find((x) => x.case_key === c.key && x.field === "start_date");
  assert.ok(ch, "change recorded");
  assert.strictEqual(ch.old_value, old);
  assert.strictEqual(ch.direction, "later");
  // Target date follows the formula, so it must not be reported separately.
  assert.ok(!r.changes.find((x) => x.case_key === c.key && x.field === "target_date"));
});
