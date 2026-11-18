"use strict";
/**
 * FlightAlert Cloud Worker v2 (Phase B: multi-tenant trials)
 * ----------------------------------------------------------
 * New vs v1:
 *  - AGENCY ROUTING: every incoming mail is matched to the agency whose mailbox
 *    forwarded it (X-Forwarded-For / Delivered-To / From headers vs agencies.forward_sources).
 *    Unmatched mail falls back to the default agency (AGENCY_SLUG, Finch).
 *  - PER-AGENCY DELIVERY: schedule-change alerts are emailed, fully formatted,
 *    to that agency's notify_email (their trial product experience).
 *  - Admin Telegram still receives every card, tagged with the agency name.
 *  - Trial expiry respected: expired trials are logged, not delivered.
 * Env additions: none required. Optional: ANTHROPIC_MODEL.
 */

const path = require("path");
const fs = require("fs");
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
const { parseEmail, splitEmail, helpers, decodeMimeWords, stripHtml } = require("../parser");
const { compile, airlineName } = require("../compiler");
const http = require("http");
const gmail = require("../gmail");
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (_) { console.log("[pdf] pdf-parse not installed — attachment reading off"); }

// Extract text from PDF attachments inside the raw MIME (base64 application/pdf parts).
let simpleParser = null;
try { ({ simpleParser } = require("mailparser")); } catch (_) { console.log("[pdf] mailparser not installed"); }
// Text of every PDF attachment (any MIME layout, application/pdf or octet-stream named *.pdf)
async function extractPdfTexts(raw) {
  if (!pdfParse || !simpleParser) return "";
  const out = [];
  try {
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    for (const att of parsed.attachments || []) {
      const isPdf = /pdf/i.test(att.contentType || "") || /\.pdf$/i.test(att.filename || "");
      if (!isPdf || !att.content || out.length >= 5) continue;
      try {
        const d = await pdfParse(att.content);
        if (d.text && d.text.trim().length > 30) out.push(`--- ${att.filename || "attachment.pdf"} ---\n${d.text}`);
      } catch (e2) { console.log("[pdf] attachment parse failed:", att.filename, e2.message); }
    }
  } catch (e) { console.log("[pdf] mime parse failed:", e.message); }
  return out.join("\n\n");
}

// Client mobile from ticket text (10-digit after CONTACT/Mobile labels; skips agency landline patterns poorly — best-effort).
function extractClientMobile(text) {
  const ms = [...text.matchAll(/(?:CONTACT|MOBILE|PHONE)\s*:?\s*(?:\+?91[\s-]?)?([6-9]\d{9})\b/gi)].map((x) => x[1]);
  return ms.length ? ms[ms.length - 1] : null; // last CONTACT is usually the passenger's on these layouts
}

// ---------- config ----------
let fileCfg = {};
const CFG_PATH = path.join(__dirname, "config.json");
if (fs.existsSync(CFG_PATH)) { try { fileCfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch (_) {} }
const CFG = {
  imapUser: process.env.IMAP_USER || fileCfg.imap?.user,
  imapPass: process.env.IMAP_APP_PASSWORD || fileCfg.imap?.appPassword,
  imapHost: process.env.IMAP_HOST || fileCfg.imap?.host || "imap.gmail.com",
  imapPort: Number(process.env.IMAP_PORT || fileCfg.imap?.port || 993),
  tgToken: process.env.TELEGRAM_BOT_TOKEN || fileCfg.telegram?.botToken,
  tgChat: process.env.TELEGRAM_CHAT_ID || fileCfg.telegram?.chatId,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
  anthropicKey: process.env.ANTHROPIC_API_KEY || fileCfg.anthropicApiKey || "",
  pollSeconds: Number(process.env.POLL_SECONDS || fileCfg.pollSeconds || 60),
  agencySlug: process.env.AGENCY_SLUG || "finch-travels",
};
for (const k of ["imapUser","imapPass","tgToken","tgChat","supabaseUrl","supabaseKey"]) {
  if (!CFG[k]) { console.error(`Missing config: ${k}`); process.exit(1); }
}

const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false } });
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true,
  auth: { user: CFG.imapUser, pass: CFG.imapPass },
  connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  pool: true, maxConnections: 1,
});

// ---------- WhatsApp delivery (Meta Cloud API) ----------
const WA = {
  token: process.env.WA_TOKEN || "",
  phoneId: process.env.WA_PHONE_ID || "",
  enabled() { return Boolean(this.token && this.phoneId); },
};
function normMobile(m) {
  if (!m) return null;
  let d = String(m).replace(/[^\d]/g, "");
  if (d.length === 10) d = "91" + d;            // default India
  if (d.length < 11 || d.length > 15) return null;
  return d;
}
async function sendWhatsApp(toMobile, text) {
  const to = normMobile(toMobile);
  if (!to) return { ok: false, err: "invalid mobile" };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${WA.phoneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WA.token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    });
    const data = await res.json();
    if (!res.ok) {
      const code = data?.error?.code;
      const msg = data?.error?.message || "unknown";
      // 131047 / 131026: outside 24h window or recipient not opted in (test mode)
      return { ok: false, err: `${code}: ${msg}` };
    }
    return { ok: true, id: data.messages?.[0]?.id };
  } catch (e) { return { ok: false, err: e.message }; }
}


// ---------- WhatsApp templates (client messages without the 24-hour rule) ----------
// Env: WA_USE_TEMPLATES=1, WA_TPL_CHANGE (default flight_schedule_change), WA_TPL_CANCEL (default flight_cancellation), WA_TPL_LANG (default en)
const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function legText(sector, l) {
  if (!l) return "";
  const d = l.date && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? `${Number(l.date.slice(8))} ${MON3[Number(l.date.slice(5, 7)) - 1]}` : (l.date || "");
  return [l.flight, String(sector || "").replace(/\s*(→|->)\s*/, "-"), d, `${l.dep || "--:--"}-${l.arr || "--:--"}${l.arrDayOffset ? " (+" + l.arrDayOffset + ")" : ""}`].filter(Boolean).join(" ");
}
const clean = (s, max = 300) => (String(s || "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, max)) || "-";
function titleName(n) { return String(n || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim(); }
// Client sees only the legs that actually changed and are not yet flown.
function clientLegs(p) {
  const segs = p.segments || [];
  const nf = (f) => String(f || "").toUpperCase().replace(/\s+/g, "");
  const legChanged = (s) => !s.new || !s.old || s.status === "CANCELLED" || nf(s.old.flight) !== nf(s.new.flight) || s.old.date !== s.new.date || s.old.dep !== s.new.dep || s.old.arr !== s.new.arr;
  const todayIST = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const notFlown = (s) => { const d = (s.new || s.old || {}).date; return !(d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayIST); };
  let show = segs.filter((s) => s.status !== "UNCHANGED" && legChanged(s) && notFlown(s));
  if (!show.length) show = segs.filter((s) => s.status !== "UNCHANGED" && legChanged(s));
  if (!show.length) show = segs;
  return show;
}
function clientName(p) {
  const pax = (p.passengers || []).map(titleName);
  return pax.length ? pax[0] + (pax.length > 1 ? ` +${pax.length - 1}` : "") : "Customer";
}
// v2 templates: each changed flight on its own lines, "Reply STOP" footer. 1 or 2 flights; more → v1.
//   flight_change_1leg / flight_change_2leg / flight_cancel_1leg / flight_cancel_2leg
function legShort(l) {
  if (!l) return "";
  const d = l.date && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? `${Number(l.date.slice(8))} ${MON3[Number(l.date.slice(5, 7)) - 1]}` : (l.date || "");
  return [l.flight, d, `${l.dep || "--:--"}-${l.arr || "--:--"}${l.arrDayOffset ? " (+" + l.arrDayOffset + ")" : ""}`].filter(Boolean).join(" · ");
}
function templateV2For(p, agency) {
  const legs = clientLegs(p);
  if (!legs.length || legs.length > 2) return null;
  const cancelled = p.changeType === "CANCELLATION";
  const params = [clientName(p), p.pnr, airlineName(p.airline || "")];
  for (const s of legs) {
    params.push(String(s.sector || "").replace(/\s*(→|->|-)\s*/, " → "));
    params.push(legShort(s.old) || "As per your ticket");
    params.push(cancelled ? (legShort(s.new) || "Not offered by the airline - full refund applicable") : (legShort(s.new) || "Please contact us"));
  }
  params.push(agency?.name, agency?.owner_phone || agency?.whatsapp);
  return { name: `${cancelled ? "flight_cancel" : "flight_change"}_${legs.length}leg`, params: params.map((x) => clean(x)) };
}
function templateFor(p, agency) {
  const pax = (p.passengers || []).map(titleName);
  const who = clientName(p);
  const cancelled = p.changeType === "CANCELLATION";
  const show = clientLegs(p);
  const oldTxt = show.filter((s) => s.old).map((s) => legText(s.sector, s.old)).join(" | ");
  const newTxt = show.filter((s) => s.new).map((s) => legText(s.sector, s.new)).join(" | ");
  const params = [who, p.pnr, airlineName(p.airline || ""), cancelled ? oldTxt : (oldTxt || "As per your ticket"), cancelled ? (newTxt || "Not offered by the airline - full refund applicable") : newTxt,
    agency?.name, agency?.owner_phone || agency?.whatsapp];
  return { name: cancelled ? (process.env.WA_TPL_CANCEL || "flight_cancellation") : (process.env.WA_TPL_CHANGE || "flight_schedule_change"),
           params: params.map((x) => clean(x)) };
}
async function sendWhatsAppTemplate(toMobile, name, params) {
  const to = normMobile(toMobile);
  if (!to) return { ok: false, err: "invalid mobile" };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${WA.phoneId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${WA.token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: {
        name, language: { code: process.env.WA_TPL_LANG || "en" },
        components: [{ type: "body", parameters: params.map((t) => ({ type: "text", text: t })) }] } }) });
    const data = await res.json();
    if (!res.ok) return { ok: false, err: `${data?.error?.code}: ${data?.error?.message || "unknown"}${data?.error?.error_data?.details ? " — " + data.error.error_data.details : ""}` };
    return { ok: true, id: data.messages?.[0]?.id };
  } catch (e) { return { ok: false, err: e.message }; }
}
let V2_OFF_UNTIL = 0;
// One entry point: template when enabled (works any time), plain text as fallback (works inside a 24 h window).
async function deliverClientWhatsApp(target, payload, agency, text) {
  if (process.env.WA_USE_TEMPLATES === "1" && payload && payload.pnr) {
    const v2 = Date.now() > V2_OFF_UNTIL ? templateV2For(payload, agency) : null;
    if (v2) {
      const r = await sendWhatsAppTemplate(target, v2.name, v2.params);
      if (r.ok) return { ...r, via: `template ${v2.name}` };
      if (/^13200[01]|^132012/.test(r.err)) V2_OFF_UNTIL = Date.now() + 3600000; // not approved yet → use v1 for an hour
      console.error("[wa-template v2]", r.err);
    }
    const t = templateFor(payload, agency);
    const r = await sendWhatsAppTemplate(target, t.name, t.params);
    if (r.ok) return { ...r, via: `template ${t.name}` };
    console.error("[wa-template]", r.err);
    const r2 = await sendWhatsApp(target, text);
    return r2.ok ? { ...r2, via: "text (template failed: " + r.err + ")" } : { ok: false, err: `template: ${r.err} | text: ${r2.err}` };
  }
  const r = await sendWhatsApp(target, text);
  return { ...r, via: "text" };
}

// ---------- send one alert to the client (dashboard, Telegram approve, auto-send) ----------
async function sendAlertToClient(alertId, { mobile = null, actor = "telegram", fallbackOwner = false } = {}) {
  if (!WA.enabled()) return { ok: false, err: "WhatsApp is not configured on the server" };
  const { data: al } = await sb.from("alerts").select("id,agency_id,pnr,status,compiled_whatsapp,payload").eq("id", alertId).maybeSingle();
  if (!al) return { ok: false, err: "alert not found" };
  const p = al.payload || {};
  if (al.status === "awaiting_data" || !al.pnr || !(p.passengers || []).length) return { ok: false, err: "Passenger details are not complete yet — waiting for the ticket" };
  const ag = AGENCIES.find((a) => a.id === al.agency_id);
  if (ag?.status === "suspended") return { ok: false, err: "Agency is suspended" };
  let target = mobile ? normMobile(mobile) : null, who = "client";
  if (mobile && !target) return { ok: false, err: "Mobile number is not valid" };
  if (target) {
    await sb.from("bookings").update({ mobile: String(mobile).replace(/[^\d+]/g, "") }).eq("agency_id", al.agency_id).eq("pnr", al.pnr).then(() => {}, () => {});
  } else {
    const { data: bk } = await sb.from("bookings").select("mobile").eq("agency_id", al.agency_id).eq("pnr", al.pnr).maybeSingle();
    if (bk?.mobile) target = bk.mobile;
    else if (fallbackOwner && (ag?.whatsapp || ag?.owner_phone)) { target = ag.whatsapp || ag.owner_phone; who = "agency owner"; }
  }
  if (!target) return { ok: false, err: "No client mobile on file — enter it" };
  const { data: opt } = await sb.from("wa_optout").select("phone").eq("phone", normMobile(target)).maybeSingle().then((x) => x, () => ({}));
  if (opt) return { ok: false, err: "This client replied STOP — alerts to this number are switched off" };
  const r = await deliverClientWhatsApp(target, p, ag, al.compiled_whatsapp);
  const now = new Date().toISOString();
  if (r.ok) {
    const full = await sb.from("alerts").update({ status: "sent", sent_at: now, client_status: "sent", client_mobile: String(target), wa_message_id: r.id || null, wa_error: null, sent_by: actor }).eq("id", al.id);
    if (full.error) await sb.from("alerts").update({ status: "sent", sent_at: now }).eq("id", al.id);
    if (actor !== "telegram") await adminCard(`📲 <b>SENT</b> ${esc(al.pnr)} → ${who} +${esc(normMobile(target))} · 🏢 ${esc(ag?.name || "")}
by ${esc(actor)}`).catch(() => {});
  } else {
    await sb.from("alerts").update({ client_status: "failed", wa_error: String(r.err).slice(0, 300), client_mobile: String(target) }).eq("id", al.id).then(() => {}, () => {});
  }
  return { ...r, target: String(target), who };
}
// Auto-send (agency setting): only complete, confident alerts with a client mobile on file.
async function maybeAutoSend(agency, alertId, payload) {
  let sent = false;
  if (agency?.auto_send && alertId && WA.enabled() && trialActive(agency) && (payload?.confidence || 0) >= 0.85) {
    const r = await sendAlertToClient(alertId, { actor: "auto-send" });
    sent = r.ok;
    if (!r.ok) await adminCard(`⏸ Auto-send skipped for ${esc(payload?.pnr || "")} · 🏢 ${esc(agency.name)}: ${esc(r.err)}`).catch(() => {});
  }
  if (!sent) await notifyAgentWhatsApp(agency, payload).catch((e) => console.error("[agent-notify]", e.message));
}
// Ping the agency on its own WhatsApp: "new change — open your dashboard". On by default for every agency
// except the operator's own (it gets Telegram); switch in dashboard Settings (agent_wa_notify).
async function notifyAgentWhatsApp(agency, p) {
  if (!agency || !WA.enabled() || !trialActive(agency)) return;
  const on = agency.agent_wa_notify ?? (agency.id !== DEFAULT_AGENCY?.id);
  const to = agency.whatsapp || agency.owner_phone;
  if (!on || !to || !p?.pnr) return;
  const kind = p.changeType === "CANCELLATION" ? "cancellation" : "schedule change";
  const pax = (p.passengers || []).map(titleName);
  const r = await sendWhatsAppTemplate(to, "agent_new_alert", [kind, p.pnr, airlineName(p.airline || "") || "-", pax.length ? pax[0] + (pax.length > 1 ? ` +${pax.length - 1}` : "") : "-"].map((x) => clean(x)));
  if (!r.ok && !/^13200[01]|^132012/.test(r.err)) console.error("[agent-notify]", agency.slug, r.err);
}

