"use strict";
/**
 * Self-test from the agency's own real mails.
 *  /buildtests  — picks real airline mails Aviolink already handled (tickets, changes, delays, info, unrecognised),
 *                 downloads them from Gmail and stores each with today's reading as the expected result.
 *  /selftest    — reads every stored mail again with the current code and reports any difference.
 * Runs automatically ~10 min after every update (each Railway deploy restarts the worker).
 * Table (run once in Supabase):
 *   create table if not exists test_mails (id bigserial primary key, agency_id text, message_id text unique,
 *     subject text, raw text, expected jsonb, created_at timestamptz default now());
 */
const PER_KIND = 20, MAX_TOTAL = 80;

module.exports = function makeSelfTest(ctx) {
  const { sb, gmail, gmailAccess, getAgencies, readMail, adminCard, esc } = ctx;

  const nf = (f) => String(f || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^([A-Z0-9]{2})0+/, "$1");
  // The facts that matter to a client: what kind, which PNR, which flights, when.
  function essence(p) {
    const legs = (p.segments || []).map((s) => {
      const v = s.new || s.old || s;
      return [nf(s.flight || v.flight), v.date || "", v.dep || "", v.arr || "", s.status === "CANCELLED" || (s.old && !s.new) ? "X" : ""].join(" ");
    }).sort();
    return { kind: p.kind || null, pnr: p.pnr || null, change: p.changeType || null, pax: (p.passengers || []).length, legs };
  }
  // Compare by content, not field order (the database re-orders JSON keys).
  const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : v;
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  function diffText(e, g) {
    const out = [];
    for (const k of ["kind", "pnr", "change", "pax"]) if (e[k] !== g[k]) out.push(`${k}: ${e[k]} → ${g[k]}`);
    if (!same(e.legs, g.legs)) out.push(`flights: ${e.legs.join(" | ") || "-"} → ${g.legs.join(" | ") || "-"}`);
    return out.join("; ");
  }

  async function build(chatNote) {
    const { data: rows, error } = await sb.from("mail_log").select("agency_id,message_id,subject,verdict")
      .in("verdict", ["ticket", "change", "info", "review", "backfill-ticket"]).like("message_id", "gm-%")
      .order("created_at", { ascending: false }).limit(1500);
    if (error) throw error;
    const { data: have } = await sb.from("test_mails").select("message_id");
    if (have === null) throw new Error("table test_mails missing — run the SQL in Supabase first");
    const known = new Set((have || []).map((x) => x.message_id));
    const perKind = {}; const pick = [];
    for (const r of rows || []) {
      const mid = r.message_id.split("#")[0];
      if (known.has(mid) || pick.some((p) => p.mid === mid)) continue;
      const k = r.verdict === "backfill-ticket" ? "ticket" : r.verdict;
      if ((perKind[k] || 0) >= PER_KIND) continue;
      perKind[k] = (perKind[k] || 0) + 1; pick.push({ ...r, mid });
      if (pick.length + known.size >= MAX_TOTAL) break;
    }
    let saved = 0;
    const access = new Map();
    for (const r of pick) {
      try {
        const a = getAgencies().find((x) => x.id === r.agency_id);
        if (!a || !a.gmail_refresh_token) continue;
        if (!access.has(a.id)) access.set(a.id, await gmailAccess(a));
        const raw = await gmail.getRaw(access.get(a.id), r.mid.slice(3));
        const parsed = await readMail(raw);
        if (parsed.source === "ai-error") continue;
        await sb.from("test_mails").upsert({ agency_id: r.agency_id, message_id: r.mid, subject: r.subject, raw, expected: essence(parsed) }, { onConflict: "message_id" });
        saved++;
      } catch (e) { console.error("[buildtests]", r.subject, e.message); }
    }
    const total = known.size + saved;
    await adminCard(`🧪 <b>TEST SET</b>${chatNote ? " " + chatNote : ""}: ${saved} real mail(s) added · ${total} in total\n${Object.entries(perKind).map(([k, v]) => `${k}: ${v}`).join(" · ")}\nEvery update is now checked against these.`);
    return total;
  }

  async function run(reason) {
    const { data: tests, error } = await sb.from("test_mails").select("id,agency_id,message_id,subject,raw,expected");
    if (error || !tests || !tests.length) return null;
    // Mails stored cut at 600 KB by the first version: fetch the full mail from Gmail again.
    const access = new Map();
    for (const t of tests) {
      if ((t.raw || "").length < 600000) continue;
      try {
        const a = getAgencies().find((x) => x.id === t.agency_id);
        if (!a || !a.gmail_refresh_token) continue;
        if (!access.has(a.id)) access.set(a.id, await gmailAccess(a));
        t.raw = await gmail.getRaw(access.get(a.id), t.message_id.slice(3));
        await sb.from("test_mails").update({ raw: t.raw }).eq("id", t.id);
      } catch (e) { console.error("[selftest] refetch", t.subject, e.message); }
    }
    const bad = [], minors = []; let aiDown = 0;
    for (const t of tests) {
      try {
        let got = await readMail(t.raw);
        if (got.source === "ai-error") { aiDown++; continue; }
        if (!same(essence(got), t.expected)) { got = await readMail(t.raw); } // AI can vary once — confirm
        const g = essence(got);
        if (!same(g, t.expected)) {
          // "Booking info" vs "not a booking" on a mail with no change (e.g. check-in reminder): never alerts a client either way
          const kinds = new Set([t.expected?.kind || null, g.kind || null]);
          const minor = !t.expected?.change && !g.change && kinds.has("TICKET") && kinds.has(null) && kinds.size === 2;
          (minor ? minors : bad).push({ subject: t.subject, why: diffText(t.expected, g) });
        }
      } catch (e) { bad.push({ subject: t.subject, why: "error: " + e.message }); }
    }
    const ok = tests.length - bad.length - minors.length - aiDown;
    const head = bad.length ? `❌ <b>SELF-TEST: ${bad.length} of ${tests.length} mails read differently</b>` : `✅ <b>SELF-TEST passed</b> — ${ok}/${tests.length} real mails read the same`;
    await adminCard(`${head}${reason ? " (" + esc(reason) + ")" : ""}${aiDown ? `\n⚠️ ${aiDown} skipped — AI not available` : ""}` +
      bad.slice(0, 10).map((b) => `\n\n• ${esc(b.subject)}\n<i>${esc(b.why.slice(0, 300))}</i>`).join("") +
      (bad.length ? "\n\nIf the new reading is correct, send /acceptall to make it the new expected result." : "") +
      (minors.length ? `\n\nℹ️ ${minors.length} minor (booking info vs not-a-booking, no client effect): ${minors.map((m) => esc(m.subject.slice(0, 60))).join("; ")}` : ""));
    return { total: tests.length, bad };
  }

  // Accept current readings as the new expected values (after a deliberate improvement).
  async function acceptAll() {
    const { data: tests } = await sb.from("test_mails").select("id,raw");
    let n = 0;
    for (const t of tests || []) {
      const got = await readMail(t.raw);
      if (got.source === "ai-error") continue;
      await sb.from("test_mails").update({ expected: essence(got) }).eq("id", t.id); n++;
    }
    await adminCard(`🧪 Expected results updated for ${n} test mail(s).`);
  }

  return { build, run, acceptAll };
};
