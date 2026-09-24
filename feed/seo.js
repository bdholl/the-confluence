// Search: structured data, per-day pages, sitemap, robots.
//
// Google surfaces properly marked-up events straight into "live music
// milwaukee tonight" results, event carousels and Maps. That needs three
// things this file provides: every event described in full (with a real street
// address and the right timezone), pages Google can crawl without running the
// calendar's JavaScript, and a sitemap that tells it where they all are.

const fs = require('fs');
const path = require('path');
const {
  SITE, escH, fmt12, longDate, dayHeading, shortDate, addDays, ymd,
  chicagoOffset, ticketUrl, buyOffer, byBilling,
} = require('./lib');

const ROOT = path.resolve(__dirname, '..');
const VENUES_FILE = path.join(__dirname, 'venues.json');
const DAY_DIR = path.join(ROOT, 'day');
const OG_CARD = `${SITE}/og-card.png`;
const CF_ANALYTICS_TOKEN = '5a2a6db87bcb490689d0cf58825d61e5';

// ---------- venue addresses ----------
// Google requires a street address for an event to be eligible for rich
// results. Rather than type ~40 addresses by hand (and get some wrong), the
// table learns them from the ticketing APIs, which carry each venue's address,
// and remembers them between builds. An entry marked "manual": true is never
// overwritten — that's how to correct one.
function loadVenues() {
  try { return JSON.parse(fs.readFileSync(VENUES_FILE, 'utf8')); } catch { return {}; }
}
function saveVenues(table) {
  const sorted = Object.fromEntries(Object.keys(table).sort().map(k => [k, table[k]]));
  fs.writeFileSync(VENUES_FILE, JSON.stringify(sorted, null, 2) + '\n');
}

// Which source to believe when they disagree. SeatGeek's venue records are the
// sloppiest — it has the Improv at "20110 Lower" (the street name cut off) —
// and without a ranking the sources overwrote each other on every build.
const SOURCE_TRUST = { ticketmaster: 3, argo: 2, seatgeek: 1 };

// Runs over the raw per-source records, before dedupe, so every source gets a
// chance to contribute an address. Strips s.addr afterwards — the table is the
// store, shows.json doesn't need a copy on every listing.
function learnVenues(shows, table) {
  let learned = 0;
  for (const s of shows) {
    const a = s.addr;
    delete s.addr;
    if (!a || !a.city || !s.venue) continue;
    const have = table[s.venue];
    if (have && have.manual) continue;
    // never trade a street address for a vaguer record…
    if (have && have.street && !a.street) continue;
    // …or a trusted source's address for a less trusted one's
    if (have && have.street && (SOURCE_TRUST[a.source] || 0) < (SOURCE_TRUST[have.source] || 0)) continue;
    if (have && have.street === a.street && have.postal === a.postal) continue;
    table[s.venue] = { street: a.street || '', city: a.city, region: a.region || 'WI', postal: a.postal || '', source: a.source };
    learned++;
  }
  return learned;
}

// Neighborhood names the calendar uses as "hoods" — all inside the city.
const MKE_HOODS = new Set(['Milwaukee', 'Westown', 'Downtown', 'Deer District', 'Bay View', 'East Side', "Walker's Point", 'Riverwest', 'Lakefront']);

function addressFor(s, table) {
  const v = table[s.venue];
  if (v && v.city) {
    return {
      '@type': 'PostalAddress',
      ...(v.street ? { streetAddress: v.street } : {}),
      addressLocality: v.city,
      addressRegion: v.region || 'WI',
      ...(v.postal ? { postalCode: v.postal } : {}),
      addressCountry: 'US',
    };
  }
  // No learned address yet: at least get the town right. "Bay View" is a
  // neighborhood, "Brookfield" is a city.
  return {
    '@type': 'PostalAddress',
    addressLocality: MKE_HOODS.has(s.hood) || !s.hood ? 'Milwaukee' : s.hood,
    addressRegion: 'WI',
    addressCountry: 'US',
  };
}

function venuesMissingStreet(shows, table) {
  const missing = new Set();
  for (const s of shows) if (!table[s.venue]?.street) missing.add(s.venue);
  return [...missing].sort();
}

