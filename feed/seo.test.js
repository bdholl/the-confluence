'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lib = require('./lib');
const seo = require('./seo');
const { argoAddress } = require('./build-shows.js');

const ROOT = path.join(__dirname, '..');

// --- timezone ---------------------------------------------------------------

test('chicagoOffset follows daylight saving', () => {
  // Structured data used to hardcode -05:00, so every show from November to
  // March was an hour off in Google.
  assert.equal(lib.chicagoOffset('2026-07-04', '20:00'), '-05:00');
  assert.equal(lib.chicagoOffset('2026-10-31', '20:00'), '-05:00');   // last day of CDT
  assert.equal(lib.chicagoOffset('2026-11-01', '20:00'), '-06:00');   // CST from 2am
  assert.equal(lib.chicagoOffset('2026-12-15', '19:30'), '-06:00');
  assert.equal(lib.chicagoOffset('2027-03-14', '20:00'), '-05:00');   // back to CDT
});

test('chicagoNow reads Milwaukee wall-clock time from a UTC instant', () => {
  // 20:00 UTC in July = 3 PM CDT; in December = 2 PM CST
  const jul = lib.chicagoNow(new Date('2026-07-15T20:00:00Z'));
  assert.equal(jul.date, '2026-07-15');
  assert.equal(jul.minutes, 15 * 60);
  const dec = lib.chicagoNow(new Date('2026-12-15T20:00:00Z'));
  assert.equal(dec.minutes, 14 * 60);
  // 03:00 UTC is still the previous evening in Milwaukee
  assert.equal(lib.chicagoNow(new Date('2026-07-16T03:00:00Z')).date, '2026-07-15');
});

// --- affiliate links ----------------------------------------------------------

test('ticketUrl wraps by host with an impact.com-style template, and only when set', () => {
  const rules = [
    { match: '(^|\\.)seatgeek\\.com$', wrap: 'https://seatgeek.pxf.io/c/1/2/3?u={url}' },
    { match: '(^|\\.)(ticketmaster|ticketweb)\\.com$', wrap: '' },
  ];
  const sg = 'https://seatgeek.com/x-tickets/123?a=1&b=2';
  assert.equal(lib.ticketUrl(sg, rules), `https://seatgeek.pxf.io/c/1/2/3?u=${encodeURIComponent(sg)}`);
  // empty template = not approved yet = untouched
  assert.equal(lib.ticketUrl('https://www.ticketweb.com/event/1', rules), 'https://www.ticketweb.com/event/1');
  // a lookalike host must not match
  assert.equal(lib.ticketUrl('https://notseatgeek.com/x', rules), 'https://notseatgeek.com/x');
  assert.equal(lib.ticketUrl('not a url', rules), 'not a url');
});

test('feed/affiliate.json is valid and every pattern compiles', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'affiliate.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.rules));
  for (const r of cfg.rules) {
    assert.doesNotThrow(() => new RegExp(r.match), `bad pattern: ${r.match}`);
    if (r.wrap) assert.match(r.wrap, /\{url\}/, `${r.program}: wrap template needs a {url} placeholder`);
  }
});

// --- venue addresses ------------------------------------------------------------

test('argoAddress parses the Argo feed location string', () => {
  assert.deepEqual(argoAddress('The Argo, 334 East Silver Spring Drive, Whitefish Bay, WI 53217'),
    { street: '334 East Silver Spring Drive', city: 'Whitefish Bay', region: 'WI', postal: '53217', source: 'argo' });
  assert.equal(argoAddress(''), undefined);
});

test('learnVenues keeps the best address and never overrides a manual one', () => {
  const table = {
    'Hand Fixed': { street: '1 Right St', city: 'Milwaukee', region: 'WI', postal: '53202', manual: true },
  };
  const shows = [
    { venue: 'Cactus Club', addr: { street: '2496 S Wentworth Ave', city: 'Milwaukee', region: 'WI', postal: '53207', source: 'ticketmaster' } },
    { venue: 'Cactus Club', addr: { city: 'Milwaukee', region: 'WI', source: 'seatgeek' } },        // vaguer — ignored
    { venue: 'Hand Fixed', addr: { street: '9 Wrong Rd', city: 'Milwaukee', source: 'seatgeek' } },  // manual wins
  ];
  seo.learnVenues(shows, table);
  assert.equal(table['Cactus Club'].street, '2496 S Wentworth Ave');
  assert.equal(table['Hand Fixed'].street, '1 Right St');
  assert.ok(shows.every(s => !('addr' in s)), 'addr is stripped off the show once learned');
});

