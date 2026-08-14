#!/usr/bin/env node
/*
 * The Confluence — show feed builder
 * ----------------------------------
 * Pulls real, upcoming Milwaukee live-music listings from public ticketing
 * APIs, normalizes them to the app's schema, merges any hand-curated shows,
 * dedupes, and writes ../shows.json (which the site fetches on load).
 *
 * Sources (each is OPTIONAL and skipped if its key isn't set):
 *   • Ticketmaster Discovery API   env: TICKETMASTER_API_KEY   (free: developer.ticketmaster.com)
 *   • SeatGeek Platform API        env: SEATGEEK_CLIENT_ID     (free: seatgeek.com/account/develop)
 *
 * Run:   TICKETMASTER_API_KEY=xxxx node feed/build-shows.js
 * Safe by design: if every source fails or returns nothing, the existing
 * shows.json is left untouched (never clobbered with an empty list).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shows.json');
const EXTRAS = path.join(__dirname, 'manual-extras.json');

const DAYS_AHEAD = Number(process.env.FEED_DAYS_AHEAD || 120);
// Milwaukee metro center + search radius (miles) — covers suburbs like Cudahy.
const LAT = 43.0389, LON = -87.9065, RADIUS = 35;

// ---------- normalization helpers ----------

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hm(t) { return t ? t.slice(0, 5) : '20:00'; } // "HH:MM"; default 8pm when unknown

// Best-effort neighborhood by venue name (matched as a substring), else the
// venue's city. Add venues here as you see them come through.
const VENUE_HOODS = {
  'x-ray arcade': 'Cudahy',
  'rave': 'Westown', 'eagles club': 'Westown', 'eagles ballroom': 'Westown',
  'turner hall': 'Westown', 'miller high life': 'Westown',
  'pabst theater': 'Downtown', 'riverside theater': 'Downtown', 'bmo pavilion': 'Downtown',
  'fiserv': 'Deer District', 'uline': 'Deer District', 'deer district': 'Deer District',
  'cactus club': 'Bay View', 'cactus': 'Bay View',
  'shank hall': 'East Side', 'vivarium': 'East Side',
  'anodyne': "Walker's Point", 'cooperage': "Walker's Point",
  'linneman': 'Riverwest', 'company brewing': 'Riverwest',
  'american family insurance amphitheater': 'Lakefront', 'henry maier': 'Lakefront', 'summerfest': 'Lakefront',
  'pabst': 'Downtown',
};
// Sources (and even Ticketmaster itself) carry several records for the same
// room. Collapse them to one display name so listings and dedupe agree.
const VENUE_ALIASES = [
  [/eagles\s*club|eagles\s*ballroom|\brave\b/i, 'The Rave / Eagles Club'],
  [/summerfest|american family insurance amph|henry maier/i, 'American Family Insurance Amphitheater'],
  [/riverside theat/i, 'Riverside Theater'],
  [/pabst theat/i, 'Pabst Theater'],
  [/turner hall/i, 'Turner Hall Ballroom'],
  [/milwaukee improv/i, 'Milwaukee Improv'],
  [/miller high life/i, 'Miller High Life Theatre'],
  [/x-?ray arcade/i, 'X-Ray Arcade'],
  [/cactus club/i, 'Cactus Club'],
  [/vivarium/i, 'Vivarium'],
  [/shank hall/i, 'Shank Hall'],
  [/fiserv/i, 'Fiserv Forum'],
  [/bmo (harris )?pavilion/i, 'BMO Pavilion'],
  [/uihlein/i, 'Uihlein Hall'],
  [/wisconsin state fair|state fair park/i, 'Wisconsin State Fair'],
  [/miramar/i, 'Miramar Theatre'],
  [/wilson theater|vogel hall/i, 'Wilson Theater at Vogel Hall'],
  [/peck pavilion/i, 'Peck Pavilion'],
];
function canonVenue(name) {
  const n = String(name || '').trim();
  for (const [re, canon] of VENUE_ALIASES) if (re.test(n)) return canon;
  return n || 'TBA';
}

function hoodFor(venueName, city) {
  const key = (venueName || '').toLowerCase();
  for (const [frag, hood] of Object.entries(VENUE_HOODS)) if (key.includes(frag)) return hood;
  return city || 'Milwaukee';
}

// Map a source's genre string onto one of the app's genre keys. Order matters:
// more specific fragments are listed before broader ones.
const GENRE_MAP = {
  'metal': 'metal', 'hard rock': 'rock', 'punk': 'punk',
  'alternative': 'indie', 'indie': 'indie', 'rock': 'rock',
  'pop': 'pop', 'country': 'country', 'americana': 'folk', 'singer': 'folk', 'folk': 'folk',
  'jazz': 'jazz', 'blues': 'blues',
  'r&b': 'rnb', 'soul': 'rnb', 'rhythm': 'rnb',
  'hip': 'hiphop', 'rap': 'hiphop',
  'edm': 'electronic', 'house': 'electronic', 'dance': 'electronic', 'electronic': 'electronic',
  'latin': 'latin', 'festival': 'festival',
};
function genreFor(raw) {
  const g = (raw || '').toLowerCase();
  for (const [frag, key] of Object.entries(GENRE_MAP)) if (g.includes(frag)) return key;
  return 'other';
}

// Minimal geohash encoder — Ticketmaster's geoPoint param wants a geohash.
function geohash(lat, lon, precision = 7) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0, bit = 0, even = true, hash = '';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon > mid) { idx = idx * 2 + 1; lonMin = mid; } else { idx = idx * 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += base32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

// ---------- sources ----------

// Milwaukee music venues we always check directly by Ticketmaster venue ID.
// WHY: the geo search uses classificationName=music, but small-room shows
// (booked via TicketWeb) are often left "Undefined" in TM's data and get
// silently dropped. Querying by venueId without the classification filter
// catches them. Venues at 0 events are harmless to keep — they light up
// whenever they list something.
const MKE_VENUES = {
  'KovZpZAFAJeA': 'Shank Hall',
  'KovZpZAFAJdA': 'The Rave / Eagles Club',
  'KovZpZA1I6lA': 'Turner Hall Ballroom',
  'KovZpZAal6EA': 'Pabst Theater',
  'KovZ917ASYq': 'Vivarium',
  'KovZpZAE66IA': 'Cactus Club',
  'KovZpa8KXe': 'X-Ray Arcade',
  'KovZpZAalInA': 'Miramar Theatre',
  'KovZpZAdJEnA': 'Miller High Life Theatre',
  'rZ7HnEZ173e3A': 'Milwaukee Improv (Main Room)',
  'KovZ917AJ4Z': 'Milwaukee Improv',
  'Z7r9jZaAKG': 'The Fitzgerald',
  'rZ7HnEZ178O_4': "Linneman's Riverwest Inn",
  'rZ7HnEZ17fyA4': 'The Back Room at Colectivo',
  'Z7r9jZadMl': 'Anodyne Coffee',
  'KovZ917AITZ': 'The Cooperage',
};

// Venue-pass keep rule: music, comedy, and untagged events stay; theatrical
// productions and sports/film go. TM's comedy tagging is inconsistent —
// usually segment "Arts & Theatre" + genre "Comedy", but sometimes genre
// "Miscellaneous" (Leanne Morgan) or missing entirely (Seinfeld) — so we keep
// all of Arts & Theatre EXCEPT explicitly theatrical genres.
const THEATRICAL = new Set([
  'Performance Art', 'Theatre', 'Ballet', 'Opera', 'Dance',
  'Magic & Illusion', 'Circus & Specialty Acts', 'Puppetry', 'Spectacular',
  "Children's Theatre", 'Fashion', 'Multimedia', 'Cultural',
]);
function keepEvent(segmentName, genreName) {
  if (!segmentName || segmentName === 'Undefined') return true;
  if (segmentName === 'Music' || segmentName === 'Comedy') return true;
  if (segmentName === 'Arts & Theatre') return !THEATRICAL.has(genreName);
  return false;
}

// Pick a wide event image (~640px 16:9) from TM's images array, for the
// featured-show card. Optional — shows without one just have no img field.
function tmImage(e) {
  const imgs = e.images || [];
  const wide = imgs.filter(i => i.ratio === '16_9' && i.width >= 500).sort((a, b) => a.width - b.width);
  return (wide[0] || imgs[0] || {}).url;
}

// Ticket status, worst-first. When two sources disagree we keep the more
// serious one — better to over-warn than send someone to a dead show.
const STATUSES = ['cancelled', 'postponed', 'rescheduled', 'offsale', 'onsale'];
const statusRank = s => { const i = STATUSES.indexOf(s || 'onsale'); return i < 0 ? STATUSES.length : i; };

function tmEventToShow(e) {
  const start = e.dates?.start || {};
  const venue = e._embedded?.venues?.[0] || {};
  const acts = e._embedded?.attractions || [];
  const cls = e.classifications?.find(c => c.primary) || e.classifications?.[0] || {};
  const seg = cls.segment?.name;
  // Comedy: either its own segment, or an Arts & Theatre event that survived
  // the keepEvent() theatrical filter (stand-up tours live there in TM data).
  const isComedy = seg === 'Comedy' || seg === 'Arts & Theatre';
  const gName = cls.genre?.name && cls.genre.name !== 'Undefined' ? cls.genre.name : (seg || '');
  const img = tmImage(e);
  // "time to be announced" — the timestamp is a placeholder, not a showtime
  const tbd = !!(start.timeTBA || start.noSpecificTime);
  // cancelled / rescheduled / sold-out shows must not look like normal ones
  const code = (e.dates?.status?.code || '').toLowerCase();
  const status = STATUSES.includes(code) && code !== 'onsale' ? code : undefined;
  // a public on-sale time still in the future means "not buyable yet"
  const onsaleAt = e.sales?.public?.startDateTime;
  const onsale = onsaleAt && Date.parse(onsaleAt) > Date.now() ? onsaleAt : undefined;
  // face-value floor when Ticketmaster publishes it (~25% of events)
  const price = e.priceRanges?.length
    ? Math.min(...e.priceRanges.map(p => p.min).filter(n => typeof n === 'number'))
    : undefined;
  return {
    ...(img ? { img } : {}),
    ...(tbd ? { tbd: true } : {}),
    ...(status ? { status } : {}),
    ...(onsale ? { onsale } : {}),
    ...(price != null && isFinite(price) ? { price } : {}),
    date: start.localDate,
    time: hm(start.localTime),
    title: acts[0]?.name || e.name,
    support: acts.slice(1).map(a => a.name).join(', ') || null,
    venue: canonVenue(venue.name),
    hood: hoodFor(venue.name, venue.city?.name),
    genre: isComedy ? 'comedy' : genreFor(gName),
    ticketer: 'Ticketmaster',
    url: e.url,
  };
}

async function fromTicketmasterVenues(startISO, endISO) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return [];
  const out = [];
  for (const [venueId, label] of Object.entries(MKE_VENUES)) {
    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    u.searchParams.set('apikey', key);
    u.searchParams.set('venueId', venueId);
    u.searchParams.set('startDateTime', startISO);
    u.searchParams.set('endDateTime', endISO);
    u.searchParams.set('size', '100');
    u.searchParams.set('sort', 'date,asc');
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const e of (data._embedded?.events || [])) {
        if (!e.dates?.start?.localDate) continue;
        const cls0 = e.classifications?.[0] || {};
        if (!keepEvent(cls0.segment?.name, cls0.genre?.name)) continue;
        out.push(tmEventToShow(e));
      }
    } catch (err) {
      console.warn(`  ! venue pass failed for ${label}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 250)); // stay under TM's 5 req/s
  }
  console.log(`• Ticketmaster venue pass (${Object.keys(MKE_VENUES).length} venues): ${out.length} events`);
  return out;
}

async function fromTicketmaster(startISO, endISO) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) { console.log('• Ticketmaster: no TICKETMASTER_API_KEY set — skipping'); return []; }
  const out = [];
  const gh = geohash(LAT, LON, 7);
  let page = 0, totalPages = 1;
  while (page < totalPages && page < 5) {
    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    u.searchParams.set('apikey', key);
    u.searchParams.set('classificationName', 'music');
    u.searchParams.set('geoPoint', gh);
    u.searchParams.set('radius', String(RADIUS));
    u.searchParams.set('unit', 'miles');
    u.searchParams.set('startDateTime', startISO);
    u.searchParams.set('endDateTime', endISO);
    u.searchParams.set('size', '200');
    u.searchParams.set('sort', 'date,asc');
    u.searchParams.set('page', String(page));
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Ticketmaster HTTP ${res.status}`);
    const data = await res.json();
    totalPages = data.page?.totalPages ?? 1;
    for (const e of (data._embedded?.events || [])) {
      if (!e.dates?.start?.localDate) continue;
      out.push(tmEventToShow(e));
    }
    page++;
  }
  console.log(`• Ticketmaster geo pass: ${out.length} events`);
  return out;
}

async function fromSeatGeek(startD, endD) {
  const id = process.env.SEATGEEK_CLIENT_ID;
  if (!id) { console.log('• SeatGeek: no SEATGEEK_CLIENT_ID set — skipping'); return []; }
  const out = [];
  const per = 100;
  let page = 1, total = Infinity;
  while ((page - 1) * per < total && page <= 5) {
    const u = new URL('https://api.seatgeek.com/2/events');
    u.searchParams.set('client_id', id);
    u.searchParams.set('lat', String(LAT));
    u.searchParams.set('lon', String(LON));
    u.searchParams.set('range', `${RADIUS}mi`);
    // 'concert' alone misses club shows and comedy; SeatGeek splits these out
    for (const t of ['concert', 'music_festival', 'comedy']) u.searchParams.append('type', t);
    u.searchParams.set('datetime_local.gte', ymd(startD));
    u.searchParams.set('datetime_local.lte', ymd(endD));
    u.searchParams.set('per_page', String(per));
    u.searchParams.set('page', String(page));
    u.searchParams.set('sort', 'datetime_local.asc');
    const res = await fetch(u);
    if (!res.ok) throw new Error(`SeatGeek HTTP ${res.status}`);
    const data = await res.json();
    total = data.meta?.total ?? 0;
    for (const e of (data.events || [])) {
      const [date, time] = (e.datetime_local || '').split('T');
      if (!date) continue;
      const perfs = e.performers || [];
      const head = perfs.find(p => p.primary) || perfs[0] || {};
      const img = head.image || head.images?.huge || head.images?.large;
      const taxo = (e.taxonomies || []).map(t => t.name).join(' ');
      out.push({
        ...(img ? { img } : {}),
        ...(e.time_tbd || e.datetime_tbd ? { tbd: true } : {}),
        date,
        time: hm(time),
        title: head.name || e.short_title || e.title,
        support: perfs.filter(p => !p.primary).map(p => p.name).slice(0, 4).join(', ') || null,
        venue: canonVenue(e.venue?.name),
        hood: hoodFor(e.venue?.name, e.venue?.city),
        genre: /comedy/i.test(taxo) ? 'comedy' : genreFor(taxo || head.genres?.[0]?.name || ''),
        ticketer: 'SeatGeek',
        url: e.url,
      });
    }
    page++;
  }
  console.log(`• SeatGeek: ${out.length} events`);
  return out;
}

// The Argo (Whitefish Bay) — not on Ticketmaster (their TM venue record sits
// empty). Their site lists shows via a SociableKit→Eventbrite widget whose
// backing feed is public JSON, refreshed daily. Embed id from theargolive.com.
const ARGO_FEED = 'https://data.accentapi.com/feed/25619320.json?no_cache=1';

function unentity(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

async function fromArgo() {
  try {
    const res = await fetch(ARGO_FEED, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const out = [];
    for (const e of (d.events || [])) {
      if (!e.date_start || !e.name) continue;
      // organizer feed could include off-site events; keep Argo ones (blank
      // location means their own room)
      const loc = (e.location || '').toLowerCase();
      if (loc && !loc.includes('argo')) continue;
      out.push({
        ...(e.pic_big ? { img: e.pic_big } : {}),
        date: e.date_start,
        time: hm((e.local_date_time || '').slice(11, 16) || null),
        title: unentity(e.name),
        support: null,
        venue: 'The Argo',
        hood: 'Whitefish Bay',
        genre: 'other',
        ticketer: 'Eventbrite',
        url: e.ticket_uri || 'https://theargolive.com/events',
      });
    }
    console.log(`• The Argo (Eventbrite widget feed): ${out.length} events`);
    return out;
  } catch (err) {
    console.warn('  ! The Argo feed failed:', err.message);
    return [];
  }
}

// Calendar subscription file — every show as a VEVENT in Central time.
function buildIcs(shows) {
  const escT = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Confluence//Milwaukee Live Music//EN',
    'X-WR-CALNAME:The Confluence — Milwaukee Live Music', 'X-WR-TIMEZONE:America/Chicago',
  ];
  for (const s of shows) {
    const dt = s.date.replace(/-/g, '') + 'T' + s.time.replace(':', '') + '00';
    const endH = String((Number(s.time.slice(0, 2)) + 2) % 24).padStart(2, '0');
    const dtEnd = s.date.replace(/-/g, '') + 'T' + endH + s.time.slice(3) + '00';
    const uid = `${s.date}-${s.time}-${(s.title + s.venue).replace(/[^a-z0-9]/gi, '').slice(0, 40)}@theconfluence`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART;TZID=America/Chicago:${dt}`,
      `DTEND;TZID=America/Chicago:${dtEnd}`,
      `SUMMARY:${escT(s.title)} @ ${escT(s.venue)}`,
      `LOCATION:${escT(s.venue)}\\, ${escT(s.hood)}`,
      `DESCRIPTION:${escT((s.support ? 'With ' + s.support + '. ' : '') + 'Tickets: ' + s.url)}`,
      `URL:${s.url}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---------- shareable per-show pages ----------
// A calendar spreads when someone texts three friends "look at this". A link
// to the calendar's homepage previews as the homepage, so instead every show
// gets its own small page carrying its own og: tags — paste it into iMessage
// or Facebook and the artist's photo, name, venue and date do the selling.
// The page itself is one screen with one job: a button straight to tickets.
const SITE = 'https://theconfluencemke.com';
const PAGES_DIR = path.join(ROOT, 'show');
// How long a page outlives its show, so a link shared the week of the gig
// still resolves for the people who go back to it afterwards.
const PAGE_GRACE_DAYS = 30;

// Keep in sync with AFFILIATE in index.html — these pages are written by Node
// and never run that file's JS, so the params have to be applied here too.
const AFFILIATE = { Ticketmaster: {}, SeatGeek: {}, AXS: {}, Eventbrite: {} };

function ticketUrl(src, url) {
  const params = AFFILIATE[src];
  if (!params || !Object.keys(params).length) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  } catch { return url; }
}

// Escapes quotes too, unlike the page's own esc() — these strings land in
// attributes (og:title, alt, href).
const escH = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function slugify(s) {
  const base = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // RÜFÜS → RUFUS
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= 60) return base || 'show';
  // trim at a word boundary rather than mid-name
  return base.slice(0, 60).replace(/-[^-]*$/, '') || base.slice(0, 60);
}

// "big-head-todd-and-the-monsters-2026-10-18" — readable when pasted, and the
// trailing date is what the pruner reads back off the filename.
function assignSlugs(shows) {
  const taken = new Set();
  for (const s of shows) {
    const base = `${slugify(s.title)}-${s.date}`;
    let slug = base;
    // two rooms, same act, same night (The Rave runs several) — keep both
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    s.slug = slug;
  }
  return shows;
}

const fmt12 = t => {
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const d = new Date(date + 'T12:00:00');
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Only the statuses that still show a buy button need explaining — "Cancelled"
// and "Off sale" already say it where the button would have been.
const STATUS_NOTE = {
  postponed: 'This show has been postponed — check with the venue before buying.',
  rescheduled: 'This show has been rescheduled — check the date on the ticket page.',
};

function showPageHtml(s) {
  const when = s.tbd ? 'Time TBA' : (s.times && s.times.length > 1
    ? s.times.map(fmt12).join(' & ') : fmt12(s.time));
  const dateLine = `${longDate(s.date)} · ${when}`;
  const where = `${s.venue}${s.hood && s.hood !== s.venue ? ' · ' + s.hood : ''}`;
  const desc = `${s.title} plays ${s.venue} in Milwaukee on ${longDate(s.date)}${s.tbd ? '' : ' at ' + fmt12(s.time)}.`;
  const url = `${SITE}/show/${s.slug}.html`;
  const buy = (s.offers && s.offers[0]) || { src: s.ticketer, url: s.url };

  // one button, straight to the ticket page — same promise the calendar makes
  let action = `<a class="buy" href="${escH(ticketUrl(buy.src, buy.url))}" target="_blank" rel="noopener noreferrer">Get Tickets →</a>`;
  if (s.status === 'cancelled') action = '<p class="dead">Cancelled</p>';
  else if (s.status === 'offsale') action = '<p class="dead">Off sale</p>';

  const note = s.status && STATUS_NOTE[s.status]
    ? `<p class="note ${s.status}">${STATUS_NOTE[s.status]}</p>` : '';

  // structured data, so search results and some chat apps read the event
  // rather than guessing from the page text
  const ld = {
    '@context': 'https://schema.org', '@type': 'MusicEvent',
    name: s.title, url,
    startDate: `${s.date}T${s.time}:00-05:00`,
    eventStatus: `https://schema.org/Event${s.status === 'cancelled' ? 'Cancelled'
      : s.status === 'postponed' ? 'Postponed'
      : s.status === 'rescheduled' ? 'Rescheduled' : 'Scheduled'}`,
    location: { '@type': 'Place', name: s.venue, address: { '@type': 'PostalAddress', addressLocality: 'Milwaukee', addressRegion: 'WI', addressCountry: 'US' } },
    ...(s.img ? { image: s.img } : {}),
    ...(buy.url ? { offers: { '@type': 'Offer', url: buy.url, ...(buy.price != null ? { price: buy.price, priceCurrency: 'USD' } : {}) } } : {}),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escH(s.title)} — ${escH(s.venue)}, ${escH(longDate(s.date))} | The Confluence</title>
<meta name="description" content="${escH(desc)}" />
<link rel="canonical" href="${escH(url)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escH(url)}" />
<meta property="og:site_name" content="The Confluence" />
<meta property="og:title" content="${escH(s.title)} · ${escH(s.venue)}" />
<meta property="og:description" content="${escH(dateLine)} — Milwaukee" />
${s.img ? `<meta property="og:image" content="${escH(s.img)}" />\n<meta name="twitter:card" content="summary_large_image" />` : '<meta name="twitter:card" content="summary" />'}
<meta name="twitter:title" content="${escH(s.title)} · ${escH(s.venue)}" />
<meta name="twitter:description" content="${escH(dateLine)} — Milwaukee" />
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png" />
<link rel="apple-touch-icon" href="../apple-touch-icon.png" />
<meta name="theme-color" content="#0168FB" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--paper:#fdfcf8;--ink:#111;--gray:#6f6f6f;--faint:#9a9a9a;--line:#e7e7e3;--blue:#0168FB}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:600px;margin:0 auto;padding:0 26px}
.mast{background:#f4efe2;border-bottom:1px solid var(--line);padding:20px 0}
.mark{font-family:'Instrument Serif',Georgia,serif;font-size:28px;line-height:1;color:var(--blue);text-decoration:none;display:inline-block}
main.wrap{padding-top:38px;padding-bottom:52px}
.kicker{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
h1{font-family:'Space Grotesk',system-ui,sans-serif;font-size:clamp(30px,6.5vw,44px);font-weight:700;line-height:1.08;letter-spacing:-.015em;margin:10px 0 0}
h1.off{text-decoration:line-through;text-decoration-thickness:2px;color:var(--gray)}
.support{margin-top:8px;font-size:15px;color:var(--gray)}
.when{margin-top:20px;font-size:19px;font-weight:600}
.where{margin-top:3px;font-size:16px;color:var(--gray)}
.art{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--line);margin-top:26px}
.art.off{filter:grayscale(1);opacity:.55}
.buy{display:inline-block;margin-top:26px;background:var(--ink);color:var(--paper);text-decoration:none;font-size:16px;font-weight:600;padding:14px 26px;border:1px solid var(--ink)}
.buy:hover{background:var(--blue);border-color:var(--blue)}
.dead{margin-top:26px;font-size:16px;font-weight:600;color:var(--faint)}
.note{margin-top:14px;font-size:13.5px;font-weight:600}
.note.cancelled{color:var(--ink)}
.note.postponed,.note.rescheduled{color:#8a6a00}
.note.offsale{color:var(--gray)}
.back{display:block;margin-top:34px;padding-top:22px;border-top:1px solid var(--line);font-size:15px;color:var(--ink)}
.back a{color:var(--blue);text-decoration:none;font-weight:600}
.back a:hover{text-decoration:underline;text-underline-offset:3px}
footer.wrap{padding-bottom:44px;font-size:12.5px;color:var(--faint)}
</style>
</head>
<body>
<header class="mast"><div class="wrap"><a class="mark" href="../">The Confluence</a></div></header>
<main class="wrap">
  <p class="kicker">Live in Milwaukee</p>
  <h1${s.status === 'cancelled' ? ' class="off"' : ''}>${escH(s.title)}</h1>
  ${s.support ? `<p class="support">with ${escH(s.support)}</p>` : ''}
  <p class="when">${escH(dateLine)}</p>
  <p class="where">${escH(where)}</p>
  ${s.img ? `<img class="art${s.status === 'cancelled' ? ' off' : ''}" src="${escH(s.img)}" alt="${escH(s.title)}" />` : ''}
  ${action}
  ${note}
  <p class="back">Every show in Milwaukee, updated every morning — <a href="../">see the full calendar →</a></p>
</main>
<footer class="wrap">The Confluence · Milwaukee live music calendar</footer>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
}

// Writes one page per show and clears out pages whose show is long gone, so
// the directory tracks the feed instead of growing forever.
function buildShowPages(shows, today) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const live = new Set();
  for (const s of shows) {
    live.add(`${s.slug}.html`);
    fs.writeFileSync(path.join(PAGES_DIR, `${s.slug}.html`), showPageHtml(s));
  }

  const cutoff = new Date(today + 'T12:00:00');
  cutoff.setDate(cutoff.getDate() - PAGE_GRACE_DAYS);
  const cutoffStr = ymd(cutoff);
  let pruned = 0;
  for (const f of fs.readdirSync(PAGES_DIR)) {
    if (!f.endsWith('.html') || live.has(f)) continue;
    const d = f.match(/(\d{4}-\d{2}-\d{2})(?:-\d+)?\.html$/);
    if (d && d[1] >= cutoffStr) continue;      // still inside the grace window
    fs.unlinkSync(path.join(PAGES_DIR, f));
    pruned++;
  }
  console.log(`• Show pages: ${shows.length} written${pruned ? `, ${pruned} expired removed` : ''}`);
}

// ---------- artist previews (iTunes Search) ----------
// Resolved at build time so the page knows which listings can actually be
// played — no play button on comedy nights or local acts with no catalogue —
// and so pressing play starts instantly instead of waiting on a lookup.
// Results are cached between builds; only new artists are ever fetched.
const PREVIEW_CACHE = path.join(__dirname, 'preview-cache.json');

const cleanArtist = t => String(t || '')
  .replace(/\s*\(.*?\)\s*/g, ' ')          // "(Free)", "(Day 1)"
  .replace(/\s*[-–—:]\s*(a tribute|tribute).*$/i, '')
  .replace(/\s+w\/.*$/i, '')                // "w/ Support"
  .replace(/\s+/g, ' ')
  .trim();