// ---------- agency directory (refreshed every 5 min) ----------
let AGENCIES = [];
let DEFAULT_AGENCY = null;
async function loadAgencies() {
  const BASE = "id,name,slug,plan,trial_ends_at,notify_email,owner_phone,whatsapp,forward_sources,telegram_chat_id,alerts_email";
  let { data, error } = await sb.from("agencies").select(BASE + ",gmail_email,gmail_refresh_token,gmail_backfill_status");
  if (error && /gmail_/.test(error.message)) {
    // Gmail columns not created yet (gmail-patch.sql not run) — keep working without Gmail.
    console.error("[agencies] gmail columns missing — run gmail-patch.sql in Supabase; continuing without Gmail");
    ({ data, error } = await sb.from("agencies").select(BASE));
  }
  if (error) { console.error("[agencies-error]", error.message); return; }
  AGENCIES = data || [];
  let ext = await sb.from("agencies").select("id,status,auto_send,agent_wa_notify,paid_until");
  if (ext.error) ext = await sb.from("agencies").select("id,status,auto_send");
  if (!ext.error) { const m = new Map(ext.data.map((x) => [x.id, x])); for (const a of AGENCIES) { const x = m.get(a.id) || {}; Object.assign(a, { status: x.status || "active", auto_send: Boolean(x.auto_send), agent_wa_notify: x.agent_wa_notify ?? null, paid_until: x.paid_until || null }); } }
  DEFAULT_AGENCY = AGENCIES.find((a) => a.slug === CFG.agencySlug) || AGENCIES[0] || null;
  console.log(`[agencies] loaded ${AGENCIES.length} (default: ${DEFAULT_AGENCY?.name})`);
}

function extractRouteAddresses(rawHead, email) {
  const addrs = new Set();
  const grab = (re) => { let m; while ((m = re.exec(rawHead)) !== null) addrs.add(m[1].toLowerCase()); };
  grab(/^X-Forwarded-For:\s*(?:.*?<)?([^\s<>,]+@[^\s<>,]+)/gim);
  grab(/^Delivered-To:\s*([^\s<>,]+@[^\s<>,]+)/gim);
  grab(/^Return-Path:\s*<?([^\s<>,]+@[^\s<>,]+)>?/gim);
  grab(/^To:\s*(?:.*?<)?([^\s<>,]+@[^\s<>,]+)/gim);
  grab(/^X-Forwarded-To:\s*([^\s<>,]+@[^\s<>,]+)/gim);
  const fromM = (email.from || "").match(/<?([^\s<>,]+@[^\s<>,]+)>?/);
  if (fromM) addrs.add(fromM[1].toLowerCase());
  addrs.delete(CFG.imapUser.toLowerCase());
  return [...addrs];
}
function resolveAgency(rawHead, email) {
  const addrs = extractRouteAddresses(rawHead, email);
  // Priority 1: mail addressed to the agency's own @aviolink.in address
  for (const a of AGENCIES) {
    if (a.alerts_email && addrs.includes(String(a.alerts_email).toLowerCase())) return a;
  }
  // Priority 2: forwarded from a registered source mailbox
  for (const a of AGENCIES) {
    const sources = (a.forward_sources || []).map((s) => String(s).toLowerCase());
    if (sources.some((s) => addrs.includes(s))) return a;
  }
  return DEFAULT_AGENCY;
}
function trialActive(a) {
  if (!a || a.status === "suspended") return false;
  if (a.plan !== "trial") return !a.paid_until || new Date(a.paid_until) > new Date(); // paid: until the paid period ends
  return !a.trial_ends_at || new Date(a.trial_ends_at) > new Date();
}

