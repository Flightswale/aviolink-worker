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
const AIRLINES = { "6E":"IndiGo","AI":"Air India","IX":"Air India Express","UK":"Vistara","SG":"SpiceJet","QP":"Akasa Air","9I":"Alliance Air","S5":"Star Air","EK":"Emirates","EY":"Etihad","QR":"Qatar Airways","SV":"Saudia","RX":"Riyadh Air","GF":"Gulf Air","WY":"Oman Air","FZ":"flydubai","G9":"Air Arabia","KU":"Kuwait Airways","TK":"Turkish Airlines","LH":"Lufthansa","BA":"British Airways","AF":"Air France","KL":"KLM","LX":"Swiss","OS":"Austrian","SQ":"Singapore Airlines","TG":"Thai Airways","MH":"Malaysia Airlines","CX":"Cathay Pacific","QF":"Qantas","UL":"SriLankan","VS":"Virgin Atlantic","UA":"United","DL":"Delta","AA":"American Airlines","AC":"Air Canada","ET":"Ethiopian","KQ":"Kenya Airways","NH":"ANA","JL":"Japan Airlines","KE":"Korean Air","OZ":"Asiana","VN":"Vietnam Airlines","PR":"Philippine Airlines","GA":"Garuda","AK":"AirAsia","D7":"AirAsia X","FD":"Thai AirAsia","TR":"Scoot","3K":"Jetstar Asia","BG":"Biman","RA":"Nepal Airlines","KB":"Druk Air","B3":"Bhutan Airlines","AZ":"ITA Airways","IB":"Iberia","TP":"TAP Portugal","LO":"LOT","SK":"SAS","AY":"Finnair","EI":"Aer Lingus","U2":"easyJet","FR":"Ryanair","DP":"Pobeda","SU":"Aeroflot","S7":"S7 Airlines","U6":"Ural Airlines","UT":"UTair","FV":"Rossiya","N4":"Nordwind","W6":"Wizz Air","PC":"Pegasus","VF":"AJet","XQ":"SunExpress","J9":"Jazeera Airways","OV":"SalamAir","F3":"flyadeal","XY":"flynas","MS":"EgyptAir","RJ":"Royal Jordanian","ME":"Middle East Airlines","HY":"Uzbekistan Airways","KC":"Air Astana","J2":"Azerbaijan Airlines","PS":"Ukraine Intl","5J":"Cebu Pacific","VJ":"VietJet","Z2":"AirAsia Philippines","OD":"Batik Air","BS":"US-Bangla","VQ":"Novoair","H9":"Himalaya Airlines","Q2":"Maldivian","CA":"Air China","MU":"China Eastern","CZ":"China Southern","HU":"Hainan Airlines","BR":"EVA Air","CI":"China Airlines","WS":"WestJet","AS":"Alaska Airlines","B6":"JetBlue","WN":"Southwest","AM":"Aeroméxico","LA":"LATAM","AV":"Avianca","CM":"Copa","VY":"Vueling","SN":"Brussels Airlines","A3":"Aegean","DE":"Condor","EW":"Eurowings","DY":"Norwegian","HV":"Transavia","LG":"Luxair","TO":"Transavia France","WY":"Oman Air","UL":"SriLankan","MK":"Air Mauritius","WB":"RwandAir","SA":"South African Airways" };
function airlineName(code){ const c=String(code||"").toUpperCase().trim(); return AIRLINES[c] ? `${AIRLINES[c]} (${c})` : code; }
function sectorArrow(sector){ return sector ? sector.replace("-"," → ") : ""; }

function compile(parsed, agency = {}) {
  const A = { name: "Your Travel Agency", phone: "", footer: "", ...agency };
  const cancelled = parsed.changeType === "CANCELLATION";
  const anyNew = (parsed.segments || []).some((s) => s.new);
  const header = cancelled ? "🔴 *FLIGHT CANCELLATION ALERT*" : "🔔 *FLIGHT CHANGE ALERT*";

  const L = [header, "━━━━━━━━━━━━━━━", ""];

  // Passenger FIRST — the anchor when scanning many alerts
  const pax = (parsed.passengers || []).map(titleCase);
  const extra = parsed.paxCount && parsed.paxCount > pax.length ? ` + ${parsed.paxCount - pax.length}` : "";
  if (pax.length === 1) L.push(`👤 *Passenger:* ${pax[0]}${extra}`);
  else if (pax.length > 1) { L.push(`👤 *Passengers:*`); pax.forEach((p)=>L.push(`   • ${p}`)); if (extra) L.push(`   • and${extra} more`); }
  else L.push(`👤 *Passenger:* (see booking)${extra}`);
  L.push(`🎫 *PNR:* ${parsed.pnr || "check original mail"}`);
  if (parsed.airline) L.push(`✈️ *Airline:* ${airlineName(parsed.airline)}`);
  L.push("");

  const segs = parsed.segments || [];
  const t = (x) => x ? `${x.dep || "--:--"} – ${x.arr || "--:--"}${x.arrDayOffset ? " (+" + x.arrDayOffset + ")" : ""}` : "";
  // Two short lines per leg so nothing wraps on a phone screen
  const line = (s, leg, mark) => `${leg.flight || s.sector || "Flight"} · ${sectorArrow(s.sector)} · ${fmtDateShort(leg.date)}\n      ${mark ? "*" + t(leg) + "* ⬅️" : t(leg)}`;
  const hasAnyOld = segs.some((s) => s.old && (s.old.dep || s.old.arr));
  const changedIdx = new Set(segs.map((s, i) => (s.status !== "UNCHANGED" && s.new && s.old && (s.old.dep !== s.new.dep || s.old.arr !== s.new.arr || s.old.date !== s.new.date || s.old.flight !== s.new.flight)) ? i : -1).filter((i) => i >= 0));

  if (cancelled) {
    segs.forEach((s) => {
      if (s.old) L.push(`❌ *Cancelled:* ${line(s, s.old, false)}`);
      if (s.new) L.push(`✅ *Alternate:* ${line(s, s.new, false)}`);
    });
    L.push("");
  } else {
    if (hasAnyOld) {
      L.push("*Old timings*");
      segs.forEach((s) => { if (s.old) L.push(line(s, s.old, false)); });
      L.push("");
    }
    L.push(hasAnyOld ? "*New timings*" : "*Revised timings*");
    segs.forEach((s, i) => { const leg = s.new || s.old; if (leg) L.push(line(s, leg, changedIdx.has(i))); });
    L.push("");
  }

  L.push("━━━━━━━━━━━━━━━");
  if (cancelled && !anyNew) {
    L.push("*Your options:*");
    L.push("1️⃣ Book alternate flight");
    L.push("2️⃣ Full refund");
    L.push("");
    L.push("Reply *1* or *2*, or call us.");
  } else {
    if (parsed.actionDeadline) L.push(`⏰ *Confirm by:* ${fmtDateShort(parsed.actionDeadline)}`);
    L.push("For any queries, please contact");
  }
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
