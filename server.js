const express = require("express");
const axios = require("axios");
const ExcelJS = require("exceljs");
const FormData = require("form-data");

const app = express();

// ---- Config (all from environment variables) ----
const {
  TENANT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  DRIVE_ID,
  ITEM_ID,
  SHEET_NAME = "TASK NX TEAM",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RUN_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000,
} = process.env;

function requireEnv() {
  const missing = [
    "TENANT_ID",
    "CLIENT_ID",
    "CLIENT_SECRET",
    "DRIVE_ID",
    "ITEM_ID",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "RUN_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing required env vars: " + missing.join(", "));
  }
}

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("scope", "https://graph.microsoft.com/.default");
  params.append("grant_type", "client_credentials");

  const res = await axios.post(url, params);
  return res.data.access_token;
}

async function getFileMetadata(token) {
  const url = `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

async function listWorksheetNames(token) {
  const url = `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}/workbook/worksheets`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (res.data.value || []).map((w) => w.name);
}

async function readSheet(token) {
  const url = `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}/workbook/worksheets('${encodeURIComponent(
    SHEET_NAME
  )}')/usedRange(valuesOnly=true)`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data.values;
}

function rowsToObjects(values) {
  if (!values || values.length === 0) return [];
  const headers = values[0].map((h) => String(h || "").trim().toLowerCase());
  const findCol = (nameOptions) =>
    headers.findIndex((h) => nameOptions.includes(h));

  const idx = {
    status: findCol(["status"]),
    owner: findCol(["owner"]),
    site: findCol(["site", "customer"]),
    task: findCol(["task detail", "task", "task/case"]),
    targetDate: findCol(["target date"]),
    remark: findCol(["remark", "comment"]),
    csNumber: findCol(["cs number", "cs no", "cs no."]),
  };

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r || r.every((c) => c === "" || c === null)) continue;
    rows.push({
      status: idx.status >= 0 ? String(r[idx.status] || "").trim() : "",
      owner: idx.owner >= 0 ? String(r[idx.owner] || "").trim() : "",
      site: idx.site >= 0 ? String(r[idx.site] || "").trim() : "",
      task: idx.task >= 0 ? String(r[idx.task] || "").trim() : "",
      targetDateRaw: idx.targetDate >= 0 ? r[idx.targetDate] : null,
      remark: idx.remark >= 0 ? String(r[idx.remark] || "").trim() : "",
      csNumber: idx.csNumber >= 0 ? String(r[idx.csNumber] || "").trim() : "",
    });
  }
  return rows;
}

function getCaseKey(row) {
  if (row.csNumber) return `cs:${row.csNumber}`;
  return `combo:${row.owner}|${row.site}|${row.task}`;
}

function parseExcelDate(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") {
    return new Date(Math.round((val - 25569) * 86400 * 1000));
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(dt.getTime())) return dt;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

function daysBetween(a, b) {
  const ms = 24 * 60 * 60 * 1000;
  return Math.floor((a.getTime() - b.getTime()) / ms);
}

function severityEmoji(daysOverdue) {
  if (daysOverdue >= 5) return "🔴";
  if (daysOverdue >= 3) return "🟠";
  return "🟡";
}

const TELEGRAM_MAX_LEN = 3500;

function buildMessages(overdueRows, today) {
  const dateStr = today.toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  if (overdueRows.length === 0) {
    return [`✅ TASK NX TEAM - วันนี้ไม่มีรายการ overdue\n🗓 ${dateStr}`];
  }

  const header = `📋 สรุป Case Overdue - TASK NX TEAM\n🗓 วันที่ ${dateStr}\n\nพบรายการค้าง ${overdueRows.length} รายการ (เรียงจากเกินกำหนดมากสุด):\n\n`;
  const footer = `\n—\nรวมทั้งหมด: ${overdueRows.length} รายการค้าง`;

  const itemTexts = overdueRows.map((r) => {
    return `${severityEmoji(r.daysOverdue)} ${r.task || "(ไม่มีชื่องาน)"}\n   👤 Owner: ${
      r.owner || "-"
    }\n   🏢 Site: ${r.site || "-"}\n   📌 Status: ${r.status || "-"}\n   ⏰ เกินกำหนด ${
      r.daysOverdue
    } วัน (Target date: ${r.targetDateStr})\n\n`;
  });

  const messages = [];
  let current = header;
  let partNum = 1;

  for (const item of itemTexts) {
    if (current.length + item.length + footer.length > TELEGRAM_MAX_LEN) {
      messages.push(current + `\n(ต่อหน้า ${partNum + 1}...)`);
      partNum++;
      current = `📋 สรุป Case Overdue - TASK NX TEAM (ต่อ ${partNum})\n\n` + item;
    } else {
      current += item;
    }
  }
  current += footer;
  messages.push(current);

  return messages;
}