// ---------- Telegram (admin oversight) ----------
const TG = `https://api.telegram.org/bot${CFG.tgToken}`;
async function tg(method, payload) {
  const res = await fetch(`${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram ${method}:`, data.description);
  return data;
}
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// WhatsApp markup -> Telegram HTML for a readable preview (*bold* -> <b>, _italic_ -> <i>)
function waPreviewHtml(waText) {
  return esc(waText)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>");
}
async function adminCard(text, alertId) {
  const payload = { chat_id: CFG.tgChat, text, parse_mode: "HTML" };
  if (alertId) payload.reply_markup = { inline_keyboard: [[
    { text: "✅ Approve", callback_data: `ap:${alertId}` },
    { text: "❌ Skip", callback_data: `sk:${alertId}` },
  ]]};
  return tg("sendMessage", payload);
}
let tgOffset = 0;
async function pollTelegram() {
  const data = await tg("getUpdates", { offset: tgOffset, timeout: 0 });
  for (const u of data.result || []) {
    tgOffset = u.update_id + 1;
    // /retest PNR  -> forget this PNR's recent mails + alerts so the next poll re-reads them (no re-forwarding needed)
    const txt = (u.message?.text || "").trim();
    if (txt.startsWith("/report")) { await nightlyReport(true); continue; }
    if (txt.startsWith("/billing")) { await adminCard(`💳 <b>BILLING CHECK</b>\n${esc(await BILLING.check())}\n\nWebhook URL in Razorpay must be: https://api.aviolink.in/webhook/razorpay`); continue; }
    if (txt.startsWith("/marketing")) { try { await weeklyMarketing(true); } catch (e) { await adminCard(`📣 Marketing post failed: ${esc(e.message)}`); } continue; }
    if (txt.startsWith("/proof")) {
      const [, d, s] = txt.split(/\s+/);
      try { await adminCard(await proofReport(Math.min(365, Number(d) || 30), s || "")); }
      catch (e) { await adminCard(`📈 Proof report failed: ${esc(e.message)}`); }
      continue;
    }
    if (/^\/(buildtests|selftest|acceptall)/.test(txt)) {
      const cmd = txt.match(/^\/(\w+)/)[1];
      await tg("sendMessage", { chat_id: u.message.chat.id, text: cmd === "buildtests" ? "🧪 Collecting real airline mails from Gmail for the test set… (a few minutes)" : cmd === "selftest" ? "🧪 Re-reading every test mail with the current code… (a few minutes)" : "🧪 Updating expected results…" });
      const job = cmd === "buildtests" ? SELFTEST.build("") : cmd === "selftest" ? SELFTEST.run("on request") : SELFTEST.acceptAll();
      job.catch((e) => adminCard(`🧪 ${cmd} failed: ${esc(e.message)}`));
      continue;
    }
    if (txt.startsWith("/watemplates")) {
      const waba = process.env.WA_WABA_ID || "2690954148013574";
      const H = { authorization: `Bearer ${WA.token}`, "content-type": "application/json" };
      const L1 = (n, a, b, c) => `\u2708\uFE0F {{${n}}}\n${a}: {{${n + 1}}}\n${b}: {{${n + 2}}}`;
      const head = (verb) => `Dear {{1}},\n\nThe airline has ${verb} your booking PNR {{2}} with {{3}}.\n\n`;
      const tail = (n) => `\n\nFor any queries, please contact {{${n}}} at {{${n + 1}}}. Thank you.`;
      const ex1 = ["Mr. Rahul Sharma", "AB12CD", "IndiGo (6E)", "PNQ \u2192 DEL", "6E 2418 \u00b7 10 Dec \u00b7 06:10-08:15", "6E 2418 \u00b7 10 Dec \u00b7 06:40-08:45"];
      const ex2 = ["DEL \u2192 PNQ", "6E 2419 \u00b7 14 Dec \u00b7 19:00-21:05", "6E 2419 \u00b7 14 Dec \u00b7 19:30-21:35"];
      const exC1 = ["Mr. Rahul Sharma", "AB12CD", "IndiGo (6E)", "PNQ \u2192 DEL", "6E 2418 \u00b7 10 Dec \u00b7 06:10-08:15", "6E 2422 \u00b7 10 Dec \u00b7 09:30-11:35"];
      const exC2 = ["DEL \u2192 PNQ", "6E 2419 \u00b7 14 Dec \u00b7 19:00-21:05", "Not offered by the airline - full refund applicable"];
      const ag = ["Finch Travels", "+91 92705 46474"];
      const defs = [
        ["flight_change_1leg", head("changed the schedule of") + L1(4, "Previous", "Revised") + tail(7), [...ex1, ...ag]],
        ["flight_change_2leg", head("changed the schedule of") + L1(4, "Previous", "Revised") + "\n\n" + L1(7, "Previous", "Revised") + tail(10), [...ex1, ...ex2, ...ag]],
        ["flight_cancel_1leg", head("cancelled a flight in") + L1(4, "Cancelled", "Alternative") + tail(7), [...exC1, ...ag]],
        ["agent_new_alert", "New flight {{1}} for PNR {{2}} ({{3}}).\nPassenger: {{4}}\n\nOpen your Aviolink dashboard to check it and send it to your client: https://app.aviolink.in", ["schedule change", "AB12CD", "IndiGo (6E)", "Mr. Rahul Sharma"]],
        ["flight_cancel_2leg", head("cancelled flights in") + L1(4, "Cancelled", "Alternative") + "\n\n" + L1(7, "Cancelled", "Alternative") + tail(10), [...exC1, ...exC2, ...ag]],
      ];
      const out = [];
      for (const [name, text, ex] of defs) {
        const body = { name, language: "en", category: "UTILITY", components: [
          { type: "BODY", text, example: { body_text: [ex] } },
          { type: "FOOTER", text: "Reply STOP to stop flight alerts" },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop alerts" }] } ] };
        const r = await fetch(`https://graph.facebook.com/v20.0/${waba}/message_templates`, { method: "POST", headers: H, body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ error: { message: e.message } }));
        out.push(r.id ? `\u2705 ${name}: submitted (${r.status || "PENDING"})` : `\u274c ${name}: ${r.error?.error_user_msg || r.error?.message || JSON.stringify(r).slice(0, 200)}`);
      }
      const list = await fetch(`https://graph.facebook.com/v20.0/${waba}/message_templates?fields=name,status,category,rejected_reason&limit=50`, { headers: H }).then((x) => x.json()).catch(() => ({}));
      const st = (list.data || []).filter((t) => /^flight_/.test(t.name)).map((t) => `${t.name}: ${t.status}${t.category ? " \u00b7 " + t.category : ""}${t.rejected_reason && t.rejected_reason !== "NONE" ? " \u00b7 " + t.rejected_reason : ""}`).join("\n");
      await tg("sendMessage", { chat_id: u.message.chat.id, text: `${out.join("\n")}\n\nAll flight templates now:\n${st || "-"}\n\nSend /watemplates again any time to see the status (already-existing ones just show as errors).` });
      continue;
    }
    if (txt.startsWith("/wasub")) {
      const waba = process.env.WA_WABA_ID || "2690954148013574";
      const H = { authorization: `Bearer ${WA.token}`, "content-type": "application/json" };
      const sub = await fetch(`https://graph.facebook.com/v20.0/${waba}/subscribed_apps`, { method: "POST", headers: H }).then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
      const list = await fetch(`https://graph.facebook.com/v20.0/${waba}/subscribed_apps`, { headers: H }).then((r) => r.json()).catch(() => ({}));
      const ph = await fetch(`https://graph.facebook.com/v20.0/${WA.phoneId}?fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type,status,messaging_limit_tier`, { headers: H }).then((r) => r.json()).catch(() => ({}));
      await tg("sendMessage", { chat_id: u.message.chat.id, text: `🔗 Subscribe app to WABA ${waba}: ${sub.success ? "OK" : JSON.stringify(sub.error || sub).slice(0, 300)}\nApps subscribed: ${(list.data || []).map((x) => x.whatsapp_business_api_data?.name || x.name || "app").join(", ") || "none"}\n\n📱 Number: ${JSON.stringify(ph).slice(0, 600)}` });
      continue;
    }
    if (txt.startsWith("/watest")) {
      const to = (txt.split(/\s+/)[1] || "");
      const ag = AGENCIES.find((a) => a.slug === CFG.agencySlug) || AGENCIES[0];
      const sample = { pnr: "VETN8N", airline: "6E", changeType: "SCHEDULE_CHANGE", passengers: ["MR DHYEY TAILOR", "MS ANJANA TAILOR"],
        segments: [{ sector: "DEL-JDH", old: { flight: "6E 6629", date: "2026-10-30", dep: "11:05", arr: "12:25" }, new: { flight: "6E 6629", date: "2026-10-30", dep: "10:50", arr: "12:05" } }] };
      const t = templateFor(sample, ag);
      const r = await sendWhatsAppTemplate(to, t.name, t.params);
      if (r.ok && r.id) WATCH_WA.set(r.id, `test to +${normMobile(to)}`);
      await tg("sendMessage", { chat_id: u.message.chat.id, text: r.ok ? `✅ Accepted by Meta: "${t.name}" to ${to} (msg ${r.id}). Delivery status will follow here.` : `❌ ${r.err}` });
      continue;
    }
    if (txt.startsWith("/backfill")) {
      const n = AGENCIES.filter((a) => a.gmail_refresh_token);
      for (const a of n) { await sb.from("agencies").update({ gmail_backfill_status: "pending" }).eq("id", a.id); a.gmail_backfill_status = "pending"; }
      await tg("sendMessage", { chat_id: u.message.chat.id, text: `📚 Backfill re-queued for ${n.length} mailbox(es) — starts within a minute.` });
      continue;
    }
    if (txt.startsWith("/fetch")) {
      const key = (txt.split(/\s+/)[1] || "").toUpperCase();
      const a = AGENCIES.find((x) => x.gmail_refresh_token);
      if (!/^[A-Z0-9]{5,15}$/.test(key) || !a) { await tg("sendMessage", { chat_id: u.message.chat.id, text: "Usage: /fetch PNR  (needs a Gmail-connected agency)" }); continue; }
      fetchByKey(a, key, u.message.chat.id).catch((e) => tg("sendMessage", { chat_id: u.message.chat.id, text: `❌ /fetch ${key}: ${e.message}` }));
      continue;
    }
    if (txt.startsWith("/status")) {
      const ago = (t) => t ? `${Math.round((Date.now() - t) / 60000)} min ago` : "never";
      const rows = AGENCIES.map((a) => {
        const h = GMAIL_HEALTH.get(a.id) || {};
        if (!a.gmail_refresh_token) return `🏢 ${a.name}: Gmail not connected (forwarding only)`;
        return `🏢 ${a.name} — ${a.gmail_email}\n   last read OK: ${ago(h.okAt)} · mails in 3-day window: ${h.seen ?? "?"}\n   backfill: ${a.gmail_backfill_status || "-"}${h.err ? `\n   last error (${ago(h.errAt)}): ${String(h.err).slice(0, 200)}` : ""}`;
      }).join("\n\n");
      await tg("sendMessage", { chat_id: u.message.chat.id, text: `📊 Status\nGoogle sign-in: ${gmail.enabled() ? "ON" : "OFF"}\n\n${rows}` });
      continue;
    }
    if (txt.startsWith("/retest")) {
      const pnr = (txt.split(/\s+/)[1] || "").toUpperCase();
      if (!/^[A-Z0-9]{5,15}$/.test(pnr)) { await tg("sendMessage", { chat_id: u.message.chat.id, text: "Usage: /retest PNR  (or booking / order number)" }); continue; }
      const since = new Date(Date.now() - 3 * 86400000).toISOString();
      const { data: logs } = await sb.from("mail_log").select("id,subject,verdict,detail,message_id").gte("created_at", since)
        .or(`subject.ilike.%${pnr}%,detail.ilike.%${pnr}%`);
      const ids = (logs || []).map((r) => r.id);
      if (ids.length) await sb.from("mail_log").delete().in("id", ids);
      const { data: als } = await sb.from("alerts").select("id").eq("pnr", pnr).gte("created_at", since);
      if (als && als.length) await sb.from("alerts").delete().in("id", als.map((a) => a.id));
      const lines = (logs || []).map((r) => `• ${r.message_id.startsWith("gm-") ? "[Gmail]" : "[Fwd]"} ${String(r.subject).slice(0, 70)}\n   → ${r.verdict}${r.detail ? " (" + String(r.detail).slice(0, 80) + ")" : ""}`).join("\n");
      await tg("sendMessage", { chat_id: u.message.chat.id, text: `🔁 Retest ${pnr}: ${ids.length} mail(s) will be re-read on the next poll (≤60s), ${als?.length || 0} old alert(s) cleared.${lines ? "\n\nPrevious result:\n" + lines : "\n\nNo mail with this PNR in its subject was found in the last 3 days."}` });
      continue;
    }
    if (!u.callback_query) continue;
    const [action, alertId] = (u.callback_query.data || "").split(":");
    const status = action === "ap" ? "approved" : "skipped";
    if (alertId && !["sweep","review","no-pnr"].includes(alertId)) {
      await sb.from("alerts").update({ status, approved_at: new Date().toISOString() }).eq("id", alertId);
      if (action === "ap" && WA.enabled()) {
        try {
          const r = await sendAlertToClient(alertId, { actor: "telegram", fallbackOwner: true });
          if (r.ok && r.id) WATCH_WA.set(r.id, `${r.who} +${normMobile(r.target)}`);
          await tg("sendMessage", { chat_id: u.callback_query.message.chat.id, text: r.ok ? (r.who === "agency owner" ? `ℹ️ No client mobile on file for this PNR — sent to the agency's own WhatsApp (${r.target}).\n` : "") + `📲 Sent to ${r.who} (${r.target}) via ${r.via} — delivery status follows` : `⚠️ Not sent: ${r.err}` });
        } catch (e) { console.error("[wa-error]", e.message); }
      }
    }
    await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: status.toUpperCase() });
    await tg("editMessageReplyMarkup", { chat_id: u.callback_query.message.chat.id, message_id: u.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
}

// ---------- Supabase helpers (agency-scoped) ----------
async function alreadyProcessed(messageId) {
  const { data } = await sb.from("mail_log").select("id").eq("message_id", messageId).limit(1);
  return data && data.length > 0;
}
async function logMail(agencyId, messageId, subject, verdict, detail = "") {
  await sb.from("mail_log").insert({ agency_id: agencyId, message_id: messageId, subject, verdict, detail });
}
async function upsertBooking(agencyId, parsed, extra = {}) {
  await sb.from("bookings").upsert({
    agency_id: agencyId, pnr: parsed.pnr, airline: parsed.airline || null,
    passengers: parsed.passengers || [], segments: parsed.segments || [],
    source: parsed.source || null, ...extra,
  }, { onConflict: "agency_id,pnr" });
}
async function insertAlert(agencyId, parsed, compiledWhatsapp) {
  const { data } = await sb.from("alerts").insert({
    agency_id: agencyId, pnr: parsed.pnr, change_type: parsed.changeType,
    payload: parsed, compiled_whatsapp: compiledWhatsapp,
    confidence: parsed.confidence, source: parsed.source, status: "pending",
  }).select("id").single();
  return data?.id || null;
}

// ---------- per-agency delivery ----------
let smtpFailures = 0;
async function deliverToAgency(agency, parsed, msg, alertId) {
  if (!agency?.notify_email) return false;
  if (smtpFailures >= 2) { return false; } // SMTP blocked on this host — skip silently, Telegram is the channel
  try {
    await mailer.sendMail({
      from: `"FlightAlert" <${CFG.imapUser}>`,
      to: agency.notify_email,
      subject: `⚡ ${msg.emailSubject}`,
      text: `${msg.whatsapp}\n\n— — —\nCopy-paste the message above straight to your client's WhatsApp.\n\n${msg.emailBody}`,
    });
    if (alertId) await sb.from("alerts").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", alertId);
    return true;
  } catch (e) {
    smtpFailures++;
    console.error(`[deliver-error] ${agency.slug}: ${e.message}${smtpFailures >= 2 ? " — email delivery disabled until restart (host blocks SMTP)" : ""}`);
    return false;
  }
}


// Fill OLD timing from stored booking segments when a change shows only the NEW schedule
// (IndiGo "Revised Itinerary" style). Match by flight number, else by sector. Returns true if anything changed.
function enrichOldTiming(p, bookingSegments) {
  const nf = (f) => String(f || "").toUpperCase().replace(/\s+/g, "");
  let touched = false;
  for (const s of p.segments || []) {
    const nu = s.new || (s.dep || s.date ? { flight: s.flight, date: s.date, dep: s.dep, arr: s.arr } : null);
    const hasOld = s.old && (s.old.dep || s.old.date);
    if (hasOld || !nu) continue;
    const bs = (bookingSegments || []).find((x) => (x.flight && nu.flight && nf(x.flight) === nf(nu.flight)) || (x.sector && s.sector && x.sector === s.sector));
    if (bs && (bs.dep !== nu.dep || bs.date !== nu.date || bs.arr !== nu.arr)) {
      s.old = { flight: bs.flight, date: bs.date, dep: bs.dep, arr: bs.arr };
      s.new = nu; s.status = s.status || "CHANGED"; touched = true;
      console.log(`[old-timing] ${p.pnr} ${s.sector}: ${bs.date} ${bs.dep} -> ${nu.date} ${nu.dep} (from booking)`);
    }
  }
  return touched;
}

// ---------- per-mail handling ----------
// Airport codes in a change mail are checked against the ticket on file: same flight number => the ticket's sector wins
// (stops misreads like PNQ→"PQQ" reaching the client).
async function fixSectorsFromBooking(agencyId, parsed) {
  if (parsed.kind !== "SCHEDULE_CHANGE" || !parsed.pnr || !(parsed.segments || []).length) return;
  const { data: bk } = await sb.from("bookings").select("segments").eq("agency_id", agencyId).eq("pnr", parsed.pnr).maybeSingle();
  if (!bk || !(bk.segments || []).length) return;
  const nf = (f) => String(f || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^([A-Z0-9]{2})0+/, "$1");
  const ns = (s) => String(s || "").toUpperCase().match(/[A-Z]{3}/g) || [];
  for (const s of parsed.segments) {
    const fl = nf(s.flight || s.old?.flight || s.new?.flight);
    if (!fl) continue;
    const b = bk.segments.find((x) => nf(x.flight || x.old?.flight || x.new?.flight) === fl);
    const bs = b ? ns(b.sector) : [];
    if (bs.length !== 2) continue;
    const cur = ns(s.sector);
    if (cur[0] !== bs[0] || cur[1] !== bs[1]) { console.log(`[sector-fix] ${parsed.pnr} ${fl}: ${s.sector} -> ${bs.join("-")}`); s.sector = `${bs[0]}-${bs[1]}`; }
  }
}

async function handleParsed(agency, parsed, subject, messageId) {
  await fixSectorsFromBooking(agency.id, parsed).catch(() => {});
  const conf = Math.round((parsed.confidence || 0) * 100);
  const tag = `🏢 ${esc(agency.name)}`;

  if (parsed.kind === "TICKET" && parsed.pnr) {
    const mobile = extractClientMobile((parsed.raw && parsed.raw.subject ? "" : "") + JSON.stringify(parsed) ) || null;
    const bodyMobile = parsed._bodyMobile || null;
    const { data: prev } = await sb.from("bookings").select("passengers,segments,airline").eq("agency_id", agency.id).eq("pnr", parsed.pnr).maybeSingle();
    const revision = prev ? diffItinerary(prev.segments || [], parsed.segments || []) : null;
    await upsertBooking(agency.id, parsed, bodyMobile ? { mobile: bodyMobile } : {});
    if (revision) {
      // A new ticket / trip summary for a PNR we already hold, with different flights or timings = schedule change.
      const chg = { kind: "SCHEDULE_CHANGE", changeType: revision.cancelledOnly ? "CANCELLATION" : "SCHEDULE_CHANGE", pnr: parsed.pnr,
        airline: parsed.airline || prev.airline, passengers: (parsed.passengers && parsed.passengers.length) ? parsed.passengers : (prev.passengers || []),
        segments: revision.segments, confidence: 0.84, source: "revised-ticket", raw: parsed.raw, _bodyMobile: bodyMobile };
      console.log(`[revised] ${agency.slug} ${parsed.pnr}: itinerary differs from stored ticket -> change alert`);
      await logMail(agency.id, messageId, subject, "ticket", parsed.pnr + " (revised)");
      await handleParsed(agency, chg, subject, `${messageId}#rev`);
      return;
    }
    await logMail(agency.id, messageId, subject, "ticket", parsed.pnr);
    await adminCard(`🎫 <b>BOOKING</b> — ${esc(parsed.pnr)} · ${tag}\n${esc((parsed.passengers||[]).join(", ")||"pax n/a")}${bodyMobile ? `\n📱 ${bodyMobile}` : ""}\n<i>${conf}% · ${esc(parsed.source)}</i>`);
    console.log(`[ticket] ${agency.slug} ${parsed.pnr} (${conf}%)`);

    // COMPLETION LOOP: fill any pending alert that was missing pax/PNR — only if this ticket HAS passengers.
    if (!(parsed.passengers && parsed.passengers.length)) return;
    try {
      const flights = new Set((parsed.segments || []).map((s) => s.flight).filter(Boolean));
      const { data: pend } = await sb.from("alerts").select("id,pnr,payload")
        .eq("agency_id", agency.id).in("status", ["pending", "awaiting_data"]).limit(25);
      for (const al of pend || []) {
        const p = al.payload || {};
        const paxMissing = !(p.passengers && p.passengers.length);
        const pnrMatch = al.pnr && al.pnr === parsed.pnr;
        const norm = (f) => String(f || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const tk = new Set((parsed.segments || []).map((s) => norm(s.flight) + "|" + (s.date || "")));
        const flightMatch = (p.segments || []).some((s) => [s.old, s.new].some((l) => l && tk.has(norm(l.flight) + "|" + (l.date || ""))))
          || (!al.pnr && (p.segments || []).some((s) => flights.has(s.old?.flight) || flights.has(s.new?.flight) || flights.has(s.flight)));
        let ownBooking = false;
        if (flightMatch && al.pnr && al.pnr !== parsed.pnr) {
          const { data: ob } = await sb.from("bookings").select("id").eq("agency_id", agency.id).eq("pnr", al.pnr).maybeSingle();
          ownBooking = Boolean(ob); // that PNR has its own ticket — never borrow names from another booking
        }
        if (paxMissing && (pnrMatch || (flightMatch && !ownBooking))) {
          p.passengers = parsed.passengers || [];
          p.pnr = p.pnr || parsed.pnr;
          enrichOldTiming(p, parsed.segments);
          const msg2 = compile(p, { name: agency.name, phone: agency.owner_phone || agency.whatsapp || "" });
          await sb.from("alerts").update({ pnr: p.pnr, payload: p, compiled_whatsapp: msg2.whatsapp, status: "pending" }).eq("id", al.id);
          if (trialActive(agency)) await deliverToAgency(agency, p, msg2, al.id);
          await maybeAutoSend(agency, al.id, p);
          await adminCard(`✅ <b>ALERT COMPLETED</b> with passenger details · ${tag}\n\n<pre>${esc(msg2.whatsapp)}</pre>`, al.id);
          console.log(`[complete] alert ${al.id} filled from ticket ${parsed.pnr}`);
        }
      }
    } catch (e) { console.error("[complete-error]", e.message); }
    return;
  }

  // Airline says "PNR X changed" but gives no flights/timings (e.g. Qatar "view my flight schedule" mails)
  if (parsed.kind === "SCHEDULE_CHANGE" && parsed.pnr && !(parsed.segments || []).length) {
    const { data: b } = await sb.from("bookings").select("passengers,segments,airline").eq("agency_id", agency.id).eq("pnr", parsed.pnr).maybeSingle();
    const pax = (b?.passengers || parsed.passengers || []);
    const legs = (b?.segments || []).map((s) => `${s.flight || ""} · ${String(s.sector || "").replace("-", " → ")} · ${s.date || ""} · ${s.dep || "--"}–${s.arr || "--"}`);
    const airline = parsed.airline || b?.airline || "";
    const fromAddr = ((parsed.raw?.from || "").match(/@([^>\s]+)/) || [])[1] || "";
    await logMail(agency.id, messageId, subject, "change", `${parsed.pnr} — notice without details`);
    await adminCard(`⚡ <b>SCHEDULE CHANGE — DETAILS NOT IN MAIL</b> · ${tag}\n🎫 PNR: <b>${esc(parsed.pnr)}</b>${airline ? " · ✈️ " + esc(airline) : ""}${fromAddr ? " · " + esc(fromAddr) : ""}\n` +
      (pax.length ? `👤 ${esc(pax.join(", "))}\n` : "👤 (no ticket on file)\n") +
      (legs.length ? `\n<b>Booked flights (before change):</b>\n${esc(legs.join("\n"))}\n` : "") +
      `\n⚠️ The airline did not include the new timings. Check the PNR in GDS / airline website and inform the client.\n<i>Not sent to client automatically.</i>`);
    console.log(`[change-notice] ${agency.slug} ${parsed.pnr} (no details in mail)`);
    return;
  }

  if (parsed.kind === "SCHEDULE_CHANGE" && (parsed.segments || []).length) {
    if (parsed.pnr) {
      const { data: b } = await sb.from("bookings").select("passengers,mobile").eq("agency_id", agency.id).eq("pnr", parsed.pnr).maybeSingle();
      if (b) {
        if ((!parsed.passengers || !parsed.passengers.length) && b.passengers?.length) parsed.passengers = b.passengers;
        parsed.clientMobile = b.mobile || null;
        enrichOldTiming(parsed, b.segments);
      }
    }
    // Duplicate = same PNR + same change type + identical old/new flight details.
    // A different timing for the same PNR is a NEW change and must alert.
    if (parsed.pnr) {
      const fp = (p) => JSON.stringify({ t: p.changeType, s: (p.segments || []).map((s) => ({
        st: s.status, sec: s.sector,
        o: s.old ? [s.old.flight, s.old.date, s.old.dep, s.old.arr] : null,
        n: s.new ? [s.new.flight, s.new.date, s.new.dep, s.new.arr] : null })) });
      const mine = fp(parsed);
      const { data: recent } = await sb.from("alerts").select("id,payload").eq("agency_id", agency.id).eq("pnr", parsed.pnr)
        .gte("created_at", new Date(Date.now() - 72 * 3600 * 1000).toISOString()).limit(20);
      if ((recent || []).some((r) => r.payload && fp(r.payload) === mine)) {
        await logMail(agency.id, messageId, subject, "dup", parsed.pnr);
        console.log(`[dup] ${agency.slug} ${parsed.pnr} identical change already alerted — skipped`);
        return;
      }
    }
    const msg = compile(parsed, { name: agency.name, phone: agency.owner_phone || agency.whatsapp || "" });
    const alertId = await insertAlert(agency.id, parsed, msg.whatsapp);
    await logMail(agency.id, messageId, subject, "change", parsed.pnr || "");

    let deliveredNote = "";
    const hasFullData = Boolean(parsed.pnr && parsed.passengers && parsed.passengers.length);
    // Urgency override: flight within 48h -> deliver even if incomplete.
    const soonest = (parsed.segments || []).map((s) => s.old?.date || s.date).filter(Boolean).sort()[0];
    const imminent = soonest && (new Date(soonest + "T23:59:59") - Date.now()) < 48 * 3600 * 1000;
    if (!hasFullData && imminent) {
      const urgent = { ...parsed };
      const msgU = compile(urgent, { name: agency.name, phone: agency.owner_phone || agency.whatsapp || "" });
      msgU.whatsapp = "⚠️ *URGENT — flight imminent*\n" + msgU.whatsapp;
      msgU.emailSubject = "URGENT | " + msgU.emailSubject;
      if (trialActive(agency)) {
        const ok = await deliverToAgency(agency, urgent, msgU, alertId);
        deliveredNote = ok ? `\n🚨 <b>URGENT (≤48h)</b> — delivered despite incomplete data (${esc(agency.notify_email)})` : `\n⚠️ urgent delivery failed`;
      } else deliveredNote = `\n⏸ trial expired`;
    } else if (!hasFullData) {
      await sb.from("alerts").update({ status: "awaiting_data" }).eq("id", alertId);
      deliveredNote = `\n⏸ <b>HELD — incomplete data, not delivered.</b> Will auto-complete & deliver when the ticket arrives.`;
    } else if (trialActive(agency)) {
      await maybeAutoSend(agency, alertId, parsed);
      const ok = await deliverToAgency(agency, parsed, msg, alertId);
      deliveredNote = ok ? `\n📬 delivered to ${esc(agency.notify_email)}` : `\n⚠️ delivery failed`;
    } else {
      deliveredNote = `\n⏸ trial expired — not delivered`;
    }
    const header = conf >= 85 ? `⚡ <b>SCHEDULE CHANGE</b> (${conf}%)` : `⚠️ <b>SCHEDULE CHANGE — ${conf}%, verify</b>`;
    const askTicket = (!parsed.passengers || !parsed.passengers.length)
      ? `\n↩️ <i>Forward the original ticket mail — the alert will auto-complete with passenger details.</i>` : "";
    await adminCard(
      `${header} · ${tag}${deliveredNote}${askTicket}\n\n` +
      `${waPreviewHtml(msg.whatsapp)}\n\n` +
      `📋 <i>Tap to copy for WhatsApp:</i>\n<pre>${esc(msg.whatsapp)}</pre>`,
      alertId
    );
    console.log(`[change] ${agency.slug} ${parsed.pnr} alert ${alertId} (${conf}%)`);
    return;
  }

  const why = `kind=${parsed.kind || "-"} pnr=${parsed.pnr || "-"} pax=${(parsed.passengers || []).length} legs=${(parsed.segments || []).length} src=${parsed.source || "-"}`;
  await logMail(agency.id, messageId, subject, "review", why);
  await adminCard(`🔍 <b>UNRECOGNISED</b> · ${tag}\nSubject: ${esc(subject)}\n<i>${esc(why)}</i>`);
  console.log(`[review] ${agency.slug} ${subject}`);
}

// ---------- relevance gates ----------
const AIRLINE_HINTS = /(pobeda|aeroflot|s7\.ru|utair|uralairlines|azurair|rossiya|onetwotrip|aviasales|kiwi\.com|trip\.com|expedia|edreams|opodo|gotogate|mytrip|wizzair|pegasus|ajet|sunexpress|airasia|vietjet|scoot|jetstar|cebupacific|philippineairlines|garuda|biman|usbangla|nepalairlines|buddhaair|drukair|bhutanairlines|maldivian|flyadeal|jazeeraairways|salamair|egyptair|royaljordanian|mea\.com|ethiopianairlines|kenya-airways|rwandair|airmauritius|aircanada|westjet|alaskaair|jetblue|southwest|aeromexico|latam|avianca|copaair|iberia|vueling|ryanair|easyjet|flytap|ita-airways|swiss\.com|austrian|brusselsairlines|finnair|flysas|lot\.com|aegeanair|aerlingus|condor|eurowings|chinasouthern|ceair|airchina|hainanairlines|ana\.co\.jp|jal\.co|koreanair|flyasiana|evaair|qantas|virginaustralia|airnewzealand|airindia|goindigo|spicejet|akasaair|airindiaexpress|flydubai|emirates|qatarairways|etihad|singaporeair|turkishairlines|lufthansa|britishairways|riyadhair|saudia|flynas|airarabia|vistara|gulfair|omanair|kuwaitairways|srilankan|malaysiaairlines|thaiairways|cathaypacific|klm|airfrance|virginatlantic|americanairlines|united|delta|travelport|galileo|tripjack|tbo|travclan|mystifly|akbartravels|cleartrip|makemytrip|yatra|easemytrip|ixigo)/i;
// Generic airline-sender pattern: alerts@/notifications@/noreply@ *air*/airlines/airways domains
const AIRLINE_SENDER = /@(?:[a-z0-9.-]*\b(?:air|airline|airways|aviation|fly)[a-z0-9-]*)\.[a-z]{2,}/i;
const NEGATIVE_HINTS = /(login otp|otp email|one[- ]?time password|verification code|verify your|password reset|security alert|two[- ]?step|2-step|unsubscribe|newsletter|webinar|special offer|sale ends|promo(tion)?|discount|airport transfers|hotel deal|earn (points|miles|bluchips)|credit card offer|introducing|unmatched convenience|now (flying|connecting)|new route|inaugural|premium economy on|fare sale|book now and|boarding pass|web check-?in is now open|check-?in (is )?(now )?open|online check-?in|регистрация на рейс|онлайн-регистраци|открыта регистрация|enregistrement en ligne|complete (your )?payment|feedback|survey|as per your (request|instruction)|your (cancellation|refund|change|rebooking) request|cancellation request (received|processed|confirmed)|refund (request|processed|initiated|status)|request for (cancellation|date change|reissue)|we have (cancelled|canceled) your booking as requested)/i;
const GST_HINTS = /(tax ?invoice|gst invoice|invoice for your (booking|travel)|e-invoice)/i;
const SUBJECT_HINTS = /(schedule (change|modification)|time change|flight (change|update|advisory|disruption|cancellation|delay)|\bdelays?\b|delayed|earlier departure|departure (is )?(now )?earlier|itinerary( change)?|revised (itinerary|schedule)|updated itinerary|new itinerary|resched|retimed|re-timed|cancel+ed|reaccommodat|re-accommodat|rebook|postponed|departure time|gate change|terminal change|e-?ticket|electronic ticket|ticket confirmation|booking (ref|reference|confirmation|confirmed)|reservation (confirmation|code)|record locator|confirmation number|travel (details|itinerary)|trip details|flight (details|booking|itinerary|confirmation)|booking (no|number|#)|order (no|number)|information about your (flight|booking)|change (in|of) (the )?(departure|arrival)|departure and arrival|your (trip|upcoming flight)|PNR|galileo queue|рейс|изменени|бронировани)/i;
function looksRelevant(email) {
  if (NEGATIVE_HINTS.test(email.subject || "")) return false;
  return AIRLINE_HINTS.test(email.from||"") || AIRLINE_HINTS.test(email.originalFrom||"") ||
         AIRLINE_SENDER.test(email.from||"") || AIRLINE_SENDER.test(email.originalFrom||"") ||
         AIRLINE_HINTS.test(email.body.slice(0,2000)) || SUBJECT_HINTS.test(email.subject||"");
}

// ---------- welcome mail for dashboard signups, from support@aviolink.in ----------
// Sent via Gmail API from support@aviolink.in (connected once at /connect-support)
let supportMailer = null;
// support@aviolink.in sends through the Gmail API (HTTPS). Token is stored once via /connect-support.
let SUPPORT_GMAIL = null; // { email, refresh }
async function loadSupportGmail() {
  const { data } = await sb.from("app_settings").select("key,value").in("key", ["support_gmail_email", "support_gmail_refresh"]).then((x) => x, () => ({}));
  const m = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
  SUPPORT_GMAIL = m.support_gmail_refresh ? { email: m.support_gmail_email, refresh: m.support_gmail_refresh } : null;
}
function getSupportMailer() {
  if (!SUPPORT_GMAIL) return null;
  const MailComposer = require("nodemailer/lib/mail-composer");
  return {
    async sendMail(opts) {
      const node = new MailComposer({ ...opts, from: opts.from || `"Aviolink" <${SUPPORT_GMAIL.email}>` }).compile();
      node.keepBcc = true; // Gmail API reads recipients from headers
      const raw = await node.build();
      const tok = await gmail.refreshAccess(SUPPORT_GMAIL.refresh);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      try {
        const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", signal: ctl.signal,
          headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }) });
        if (!r.ok) throw new Error(`gmail send ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } finally { clearTimeout(t); }
    },
  };
}
async function sendSignupWelcome(a, toEmail) {
  const m = getSupportMailer();
  if (!m) { console.log("[welcome] support mailbox not connected — skipped"); return false; }
  const name = a.contact_name || a.name;
  const end = a.trial_ends_at ? new Date(a.trial_ends_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#141B4D;line-height:1.55">
<h2 style="margin:0 0 6px">Welcome to Aviolink, ${esc(name)} ✈️</h2>
<p>Your free 30-day trial for <b>${esc(a.name)}</b> is active${end ? ` until <b>${end}</b>` : ""}.</p>
<p><b>What happens now</b></p>
<ol>
<li><b>Connect your Gmail</b> (if you haven't yet) — the mailbox where airline and supplier mails arrive. Read-only: Aviolink never sends or deletes mail.</li>
<li>Aviolink reads your past 12 months of tickets, then watches every new mail — schedule changes, delays and cancellations from any airline, in any language.</li>
<li>When a flight changes, you get a WhatsApp message and the alert waits in your dashboard. One tap sends it to your client — with <b>${esc(a.name)}</b>'s name and phone number in the message.</li>
</ol>
<p style="margin:22px 0"><a href="https://app.aviolink.in" style="background:#1E2761;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Open your dashboard</a></p>
<p><b>Tips</b><br>• Add your client's mobile on the alert (or on the ticket mail) so it can be sent in one tap.<br>• In Settings you can switch on auto-send for complete, confident alerts.</p>
<p>Questions? Just reply to this mail, or WhatsApp us at +91 92705 46474.</p>
<p>Team Aviolink<br><a href="https://aviolink.in">aviolink.in</a></p>
<p style="color:#6B7280;font-size:12px">Aviolink is a brand of Finch Travels, Pune.</p></div>`;
  await m.sendMail({ from: `"Aviolink" <${SUPPORT_GMAIL.email}>`, replyTo: SUPPORT_GMAIL.email, to: toEmail, bcc: SUPPORT_GMAIL.email,
    subject: `Welcome to Aviolink — your 30-day trial is active`, html });
  return true;
}

// ---------- welcome mails for new signups ----------
async function sendWelcomes() {
  const { data: fresh } = await sb.from("agencies")
    .select("id,name,slug,contact_name,notify_email,alerts_email")
    .eq("welcome_sent", false).not("notify_email", "is", null).limit(10);
  for (const a of fresh || []) {
    try {
      await mailer.sendMail({
        from: `"Aviolink" <${CFG.imapUser}>`,
        to: a.notify_email,
        subject: `Welcome to Aviolink, ${a.name} — your FlightAlert trial is active ✈️`,
        text:
`Hi ${a.contact_name || a.name},

Your 30-day FlightAlert trial is active. One step left (2 minutes, one time):

YOUR PRIVATE AVIOLINK ADDRESS:
${a.alerts_email}

SET AUTO-FORWARDING:
1. Open the mailbox where your airline/vendor mails arrive
2. Settings -> Forwarding -> Add forwarding address: ${a.alerts_email}
3. Confirm the verification mail, then select "Forward a copy of incoming mail" (keep copy in Inbox) -> Save

That's it. From the next airline mail onward, every flight change and cancellation lands in this inbox, fully formatted and WhatsApp-ready.

Tips:
- Also forward your recent unflown ticket mails once - alerts will then always carry your passenger's name.
- We read only airline/booking mails; everything else is discarded instantly.

Questions? Reply to this mail, write to support@aviolink.in or WhatsApp +91-9270546474.

Fly safe,
Team Aviolink
https://aviolink.in`,
      });
      await sb.from("agencies").update({ welcome_sent: true }).eq("id", a.id);
      await tg("sendMessage", { chat_id: CFG.tgChat, text: `👋 New signup welcomed: ${a.name} (${a.notify_email}) -> ${a.alerts_email}` });
      console.log(`[welcome] ${a.slug}`);
    } catch (e) { console.error(`[welcome-error] ${a.slug}: ${e.message}`); }
  }
}

// ---------- mail polling ----------
// One mail, from any source (IMAP forward inbox or an agency's own Gmail) -> same pipeline.
// ---------- self-test from real mails ----------
async function readMailForTest(raw) {
  const email = splitEmail(raw);
  const marked = await strikeAwareBody(raw); if (marked) email.body = marked;
  email.toDisplayName = null;
  const pdfText = await extractPdfTexts(raw); if (pdfText) email.body += "\n\n===PDF ATTACHMENT TEXT===\n" + pdfText;
  return parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined, email });
}
const SELFTEST = require("./selftest")({ sb, gmail, gmailAccess: (a) => gmailAccess(a), getAgencies: () => AGENCIES, readMail: readMailForTest, adminCard, esc });
async function selfTestAfterUpdate() {
  try {
    const { count, error } = await sb.from("test_mails").select("id", { count: "exact", head: true });
    if (error) { console.log("[selftest] table test_mails not created yet"); return; }
    if (!count) await SELFTEST.build("(first time, automatic)");
    else await SELFTEST.run("after update");
  } catch (e) { console.error("[selftest]", e.message); }
}

// ---------- AI outage: never lose a mail ----------
// If the AI reader errors (bad key, no credit, overload, network), the mail is NOT logged,
// so the next poll reads it again. Telegram is told once, and again when AI is back.
class AiDown extends Error {}
const AI_DOWN = { since: 0, reason: "", held: new Set(), warnedAt: 0 };
function aiFixHint(reason) {
  if (/401|authentication|x-api-key/i.test(reason)) return "Anthropic API key is invalid. Create a new key at console.anthropic.com → API Keys, then Railway → aviolink-worker → Variables → ANTHROPIC_API_KEY → paste → it restarts by itself.";
  if (/credit|billing|balance/i.test(reason)) return "Anthropic account has no credit. console.anthropic.com → Billing → add credit.";
  if (/429|529|overloaded|rate/i.test(reason)) return "Anthropic is busy — no action needed, retrying automatically.";
  return "Retrying automatically every minute.";
}
async function aiDown(reason, subject) {
  if (!AI_DOWN.since) AI_DOWN.since = Date.now();
  AI_DOWN.reason = reason; AI_DOWN.held.add(subject);
  console.error(`[ai-down] held "${subject}" — ${reason}`);
  if (Date.now() - AI_DOWN.warnedAt > 30 * 60000) {
    AI_DOWN.warnedAt = Date.now();
    await adminCard(`⛔ <b>AI READER NOT WORKING</b>\n${esc(reason.slice(0, 200))}\n\n📥 ${AI_DOWN.held.size} mail(s) held — <b>not lost</b>. They are read automatically the moment AI works again.\nLatest: ${esc(subject)}\n\n🔧 ${esc(aiFixHint(reason))}`).catch(() => {});
  }
}
function aiOk() {
  if (!AI_DOWN.since) return;
  const n = AI_DOWN.held.size, mins = Math.round((Date.now() - AI_DOWN.since) / 60000);
  AI_DOWN.since = 0; AI_DOWN.held.clear(); AI_DOWN.warnedAt = 0;
  requeueUnparsed().catch(() => {});
  adminCard(`✅ <b>AI READER WORKING AGAIN</b> after ${mins} min — ${n} held mail(s) are being read now.`).catch(() => {});
}
// Mails that ended as "unparsed" because AI failed earlier: put them back in the queue once.
async function requeueUnparsed() {
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const { data } = await sb.from("mail_log").select("id,subject").eq("verdict", "review").like("detail", "%src=unparsed%").gte("created_at", since);
  if (!data || !data.length) return;
  await sb.from("mail_log").delete().in("id", data.map((x) => x.id));
  await adminCard(`🔁 Re-reading ${data.length} mail(s) that failed earlier because AI was down:\n${data.slice(0, 8).map((x) => "• " + esc(x.subject)).join("\n")}`).catch(() => {});
}

async function processRaw(raw, mid, subject, forcedAgency = null, opts = {}) {
  try { return await processRawInner(raw, mid, subject, forcedAgency, opts); }
  catch (e) { if (e instanceof AiDown) { await aiDown(e.message, subject); return false; } throw e; }
}
async function processRawInner(raw, mid, subject, forcedAgency = null, opts = {}) {
    const rawHead = raw.slice(0, raw.indexOf("\n\n") === -1 ? raw.length : raw.indexOf("\n\n"));
    const email = splitEmail(raw);
    const marked = await strikeAwareBody(raw);
    if (marked) { email.body = marked; console.log("[body] crossed-out values marked as [OLD: …]"); }
    // Passenger hint: airlines often address "PAX NAME <agency@mail>" in To:
    email.toDisplayName = null; // To: display name is the agency contact (IndiGo), never the passenger
    const pdfText = await extractPdfTexts(raw);
    if (pdfText) {
      email.body += "\n\n===PDF ATTACHMENT TEXT===\n" + pdfText;
      console.log(`[pdf] extracted ${pdfText.length} chars from attachment(s)`);
    }
    const agency = forcedAgency || resolveAgency(rawHead, email) || DEFAULT_AGENCY;
    console.log(`[mail] (${agency?.slug}) ${subject}`);
    const gh = GMAIL_HEALTH.get(agency.id);
    if (!forcedAgency && agency.gmail_refresh_token && gmail.enabled() && gh && gh.okAt && Date.now() - gh.okAt < 600000) {
      // This agency's Gmail is read directly — a forwarded copy would only create duplicates.
      await logMail(agency.id, mid, subject, "skip", "agency reads Gmail directly");
      return;
    }

    if (opts.bookingsOnly) {
      // candidates were already chosen by sender/subject/AI — no keyword gate here
      const parsed = await parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined, email });
      if (parsed.source === "ai-error") throw new AiDown(parsed.aiError);
      if (parsed.kind === "TICKET" && parsed.pnr) {
        await upsertBooking(agency.id, parsed, extractClientMobile(email.body) ? { mobile: extractClientMobile(email.body) } : {});
        await logMail(agency.id, mid, subject, "backfill-ticket", parsed.pnr);
        console.log(`[backfill] ${agency.slug} ticket ${parsed.pnr} (${(parsed.passengers||[]).length} pax)`);
        return true;
      }
      await logMail(agency.id, mid, subject, "backfill-skip", parsed.kind || "");
      return false;
    }
    if (GST_HINTS.test(subject)) {
      await sb.from("gst_invoices").insert({ agency_id: agency.id, subject, invoice_ref: (subject.match(/[A-Z]{2}\d{6,}[A-Z0-9]*/)||[])[0]||null });
      await logMail(agency.id, mid, subject, "gst");
    } else if ((() => { const fromAir = AIRLINE_HINTS.test(email.from || "") || AIRLINE_SENDER.test(email.from || "");
                         return (NEGATIVE_HINTS.test(subject) && !fromAir) || !looksRelevant(email); })()
               && ((NEGATIVE_HINTS.test(subject) && !(AIRLINE_HINTS.test(email.from || "") || AIRLINE_SENDER.test(email.from || ""))) || !(await aiSaysTravel(email)))) {
      const sender = ((email.from || "").match(/@([^>\s]+)/) || [])[1] || "";
      await logMail(agency.id, mid, subject, "skip", `${NEGATIVE_HINTS.test(subject) ? "rule: promo/otp/check-in" : "rules+AI: not travel"} | ${sender}`);
      console.log(`[skip] ${subject}`);
    } else if (/GALILEO QUEUE CAPTURE/i.test(subject)) {
      const gq = require("../templates/galileo-queue");
      const all = fs.existsSync(path.join(__dirname, "..", "templates", "galileo-queue.js")) ? gq.parseAll(email, helpers) : [];
      const total = (email.body.match(/===== CAPTURE/g) || []).length;
      for (const one of all) {
        one.kind = "SCHEDULE_CHANGE"; one.confidence = 0.95; one.source = "template:galileo-queue-v1";
        if (one.phone && one.pnr) await upsertBooking(agency.id, one, { mobile: one.phone });
        await handleParsed(agency, one, subject, `${mid}#${one.pnr}`);
      }
      await logMail(agency.id, mid, subject, "queue-sweep", `${total} scanned, ${all.length} changes`);
      await adminCard(`🧾 <b>QUEUE SWEEP</b> · 🏢 ${esc(agency.name)}\nScanned ${total} · changes ${all.length}`);
    } else {
      const parsed = await parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined, email });
      if (parsed.source === "ai-error") throw new AiDown(parsed.aiError);
      if (CFG.anthropicKey) aiOk();
      parsed._bodyMobile = extractClientMobile(email.body);
      let linked = null;
      if (parsed.source === "ai-not-booking") linked = await findLinkedBooking(agency, email);
      if (parsed.source === "ai-not-booking" && linked) {
        // Second, focused read: the mail mentions one of our own bookings — does it change it?
        const ctx = `EXISTING BOOKING ON FILE — PNR ${linked.pnr}${linked.airline ? " (" + linked.airline + ")" : ""}, passengers: ${(linked.passengers || []).join(", ") || "n/a"}\n` +
          (linked.segments || []).map((s) => `  ${s.flight || ""} ${s.sector || ""} ${s.date || ""} ${s.dep || ""}-${s.arr || ""}`).join("\n") +
          `\n\nThe email below may contain a change to this booking hidden inside general travel information (new departure/arrival time, new flight number, new date, cancellation, terminal change with retime). Compare it carefully with the booking above. If anything changed, return a SCHEDULE_CHANGE with old (from the booking) and new values for every leg; use PNR ${linked.pnr}. If nothing in the booking changed, return {"kind":null}.\n\n=== EMAIL ===\n`;
        const p2 = await parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined, email: { ...email, body: ctx + email.body }, _templates: [] });
        if (p2.source === "ai-error") throw new AiDown(p2.aiError);
        p2._bodyMobile = parsed._bodyMobile;
        if (p2.kind === "SCHEDULE_CHANGE" && (p2.segments || []).length) {
          p2.pnr = p2.pnr || linked.pnr;
          console.log(`[linked] ${subject} -> change found for ${linked.pnr}`);
          await handleParsed(agency, p2, subject, mid);
        } else {
          await logMail(agency.id, mid, subject, "info", `linked to booking ${linked.pnr} — no change found`);
          console.log(`[info] ${subject} (linked ${linked.pnr}, no change)`);
        }
      } else if (parsed.source === "ai-not-booking") {
        await logMail(agency.id, mid, subject, "info", "AI: informational, no booking event");
        console.log(`[info] ${subject}`);
      } else if ((parsed.confidence || 0) === 0 && !SUBJECT_HINTS.test(subject)) {
        await logMail(agency.id, mid, subject, "skip", "airline mail, not booking-related");
      } else {
        await handleParsed(agency, parsed, subject, mid);
      }
    }
}

