"use strict";
/**
 * Cleartrip B2B schedule-change mails (kind: SCHEDULE_CHANGE).
 * Built from real traffic (Aug 2026):
 *
 * Format A — "Flight Time Changed" table mail (help.b2b@cleartrip.com):
 *   Subject: "... Flight Time Changed - Booking Refno : FBB7SVA7 - AirlinePnr : KEBDPW - Sector : PNQ-DEL - Travel Date : 29 Aug 2026"
 *   Body: Existing vs Updated columns; "Flight Details: PNQ-DEL--937";
 *         "Departure Date: 29/08/2026 05:55:00" (old) / "Departure Date: 29/08/2026 09:50:00" (new)
 *   Passenger List: "Mr TATYASAHEB LAXMAN INGALE|Mr SHARDUL TATYASAHEB INGALE"
 *
 * Format B — "Airline Schedule change - CTxxxxxxx" (airamend.b2b@cleartrip.com):
 *   GDS-style: PNR line "8AYCHU", pax "1.SHENDKAR/KETKI PRANAV MS(ADT)",
 *   segment "3 EW3049 E 18SEP 5 CDGPRG UN2  2015 2200  *1A/E*"
 */

const SEG_B =
  /(\d)\s+([A-Z]{2})\s?(\d{2,4})\s+[A-Z]\s+(\d{1,2}[A-Z]{3})\s+\d\s+([A-Z]{3})([A-Z]{3})\s+(UN|UC|HX|NO|WK|TK|TL|SC|KK|HK)(\d)\s+(\d{4})\s+(\d{4})/;

function inferYear(ddmmm, H) {
  const iso = H.parseDate(ddmmm + String(new Date().getFullYear()).slice(2));
  if (!iso) return null;
  if (Date.now() - new Date(iso).getTime() > 30 * 86400000) {
    return H.parseDate(ddmmm + String(new Date().getFullYear() + 1).slice(2));
  }
  return iso;
}

module.exports = {
  name: "cleartrip-b2b-v1",
  priority: 11,
  match: (email) =>
    /cleartrip\.com/i.test(email.from || "") ||
    /cleartrip\.com/i.test(email.originalFrom || "") ||
    /Greetings from Cleartrip/i.test(email.body),
  parse: (email, H) => {
    const b = email.body;
    const subj = email.subject || "";

    // ---------- Format A: table-style "Flight Time Changed" ----------
    if (/Flight Time Changed|Existing Flight Details/i.test(subj + " " + b)) {
      const pnr =
        (subj.match(/AirlinePnr\s*:\s*([A-Z0-9]{6})/i) || b.match(/AIRLINE PNR\s*:?\s*([A-Z0-9]{6})/i) || [])[1] || null;
      const refno =
        (subj.match(/Refno\s*:\s*([A-Z0-9]+)/i) || b.match(/REFERENCE NO\s*:?\s*([A-Z0-9]+)/i) || [])[1] || null;
      const sector = H.normSector((subj.match(/Sector\s*:\s*([A-Z]{3}\s*-\s*[A-Z]{3})/i) || b.match(/([A-Z]{3})-([A-Z]{3})--\d+/) || [])[0] || "");
      const flightNum = (b.match(/[A-Z]{3}-[A-Z]{3}--(\d{2,4})/) || [])[1] || null;

      // Departure/Arrival lines appear as pairs: first occurrence = existing, "Departure Date:"-labelled = updated (order varies in text extraction; collect all datetimes near labels)
      const dts = [...b.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):\d{2}/g)].map((m) => ({
        date: `${m[3]}-${m[2]}-${m[1]}`, time: `${m[4]}:${m[5]}`,
      }));
      // Expect 4: oldDep, newDep, oldArr, newArr (as in real sample: 05:55, 09:50, 08:30, 12:25)
      if (!pnr && !refno) return null;
      if (dts.length < 2) return null;
      const [oldDep, newDep, oldArr, newArr] = [dts[0], dts[1], dts[2] || null, dts[3] || null];

      const passengers = [];
      const paxLine = (b.match(/Passenger List\s*\n?([^\n]+)/i) || [])[1];
      if (paxLine) paxLine.split("|").forEach((p) => { const t = p.trim(); if (t) passengers.push(t); });

      return {
        pnr: pnr || refno,
        airline: null,
        changeType: "TIME_CHANGE",
        passengers,
        segments: [{
          status: "CHANGED",
          sector,
          old: { flight: flightNum ? `-- ${flightNum}` : null, date: oldDep.date, dep: oldDep.time, arr: oldArr ? oldArr.time : null },
          new: newDep ? { flight: flightNum ? `-- ${flightNum}` : null, date: newDep.date, dep: newDep.time, arr: newArr ? newArr.time : null } : null,
        }],
        actionDeadline: null,
        bookingRef: refno,
      };
    }

    // ---------- Format B: GDS-style "Airline Schedule change" ----------
    const pnr = (b.match(/^\s*([A-Z0-9]{6})\s*$/m) || [])[1] || null;
    const passengers = [];
    const paxRe = /\d\.\s*([A-Z][A-Z' ]+\/[A-Z][A-Z' ]+?\s*(?:MR|MRS|MS|MISS|MSTR|CHD|INF|DR))\s*\((?:ADT|CHD|INF)\)/g;
    let pm;
    while ((pm = paxRe.exec(b)) !== null) passengers.push(pm[1].replace(/\s+/g, " ").trim());

    const legs = [];
    // Segment may wrap across lines in extraction; scan windows of 2 joined NON-EMPTY lines.
    const lines = b.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const joined = (lines[i] + " " + (lines[i + 1] || "")).trim();
      const m = joined.match(SEG_B);
      if (m) {
        legs.push({
          flight: H.normFlight(`${m[2]}${m[3]}`),
          date: inferYear(m[4], H),
          sector: `${m[5]}-${m[6]}`,
          status: m[7],
          dep: H.parseTime(m[9]),
          arr: H.parseTime(m[10]),
        });
      }
    }
    if (!pnr || legs.length === 0) return null;

    const OLD = new Set(["UN", "UC", "HX", "NO", "WK"]);
    const NEW = new Set(["TK", "TL", "SC", "KK"]);
    const segments = [];
    const used = new Set();
    for (const o of legs.filter((l) => OLD.has(l.status))) {
      const nu = legs.find((l) => NEW.has(l.status) && l.sector === o.sector && !used.has(l));
      if (nu) used.add(nu);
      segments.push({
        status: nu ? "CHANGED" : "CANCELLED",
        sector: o.sector,
        old: { flight: o.flight, date: o.date, dep: o.dep, arr: o.arr },
        new: nu ? { flight: nu.flight, date: nu.date, dep: nu.dep, arr: nu.arr } : null,
      });
    }
    for (const nu of legs.filter((l) => NEW.has(l.status) && !used.has(l))) {
      if (segments.some((s) => s.sector === nu.sector)) continue;
      segments.push({ status: "CHANGED", sector: nu.sector, old: { flight: nu.flight, date: nu.date, dep: nu.dep, arr: nu.arr }, new: { flight: nu.flight, date: nu.date, dep: nu.dep, arr: nu.arr } });
    }
    if (!segments.length) return null;

    return {
      pnr,
      airline: segments[0].old.flight ? segments[0].old.flight.split(" ")[0] : null,
      changeType: segments.every((s) => s.status === "CANCELLED") ? "CANCELLATION" : "TIME_CHANGE",
      passengers,
      segments,
      actionDeadline: null,
    };
  },
};
