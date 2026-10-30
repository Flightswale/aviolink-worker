"use strict";
/**
 * Aviolink dashboard — app.aviolink.in (also api.aviolink.in/app before DNS is ready)
 * Agents: Google sign-in → alerts (send / ignore), bookings, mail log, Gmail, settings.
 * Admin (ADMIN_EMAILS): every agency, all alerts, skipped mail, login-as-agency.
 */
const crypto = require("crypto");
const PAGE = require("fs").readFileSync(require("path").join(__dirname, "dashboard.html"), "utf8");

const SECRET = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "aviolink-dev";
const ADMINS = (process.env.ADMIN_EMAILS || "info@flightswale.com").toLowerCase().split(/[,\s]+/).filter(Boolean);
const COOKIE = "av_s";
const DAY = 86400000;

const b64u = (s) => Buffer.from(s).toString("base64url");
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url").slice(0, 32);
function makeToken(obj) { const p = b64u(JSON.stringify(obj)); return `${p}.${sign(p)}`; }
function readToken(t) {
  const [p, s] = String(t || "").split(".");
  if (!p || !s || sign(p) !== s) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch (_) { return null; }
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}
function hostOf(req) { return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase(); }
function cookieDomain(host) { return /(^|\.)aviolink\.in$/.test(host) ? "; Domain=.aviolink.in" : ""; }
function setSession(res, host, obj) {
  res.setHeader("set-cookie", `${COOKIE}=${obj ? makeToken(obj) : ""}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${obj ? 30 * 86400 : 0}${cookieDomain(host)}`);
}
const json = (res, code, data) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
async function body(req) { let b = ""; for await (const c of req) { b += c; if (b.length > 1e6) break; } try { return JSON.parse(b || "{}"); } catch (_) { return {}; } }
const lc = (s) => String(s || "").trim().toLowerCase();