async function lookupPreview(name) {
  const u = new URL('https://itunes.apple.com/search');
  u.searchParams.set('media', 'music');
  u.searchParams.set('entity', 'song');
  u.searchParams.set('limit', '5');
  u.searchParams.set('term', name);
  const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (res.status === 403 || res.status === 429) throw new Error(`rate limited (${res.status})`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const want = name.toLowerCase();
  // exact artist match only — "includes" collides badly on common names
  // (a gospel "Kevin Smith", a jazz "Tommy Davidson") and would play a
  // stranger's song under a comedian's listing
  const hit = (data.results || []).find(r => r.previewUrl && (r.artistName || '').toLowerCase() === want);
  return hit ? { url: hit.previewUrl, track: hit.trackName, artist: hit.artistName, kind: hit.primaryGenreName || '' } : null;
}

async function attachPreviews(shows) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(PREVIEW_CACHE, 'utf8')); } catch { /* first run */ }

  const names = [...new Set(shows.map(s => cleanArtist(s.title)).filter(Boolean))];
  const missing = names.filter(n => !(n in cache));
  let fetched = 0, failed = 0;

  for (const n of missing) {
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        cache[n] = await lookupPreview(n);  // null means "checked, none exists"
        fetched++; done = true;
      } catch (e) {
        // Apple throttles bursts; back off and give it one more go
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    if (!done) {
      failed++;
      if (failed >= 25) { console.warn('  ! previews: throttled, leaving the rest for the next build'); break; }
      continue;                            // uncached, so a later build retries
    }
    await new Promise(r => setTimeout(r, 480));   // stay under Apple's burst limit
  }

  try { fs.writeFileSync(PREVIEW_CACHE, JSON.stringify(cache, null, 0)); } catch {}

  let withPreview = 0;
  for (const s of shows) {
    const hit = cache[cleanArtist(s.title)];
    if (!hit || !hit.url) continue;
    // a comedian's listing should only play actual comedy — otherwise it's a
    // same-name musician, and the ▶ would be a lie
    if (s.genre === 'comedy' && !/comedy|spoken/i.test(hit.kind || '')) continue;
    s.preview = hit; withPreview++;
  }
  console.log(`• Previews: ${withPreview}/${shows.length} shows playable (${fetched} looked up, ${names.length - missing.length} cached)`);
  return shows;
}