async function pollMailbox() {
  const client = new ImapFlow({ host: CFG.imapHost, port: CFG.imapPort, secure: true,
    auth: { user: CFG.imapUser, pass: CFG.imapPass }, logger: false });
  client.on("error", (e) => console.error("[imap-error]", e.message)); // never let a socket timeout crash the process
  await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error("IMAP connect timeout (Gmail connection limit? remove old deployments)")), 30000))]);
  const lock = await client.getMailboxLock("INBOX");
  try {
    // Process by time-window + own dedupe (mail_log), NOT by unread status —
    // a human opening a mail must never hide it from the system.
    const uids = await client.search({ since: new Date(Date.now() - 3 * 86400000) });
    // FAST PATH: headers only for everything, one DB lookup for known ids, then
    // download full content ONLY for new mails — newest first.
    const envelopes = [];
    for await (const m of client.fetch(uids || [], { envelope: true, uid: true })) {
      envelopes.push({ uid: m.uid, mid: m.envelope?.messageId || `uid-${m.uid}`, subject: m.envelope?.subject || "(no subject)" });
    }
    const { data: known } = await sb.from("mail_log").select("message_id")
      .gte("created_at", new Date(Date.now() - 4 * 86400000).toISOString());
    const knownIds = new Set((known || []).map((r) => r.message_id));
    const fresh = envelopes.filter((e) => !knownIds.has(e.mid)).sort((a, b) => b.uid - a.uid);
    console.log(`[poll] ${envelopes.length} mails in 3-day window, ${fresh.length} new`);

    for (const item of fresh) {
      const uid = item.uid;
      const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
      const mid = item.mid;
      if (!msg || !msg.source) { console.log(`[skip] could not fetch uid ${uid} (${item.subject})`); continue; }

      await processRaw(msg.source.toString("utf8"), mid, msg.envelope.subject || "(no subject)");
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

// ---------- Gmail (Sign in with Google) ----------
const accessCache = new Map(); // agencyId -> { token, exp }
const GMAIL_HEALTH = new Map(); // agencyId -> { okAt, seen, fresh, errAt, err }
async function gmailAccess(a) {
  const c = accessCache.get(a.id);
  if (c && c.exp > Date.now() + 60000) return c.token;
  const t = await gmail.refreshAccess(a.gmail_refresh_token);
  accessCache.set(a.id, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
  return t.access_token;
}
const gmailErrAt = new Map();
async function gmailFail(a, e) {
  console.error(`[gmail-error] ${a.slug}: ${e.message}`);
  { const h = GMAIL_HEALTH.get(a.id) || {}; h.errAt = Date.now(); h.err = e.message; GMAIL_HEALTH.set(a.id, h); }
  if (!/invalid_grant|unauthorized|401/i.test(e.message) && Date.now() - (gmailErrAt.get(a.id) || 0) > 3600000) {
    gmailErrAt.set(a.id, Date.now());
    await adminCard(`⚠️ <b>GMAIL READ ERROR</b> · 🏢 ${esc(a.name)}\n${esc(e.message).slice(0, 300)}`);
  }
  if (/invalid_grant|unauthorized|401/i.test(e.message)) {
    await sb.from("agencies").update({ gmail_error: e.message }).eq("id", a.id);
    await adminCard(`⚠️ <b>GMAIL DISCONNECTED</b> · 🏢 ${esc(a.name)} (${esc(a.gmail_email || "")})\n${esc(e.message)}\nAgency must reconnect from aviolink.in`);
  }
}
// Mails the agent SENT are never read (-from:me), spam IS read (airline mails land there), trash is not.
const GMAIL_LIVE_Q = "newer_than:3d -from:me -in:trash -in:chats";
async function pollGmail() {
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token && x.status !== "suspended")) {
    try {
      const access = await gmailAccess(a);
      const ids = await gmail.listIds(access, GMAIL_LIVE_Q, 300);
      const h = GMAIL_HEALTH.get(a.id) || {}; h.seen = ids.length; h.okAt = Date.now(); GMAIL_HEALTH.set(a.id, h);
      if (!ids.length) continue;
      const mids = ids.map((id) => `gm-${id}`);
      const { data: known } = await sb.from("mail_log").select("message_id").in("message_id", mids);
      const knownSet = new Set((known || []).map((r) => r.message_id));
      const fresh = ids.filter((id) => !knownSet.has(`gm-${id}`)).reverse(); // oldest first: ticket before its change notice
      if (fresh.length) console.log(`[gmail] ${a.slug}: ${ids.length} in window, ${fresh.length} new`);
      for (const id of fresh) {
        const raw = await gmail.getRaw(access, id);
        const subject = (raw.match(/^Subject:\s*(.*)$/im) || [])[1] || "(no subject)";
        await processRaw(raw, `gm-${id}`, splitEmail(raw).subject || subject, a);
      }
    } catch (e) { await gmailFail(a, e); }
  }
}
// First connect: read up to 12 months of ticket mails so every future alert has passenger names.
async function runBackfills() {
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token && x.gmail_backfill_status === "pending")) {
    await sb.from("agencies").update({ gmail_backfill_status: "running" }).eq("id", a.id);
    a.gmail_backfill_status = "running";
    let tickets = 0, fetched = 0;
    try {
      let access = await gmailAccess(a);
      // 1. every mail of the last 12 months (no subject words), headers only
      const ids = await gmail.listIds(access, "newer_than:365d -from:me -in:trash -in:chats", 60000);
      await adminCard(`📚 <b>BACKFILL STARTED</b> · 🏢 ${esc(a.name)}\n${ids.length} mails in the last 12 months — scanning sender + subject of every one`);
      const metas = [];
      for (let i = 0; i < ids.length; i += 10) {
        if (i % 2000 === 0) access = await gmailAccess(a);
        const part = await Promise.all(ids.slice(i, i + 10).map((id) => gmail.getMeta(access, id).catch(() => null)));
        metas.push(...part.filter(Boolean));
      }
      // 2. sure candidates by sender/subject; the rest judged by AI in batches of 50 headlines
      const cand = new Set(); const unsure = [];
      for (const m of metas) {
        const subj = decodeMimeWords(m.subject), from = decodeMimeWords(m.from);
        if (NEGATIVE_HINTS.test(subj)) continue;
        if (AIRLINE_HINTS.test(from) || AIRLINE_SENDER.test(from) || SUBJECT_HINTS.test(subj)) cand.add(m.id);
        else unsure.push({ id: m.id, line: `${from.slice(0, 60)} | ${subj.slice(0, 110)}` });
      }
      for (let i = 0; i < unsure.length; i += 50) {
        const batch = unsure.slice(i, i + 50);
        for (const idx of await aiPickTravel(batch.map((b) => b.line))) if (batch[idx]) cand.add(batch[idx].id);
      }
      // 3. download only candidates, oldest first, and save bookings
      const ordered = metas.filter((m) => cand.has(m.id)).sort((x, y) => x.ts - y.ts);
      const { data: known } = await sb.from("mail_log").select("message_id").neq("verdict", "backfill-skip").in("message_id", ordered.map((m) => `gm-${m.id}`).slice(0, 10000));
      const knownSet = new Set((known || []).map((r) => r.message_id));
      for (const m of ordered) {
        if (knownSet.has(`gm-${m.id}`)) continue;
        fetched++;
        if (fetched % 300 === 0) access = await gmailAccess(a);
        try {
          await sb.from("mail_log").delete().eq("message_id", `gm-${m.id}`).eq("verdict", "backfill-skip");
          const raw = await gmail.getRaw(access, m.id);
          if (await processRaw(raw, `gm-${m.id}`, splitEmail(raw).subject || "(no subject)", a, { bookingsOnly: true })) tickets++;
        } catch (e) { console.error("[backfill-item]", e.message); }
      }
      await sb.from("agencies").update({ gmail_backfill_status: "done" }).eq("id", a.id);
      a.gmail_backfill_status = "done";
      await adminCard(`📚 <b>BACKFILL DONE</b> · 🏢 ${esc(a.name)}\nScanned ${metas.length} mails · ${cand.size} travel-related · ${fetched} read · <b>${tickets} bookings saved</b>`);
    } catch (e) {
      await sb.from("agencies").update({ gmail_backfill_status: "error" }).eq("id", a.id);
      a.gmail_backfill_status = "error";
      await gmailFail(a, e);
    }
  }
}
// AI picks which headlines (sender | subject) are airline/OTA tickets, itineraries or flight changes. Returns indices.
async function aiPickTravel(lines) {
  if (!CFG.anthropicKey || !lines.length) return [];
  try {
    const headers = { "content-type": "application/json", "x-api-key": CFG.anthropicKey, "anthropic-version": "2023-06-01" };
    if (process.env.ANTHROPIC_WORKSPACE_ID) headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify({
      model: process.env.ANTHROPIC_CLASSIFY_MODEL || "claude-haiku-4-5-20251001", max_tokens: 300, temperature: 0,
      system: "Each numbered line is 'sender | subject' of an email received by a travel agency. Return ONLY a JSON array of the line numbers that are from an airline, GDS, consolidator, OTA or booking vendor AND concern a specific flight booking: e-ticket, booking/trip summary, itinerary, reservation, or a schedule change/delay/cancellation. Any language. Exclude marketing, OTPs, invoices, statements, check-in reminders. Example: [0,7,12]",
      messages: [{ role: "user", content: lines.map((l, i) => `${i}. ${l}`).join("\n") }] }) });
    if (!res.ok) { console.error("[ai-pick] HTTP", res.status); return []; }
    const d = await res.json();
    const t = d.content?.[0]?.text || "[]";
    return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)).filter((n) => Number.isInteger(n));
  } catch (e) { console.error("[ai-pick]", e.message); return []; }
}


