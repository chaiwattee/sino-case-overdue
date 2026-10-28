// Date helpers. Every date here is a local calendar day (Asia/Bangkok),
// represented as a Date at local midnight.

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function today() {
  return startOfDay(new Date());
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return startOfDay(x);
}

// Whole calendar days from a to b (b - a). DST-safe enough for Asia/Bangkok.
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

// Excel cells arrive either as serial numbers (valuesOnly) or as text
// like "28/10/2026" (dd/mm/yyyy, as used in the Case List sheets).
function parseExcelDate(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number" && isFinite(val)) {
    if (val < 1) return null;
    const utc = new Date(Math.round((val - 25569) * DAY_MS));
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }
  const s = String(val).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    let year = Number(y.length === 2 ? "20" + y : y);
    if (year > 2400) year -= 543; // Buddhist year typed by hand
    const dt = new Date(year, Number(mo) - 1, Number(d));
    if (!isNaN(dt.getTime()) && dt.getDate() === Number(d)) return dt;
    return null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return null;
}

function toISODate(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromISODate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function thaiDate(d, opts = {}) {
  if (!d) return "-";
  return d.toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: opts.year === false ? undefined : "numeric",
  });
}

function previousWeekRange(ref = today()) {
  const daysSinceMonday = (ref.getDay() + 6) % 7;
  const thisMonday = addDays(ref, -daysSinceMonday);
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}

function previousMonthRange(ref = today()) {
  return {
    from: new Date(ref.getFullYear(), ref.getMonth() - 1, 1),
    to: new Date(ref.getFullYear(), ref.getMonth(), 0),
  };
}

function lastNDaysRange(n, ref = today()) {
  return { from: addDays(ref, -(n - 1)), to: ref };
}

module.exports = {
  DAY_MS,
  startOfDay,
  today,
  addDays,
  daysBetween,
  parseExcelDate,
  toISODate,
  fromISODate,
  thaiDate,
  previousWeekRange,
  previousMonthRange,
  lastNDaysRange,
};
