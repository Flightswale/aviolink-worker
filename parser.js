"use strict";
/**
 * FlightAlert — Schedule-Change Email Parser (cloud v2)
 * Two stages: airline templates (cost-savers) -> AI fallback (the universal reader).
 * This build logs AI failures loudly instead of swallowing them.
 */

const fs = require("fs");
const path = require("path");

// ---------- shared helpers ----------
const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

function parseDate(s) {
  if (!s) return null;
  const t = s.trim().toUpperCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2]];
  if (!mm) return null;
  const yyyy = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}
function parseTime(s) {
  if (!s) return null;
  const t = s.trim().replace(":", "");
  if (!/^\d{4}$/.test(t)) return null;
  return `${t.slice(0, 2)}:${t.slice(2)}`;
}
function normSector(s) {
  if (!s) return null;
  const m = s.toUpperCase().match(/([A-Z]{3})\s*[-–—\s]\s*([A-Z]{3})/);
  return m ? `${m[1]}-${m[2]}` : null;
}
function normFlight(s) {
  if (!s) return null;
  const m = s.toUpperCase().match(/([A-Z0-9]{2})\s*0*(\d{1,4})/);
  return m ? `${m[1]} ${m[2]}` : null;
}
function extractPaxNames(text) {
  const re = /\b([A-Z][A-Z' ]{1,25})\/([A-Z][A-Z' ]{1,30}?)\s+(MR|MRS|MS|MISS|MSTR|CHD|INF|DR)\b/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(`${m[1].trim()}/${m[2].trim()} ${m[3]}`);
  return [...new Set(out)];
}