test('learnVenues trusts Ticketmaster over SeatGeek, and settles instead of flapping', () => {
  // Real case: SeatGeek has the Improv at "20110 Lower" — street name cut off.
  // Without a ranking the two sources overwrote each other on every build.
  const table = {};
  const tm = { venue: 'Milwaukee Improv', addr: { street: '20110 Lower Union St', city: 'Brookfield', region: 'WI', postal: '53045', source: 'ticketmaster' } };
  const sg = { venue: 'Milwaukee Improv', addr: { street: '20110 Lower', city: 'Brookfield', region: 'WI', postal: '53045', source: 'seatgeek' } };
  seo.learnVenues([{ ...sg }, { ...tm }], table);
  assert.equal(table['Milwaukee Improv'].street, '20110 Lower Union St', 'the trusted source wins whatever the order');
  const again = seo.learnVenues([{ ...tm, addr: { ...tm.addr } }, { ...sg, addr: { ...sg.addr } }], table);
  assert.equal(again, 0, 'a second build changes nothing');
});

test('addressFor falls back to the right town, not always Milwaukee', () => {
  assert.equal(seo.addressFor({ venue: 'X', hood: 'Bay View' }, {}).addressLocality, 'Milwaukee');   // a neighborhood
  assert.equal(seo.addressFor({ venue: 'X', hood: 'Brookfield' }, {}).addressLocality, 'Brookfield'); // a suburb
  const full = seo.addressFor({ venue: 'The Argo' }, { 'The Argo': { street: '334 E Silver Spring Dr', city: 'Whitefish Bay', region: 'WI', postal: '53217' } });
  assert.equal(full.streetAddress, '334 E Silver Spring Dr');
  assert.equal(full.postalCode, '53217');
});

// --- event structured data ----------------------------------------------------------

const baseShow = {
  title: 'Modest Mouse', support: 'Mattress, Built To Spill', date: '2026-12-05', time: '20:00',
  venue: 'Riverside Theater', hood: 'Downtown', genre: 'indie', slug: 'modest-mouse-2026-12-05',
  img: 'https://img.example/a.jpg', price: 45,
  offers: [{ src: 'Ticketmaster', url: 'https://www.ticketmaster.com/modest-mouse/event/0ABC', price: 45 }],
};
const ld = (s, table = {}) => seo.eventJsonLd(s, { url: `${lib.SITE}/show/${s.slug}.html`, performer: s.title, table });

test('eventJsonLd carries everything Google asks for', () => {
  const e = ld(baseShow);
  assert.equal(e['@type'], 'MusicEvent');
  assert.equal(e.startDate, '2026-12-05T20:00:00-06:00', 'December is CST');
  assert.equal(e.eventAttendanceMode, 'https://schema.org/OfflineEventAttendanceMode');
  assert.equal(e.eventStatus, 'https://schema.org/EventScheduled');
  assert.equal(e.location.name, 'Riverside Theater');
  assert.deepEqual(e.performer.map(p => p.name), ['Modest Mouse', 'Mattress', 'Built To Spill']);
  assert.equal(e.performer[0]['@type'], 'PerformingGroup');
  assert.deepEqual(e.image, ['https://img.example/a.jpg']);
  assert.equal(e.offers.availability, 'https://schema.org/InStock');
  assert.equal(e.offers.price, 45);
  assert.equal(e.offers.priceCurrency, 'USD');
});

test('eventJsonLd: comedy, TBA, cancelled, and future on-sale', () => {
  const comedy = ld({ ...baseShow, genre: 'comedy', support: null });
  assert.equal(comedy['@type'], 'ComedyEvent');
  assert.equal(comedy.performer['@type'], 'Person');

  assert.equal(ld({ ...baseShow, tbd: true }).startDate, '2026-12-05', 'no invented showtime');

  const gone = ld({ ...baseShow, status: 'cancelled' });
  assert.equal(gone.eventStatus, 'https://schema.org/EventCancelled');
  assert.equal(gone.offers, undefined, 'no ticket offer for a cancelled show');

  const later = ld({ ...baseShow, onsale: '2099-01-01T15:00:00Z' });
  assert.equal(later.offers.availability, 'https://schema.org/PreOrder');
  assert.equal(later.offers.validFrom, '2099-01-01T15:00:00Z');

  const noPic = ld({ ...baseShow, img: undefined });
  assert.equal(noPic.image, undefined, 'omit rather than fake an image');
});

// --- generated files: the CI validator --------------------------------------------------
// Every show page on disk must carry structured data Google will accept. If a
// change breaks the markup, the daily build fails here instead of the events
// quietly dropping out of search.

const EVENT_TYPES = new Set(['MusicEvent', 'ComedyEvent']);
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})?$/;

