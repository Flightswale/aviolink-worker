#!/usr/bin/env python3
"""Builds the multi-page aviolink.in static site into OUT (Netlify drag & drop)."""
import os, shutil, textwrap

OUT = os.environ.get("SITE_OUT", "/mnt/user-data/outputs/aviolink-site")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT + "/assets", exist_ok=True)
for _f in ["mark.svg","logo-dark.svg","logo-light.svg","aviolink-icon-640.png","aviolink-icon-120.png","aviolink-logo-light.png","aviolink-logo-dark.png"]:
    shutil.copy(os.path.join(os.path.dirname(__file__),"logo",_f), OUT+"/assets/"+_f)

PHONE = "+91 92705 46474"
PHONE_WA = "919270546474"
EMAIL = "support@aviolink.in"
ENTITY = "Finch Travels"          # update after incorporation
ADDRESS = "Office No. C-304, Newton Homes, Near Runwal Seagull, Shriram Chowk, Handewadi Road, Hadapsar, Pune 411028, Maharashtra, India"
UPDATED = "17 October 2026"
API = "https://api.aviolink.in"

CSS = r"""
:root{--navy:#141B4D;--navy2:#1E2761;--amber:#F59E0B;--amber2:#FBBF24;--ink:#0F172A;--muted:#5B6478;--line:#E3E8F2;--ice:#F4F7FD;--ok:#10B981;--bad:#EF4444;--radius:16px}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:#fff;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit}
img{max-width:100%}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}
.narrow{max-width:820px}
/* header */
header.site{position:sticky;top:0;z-index:50;background:rgba(20,27,77,.96);backdrop-filter:blur(8px);color:#fff}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:68px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.3rem;text-decoration:none;letter-spacing:-.02em}
.logo .mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--amber),#F97316);display:grid;place-items:center;font-size:1.05rem}
.logo b{color:var(--amber)}
nav.main{display:flex;align-items:center;gap:26px}
nav.main a{text-decoration:none;font-weight:600;font-size:.94rem;color:#D6DDF5}
nav.main a:hover,nav.main a.on{color:#fff}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;border:none;cursor:pointer;font:inherit;font-weight:700;border-radius:10px;padding:12px 22px;text-decoration:none;transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(-1px)}
.btn-amber{background:var(--amber);color:#2A1D00;box-shadow:0 6px 20px rgba(245,158,11,.35)}
.btn-ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.35)}
.btn-navy{background:var(--navy2);color:#fff}
.btn-white{background:#fff;color:var(--ink);border:1.5px solid var(--line)}
.btn-lg{padding:15px 28px;font-size:1.03rem}
nav.main .btn{color:#2A1D00;padding:10px 18px}
.menu-t{display:none;background:none;border:none;color:#fff;font-size:1.6rem;cursor:pointer}
@media(max-width:900px){nav.main{display:none;position:absolute;top:68px;left:0;right:0;background:var(--navy);flex-direction:column;padding:18px 20px 24px;gap:16px;align-items:flex-start}nav.main.open{display:flex}.menu-t{display:block}}
/* hero */
.hero{background:radial-gradient(1200px 500px at 85% -10%,rgba(245,158,11,.18),transparent 60%),linear-gradient(180deg,var(--navy) 0%,var(--navy2) 100%);color:#fff;padding:80px 0 90px;overflow:hidden}
.hero .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center}
.eyebrow{display:inline-flex;gap:8px;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:6px 14px;border-radius:999px;font-size:.82rem;font-weight:600;color:#E4E9FA}
.hero h1{font-size:clamp(2.1rem,4.4vw,3.4rem);line-height:1.12;letter-spacing:-.03em;margin:18px 0}
.hero h1 em{font-style:normal;color:var(--amber2)}
.hero p.lead{color:#C9D3F2;font-size:1.1rem;max-width:560px}
.hero .cta{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}
.hero .fine{color:#9FB0E0;font-size:.85rem;margin-top:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
.chip{font-size:.8rem;font-weight:600;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#E4E9FA}
@media(max-width:900px){.hero .grid{grid-template-columns:1fr}.hero{padding:56px 0 64px}}
/* phone */
.phone{width:320px;max-width:100%;margin:0 auto;background:#0B1023;border-radius:38px;padding:12px;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 2px rgba(255,255,255,.06)}
.phone .scr{background:#ECE5DD;border-radius:28px;overflow:hidden}
.phone .bar{background:#075E54;color:#fff;padding:14px 16px;font-size:.85rem;font-weight:700;display:flex;gap:10px;align-items:center}
.phone .bar .av{width:30px;height:30px;border-radius:50%;background:var(--amber);display:grid;place-items:center;color:#2A1D00;font-size:.8rem}
.bubble{background:#fff;margin:14px;border-radius:10px;padding:12px 14px;font-size:.78rem;line-height:1.5;color:#111;white-space:pre-line;font-family:system-ui,sans-serif;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.bubble b{font-weight:700}
.bubble .t{display:block;text-align:right;color:#8a8a8a;font-size:.68rem;margin-top:4px}
/* sections */
section{padding:84px 0}
section.alt{background:var(--ice)}
.kicker{color:var(--amber);font-weight:800;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}
h2.sec{font-size:clamp(1.7rem,3vw,2.4rem);letter-spacing:-.025em;line-height:1.2;margin:10px 0 14px;color:var(--navy)}
p.sub{color:var(--muted);font-size:1.05rem;max-width:680px}
.center{text-align:center}.center p.sub{margin:0 auto}
.cards{display:grid;gap:20px;margin-top:40px}
.c3{grid-template-columns:repeat(3,1fr)}.c4{grid-template-columns:repeat(4,1fr)}.c2{grid-template-columns:repeat(2,1fr)}
@media(max-width:900px){.c3,.c4,.c2{grid-template-columns:1fr}}
@media(min-width:600px) and (max-width:900px){.c4{grid-template-columns:1fr 1fr}}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:26px;transition:box-shadow .2s,transform .2s}
.card:hover{box-shadow:0 14px 40px rgba(20,27,77,.08);transform:translateY(-2px)}
.card .ic{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:1.35rem;background:var(--ice);margin-bottom:14px}
.card h3{font-size:1.08rem;color:var(--navy);margin-bottom:6px}
.card p{color:var(--muted);font-size:.95rem}
.tag{display:inline-block;font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:999px;background:#FEF3C7;color:#92400E;margin-bottom:10px}
.tag.live{background:#D1FAE5;color:#065F46}
/* steps */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:44px;counter-reset:s}
.step{position:relative;padding:28px;border-radius:var(--radius);background:#fff;border:1px solid var(--line)}
.step .n{width:40px;height:40px;border-radius:50%;background:var(--navy2);color:#fff;font-weight:800;display:grid;place-items:center;margin-bottom:14px}
.step h3{color:var(--navy);font-size:1.08rem;margin-bottom:6px}.step p{color:var(--muted);font-size:.95rem}
@media(max-width:900px){.steps{grid-template-columns:1fr}}
/* split */
.split{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center}
@media(max-width:900px){.split{grid-template-columns:1fr}}
ul.ticks{list-style:none;margin-top:18px}
ul.ticks li{padding-left:30px;position:relative;margin:12px 0;color:#2B3245}
ul.ticks li:before{content:"✓";position:absolute;left:0;top:0;width:20px;height:20px;border-radius:50%;background:#D1FAE5;color:#065F46;font-size:.75rem;font-weight:800;display:grid;place-items:center}
/* band */
.band{background:linear-gradient(135deg,var(--navy2),var(--navy));color:#fff;border-radius:24px;padding:52px;display:flex;justify-content:space-between;align-items:center;gap:28px;flex-wrap:wrap}
.band h2{font-size:clamp(1.5rem,2.6vw,2.1rem);letter-spacing:-.02em}
.band p{color:#C9D3F2;margin-top:6px}
/* page hero */
.phero{background:linear-gradient(180deg,var(--navy) 0%,var(--navy2) 100%);color:#fff;padding:64px 0 58px}
.phero h1{font-size:clamp(1.9rem,3.6vw,2.8rem);letter-spacing:-.03em;line-height:1.15;margin-top:10px}
.phero p{color:#C9D3F2;font-size:1.08rem;max-width:700px;margin-top:12px}
/* pricing */
.price{border:1.5px solid var(--line);border-radius:20px;padding:32px;background:#fff;display:flex;flex-direction:column}
.price.hot{border-color:var(--amber);box-shadow:0 18px 50px rgba(245,158,11,.18);position:relative}
.price.hot:before{content:"Most popular";position:absolute;top:-13px;left:28px;background:var(--amber);color:#2A1D00;font-size:.75rem;font-weight:800;padding:4px 12px;border-radius:999px}
.price h3{color:var(--navy);font-size:1.2rem}
.price .amt{font-size:2.4rem;font-weight:800;letter-spacing:-.03em;margin:12px 0 2px;color:var(--ink)}
.price .amt small{font-size:.95rem;color:var(--muted);font-weight:600}
.price .gst{color:var(--muted);font-size:.82rem}
.price ul{flex:1}
.price .btn{margin-top:22px;width:100%}
/* faq */
details{border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:12px 0;background:#fff}
details summary{font-weight:700;cursor:pointer;color:var(--navy);list-style:none}
details summary::-webkit-details-marker{display:none}
details summary:after{content:"+";float:right;font-weight:800;color:var(--amber)}
details[open] summary:after{content:"–"}
details p{color:var(--muted);margin-top:10px}
/* legal */
.legal h2{color:var(--navy);font-size:1.2rem;margin:30px 0 8px}
.legal p,.legal li{color:#2B3245;margin:8px 0}
.legal ul,.legal ol{padding-left:22px}
.legal .meta{color:var(--muted);font-size:.9rem}
/* forms */
.formcard{background:#fff;border:1px solid var(--line);border-radius:22px;padding:34px;box-shadow:0 20px 60px rgba(20,27,77,.08)}
label{display:block;font-weight:700;font-size:.86rem;margin:16px 0 6px;color:var(--navy)}
input,textarea{width:100%;padding:12px 14px;border:1.5px solid var(--line);border-radius:10px;font:inherit;font-size:.95rem;background:#fff}
input:focus,textarea:focus{outline:none;border-color:var(--amber);box-shadow:0 0 0 4px rgba(245,158,11,.15)}
.hint{font-size:.78rem;color:#8a93a6;margin-top:5px}
.gbtn{width:100%;background:#fff;color:#1f2937;border:1.5px solid #CBD3E3;font-weight:700;padding:14px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:1rem;cursor:pointer;margin-top:24px}
.gbtn:hover{border-color:#94A3C4;background:#FAFBFE}
.gbtn img{width:20px}
.or{display:flex;align-items:center;gap:12px;color:#94A3B8;font-size:.82rem;margin:16px 0}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--line)}
.ebtn{width:100%;background:var(--navy2);color:#fff;border:none;font-weight:700;padding:14px;border-radius:10px;font-size:1rem;cursor:pointer}
.msg-ok{display:none;background:#ECFDF5;border:1.5px solid var(--ok);border-radius:14px;padding:20px;line-height:1.6}
.msg-err{display:none;background:#FEF2F2;border:1.5px solid var(--bad);border-radius:12px;padding:12px 14px;margin-top:14px;color:#991B1B;font-size:.9rem}
code{background:var(--ice);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:.88rem;user-select:all}
/* team */
.person{display:grid;grid-template-columns:150px 1fr;gap:28px;align-items:start}
.avatar{width:150px;height:150px;border-radius:24px;background:linear-gradient(135deg,var(--navy2),var(--amber));display:grid;place-items:center;color:#fff;font-size:2.8rem;font-weight:800}
@media(max-width:700px){.person{grid-template-columns:1fr}}
/* footer */
footer.site{background:#0C1235;color:#AFBBE0;padding:60px 0 28px;font-size:.92rem}
footer.site .cols{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:32px}
footer.site h4{color:#fff;font-size:.9rem;margin-bottom:12px}
footer.site a{text-decoration:none;color:#AFBBE0;display:block;margin:7px 0}
footer.site a:hover{color:#fff}
footer.site .bottom{border-top:1px solid rgba(255,255,255,.1);margin-top:40px;padding-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:.82rem;color:#8291C2}
@media(max-width:900px){footer.site .cols{grid-template-columns:1fr 1fr}}
@media(max-width:520px){footer.site .cols{grid-template-columns:1fr}}
"""
open(OUT + "/assets/style.css", "w").write(CSS)

FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23F59E0B'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle'%3E%E2%9C%88%3C/text%3E%3C/svg%3E"

NAV = [("index.html", "Home"), ("flightalert.html", "Product"), ("pricing.html", "Pricing"),
       ("about.html", "About"), ("team.html", "Team"), ("contact.html", "Contact")]

def header(active):
    links = "".join(f'<a href="{h}"{" class=on" if h == active else ""}>{t}</a>' for h, t in NAV)
    return f'''<header class="site"><div class="wrap">
<a class="logo" href="index.html"><img src="assets/logo-dark.svg" alt="Aviolink Flight Alert" style="height:42px"></a>
<button class="menu-t" aria-label="Menu" onclick="document.querySelector('nav.main').classList.toggle('open')">☰</button>
<nav class="main">{links}<a class="btn btn-amber" href="signup.html">Start free trial</a></nav>
</div></header>'''

FOOTER = f'''<footer class="site"><div class="wrap">
<div class="cols">
 <div><a class="logo" href="index.html"><img src="assets/logo-dark.svg" alt="Aviolink Flight Alert" style="height:44px"></a>
 <p style="margin-top:14px;max-width:300px">Aviation software for travel agencies. Every flight change, delay and cancellation — caught and communicated, automatically.</p></div>
 <div><h4>Product</h4><a href="flightalert.html">FlightAlert</a><a href="flightalert.html#how">How it works</a><a href="pricing.html">Pricing</a><a href="security.html">Data &amp; security</a><a href="signup.html">Start free trial</a></div>
 <div><h4>Company</h4><a href="about.html">About us</a><a href="team.html">Our team</a><a href="contact.html">Contact</a></div>
 <div><h4>Legal</h4><a href="terms.html">Terms of service</a><a href="privacy.html">Privacy policy</a><a href="refund.html">Refund &amp; cancellation</a><a href="delivery.html">Service delivery</a></div>
</div>
<div class="bottom"><span>© 2026 Aviolink · Operated by {ENTITY} · {ADDRESS}</span><span>📧 <a href="mailto:{EMAIL}" style="display:inline">{EMAIL}</a> · 📱 <a href="https://wa.me/{PHONE_WA}" style="display:inline">{PHONE}</a></span></div>
</div></footer>'''