const LEGAL_CSS = `<meta name=viewport content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;color:#1f2937;line-height:1.6}h1{color:#1E2761}h2{color:#1E2761;font-size:1.1rem;margin-top:26px}</style>`;
const PRIVACY_HTML = `<!doctype html><title>Privacy Policy — Aviolink</title>${LEGAL_CSS}
<h1>Aviolink FlightAlert — Privacy Policy</h1><p>Last updated: 17 October 2026. Operated by Finch Travels, Pune, India (support@aviolink.in, +91 9270546474).</p>
<h2>What we access</h2><p>When a travel agency connects its mailbox using "Sign in with Google", Aviolink receives read-only access (Gmail scope <code>gmail.readonly</code>). We never send, delete or modify mail, and we never see the account password.</p>
<h2>What we use it for</h2><p>Solely to detect airline and travel-vendor emails — e-tickets, itineraries, schedule changes, delays and cancellations — and turn them into flight-change alerts for that agency. Other emails are skipped automatically and their content is not stored.</p>
<h2>What we store</h2><p>From relevant airline mails only: PNR, airline, flight numbers, dates and timings, passenger names and contact number when present, and the alert text. We also store the message ID and subject to avoid processing a mail twice. Data is stored in an encrypted database (Supabase, India region) and is used only to provide the service to that agency.</p>
<h2>Sharing</h2><p>We do not sell or share Gmail data with anyone. Alerts are delivered only to the agency and, when the agency approves, to its own passenger on WhatsApp. Email content may be processed by an AI model provider (Anthropic) solely to extract flight details; it is not used to train models.</p>
<h2>Google API Services User Data Policy</h2><p>Aviolink's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Your control</h2><p>You can disconnect at any time at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>. On request to support@aviolink.in we delete all your stored data within 7 days.</p>`;
const TERMS_HTML = `<!doctype html><title>Terms of Service — Aviolink</title>${LEGAL_CSS}
<h1>Aviolink FlightAlert — Terms of Service</h1><p>Last updated: 17 October 2026. Provider: Finch Travels, Pune, India (support@aviolink.in).</p>
<h2>Service</h2><p>Aviolink reads airline and vendor emails from mailboxes you connect and alerts you about flight schedule changes and cancellations. Alerts are an aid; the airline's own communication remains authoritative and you remain responsible for verifying changes with the airline or GDS.</p>
<h2>Trial and fees</h2><p>New agencies get a 30-day free trial. Paid plans are billed as published on aviolink.in; you may cancel anytime.</p>
<h2>Acceptable use</h2><p>Connect only mailboxes you are authorised to use. Do not use the service for unlawful purposes.</p>
<h2>Liability</h2><p>The service is provided "as is". To the extent permitted by law, our liability is limited to the fees you paid in the last 3 months.</p>
<h2>Data</h2><p>See our <a href="/privacy">Privacy Policy</a>. Disconnecting your mailbox stops all access immediately.</p>`;



