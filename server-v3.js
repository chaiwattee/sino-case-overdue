// Sino Case SLA v3: cases are entered on the web and stored in PostgreSQL.
const path = require("path");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const { config } = require("./src/config");
const { config3, missing3 } = require("./src/v3/config3");
const { migrate, requestContext } = require("./src/v3/db");
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

app.use((req, res, next) => {
  // Forwarded headers are only trusted from the local Cloudflare tunnel; direct LAN requests use the socket address.
  const peer = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const local = peer === "127.0.0.1" || peer === "::1";
  const fwd = String(req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0] || "").trim();
  const ip = local && fwd ? fwd : peer;
  requestContext.run({ ip, ua: req.headers["user-agent"] || "" }, next);
});

// Old host names (case.baanpin.com, case-v3.baanpin.com) -> BASE_URL after the move.
const baseHost = new URL(config3.baseUrl).host.toLowerCase();
app.use((req, res, next) => {
  if (!config3.canonicalRedirect || req.path === "/health" || /^\/run-/.test(req.path)) return next();
  const host = String(req.headers.host || "").toLowerCase();
  if (!host || host === baseHost || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(421).json({ error: `ระบบย้ายไปที่ ${config3.baseUrl} แล้ว` });
  res.redirect(301, config3.baseUrl + req.originalUrl);
});
app.use((req, res, next) => {
  if (req.secure || req.socket.encrypted) res.set("Strict-Transport-Security", "max-age=15552000");
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

// Direct HTTPS (e.g. :9443). The certificate files are re-read when they change, so renewals need no restart.
function startHttps() {
  const t = config3.https;
  if (!t.port) return;
  if (!t.cert || !t.key) {
    console.error("HTTPS_PORT is set but TLS_CERT_FILE / TLS_KEY_FILE are missing; HTTPS not started");
    return;
  }
  const load = () => ({ cert: fs.readFileSync(t.cert), key: fs.readFileSync(t.key) });
  const server = https.createServer({ ...load(), minVersion: "TLSv1.2" }, app);
  server.listen(t.port, "0.0.0.0", () => console.log(`HTTPS on :${t.port}`));
  let timer = null;
  fs.watchFile(t.cert, { interval: 60000 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        server.setSecureContext({ ...load(), minVersion: "TLSv1.2" });
        console.log("[https] certificate reloaded");
      } catch (e) {
        console.error("[https] certificate reload failed:", e.message);
      }
    }, 5000);
  });
}

(async () => {
  await migrate();
  app.listen(config3.port, config3.httpHost, () => {
    console.log(`Sino Case SLA v3 on http://${config3.httpHost}:${config3.port} (${config3.baseUrl}) TZ ${config.tz}`);
    jobs.startJobs();
  });
  startHttps();
})().catch((e) => {
  console.error("startup failed:", e);
  process.exit(1);
});
