// Shared by the feed builder, the generated pages, and the promo bots — one
// place for the site's address, date handling, escaping and ticket links, so a
// show reads the same on the calendar, its own page, a Bluesky post and the
// newsletter.

const fs = require('fs');
const path = require('path');

const SITE = 'https://theconfluencemke.com';
const TZ = 'America/Chicago';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Escapes quotes too — these strings land in attributes (og:title, alt, href).
const escH = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmt12 = t => {
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

// "8 PM", "7:30 PM" — the compact form for posts and cards, where ":00" is noise
const fmtShort = t => fmt12(t).replace(':00', '');

const dayOf = date => new Date(date + 'T12:00:00');

function longDate(date) {
  const d = dayOf(date);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// "Friday, September 26" — no year, for headers inside a single week
function dayHeading(date) {
  const d = dayOf(date);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// "Fri Sep 26"
function shortDate(date) {
  const d = dayOf(date);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

function addDays(date, n) {
  const d = dayOf(date);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// Milwaukee's UTC offset on a given local date and time: "-05:00" in summer,
// "-06:00" in winter. Structured data used to hardcode -05:00, which put every
// show from November to March an hour off in Google.
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
function chicagoOffset(date, time = '20:00') {
  // Read the offset at that wall-clock moment. Starting from the same digits in
  // UTC and stepping forward six hours lands within the right hour either side
  // of a transition, which is plenty for showtimes.
  const probe = new Date(Date.parse(`${date}T${time}:00Z`) + 6 * 3600e3);
  const name = offsetFmt.formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || '';
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || '00'}` : '-06:00';
}

// What time it is in Milwaukee right now — the bots decide "tonight" and "is it
// three o'clock yet" in local time, whatever timezone the runner is in.
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
function chicagoNow(at = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

// Rough national-vs-local ordering by room, same idea as the calendar's
// venueTier(): arenas and sheds first, touring theaters next, everything else
// after. The browser keeps its own copy in index.html.
function venueTier(v) {
  const n = (v || '').toLowerCase();
  if (/fiserv|amphitheater|bmo|alpine|state fair|landmark|miller high life|uihlein/.test(n)) return 0;
  if (/riverside|pabst|rave|eagles|turner|improv/.test(n)) return 1;
  return 2;
}
const byBilling = (a, b) => venueTier(a.venue) - venueTier(b.venue) || a.time.localeCompare(b.time);

// ---------- ticket links, monetized ----------
// Both ticket affiliate programs run through impact.com, which tracks with a
// wrapped redirect ("…/c/<ids>?u=<the real url>") rather than a query
// parameter tacked onto the ticket URL. So a rule is a host pattern plus a wrap
// template. Empty templates mean "not approved yet" and links pass through.
//
// This file is the single source of truth: the builder applies it to every
// generated page, and injects it into index.html so the calendar does the same.
const AFFILIATE_FILE = path.join(__dirname, 'affiliate.json');
let affiliateRules = null;
function loadAffiliate() {
  if (affiliateRules) return affiliateRules;
  try { affiliateRules = JSON.parse(fs.readFileSync(AFFILIATE_FILE, 'utf8')).rules || []; }
  catch { affiliateRules = []; }
  return affiliateRules;
}
function ticketUrl(url, rules = loadAffiliate()) {
  if (!url) return url;
  let host;
  try { host = new URL(url).host; } catch { return url; }
  for (const r of rules) {
    if (!r.wrap || !r.match) continue;
    if (new RegExp(r.match, 'i').test(host)) return r.wrap.replace('{url}', encodeURIComponent(url));
  }
  return url;
}

const buyOffer = s => (s.offers && s.offers[0]) || { src: s.ticketer, url: s.url };

module.exports = {
  SITE, TZ, WEEKDAYS, MONTHS,
  ymd, escH, fmt12, fmtShort, longDate, dayHeading, shortDate, addDays,
  chicagoOffset, chicagoNow, venueTier, byBilling,
  loadAffiliate, ticketUrl, buyOffer,
};
