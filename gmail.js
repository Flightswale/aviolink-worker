"use strict";
/**
 * Aviolink — Gmail OAuth + REST helpers ("Sign in with Google").
 * No SDK: plain fetch against Google's OAuth2 and Gmail v1 endpoints.
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL (https://<railway-domain>)
 */
const crypto = require("crypto");

const CID = process.env.GOOGLE_CLIENT_ID || "";
const CSEC = process.env.GOOGLE_CLIENT_SECRET || "";
// Railway sets RAILWAY_PUBLIC_DOMAIN automatically once "Generate Domain" is clicked — no variable needed.
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/$/, "");
const REDIRECT = `${PUBLIC_URL}/auth/google/callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"].join(" ");

const enabled = () => Boolean(CID && CSEC && PUBLIC_URL);

// state = <agencyId>.<hmac> so nobody can connect their mailbox to someone else's agency
function signState(agencyId) {
  const sig = crypto.createHmac("sha256", CSEC).update(agencyId).digest("hex").slice(0, 24);
  return `${agencyId}.${sig}`;
}
function verifyState(state) {
  const [agencyId, sig] = String(state || "").split(".");
  if (!agencyId || !sig) return null;
  return signState(agencyId) === `${agencyId}.${sig}` ? agencyId : null;
}

function authUrl(agencyId) {
  const q = new URLSearchParams({
    client_id: CID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: signState(agencyId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// Dashboard login: identity only (email), no mailbox access.
function loginUrl(state) {
  const q = new URLSearchParams({ client_id: CID, redirect_uri: REDIRECT, response_type: "code", scope: "openid email", prompt: "select_account", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
async function tokenPost(body) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google token ${res.status}: ${data.error || ""} ${data.error_description || ""}`.trim());
  return data;
}
const exchangeCode = (code) => tokenPost({ code, grant_type: "authorization_code", redirect_uri: REDIRECT });
const refreshAccess = (refresh_token) => tokenPost({ refresh_token, grant_type: "refresh_token" });

async function gapi(access, pathAndQuery) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathAndQuery}`, { headers: { authorization: `Bearer ${access}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gmail ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}
async function profile(access) { return gapi(access, "profile"); } // { emailAddress, messagesTotal }

// List message ids matching a Gmail search query, newest first (paginated).
async function listIds(access, q, max = 200) {
  const ids = []; let pageToken = "";
  while (ids.length < max) {
    const page = await gapi(access, `messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(500, max - ids.length)}${pageToken ? "&pageToken=" + pageToken : ""}`);
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken; if (!pageToken || !(page.messages || []).length) break;
  }
  return ids;
}
// Headers only (From, Subject, Date) — cheap, for scanning a whole year of mail.
async function getMeta(access, id) {
  const m = await gapi(access, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  return { id, from: h.from || "", subject: h.subject || "", ts: Number(m.internalDate || 0) };
}
// Full RFC-822 source of one message, as a UTF-8 string (same shape IMAP gives us).
async function getRaw(access, id) {
  const m = await gapi(access, `messages/${id}?format=raw`);
  return Buffer.from(String(m.raw || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

module.exports = { loginUrl, enabled, authUrl, verifyState, exchangeCode, refreshAccess, profile, listIds, getRaw, getMeta, PUBLIC_URL };