def page(fname, title, desc, body, active=None, extra_head="", script=""):
    html = f'''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:title" content="{title}"><meta property="og:description" content="{desc}"><meta property="og:type" content="website"><meta property="og:url" content="https://aviolink.in/{'' if fname=='index.html' else fname}">
<link rel="icon" type="image/svg+xml" href="assets/mark.svg"><link rel="apple-touch-icon" href="assets/aviolink-icon-640.png"><meta property="og:image" content="https://aviolink.in/assets/aviolink-logo-light.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">{extra_head}
</head><body>
{header(active or fname)}
{body}
{FOOTER}
{script}
</body></html>'''
    open(f"{OUT}/{fname}", "w").write(html)

def phero(kicker, h1, p):
    return f'<section class="phero"><div class="wrap"><div class="kicker">{kicker}</div><h1>{h1}</h1><p>{p}</p></div></section>'

BAND = '''<section><div class="wrap"><div class="band"><div><h2>Never let a client hear it from the airline first.</h2><p>30-day free trial · no card · connect your inbox in 30 seconds</p></div><a class="btn btn-amber btn-lg" href="signup.html">Start free trial →</a></div></div></section>'''

PHONE_DEMO = '''<div class="phone"><div class="scr"><div class="bar"><span class="av">FT</span>Your Travel Agency</div>
<div class="bubble">🔔 <b>FLIGHT CHANGE ALERT</b>
━━━━━━━━━━━━━━━
👤 <b>Passengers:</b>
   • Mr. Rohit Sharma
   • Mrs. Neha Sharma
🎫 <b>PNR:</b> X9K2LM
✈️ <b>Airline:</b> Air India (AI)

<b>Old timings</b>
AI 863 · BOM → DEL · 29 Aug
      05:55 – 08:05

<b>New timings</b>
AI 865 · BOM → DEL · 29 Aug
      <b>09:50 – 12:00</b> ⬅️
━━━━━━━━━━━━━━━
For any queries, please contact
<b>Your Travel Agency</b> 📞 98XXXXXXXX<span class="t">09:41 ✓✓</span></div></div></div>'''

# ---------------- HOME ----------------
page("index.html", "Aviolink — Flight change, delay & cancellation alerts for travel agencies",
 "Aviolink reads every airline and vendor email for your agency and alerts you — and your client on WhatsApp — the moment a flight is rescheduled, delayed or cancelled.",
f'''<section class="hero"><div class="wrap grid">
<div>
 <span class="eyebrow">✈️ Built by airline ticketing professionals · Pune, India</span>
 <h1>Flight <em>rescheduled</em>, <em>delayed</em> or <em>cancelled</em>?<br>Your client hears it from you — first.</h1>
 <p class="lead">Airlines announce changes by email, buried among hundreds of others. Aviolink reads every airline and vendor mail for your agency, understands it with AI, and sends a clean alert with passenger names, PNR and old vs new timings — ready for your client on WhatsApp.</p>
 <div class="cta"><a class="btn btn-amber btn-lg" href="signup.html">Start 30-day free trial →</a><a class="btn btn-ghost btn-lg" href="flightalert.html">See how it works</a></div>
 <div class="fine">No card · Sign in with Google in 30 seconds · nothing to install</div>
 <div class="chips"><span class="chip">Schedule changes</span><span class="chip">Delays</span><span class="chip">Cancellations</span><span class="chip">Re-accommodation</span><span class="chip">Time &amp; flight-number changes</span></div>
</div>
<div>{PHONE_DEMO}</div>
</div></section>

<section><div class="wrap center">
 <div class="kicker">The problem</div>
 <h2 class="sec">One missed airline email costs you a client.</h2>
 <p class="sub">Schedule changes, delays and cancellations look exactly like the promotional mails around them. When one slips through, the passenger reaches the airport for a flight that has moved — and blames the agency.</p>
 <div class="cards c3" style="text-align:left">
  <div class="card"><div class="ic">📥</div><h3>Buried in the inbox</h3><p>Dozens of airline, GDS and consolidator mails every day. The one that matters is rarely opened in time.</p></div>
  <div class="card"><div class="ic">⏰</div><h3>Delays and cancellations</h3><p>A two-hour delay or a cancelled leg breaks connections, transfers and hotel check-ins — your client needs to know now, not at the counter.</p></div>
  <div class="card"><div class="ic">😡</div><h3>Your client, your blame</h3><p>Goodwill refunds, re-bookings at walk-in fares and lost trust. Manual queue and inbox checks don't scale.</p></div>
 </div>
</div></section>

<section class="alt"><div class="wrap">
 <div class="center"><div class="kicker">What Aviolink catches</div><h2 class="sec">Every kind of disruption, from every airline.</h2><p class="sub">Any airline, any GDS, any consolidator or B2B portal — in any format. No templates to set up, no lists to maintain.</p></div>
 <div class="cards c4">
  <div class="card"><div class="ic">🔁</div><h3>Schedule changes</h3><p>Retimes, flight-number changes, earlier departures, revised itineraries.</p></div>
  <div class="card"><div class="ic">⏳</div><h3>Delays</h3><p>Departure delays and revised timings, flagged URGENT when travel is within 48 hours.</p></div>
  <div class="card"><div class="ic">❌</div><h3>Cancellations</h3><p>Cancelled legs with the alternate flight offered, or refund options when there is none.</p></div>
  <div class="card"><div class="ic">🧭</div><h3>Re-accommodation</h3><p>Airline-protected rebookings shown leg by leg, with every unchanged leg listed too.</p></div>
 </div>
</div></section>

<section id="how"><div class="wrap center">
 <div class="kicker">How it works</div>
 <h2 class="sec">Three steps. Then it runs on its own.</h2>
 <div class="steps" style="text-align:left">
  <div class="step"><div class="n">1</div><h3>Sign up</h3><p>Start a 30-day free trial with your agency name and WhatsApp number. No card.</p></div>
  <div class="step"><div class="n">2</div><h3>Sign in with Google</h3><p>Connect the mailbox where airline mails arrive — read-only, 30 seconds. Not on Gmail? Use simple email forwarding.</p></div>
  <div class="step"><div class="n">3</div><h3>Alerts reach your clients</h3><p>Every change becomes a clean alert. You approve with one tap and it goes to your passenger on WhatsApp.</p></div>
 </div>
</div></section>

<section class="alt"><div class="wrap split">
 <div>
  <div class="kicker">Why agencies trust it</div>
  <h2 class="sec">Correct, complete — or held.</h2>
  <p class="sub">An alert with the wrong name is worse than no alert. Aviolink is built by people who issue tickets every day.</p>
  <ul class="ticks">
   <li><b>Never half information:</b> if a passenger name or PNR is missing, the alert waits until the ticket is matched — unless the flight is within 48 hours, then it goes out marked URGENT.</li>
   <li><b>Your own requests are ignored:</b> date-change and cancellation requests you send to suppliers — and their acknowledgements — never trigger alerts.</li>
   <li><b>Every change, every time:</b> the same PNR changed three times means three alerts; identical repeat notices are silenced.</li>
   <li><b>Old bookings covered:</b> 12 months of past tickets are loaded when you connect, so a ticket issued in August for a January trip is protected.</li>
  </ul>
 </div>
 <div class="cards c2" style="margin-top:0">
  <div class="card"><div class="ic">🔒</div><h3>Read-only</h3><p>We can never send, delete or change your mail.</p></div>
  <div class="card"><div class="ic">🇮🇳</div><h3>Data in India</h3><p>Stored in an encrypted database in Mumbai.</p></div>
  <div class="card"><div class="ic">🤖</div><h3>AI that reads any format</h3><p>Airline mails, GDS notices, B2B portals, PDFs.</p></div>
  <div class="card"><div class="ic">📱</div><h3>Works on every phone</h3><p>Alerts are formatted for WhatsApp on any device.</p></div>
 </div>
</div></section>
{BAND}''', active="index.html")

