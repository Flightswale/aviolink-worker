"use strict";
/**
 * Aviolink GST tax invoices — one per captured payment, numbered AV/26-27/0001 (≤16 chars, restarts each April).
 * Supplier: FINCH TRAVELS (GSTIN 27AAKFF5906A1ZO, Maharashtra). Price is GST-inclusive (₹2,359 = taxable + 18%).
 * Place of supply = buyer's state (from GSTIN, else billing address); unknown → Maharashtra.
 * Same state → CGST 9% + SGST 9%; other state → IGST 18%.
 */
const PDFDocument = require("pdfkit");

const SUPPLIER = {
  legal: "FINCH TRAVELS", brand: "Aviolink — a brand of Finch Travels",
  gstin: process.env.SUPPLIER_GSTIN || "27AAKFF5906A1ZO", state: "Maharashtra", stateCode: "27",
  address: "C-304, 3rd Floor, Newton Homes, Near Runwal Seagull, Handewadi Road, Hadapsar, Pune, Maharashtra 411028",
  email: "support@aviolink.in", phone: "+91 95032 55845", web: "aviolink.in",
};
const SAC = process.env.AVIOLINK_SAC || "998315";
const STATES = { "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh" };

const r2 = (x) => Math.round(x * 100) / 100;
function fyOf(d) { const ist = new Date(d.getTime() + 5.5 * 3600000); const y = ist.getUTCFullYear(), m = ist.getUTCMonth(); const s = m >= 3 ? y : y - 1; return `${String(s).slice(2)}-${String(s + 1).slice(2)}`; }
function stateOf(agency) {
  const g = String(agency.gstin || "").toUpperCase();
  if (/^\d{2}[A-Z0-9]{13}$/.test(g) && STATES[g.slice(0, 2)]) return g.slice(0, 2);
  const addr = String(agency.billing_address || "").toLowerCase();
  for (const [code, name] of Object.entries(STATES)) if (addr.includes(name.toLowerCase())) return code;
  if (/\b(mumbai|pune|nagpur|nashik|thane|aurangabad)\b/.test(addr)) return "27";
  return SUPPLIER.stateCode;
}
function words(n) {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x) => (x < 20 ? a[x] : `${b[Math.floor(x / 10)]}${x % 10 ? " " + a[x % 10] : ""}`);
  const three = (x) => (x >= 100 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x));
  if (n === 0) return "Zero";
  let out = [], cr = Math.floor(n / 1e7), lk = Math.floor((n % 1e7) / 1e5), th = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  if (cr) out.push(`${two(cr)} Crore`); if (lk) out.push(`${two(lk)} Lakh`); if (th) out.push(`${two(th)} Thousand`); if (rest) out.push(three(rest));
  return out.join(" ");
}
const inr = (x) => Number(x).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = function makeInvoices({ sb }) {
  // Create (once) the invoice for a payment. Returns the invoice row.
  async function create(agency, pay) {
    const { data: have } = await sb.from("invoices").select("*").eq("payment_id", pay.id).maybeSingle();
    if (have) return have;
    const total = r2((pay.amount || 0) / 100);
    const taxable = r2(total / 1.18), tax = r2(total - taxable);
    const pos = stateOf(agency), intra = pos === SUPPLIER.stateCode;
    const date = new Date(pay.created_at ? pay.created_at * 1000 : Date.now()), fy = fyOf(date);
    const row = { payment_id: pay.id, agency_id: agency.id, fy, issued_at: date.toISOString(),
      buyer_name: (agency.legal_name || agency.name || "").slice(0, 120), buyer_gstin: agency.gstin || null, buyer_address: agency.billing_address || null,
      buyer_email: agency.notify_email || null, place_of_supply: pos, sac: SAC, period_from: agency._from || null, period_to: agency._to || null,
      taxable, cgst: intra ? r2(tax / 2) : 0, sgst: intra ? r2(tax - r2(tax / 2)) : 0, igst: intra ? 0 : tax, total, method: pay.method || null };
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: last } = await sb.from("invoices").select("seq").eq("fy", fy).order("seq", { ascending: false }).limit(1);
      const seq = (last?.[0]?.seq || 0) + 1;
      const no = `AV/${fy}/${String(seq).padStart(4, "0")}`;
      const { data, error } = await sb.from("invoices").insert({ ...row, seq, invoice_no: no }).select("*").single();
      if (!error) return data;
      if (/payment_id/.test(error.message)) { const { data: d } = await sb.from("invoices").select("*").eq("payment_id", pay.id).maybeSingle(); if (d) return d; }
      if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    }
    throw new Error("could not number invoice");
  }

  function pdf(inv) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Tax Invoice ${inv.invoice_no}`, Author: SUPPLIER.legal } });
      const bufs = []; doc.on("data", (b) => bufs.push(b)); doc.on("end", () => resolve(Buffer.concat(bufs))); doc.on("error", reject);
      const navy = "#141B4D", mut = "#5B6478", W = 499, L = 48;
      const d = new Date(inv.issued_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
      doc.fillColor(navy).font("Helvetica-Bold").fontSize(20).text("TAX INVOICE", L, 48);
      doc.font("Helvetica").fontSize(9).fillColor(mut).text("Original for recipient", L, 72);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(navy).text(`Invoice no: ${inv.invoice_no}`, 330, 50, { width: 217, align: "right" })
        .font("Helvetica").text(`Date: ${d}`, 330, 64, { width: 217, align: "right" });
      doc.moveTo(L, 92).lineTo(L + W, 92).strokeColor("#D7DBE8").stroke();
      // Supplier / buyer
      doc.font("Helvetica-Bold").fontSize(9).fillColor(mut).text("FROM", L, 104).text("BILL TO", 310, 104);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(navy).text(SUPPLIER.legal, L, 118, { width: 240 });
      doc.font("Helvetica").fontSize(9).fillColor("#222").text(`${SUPPLIER.brand}\n${SUPPLIER.address}\nGSTIN: ${SUPPLIER.gstin}  ·  State: ${SUPPLIER.state} (${SUPPLIER.stateCode})\n${SUPPLIER.email}  ·  ${SUPPLIER.phone}`, L, 134, { width: 240 });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(navy).text(inv.buyer_name || "-", 310, 118, { width: 237 });
      doc.font("Helvetica").fontSize(9).fillColor("#222").text(`${inv.buyer_address || ""}\nGSTIN: ${inv.buyer_gstin || "Unregistered"}\nPlace of supply: ${STATES[inv.place_of_supply] || ""} (${inv.place_of_supply})${inv.buyer_email ? "\n" + inv.buyer_email : ""}`, 310, 134, { width: 237 });
      // Table
      let y = 228;
      const cols = [[L, 28, "#"], [L + 28, 230, "Description"], [L + 258, 56, "SAC"], [L + 314, 40, "Qty"], [L + 354, 70, "Rate"], [L + 424, 75, "Amount (INR)"]];
      doc.rect(L, y, W, 22).fill("#EEF0F7");
      doc.fillColor(navy).font("Helvetica-Bold").fontSize(9);
      cols.forEach(([x, w, t], i) => doc.text(t, x + 4, y + 7, { width: w - 8, align: i >= 3 ? "right" : "left" }));
      y += 30;
      const per = inv.period_from && inv.period_to ? `\nService period: ${new Date(inv.period_from).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })} – ${new Date(inv.period_to).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}` : "";
      doc.font("Helvetica").fillColor("#222").fontSize(9);
      doc.text("1", cols[0][0] + 4, y, { width: 20 });
      doc.text(`Aviolink FlightAlert — online flight-change alert service, 1 month subscription${per}`, cols[1][0] + 4, y, { width: cols[1][1] - 8 });
      doc.text(inv.sac, cols[2][0] + 4, y, { width: 48 });
      doc.text("1", cols[3][0] + 4, y, { width: 32, align: "right" });
      doc.text(inr(inv.taxable), cols[4][0] + 4, y, { width: 62, align: "right" });
      doc.text(inr(inv.taxable), cols[5][0] + 4, y, { width: 67, align: "right" });
      y += 48;
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor("#D7DBE8").stroke(); y += 10;
      const line = (label, val, bold) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(bold ? navy : "#222")
        .text(label, 300, y, { width: 140, align: "right" }).text(val, 440, y, { width: 107, align: "right" }); y += bold ? 20 : 16; };
      line("Taxable value", inr(inv.taxable));
      if (Number(inv.igst)) line("IGST @ 18%", inr(inv.igst)); else { line("CGST @ 9%", inr(inv.cgst)); line("SGST @ 9%", inr(inv.sgst)); }
      doc.moveTo(300, y).lineTo(L + W, y).strokeColor("#D7DBE8").stroke(); y += 6;
      line("Total (INR)", inr(inv.total), true);
      const rupees = Math.floor(inv.total), paise = Math.round((inv.total - rupees) * 100);
      doc.font("Helvetica").fontSize(9).fillColor("#222").text(`Amount in words: Indian Rupees ${words(rupees)}${paise ? ` and ${words(paise)} Paise` : ""} only.`, L, y + 6, { width: W });
      y += 34;
      doc.text(`Tax payable on reverse charge: No.   Paid online via Razorpay (${String(inv.method || "").toUpperCase() || "online"}), ref ${inv.payment_id}.`, L, y, { width: W });
      y += 40;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(navy).text(`For ${SUPPLIER.legal}`, 330, y, { width: 217, align: "right" });
      doc.font("Helvetica").fontSize(8.5).fillColor(mut).text("This is a computer-generated invoice and does not need a signature.", 230, y + 34, { width: 317, align: "right" });
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor(mut).text(`${SUPPLIER.brand}  ·  ${SUPPLIER.web}  ·  ${SUPPLIER.email}`, L, 790, { width: W, align: "center", lineBreak: false });
      doc.end();
    });
  }

  // GSTR-1 style register for a month (YYYY-MM) as CSV
  async function register(month) {
    const from = new Date(`${month}-01T00:00:00+05:30`), to = new Date(from); to.setMonth(to.getMonth() + 1);
    const { data } = await sb.from("invoices").select("*").gte("issued_at", from.toISOString()).lt("issued_at", to.toISOString()).order("seq");
    const rows = data || [];
    const head = ["Invoice no", "Date", "Buyer", "Buyer GSTIN", "Type", "Place of supply", "SAC", "Taxable", "CGST", "SGST", "IGST", "Total", "Payment ref"];
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [r.invoice_no, new Date(r.issued_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), r.buyer_name, r.buyer_gstin || "", r.buyer_gstin ? "B2B" : "B2C",
      `${r.place_of_supply}-${STATES[r.place_of_supply] || ""}`, r.sac, r.taxable, r.cgst, r.sgst, r.igst, r.total, r.payment_id].map(q).join(","));
    const sum = (k) => r2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
    lines.push(["TOTAL", "", `${rows.length} invoices`, "", "", "", "", sum("taxable"), sum("cgst"), sum("sgst"), sum("igst"), sum("total"), ""].map(q).join(","));
    return { csv: "﻿" + head.map(q).join(",") + "\n" + lines.join("\n") + "\n", count: rows.length, total: sum("total"), tax: r2(sum("cgst") + sum("sgst") + sum("igst")) };
  }

  return { create, pdf, register, SUPPLIER, SAC };
};
