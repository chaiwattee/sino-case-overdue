#!/usr/bin/env node
// Send a short status message to Telegram and to BOOTSTRAP_ADMIN_EMAIL, with the tail of a log file.
//   node scripts/notify.js "<message>" [logfile]
const fs = require("fs");
const telegram = require("../src/telegram");
const graph = require("../src/graph");

(async () => {
  const msg = process.argv[2] || "(no message)";
  const log = process.argv[3] && fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3], "utf8").split("\n").slice(-40).join("\n") : "";
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  await telegram.sendText(`${msg}${log ? "\n\n" + log.slice(-3000) : ""}`).catch((e) => console.error("telegram:", e.message));
  const to = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").split(/[,\s]+/).filter(Boolean);
  if (to.length)
    await graph
      .sendMail({ to, cc: [], subject: `[Sino Case SLA] ${msg.slice(0, 120)}`, html: `<p>${esc(msg)}</p>${log ? `<pre style="font-size:12px">${esc(log)}</pre>` : ""}` })
      .catch((e) => console.error("mail:", e.response?.data?.error?.message || e.message));
})();