# ---------------- PRODUCT ----------------
page("flightalert.html", "FlightAlert — automatic flight disruption alerts | Aviolink",
 "FlightAlert reads airline and vendor emails, detects schedule changes, delays and cancellations, and sends WhatsApp-ready alerts with passenger names and old vs new timings.",
phero("Product · FlightAlert", "Automatic flight disruption alerts — from airline email to your client's WhatsApp.", "FlightAlert watches your agency mailbox around the clock, recognises every schedule change, delay and cancellation, and turns it into a professional alert your client understands at a glance.") + f'''
<section><div class="wrap split">
 <div>
  <div class="kicker">What you get</div>
  <h2 class="sec">One clean message instead of a confusing airline mail.</h2>
  <ul class="ticks">
   <li>Passenger names first — every passenger on the booking</li>
   <li>Airline PNR (not the vendor reference) and airline name</li>
   <li><b>Old timings</b> and <b>New timings</b> for every leg, with the changed leg marked</li>
   <li>Next-day arrivals shown as (+1); cancellations clearly marked ❌</li>
   <li>Your agency name and phone number at the bottom</li>
   <li>Short lines that never wrap — readable on any phone</li>
  </ul>
 </div>
 <div>{PHONE_DEMO}</div>
</div></section>

<section class="alt" id="how"><div class="wrap">
 <div class="center"><div class="kicker">Under the hood</div><h2 class="sec">How FlightAlert works</h2></div>
 <div class="steps">
  <div class="step"><div class="n">1</div><h3>Detect</h3><p>Every new mail is checked against worldwide airline, GDS and vendor patterns. Promotions, OTPs, newsletters and your own outgoing requests are skipped.</p></div>
  <div class="step"><div class="n">2</div><h3>Understand</h3><p>AI extracts PNR, passengers, airline, every leg and the old vs new timings — from mail text and PDF attachments, in any format or language.</p></div>
  <div class="step"><div class="n">3</div><h3>Match &amp; deliver</h3><p>The change is matched to the original ticket for names and contact number, checked for duplicates, and sent for your one-tap approval — then to your client on WhatsApp.</p></div>
 </div>
</div></section>

<section><div class="wrap">
 <div class="center"><div class="kicker">Features</div><h2 class="sec">Built for how agencies actually work</h2></div>
 <div class="cards c3">
  <div class="card"><span class="tag live">Live</span><h3>Any airline, any vendor</h3><p>IndiGo, Air India, Emirates, Lufthansa, Turkish, Riyadh Air, Cleartrip B2B, TBO, TripJack, Galileo notices and more. No setup per supplier.</p></div>
  <div class="card"><span class="tag live">Live</span><h3>Sign in with Google</h3><p>Read-only Gmail / Google Workspace connection, including mails that land in spam. Forwarding available for other providers.</p></div>
  <div class="card"><span class="tag live">Live</span><h3>12-month backfill</h3><p>Past tickets are imported when you connect, so alerts for older bookings still carry full passenger details.</p></div>
  <div class="card"><span class="tag live">Live</span><h3>Hold until complete</h3><p>No alert goes out with missing names; urgent flights (within 48 h) are never held.</p></div>
  <div class="card"><span class="tag live">Live</span><h3>Smart duplicate control</h3><p>Repeated notices for the same change are silenced; every new change to a PNR is alerted.</p></div>
  <div class="card"><span class="tag live">Live</span><h3>One-tap approval</h3><p>Nothing reaches your client without your approval. You stay in control of every message.</p></div>
 </div>
</div></section>

<section class="alt"><div class="wrap narrow">
 <div class="center"><div class="kicker">FAQ</div><h2 class="sec">Questions agencies ask</h2></div>
 <details><summary>Do I need a new email ID?</summary><p>No. You connect the inbox you already use with "Sign in with Google". If you are not on Gmail / Google Workspace, you get a private forwarding address instead.</p></details>
 <details><summary>Will you read my personal or client emails?</summary><p>Only airline, booking and vendor mails are processed. Everything else is skipped automatically and its content is never stored or read by a person. Access is read-only and you can disconnect anytime.</p></details>
 <details><summary>Do my clients get alerts directly?</summary><p>Yes, after you approve. Each alert is shown to you first; one tap sends it to your passenger on WhatsApp with your agency name and number.</p></details>
 <details><summary>What about delays?</summary><p>Delay and revised-timing notices are treated like schedule changes. If the flight is within 48 hours the alert is marked URGENT and delivered immediately.</p></details>
 <details><summary>Is anything installed on my computers or GDS?</summary><p>Nothing. Aviolink runs fully in the cloud. Your GDS, computers and passwords are never touched.</p></details>
 <details><summary>What if a mail is missed or parsed wrongly?</summary><p>Every mail we process is logged. Tell us the PNR and we re-check it within minutes — and improve the system so it does not happen again.</p></details>
</div></section>
{BAND}''')