// Does this mail mention one of the agency's saved bookings (by PNR, or flight number + date)?
async function findLinkedBooking(agency, email) {
  try {
    const text = `${email.subject || ""}\n${email.body || ""}`.toUpperCase();
    const pnrs = [...new Set((text.match(/\b[A-Z0-9]{6}\b/g) || []).filter((t) => /[A-Z]/.test(t) && /\d/.test(t) || /^[A-Z]{6}$/.test(t)))].slice(0, 40);
    if (pnrs.length) {
      const { data } = await sb.from("bookings").select("pnr,airline,passengers,segments").eq("agency_id", agency.id).in("pnr", pnrs).limit(1);
      if (data && data.length) return data[0];
    }
    const flights = [...new Set((text.match(/\b([A-Z0-9]{2})\s?-?\s?(\d{2,4})\b/g) || []).map((f) => f.replace(/[^A-Z0-9]/g, "")))].slice(0, 20);
    if (flights.length) {
      const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      const { data } = await sb.from("bookings").select("pnr,airline,passengers,segments").eq("agency_id", agency.id).order("captured_at", { ascending: false }).limit(800);
      for (const b of data || []) {
        if ((b.segments || []).some((s) => s.date >= since && flights.includes(String(s.flight || "").toUpperCase().replace(/[^A-Z0-9]/g, "")))) return b;
      }
    }
  } catch (e) { console.error("[linked]", e.message); }
  return null;
}


// Compare stored itinerary with a newly received ticket. Returns change segments or null.
function diffItinerary(oldSegs, newSegs) {
  const nf = (f) => String(f || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nt = (t) => { const m = String(t || "").match(/(\d{1,2}):?(\d{2})/); return m ? m[1].padStart(2, "0") + ":" + m[2] : ""; };
  const ns = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!oldSegs.length || !newSegs.length) return null;
  const used = new Set(); const out = []; let changed = false;
  for (const n of newSegs) {
    let oi = oldSegs.findIndex((o, i) => !used.has(i) && ns(o.sector) && ns(o.sector) === ns(n.sector));
    if (oi < 0) oi = oldSegs.findIndex((o, i) => !used.has(i) && nf(o.flight) && nf(o.flight) === nf(n.flight));
    if (oi < 0) { out.push({ sector: n.sector, status: "CHANGED", old: null, new: n }); changed = true; continue; }
    used.add(oi);
    const o = oldSegs[oi];
    const diff = (a, b) => a && b && a !== b;
    const isChg = diff(nf(o.flight), nf(n.flight)) || diff(o.date, n.date) || diff(nt(o.dep), nt(n.dep)) || diff(nt(o.arr), nt(n.arr));
    if (isChg) changed = true;
    out.push({ sector: n.sector || o.sector, status: isChg ? "CHANGED" : "UNCHANGED", old: o, new: n });
  }
  oldSegs.forEach((o, i) => { if (!used.has(i)) { out.push({ sector: o.sector, status: "CANCELLED", old: o, new: null }); changed = true; } });
  if (!changed) return null;
  return { segments: out, cancelledOnly: out.every((s) => s.status === "CANCELLED" || s.status === "UNCHANGED") && out.some((s) => s.status === "CANCELLED") };
}


// /fetch PNR — every mail mentioning the PNR in the last 12 months, oldest first (ticket before change).
async function fetchByKey(a, key, chatId) {
  const access = await gmailAccess(a);
  const ids = (await gmail.listIds(access, `"${key}" newer_than:365d -from:me -in:trash`, 50)).reverse();
  await tg("sendMessage", { chat_id: chatId, text: `🔎 /fetch ${key}: ${ids.length} mail(s) found in ${a.gmail_email} — processing oldest first…` });
  if (ids.length) await sb.from("mail_log").delete().in("message_id", ids.map((id) => `gm-${id}`));
  for (const id of ids) {
    try { const raw = await gmail.getRaw(access, id); await processRaw(raw, `gm-${id}`, splitEmail(raw).subject || "(no subject)", a); }
    catch (e) { console.error("[fetch]", e.message); }
  }
  const { data: logs } = await sb.from("mail_log").select("subject,verdict,detail").in("message_id", ids.map((id) => `gm-${id}`));
  await tg("sendMessage", { chat_id: chatId, text: `✅ /fetch ${key} done:\n` + (logs || []).map((r) => `• ${String(r.subject).slice(0, 60)} → ${r.verdict}${r.detail ? " (" + String(r.detail).slice(0, 50) + ")" : ""}`).join("\n") });
}


// Airlines often show a change only by crossing out the old time (<s>, <del>, line-through).
// Plain-text conversion loses that, so mark struck text as [OLD: …] for the AI. Returns null if nothing is struck.
async function strikeAwareBody(raw) {
  if (!simpleParser) return null;
  try {
    const m = await simpleParser(raw, { skipImageLinks: true });
    const html = typeof m.html === "string" ? m.html : "";
    if (!/<(s|strike|del)\b|line-through/i.test(html)) return null;
    let h = html.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, t, inner) => ` [OLD: ${inner.replace(/<[^>]+>/g, " ").trim()}] `);
    h = h.replace(/<(span|div|td|p|font|b|strong)\b([^>]*line-through[^>]*)>([\s\S]*?)<\/\1>/gi, (_, t, attrs, inner) => ` [OLD: ${inner.replace(/<[^>]+>/g, " ").trim()}] `);
    return stripHtml(h).replace(/\n{3,}/g, "\n\n");
  } catch (e) { console.error("[body]", e.message); return null; }
}


const WATCH_WA = new Map(); // message id -> label, statuses reported to Telegram
async function handleWaWebhook(payload) {
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const s of v.statuses || []) {
      console.log(`[wa-status] ${s.recipient_id} ${s.status} ${s.id}`);
      if (WATCH_WA.has(s.id) && s.status !== "failed") await adminCard(`📶 WhatsApp ${esc(WATCH_WA.get(s.id))} → <b>${esc(s.status)}</b>`);
      if (s.status === "failed") {
        const e = (s.errors || [])[0] || {};
        await adminCard(`❌ <b>WHATSAPP NOT DELIVERED</b> to +${esc(s.recipient_id)}\nCode ${esc(e.code)} — ${esc(e.title || "")}\n${esc(e.error_data?.details || e.message || "")}`);
      }
      const rank = { sent: 1, delivered: 2, read: 3, failed: 9 };
      if (rank[s.status]) {
        const { data: al } = await sb.from("alerts").select("id,client_status").eq("wa_message_id", s.id).maybeSingle().then((x) => x, () => ({}));
        if (al && (rank[s.status] > (rank[al.client_status] || 0))) {
          const e = (s.errors || [])[0] || {};
          await sb.from("alerts").update({ client_status: s.status, ...(s.status === "failed" ? { wa_error: `${e.code || ""} ${e.title || ""} ${e.error_data?.details || ""}`.trim().slice(0, 300) } : {}) }).eq("id", al.id);
        }
      }
    }
    for (const m of v.messages || []) {
      const name = (v.contacts || [])[0]?.profile?.name || "";
      const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || `[${m.type}]`;
      if (/^\s*(stop|stop alerts?|unsubscribe|band|बंद|बंद करा|cancel alerts?)\s*[.!]?\s*$/i.test(text)) {
        const r = await sb.from("wa_optout").upsert({ phone: String(m.from), created_at: new Date().toISOString() }, { onConflict: "phone" });
        await sendWhatsApp(m.from, "You will no longer receive flight alerts from Aviolink on this number. Reply START to turn them back on.");
        await adminCard(`🛑 <b>CLIENT OPTED OUT</b> +${esc(m.from)}${name ? " (" + esc(name) + ")" : ""} replied STOP — no more alerts to this number.${r.error ? "\n⚠️ Not saved: " + esc(r.error.message) : ""}`);
        continue;
      }
      if (/^\s*(start|resume)\s*[.!]?\s*$/i.test(text)) {
        await sb.from("wa_optout").delete().eq("phone", String(m.from));
        await sendWhatsApp(m.from, "Flight alerts from Aviolink are on again for this number.");
        await adminCard(`✅ Client +${esc(m.from)} replied START — alerts on again.`);
        continue;
      }
      await adminCard(`💬 <b>CLIENT REPLY</b> from +${esc(m.from)}${name ? " (" + esc(name) + ")" : ""}\n${esc(String(text).slice(0, 500))}`);
    }
  }
}