// ---------- structured data ----------
const STATUS_SCHEMA = {
  cancelled: 'EventCancelled', postponed: 'EventPostponed', rescheduled: 'EventRescheduled',
};

function eventJsonLd(s, { url, performer, table }) {
  const comedy = s.genre === 'comedy';
  const buy = buyOffer(s);
  // Placeholder times aren't showtimes — Google accepts a bare date instead.
  const startDate = s.tbd ? s.date : `${s.date}T${s.time}:00${chicagoOffset(s.date, s.time)}`;
  const address = addressFor(s, table);

  const performers = [performer, ...String(s.support || '').split(/,\s*/)]
    .map(n => (n || '').trim()).filter(Boolean)
    .map(name => ({ '@type': comedy ? 'Person' : 'PerformingGroup', name }));

  // No offer at all for a cancelled or off-sale show — pointing Google at a
  // ticket page for something you can't attend is worse than saying nothing.
  let offers;
  if (buy.url && s.status !== 'cancelled' && s.status !== 'offsale') {
    const future = s.onsale && Date.parse(s.onsale) > Date.now();
    offers = {
      '@type': 'Offer',
      url: ticketUrl(buy.url),
      availability: `https://schema.org/${future ? 'PreOrder' : 'InStock'}`,
      ...(future ? { validFrom: s.onsale } : {}),
      ...(buy.price != null ? { price: buy.price, priceCurrency: 'USD' } : {}),
    };
  }

  return {
    '@context': 'https://schema.org',
    '@type': comedy ? 'ComedyEvent' : 'MusicEvent',
    name: s.title,
    url,
    description: `${s.title}${s.support ? ' with ' + s.support : ''} live at ${s.venue}, ${address.addressLocality}, Wisconsin.`,
    startDate,
    eventStatus: `https://schema.org/${STATUS_SCHEMA[s.status] || 'EventScheduled'}`,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: s.venue, address },
    ...(performers.length ? { performer: performers.length === 1 ? performers[0] : performers } : {}),
    // an image only when we have a real one — never a placeholder
    ...(s.img ? { image: [s.img] } : {}),
    ...(offers ? { offers } : {}),
  };
}

const ldScript = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

// ---------- per-day pages ----------
// The calendar renders with JavaScript. Google can run it, but it ranks plain
// HTML more reliably and "what's on in Milwaukee Friday" is exactly the query a
// day page answers. Each carries an ItemList pointing at the show pages — the
// pattern Google documents for a page that summarizes several events, with the
// full Event markup living on each event's own page.
const PAGE_GRACE_DAYS = 30;

function pageHead({ title, desc, url, image, depth = 1 }) {
  const up = '../'.repeat(depth);
  return `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escH(title)}</title>
<meta name="description" content="${escH(desc)}" />
<link rel="canonical" href="${escH(url)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escH(url)}" />
<meta property="og:site_name" content="The Confluence" />
<meta property="og:title" content="${escH(title)}" />
<meta property="og:description" content="${escH(desc)}" />
<meta property="og:image" content="${escH(image || OG_CARD)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" type="image/png" sizes="32x32" href="${up}favicon-32.png" />
<link rel="apple-touch-icon" href="${up}apple-touch-icon.png" />
<meta name="theme-color" content="#0168FB" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet" />`;
}

