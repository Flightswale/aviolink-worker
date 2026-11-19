"use strict";
/**
 * Aviolink billing — Razorpay Subscriptions (UPI AutoPay / card mandate), fully automatic.
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

  // Start a subscription for an agency → URL of Razorpay's payment page
  async function subscribe(agency, email) {
    if (!enabled()) throw new Error("Online payment is being set up — please WhatsApp +91 95032 55845 to subscribe.");
    // Reuse an unpaid subscription instead of creating a new one on every click
    if (agency.rzp_subscription_id) {
      try { const old = await rzp("GET", `/subscriptions/${agency.rzp_subscription_id}`);
        if (["created", "authenticated"].includes(old.status)) return payUrl(old.id); } catch (e) {}
    }
    const plan = await ensurePlan();
    // Customer record carries name, email, phone and GSTIN → Razorpay invoices are proper B2B GST invoices
    let customerId = null;
    try {
      const c = await rzp("POST", "/customers", { name: (agency.legal_name || agency.name).slice(0, 50), email: email || agency.notify_email || undefined,
        contact: String(agency.whatsapp || agency.owner_phone || "").replace(/[^\d+]/g, "") || undefined, gstin: agency.gstin || undefined, fail_existing: "0",
        notes: { agency_id: agency.id, billing_address: (agency.billing_address || "").slice(0, 250) } });
      customerId = c.id;
    } catch (e) { console.error("[billing] customer", e.message); }
    const sub = await rzp("POST", "/subscriptions", { plan_id: plan, total_count: 120, quantity: 1, customer_notify: 1, ...(customerId ? { customer_id: customerId } : {}),
      notes: { agency_id: agency.id, agency: agency.name, email: email || "" } });
    await sb.from("agencies").update({ rzp_subscription_id: sub.id }).eq("id", agency.id).then(() => {}, () => {});
    return payUrl(sub.id);
  }

  // Our own payment page with Razorpay Checkout (the Razorpay hosted subscription page is not enabled on this account)
  const API = (process.env.PUBLIC_API_URL || "https://api.aviolink.in").replace(/\/$/, "");
  const payUrl = (id) => `${API}/pay/${id}`;
  const h = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function payPage(subId) {
    if (!/^sub_[A-Za-z0-9]+$/.test(subId)) return null;
    const sub = await rzp("GET", `/subscriptions/${subId}`);
    const done = ["active", "authenticated"].includes(sub.status);
    let cust = {}; if (sub.customer_id) cust = await rzp("GET", `/customers/${sub.customer_id}`).catch(() => ({}));
    const opts = { key: KEY, subscription_id: subId, name: "Aviolink", description: `FlightAlert monthly · ₹${PRICE.toLocaleString("en-IN")} incl. GST`,
      image: "https://aviolink.in/assets/aviolink-icon-120.png", callback_url: `${API}/pay/${subId}/done`, prefill: { name: cust.name || "", email: cust.email || "", contact: cust.contact || "" },
      notes: sub.notes || {}, theme: { color: "#141B4D" } };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviolink — Subscribe</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#F3F5FB;color:#141B4D;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{background:#fff;border-radius:18px;padding:32px;max-width:420px;width:100%;box-shadow:0 10px 40px rgba(20,27,77,.12);text-align:center}h1{font-size:22px;margin:0 0 6px}p{color:#3F4865;line-height:1.5}
.p{font-size:34px;font-weight:800;margin:14px 0}button{background:#0E9F6E;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:17px;font-weight:700;cursor:pointer;width:100%}small{color:#5B6478}</style></head>
<body><div class="c"><img src="https://aviolink.in/assets/aviolink-icon-120.png" alt="" width="56" height="56"><h1>Aviolink FlightAlert</h1>
${done ? `<p>✅ This subscription is already active. Thank you!</p><p><a href="https://app.aviolink.in">Open your dashboard</a></p>` :
`<div class="p">₹${PRICE.toLocaleString("en-IN")}<span style="font-size:15px;font-weight:600;color:#5B6478"> / month incl. GST</span></div>
<p>Renews automatically every month by UPI AutoPay or card. Cancel any time.</p><button id="pay">Pay securely with Razorpay</button>
<p><small>Questions? WhatsApp +91 95032 55845 · support@aviolink.in</small></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>const o=${JSON.stringify(opts).replace(/</g, "\\u003c")};const r=new Razorpay(o);document.getElementById("pay").onclick=()=>r.open();r.open();</script>`}
</div></body></html>`;
  }
  async function payDone(subId, form) {
    const sig = crypto.createHmac("sha256", SECRET).update(`${form.razorpay_payment_id}|${subId}`).digest("hex");
    const ok = !!form.razorpay_signature && sig === form.razorpay_signature;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviolink</title></head>
<body style="font-family:system-ui,sans-serif;background:#F3F5FB;color:#141B4D;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px">
<div style="background:#fff;border-radius:18px;padding:32px;max-width:420px;text-align:center">${ok ? `<h1>✅ Payment successful</h1><p>Your subscription is active and renews automatically. A receipt will reach your email.</p>` : `<h1>Payment not completed</h1><p>Nothing was charged. <a href="${payUrl(h(subId))}">Try again</a> or WhatsApp +91 95032 55845.</p>`}
<p><a href="https://app.aviolink.in">Open your dashboard</a></p></div></body></html>`;
  }

  // Webhook: verify signature on the raw body, then apply
  async function webhook(raw, signature) {
    if (!WH) return { ok: false, err: "webhook secret not set" };
    const expect = crypto.createHmac("sha256", WH).update(raw).digest("hex");
    if (!signature || signature.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(signature))) return { ok: false, err: "bad signature" };
    const ev = JSON.parse(raw);
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