// ---------- AI safety net: second opinion before any mail is skipped ----------
async function aiSaysTravel(email) {
  if (!CFG.anthropicKey) return false;
  try {
    const headers = { "content-type": "application/json", "x-api-key": CFG.anthropicKey, "anthropic-version": "2023-06-01" };
    if (process.env.ANTHROPIC_WORKSPACE_ID) headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify({
      model: process.env.ANTHROPIC_CLASSIFY_MODEL || "claude-haiku-4-5-20251001", max_tokens: 5, temperature: 0,
      system: "You classify emails received by a travel agency. Answer YES if the email is from an airline, GDS, travel consolidator, OTA or booking vendor AND is about a specific flight booking: an e-ticket / booking confirmation / itinerary, or a schedule change, time change, delay, cancellation, rebooking or re-accommodation of a flight. Answer NO for marketing, newsletters, OTPs, check-in reminders, boarding passes, invoices, payment receipts, refunds the agency requested, and anything not about a specific flight. Any language. Answer exactly YES or NO.",
      messages: [{ role: "user", content: `FROM: ${email.from}\nSUBJECT: ${email.subject}\n\n${(email.body || "").slice(0, 3000)}` }] }) });
    if (!res.ok) { const b = await res.text().catch(() => ""); throw new AiDown(`HTTP ${res.status}: ${b.slice(0, 200)}`); }
    const d = await res.json();
    aiOk();
    const yes = /^\s*yes/i.test(d.content?.[0]?.text || "");
    if (yes) console.log(`[ai-safety] rescued: ${email.subject}`);
    return yes;
  } catch (e) { if (e instanceof AiDown) throw e; throw new AiDown(e.message); }
}

// ---------- watchdog + nightly report ----------
const STARTED_AT = Date.now();
const watchdogWarned = new Map();
async function watchdog() {
  if (!gmail.enabled() || Date.now() - STARTED_AT < 15 * 60000) return;
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token)) {
    const h = GMAIL_HEALTH.get(a.id) || {};
    if (!h.okAt || Date.now() - h.okAt > 15 * 60000) {
      if (Date.now() - (watchdogWarned.get(a.id) || 0) > 3600000) {
        watchdogWarned.set(a.id, Date.now());
        await adminCard(`🚨 <b>GMAIL NOT READ FOR 15+ MIN</b> · 🏢 ${esc(a.name)} (${esc(a.gmail_email)})\nLast OK: ${h.okAt ? new Date(h.okAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "never since restart"}${h.err ? "\nError: " + esc(String(h.err).slice(0, 200)) : ""}`);
      }
    }
  }
}
let lastReportDay = "";
// WhatsApp health: warn the moment quality / limit / status / name changes
let WA_HEALTH = null, waHealthAt = 0, WA_TPL_STATE = null;
async function waQualityWatch(force = false) {
  if (!WA.enabled() || (!force && Date.now() - waHealthAt < 3600000)) return;
  waHealthAt = Date.now();
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA.phoneId}?fields=quality_rating,messaging_limit_tier,status,name_status`, { headers: { authorization: `Bearer ${WA.token}` } });
    const h = await r.json();
    if (!r.ok) return;
    const prev = WA_HEALTH; WA_HEALTH = h;
    // template approvals: tell the operator when any template changes status (approved / rejected / paused)
    try {
      const waba = process.env.WA_WABA_ID || "2690954148013574";
      const tl = await fetch(`https://graph.facebook.com/v20.0/${waba}/message_templates?fields=name,status&limit=50`, { headers: { authorization: `Bearer ${WA.token}` } }).then((x) => x.json());
      const now = Object.fromEntries((tl.data || []).map((t) => [t.name, t.status]));
      if (WA_TPL_STATE) {
        const ch = Object.keys(now).filter((k) => WA_TPL_STATE[k] !== now[k]);
        if (ch.length) await adminCard(`📋 <b>WhatsApp template update</b>\n${ch.map((k) => `${esc(k)}: ${esc(WA_TPL_STATE[k] || "new")} → <b>${esc(now[k])}</b>`).join("\n")}`);
      }
      WA_TPL_STATE = now;
    } catch (_) {}
    const bad = h.quality_rating && h.quality_rating !== "GREEN";
    const changed = prev && ["quality_rating", "messaging_limit_tier", "status", "name_status"].some((k) => prev[k] !== h[k]);
    if (bad || changed || force) {
      await adminCard(`${bad ? "⚠️ <b>WHATSAPP QUALITY " + esc(h.quality_rating) + "</b>\nClients are blocking or reporting our number. Check recent alerts for wrong or repeated messages before sending more." : "📱 <b>WhatsApp number status</b>"}\nQuality: ${esc(h.quality_rating)} · Limit: ${esc(h.messaging_limit_tier)} · Status: ${esc(h.status)} · Name: ${esc(h.name_status)}` +
        (changed ? `\n(was: ${esc(prev.quality_rating)} · ${esc(prev.messaging_limit_tier)} · ${esc(prev.status)} · ${esc(prev.name_status)})` : ""));
    }
  } catch (e) { console.error("[wa-health]", e.message); }
}

async function nightlyReport(force = false) {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const day = ist.toISOString().slice(0, 10);
  if (!force && (ist.getUTCHours() !== 21 || lastReportDay === day)) return;
  lastReportDay = day;
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data: rows } = await sb.from("mail_log").select("agency_id,subject,verdict,detail").gte("created_at", since).limit(5000);
  const R = rows || [];
  const n = (v) => R.filter((r) => r.verdict === v).length;
  const airlineSkips = R.filter((r) => r.verdict === "skip" && /rules\+AI/.test(r.detail || "") && (AIRLINE_SENDER.test("@" + String(r.detail).split("| ")[1]) || AIRLINE_HINTS.test(r.detail || "")));
  const { count: alerts } = await sb.from("alerts").select("id", { count: "exact", head: true }).gte("created_at", since);
  let msg = `📋 <b>DAILY REPORT</b> · last 24 h\nMails read: ${R.length}\n🎫 Tickets saved: ${n("ticket")}\n⚡ Change mails: ${n("change")} · alerts created: ${alerts ?? "?"}\n🔍 Unrecognised: ${n("review")} · duplicates silenced: ${n("dup")}\n⏭ Skipped: ${n("skip")}`;
  const infos = R.filter((r) => r.verdict === "info");
  if (infos.length) msg += `\n\nℹ️ <b>Informational airline mails (no alert needed):</b>\n` + infos.slice(0, 10).map((r) => "• " + esc(String(r.subject).slice(0, 80)) + (/linked/.test(r.detail || "") ? `\n   <i>${esc(r.detail)}</i>` : "")).join("\n");
  const reviews = R.filter((r) => r.verdict === "review");
  if (reviews.length) msg += `\n\n🔍 <b>Unrecognised (check if any is a real change):</b>\n` + reviews.slice(0, 10).map((r) => "• " + esc(String(r.subject).slice(0, 80)) + (r.detail ? `\n   <i>${esc(String(r.detail).slice(0, 90))}</i>` : "")).join("\n");
  msg += airlineSkips.length ? `\n\n⚠️ <b>Airline-sender mails skipped — please glance:</b>\n` + airlineSkips.slice(0, 15).map((r) => "• " + esc(String(r.subject).slice(0, 80))).join("\n") : "\n\n✅ No airline-sender mail was skipped.";
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token)) { const h = GMAIL_HEALTH.get(a.id) || {}; msg += `\n\n📬 ${esc(a.name)}: Gmail last read ${h.okAt ? Math.round((Date.now() - h.okAt) / 60000) + " min ago" : "never"}`; }
  await adminCard(msg);
}

// ---------- proof report: what Aviolink caught for an agency (sales evidence) ----------
async function proofReport(days = 30, slug = "") {
  const ag = slug ? AGENCIES.find((a) => a.slug === slug || a.name.toLowerCase().includes(slug.toLowerCase())) : null;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // exact counts (a plain select is capped at 1000 rows)
  const cnt = async (verdicts) => {
    let q = sb.from("mail_log").select("id", { count: "exact", head: true }).gte("created_at", since);
    if (verdicts) q = q.in("verdict", verdicts);
    if (ag) q = q.eq("agency_id", ag.id);
    const { count } = await q; return count || 0;
  };
  const [cAll, cTicket, cDup, cSkip] = await Promise.all([cnt(null), cnt(["ticket", "backfill-ticket"]), cnt(["dup"]), cnt(["skip"])]);
  let mq = sb.from("mail_log").select("verdict").gte("created_at", since).limit(1);
  let aq = sb.from("alerts").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  if (ag) { mq = mq.eq("agency_id", ag.id); aq = aq.eq("agency_id", ag.id); }
  const [{ data: ml }, { data: al }] = await Promise.all([mq, aq]);
  const M = ml || [], A = (al || []).filter((a) => a.status !== "skipped" && a.client_status !== "ignored"); // ignored alerts are not counted as proof
  const nv = (v) => M.filter((r) => r.verdict === v).length;
  const istHour = (t) => new Date(new Date(t).getTime() + 5.5 * 3600000).getUTCHours();
  const firstDep = (a) => {
    const segs = a.payload?.segments || [];
    const ts = segs.map((s) => { const v = s.old || s.new || s; return v.date ? Date.parse(`${v.date}T${(v.dep || "00:00")}:00+05:30`) : NaN; }).filter((x) => !isNaN(x));
    return ts.length ? Math.min(...ts) : NaN;
  };
  const urgent = A.filter((a) => { const d = firstDep(a) - new Date(a.created_at).getTime(); return d > 0 && d <= 48 * 3600000; });
  const night = A.filter((a) => { const h = istHour(a.created_at); return h >= 21 || h < 8; });
  const cancels = A.filter((a) => (a.change_type || a.payload?.changeType) === "CANCELLATION");
  const pnrs = new Set(A.map((a) => a.pnr).filter(Boolean));
  const paxBy = new Map(); // each passenger once per booking, however often it changed
  for (const a of A) if (a.pnr) paxBy.set(a.pnr, Math.max(paxBy.get(a.pnr) || 0, (a.payload?.passengers || []).length));
  const pax = [...paxBy.values()].reduce((s, n) => s + n, 0);
  const sent = A.filter((a) => ["sent", "delivered", "read"].includes(a.client_status) || ["sent", "delivered"].includes(a.status));
  const read = A.filter((a) => a.client_status === "read").length;
  const byAir = {};
  for (const a of A) { const k = a.payload?.airline || "?"; byAir[k] = (byAir[k] || 0) + 1; }
  const topAir = Object.entries(byAir).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${esc(airlineName(k) || k)} ${v}`).join(" · ");
  const ex = urgent.slice(0, 3).map((a) => {
    const h = Math.round((firstDep(a) - new Date(a.created_at).getTime()) / 3600000);
    return `• ${esc(a.pnr || "")} · ${esc(airlineName(a.payload?.airline) || a.payload?.airline || "")} · ${(a.change_type || "") === "CANCELLATION" ? "cancelled" : "re-timed"} · caught ${h} h before departure`;
  }).join("\n");
  return `📈 <b>AVIOLINK PROOF REPORT</b> · last ${days} days${ag ? " · " + esc(ag.name) : " · all agencies"}\n\n` +
    `📨 Mails read automatically: <b>${cAll}</b>\n🎫 Tickets saved: ${cTicket}\n\n` +
    `⚡ <b>Flight changes caught: ${A.length}</b> (${pnrs.size} bookings, ${pax} passengers)\n` +
    `   ❌ Cancellations: ${cancels.length}\n   🕐 Re-timings / other: ${A.length - cancels.length}\n` +
    `   🚨 Within 48 h of departure: <b>${urgent.length}</b>\n   🌙 Arrived 9 PM–8 AM: <b>${night.length}</b>\n\n` +
    `📲 Sent to clients on WhatsApp: ${sent.length}${read ? ` (${read} read)` : ""}\n` +
    `🔇 Duplicate airline mails silenced: ${cDup}\n⏭ Non-travel mails ignored: ${cSkip}\n` +
    (topAir ? `\n✈️ By airline: ${topAir}` : "") + (ex ? `\n\n<b>Close calls:</b>\n${ex}` : "") +
    `\n\n<i>Every one of these would otherwise depend on someone noticing one mail among ${cAll}.</i>`;
}

// ---------- trial end: reminders to the agency (email) and the operator (Telegram) ----------
let trialCheckDay = "";
async function trialReminders() {
  const ist = new Date(Date.now() + 5.5 * 3600000), day = ist.toISOString().slice(0, 10);
  if (trialCheckDay === day || ist.getUTCHours() < 10) return; // once a day, from 10 AM IST
  trialCheckDay = day;
  const { data, error } = await sb.from("agencies").select("id,name,slug,plan,trial_ends_at,notify_email,contact_name,owner_phone,whatsapp,status,trial_reminder").eq("plan", "trial");
  if (error) return;
  for (const a of data || []) {
    if (!a.trial_ends_at || a.status === "suspended" || a.id === DEFAULT_AGENCY?.id) continue;
    const left = Math.ceil((new Date(a.trial_ends_at) - Date.now()) / 86400000);
    const step = left <= 0 ? "ended" : left <= 1 ? "1day" : left <= 7 ? "7days" : null;
    if (!step || a.trial_reminder === step) continue;
    if (step === "7days" && a.trial_reminder === "1day") continue;
    const { count } = await sb.from("alerts").select("id", { count: "exact", head: true }).eq("agency_id", a.id);
    const phone = a.whatsapp || a.owner_phone || "-";
    await adminCard(`${step === "ended" ? "⌛ <b>TRIAL ENDED</b>" : `⏳ <b>TRIAL ENDS IN ${left} DAY${left === 1 ? "" : "S"}</b>`} · 🏢 ${esc(a.name)}\n👤 ${esc(a.contact_name || "-")} · 📞 ${esc(phone)} · 📧 ${esc(a.notify_email || "-")}\n⚡ ${count || 0} flight change(s) caught for them so far.\n${step === "ended" ? "Alerts are paused for them. Admin view → More… → Mark as paid / Extend trial." : "Good moment to call them."}`).catch(() => {});
    const m = getSupportMailer();
    if (m && a.notify_email) {
      const end = new Date(a.trial_ends_at).toLocaleDateString("en-IN", { day: "numeric", month: "long" });
      const subj = step === "ended" ? "Your Aviolink trial has ended" : `Your Aviolink trial ends ${left === 1 ? "tomorrow" : "on " + end}`;
      const lead = step === "ended" ? "Your free trial has ended, so new flight-change alerts are paused." : `Your free trial ends ${left === 1 ? "tomorrow" : "on <b>" + end + "</b>"}.`;
      await m.sendMail({ from: `"Aviolink" <${SUPPORT_GMAIL.email}>`, to: a.notify_email, bcc: SUPPORT_GMAIL.email, subject: subj,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#141B4D;line-height:1.55"><p>Hi ${esc(a.contact_name || a.name)},</p><p>${lead}</p><p>So far Aviolink has caught <b>${count || 0} flight change${count === 1 ? "" : "s"}</b> for ${esc(a.name)}.</p><p>To ${step === "ended" ? "switch alerts back on" : "keep receiving alerts without a break"}, click <b>Subscribe</b> in your dashboard (UPI AutoPay or card, renews monthly), or reply to this mail / WhatsApp us at <b>+91 92705 46474</b>.</p><p style="margin:22px 0"><a href="https://app.aviolink.in" style="background:#1E2761;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Open your dashboard</a></p><p>Team Aviolink · <a href="https://aviolink.in">aviolink.in</a></p></div>` }).catch((e) => console.error("[trial-mail]", e.message));
    }
    await sb.from("agencies").update({ trial_reminder: step }).eq("id", a.id);
  }
}