const DAY_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--paper:#fdfcf8;--ink:#111;--gray:#6f6f6f;--faint:#9a9a9a;--line:#e7e7e3;--blue:#0168FB}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:0 26px}
.mast{background:#f4efe2;border-bottom:1px solid var(--line);padding:20px 0}
.mark{font-family:'Instrument Serif',Georgia,serif;font-size:28px;line-height:1;color:var(--blue);text-decoration:none}
main.wrap{padding-top:38px;padding-bottom:52px}
.kicker{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(34px,7vw,52px);line-height:1.05;margin:8px 0 4px}
.count{font-size:14px;color:var(--gray);margin-bottom:22px}
.row{display:grid;grid-template-columns:78px 1fr auto;gap:16px;align-items:baseline;padding:13px 0;border-bottom:1px solid var(--line)}
.row:first-of-type{border-top:1px solid var(--ink)}
.t{font-size:13px;color:var(--gray);font-variant-numeric:tabular-nums;white-space:nowrap}
.a{font-family:'Space Grotesk',system-ui,sans-serif;font-size:18px;font-weight:500;color:inherit;text-decoration:none;line-height:1.25}
.a:hover{text-decoration:underline;text-underline-offset:3px}
.v{display:block;font-size:13.5px;color:var(--gray);margin-top:2px}
.b{font-size:12.5px;white-space:nowrap}
.b a{color:var(--blue);text-decoration:none}
.b a:hover{text-decoration:underline}
.b .dead{color:var(--faint)}
.pn{display:flex;justify-content:space-between;gap:16px;margin-top:26px;font-size:14px}
.pn a{color:var(--blue);text-decoration:none;font-weight:600}
.back{margin-top:30px;padding-top:20px;border-top:1px solid var(--line);font-size:15px}
.back a{color:var(--blue);text-decoration:none;font-weight:600}
footer.wrap{padding-bottom:44px;font-size:12.5px;color:var(--faint)}
@media (max-width:560px){.row{grid-template-columns:58px 1fr;gap:12px}.b{grid-column:2}}`;

function dayPageHtml(date, shows, { prev, next }) {
  const url = `${SITE}/day/${date}.html`;
  const heading = dayHeading(date);
  const n = shows.length;
  const title = `Live music in Milwaukee — ${longDate(date)} | The Confluence`;
  const lead = shows.slice(0, 4).map(s => s.title).join(', ');
  const desc = `${n} show${n === 1 ? '' : 's'} in Milwaukee on ${heading}${lead ? ': ' + lead + (n > 4 ? ' and more' : '') : ''}. Times, venues and tickets.`;

  const rows = shows.map(s => {
    const buy = buyOffer(s);
    // a comedy club's two sets stack, the way the calendar shows them
    const when = s.tbd ? 'TBA' : (s.times && s.times.length > 1 ? s.times.map(fmt12) : [fmt12(s.time)]).map(escH).join('<br>');
    let action = buy.url ? `<a href="${escH(ticketUrl(buy.url))}" target="_blank" rel="noopener noreferrer">Get Tickets →</a>` : '';
    if (s.status === 'cancelled') action = '<span class="dead">Cancelled</span>';
    else if (s.status === 'offsale') action = '<span class="dead">Off sale</span>';
    return `<div class="row"><div class="t">${when}</div><div><a class="a" href="../show/${escH(s.slug)}.html">${escH(s.title)}</a><span class="v">${escH(s.venue)}${s.support ? ' · with ' + escH(s.support) : ''}</span></div><div class="b">${action}</div></div>`;
  }).join('\n');

  const list = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: `Live music in Milwaukee on ${heading}`,
    itemListElement: shows.map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/show/${s.slug}.html` })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
${pageHead({ title, desc, url })}
<style>${DAY_CSS}</style>
</head>
<body>
<header class="mast"><div class="wrap"><a class="mark" href="../">The Confluence</a></div></header>
<main class="wrap">
  <p class="kicker">Live in Milwaukee</p>
  <h1>${escH(heading)}</h1>
  <p class="count">${n} show${n === 1 ? '' : 's'}</p>
${rows}
  <nav class="pn">${prev ? `<a href="${prev}.html">← ${escH(shortDate(prev))}</a>` : '<span></span>'}${next ? `<a href="${next}.html">${escH(shortDate(next))} →</a>` : ''}</nav>
  <p class="back">Every show in Milwaukee, updated every morning — <a href="../">see the full calendar →</a></p>