module.exports = function makeDashboard(ctx) {
  const { sb, gmail, getAgencies, loadAgencies, GMAIL_HEALTH, sendAlertToClient, adminCard, esc } = ctx;

  async function allAgencies() {
    const { data, error } = await sb.from("agencies").select("*").order("name");
    if (error) throw error;
    return data || [];
  }
  async function agencyById(id) {
    const { data } = await sb.from("agencies").select("*").eq("id", id).maybeSingle();
    return data;
  }
  function agencyForEmail(list, email) {
    return list.find((a) => [a.gmail_email, a.notify_email, ...(a.login_emails || [])].some((e) => lc(e) === email)) || null;
  }
  function publicAgency(a) {
    if (!a) return null;
    const h = GMAIL_HEALTH.get(a.id) || {};
    return {
      id: a.id, name: a.name, slug: a.slug, plan: a.plan, trial_ends_at: a.trial_ends_at, status: a.status || "active",
      owner_phone: a.owner_phone, whatsapp: a.whatsapp, notify_email: a.notify_email, alerts_email: a.alerts_email,
      auto_send: Boolean(a.auto_send), login_emails: a.login_emails || [], autoSendReady: a.auto_send !== undefined,
      gmail: { email: a.gmail_email || null, connected_at: a.gmail_connected_at || null, backfill: a.gmail_backfill_status || null,
        error: a.gmail_error || h.err || null, last_ok: h.okAt || null, seen: h.seen ?? null },
    };
  }

  // Which agency a request acts on. null = all agencies (admin only).
  function scope(sess, u) {
    if (sess.admin && !sess.actAs && u.searchParams.get("all") === "1") return null;
    return sess.actAs || sess.agencyId || "__none__";
  }

  async function handle(req, res, u) {
    const host = hostOf(req);
    const isAppHost = host.startsWith("app.");
    const p = u.pathname;

    // ---- login flow (Google, email only) ----
    if (p === "/login") {
      if (!gmail.enabled()) return json(res, 503, { error: "Google sign-in not configured" });
      const back = /^(app|api)\.aviolink\.in$/.test(host) || host.endsWith(".up.railway.app") ? host : "app.aviolink.in";
      const raw = `login~${back}~${Date.now()}`;
      res.writeHead(302, { location: gmail.loginUrl(`${raw}~${sign(raw)}`) }); res.end(); return true;
    }
    if (p === "/auth/google/callback" && String(u.searchParams.get("state") || "").startsWith("login~")) {
      const parts = u.searchParams.get("state").split("~");
      const raw = parts.slice(0, 3).join("~");
      const back = parts[1];
      const home = `https://${back}${back.startsWith("app.") ? "/" : "/app"}`;
      if (sign(raw) !== parts[3] || Date.now() - Number(parts[2]) > 15 * 60000 || !u.searchParams.get("code")) {
        res.writeHead(302, { location: `${home}?e=login` }); res.end(); return true;
      }
      const tok = await gmail.exchangeCode(u.searchParams.get("code"));
      let email = "";
      try { const c = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString()); if (c.email_verified !== false) email = lc(c.email); } catch (_) {}
      if (!email) { res.writeHead(302, { location: `${home}?e=login` }); res.end(); return true; }
      const list = await allAgencies();
      const ag = agencyForEmail(list, email);
      const admin = ADMINS.includes(email);
      if (!ag && !admin) {
        setSession(res, back, null);
        res.writeHead(302, { location: `${home}?e=noaccount&m=${encodeURIComponent(email)}` }); res.end(); return true;
      }
      if (ag && !admin && ag.status === "suspended") { res.writeHead(302, { location: `${home}?e=suspended` }); res.end(); return true; }
      setSession(res, back, { email, admin, agencyId: ag?.id || null, actAs: null, exp: Date.now() + 30 * DAY });
      await adminCard(`🔐 Dashboard login: ${esc(email)}${ag ? " · 🏢 " + esc(ag.name) : ""}${admin ? " (admin)" : ""}`).catch(() => {});
      res.writeHead(302, { location: home }); res.end(); return true;
    }
    if (p === "/logout") { setSession(res, host, null); res.writeHead(302, { location: isAppHost ? "/" : "/app" }); res.end(); return true; }

    // ---- page ----
    if ((isAppHost && (p === "/" || p === "/index.html")) || p === "/app" || p === "/app/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(PAGE); return true;
    }
    if (!p.startsWith("/api/")) return false;

    // ---- API ----
    const sess = readToken(cookies(req)[COOKIE]);
    if (!sess) return json(res, 401, { error: "login" }), true;
    if (req.method === "POST" && req.headers["x-av"] !== "1") return json(res, 403, { error: "bad request" }), true;

    if (p === "/api/me") {
      const own = sess.agencyId ? await agencyById(sess.agencyId) : null;
      const act = sess.actAs ? await agencyById(sess.actAs) : null;
      if (!sess.admin && own && own.status === "suspended") return json(res, 403, { error: "suspended" }), true;
      return json(res, 200, { email: sess.email, admin: sess.admin, agency: publicAgency(act || own), actAs: Boolean(act), waReady: ctx.waEnabled() }), true;
    }

    // Alerts
    if (p === "/api/alerts" && req.method === "GET") {
      const ag = scope(sess, u);
      const since = new Date(Date.now() - 60 * DAY).toISOString();
      let q = sb.from("alerts").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(400);
      if (ag) q = q.eq("agency_id", ag);
      const { data, error } = await q;
      if (error) return json(res, 500, { error: error.message }), true;
      const pnrs = [...new Set((data || []).map((a) => a.pnr).filter(Boolean))];
      let mob = new Map();
      if (pnrs.length) {
        let bq = sb.from("bookings").select("agency_id,pnr,mobile").in("pnr", pnrs.slice(0, 300));
        if (ag) bq = bq.eq("agency_id", ag);
        const { data: bk } = await bq;
        mob = new Map((bk || []).map((b) => [`${b.agency_id}|${b.pnr}`, b.mobile]));
      }
      const names = new Map(getAgencies().map((a) => [a.id, a.name]));
      return json(res, 200, (data || []).map((a) => ({
        id: a.id, agency_id: a.agency_id, agency: names.get(a.agency_id) || "", created_at: a.created_at, pnr: a.pnr, change_type: a.change_type,
        status: a.status, client_status: a.client_status || null, client_mobile: a.client_mobile || mob.get(`${a.agency_id}|${a.pnr}`) || "",
        wa_error: a.wa_error || null, sent_at: a.sent_at, sent_by: a.sent_by || null, confidence: a.confidence,
        payload: { airline: a.payload?.airline, passengers: a.payload?.passengers || [], segments: a.payload?.segments || [], changeType: a.payload?.changeType },
        text: a.compiled_whatsapp || "",
      }))), true;
    }
    const am = p.match(/^\/api\/alerts\/([0-9a-f-]{36})\/(send|ignore)$/);
    if (am && req.method === "POST") {
      const { data: al } = await sb.from("alerts").select("id,agency_id").eq("id", am[1]).maybeSingle();
      if (!al) return json(res, 404, { error: "not found" }), true;
      const ag = scope(sess, u);
      if (!(sess.admin) && al.agency_id !== ag) return json(res, 403, { error: "not yours" }), true;
      if (sess.admin && sess.actAs && al.agency_id !== sess.actAs) return json(res, 403, { error: "not this agency" }), true;
      if (am[2] === "ignore") {
        const r = await sb.from("alerts").update({ status: "skipped", client_status: "ignored", sent_by: sess.email }).eq("id", al.id);
        if (r.error) await sb.from("alerts").update({ status: "skipped" }).eq("id", al.id);
        return json(res, 200, { ok: true }), true;
      }
      const b = await body(req);
      const r = await sendAlertToClient(al.id, { mobile: b.mobile, actor: sess.email });
      return json(res, r.ok ? 200 : 400, r), true;
    }

    // Bookings
    if (p === "/api/bookings") {
      const ag = scope(sess, u);
      const s = String(u.searchParams.get("q") || "").trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "");
      let q = sb.from("bookings").select("*").limit(300);
      if (ag) q = q.eq("agency_id", ag);
      if (s) q = q.ilike("pnr", `%${s}%`);
      let { data, error } = await q.order("created_at", { ascending: false });
      if (error) ({ data, error } = await (ag ? sb.from("bookings").select("*").eq("agency_id", ag) : sb.from("bookings").select("*")).limit(300));
      if (error) return json(res, 500, { error: error.message }), true;
      return json(res, 200, (data || []).map((b) => ({ pnr: b.pnr, airline: b.airline, passengers: b.passengers || [], segments: b.segments || [], mobile: b.mobile || "", created_at: b.created_at || b.updated_at || null }))), true;
    }

    // Mail log
    if (p === "/api/mail") {
      const ag = scope(sess, u);
      const days = Math.min(30, Number(u.searchParams.get("days") || 7));
      let q = sb.from("mail_log").select("agency_id,created_at,subject,verdict,detail").gte("created_at", new Date(Date.now() - days * DAY).toISOString()).order("created_at", { ascending: false }).limit(1000);
      if (ag) q = q.eq("agency_id", ag);
      const v = u.searchParams.get("verdict");
      if (v) q = q.in("verdict", v.split(","));
      const { data, error } = await q;
      if (error) return json(res, 500, { error: error.message }), true;
      const names = new Map(getAgencies().map((a) => [a.id, a.name]));
      return json(res, 200, (data || []).map((m) => ({ ...m, agency: names.get(m.agency_id) || "" }))), true;
    }

    // Gmail reconnect (session-bound, so nobody can link a mailbox to another agency)
    if (p === "/api/gmail/connect") {
      const ag = sess.actAs || sess.agencyId;
      if (!ag) return json(res, 400, { error: "no agency" }), true;
      res.writeHead(302, { location: gmail.authUrl(ag) }); res.end(); return true;
    }

    // Settings
    if (p === "/api/settings" && req.method === "POST") {
      const ag = sess.actAs || sess.agencyId;
      if (!ag) return json(res, 400, { error: "no agency" }), true;
      const b = await body(req);
      const upd = {};
      if (typeof b.name === "string" && b.name.trim().length >= 2) upd.name = b.name.trim().slice(0, 80);
      if (typeof b.owner_phone === "string") { const d = b.owner_phone.replace(/[^\d+ ]/g, "").trim(); if (d.replace(/\D/g, "").length >= 10) upd.owner_phone = d; else return json(res, 400, { error: "Phone must have at least 10 digits" }), true; }
      if (typeof b.notify_email === "string") upd.notify_email = lc(b.notify_email) || null;
      if (typeof b.auto_send === "boolean") upd.auto_send = b.auto_send;
      if (Array.isArray(b.login_emails)) upd.login_emails = [...new Set(b.login_emails.map(lc).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 10);
      const { error } = await sb.from("agencies").update(upd).eq("id", ag);
      if (error) return json(res, 500, { error: /column/.test(error.message) ? "Database update pending — run dashboard.sql in Supabase" : error.message }), true;
      await loadAgencies();
      return json(res, 200, { ok: true, agency: publicAgency(await agencyById(ag)) }), true;
    }

    // ---- admin ----
    if (p.startsWith("/api/admin/")) {
      if (!sess.admin) return json(res, 403, { error: "admin only" }), true;
      if (p === "/api/admin/agencies") {
        const list = await allAgencies();
        const since = new Date(Date.now() - 30 * DAY).toISOString();
        const { data: al } = await sb.from("alerts").select("agency_id,status,client_status").gte("created_at", since).limit(10000);
        const { data: ml } = await sb.from("mail_log").select("agency_id,verdict").gte("created_at", new Date(Date.now() - 7 * DAY).toISOString()).limit(20000);
        const c = (arr, id, f) => (arr || []).filter((x) => x.agency_id === id && f(x)).length;
        return json(res, 200, list.map((a) => ({ ...publicAgency(a),
          stats: { alerts30: c(al, a.id, () => true), toSend: c(al, a.id, (x) => !x.client_status && !["skipped", "awaiting_data", "sent", "delivered"].includes(x.status)),
            sent30: c(al, a.id, (x) => ["sent", "delivered", "read"].includes(x.client_status)), mails7: c(ml, a.id, () => true), review7: c(ml, a.id, (x) => x.verdict === "review") } }))), true;
      }
      const ag = p.match(/^\/api\/admin\/agencies\/([0-9a-f-]{36})$/);
      if (ag && req.method === "POST") {
        const b = await body(req); const upd = {};
        if (["active", "suspended"].includes(b.status)) upd.status = b.status;
        if (["trial", "paid"].includes(b.plan)) upd.plan = b.plan;
        if (b.extendTrialDays) { const a = await agencyById(ag[1]); const base = Math.max(Date.now(), a?.trial_ends_at ? new Date(a.trial_ends_at).getTime() : 0); upd.trial_ends_at = new Date(base + Number(b.extendTrialDays) * DAY).toISOString(); }
        const { error } = await sb.from("agencies").update(upd).eq("id", ag[1]);
        if (error) return json(res, 500, { error: /column/.test(error.message) ? "Run dashboard.sql in Supabase first" : error.message }), true;
        await loadAgencies();
        return json(res, 200, { ok: true }), true;
      }
      if (p === "/api/admin/actas" && req.method === "POST") {
        const b = await body(req);
        const target = b.agencyId ? await agencyById(b.agencyId) : null;
        setSession(res, host, { ...sess, actAs: target ? target.id : null, exp: Date.now() + 30 * DAY });
        return json(res, 200, { ok: true }), true;
      }
    }
    return json(res, 404, { error: "not found" }), true;
  }
  return { handle };
};