# ---------------- PRICING ----------------
page("pricing.html", "Pricing — Aviolink FlightAlert",
 "Simple monthly plans for travel agencies. 30-day free trial, no card, cancel anytime.",
phero("Pricing", "Simple pricing. Less than one goodwill refund.", "Start with a full-featured 30-day free trial. No card required. Choose a plan only when you are convinced.") + f'''
<section><div class="wrap">
 <div class="cards c3">
  <div class="price"><h3>Trial</h3><div class="amt">₹0</div><div class="gst">30 days · no card</div>
   <ul class="ticks"><li>All features</li><li>Google sign-in or forwarding</li><li>12-month booking backfill</li><li>WhatsApp alerts to clients</li></ul>
   <a class="btn btn-white" href="signup.html">Start free trial</a></div>
  <div class="price hot"><h3>Agency</h3><div class="amt">₹1,999<small> / month</small></div><div class="gst">+ 18% GST · billed monthly</div>
   <ul class="ticks"><li>1 connected mailbox</li><li>Unlimited alerts</li><li>Any airline, any vendor</li><li>WhatsApp delivery with your agency name</li><li>Email &amp; WhatsApp support</li></ul>
   <a class="btn btn-amber" href="signup.html">Start free trial</a></div>
  <div class="price"><h3>Multi-branch</h3><div class="amt">Custom</div><div class="gst">for consolidators &amp; TMCs</div>
   <ul class="ticks"><li>Multiple mailboxes &amp; branches</li><li>Sub-agent alerts</li><li>Priority support</li><li>Volume pricing</li></ul>
   <a class="btn btn-white" href="contact.html">Talk to us</a></div>
 </div>
 <p class="center" style="color:var(--muted);margin-top:28px;font-size:.9rem">Prices in Indian Rupees. Payments are processed securely by our payment partner. See <a href="terms.html">Terms</a> and <a href="refund.html">Refund &amp; cancellation policy</a>.</p>
</div></section>
<section class="alt"><div class="wrap narrow">
 <details><summary>What happens after the trial?</summary><p>We remind you before the trial ends. If you do not choose a plan, alerts simply stop — nothing is charged automatically.</p></details>
 <details><summary>Can I cancel anytime?</summary><p>Yes. Cancel before your next billing date and you will not be charged again. See the refund policy for details.</p></details>
 <details><summary>Do you issue GST invoices?</summary><p>Yes, a GST invoice is issued for every payment.</p></details>
</div></section>
{BAND}''')

# ---------------- ABOUT ----------------
page("about.html", "About us — Aviolink",
 "Aviolink builds aviation software for travel agencies, created by airline ticketing professionals in Pune, India.",
phero("About Aviolink", "Aviation software built from the ticketing desk.", "We are travel professionals first. Aviolink exists because we lived the problem — missed schedule-change mails, stranded passengers and the calls that follow.") + f'''
<section><div class="wrap split">
 <div>
  <div class="kicker">Our story</div>
  <h2 class="sec">From a busy agency inbox to a product.</h2>
  <p class="sub">Aviolink started inside a working Pune travel agency. Every week, airline schedule changes and cancellations arrived by email among hundreds of other mails — and every week someone had to find them before a client reached the airport.</p>
  <p class="sub" style="margin-top:14px">We built a system that reads those mails the way an experienced ticketing executive would — knowing an airline PNR from a vendor reference, a protected rebooking from a voluntary change, and a GDS status code from noise. Today that system is FlightAlert.</p>
 </div>
 <div class="cards c2" style="margin-top:0">
  <div class="card"><div class="ic">🎯</div><h3>Mission</h3><p>No passenger should miss a flight because an email went unread.</p></div>
  <div class="card"><div class="ic">🧑‍✈️</div><h3>Domain first</h3><p>Run by a team with 15+ years of GDS, ticketing and airline operations experience.</p></div>
  <div class="card"><div class="ic">🛡️</div><h3>Accuracy over noise</h3><p>Complete alerts or none — never a wrong passenger name.</p></div>
  <div class="card"><div class="ic">🤝</div><h3>Agency-first</h3><p>Your clients stay your clients. Every message carries your agency's name.</p></div>
 </div>
</div></section>
<section class="alt"><div class="wrap">
 <div class="center"><div class="kicker">What we're building</div><h2 class="sec">Products for travel professionals</h2></div>
 <div class="cards c3">
  <div class="card"><span class="tag live">Live</span><h3>FlightAlert</h3><p>Automatic schedule-change, delay and cancellation alerts with WhatsApp delivery.</p><p style="margin-top:10px"><a href="flightalert.html"><b>Learn more →</b></a></p></div>
  <div class="card"><span class="tag">Coming soon</span><h3>Web Check-in Assist</h3><p>Timely web check-in reminders and assistance for your passengers.</p></div>
  <div class="card"><span class="tag">Coming soon</span><h3>Agency Dashboard</h3><p>All your bookings, alerts and client communication in one place.</p></div>
 </div>
</div></section>
{BAND}''')

# ---------------- TEAM ----------------
TEAM_LEAD = [
 ("SK","Sonali Kale","Partner","Co-owner of Aviolink. Guides business direction, partnerships and growth."),
 ("AJ","Aishwarya Jagtap","Partner","Co-owner of Aviolink. Guides business direction, client relationships and growth."),
]
TEAM = [
 ("SC","Sandeep Chavan","Ticketing Executive","Handles airline ticketing and schedule-change operations, and supports agencies in verifying alerts against airline records."),
 ("PD","Pooja Dhuman","Accounts","Manages agency billing, GST invoicing and payment reconciliation."),
 ("SJ","Sagar Jagtap","Finance Expert","Advises on finance, pricing and financial compliance."),
]
def pcard(ini,name,role,bio):
    return f'<div class="card" style="text-align:center"><div class="avatar" style="width:96px;height:96px;font-size:1.8rem;border-radius:50%;margin:0 auto 14px">{ini}</div><h3>{name}</h3><div class="kicker" style="margin:4px 0 10px;letter-spacing:.06em">{role}</div><p>{bio}</p></div>'