test('every generated show page has valid event markup', () => {
  const dir = path.join(ROOT, 'show');
  const showsFile = path.join(ROOT, 'shows.json');
  if (!fs.existsSync(dir) || !fs.existsSync(showsFile)) return;
  const current = new Set(JSON.parse(fs.readFileSync(showsFile, 'utf8')).shows.map(s => `${s.slug}.html`));
  let checked = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!current.has(f)) continue;           // past pages in their grace window are frozen
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(m, `${f}: no JSON-LD`);
    const e = JSON.parse(m[1]);
    const where = `${f} (${e.name})`;
    assert.ok(EVENT_TYPES.has(e['@type']), `${where}: @type ${e['@type']}`);
    assert.ok(e.name, `${where}: name`);
    assert.match(e.startDate, ISO, `${where}: startDate ${e.startDate}`);
    if (e.startDate.length > 10) {
      assert.equal(e.startDate.slice(-6), lib.chicagoOffset(e.startDate.slice(0, 10), e.startDate.slice(11, 16)), `${where}: wrong UTC offset`);
    }
    assert.ok(e.location?.name, `${where}: location.name`);
    assert.ok(e.location?.address?.addressLocality, `${where}: address locality`);
    assert.equal(e.location.address.addressCountry, 'US', `${where}: country`);
    assert.ok(e.eventStatus?.startsWith('https://schema.org/Event'), `${where}: eventStatus`);
    if (e.offers) assert.match(e.offers.url, /^https:\/\//, `${where}: offer url`);
    if (e.image) for (const i of e.image) assert.match(i, /^https:\/\//, `${where}: image url`);
    assert.match(html, /<link rel="canonical" href="https:\/\/theconfluencemke\.com\/show\//, `${where}: canonical`);
    assert.match(html, /<meta property="og:image" content="https:\/\//, `${where}: og:image`);
    checked++;
  }
  assert.ok(checked > 0 || current.size === 0, 'no show pages were checked');
});

test('sitemap lists every upcoming show and day page; robots points at it', () => {
  const smFile = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(smFile)) return;
  const sm = fs.readFileSync(smFile, 'utf8');
  assert.match(sm, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((sm.match(/<url>/g) || []).length, (sm.match(/<\/url>/g) || []).length, 'balanced <url> tags');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|#39;)/.test(sm), 'unescaped ampersand in sitemap');
  const locs = new Set([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
  const { shows } = JSON.parse(fs.readFileSync(path.join(ROOT, 'shows.json'), 'utf8'));
  // "upcoming" as of the build that wrote the sitemap, which may be a day
  // after the feed's own date if the pages were rebuilt without the APIs
  const firstDay = [...locs].filter(l => l.includes('/day/')).sort()[0]?.match(/(\d{4}-\d{2}-\d{2})/)[1];
  assert.ok(firstDay, 'sitemap has no day pages');
  for (const s of shows.filter(s => s.date >= firstDay)) {
    assert.ok(locs.has(`${lib.SITE}/show/${s.slug}.html`), `sitemap missing ${s.slug}`);
    assert.ok(locs.has(`${lib.SITE}/day/${s.date}.html`), `sitemap missing day ${s.date}`);
    assert.ok(fs.existsSync(path.join(ROOT, 'day', `${s.date}.html`)), `no day page for ${s.date}`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/theconfluencemke\.com\/sitemap\.xml/);
});

test('day pages summarize with an ItemList pointing at the show pages', () => {
  const html = seo.dayPageHtml('2026-12-05', [baseShow], { prev: '2026-12-04', next: null });
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const list = JSON.parse(m[1]);
  assert.equal(list['@type'], 'ItemList');
  assert.equal(list.itemListElement[0].url, `${lib.SITE}/show/modest-mouse-2026-12-05.html`);
  assert.match(html, /<link rel="canonical" href="https:\/\/theconfluencemke\.com\/day\/2026-12-05\.html"/);
  assert.match(html, /href="2026-12-04\.html"/, 'links to the previous day');
});

test('updateIndex injects day links and affiliate rules, idempotently', () => {
  const html = '<p>x</p><!-- day-links --><!-- /day-links --><script id="affiliate-config" type="application/json">{"rules":[]}</script>';
  const rules = [{ match: 'seatgeek', wrap: 'https://t.example/?u={url}' }];
  const once = seo.updateIndex(html, { dates: ['2026-12-05', '2026-12-06'], affiliate: rules });
  assert.match(once, /<a href="day\/2026-12-05\.html">Sat Dec 5<\/a>/);
  assert.match(once, /"wrap":"https:\/\/t\.example\/\?u=\{url\}"/);
  assert.equal(seo.updateIndex(once, { dates: ['2026-12-05', '2026-12-06'], affiliate: rules }), once, 'running twice changes nothing');
});
