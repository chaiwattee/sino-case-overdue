// Sino Case SLA v3: cases are entered on the web and stored in PostgreSQL.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { config } = require("./src/config");
const { config3, missing3 } = require("./src/v3/config3");
const { migrate } = require("./src/v3/db");
const auth = require("./src/v3/auth");
const { api } = require("./src/v3/api3");
const jobs = require("./src/v3/jobs");

const miss = missing3();
if (miss.length) {
  console.error("Missing/invalid env: " + miss.join(", "));
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use((req, res, next) => {
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/version", (req, res) => res.json({ version: "v3-web-input" }));

// Ops endpoints for manual runs (RUN_SECRET)
function secretOk(req) {
  const a = Buffer.from(String(req.query.secret || ""));
  const b = Buffer.from(String(config.runSecret || ""));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ops = (fn) => async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
app.get("/run-alerts", ops((req) => jobs.runAlerts({ dryRun: req.query.dry === "1" })));
app.get("/run-telegram", ops(() => jobs.sendTelegram()));
app.get("/run-reports", ops(async () => ({ results: await jobs.runDueSchedules() })));
app.get("/run-retention", ops(() => jobs.runRetention()));

app.use(auth.router);
app.use("/api", api);

const pub = path.join(__dirname, "public3");
const noCache = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
// Login page and its assets are public; everything else needs a session.
app.get(["/login.html", "/style.css", "/login.js"], express.static(pub, noCache));
app.use(async (req, res, next) => {
  if (req.method !== "GET") return next();
  const s = auth.verify(String(req.headers.cookie || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1] && decodeURIComponent(String(req.headers.cookie).match(/(?:^|;\s*)sid=([^;]+)/)[1]));
  if (!s) return res.redirect("/login.html");
  next();
});
app.use(express.static(pub, { index: "index.html", ...noCache }));

(async () => {
  await migrate();
  app.listen(config3.port, () => {
    console.log(`Sino Case SLA v3 on :${config3.port} (${config3.baseUrl}) TZ ${config.tz}`);
    jobs.startJobs();
  });
})().catch((e) => {
  console.error("startup failed:", e);
  process.exit(1);
});