// ---------- template registry ----------
function loadTemplates() {
  const dir = path.join(__dirname, "templates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => require(path.join(dir, f)))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

// ---------- .eml splitting: multipart + quoted-printable ----------
function decodeQuotedPrintable(s) {
  return s
    .replace(/=\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, h) => Buffer.from([parseInt(h, 16)]).toString("latin1"))
    .replace(/[\xC2-\xF4][\x80-\xBF]{1,3}/g, (m) => {
      try { return Buffer.from(m, "latin1").toString("utf8"); } catch { return m; }
    })
    .replace(/\u00A0/g, " ");
}
function stripHtml(s) {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]{2,}/g, " ");
}
function extractBody(head, rawBody) {
  const ct = (head.match(/^Content-Type:\s*(.+)$/im) || [])[1] || "";
  const boundaryM = ct.match(/boundary="?([^";\s]+)"?/i);
  let partText = rawBody;
  let partHead = head;
  let isHtml = /text\/html/i.test(ct);

  if (boundaryM) {
    const parts = rawBody.split(new RegExp(`--${boundaryM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));
    let chosen = parts.find((p) => /Content-Type:\s*text\/plain/i.test(p));
    if (!chosen) { chosen = parts.find((p) => /Content-Type:\s*text\/html/i.test(p)); isHtml = Boolean(chosen); }
    if (!chosen) chosen = parts.find((p) => p.trim().length > 0) || rawBody;
    const idx = chosen.indexOf("\n\n");
    partHead = idx === -1 ? "" : chosen.slice(0, idx);
    partText = idx === -1 ? chosen : chosen.slice(idx + 2);
    if (/Content-Type:\s*text\/html/i.test(partHead)) isHtml = true;
  }

  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(partHead)) {
    partText = decodeQuotedPrintable(partText);
  } else if (/Content-Transfer-Encoding:\s*base64/i.test(partHead)) {
    try { partText = Buffer.from(partText.replace(/\s+/g, ""), "base64").toString("utf8"); } catch (_) {}
  }
  if (isHtml || /<html|<body|<table/i.test(partText)) partText = stripHtml(partText);
  return partText;
}
function splitEmail(rawEml) {
  const norm = rawEml.replace(/\r\n/g, "\n");
  const idx = norm.indexOf("\n\n");
  const head = idx === -1 ? norm : norm.slice(0, idx);
  const rawBody = idx === -1 ? "" : norm.slice(idx + 2);
  const h = (name) => {
    const m = head.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  };
  const body = extractBody(head, rawBody);
  const fwd = body.match(/^From:\s*.*?<([^>\s]+@[^>\s]+)>/im);
  return { from: h("From"), subject: h("Subject"), body, originalFrom: fwd ? fwd[1] : null };
}

// ---------- confidence ----------
function scoreResult(r) {
  let score = 0;
  if (r.pnr && /^[A-Z0-9]{5,7}$/.test(r.pnr)) score += 0.3;
  if (r.passengers && r.passengers.length > 0) score += 0.15;
  if (r.segments && r.segments.length > 0) {
    score += 0.2;
    const seg = r.segments[0];
    if (r.kind === "TICKET") {
      if (seg.sector) score += 0.1;
      if (seg.flight && seg.date) score += 0.15;
      if (seg.dep) score += 0.1;
    } else {
      if (seg.sector) score += 0.1;
      if (seg.old && seg.old.flight && seg.old.date) score += 0.15;
      if (seg.status === "CANCELLED" || (seg.new && seg.new.flight)) score += 0.1;
    }
  }
  return Math.min(1, Math.round(score * 100) / 100);
}

// ---------- AI fallback: the universal reader ----------
const FALLBACK_SYSTEM_PROMPT = `You extract airline schedule-change / cancellation / e-ticket data from emails sent to travel agencies, from ANY airline, consolidator or booking vendor worldwide, in any language.
Respond ONLY with a JSON object, no markdown fences, matching exactly:
{"kind":"SCHEDULE_CHANGE"|"TICKET","pnr":string|null,"airline":string|null,
"changeType":"TIME_CHANGE"|"CANCELLATION"|"REACCOMMODATION"|null,
"passengers":string[],"segments":[{"status":"CHANGED"|"CANCELLED"|"BOOKED","sector":string|null,
"flight":string|null,"date":"YYYY-MM-DD"|null,"dep":"HH:MM"|null,"arr":"HH:MM"|null,
"old":{"flight":string|null,"date":"YYYY-MM-DD"|null,"dep":"HH:MM"|null,"arr":"HH:MM"|null}|null,
"new":{"flight":string|null,"date":"YYYY-MM-DD"|null,"dep":"HH:MM"|null,"arr":"HH:MM"|null}|null}],
"actionDeadline":"YYYY-MM-DD"|null}

CRITICAL AIRLINE-DOMAIN RULES:
1. pnr = the AIRLINE PNR / record locator: 5-7 alphanumeric chars (e.g. 8AYCHU, KEBDPW). NEVER a vendor/agency reference like CT1457860, FBB7SVA7, booking ids, or ticket numbers. If both appear, always pick the 5-7 char airline PNR.
2. GDS segment status codes: UN, UC, HX, NO, WK = CANCELLED (that flight goes in "old", "new"=null unless a replacement flight is explicitly offered). TK, TL, SC = the NEW/changed schedule. HK, KK = confirmed.
3. A mail saying "rescheduled/canceled" that shows only ONE flight with UN/HX status is a CANCELLATION: changeType=CANCELLATION, that flight in "old", "new"=null. NEVER put a cancelled flight in "new".
4. Only use changeType=TIME_CHANGE when both an old and a genuinely new schedule are present (or the mail explicitly states the new timing).
5. kind=TICKET for itineraries/e-tickets (fill flight/date/dep/arr per segment; old/new null). kind=SCHEDULE_CHANGE for changes/cancellations.
6. Dates ISO YYYY-MM-DD (GDS date like 18SEP = next occurrence of that date). Times 24h HH:MM. Sector XXX-YYY IATA. Unknown fields null.
7. If the mail is not about a flight booking or change at all, return {"kind":null}.
8. VOLUNTARY vs INVOLUNTARY: alerts are ONLY for AIRLINE-INITIATED changes. If the mail shows the change/cancellation was REQUESTED by the travel agency or passenger (e.g. "as per your request", "your cancellation request", refund confirmations, reissue requests, replies to an agency's own mail asking for a change), return {"kind":null}. The quoted thread below a supplier reply often reveals who initiated it.

EXAMPLE: line "3 EW3049 E 18SEP 5 CDGPRG UN2 2015 2200" in a schedule-change mail with PNR 8AYCHU =>
{"kind":"SCHEDULE_CHANGE","pnr":"8AYCHU","airline":"EW","changeType":"CANCELLATION","passengers":[...],
"segments":[{"status":"CANCELLED","sector":"CDG-PRG","flight":null,"date":null,"dep":null,"arr":null,
"old":{"flight":"EW 3049","date":"<next 18 Sep>","dep":"20:15","arr":"22:00"},"new":null}],"actionDeadline":null}`;

async function aiFallback(email, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  const workspaceId = opts.workspaceId || process.env.ANTHROPIC_WORKSPACE_ID;
  const doFetch = opts.fetch || globalThis.fetch;
  if (!apiKey || !doFetch) return null;
  try {
    const headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (workspaceId) headers["anthropic-workspace-id"] = workspaceId;
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: FALLBACK_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `SUBJECT: ${email.subject}\nFROM: ${email.from}\n\n${(email.body || "").slice(0, 30000)}` }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[ai-error] HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    // Tolerate chatter around the JSON: parse from the first "{" to the last "}".
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    const parsed = JSON.parse(a >= 0 && b > a ? clean.slice(a, b + 1) : clean);
    if (!parsed || !parsed.kind) { console.log("[ai] mail judged not booking-related"); return null; }
    return parsed;
  } catch (err) {
    console.error(`[ai-error] ${err.message}`);
    return null;
  }
}

// ---------- main entry ----------
async function parseEmail(rawEml, opts = {}) {
  const email = splitEmail(rawEml);
  const templates = opts._templates || loadTemplates();

  for (const tpl of templates) {
    try {
      if (!tpl.match(email)) continue;
      const r = tpl.parse(email, helpers);
      if (r) {
        if (!r.kind) r.kind = "SCHEDULE_CHANGE";
        const noPax = !(r.passengers && r.passengers.length);
        const changeSubject = /revised|schedule change|time change|resched|cancel|retim|delay/i.test(email.subject || "");
        if (opts.ai !== false && (noPax || (r.kind === "TICKET" && changeSubject))) {
          console.log(`[template] ${tpl.name} incomplete (pax=${!noPax}, changeSubject=${changeSubject}) -> handing to AI`);
          break; // fall through to the AI reader
        }
        r.confidence = scoreResult(r);
        r.source = `template:${tpl.name}`;
        r.raw = { subject: email.subject, from: email.from };
        return r;
      }
    } catch (e) {
      console.error(`[template-error] ${tpl.name}: ${e.message}`);
    }
  }

  if (opts.ai !== false) {
    const r = await aiFallback(email, opts);
    if (r && r.kind) {
      r.passengers = r.passengers || [];
      r.segments = r.segments || [];
      r.confidence = Math.min(scoreResult(r), 0.84); // AI results always route to approval
      r.source = "ai-fallback";
      r.raw = { subject: email.subject, from: email.from };
      return r;
    }
  }

  return {
    pnr: null, airline: null, changeType: null, kind: null, passengers: [], segments: [],
    actionDeadline: null, confidence: 0, source: "unparsed",
    raw: { subject: email.subject, from: email.from },
  };
}

const helpers = { parseDate, parseTime, normSector, normFlight, extractPaxNames };
module.exports = { parseEmail, splitEmail, helpers, scoreResult, aiFallback };
