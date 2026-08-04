const express = require("express");
const axios = require("axios");

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
    });
  }
  return rows;
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

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
  });
}

async function sendTelegramMessages(messages) {
  for (const msg of messages) {
    await sendTelegram(msg);
  }
}

async function runCheck() {
  const token = await getGraphToken();
  const values = await readSheet(token);
  const rows = rowsToObjects(values);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const twoMonthsAgo = new Date(today);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  const overdueRows = rows
    .map((r) => {
      const targetDate = parseExcelDate(r.targetDateRaw);
      return { ...r, targetDate };
    })
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
  await sendTelegramMessages(messages);
  return { overdueCount: overdueRows.length, messageCount: messages.length };
}

app.get("/health", (req, res) => res.json({ ok: true }));

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
      fileError = e.response?.data || e.message;
    }

    let sheetNames = null;
    let sheetError = null;
    try {
      sheetNames = await listWorksheetNames(token);
    } catch (e) {
      sheetError = e.response?.data || e.message;
    }

    res.json({
      configuredSheetName: SHEET_NAME,
      fileInfo,
      fileError,
      sheetNames,
      sheetError,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
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
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
