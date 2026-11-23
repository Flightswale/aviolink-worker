"use strict";
/**
 * Weekly "Airline changes" reports — public SEO pages at aviolink.in/news (proxied by a Cloudflare Pages Function).
 * Numbers are aggregates across all Aviolink mailboxes: no agency, client, PNR or passenger is ever shown.
 * A week runs Monday 00:00 → Monday 00:00 IST and is stored once in weekly_news.
 */
const DAY = 86400000, IST = 5.5 * 3600000;

module.exports = function makeNews({ sb, airlineName, tips }) {
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Monday 00:00 IST (as a UTC Date) of the week containing t
  function mondayOf(t) {
    const ist = new Date(t + IST); const dow = (ist.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow) - IST);
  }
  const key = (mon) => new Date(mon.getTime() + IST).toISOString().slice(0, 10);
  const fmt = (d, o) => new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", ...o });

  async function weekStats(mon) {
    const from = mon.toISOString(), to = new Date(mon.getTime() + 7 * DAY).toISOString();
    const { data: al } = await sb.from("alerts").select("change_type,created_at,payload,status,client_status").gte("created_at", from).lt("created_at", to).limit(5000);
    const A = (al || []).filter((a) => a.status !== "skipped" && a.client_status !== "ignored");
    const { count: mails } = await sb.from("mail_log").select("id", { count: "exact", head: true }).gte("created_at", from).lt("created_at", to);
    const isCancel = (a) => (a.change_type || a.payload?.changeType) === "CANCELLATION";
    const byAir = {};
    for (const a of A) {
      const code = a.payload?.airline; if (!code) continue;
      const n = airlineName(code) || code; byAir[n] = byAir[n] || { changes: 0, cancels: 0 };
      byAir[n].changes++; if (isCancel(a)) byAir[n].cancels++;
    }
    const night = A.filter((a) => { const h = new Date(new Date(a.created_at).getTime() + IST).getUTCHours(); return h >= 21 || h < 8; }).length;
    const weekend = A.filter((a) => [0, 6].includes(new Date(new Date(a.created_at).getTime() + IST).getUTCDay())).length;
    return { changes: A.length, cancels: A.filter(isCancel).length, night, weekend, mails: mails || 0,
      airlines: Object.entries(byAir).sort((x, y) => y[1].changes - x[1].changes).map(([name, v]) => ({ name, ...v })),
      tip: tips[Math.floor(mon.getTime() / 6048e5) % tips.length] };
  }

  async function saveWeek(mon) {
    const data = await weekStats(mon);
    await sb.from("weekly_news").upsert({ week: key(mon), data }, { onConflict: "week" });
    return data;
  }
  // Last complete week (called Monday morning) + any missing past weeks since the first alert (max 12)
  async function catchUp() {
    const last = new Date(mondayOf(Date.now()).getTime() - 7 * DAY);
    const { data: have } = await sb.from("weekly_news").select("week");
    const got = new Set((have || []).map((r) => String(r.week).slice(0, 10)));
    const { data: first } = await sb.from("alerts").select("created_at").order("created_at", { ascending: true }).limit(1);
    if (!first?.length) return 0;
    const start = mondayOf(new Date(first[0].created_at).getTime());
    let n = 0;
    for (let m = last; m >= start && n < 12; m = new Date(m.getTime() - 7 * DAY)) {
      if (!got.has(key(m))) { await saveWeek(m); n++; }
    }
    return n;
  }

  let TPL = null, TPL_AT = 0;
  async function template() {
    if (TPL && Date.now() - TPL_AT < 3600000) return TPL;
    const r = await fetch("https://aviolink.in/news-template.html");
    if (r.ok) { TPL = await r.text(); TPL_AT = Date.now(); }
    return TPL;
  }
  async function wrap(path, title, desc, body) {
    const t = await template();
    if (!t) return `<!doctype html><title>${esc(title)}</title>${body}`;
    return t.split("{{TITLE}}").join(esc(title)).split("{{DESC}}").join(esc(desc)).split("{{PATH}}").join(path).replace("{{BODY}}", body);
  }
  const range = (wk) => { const m = new Date(wk + "T00:00:00+05:30"); const s = new Date(m.getTime() + 6 * DAY);
    return `${fmt(m, { day: "numeric", ...(m.getMonth() !== s.getMonth() ? { month: "short" } : {}) })}–${fmt(s, { day: "numeric", month: "short", year: "numeric" })}`; };

  async function render(path) {
    if (path === "/news/sitemap.xml") {
      const { data } = await sb.from("weekly_news").select("week,created_at").order("week", { ascending: false });
      const urls = [`<url><loc>https://aviolink.in/news</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`]
        .concat((data || []).filter((r) => r.week).map((r) => `<url><loc>https://aviolink.in/news/${String(r.week).slice(0, 10)}</loc><lastmod>${String(r.created_at).slice(0, 10)}</lastmod><priority>0.6</priority></url>`));
      return { type: "application/xml", body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n` };
    }
    const { data: weeks } = await sb.from("weekly_news").select("week,data").order("week", { ascending: false });
    const W = (weeks || []).map((r) => ({ week: String(r.week).slice(0, 10), d: r.data || {} }));
    if (path === "/news") {
      const rows = W.map((w) => `<a class="card" href="/news/${w.week}" style="display:block;text-decoration:none;color:inherit"><div class="kicker" style="margin:0">${esc(range(w.week))}</div><h3 style="margin:8px 0 6px">${w.d.changes || 0} flight changes caught${w.d.cancels ? ` · ${w.d.cancels} cancellation${w.d.cancels === 1 ? "" : "s"}` : ""}</h3><p style="margin:0;color:var(--muted)">${esc((w.d.airlines || []).slice(0, 3).map((a) => a.name).join(", ") || "Weekly report")}</p></a>`).join("");
      const body = `<section class="phero"><div class="wrap"><div class="kicker">Weekly report</div><h1>Airline schedule changes, week by week</h1><p>How many flight re-timings and cancellations reached Indian travel agency mailboxes each week — and which airlines sent them. Counted automatically by Aviolink, with no agency or passenger details.</p></div></section>
<section><div class="wrap narrow"><div class="cards" style="grid-template-columns:1fr">${rows || "<p>The first weekly report appears on Monday.</p>"}</div></div></section>`;
      return { type: "text/html; charset=utf-8", body: await wrap("/news", "Airline schedule changes this week — weekly report | Aviolink", "Weekly count of airline schedule changes and cancellations seen in Indian travel agency mailboxes, by airline.", body) };
    }
    const m = path.match(/^\/news\/(\d{4}-\d{2}-\d{2})$/);
    const i = m ? W.findIndex((w) => w.week === m[1]) : -1;
    if (i < 0) return null;
    const { week, d } = W[i], r = range(week);
    const air = (d.airlines || []).map((a) => `<tr><td style="padding:10px 12px;border-bottom:1px solid var(--line)">${esc(a.name)}</td><td style="padding:10px 12px;border-bottom:1px solid var(--line);text-align:right">${a.changes}</td><td style="padding:10px 12px;border-bottom:1px solid var(--line);text-align:right">${a.cancels}</td></tr>`).join("");
    const stat = (n, l) => `<div class="card"><div style="font-size:2.2rem;font-weight:800;color:var(--navy)">${Number(n || 0).toLocaleString("en-IN")}</div><div style="color:var(--muted)">${l}</div></div>`;
    const nav = `<p style="margin-top:28px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">${W[i + 1] ? `<a href="/news/${W[i + 1].week}">← ${esc(range(W[i + 1].week))}</a>` : "<span></span>"}<a href="/news">All weeks</a>${W[i - 1] ? `<a href="/news/${W[i - 1].week}">${esc(range(W[i - 1].week))} →</a>` : "<span></span>"}</p>`;
    const top = (d.airlines || []).slice(0, 3).map((a) => a.name);
    const body = `<section class="phero"><div class="wrap"><div class="kicker">Weekly report · ${esc(r)}</div><h1>Airline schedule changes: ${esc(r)}</h1><p>${d.changes || 0} flight changes${d.cancels ? `, including ${d.cancels} cancellation${d.cancels === 1 ? "" : "s"},` : ""} reached travel agency mailboxes this week${top.length ? ` — most from ${esc(top.join(", "))}` : ""}.</p></div></section>
<section><div class="wrap narrow">
<div class="cards c2">${stat(d.changes, "flight changes caught")}${stat(d.cancels, "cancellations")}${stat(d.night, "arrived between 9 PM and 8 AM")}${stat(d.weekend, "arrived on Saturday or Sunday")}</div>
${air ? `<h2 style="margin-top:40px">Changes by airline</h2><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin-top:12px;background:#fff;border:1px solid var(--line);border-radius:12px"><thead><tr><th style="text-align:left;padding:10px 12px">Airline</th><th style="text-align:right;padding:10px 12px">Changes</th><th style="text-align:right;padding:10px 12px">Cancellations</th></tr></thead><tbody>${air}</tbody></table></div>` : ""}
<h2 style="margin-top:40px">Tip for travel agents</h2><p>${esc(d.tip || "")}</p>
<h2 style="margin-top:32px">What to do when an airline changes a booking</h2><p>Check the new timing against the client’s plans and any onward flight, inform the client before check-in opens, and keep the airline mail for refund or rebooking claims. Aviolink reads these mails automatically and sends the client a WhatsApp alert in your agency’s name.</p>
<p style="color:var(--muted);font-size:.9rem;margin-top:24px">Counted from ${Number(d.mails || 0).toLocaleString("en-IN")} mails read by Aviolink this week. Totals only: no agency, client or booking details are published.</p>
${nav}</div></section>`;
    return { type: "text/html; charset=utf-8", body: await wrap(`/news/${week}`, `Airline schedule changes ${r}: ${d.changes || 0} changes${top.length ? `, ${top[0]} most` : ""} | Aviolink`, `${d.changes || 0} flight re-timings and ${d.cancels || 0} cancellations in Indian travel agency mailboxes, ${r}${top.length ? `. Most from ${top.join(", ")}` : ""}.`, body) };
  }

  // IndexNow: tell Bing / Yandex / Seznam about pages (Google does not use IndexNow; it reads sitemap.xml)
  const INDEXNOW_KEY = "838465aaa4c93141df30a8658b788332";
  async function pingIndexNow(paths) {
    const urlList = paths.map((p) => "https://aviolink.in" + p);
    const r = await fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: "aviolink.in", key: INDEXNOW_KEY, keyLocation: `https://aviolink.in/${INDEXNOW_KEY}.txt`, urlList }) });
    return r.status;
  }
  async function pingAll() {
    const { data } = await sb.from("weekly_news").select("week");
    const site = ["/", "/flightalert.html", "/pricing.html", "/about.html", "/contact.html", "/security.html", "/signup.html", "/news"];
    return pingIndexNow(site.concat((data || []).map((r) => "/news/" + String(r.week).slice(0, 10))));
  }

  return { catchUp, saveWeek, mondayOf, render, key, pingIndexNow, pingAll };
};