page("team.html", "Our team — Aviolink",
 "Meet the team behind Aviolink — partners, airline ticketing and GDS professionals building software for travel agencies in Pune, India.",
phero("Our team", "Travel professionals who build software.", "Aviolink is built in Pune, India, by a team that issues tickets and handles flight disruptions every day.") + f'''
<section><div class="wrap">
 <div class="center"><div class="kicker">Partners</div><h2 class="sec">Leadership</h2></div>
 <div class="cards c2" style="max-width:820px;margin-left:auto;margin-right:auto">{"".join(pcard(*p) for p in TEAM_LEAD)}</div>
</div></section>

<section><div class="wrap">
 <div class="center"><div class="kicker">Operations</div><h2 class="sec">The people behind every alert</h2></div>
 <div class="cards c3">{"".join(pcard(*p) for p in TEAM)}</div>
</div></section>
<section class="alt"><div class="wrap center">
 <h2 class="sec">Want to work with us?</h2>
 <p class="sub">We are always glad to hear from travel-technology engineers and experienced ticketing professionals.</p>
 <p style="margin-top:22px"><a class="btn btn-navy" href="mailto:{EMAIL}?subject=Careers%20at%20Aviolink">Write to {EMAIL}</a></p>
</div></section>''')

# ---------------- CONTACT ----------------
page("contact.html", "Contact — Aviolink",
 "Contact Aviolink for sales, support or partnerships. WhatsApp, email and office details.",
phero("Contact", "Talk to a person who knows ticketing.", "Questions about FlightAlert, a demo for your team, or partnership enquiries — we usually reply within a few working hours.") + f'''
<section><div class="wrap">
 <div class="cards c3">
  <div class="card"><div class="ic">💬</div><h3>WhatsApp</h3><p>Fastest for quick questions and demos.</p><p style="margin-top:10px"><a href="https://wa.me/{PHONE_WA}"><b>{PHONE}</b></a></p></div>
  <div class="card"><div class="ic">📧</div><h3>Email</h3><p>Support, billing and partnerships.</p><p style="margin-top:10px"><a href="mailto:{EMAIL}"><b>{EMAIL}</b></a></p></div>
  <div class="card"><div class="ic">📍</div><h3>Office</h3><p>{ENTITY}<br>Office No. C-304, Newton Homes,<br>Near Runwal Seagull, Shriram Chowk,<br>Handewadi Road, Hadapsar,<br>Pune 411028, Maharashtra</p><p style="margin-top:10px;color:var(--muted);font-size:.88rem">Mon–Sat · 10:00–19:00 IST</p></div>
 </div>
 <div class="formcard" style="max-width:720px;margin:48px auto 0">
  <h2 class="sec" style="font-size:1.5rem;margin-top:0">Send us a message</h2>
  <form id="cf">
   <label>Your name</label><input id="cn" required>
   <label>Agency name</label><input id="ca">
   <label>Email or WhatsApp number</label><input id="ce" required>
   <label>Message</label><textarea id="cm" rows="5" required></textarea>
   <button class="ebtn" style="margin-top:20px" type="submit">Send via WhatsApp →</button>
   <div class="hint" style="text-align:center">Opens WhatsApp with your message ready to send.</div>
  </form>
 </div>
</div></section>''', script=f'''<script>
document.getElementById('cf').addEventListener('submit',function(e){{e.preventDefault();
var t='Hello Aviolink,%0A%0AName: '+encodeURIComponent(cn.value)+'%0AAgency: '+encodeURIComponent(ca.value)+'%0AContact: '+encodeURIComponent(ce.value)+'%0A%0A'+encodeURIComponent(cm.value);
window.open('https://wa.me/{PHONE_WA}?text='+t,'_blank');}});
</script>''')

# ---------------- SECURITY ----------------
page("security.html", "Data & security — Aviolink",
 "How Aviolink protects agency mailboxes and passenger data: read-only access, minimal storage, encrypted database in India.",
phero("Data & security", "Read-only. Minimal. In India.", "Connecting a mailbox is a serious act of trust. Here is exactly what Aviolink can and cannot do.") + f'''
<section><div class="wrap">
 <div class="cards c3">
  <div class="card"><div class="ic">👁️</div><h3>Read-only access</h3><p>We request Google's read-only Gmail permission. Aviolink cannot send, delete, move or modify any mail.</p></div>
  <div class="card"><div class="ic">🔑</div><h3>No passwords</h3><p>Sign-in happens on Google's own page. We never see or store your password and you can revoke access anytime.</p></div>
  <div class="card"><div class="ic">✂️</div><h3>Minimal storage</h3><p>Only flight details from airline mails are stored — PNR, passengers, legs, timings. Other mails are skipped and not stored.</p></div>
  <div class="card"><div class="ic">🗄️</div><h3>Encrypted, in India</h3><p>Data is kept in an encrypted managed database in the Mumbai region, with access limited to the service itself.</p></div>
  <div class="card"><div class="ic">🚫</div><h3>Never sold, never shared</h3><p>Your data is used only to deliver alerts to you and, after your approval, to your own passengers.</p></div>
  <div class="card"><div class="ic">🧾</div><h3>Google API policy</h3><p>Our use of Google user data follows the Google API Services User Data Policy, including Limited Use requirements.</p></div>
 </div>
 <p class="center" style="margin-top:34px;color:var(--muted)">Disconnect anytime at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a> · Request deletion at <a href="mailto:{EMAIL}">{EMAIL}</a> · Full details in our <a href="privacy.html">Privacy policy</a>.</p>
</div></section>''')

# ---------------- LEGAL ----------------
def legal(fname, title, h1, body):
    page(fname, f"{title} — Aviolink", f"Aviolink {title.lower()}.",
         phero("Legal", h1, f"Last updated: {UPDATED}") + f'<section><div class="wrap narrow legal">{body}</div></section>', active="")

