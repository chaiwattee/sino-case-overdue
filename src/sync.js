// Reads the 3 Case List tabs, computes SLA stage per case, keeps snapshots in
// the store and records Start date / Target date edits (audit log).
const { config } = require("./config");
const graph = require("./graph");
const { store } = require("./store");
const { parseCaseList, withStage, isClosed } = require("./cases");
const { today: todayFn, toISODate, fromISODate } = require("./dates");

const state = {
  syncedAt: null,
  cases: [],
  sources: [],
  lastChanges: [],
  error: null,
};

async function readSource(source) {
  if (config.mock) {
    const { mockSheet } = require("./mock");
    return {
      values: mockSheet(source.key),
      meta: {
        name: `${source.key}_Engineer_Case_2026.xlsx`,
        webUrl: "#",
        lastModifiedDateTime: new Date().toISOString(),
        lastModifiedBy: { user: { displayName: "Mock User" } },
      },
    };
  }
  const [values, meta] = await Promise.all([
    graph.readSheetValues(source.itemId),
    graph.getFileMeta(source.itemId).catch(() => null),
  ]);
  return { values, meta };
}

function changeDirection(oldIso, newIso) {
  if (!oldIso && newIso) return "set";
  if (oldIso && !newIso) return "cleared";
  return newIso > oldIso ? "later" : "earlier";
}

let running = null;

async function sync() {
  if (running) return running;
  running = doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  const today = todayFn();
  const all = [];
  const sources = [];

  for (const src of config.sources) {
    const info = { key: src.key, label: src.label, count: 0, error: null };
    try {
      const { values, meta } = await readSource(src);
      const cases = parseCaseList(values, src).map((c) => {
        c.fileUrl = meta?.webUrl || null;
        return c;
      });
      info.count = cases.length;
      info.name = meta?.name;
      info.webUrl = meta?.webUrl;
      info.lastModified = meta?.lastModifiedDateTime;
      info.lastModifiedBy = meta?.lastModifiedBy?.user?.displayName || null;
      all.push(...cases);
    } catch (e) {
      info.error = e.response?.data?.error?.message || e.message;
      console.error(`[sync] ${src.key} failed:`, info.error);
    }
    sources.push(info);
  }

  // If every source failed, keep the previous data instead of wiping the dashboard.
  if (sources.every((s) => s.error)) {
    state.error = "อ่านข้อมูลไม่ได้ทั้ง 3 เอกสาร: " + sources.map((s) => s.error).join(" | ");
    state.sources = sources;
    throw new Error(state.error);
  }

  const cases = all.map((c) => withStage(c, today));
  const changes = await trackSnapshots(cases, sources);

  // Keep cases from a failed source as they were in the last good sync.
  const failed = new Set(sources.filter((s) => s.error).map((s) => s.key));
  const kept = state.cases.filter((c) => failed.has(c.source));

  state.cases = [...cases, ...kept];
  state.sources = sources;
  state.syncedAt = new Date().toISOString();
  state.lastChanges = changes;
  state.error = null;
  if (changes.length && changeHandler) {
    Promise.resolve(changeHandler(changes)).catch((e) =>
      console.error("[sync] change handler failed:", e.message)
    );
  }
  return { cases: state.cases, changes };
}

async function trackSnapshots(cases, sources) {
  const bySource = Object.fromEntries(sources.map((s) => [s.key, s]));
  const nowIso = new Date().toISOString();
  let snaps = {};
  try {
    snaps = await store.getSnapshots(cases.map((c) => c.key));
  } catch (e) {
    console.error("[sync] getSnapshots failed:", e.response?.data || e.message);
    return [];
  }

  const changes = [];
  const upserts = [];
  const seen = new Set();

  for (const c of cases) {
    if (seen.has(c.key)) continue; // duplicated CS Number in one file: first row wins
    seen.add(c.key);
    const prev = snaps[c.key];
    const start = toISODate(c.startDate);
    const target = toISODate(c.targetDate);
    const src = bySource[c.source] || {};
    const base = {
      case_key: c.key,
      source: c.source,
      cs_number: c.csNumber || null,
      owner: c.owner || null,
      owner_email: c.ownerEmail || null,
      site: c.site || null,
      last_modified_by: src.lastModifiedBy || null,
      file_modified_at: src.lastModified || null,
    };

    if (prev) {
      // Start date is stamped once by the Office Script; any later edit is flagged.
      if (prev.start_date && prev.start_date !== start) {
        changes.push({
          ...base,
          field: "start_date",
          old_value: prev.start_date,
          new_value: start,
          direction: changeDirection(prev.start_date, start),
        });
      }
      // Target date edits that are not just the formula following Start date.
      const startMoved = prev.start_date && prev.start_date !== start;
      if (prev.target_date && prev.target_date !== target && !startMoved) {
        changes.push({
          ...base,
          field: "target_date",
          old_value: prev.target_date,
          new_value: target,
          direction: changeDirection(prev.target_date, target),
        });
      }
    }

    const closedNow = isClosed(c);
    const wasClosed = prev ? prev.closed_at != null : false;
    let closedAt = prev?.closed_at || null;
    if (closedNow && !wasClosed) closedAt = toISODate(c.endDate) || toISODate(todayFn());
    if (!closedNow) closedAt = null; // re-opened
    c.closedAt = closedAt ? fromISODate(closedAt) : null;
    if (c.stage === "closed" && !c.endDate && c.closedAt && c.dueDate) {
      c.closedOnTime = c.closedAt <= c.dueDate;
    }

    upserts.push({
      case_key: c.key,
      source: c.source,
      cs_number: c.csNumber || null,
      owner: c.owner || null,
      owner_email: c.ownerEmail || null,
      site: c.site || null,
      status: c.status || null,
      start_date: start,
      target_date: target,
      end_date: toISODate(c.endDate),
      closed_at: closedAt,
      first_seen_at: prev?.first_seen_at || nowIso,
      last_seen_at: nowIso,
    });
  }

  try {
    await store.upsertSnapshots(upserts);
    if (changes.length) await store.insertChanges(changes);
  } catch (e) {
    console.error("[sync] snapshot write failed:", e.response?.data || e.message);
  }
  return changes;
}

function getState() {
  return state;
}

// Called with the list of Start date / Target date edits found by a sync.
let changeHandler = null;
function onChanges(fn) {
  changeHandler = fn;
}

module.exports = { sync, getState, onChanges };