function buildOwnerStatsMessage(overdueRows) {
  const counts = {};
  overdueRows.forEach((r) => {
    const owner = r.owner || "(ไม่ระบุ)";
    counts[owner] = (counts[owner] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  let msg = `📊 สรุปจำนวนเคส Overdue แยกตาม Owner\n\n`;
  sorted.forEach(([owner, count]) => {
    msg += `👤 ${owner}: ${count} เคส\n`;
  });
  msg += `\nรวมทั้งหมด: ${overdueRows.length} เคส`;
  return msg;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchSnapshots(caseKeys) {
  if (caseKeys.length === 0) return {};
  const list = caseKeys.map((k) => `"${k.replace(/"/g, '""')}"`).join(",");
  const url = `${SUPABASE_URL}/rest/v1/case_snapshots?case_key=in.(${encodeURIComponent(
    list
  )})&select=case_key,target_date,status`;
  const res = await axios.get(url, { headers: supabaseHeaders() });
  const map = {};
  (res.data || []).forEach((row) => {
    map[row.case_key] = row;
  });
  return map;
}

async function upsertSnapshots(snapshotRows) {
  if (snapshotRows.length === 0) return;
  const url = `${SUPABASE_URL}/rest/v1/case_snapshots`;
  await axios.post(url, snapshotRows, {
    headers: supabaseHeaders({
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
  });
}

async function insertChangeLog(entries) {
  if (entries.length === 0) return;
  const url = `${SUPABASE_URL}/rest/v1/case_change_log`;
  await axios.post(url, entries, {
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
  });
}

async function cleanupOldData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const sixMonthsAgo = new Date(Date.now() - 182 * 86400 * 1000).toISOString();
  try {
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/case_snapshots?status=eq.success&last_seen_at=lt.${encodeURIComponent(
        thirtyDaysAgo
      )}`,
      { headers: supabaseHeaders() }
    );
  } catch (e) {
    console.error("cleanup case_snapshots failed:", e.message);
  }
  try {
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/case_change_log?detected_at=lt.${encodeURIComponent(
        sixMonthsAgo
      )}`,
      { headers: supabaseHeaders() }
    );
  } catch (e) {
    console.error("cleanup case_change_log failed:", e.message);
  }
}

async function getLastModifiedBy(token) {
  const url = `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}?$select=lastModifiedBy,lastModifiedDateTime`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    name: res.data.lastModifiedBy?.user?.displayName || "(ไม่ทราบ)",
    dateTime: res.data.lastModifiedDateTime || null,
  };
}

function buildFlaggedChangesMessage(flaggedChanges) {
  if (flaggedChanges.length === 0) {
    return `✅ ไม่พบการเลื่อน Target date ในวันนี้`;
  }
  let msg = `⚠️ พบการเลื่อน Target date (เลื่อนออกไปจากเดิม)\n\n`;
  flaggedChanges.forEach((c) => {
    msg += `🔸 ${c.task || "(ไม่มีชื่องาน)"}\n`;
    msg += `   👤 Owner: ${c.owner || "-"}\n`;
    msg += `   🏢 Site: ${c.site || "-"}\n`;
    msg += `   📅 เดิม: ${c.oldDateStr} → ใหม่: ${c.newDateStr}\n`;
    msg += `   ✏️ แก้ไขไฟล์ล่าสุดโดย: ${c.lastModifiedBy}\n\n`;
  });
  msg += `หมายเหตุ: "แก้ไขล่าสุดโดย" คือคนที่แก้ไฟล์ล่าสุดในภาพรวม อาจไม่ใช่คนที่แก้บรรทัดนี้เป๊ะๆ ถ้ามีหลายคนแก้ไฟล์วันเดียวกัน`;
  return msg;
}

function getPreviousWeekRange(today) {
  const dayOfWeek = today.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  lastSunday.setHours(23, 59, 59, 999);
  return { start: lastMonday, end: lastSunday };
}

function getPreviousMonthRange(today) {
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999);
  return { start, end };
}

function getRowsInRange(parsedRows, range) {
  return parsedRows.filter(
    (r) =>
      r.targetDate &&
      r.targetDate.getTime() >= range.start.getTime() &&
      r.targetDate.getTime() <= range.end.getTime()
  );
}

function buildOwnerPeriodReport(parsedRows, today, range, label) {
  const inRange = getRowsInRange(parsedRows, range);

  const byOwner = {};
  inRange.forEach((r) => {
    const owner = r.owner || "(ไม่ระบุ)";
    if (!byOwner[owner]) {
      byOwner[owner] = { total: 0, success: 0, open: 0, overdue: 0 };
    }
    byOwner[owner].total++;
    const isSuccess = r.status.trim().toLowerCase() === "success";
    if (isSuccess) {
      byOwner[owner].success++;
    } else {
      byOwner[owner].open++;
      if (r.targetDate.getTime() < today.getTime()) {
        byOwner[owner].overdue++;
      }
    }
  });

  const startStr = range.start.toLocaleDateString("th-TH");
  const endStr = range.end.toLocaleDateString("th-TH");

  if (inRange.length === 0) {
    return `📅 รายงาน${label}\nช่วง ${startStr} - ${endStr}\n\nไม่มีเคสที่มี Target date อยู่ในช่วงนี้`;
  }

  let msg = `📅 รายงาน${label} แยกตาม Owner\nช่วง ${startStr} - ${endStr}\n\n`;
  const sorted = Object.entries(byOwner).sort((a, b) => b[1].total - a[1].total);
  sorted.forEach(([owner, stat]) => {
    msg += `👤 ${owner}\n`;
    msg += `   ทั้งหมด: ${stat.total} | ปิดแล้ว: ${stat.success} | ยังไม่ปิด: ${stat.open}`;
    if (stat.overdue > 0) {
      msg += ` (overdue: ${stat.overdue})`;
    }
    msg += `\n\n`;
  });
  msg += `—\nรวมทั้งหมด: ${inRange.length} เคส`;
  return msg;
}

async function buildExcelBuffer(rows, sheetTitle, includeDaysOverdue) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetTitle.slice(0, 31));

  const columns = [
    { header: "Owner", key: "owner", width: 20 },
    { header: "Site", key: "site", width: 20 },
    { header: "Task/Case", key: "task", width: 35 },
    { header: "Status", key: "status", width: 15 },
    { header: "Target Date", key: "targetDateStr", width: 15 },
  ];
  if (includeDaysOverdue) {
    columns.push({ header: "Days Overdue", key: "daysOverdue", width: 12 });
  }
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };

  rows.forEach((r) => sheet.addRow(r));

  return workbook.xlsx.writeBuffer();
}