function loadExtras() {
  try {
    const arr = JSON.parse(fs.readFileSync(EXTRAS, 'utf8'));
    const shows = Array.isArray(arr) ? arr : (arr.shows || []);
    console.log(`• Manual extras: ${shows.length} shows`);
    return shows;
  } catch { return []; }
}

// Keep the page's built-in fallback list (used when it's opened as a local
// file://, where fetch is blocked) in sync with the freshest data, so
// double-clicking the HTML always shows current shows too.
function updateEmbedded(payload) {
  const htmlPath = path.join(ROOT, 'index.html');
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); } catch { return; }
  const re = /(<script id="embedded-shows"[^>]*>)([\s\S]*?)(<\/script>)/;
  if (!re.test(html)) return;
  // Escape "<" so a stray "</script>" in any title can't break the tag.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  fs.writeFileSync(htmlPath, html.replace(re, `$1${json}$3`));
  console.log('• Embedded fallback in HTML refreshed');
}

// Different sources spell the same room differently ("The Rave-Eagles Club"
// vs "Rave / Eagles Club"), so squash to a comparable core before matching.
function normKey(s) {
  return String(s || '')
    // sources append " - Milwaukee" / " - Marcus Center for the …" to the
    // same room; drop anything after the first dash separator
    .split(' - ')[0]
    // RÜFÜS DU SOL vs RUFUS DU SOL — fold accents before comparing
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|at|a)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)          // first few words carry the identity
    .join(' ');
}

