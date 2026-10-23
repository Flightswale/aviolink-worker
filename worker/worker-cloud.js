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
const { parseEmail, splitEmail, helpers } = require("../parser");
const { compile } = require("../compiler");
const http = require("http");
const gmail = require("../gmail");
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (_) { console.log("[pdf] pdf-parse not installed — attachment reading off"); }

// Extract text from PDF attachments inside the raw MIME (base64 application/pdf parts).
async function extractPdfTexts(raw) {
  if (!pdfParse) return "";
  const out = [];
  const re = /Content-Type:\s*application\/pdf[\s\S]{0,400}?Content-Transfer-Encoding:\s*base64\s*\n\n?([A-Za-z0-9+/=\s]{500,})/gi;
  let m;
  while ((m = re.exec(raw)) !== null && out.length < 5) {
    try {
      const buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
      const d = await pdfParse(buf);
      if (d.text && d.text.trim().length > 50) out.push(d.text);
    } catch (e) { console.log("[pdf] attachment parse failed:", e.message); }
  }
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
  if (!a) return false;
  if (a.plan !== "trial") return true; // paid/starter/etc.
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
    if (txt.startsWith("/retest")) {
      const pnr = (txt.split(/\s+/)[1] || "").toUpperCase();
      if (!/^[A-Z0-9]{5,7}$/.test(pnr)) { await tg("sendMessage", { chat_id: u.message.chat.id, text: "Usage: /retest PNR" }); continue; }
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
        // Deliver to client WhatsApp (booking mobile) or agency owner as fallback.
        try {
          const { data: al } = await sb.from("alerts").select("agency_id,pnr,compiled_whatsapp").eq("id", alertId).single();
          if (al) {
            let target = null, who = "";
            if (al.pnr) {
              const { data: bk } = await sb.from("bookings").select("mobile").eq("agency_id", al.agency_id).eq("pnr", al.pnr).maybeSingle();
              if (bk?.mobile) { target = bk.mobile; who = "client"; }
            }
            if (!target) {
              const ag = AGENCIES.find((a) => a.id === al.agency_id);
              if (ag?.whatsapp || ag?.owner_phone) { target = ag.whatsapp || ag.owner_phone; who = "agency owner"; }
            }
            if (target) {
              const r = await sendWhatsApp(target, al.compiled_whatsapp);
              if (r.ok) {
                await sb.from("alerts").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", alertId);
                await tg("sendMessage", { chat_id: u.callback_query.message.chat.id, text: `📲 WhatsApp delivered to ${who} (${target})` });
              } else {
                await tg("sendMessage", { chat_id: u.callback_query.message.chat.id, text: `⚠️ WhatsApp failed (${r.err}).\nTest-mode tip: the recipient must be a verified test number AND must message the test number once ("hi") to open the 24h window.` });
              }
            } else {
              await tg("sendMessage", { chat_id: u.callback_query.message.chat.id, text: `ℹ️ No mobile on file for this PNR — approved only. Add via ticket capture or bookings table.` });
            }
          }
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
async function handleParsed(agency, parsed, subject, messageId) {
  const conf = Math.round((parsed.confidence || 0) * 100);
  const tag = `🏢 ${esc(agency.name)}`;

  if (parsed.kind === "TICKET" && parsed.pnr) {
    const mobile = extractClientMobile((parsed.raw && parsed.raw.subject ? "" : "") + JSON.stringify(parsed) ) || null;
    const bodyMobile = parsed._bodyMobile || null;
    await upsertBooking(agency.id, parsed, bodyMobile ? { mobile: bodyMobile } : {});
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
        const flightMatch = !al.pnr && (p.segments || []).some((s) =>
          flights.has(s.old?.flight) || flights.has(s.new?.flight) || flights.has(s.flight));
        if ((pnrMatch && paxMissing) || flightMatch) {
          p.passengers = parsed.passengers || [];
          p.pnr = p.pnr || parsed.pnr;
          enrichOldTiming(p, parsed.segments);
          const msg2 = compile(p, { name: agency.name, phone: agency.owner_phone || agency.whatsapp || "" });
          await sb.from("alerts").update({ pnr: p.pnr, payload: p, compiled_whatsapp: msg2.whatsapp, status: "pending" }).eq("id", al.id);
          if (trialActive(agency)) await deliverToAgency(agency, p, msg2, al.id);
          await adminCard(`✅ <b>ALERT COMPLETED</b> with passenger details · ${tag}\n\n<pre>${esc(msg2.whatsapp)}</pre>`, al.id);
          console.log(`[complete] alert ${al.id} filled from ticket ${parsed.pnr}`);
        }
      }
    } catch (e) { console.error("[complete-error]", e.message); }
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

  await logMail(agency.id, messageId, subject, "review");
  await adminCard(`🔍 <b>UNRECOGNISED</b> · ${tag}\nSubject: ${esc(subject)}`);
  console.log(`[review] ${agency.slug} ${subject}`);
}

// ---------- relevance gates ----------
const AIRLINE_HINTS = /(pobeda|aeroflot|s7\.ru|utair|uralairlines|azurair|rossiya|onetwotrip|aviasales|kiwi\.com|trip\.com|expedia|edreams|opodo|gotogate|mytrip|wizzair|pegasus|ajet|sunexpress|airasia|vietjet|scoot|jetstar|cebupacific|philippineairlines|garuda|biman|usbangla|nepalairlines|buddhaair|drukair|bhutanairlines|maldivian|flyadeal|jazeeraairways|salamair|egyptair|royaljordanian|mea\.com|ethiopianairlines|kenya-airways|rwandair|airmauritius|aircanada|westjet|alaskaair|jetblue|southwest|aeromexico|latam|avianca|copaair|iberia|vueling|ryanair|easyjet|flytap|ita-airways|swiss\.com|austrian|brusselsairlines|finnair|flysas|lot\.com|aegeanair|aerlingus|condor|eurowings|chinasouthern|ceair|airchina|hainanairlines|ana\.co\.jp|jal\.co|koreanair|flyasiana|evaair|qantas|virginaustralia|airnewzealand|airindia|goindigo|spicejet|akasaair|airindiaexpress|flydubai|emirates|qatarairways|etihad|singaporeair|turkishairlines|lufthansa|britishairways|riyadhair|saudia|flynas|airarabia|vistara|gulfair|omanair|kuwaitairways|srilankan|malaysiaairlines|thaiairways|cathaypacific|klm|airfrance|virginatlantic|americanairlines|united|delta|travelport|galileo|tripjack|tbo|travclan|mystifly|akbartravels|cleartrip|makemytrip|yatra|easemytrip|ixigo)/i;
// Generic airline-sender pattern: alerts@/notifications@/noreply@ *air*/airlines/airways domains
const AIRLINE_SENDER = /@(?:[a-z0-9.-]*\b(?:air|airline|airways|aviation|fly)[a-z0-9-]*)\.[a-z]{2,}/i;
const NEGATIVE_HINTS = /(login otp|otp email|one[- ]?time password|verification code|verify your|password reset|security alert|two[- ]?step|2-step|unsubscribe|newsletter|webinar|special offer|sale ends|promo(tion)?|discount|airport transfers|hotel deal|earn (points|miles|bluchips)|credit card offer|introducing|unmatched convenience|now (flying|connecting)|new route|inaugural|premium economy on|fare sale|book now and|boarding pass|web check-?in is now open|complete (your )?payment|feedback|survey|as per your (request|instruction)|your (cancellation|refund|change|rebooking) request|cancellation request (received|processed|confirmed)|refund (request|processed|initiated|status)|request for (cancellation|date change|reissue)|we have (cancelled|canceled) your booking as requested)/i;
const GST_HINTS = /(tax ?invoice|gst invoice|invoice for your (booking|travel)|e-invoice)/i;
const SUBJECT_HINTS = /(schedule (change|modification)|time change|flight (change|update|advisory|disruption|cancellation|delay)|\bdelays?\b|delayed|earlier departure|departure (is )?(now )?earlier|itinerary( change)?|revised (itinerary|schedule)|updated itinerary|new itinerary|resched|retimed|re-timed|cancel+ed|reaccommodat|re-accommodat|rebook|postponed|departure time|gate change|terminal change|e-?ticket|electronic ticket|ticket confirmation|booking (ref|reference|confirmation|confirmed)|reservation (confirmation|code)|record locator|confirmation number|travel (details|itinerary)|trip details|flight (details|booking|itinerary|confirmation)|booking (no|number|#)|order (no|number)|information about your (flight|booking)|change (in|of) (the )?(departure|arrival)|departure and arrival|your (trip|upcoming flight)|PNR|galileo queue|рейс|изменени|бронировани)/i;
function looksRelevant(email) {
  if (NEGATIVE_HINTS.test(email.subject || "")) return false;
  return AIRLINE_HINTS.test(email.from||"") || AIRLINE_HINTS.test(email.originalFrom||"") ||
         AIRLINE_SENDER.test(email.from||"") || AIRLINE_SENDER.test(email.originalFrom||"") ||
         AIRLINE_HINTS.test(email.body.slice(0,2000)) || SUBJECT_HINTS.test(email.subject||"");
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

Questions? Reply to this mail, write to support@aviolink.in or WhatsApp +91-9503255845.

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
async function processRaw(raw, mid, subject, forcedAgency = null, opts = {}) {
    const rawHead = raw.slice(0, raw.indexOf("\n\n") === -1 ? raw.length : raw.indexOf("\n\n"));
    const email = splitEmail(raw);
    // Passenger hint: airlines often address "PAX NAME <agency@mail>" in To:
    email.toDisplayName = null; // To: display name is the agency contact (IndiGo), never the passenger
    const pdfText = await extractPdfTexts(raw);
    if (pdfText) {
      email.body += "\n\n===PDF ATTACHMENT TEXT===\n" + pdfText;
      console.log(`[pdf] extracted ${pdfText.length} chars from attachment(s)`);
    }
    const agency = forcedAgency || resolveAgency(rawHead, email) || DEFAULT_AGENCY;
    console.log(`[mail] (${agency?.slug}) ${subject}`);
    if (!forcedAgency && agency.gmail_refresh_token && gmail.enabled()) {
      // This agency's Gmail is read directly — a forwarded copy would only create duplicates.
      await logMail(agency.id, mid, subject, "skip", "agency reads Gmail directly");
      return;
    }

    if (opts.bookingsOnly) {
      if (!looksRelevant(email)) { await logMail(agency.id, mid, subject, "backfill-skip"); return; }
      const parsed = await parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined });
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
    } else if (!looksRelevant(email)) {
      await logMail(agency.id, mid, subject, "skip");
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
      const parsed = await parseEmail(raw, { ai: Boolean(CFG.anthropicKey), apiKey: CFG.anthropicKey || undefined });
      parsed._bodyMobile = extractClientMobile(email.body);
      if ((parsed.confidence || 0) === 0 && !SUBJECT_HINTS.test(subject)) {
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
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token)) {
    try {
      const access = await gmailAccess(a);
      const ids = await gmail.listIds(access, GMAIL_LIVE_Q, 300);
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
const BACKFILL_Q = 'newer_than:365d -from:me -in:trash (subject:(ticket OR e-ticket OR eticket OR itinerary OR PNR OR "booking confirmation" OR "booking confirmed" OR "booking reference" OR "flight confirmation" OR "reservation confirmed" OR "travel itinerary" OR "e-ticket receipt" OR "electronic ticket" OR "ticket confirmation" OR "trip details" OR "flight details"))';
async function runBackfills() {
  for (const a of AGENCIES.filter((x) => x.gmail_refresh_token && x.gmail_backfill_status === "pending")) {
    await sb.from("agencies").update({ gmail_backfill_status: "running" }).eq("id", a.id);
    a.gmail_backfill_status = "running";
    let tickets = 0, scanned = 0;
    try {
      const access = await gmailAccess(a);
      const ids = await gmail.listIds(access, BACKFILL_Q, 600);
      const mids = ids.map((id) => `gm-${id}`);
      const { data: known } = await sb.from("mail_log").select("message_id").in("message_id", mids);
      const knownSet = new Set((known || []).map((r) => r.message_id));
      await adminCard(`📚 <b>BACKFILL STARTED</b> · 🏢 ${esc(a.name)}\n${ids.length} ticket-like mails in last 12 months`);
      for (const id of ids) {
        if (knownSet.has(`gm-${id}`)) continue;
        scanned++;
        try {
          const raw = await gmail.getRaw(access, id);
          const ok = await processRaw(raw, `gm-${id}`, splitEmail(raw).subject || "(no subject)", a, { bookingsOnly: true });
          if (ok) tickets++;
        } catch (e) { console.error("[backfill-item]", e.message); }
      }
      await sb.from("agencies").update({ gmail_backfill_status: "done" }).eq("id", a.id);
      a.gmail_backfill_status = "done";
      await adminCard(`📚 <b>BACKFILL DONE</b> · 🏢 ${esc(a.name)}\n${tickets} bookings saved from ${scanned} mails`);
    } catch (e) {
      await sb.from("agencies").update({ gmail_backfill_status: "error" }).eq("id", a.id);
      a.gmail_backfill_status = "error";
      await gmailFail(a, e);
    }
  }
}


const LEGAL_CSS = `<meta name=viewport content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;color:#1f2937;line-height:1.6}h1{color:#1E2761}h2{color:#1E2761;font-size:1.1rem;margin-top:26px}</style>`;
const PRIVACY_HTML = `<!doctype html><title>Privacy Policy — Aviolink</title>${LEGAL_CSS}
<h1>Aviolink FlightAlert — Privacy Policy</h1><p>Last updated: 17 October 2026. Operated by Finch Travels, Pune, India (support@aviolink.in, +91 9503255845).</p>
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

// ---------- HTTP: OAuth callback + health ----------
function startHttp() {
  const port = Number(process.env.PORT || 8080);
  const site = (process.env.SITE_URL || "https://aviolink.in").replace(/\/$/, "");
  http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/privacy" || u.pathname === "/terms") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(u.pathname === "/privacy" ? PRIVACY_HTML : TERMS_HTML);
      }
      if (u.pathname === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
      const page = (title, msg) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Aviolink</title><body style="font-family:system-ui;background:#eef2fb;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;padding:32px;border-radius:14px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(30,39,97,.15)"><h2 style="color:#1E2761">${title}</h2><p style="color:#374151;line-height:1.5">${msg}</p></div>`); };
      // Simple link: /connect/<agency-slug>  e.g. /connect/finch-travels
      const cm = u.pathname.match(/^\/connect\/([a-z0-9-]+)$/);
      if (cm) {
        if (!gmail.enabled()) return page("Not ready", "Google sign-in is not configured yet.");
        const a = AGENCIES.find((x) => x.slug === cm[1]);
        if (!a) return page("Unknown agency", `No agency called “${esc(cm[1])}”. Pick one:<br><br>${AGENCIES.map((x) => `<a href="/connect/${x.slug}">${esc(x.name)}</a>${x.gmail_email ? " ✅ " + esc(x.gmail_email) : ""}`).join("<br>")}`);
        res.writeHead(302, { location: gmail.authUrl(a.id) }); return res.end();
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
        return page("✅ Gmail connected", `<b>${esc(prof.emailAddress)}</b> is now linked to <b>${esc(a?.name || "your agency")}</b>.<br><br>We are reading your past 12 months of ticket mails, then watching every new schedule change and cancellation. You can close this page.`);
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
  await loadAgencies();
  try {
    const { data: stuck } = await sb.from("agencies").update({ gmail_backfill_status: "pending" }).eq("gmail_backfill_status", "running").select("id");
    if (stuck && stuck.length) { console.log(`[backfill] ${stuck.length} interrupted backfill(s) will resume`); await loadAgencies(); }
  } catch (_) {}
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
  const bfLoop = async () => { if (gmail.enabled()) { try { await runBackfills(); } catch (e) { console.error("[backfill-loop]", e.message); } } setTimeout(bfLoop, 60000); };
  sendWelcomes().catch(()=>{});
  startHttp();
  mailLoop(); tgLoop(); setTimeout(agLoop, 120000); setTimeout(bfLoop, 15000);
})();
