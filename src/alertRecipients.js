// Who gets an owner alert email. Shared by v2 (env config) and v3 (settings table).
const { config } = require("./config");

const splitList = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));

/** Default rules: CC list from ALERT_CC, only on the rounds in ALERT_CC_TYPES (default r2 + overdue). */
function defaultRules() {
  return {
    cc: config.alertCc,
    ccTypes: config.alertCcTypes,
    fallback: config.alertCc, // used as "to" when the case has no owner email
  };
}

/** @returns {{to: string[], cc: string[], noOwner: boolean}} */
function recipientsFor(c, type, rules = defaultRules()) {
  const cc = splitList(rules.cc);
  const fallback = splitList(rules.fallback).length ? splitList(rules.fallback) : cc;
  if (!c.ownerEmail) return { to: fallback, cc: [], noOwner: true };
  const owner = String(c.ownerEmail).toLowerCase();
  const useCc = (rules.ccTypes || []).includes(type);
  return { to: [c.ownerEmail], cc: useCc ? cc.filter((x) => x !== owner) : [], noOwner: false };
}

module.exports = { recipientsFor, defaultRules, splitList };