// Levenshtein similarity, 0..1. Used only to catch spelling variants of the
// SAME show ("Jennifer Lyn" vs "Jennifer Lynn"); the threshold is deliberately
// high because multi-room venues (The Rave, the Improv) genuinely run
// different shows at the same time, and merging those would lose listings.
function similarity(a, b) {
  if (a === b) return 1;
  const [s, t] = a.length >= b.length ? [a, b] : [b, a];
  if (!s.length) return 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[t.length] / s.length;
}
const TITLE_MATCH = 0.85;
// Two listings of the same act on the same night more than this far apart are
// genuinely separate performances (comedy clubs run ~7:00 and ~9:15). Closer
// than this and it's one show whose sources disagree — often doors vs stage
// time (Modest Mouse listed 7:00 by one source, 8:00 by the other).
const SEPARATE_SHOW_MIN = 120;

const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const toHM = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// Second pass: within one date+venue, fold near-identical titles into a single
// listing. Showtimes are clustered — a real double-header keeps both times,
// while a source disagreement collapses to one.
function mergeTitleVariants(shows) {
  const slots = new Map();
  for (const s of shows) {
    const slot = `${s.date}|${normKey(s.venue)}`;
    const list = slots.get(slot) || [];
    const twin = list.find(x => similarity(normKey(x.title), normKey(s.title)) >= TITLE_MATCH);
    if (twin) {
      for (const o of s.offers || []) if (!twin.offers.some(t => t.src === o.src)) twin.offers.push(o);
      if (!twin.img && s.img) twin.img = s.img;
      if (!twin.support && s.support) twin.support = s.support;
      if (!twin.onsale && s.onsale) twin.onsale = s.onsale;
      if (statusRank(s.status) < statusRank(twin.status)) twin.status = s.status;
      twin._t.push({ min: toMin(s.time), src: s.ticketer, tbd: !!s.tbd });
      if (!s.tbd) twin.tbd = twin.tbd && false;
    } else {
      s._t = [{ min: toMin(s.time), src: s.ticketer, tbd: !!s.tbd }];
      list.push(s);
      slots.set(slot, list);
    }
  }

  const out = [];
  for (const list of slots.values()) for (const s of list) {
    // a "time TBA" placeholder must never invent a showtime or a second
    // performance — drop those the moment any source states a real time
    const real = s._t.filter(t => !t.tbd);
    if (real.length) { s._t = real; delete s.tbd; } else { s.tbd = true; }
    const sorted = s._t.sort((a, b) => a.min - b.min);
    const clusters = [];
    for (const t of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && t.min - last[last.length - 1].min < SEPARATE_SHOW_MIN) last.push(t);
      else clusters.push([t]);
    }
    // within a cluster prefer Ticketmaster's stated time, else the earliest
    const times = clusters.map(c => (c.find(x => x.src === 'Ticketmaster') || c[0]).min);
    delete s._t;
    s.time = toHM(times[0]);
    if (times.length > 1) s.times = times.map(toHM);
    out.push(s);
  }
  return out;
}

