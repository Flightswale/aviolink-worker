"use strict";
/**
 * FlightAlert — Message Compiler v3 (professional alert format)
 * Passenger-first layout per operator spec; renders on all devices.
 * compile(parsed, agency) -> { whatsapp, emailSubject, emailBody }
 */

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MON = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(iso) {
  if (!iso) return null;
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return `${DAYS[dt.getUTCDay()]}, ${String(d).padStart(2,"0")} ${MON[m]} ${y}`;
}
function fmtDateShort(iso) {
  if (!iso) return "—";
  const [y,m,d] = iso.split("-").map(Number);
  return `${String(d).padStart(2,"0")} ${MON[m]}`;
}
function titleCase(name) {
  return String(name||"").toLowerCase().replace(/\//," / ")
    .replace(/\b[a-z]/g,(c)=>c.toUpperCase()).replace(/\s+/g," ").trim();
}
function sectorArrow(sector){ return sector ? sector.replace("-"," → ") : ""; }

function compile(parsed, agency = {}) {
  const A = { name: "Your Travel Agency", phone: "", footer: "", ...agency };
  const cancelled = parsed.changeType === "CANCELLATION";
  const anyNew = (parsed.segments || []).some((s) => s.new);
  const header = cancelled ? "🔴 *FLIGHT CANCELLATION ALERT*" : "🔔 *FLIGHT CHANGE ALERT*";

  const L = [header, "━━━━━━━━━━━━━━━", ""];

  // Passenger FIRST — the anchor when scanning many alerts
  const pax = (parsed.passengers || []).map(titleCase);
  if (pax.length === 1) L.push(`👤 *Passenger:* ${pax[0]}`);
  else if (pax.length > 1) { L.push(`👤 *Passengers:*`); pax.forEach((p)=>L.push(`   • ${p}`)); }
  else L.push(`👤 *Passenger:* (see booking)`);
  L.push(`🎫 *PNR:* ${parsed.pnr || "check original mail"}`);
  if (parsed.airline) L.push(`✈️ *Airline:* ${parsed.airline}`);
  L.push("");

  const segs = parsed.segments || [];
  segs.forEach((s, i) => {
    if (segs.length > 1) L.push(`*── Flight ${i + 1} ──*`);
    if (s.sector) L.push(`📍 *Sector:* ${sectorArrow(s.sector)}`);
    const dateLine = s.old && s.old.date ? fmtDate(s.old.date) : null;
    if (dateLine) L.push(`📅 *Date:* ${dateLine}`);
    if (s.old) {
      L.push(`❌ *${s.status === "CANCELLED" ? "Cancelled" : "Old timing"}:* ${s.old.flight || ""}`);
      if (s.old.dep) L.push(`   Dep ${s.old.dep}${s.old.arr ? " — Arr " + s.old.arr : ""}`);
    }
    if (s.new) {
      L.push(`✅ *New timing:* ${s.new.flight || ""}`);
      if (s.new.dep) L.push(`   Dep ${s.new.dep}${s.new.arr ? " — Arr " + s.new.arr : ""}`);
      if (s.new.date && s.old && s.new.date !== s.old.date) L.push(`   (now on ${fmtDate(s.new.date)})`);
    }
    L.push("");
  });

  L.push("━━━━━━━━━━━━━━━");
  if (cancelled && !anyNew) {
    L.push("*Your options:*");
    L.push("1️⃣ Book alternate flight");
    L.push("2️⃣ Full refund");
    L.push("");
    L.push("Reply *1* or *2*, or call us.");
  } else {
    if (parsed.actionDeadline) L.push(`⏰ *Confirm by:* ${fmtDateShort(parsed.actionDeadline)}`);
    L.push("Reply *YES* to accept the new");
    L.push("timing, or call us for options.");
  }
  L.push("");
  L.push(`*${A.name}*${A.phone ? `  📞 ${A.phone}` : ""}`);
  if (A.footer) L.push(`_${A.footer}_`);

  const whatsapp = L.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // ---------- email ----------
  const firstSector = segs[0]?.sector || "";
  const paxShort = pax.length ? ` | ${pax[0].split(" / ")[0]}${pax.length>1 ? " +"+(pax.length-1) : ""}` : "";
  const emailSubject = `${cancelled ? "FLIGHT CANCELLATION ALERT" : "FLIGHT CHANGE ALERT"} | ${firstSector}${paxShort} | PNR ${parsed.pnr || "?"}`.trim();
  const emailBody =
    `Dear Team,\n\nFlight ${cancelled ? "cancellation" : "schedule change"} detected for booking PNR ${parsed.pnr || "(see original mail)"}.\n\n` +
    (pax.length ? `Passenger(s): ${pax.join(", ")}\n\n` : "") +
    segs.map((s,i)=>{
      const rows=[];
      if (segs.length>1) rows.push(`Flight ${i+1}:`);
      if (s.sector) rows.push(`  Sector: ${sectorArrow(s.sector)}`);
      if (s.old) rows.push(`  ${s.status==="CANCELLED"?"CANCELLED":"OLD"}: ${s.old.flight||""} ${fmtDateShort(s.old.date)} ${s.old.dep||""}${s.old.arr?"–"+s.old.arr:""}`);
      if (s.new) rows.push(`  NEW: ${s.new.flight||""} ${fmtDateShort(s.new.date)} ${s.new.dep||""}${s.new.arr?"–"+s.new.arr:""}`);
      return rows.join("\n");
    }).join("\n\n") +
    `\n\n${cancelled && !anyNew ? "Options: alternate flight or full refund." : (parsed.actionDeadline ? `Confirm acceptance by ${fmtDateShort(parsed.actionDeadline)}.` : "Confirm acceptance at the earliest.")}\n` +
    `\n${A.name}${A.phone ? " · " + A.phone : ""}\nPowered by FlightAlert`;

  return { whatsapp, emailSubject, emailBody };
}

module.exports = { compile };