// ---- Telegram helpers with rate-limit (429) retry + spacing between sends ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimum gap enforced between any two outgoing Telegram API calls,
// to avoid tripping Telegram's per-chat rate limit in the first place.
const TELEGRAM_MIN_GAP_MS = 1200;
const TELEGRAM_MAX_RETRIES = 5;

async function telegramRequestWithRetry(requestFn) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (e) {
      const status = e.response?.status;
      const retryAfterSec =
        e.response?.data?.parameters?.retry_after ??
        e.response?.headers?.["retry-after"];

      if (status === 429 && attempt < TELEGRAM_MAX_RETRIES) {
        attempt++;
        const waitMs = (Number(retryAfterSec) || 5) * 1000 + 500; // small buffer
        console.error(
          `Telegram 429, retry ${attempt}/${TELEGRAM_MAX_RETRIES} after ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
}

async function sendTelegramDocument(buffer, filename, caption) {
  await sleep(TELEGRAM_MIN_GAP_MS);
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  if (caption) form.append("caption", caption);
  form.append("document", buffer, filename);

  await telegramRequestWithRetry(() =>
    axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      form,
      { headers: form.getHeaders() }
    )
  );
}

async function sendTelegram(text) {
  await sleep(TELEGRAM_MIN_GAP_MS);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await telegramRequestWithRetry(() =>
    axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    })
  );
}

async function sendTelegramMessages(messages) {
  for (const msg of messages) {
    await sendTelegram(msg);
  }
}

async function getParsedRows() {
  const token = await getGraphToken();
  const values = await readSheet(token);
  const rows = rowsToObjects(values);
  const parsedRows = rows.map((r) => ({
    ...r,
    targetDate: parseExcelDate(r.targetDateRaw),
  }));
  return { token, parsedRows };
}

async function runCheck() {
  const { token, parsedRows } = await getParsedRows();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const twoMonthsAgo = new Date(today);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  const trackable = parsedRows.filter(
    (r) => r.targetDate && r.status.trim().toLowerCase() !== "success"
  );
  const caseKeys = trackable.map(getCaseKey);
  const uniqueKeys = [...new Set(caseKeys)];

  let flaggedChanges = [];
  let lastModifiedBy = { name: "(ไม่ทราบ)", dateTime: null };

  try {
    const snapshotMap = await fetchSnapshots(uniqueKeys);

    try {
      lastModifiedBy = await getLastModifiedBy(token);
    } catch (e) {
      console.error("getLastModifiedBy failed:", e.message);
    }

    const changeLogEntries = [];
    const snapshotUpserts = [];
    const seenKeys = new Set();

    for (const r of trackable) {
      const key = getCaseKey(r);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const newDateStr = r.targetDate.toISOString().slice(0, 10);
      const existing = snapshotMap[key];

      if (existing && existing.target_date && existing.target_date !== newDateStr) {
        const oldDate = new Date(existing.target_date + "T00:00:00");
        const pushedLater = r.targetDate.getTime() > oldDate.getTime();

        changeLogEntries.push({
          case_key: key,
          owner_name: r.owner,
          task: r.task,
          old_target_date: existing.target_date,
          new_target_date: newDateStr,
          last_modified_by: lastModifiedBy.name,
        });

        if (pushedLater) {
          flaggedChanges.push({
            owner: r.owner,
            site: r.site,
            task: r.task,
            oldDateStr: oldDate.toLocaleDateString("th-TH"),
            newDateStr: r.targetDate.toLocaleDateString("th-TH"),
            lastModifiedBy: lastModifiedBy.name,
          });
        }
      }

      snapshotUpserts.push({
        case_key: key,
        target_date: newDateStr,
        status: r.status,
        owner_name: r.owner,
        last_seen_at: new Date().toISOString(),
      });
    }

    await upsertSnapshots(snapshotUpserts);
    await insertChangeLog(changeLogEntries);
    await cleanupOldData();
  } catch (e) {
    console.error("change-detection step failed:", e.response?.data || e.message);
  }

  const overdueRows = parsedRows
    .filter((r) => {
      if (!r.targetDate) return false;
      const isSuccess = r.status.trim().toLowerCase() === "success";
      const isOverdue = r.targetDate.getTime() < today.getTime();
      const withinLookback = r.targetDate.getTime() >= twoMonthsAgo.getTime();
      return !isSuccess && isOverdue && withinLookback;
    })
    .map((r) => ({
      ...r,
      daysOverdue: daysBetween(today, r.targetDate),
      targetDateStr: r.targetDate.toLocaleDateString("th-TH"),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const messages = buildMessages(overdueRows, today);
  const allMessages =
    overdueRows.length > 0
      ? [buildOwnerStatsMessage(overdueRows), ...messages]
      : messages;

  allMessages.push(buildFlaggedChangesMessage(flaggedChanges));

  let telegramError = null;
  try {
    await sendTelegramMessages(allMessages);
  } catch (e) {
    telegramError = e.response?.data || e.message;
    console.error("sendTelegramMessages failed:", telegramError);
  }

  if (overdueRows.length > 0) {
    try {
      const excelBuffer = await buildExcelBuffer(
        overdueRows,
        "Overdue Cases",
        true
      );
      const dateTag = today.toISOString().slice(0, 10);
      await sendTelegramDocument(
        excelBuffer,
        `overdue-cases-${dateTag}.xlsx`,
        `📎 ไฟล์ Excel รายการ Case Overdue วันที่ ${today.toLocaleDateString("th-TH")}`
      );
    } catch (e) {
      console.error("Excel export failed:", e.response?.data || e.message);
    }
  }

  return {
    overdueCount: overdueRows.length,
    flaggedChangeCount: flaggedChanges.length,
    messageCount: allMessages.length,
    telegramError,
  };
}

async function runWeeklyReport() {
  const { parsedRows } = await getParsedRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const range = getPreviousWeekRange(today);
  const message = buildOwnerPeriodReport(parsedRows, today, range, "รายสัปดาห์");
  await sendTelegram(message);

  const inRange = getRowsInRange(parsedRows, range).map((r) => ({
    ...r,
    targetDateStr: r.targetDate.toLocaleDateString("th-TH"),
  }));
  if (inRange.length > 0) {
    try {
      const excelBuffer = await buildExcelBuffer(inRange, "Weekly Report", false);
      const dateTag = today.toISOString().slice(0, 10);
      await sendTelegramDocument(
        excelBuffer,
        `weekly-report-${dateTag}.xlsx`,
        `📎 ไฟล์ Excel รายงานรายสัปดาห์`
      );
    } catch (e) {
      console.error("Weekly Excel export failed:", e.response?.data || e.message);
    }
  }

  return { ok: true };
}

async function runMonthlyReport() {
  const { parsedRows } = await getParsedRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const range = getPreviousMonthRange(today);
  const message = buildOwnerPeriodReport(parsedRows, today, range, "รายเดือน");
  await sendTelegram(message);

  const inRange = getRowsInRange(parsedRows, range).map((r) => ({
    ...r,
    targetDateStr: r.targetDate.toLocaleDateString("th-TH"),
  }));
  if (inRange.length > 0) {
    try {
      const excelBuffer = await buildExcelBuffer(inRange, "Monthly Report", false);
      const dateTag = today.toISOString().slice(0, 10);
      await sendTelegramDocument(
        excelBuffer,
        `monthly-report-${dateTag}.xlsx`,
        `📎 ไฟล์ Excel รายงานรายเดือน`
      );
    } catch (e) {
      console.error("Monthly Excel export failed:", e.response?.data || e.message);
    }
  }

  return { ok: true };
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/version", (req, res) =>
  res.json({ version: "v6-telegram-retry" })
);

function shortError(e) {
  const raw = e.response?.data
    ? JSON.stringify(e.response.data)
    : e.message || String(e);
  return raw.length > 300 ? raw.slice(0, 300) + "...(truncated)" : raw;
}

app.get("/debug", async (req, res) => {
  try {
    requireEnv();
    if (req.query.secret !== RUN_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = await getGraphToken();

    let fileInfo = null;
    let fileError = null;
    try {
      const meta = await getFileMetadata(token);
      fileInfo = { name: meta.name, id: meta.id, webUrl: meta.webUrl };
    } catch (e) {
      fileError = shortError(e);
    }

    let sheetNames = null;
    let sheetError = null;
    try {
      sheetNames = await listWorksheetNames(token);
    } catch (e) {
      sheetError = shortError(e);
    }

    res.json({
      configuredSheetName: SHEET_NAME,
      fileInfo,
      fileError,
      sheetNames,
      sheetError,
    });
  } catch (err) {
    res.status(500).json({ error: shortError(err) });
  }
});

app.get("/run-check", async (req, res) => {
  try {
    requireEnv();
    if (req.query.secret !== RUN_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const result = await runCheck();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: shortError(err) });
  }
});

app.get("/report-weekly", async (req, res) => {
  try {
    requireEnv();
    if (req.query.secret !== RUN_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const result = await runWeeklyReport();
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: shortError(err) });
  }
});

app.get("/report-monthly", async (req, res) => {
  try {
    requireEnv();
    if (req.query.secret !== RUN_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const result = await runMonthlyReport();
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: shortError(err) });
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