// Which ticket page to send people to when a show sells in several places.
// Primary/box-office sellers first, resale marketplaces last — buying direct
// is normally the better deal.
const SOURCE_RANK = { Ticketmaster: 0, AXS: 1, Eventbrite: 1, 'At the door': 1, SeatGeek: 5 };
const rankOf = src => (SOURCE_RANK[src] ?? 3);
const bestOfferFirst = (a, b) => rankOf(a.src) - rankOf(b.src) || a.src.localeCompare(b.src);

// One offer per ticketing source: where to buy, and the price if we know it.
function toOffer(s) {
  return { src: s.ticketer, url: s.url, ...(s.price != null ? { price: s.price } : {}) };
}

// Merge rather than discard: the same show on two platforms becomes one
// listing carrying both places to buy.
function dedupe(shows) {
  const seen = new Map();
  for (const s of shows) {
    // time is part of the key so a comedy club's 7:00 + 9:45 double-header
    // survives, while duplicate records of one show still collapse.
    const k = `${s.date}|${s.time}|${normKey(s.title)}|${normKey(s.venue)}`;
    const prev = seen.get(k);
    if (!prev) { seen.set(k, { ...s, offers: [toOffer(s)] }); continue; }

    // fold this source's offer in (skip if that source is already present)
    if (!prev.offers.some(o => o.src === s.ticketer)) prev.offers.push(toOffer(s));
    // and let the richer record supply the display fields
    if (!prev.img && s.img) prev.img = s.img;
    if (!prev.support && s.support) prev.support = s.support;
    if (prev.price == null && s.price != null) prev.price = s.price;
    if (!prev.onsale && s.onsale) prev.onsale = s.onsale;
    // never let a cheerful source overwrite a cancellation
    if (statusRank(s.status) < statusRank(prev.status)) prev.status = s.status;
  }
  // best place to buy first (box office before resale)
  for (const s of seen.values()) {
    s.offers.sort(bestOfferFirst);
    s.url = s.offers[0].url;          // where the listing links
    s.ticketer = s.offers[0].src;
  }
  return [...seen.values()];
}