legal("terms.html", "Terms of Service", "Terms of Service", f'''
<p>These Terms of Service ("Terms") govern your use of Aviolink FlightAlert ("Aviolink", "the Service"), operated by {ENTITY}, {ADDRESS} ("we", "us"). By creating an account, connecting a mailbox or paying for a plan, you ("the Agency", "you") agree to these Terms.</p>
<h2>1. The Service</h2>
<p>Aviolink reads airline, GDS and travel-vendor emails from mailboxes you connect or forward, detects flight schedule changes, delays and cancellations, and prepares alerts that you may approve for delivery to your passengers on WhatsApp or other channels.</p>
<p>Alerts are an operational aid. The airline's own communication, GDS records and fare rules remain authoritative. You remain responsible for verifying changes and for all communication and decisions with your clients.</p>
<h2>2. Eligibility and account</h2>
<ul><li>You must be a business or professional (travel agency, consolidator, TMC or similar) and at least 18 years old.</li>
<li>You must provide accurate details and keep them updated. You are responsible for activity under your account.</li>
<li>Connect only mailboxes you own or are authorised to use.</li></ul>
<h2>3. Free trial</h2>
<p>New agencies receive a 30-day free trial with full features. No payment details are required. At the end of the trial the Service stops unless you choose a paid plan; nothing is charged automatically.</p>
<h2>4. Plans, fees and payment</h2>
<ul><li>Paid plans are billed in advance in Indian Rupees at the prices shown on the <a href="pricing.html">Pricing page</a> at the time of purchase. Applicable GST is charged in addition and a GST invoice is issued.</li>
<li>Payments are processed by our payment partner (such as Razorpay) using UPI, cards, net banking or other supported methods. We do not store your card details.</li>
<li>If you opt for automatic renewal, your plan renews for the same period until cancelled. You can cancel renewal at any time before the next billing date.</li>
<li>We may change prices with at least 30 days' notice by email; changes apply from your next billing period.</li>
<li>If a payment fails, we may suspend the Service after 7 days' notice until payment is made.</li></ul>
<h2>5. Cancellation and refunds</h2>
<p>Cancellation and refunds are governed by our <a href="refund.html">Refund &amp; Cancellation Policy</a>, which forms part of these Terms.</p>
<h2>6. Acceptable use</h2>
<ul><li>Do not use the Service for unlawful purposes, spam or messages your passengers have not agreed to receive.</li>
<li>Do not attempt to reverse-engineer, overload or gain unauthorised access to the Service.</li>
<li>WhatsApp messages are sent on your instruction; you must have a legitimate relationship with each recipient.</li></ul>
<h2>7. Data and privacy</h2>
<p>We process mailbox data only to provide the Service, as described in our <a href="privacy.html">Privacy Policy</a>. For passenger personal data contained in your mails, you are the data fiduciary and we process it on your behalf, under the Digital Personal Data Protection Act, 2023 and other applicable law.</p>
<h2>8. Availability</h2>
<p>We aim for continuous operation but do not guarantee that the Service will be uninterrupted or error-free, or that every airline email will be detected or interpreted correctly. Third-party services (email providers, airlines, WhatsApp, payment partners) may affect availability.</p>
<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, we are not liable for indirect or consequential losses, including missed flights, re-booking costs, refunds to your clients or loss of business. Our total liability in any matter is limited to the fees you paid us in the 3 months before the event giving rise to the claim.</p>
<h2>10. Suspension and termination</h2>
<p>You may stop using the Service and disconnect your mailbox at any time. We may suspend or terminate accounts that breach these Terms. On termination, access to your mailbox stops immediately and your stored data is deleted within 30 days unless law requires otherwise.</p>
<h2>11. Changes to these Terms</h2>
<p>We may update these Terms. Material changes will be notified by email or on the website at least 15 days before they apply.</p>
<h2>12. Governing law</h2>
<p>These Terms are governed by the laws of India. Courts at Pune, Maharashtra have exclusive jurisdiction.</p>
<h2>13. Contact</h2>
<p>{ENTITY}, {ADDRESS} · <a href="mailto:{EMAIL}">{EMAIL}</a> · {PHONE}</p>''')

legal("privacy.html", "Privacy Policy", "Privacy Policy", f'''
<p>This policy explains how Aviolink, operated by {ENTITY}, {ADDRESS}, collects and uses information when you use Aviolink FlightAlert.</p>
<h2>1. Information we collect</h2>
<ul><li><b>Account details:</b> agency name, contact name, email address and WhatsApp number you provide at signup.</li>
<li><b>Mailbox access:</b> when you "Sign in with Google", we receive read-only Gmail access (scope <code>gmail.readonly</code>) and your Google account email address. We never receive your password.</li>
<li><b>Flight data from airline mails:</b> PNR, airline, flight numbers, sectors, dates and timings, passenger names and passenger contact number where present, and the alert text generated from them. We also store each processed message's ID and subject to avoid processing it twice.</li>
<li><b>Payment data:</b> payment status and invoice details. Card and bank details are handled by our payment partner, not by us.</li></ul>
<h2>2. How we use information</h2>
<p>Only to provide the Service: detect flight changes, delays and cancellations; prepare alerts; deliver approved alerts to you and your passengers; support and billing. Emails that are not airline or travel-vendor mails are skipped automatically and their content is not stored.</p>
<h2>3. Google user data — Limited Use</h2>
<p>Aviolink's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. We do not use Gmail data for advertising, do not sell it, and do not allow humans to read it except with your explicit consent for support, for security purposes, or where required by law.</p>
<h2>4. Service providers</h2>
<ul><li>Cloud hosting and database (encrypted, Mumbai region) to run the Service.</li>
<li>An AI model provider (Anthropic) to extract flight details from airline emails. Content is processed only for that purpose and is not used to train models.</li>
<li>Meta WhatsApp Business Platform to deliver alerts you approve.</li>
<li>A payment gateway (such as Razorpay) to process payments.</li></ul>
<p>We do not sell or rent personal data to anyone.</p>
<h2>5. Retention</h2>
<p>Booking and alert data is kept while your account is active and for up to 30 days after you close it, unless a longer period is required by law (for example, tax records for invoices).</p>
<h2>6. Your choices and rights</h2>
<ul><li>Disconnect mailbox access anytime at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a> or by writing to us.</li>
<li>Request access, correction or deletion of your data at <a href="mailto:{EMAIL}">{EMAIL}</a>. We act on deletion requests within 7 days.</li>
<li>Passengers whose data appears in agency mails may contact their travel agency or us.</li></ul>
<h2>7. Security</h2>
<p>Read-only access, encrypted storage, restricted service credentials and HTTPS everywhere. See <a href="security.html">Data &amp; security</a>.</p>
<h2>8. Grievance officer</h2>
<p>Grievance Officer, Aviolink · <a href="mailto:{EMAIL}">{EMAIL}</a> · {PHONE}. We respond within 7 days.</p>
<h2>9. Changes</h2>
<p>We will post any changes on this page and notify active agencies by email for material changes.</p>''')

legal("refund.html", "Refund & Cancellation Policy", "Refund &amp; Cancellation Policy", f'''
<h2>Free trial</h2>
<p>The 30-day trial is free and needs no payment details. Nothing is charged when it ends.</p>
<h2>Cancelling a paid plan</h2>
<ul><li>You can cancel anytime by emailing <a href="mailto:{EMAIL}">{EMAIL}</a> / WhatsApp {PHONE}.</li>
<li>Cancellation stops future renewals. The Service continues until the end of the period already paid for.</li></ul>
<h2>Refunds</h2>
<ul><li><b>First payment:</b> if you are not satisfied, request a refund within 7 days of your first paid billing date for a full refund.</li>
<li><b>Renewals:</b> renewal payments are non-refundable once the new period has started, except as below.</li>
<li><b>Duplicate or wrong charges:</b> refunded in full.</li>
<li><b>Service failure:</b> if the Service is unavailable for more than 72 continuous hours due to our fault, you may request a pro-rata refund or credit for that period.</li></ul>
<h2>How refunds are paid</h2>
<p>Approved refunds are processed within 5–7 working days to the original payment method. Your bank may take additional time to credit the amount.</p>
<h2>Contact</h2>
<p>{ENTITY}, {ADDRESS} · <a href="mailto:{EMAIL}">{EMAIL}</a> · {PHONE}</p>''')