</main>
<footer class="wrap">The Confluence · Milwaukee live music calendar</footer>
${ldScript(list)}
<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${CF_ANALYTICS_TOKEN}"}'></script>
</body>
</html>
`;
}

function groupByDay(shows) {
  const days = new Map();
  for (const s of shows) {
    if (!days.has(s.date)) days.set(s.date, []);
    days.get(s.date).push(s);
  }
  for (const list of days.values()) list.sort(byBilling);
  return days;
}

// Same lifecycle as the show pages: rewrite the live ones, keep past days for
// the grace window, then prune.
function prunePages(dir, live, today) {
  const cutoff = addDays(today, -PAGE_GRACE_DAYS);
  let pruned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.html') || live.has(f)) continue;
    const d = f.match(/(\d{4}-\d{2}-\d{2})(?:-\d+)?\.html$/);
    if (d && d[1] >= cutoff) continue;
    fs.unlinkSync(path.join(dir, f));
    pruned++;
  }
  return pruned;
}

function buildDayPages(shows, today) {
  fs.mkdirSync(DAY_DIR, { recursive: true });
  const days = groupByDay(shows.filter(s => s.date >= today));
  const dates = [...days.keys()].sort();
  const live = new Set();
  dates.forEach((date, i) => {
    live.add(`${date}.html`);
    fs.writeFileSync(path.join(DAY_DIR, `${date}.html`),
      dayPageHtml(date, days.get(date), { prev: dates[i - 1], next: dates[i + 1] }));
  });
  const pruned = prunePages(DAY_DIR, live, today);
  console.log(`• Day pages: ${dates.length} written${pruned ? `, ${pruned} expired removed` : ''}`);
  return dates;
}

// ---------- sitemap + robots ----------
// Only upcoming pages are advertised. Past ones still resolve for the grace
// window (so old shared links work) but there's no reason to ask Google to
// index a show that already happened.
function sitemapXml(shows, dates, updated) {
  const urls = [
    { loc: `${SITE}/`, lastmod: updated, freq: 'daily', pri: '1.0' },
    ...dates.map(d => ({ loc: `${SITE}/day/${d}.html`, lastmod: updated, freq: 'daily', pri: '0.8' })),
    ...shows.map(s => ({ loc: `${SITE}/show/${s.slug}.html`, lastmod: updated, freq: 'weekly', pri: '0.6' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${escH(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
}

const ROBOTS = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

function writeSitemap(shows, dates, updated, today) {
  const upcoming = shows.filter(s => s.date >= today && s.slug);
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemapXml(upcoming, dates, updated));
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), ROBOTS);
  console.log(`• Sitemap: ${1 + dates.length + upcoming.length} URLs`);
}

// ---------- index.html: crawlable path in ----------
// The homepage's listing is drawn by JavaScript, so on its own it offers a
// crawler no links to follow. A plain line of the next two weeks' day pages in
// the footer gives Google (and anyone) a way in: home → day → show.
const DAY_LINKS_RE = /(<!-- day-links -->)([\s\S]*?)(<!-- \/day-links -->)/;

function dayLinksHtml(dates) {
  const next = dates.slice(0, 14);
  if (!next.length) return '';
  return `\n    <p class="foot-links foot-days">Browse by day: ${next.map(d => `<a href="day/${d}.html">${escH(shortDate(d))}</a>`).join(' · ')}</p>\n    `;
}

// Same trick as the embedded show data: the builder keeps a copy of the
// affiliate rules inside index.html so the calendar monetizes its links
// exactly the way the generated pages do, from one config file.
const AFF_RE = /(<script id="affiliate-config" type="application\/json">)([\s\S]*?)(<\/script>)/;

function updateIndex(html, { dates, affiliate }) {
  let out = html;
  if (DAY_LINKS_RE.test(out)) out = out.replace(DAY_LINKS_RE, `$1${dayLinksHtml(dates)}$3`);
  if (AFF_RE.test(out)) out = out.replace(AFF_RE, `$1${JSON.stringify({ rules: affiliate }).replace(/</g, '\\u003c')}$3`);
  return out;
}

module.exports = {
  loadVenues, saveVenues, learnVenues, addressFor, venuesMissingStreet,
  eventJsonLd, ldScript, dayPageHtml, buildDayPages, groupByDay, sitemapXml, writeSitemap,
  updateIndex, dayLinksHtml, pageHead, OG_CARD, ROBOTS, CF_ANALYTICS_TOKEN, prunePages,
};
