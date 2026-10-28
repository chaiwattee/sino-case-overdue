const axios = require("axios");
const { config } = require("./config");

let cachedToken = null;
let cachedUntil = 0;

async function getToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const url = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await axios.post(url, params);
  cachedToken = res.data.access_token;
  cachedUntil = Date.now() + (Number(res.data.expires_in || 3600) - 300) * 1000;
  return cachedToken;
}

async function graph(method, path, data, extraHeaders = {}) {
  const token = await getToken();
  const res = await axios({
    method,
    url: `https://graph.microsoft.com/v1.0${path}`,
    data,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    timeout: 60000,
  });
  return res.data;
}

function itemPath(itemId) {
  return `/drives/${config.driveId}/items/${itemId}`;
}

async function readSheetValues(itemId, sheetName = config.sheetName) {
  const sheet = encodeURIComponent(sheetName.replace(/'/g, "''"));
  const data = await graph(
    "get",
    `${itemPath(itemId)}/workbook/worksheets('${sheet}')/usedRange(valuesOnly=true)?$select=values`
  );
  return data.values || [];
}

async function getFileMeta(itemId) {
  return graph(
    "get",
    `${itemPath(itemId)}?$select=id,name,webUrl,lastModifiedDateTime,lastModifiedBy,sharepointIds`
  );
}

async function listWorksheets(itemId) {
  const data = await graph("get", `${itemPath(itemId)}/workbook/worksheets?$select=name`);
  return (data.value || []).map((w) => w.name);
}

function recipients(list) {
  return [...new Set((list || []).filter(Boolean))].map((address) => ({
    emailAddress: { address },
  }));
}

/**
 * Send an email from the configured Outlook mailbox.
 * attachments: [{ name, contentType, buffer }]
 */
async function sendMail({ to, cc, subject, html, attachments = [] }) {
  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc),
    attachments: attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType,
      contentBytes: Buffer.from(a.buffer).toString("base64"),
    })),
  };
  if (message.toRecipients.length === 0 && message.ccRecipients.length === 0) {
    throw new Error("sendMail: no recipients");
  }
  if (config.dryRunEmail || config.mock) {
    console.log(
      `[DRY RUN email] to=${(to || []).join(",")} cc=${(cc || []).join(",")} subject=${subject}`
    );
    return { dryRun: true };
  }
  await graph("post", `/users/${encodeURIComponent(config.mailSender)}/sendMail`, {
    message,
    saveToSentItems: true,
  });
  return { sent: true };
}

module.exports = { getToken, readSheetValues, getFileMeta, listWorksheets, sendMail };