// ---------- weekly marketing: Monday 10 AM IST, ready-to-share posts built from real numbers ----------
const TIPS = [
  "Put your own mobile and email in the PNR? Then airline change messages reach only you — make sure someone reads every one of them.",
  "A re-timing of 20 minutes can break a connection. Always check the onward flight when the first leg moves.",
  "When an airline cancels, the passenger is entitled to a full refund if no acceptable alternative is offered — inform the client before they reach the airport.",
  "Night-time changes are the ones most often missed. 1 in 5 changes we see arrive between 9 PM and 8 AM.",
  "Same PNR, changed twice? Clients should hear about every change, not only the first one.",
  "Group bookings: one schedule change affects every passenger — inform the group leader and each traveller.",
  "Check-in opens 24–48 h before departure. A change caught before check-in saves a missed flight at the gate.",
  "Keep your client's WhatsApp number on the booking — it turns a 20-minute phone round into a 1-tap update.",
];
let lastMarketingWeek = "";
async function weeklyMarketing(force = false) {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const week = `${ist.getUTCFullYear()}-${Math.floor((ist - new Date(Date.UTC(ist.getUTCFullYear(), 0, 1))) / 6048e5)}`;
  if (!force && (ist.getUTCDay() !== 1 || ist.getUTCHours() !== 10 || lastMarketingWeek === week)) return;
  lastMarketingWeek = week;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: al } = await sb.from("alerts").select("change_type,created_at,payload,status,client_status").gte("created_at", since).limit(5000);
  const A = (al || []).filter((a) => a.status !== "skipped" && a.client_status !== "ignored");
  const { count: mails } = await sb.from("mail_log").select("id", { count: "exact", head: true }).gte("created_at", since);
  const cancels = A.filter((a) => (a.change_type || a.payload?.changeType) === "CANCELLATION").length;
  const night = A.filter((a) => { const h = new Date(new Date(a.created_at).getTime() + 5.5 * 3600000).getUTCHours(); return h >= 21 || h < 8; }).length;
  const byAir = {}; for (const a of A) { const k = a.payload?.airline; if (k) byAir[k] = (byAir[k] || 0) + 1; }
  const top = Object.entries(byAir).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${airlineName(k) || k}: ${v}`).join(", ");
  const tip = TIPS[Math.floor(Date.now() / 6048e5) % TIPS.length];
  const wa = `✈️ *Airline changes this week*\n\nIn the last 7 days Aviolink caught *${A.length} flight changes* in travel agency mailboxes${cancels ? ` — including *${cancels} cancellation${cancels === 1 ? "" : "s"}*` : ""}.\n${top ? `Most changes: ${top}.\n` : ""}${night ? `${night} of them arrived between 9 PM and 8 AM.\n` : ""}\n💡 *Tip:* ${tip}\n\nAviolink reads your airline mails and sends your clients a WhatsApp alert in your agency's name. Free 30-day trial: aviolink.in`;
  const li = `Airline schedule changes this week: ${A.length} caught${cancels ? `, ${cancels} of them cancellation${cancels === 1 ? "" : "s"}` : ""}${night ? `, ${night} arriving overnight` : ""}.\n\n${top ? `Most active: ${top}.\n\n` : ""}${tip}\n\nAviolink reads ${(mails || 0) >= 1000 ? `thousands of ` : ""}airline and supplier mails for travel agencies and turns every change into a clear WhatsApp alert for the client — in the agency's own name.\n\nFree 30-day trial → aviolink.in\n\n#TravelAgents #Airlines #TravelTech #IndiGo #FlightChanges`;
  await adminCard(`📣 <b>WEEKLY MARKETING POSTS</b> — copy, check, share\n\n<b>1) WhatsApp groups / Status:</b>\n<pre>${esc(wa)}</pre>\n<b>2) LinkedIn / Facebook:</b>\n<pre>${esc(li)}</pre>\nNumbers are from the last 7 days, no agency or client names included.`);
}

// ---------- HTTP: OAuth callback + health ----------
let DASH = null, BILLING = null;
function startHttp() {
  BILLING = require("./billing")({ sb, adminCard, esc, loadAgencies });
  DASH = require("./dashboard")({ billing: BILLING, sb, gmail, getAgencies: () => AGENCIES, defaultAgencyId: () => DEFAULT_AGENCY?.id, sendSignupWelcome, loadAgencies, GMAIL_HEALTH, sendAlertToClient, adminCard, esc, waEnabled: () => WA.enabled() });
  const port = Number(process.env.PORT || 8080);
  const site = (process.env.SITE_URL || "https://aviolink.in").replace(/\/$/, "");
  http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/privacy" || u.pathname === "/terms") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(u.pathname === "/privacy" ? PRIVACY_HTML : TERMS_HTML);
      }
      // WhatsApp webhook: delivery statuses (sent/delivered/read/failed) + client replies
      if (u.pathname === "/webhook/razorpay" && req.method === "POST") {
        let raw = ""; for await (const c of req) raw += c;
        const r = await BILLING.webhook(raw, req.headers["x-razorpay-signature"]).catch((e) => ({ ok: false, err: e.message }));
        if (!r.ok) console.error("[razorpay]", r.err);
        res.writeHead(r.ok ? 200 : 400); res.end(r.ok ? "ok" : "no"); return;
      }
      if (u.pathname === "/webhook/whatsapp") {
        if (req.method === "GET") {
          const ok = u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === (process.env.WA_VERIFY_TOKEN || "aviolink-wa-verify");
          res.writeHead(ok ? 200 : 403, { "content-type": "text/plain" }); return res.end(ok ? (u.searchParams.get("hub.challenge") || "") : "forbidden");
        }
        let body = ""; for await (const chunk of req) body += chunk;
        res.writeHead(200); res.end("ok");
        try { await handleWaWebhook(JSON.parse(body || "{}")); } catch (e) { console.error("[wa-webhook]", e.message); }
        return;
      }
      if (await DASH.handle(req, res, u)) return;
      if (u.pathname === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
      const page = (title, msg) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Aviolink</title><body style="font-family:system-ui;background:#eef2fb;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;padding:32px;border-radius:14px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(30,39,97,.15)"><h2 style="color:#1E2761">${title}</h2><p style="color:#374151;line-height:1.5">${msg}</p></div>`); };
      // Simple link: /connect/<agency-slug>  e.g. /connect/finch-travels
      const cm = u.pathname.match(/^\/connect\/([a-z0-9-]+)$/);
      if (cm) {
        if (!gmail.enabled()) return page("Not ready", "Google sign-in is not configured yet.");
        const a = AGENCIES.find((x) => x.slug === cm[1]);
        if (a && a.gmail_refresh_token) return page("Already connected", "This agency's Gmail is already connected. To change it, log in at app.aviolink.in → Gmail → Reconnect.");
        if (!a) return page("Unknown agency", `No agency called “${esc(cm[1])}”. Pick one:<br><br>${AGENCIES.map((x) => `<a href="/connect/${x.slug}">${esc(x.name)}</a>${x.gmail_email ? " ✅ " + esc(x.gmail_email) : ""}`).join("<br>")}`);
        res.writeHead(302, { location: gmail.authUrl(a.id) }); return res.end();
      }
      if (u.pathname === "/connect-support") {
        res.writeHead(302, { location: gmail.sendAuthUrl(gmail.signState("support"), "support@aviolink.in") }); return res.end();
      }
      if (u.pathname === "/auth/google") {
        const agencyId = u.searchParams.get("agency") || "";
        if (!gmail.enabled()) { res.writeHead(503); return res.end("Google sign-in not configured"); }
        if (!/^[0-9a-f-]{36}$/i.test(agencyId)) { res.writeHead(400); return res.end("missing agency"); }
        res.writeHead(302, { location: gmail.authUrl(agencyId) }); return res.end();
      }
      if (u.pathname === "/auth/google/callback") {
        const agencyId = gmail.verifyState(u.searchParams.get("state"));
        const code = u.searchParams.get("code");
        if (!agencyId || !code) {
          const why = u.searchParams.get("error") || (!u.searchParams.get("state") ? "no state (page opened directly?)" : !agencyId ? "state check failed" : "no code");
          console.log(`[oauth] callback failed: ${why} | query=${u.search.slice(0, 200)}`);
          await adminCard(`⚠️ <b>GMAIL CONNECT FAILED</b>
Reason: ${esc(why)}`);
          return page("Not connected", `Google sign-in did not complete.<br><b>Reason:</b> ${esc(why)}<br><br>Please open the connect link again.`);
        }
        const tok = await gmail.exchangeCode(code);
        if (!tok.refresh_token) return page("Not connected", "Google did not give offline access. Please open the link again and click Allow.");
        if (agencyId === "support") {
          let email = ""; try { email = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString()).email || ""; } catch (_) {}
          await sb.from("app_settings").upsert([{ key: "support_gmail_email", value: email }, { key: "support_gmail_refresh", value: tok.refresh_token }], { onConflict: "key" });
          await loadSupportGmail();
          await adminCard(`✉️ <b>SUPPORT MAILBOX CONNECTED</b> — ${esc(email)}\nWelcome and trial mails will go out from it.`);
          return page("✅ Support mailbox connected", `<b>${esc(email)}</b> will now send Aviolink's welcome and reminder mails. You can close this page.`);
        }
        const prof = await gmail.profile(tok.access_token);
        const { error } = await sb.from("agencies").update({
          gmail_email: prof.emailAddress, gmail_refresh_token: tok.refresh_token,
          gmail_connected_at: new Date().toISOString(), gmail_backfill_status: "pending", gmail_error: null,
        }).eq("id", agencyId);
        if (error) throw error;
        accessCache.delete(agencyId);
        await loadAgencies();
        const a = AGENCIES.find((x) => x.id === agencyId);
        await adminCard(`🔗 <b>GMAIL CONNECTED</b> · 🏢 ${esc(a?.name || agencyId)}\n${esc(prof.emailAddress)} — backfill starting`);
        const dash = /aviolink\.in$/.test(gmail.PUBLIC_URL.replace(/^https?:\/\//, "").split("/")[0]) ? "https://app.aviolink.in" : `${gmail.PUBLIC_URL}/app`;
        return page("✅ Gmail connected", `<b>${esc(prof.emailAddress)}</b> is now linked to <b>${esc(a?.name || "your agency")}</b>.<br><br>Aviolink is reading your past 12 months of ticket mails, then watches every new schedule change and cancellation.<br><br><a href="${dash}" style="display:inline-block;background:#1E2761;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open your dashboard</a>`);
      }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      console.error("[http-error]", e.message);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<h3>Connection failed — please open the link again.</h3>");
    }
  }).listen(port, () => console.log(`[http] listening on ${port}${gmail.enabled() ? ` — Google sign-in ON at ${gmail.PUBLIC_URL}` : " — Google sign-in OFF (needs Generate Domain + GOOGLE_CLIENT_ID/SECRET)"}`));
}

// ---------- main ----------
(async () => {
  await require("./migrate")().catch((e) => adminCard(`⚠️ Database update failed: ${esc(e.message)}`).catch(() => {}));
  await loadAgencies();
  requeueUnparsed().catch((e) => console.error("[requeue]", e.message));
  loadSupportGmail().catch(() => {});
  setTimeout(selfTestAfterUpdate, 10 * 60000); // every deploy restarts the worker → test the new code on real mails
  try {
    const { data: stuck } = await sb.from("agencies").update({ gmail_backfill_status: "pending" }).eq("gmail_backfill_status", "running").select("id");
    if (stuck && stuck.length) { console.log(`[backfill] ${stuck.length} interrupted backfill(s) will resume`); await loadAgencies(); }
  } catch (_) {}
  try {
    // one-time repair: mails judged with an undecoded (=?UTF-8?...?=) subject get a fresh look
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const { data: bad } = await sb.from("mail_log").delete().gte("created_at", since).like("subject", "%=?%").in("verdict", ["skip", "review"]).select("id");
    if (bad && bad.length) { console.log(`[repair] ${bad.length} encoded-subject mail(s) will be re-read`); await adminCard(`🛠 Re-reading ${bad.length} mail(s) from the last 3 days that were skipped because their subject was encoded.`); }
  } catch (e) { console.error("[repair]", e.message); }
  if (!DEFAULT_AGENCY) { console.error("No agencies in DB — run the schema SQL."); process.exit(1); }
  await tg("sendMessage", { chat_id: CFG.tgChat, text: `☁️ FlightAlert worker v3 — ${AGENCIES.length} agencies, ${AGENCIES.filter((a)=>a.gmail_refresh_token).length} Gmail-connected, watching ${CFG.imapUser}` });
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`poll timed out after ${ms / 1000}s`)), ms))]);
  let polling = false;
  const mailLoop = async () => {
    if (polling) { console.log("[poll] previous cycle still running, skipping"); setTimeout(mailLoop, CFG.pollSeconds * 1000); return; }
    polling = true;
    try { await withTimeout(pollMailbox(), 300000); } catch (e) { console.error("[mail-error]", e.message); }
    if (gmail.enabled()) { try { await withTimeout(pollGmail(), 300000); } catch (e) { console.error("[gmail-loop]", e.message); } }
    polling = false;
    setTimeout(mailLoop, CFG.pollSeconds * 1000);
  };
  const tgLoop = async () => { try { await pollTelegram(); } catch (e) { console.error("[tg-error]", e.message); } setTimeout(tgLoop, 3000); };
  const agLoop = async () => { try { await loadAgencies(); await sendWelcomes(); } catch (_) {} setTimeout(agLoop, 120000); };
  const wdLoop = async () => { try { await watchdog(); await nightlyReport(); await waQualityWatch(); await weeklyMarketing(); await trialReminders(); } catch (e) { console.error("[watchdog]", e.message); } setTimeout(wdLoop, 60000); };
  setTimeout(wdLoop, 60000);
  const bfLoop = async () => { if (gmail.enabled()) { try { await runBackfills(); } catch (e) { console.error("[backfill-loop]", e.message); } } setTimeout(bfLoop, 60000); };
  sendWelcomes().catch(()=>{});
  startHttp();
  mailLoop(); tgLoop(); setTimeout(agLoop, 120000); setTimeout(bfLoop, 15000);
})();