async function main() {
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() + DAYS_AHEAD);
  const startISO = now.toISOString().slice(0, 19) + 'Z';
  const endISO = end.toISOString().slice(0, 19) + 'Z';

  const results = await Promise.allSettled([
    fromTicketmaster(startISO, endISO),
    fromTicketmasterVenues(startISO, endISO),
    fromSeatGeek(now, end),
    fromArgo(),
  ]);

  let shows = [];
  for (const r of results) {
    if (r.status === 'fulfilled') shows.push(...r.value);
    else console.warn('  ! source failed:', r.reason?.message || r.reason);
  }
  shows.push(...loadExtras());

  const todayStr = ymd(now);
  shows = shows.filter(s => s.date && s.title && s.url && s.date >= todayStr);
  shows = mergeTitleVariants(dedupe(shows))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  // offers may have grown during the variant merge — re-sort and re-point
  for (const s of shows) {
    s.offers.sort(bestOfferFirst);
    s.url = s.offers[0].url;
    s.ticketer = s.offers[0].src;
  }

  if (!shows.length) {
    console.error('✗ No shows fetched from any source — leaving existing shows.json untouched.');
    process.exit(1);
  }

  await attachPreviews(shows);
  assignSlugs(shows);            // every show gets its own shareable address

  const payload = { updated: todayStr, shows };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(ROOT, 'confluence.ics'), buildIcs(shows));
  updateEmbedded(payload);
  buildShowPages(shows, todayStr);
  const days = new Set(shows.map(s => s.date)).size;
  console.log(`\n✓ Wrote ${shows.length} shows across ${days} days to shows.json (updated ${todayStr})`);
}

// Rebuild the slugs and the share pages from whatever is already in
// shows.json — no API keys, no network. Handy after editing manual-extras, and
// it's how the pages were first generated.
function pagesOnly() {
  const payload = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assignSlugs(payload.shows);
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  updateEmbedded(payload);
  buildShowPages(payload.shows, ymd(new Date()));
}

// Run only when invoked directly (`node feed/build-shows.js`), so the pure
// helpers above can be imported by the test suite without hitting the network.
if (require.main === module) {
  if (process.argv.includes('--pages')) {
    try { pagesOnly(); } catch (e) { console.error('Page build failed:', e); process.exit(1); }
  } else {
    main().catch(e => { console.error('Build failed:', e); process.exit(1); });
  }
}

module.exports = { ymd, hm, hoodFor, genreFor, geohash, dedupe, normKey, similarity, mergeTitleVariants, cleanArtist, statusRank, keepEvent, tmEventToShow, tmImage, unentity, buildIcs, slugify, assignSlugs, showPageHtml, GENRE_MAP, VENUE_HOODS, MKE_VENUES };
