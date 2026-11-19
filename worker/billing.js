"use strict";
/**
 * Aviolink billing — one month at a time (no auto-debit mandate). Each payment = a Razorpay Order paid via Checkout;
 *   a verified payment extends paid_until by 30 days from today or from the current expiry, whichever is later.
 *   Dashboard "Subscribe" → POST /api/billing/subscribe → Razorpay hosted page (short_url).
 *   Razorpay → POST /webhook/razorpay → each successful charge: plan=paid, paid_until = period end + 3 days grace.
 * Railway variables: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 *   optional: AVIOLINK_PRICE (monthly, ₹, incl. GST — default 2359 = 1999 + 18% GST), RAZORPAY_PLAN_ID
 */
const crypto = require("crypto");
const DAY = 86400000;

module.exports = function makeBilling({ sb, adminCard, esc, loadAgencies }) {
  const KEY = process.env.RAZORPAY_KEY_ID || "", SECRET = process.env.RAZORPAY_KEY_SECRET || "", WH = process.env.RAZORPAY_WEBHOOK_SECRET || "";
  const PRICE = Math.round(Number(process.env.AVIOLINK_PRICE || 2359));
  const enabled = () => Boolean(KEY && SECRET);
  const auth = () => "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");
  async function rzp(method, path, body) {
    const r = await fetch(`https://api.razorpay.com/v1${path}`, { method, headers: { authorization: auth(), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.description || `Razorpay HTTP ${r.status}`);
    return d;
  }
  let planId = process.env.RAZORPAY_PLAN_ID || "";
  async function ensurePlan() {
    if (planId) return planId;
    const list = await rzp("GET", "/plans?count=100");
    const found = (list.items || []).find((p) => p.period === "monthly" && p.interval === 1 && p.item?.amount === PRICE * 100 && /Aviolink/i.test(p.item?.name || ""));
    if (found) return (planId = found.id);
    const p = await rzp("POST", "/plans", { period: "monthly", interval: 1, item: { name: "Aviolink FlightAlert — monthly", amount: PRICE * 100, currency: "INR", description: "Flight change alerts for travel agents (incl. GST)" } });
    return (planId = p.id);
  }

  // Start a one-month payment for an agency → URL of our payment page
  async function subscribe(agency, email) {
    if (!enabled()) throw new Error("Online payment is being set up — please WhatsApp +91 95032 55845 to pay.");
    const o = await rzp("POST", "/orders", { amount: PRICE * 100, currency: "INR", receipt: `av-${String(agency.id).slice(0, 8)}-${Date.now().toString(36)}`,
      notes: { agency_id: agency.id, agency: agency.name, email: email || "", gstin: agency.gstin || "", legal_name: (agency.legal_name || "").slice(0, 100),
        phone: String(agency.whatsapp || agency.owner_phone || "").replace(/[^\d+]/g, ""), billing_address: (agency.billing_address || "").slice(0, 250) } });
    return payUrl(o.id);
  }

  // Record a captured payment once (payments table has the payment id as primary key) → +30 days
  async function applyPayment(agencyId, pay) {
    const { error: dup } = await sb.from("payments").insert({ id: pay.id, agency_id: agencyId, amount: (pay.amount || 0) / 100, method: pay.method || null, order_id: pay.order_id || null });
    if (dup) { if (/duplicate|unique/i.test(dup.message)) return null; console.error("[billing] payments insert", dup.message); }
    const { data: a } = await sb.from("agencies").select("id,name,plan,paid_until,trial_ends_at").eq("id", agencyId).maybeSingle();
    if (!a) return null;
    // Paying early never loses days: the month starts after the current expiry (or after the free trial)
    const base = Math.max(Date.now(), a.paid_until ? new Date(a.paid_until).getTime() : 0, a.plan === "trial" && a.trial_ends_at ? new Date(a.trial_ends_at).getTime() : 0);
    const until = new Date(base + 30 * DAY).toISOString();
    await sb.from("agencies").update({ plan: "paid", paid_until: until, status: "active", trial_reminder: null }).eq("id", agencyId);
    await loadAgencies();
    await adminCard(`💰 <b>PAYMENT RECEIVED</b> · 🏢 ${esc(a.name)}\n₹${((pay.amount || 0) / 100).toLocaleString("en-IN")} · ${esc(pay.method || "")}\nValid till ${new Date(until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}. Reminder goes 5 days before expiry.`).catch(() => {});
    return until;
  }

  // Our own payment page with Razorpay Checkout (the Razorpay hosted subscription page is not enabled on this account)
  const API = (process.env.PUBLIC_API_URL || "https://api.aviolink.in").replace(/\/$/, "");
  const payUrl = (id) => `${API}/pay/${id}`;
  const h = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function payPage(orderId) {
    if (!/^order_[A-Za-z0-9]+$/.test(orderId)) return null;
    const o = await rzp("GET", `/orders/${orderId}`);
    const done = o.status === "paid";
    const n = o.notes || {};
    const opts = { key: KEY, order_id: orderId, amount: o.amount, currency: "INR", name: "Aviolink", description: `FlightAlert · 1 month · ₹${(o.amount / 100).toLocaleString("en-IN")} incl. GST`,
      image: "https://aviolink.in/assets/aviolink-icon-120.png", callback_url: `${API}/pay/${orderId}/done`, prefill: { name: n.legal_name || n.agency || "", email: n.email || "", contact: n.phone || "" },
      notes: n, theme: { color: "#141B4D" } };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviolink — Pay</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#F3F5FB;color:#141B4D;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{background:#fff;border-radius:18px;padding:32px;max-width:420px;width:100%;box-shadow:0 10px 40px rgba(20,27,77,.12);text-align:center}h1{font-size:22px;margin:0 0 6px}p{color:#3F4865;line-height:1.5}
.p{font-size:34px;font-weight:800;margin:14px 0}button{background:#0E9F6E;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:17px;font-weight:700;cursor:pointer;width:100%}small{color:#5B6478}</style></head>
<body><div class="c"><img src="https://aviolink.in/assets/aviolink-icon-120.png" alt="" width="56" height="56"><h1>Aviolink FlightAlert</h1>
${done ? `<p>✅ This payment is already done. Thank you!</p><p><a href="https://app.aviolink.in">Open your dashboard</a></p>` :
`<div class="p">₹${(o.amount / 100).toLocaleString("en-IN")}<span style="font-size:15px;font-weight:600;color:#5B6478"> for 1 month, incl. GST</span></div>
<p>One-time payment by UPI, card or net banking. No auto-debit — we remind you before the next month.</p><button id="pay">Pay securely with Razorpay</button>
<p><small>Questions? WhatsApp +91 95032 55845 · support@aviolink.in</small></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>const o=${JSON.stringify(opts).replace(/</g, "\\u003c")};const r=new Razorpay(o);document.getElementById("pay").onclick=()=>r.open();r.open();</script>`}
</div></body></html>`;
  }
  async function payDone(orderId, form) {
    const sig = crypto.createHmac("sha256", SECRET).update(`${orderId}|${form.razorpay_payment_id}`).digest("hex");
    let ok = !!form.razorpay_signature && /^order_/.test(orderId) && sig === form.razorpay_signature, until = null;
    if (ok) {
      try { let pay = await rzp("GET", `/payments/${form.razorpay_payment_id}`); const o = await rzp("GET", `/orders/${orderId}`);
        if (pay.status === "authorized" && pay.order_id === orderId) pay = await rzp("POST", `/payments/${pay.id}/capture`, { amount: pay.amount, currency: "INR" }).catch(() => pay);
        if (pay.order_id !== orderId) throw new Error("payment/order mismatch");
        if (o.notes?.agency_id && ["captured", "authorized"].includes(pay.status)) until = (await applyPayment(o.notes.agency_id, pay)) || null;
      } catch (e) { console.error("[billing] payDone", e.message); }
    }
    const till = until ? new Date(until).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : null;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviolink</title></head>
<body style="font-family:system-ui,sans-serif;background:#F3F5FB;color:#141B4D;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px">
<div style="background:#fff;border-radius:18px;padding:32px;max-width:420px;text-align:center">${ok ? `<h1>✅ Payment successful</h1><p>Thank you! Your alerts are active${till ? ` till <b>${till}</b>` : ""}. Razorpay emails you the receipt. We will remind you 5 days before the next payment.</p>` : `<h1>Payment not completed</h1><p>Nothing was charged. <a href="${payUrl(h(orderId))}">Try again</a> or WhatsApp +91 95032 55845.</p>`}
<p><a href="https://app.aviolink.in">Open your dashboard</a></p></div></body></html>`;
  }

  // Webhook: verify signature on the raw body, then apply
  async function webhook(raw, signature) {
    if (!WH) return { ok: false, err: "webhook secret not set" };
    const expect = crypto.createHmac("sha256", WH).update(raw).digest("hex");
    if (!signature || signature.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(signature))) return { ok: false, err: "bad signature" };
    const ev = JSON.parse(raw);
    if (ev.event === "payment.captured" || ev.event === "order.paid") {
      const pay = ev.payload?.payment?.entity || {};
      let agencyId = pay.notes?.agency_id;
      if (!agencyId && pay.order_id) agencyId = (await rzp("GET", `/orders/${pay.order_id}`).catch(() => ({}))).notes?.agency_id;
      if (agencyId && pay.id) await applyPayment(agencyId, pay);
      return { ok: true };
    }
    const sub = ev.payload?.subscription?.entity || {};
    const pay = ev.payload?.payment?.entity || {};
    const agencyId = sub.notes?.agency_id;
    if (!agencyId) return { ok: true, ignored: true };
    const { data: a } = await sb.from("agencies").select("id,name,paid_until").eq("id", agencyId).maybeSingle();
    if (!a) return { ok: true, ignored: true };
    if (ev.event === "subscription.charged" || ev.event === "subscription.activated") {
      const end = sub.current_end ? sub.current_end * 1000 : Date.now() + 30 * DAY;
      const until = new Date(Math.max(end + 3 * DAY, a.paid_until ? new Date(a.paid_until).getTime() : 0)).toISOString();
      await sb.from("agencies").update({ plan: "paid", paid_until: until, status: "active", trial_reminder: null, rzp_subscription_id: sub.id }).eq("id", agencyId);
      await loadAgencies();
      if (ev.event === "subscription.charged") {
        await adminCard(`💰 <b>PAYMENT RECEIVED</b> · 🏢 ${esc(a.name)}\n₹${((pay.amount || 0) / 100).toLocaleString("en-IN")} · ${esc(pay.method || "")}\nValid till ${new Date(until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} — renews automatically.`);
      }
    } else if (["subscription.halted", "subscription.cancelled", "subscription.paused", "subscription.pending"].includes(ev.event)) {
      const what = { "subscription.halted": "renewal FAILED (Razorpay stopped retrying)", "subscription.cancelled": "subscription CANCELLED", "subscription.paused": "subscription PAUSED", "subscription.pending": "renewal payment failed — Razorpay is retrying" }[ev.event];
      await adminCard(`⚠️ <b>BILLING</b> · 🏢 ${esc(a.name)}: ${what}.\nAlerts continue until ${a.paid_until ? new Date(a.paid_until).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "the paid period ends"}, then pause. Good moment to call them.`);
    }
    return { ok: true };
  }

  // Health check for /billing: keys work, plan exists, webhook secret present
  async function check() {
    const out = [];
    out.push(`Keys: ${KEY ? (KEY.startsWith("rzp_live_") ? "LIVE ✅" : KEY.startsWith("rzp_test_") ? "TEST ⚠️ (no real money)" : "set") : "❌ RAZORPAY_KEY_ID missing"}${SECRET ? "" : " · ❌ RAZORPAY_KEY_SECRET missing"}`);
    out.push(`Webhook secret: ${WH ? "✅ set" : "❌ RAZORPAY_WEBHOOK_SECRET missing"}`);
    if (enabled()) {
      try { const id = await ensurePlan(); const p = await rzp("GET", `/plans/${id}`); out.push(`Login to Razorpay: ✅\nMonthly plan: ✅ ${id} · ₹${(p.item.amount / 100).toLocaleString("en-IN")} / month`); }
      catch (e) { out.push(`Razorpay: ❌ ${e.message}`); }
    }
    return out.join("\n");
  }

  return { enabled, subscribe, webhook, check, payPage, payDone, price: PRICE };
};
