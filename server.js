const path = require("path");
const express = require("express");
const { config, missingEnv } = require("./src/config");
const { router, api, basicAuth } = require("./src/routes");
const { startScheduler } = require("./src/scheduler");
const { sync } = require("./src/sync");

const missing = missingEnv();
if (missing.length) {
  console.error("Missing required env vars: " + missing.join(", "));
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(router); // /health, /version, /run-* and /debug (secret-protected)
app.use("/api", api); // dashboard API (basic auth)
app.use(
  basicAuth,
  express.static(path.join(__dirname, "public"), {
    index: "index.html",
    // Always revalidate, so a new release shows up without a hard refresh.
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

app.listen(config.port, () => {
  console.log(
    `Sino Case Tracker listening on :${config.port} (${config.mock ? "MOCK DATA" : "live"}, TZ ${config.tz})`
  );
  startScheduler();
  sync().catch((e) => console.error("[startup] first sync failed:", e.message));
});
