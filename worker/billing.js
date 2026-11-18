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
    if (!enabled()) throw new Error("Online payment is being set up — please WhatsApp +91 92705 46474 to subscribe.");
    const plan = await ensurePlan();
    const sub = await rzp("POST", "/subscriptions", { plan_id: plan, total_count: 120, quantity: 1, customer_notify: 1,
      notes: { agency_id: agency.id, agency: agency.name, email: email || "" } });
    await sb.from("agencies").update({ rzp_subscription_id: sub.id }).eq("id", agency.id).then(() => {}, () => {});
    return sub.short_url;
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

  return { enabled, subscribe, webhook, price: PRICE };
};
