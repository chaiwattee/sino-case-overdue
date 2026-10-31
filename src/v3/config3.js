// v3-only settings (the shared ones — Graph, mail, Telegram, SLA — come from src/config.js).
require("../config"); // loads .env
const env = process.env;

function flag(name, def = false) {
  if (env[name] === undefined) return def;
  return env[name] === "1" || env[name] === "true";
}

const config3 = {
  port: Number(env.V3_PORT || env.PORT || 3011),
  baseUrl: (env.BASE_URL || "http://localhost:3011").replace(/\/$/, ""),
  // Plain HTTP listener (for the Cloudflare tunnel); localhost only unless overridden.
  httpHost: env.V3_HTTP_HOST || "127.0.0.1",
  // Optional direct HTTPS listener, e.g. case.sinostech.co.th:9443 behind a firewall port-forward.
  https: { port: Number(env.HTTPS_PORT || 0), cert: env.TLS_CERT_FILE || "", key: env.TLS_KEY_FILE || "" },
  // Send visitors on any other host name (old *.baanpin.com links) to BASE_URL.
  canonicalRedirect: env.CANONICAL_REDIRECT === "1",
  databaseUrl: env.DATABASE_URL || "postgres://case_app@127.0.0.1:5433/case_tracker",
  sessionSecret: env.SESSION_SECRET,
  sessionDays: Number(env.SESSION_DAYS || 7),
  // Microsoft (SSO) sign-ins are re-checked with Microsoft at least this often, so a removed M365 account loses access within this time.
  ssoSessionHours: Number(env.SSO_SESSION_HOURS || 8),
  bootstrapAdmin: (env.BOOTSTRAP_ADMIN_EMAIL || "").toLowerCase(),

  sso: {
    tenantId: env.SSO_TENANT_ID || env.TENANT_ID,
    clientId: env.SSO_CLIENT_ID,
    clientSecret: env.SSO_CLIENT_SECRET,
    secretExpires: env.SSO_SECRET_EXPIRES,
  },

  // Background jobs. Off by default so v3 can run next to v2 without double-sending.
  jobs: {
    alerts: flag("V3_ALERTS"),
    telegram: flag("V3_TELEGRAM"),
    reports: flag("V3_REPORTS"),
    retention: flag("V3_RETENTION", true),
    annual: flag("V3_ANNUAL", true),
  },
  disableScheduler: flag("DISABLE_SCHEDULER"),
};

function missing3() {
  const need = { SESSION_SECRET: config3.sessionSecret };
  const out = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (config3.sessionSecret && config3.sessionSecret.length < 32) out.push("SESSION_SECRET (ต้องยาวอย่างน้อย 32 ตัว)");
  return out;
}

module.exports = { config3, missing3 };
