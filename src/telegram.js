// Telegram is kept for the daily overall summary (not per-case alerts).
const axios = require("axios");
const FormData = require("form-data");
const ExcelJS = require("exceljs");
const { config } = require("./config");
const { sync } = require("./sync");
const { store } = require("./store");
const { ownerId } = require("./cases");
const d = require("./dates");

const MIN_GAP_MS = 1200;
const MAX_RETRIES = 5;
const MAX_LEN = 3500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryAfter = e.response?.data?.parameters?.retry_after;
      if (e.response?.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(retryAfter) || 5) * 1000 + 500);
        continue;
      }
      throw e;
    }
  }
}

function enabled() {
  return !!(config.telegramToken && config.telegramChatId) && !config.mock;
}

async function sendText(text) {
  if (!enabled()) return console.log("[telegram skipped]\n" + text);
  await sleep(MIN_GAP_MS);
  await withRetry(() =>
    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      chat_id: config.telegramChatId,
      text,
      disable_web_page_preview: true,
    })
  );
}

async function sendDocument(buffer, filename, caption) {
  if (!enabled()) return;
  await sleep(MIN_GAP_MS);
  const form = new FormData();
  form.append("chat_id", config.telegramChatId);
  if (caption) form.append("caption", caption);
  form.append("document", Buffer.from(buffer), filename);
  await withRetry(() =>
    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendDocument`, form, {
      headers: form.getHeaders(),
    })
  );
}

function splitMessages(header, items, footer) {
  const out = [];
  let cur = header;
  for (const it of items) {
    if (cur.length + it.length + footer.length > MAX_LEN) {
      out.push(cur);
      cur = "(ต่อ)\n\n" + it;
    } else cur += it;
  }
  out.push(cur + footer);
  return out;
}

/** Daily overall summary for the Telegram group. */
async function sendDailySummary(opts = {}) {
  const cases = opts.cases || (await sync()).cases;
  const sources = opts.sources || config.sources;
  const today = d.today();
  const open = cases.filter((c) => c.stage !== "closed");
  const count = (s) => open.filter((c) => c.stage === s).length;

  let msg = `📊 สรุปสถานะเคสประจำวัน\n🗓 ${d.thaiDate(today)}\n\n`;
  msg += `เปิดอยู่ทั้งหมด: ${open.length} เคส\n`;
  msg += `🟢 ปกติ: ${count("normal")}\n🟡 แจ้งรอบ 1: ${count("r1")}\n🟠 แจ้งรอบ 2: ${count("r2")}\n🔴 เกิน Due: ${count("overdue")}\n`;
  if (count("no_start")) msg += `⚪ ไม่มี Start date: ${count("no_start")}\n`;

  msg += `\n📁 แยกตามเอกสาร\n`;
  for (const s of sources) {
    const o = open.filter((c) => c.source === s.key);
    msg += `• ${s.label}: ${o.length} (เกิน Due ${o.filter((c) => c.stage === "overdue").length})\n`;
  }

  const byOwner = {};
  open.forEach((c) => {
    const id = ownerId(c);
    byOwner[id] = byOwner[id] || { name: c.owner || "(ไม่ระบุ)", open: 0, overdue: 0 };
    byOwner[id].open++;
    if (c.stage === "overdue") byOwner[id].overdue++;
  });
  const owners = Object.values(byOwner).sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  msg += `\n👤 แยกตาม Owner (เปิดอยู่ / เกิน Due)\n`;
  owners.forEach((o) => (msg += `• ${o.name}: ${o.open} / ${o.overdue}${o.overdue ? " 🔴" : ""}\n`));

  const messages = [msg];

  // Cancel / Resolved per owner (closed, not counted as overdue) — carried over from v1.
  const cr = {};
  cases.forEach((c) => {
    const s = c.status.toLowerCase();
    if (s !== "cancel" && s !== "resolved") return;
    const name = c.owner || "(ไม่ระบุ)";
    cr[name] = cr[name] || { cancel: 0, resolved: 0 };
    cr[name][s]++;
  });
  const crRows = Object.entries(cr).sort(
    (a, b) => b[1].cancel + b[1].resolved - (a[1].cancel + a[1].resolved)
  );
  if (crRows.length) {
    let t = `📌 สรุปเคส Cancel / Resolved แยกตาม Owner (ไม่นับเป็น Overdue)\n\n`;
    crRows.forEach(([name, c]) => (t += `👤 ${name}: Resolved ${c.resolved} | Cancel ${c.cancel}\n`));
    messages.push(t);
  }

  const overdue = open.filter((c) => c.stage === "overdue").sort((a, b) => b.daysOverdue - a.daysOverdue);
  if (overdue.length) {
    const items = overdue.map(
      (c) =>
        `🔴 ${c.csNumber || "-"} · ${c.site || "-"}\n   👤 ${c.owner || "-"} · เกิน ${c.daysOverdue} วัน (เปิด ${d.thaiDate(
          c.startDate
        )})\n`
    );
    messages.push(...splitMessages(`⏰ เคสเกิน Due (${overdue.length})\n\n`, items, ""));
  }

  try {
    const since = d.addDays(today, -1).toISOString();
    const changes = (await (opts.listChanges || store.listChanges)({ from: since, limit: 100 })).filter(
      (c) => c.field === "start_date"
    );
    if (changes.length) {
      let t = `⚠️ มีการแก้ Start date ใน 24 ชม. (${changes.length})\n\n`;
      changes.forEach(
        (c) =>
          (t += `• ${c.cs_number || c.case_key || c.case_id} · ${c.owner || c.owner_name || "-"}: ${c.old_value} → ${c.new_value}${
            c.reason ? ` (เหตุผล: ${c.reason})` : ""
          }\n`)
      );
      messages.push(t);
    }
  } catch (e) {
    console.error("[telegram] listChanges failed:", e.message);
  }

  for (const m of messages) await sendText(m);

  if (open.length) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Open cases");
    ws.columns = [
      { header: "เอกสาร", key: "source", width: 12 },
      { header: "CS Number", key: "csNumber", width: 14 },
      { header: "Site", key: "site", width: 16 },
      { header: "Owner", key: "owner", width: 22 },
      { header: "สถานะ SLA", key: "stageLabel", width: 14 },
      { header: "Start date", key: "startDate", width: 12 },
      { header: "Due", key: "dueDate", width: 12 },
      { header: "อายุ (วัน)", key: "age", width: 10 },
      { header: "Task/Case", key: "task", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    open.sort((a, b) => (b.age || 0) - (a.age || 0)).forEach((c) => ws.addRow(c));
    ws.getColumn(6).numFmt = "dd/mm/yyyy";
    ws.getColumn(7).numFmt = "dd/mm/yyyy";
    await sendDocument(await wb.xlsx.writeBuffer(), `open-cases-${d.toISODate(today)}.xlsx`, "📎 รายการเคสที่ยังเปิดอยู่");
  }
  return { messages: messages.length, open: open.length };
}

async function sendChangesNotice(changes) {
  if (!changes?.length) return;
  let t = `⚠️ ตรวจพบการแก้ไขวันที่ใน Case List (${changes.length})\n\n`;
  changes.forEach((c) => {
    const f = c.field === "start_date" ? "Start date" : "Target date";
    t += `• ${c.cs_number || c.case_key} (${c.source}) · ${c.owner || "-"}\n   ${f}: ${c.old_value || "ว่าง"} → ${
      c.new_value || "ว่าง"
    }\n   แก้ไฟล์ล่าสุดโดย: ${c.last_modified_by || "-"}\n`;
  });
  await sendText(t).catch((e) => console.error("[telegram] notice failed:", e.message));
}

module.exports = { sendDailySummary, sendChangesNotice, sendText };