legal("delivery.html", "Service Delivery Policy", "Service Delivery Policy", f'''
<p>Aviolink FlightAlert is a software service delivered online. No physical goods are shipped.</p>
<h2>Activation</h2>
<p>Your account is activated instantly when you sign up. Paid plans are activated immediately after successful payment, and a confirmation and GST invoice are sent to your registered email.</p>
<h2>Access</h2>
<p>The Service is accessed through aviolink.in, Google sign-in and the alert channels you choose (WhatsApp, email, Telegram). If activation does not happen within 24 hours of payment, contact us and we will resolve it or refund you.</p>
<h2>Contact</h2>
<p>{ENTITY}, {ADDRESS} · <a href="mailto:{EMAIL}">{EMAIL}</a> · {PHONE}</p>''')

# ---------------- SIGNUP ----------------
SIGNUP_SCRIPT = f'''<script type="module">
import {{ createClient }} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const sb = createClient('https://mztlmtcivsflbclcxeqt.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16dGxtdGNpdnNmbGJjbGN4ZXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMTQ5OTksImV4cCI6MjEwMTY5MDk5OX0.MLk5aAZPybJAgDntfoLDk3Ou3VGyekHbcU-f5-eltxk');
const API = '{API}';
const $ = (id) => document.getElementById(id);
async function createAgency() {{
  const f = $('f');
  if (!f.reportValidity()) return null;
  $('err').style.display = 'none';
  const name = $('name').value.trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  const id = crypto.randomUUID();
  const alerts_email = slug + '@aviolink.in';
  const {{ error }} = await sb.from('agencies').insert({{
    id, name, slug, alerts_email, plan: 'trial', trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    contact_name: $('contact').value.trim(), whatsapp: $('wa').value.trim(), owner_phone: $('wa').value.trim(),
    notify_email: $('notify').value.trim().toLowerCase(), forward_sources: [$('notify').value.trim().toLowerCase()]
  }});
  if (error) throw new Error(error.message);
  return {{ id, alerts_email }};
}}
function fail(ex, btn, label) {{
  $('err').textContent = 'Signup failed: ' + (ex && ex.message || ex) + ' — please WhatsApp us on {PHONE}.';
  $('err').style.display = 'block'; btn.disabled = false; btn.innerHTML = label;
}}
$('g').addEventListener('click', async () => {{
  const b = $('g'), lbl = b.innerHTML; b.disabled = true; b.textContent = 'Creating your trial…';
  try {{ const a = await createAgency(); if (!a) {{ b.disabled = false; b.innerHTML = lbl; return; }}
        b.textContent = 'Opening Google…'; location.href = API + '/auth/google?agency=' + a.id; }}
  catch (ex) {{ fail(ex, b, lbl); }}
}});
$('e').addEventListener('click', async () => {{
  const b = $('e'), lbl = b.innerHTML; b.disabled = true; b.textContent = 'Creating your trial…';
  try {{ const a = await createAgency(); if (!a) {{ b.disabled = false; b.innerHTML = lbl; return; }}
        $('addr').textContent = a.alerts_email; $('f').style.display = 'none'; $('ok').style.display = 'block'; $('ok').scrollIntoView({{behavior:'smooth'}}); }}
  catch (ex) {{ fail(ex, b, lbl); }}
}});
</script>'''

page("signup.html", "Start your free trial — Aviolink",
 "Start a 30-day free trial of Aviolink FlightAlert. Sign in with Google or use email forwarding.",
f'''<section class="alt" style="padding-top:60px"><div class="wrap split" style="align-items:start">
 <div>
  <div class="kicker">30-day free trial</div>
  <h1 class="sec" style="font-size:clamp(1.9rem,3.4vw,2.6rem);line-height:1.15">Start catching every flight change today.</h1>
  <p class="sub">Set up in under two minutes. No card, nothing to install.</p>
  <ul class="ticks">
   <li>Schedule changes, delays and cancellations from any airline or vendor</li>
   <li>Alerts with passenger names, PNR and old vs new timings</li>
   <li>One-tap approval, then delivery to your client on WhatsApp</li>
   <li>12 months of past tickets loaded automatically</li>
   <li>Read-only access · disconnect anytime</li>
  </ul>
  <p style="margin-top:22px;color:var(--muted);font-size:.9rem">Questions? WhatsApp <a href="https://wa.me/{PHONE_WA}"><b>{PHONE}</b></a></p>
 </div>
 <div class="formcard">
  <form id="f" onsubmit="return false">
   <h2 style="color:var(--navy);font-size:1.3rem">Create your agency account</h2>
   <label>Agency name</label><input id="name" required placeholder="Sharma Travels">
   <label>Your name</label><input id="contact" required placeholder="Rohit Sharma">
   <label>WhatsApp number</label><input id="wa" required placeholder="+91 98XXXXXXXX">
   <label>Email</label><input id="notify" type="email" required placeholder="you@youragency.com">
   <div class="hint">The inbox where airline and vendor mails arrive</div>
   <button class="gbtn" type="button" id="g"><img alt="" src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg">Continue with Google</button>
   <div class="hint" style="text-align:center">Gmail &amp; Google Workspace · read-only · recommended</div>
   <div class="or">or</div>
   <button class="ebtn" type="button" id="e">Continue with email (forwarding)</button>
   <div class="hint" style="text-align:center">For Outlook, Zoho, Rediffmail and other providers</div>
   <p class="hint" style="margin-top:18px;text-align:center">By continuing you agree to our <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy policy</a>.</p>
  </form>
  <div class="msg-err" id="err"></div>
  <div class="msg-ok" id="ok">
   <b style="color:#065F46;font-size:1.05rem">✅ Your trial is active</b><br><br>
   One last step — forward airline mails to your private Aviolink address:<br>
   <div style="text-align:center;margin:12px 0"><code id="addr" style="font-size:1.05rem;font-weight:700"></code></div>
   <ol style="padding-left:20px">
    <li>Open your mail settings → <b>Forwarding</b> (or Rules)</li>
    <li>Add the address above as a forwarding address</li>
    <li>Confirm the verification mail we receive, and choose <b>keep a copy in Inbox</b></li>
   </ol>
   <p style="margin-top:12px">Need help? WhatsApp <a href="https://wa.me/{PHONE_WA}"><b>{PHONE}</b></a> — we'll set it up with you.</p>
  </div>
 </div>
</div></section>''', script=SIGNUP_SCRIPT)

# Netlify: pretty 404 -> home, and old #signup anchors keep working
open(OUT + "/_redirects", "w").write("/privacy  /privacy.html  200\n/terms  /terms.html  200\n/*  /index.html  404\n")
print("built:", sorted(os.listdir(OUT)))
