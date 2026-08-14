'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ymd, hm, hoodFor, genreFor, geohash, dedupe, normKey, similarity, mergeTitleVariants, cleanArtist, keepEvent, tmEventToShow, tmImage, unentity, buildIcs, slugify, assignSlugs, showPageHtml, itunesGenre, refineGenres, pointAtBestOffer, GENRE_MAP } = require('./build-shows.js');

// The genre keys the front-end knows how to label + color. Every genre the
// feed can emit must be in this set, or shows render with a bare key + no color.
const ALLOWED_GENRES = new Set([
  'rock', 'metal', 'jazz', 'blues', 'punk', 'indie', 'country', 'pop',
  'hiphop', 'rnb', 'latin', 'folk', 'festival', 'electronic', 'comedy', 'other',
]);

// --- date / time helpers ---------------------------------------------------

test('ymd formats a Date as YYYY-MM-DD with zero padding', () => {
  assert.equal(ymd(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.equal(ymd(new Date(2026, 11, 31, 12)), '2026-12-31');
});

test('hm trims seconds to HH:MM and defaults when missing', () => {
  assert.equal(hm('19:30:00'), '19:30');
  assert.equal(hm('08:00'), '08:00');
  assert.equal(hm(null), '20:00');
  assert.equal(hm(undefined), '20:00');
});

// --- neighborhood mapping --------------------------------------------------

test('hoodFor matches known venues by substring, case-insensitive', () => {
  assert.equal(hoodFor('X-Ray Arcade', 'Cudahy'), 'Cudahy');
  assert.equal(hoodFor('The Rave / Eagles Club', 'Milwaukee'), 'Westown');
  assert.equal(hoodFor('Cactus Club', 'Milwaukee'), 'Bay View');
  assert.equal(hoodFor('THE PABST THEATER', 'Milwaukee'), 'Downtown');
});

test('hoodFor falls back to the city when the venue is unknown', () => {
  assert.equal(hoodFor('Some New Bar', 'Wauwatosa'), 'Wauwatosa');
  assert.equal(hoodFor('', ''), 'Milwaukee');
  assert.equal(hoodFor(undefined, undefined), 'Milwaukee');
});

// --- genre mapping ---------------------------------------------------------

test('genreFor maps source genre strings to allowed keys', () => {
  assert.equal(genreFor('Hard Rock'), 'rock');
  assert.equal(genreFor('Heavy Metal'), 'metal');
  assert.equal(genreFor('Hip-Hop/Rap'), 'hiphop');
  assert.equal(genreFor('R&B'), 'rnb');
  assert.equal(genreFor('Dance/Electronic'), 'electronic');
  assert.equal(genreFor('Singer/Songwriter'), 'folk');
  assert.equal(genreFor('Alternative'), 'indie');
  assert.equal(genreFor('Country'), 'country');
});

test('genreFor returns "other" for unknown/empty input', () => {
  assert.equal(genreFor('Polka'), 'other');
  assert.equal(genreFor(''), 'other');
  assert.equal(genreFor(null), 'other');
});

test('every GENRE_MAP target is a genre the front-end can render', () => {
  for (const key of Object.values(GENRE_MAP)) {
    assert.ok(ALLOWED_GENRES.has(key), `GENRE_MAP emits "${key}" which the UI does not support`);
  }
});

// --- geohash ---------------------------------------------------------------

function decodeGeohash(gh) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let even = true, latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (const c of gh) {
    const cd = base32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const bit = (cd >> i) & 1;
      if (even) { const mid = (lonMin + lonMax) / 2; if (bit) lonMin = mid; else lonMax = mid; }
      else { const mid = (latMin + latMax) / 2; if (bit) latMin = mid; else latMax = mid; }
      even = !even;
    }
  }
  return [(latMin + latMax) / 2, (lonMin + lonMax) / 2];
}

test('geohash matches the known reference for New York City', () => {
  assert.equal(geohash(40.7128, -74.0060, 7), 'dr5regw');
});

test('geohash round-trips Milwaukee to within a precision-7 cell', () => {
  const [lat, lon] = decodeGeohash(geohash(43.0389, -87.9065, 7));
  assert.ok(Math.abs(lat - 43.0389) < 0.01, `lat off: ${lat}`);
  assert.ok(Math.abs(lon - -87.9065) < 0.01, `lon off: ${lon}`);
});

// --- venue pass: classification rule ---------------------------------------

test('keepEvent keeps music, comedy, and untagged; drops theatre/sports/film', () => {
  assert.equal(keepEvent('Music', 'Rock'), true);
  assert.equal(keepEvent(undefined, undefined), true);      // small-room shows often untagged
  assert.equal(keepEvent('Undefined', undefined), true);    // TM's literal "Undefined" segment
  assert.equal(keepEvent('Comedy', 'Comedy'), true);
  // comedy usually hides under Arts & Theatre, with inconsistent genres:
  assert.equal(keepEvent('Arts & Theatre', 'Comedy'), true);          // Robby Hoffman
  assert.equal(keepEvent('Arts & Theatre', 'Miscellaneous'), true);   // Leanne Morgan
  assert.equal(keepEvent('Arts & Theatre', undefined), true);         // Jerry Seinfeld
  // real theatre stays out:
  assert.equal(keepEvent('Arts & Theatre', 'Performance Art'), false); // Cirque Dreams
  assert.equal(keepEvent('Arts & Theatre', 'Theatre'), false);
  assert.equal(keepEvent('Arts & Theatre', 'Ballet'), false);
  assert.equal(keepEvent('Sports', undefined), false);
  assert.equal(keepEvent('Film', undefined), false);
});

test('tmEventToShow tags surviving Arts & Theatre / Comedy events as comedy', () => {
  const s = tmEventToShow({
    name: 'Eddie Griffin',
    url: 'https://www.ticketmaster.com/x',
    dates: { start: { localDate: '2026-08-21', localTime: '19:30:00' } },
    classifications: [{ primary: true, segment: { name: 'Arts & Theatre' }, genre: { name: 'Comedy' } }],
    _embedded: { venues: [{ name: 'Milwaukee Improv (Main Room)', city: { name: 'Brookfield' } }] },
  });
  assert.equal(s.genre, 'comedy');
  assert.equal(s.hood, 'Brookfield');
});

test('tmEventToShow maps a raw TM event to the show schema', () => {
  const s = tmEventToShow({
    name: 'Fallback Name',
    url: 'https://www.ticketmaster.com/x',
    dates: { start: { localDate: '2026-09-13', localTime: '20:00:00' } },
    classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Hip-Hop/Rap' } }],
    _embedded: {
      venues: [{ name: 'Vivarium', city: { name: 'Milwaukee' } }],
      attractions: [{ name: 'Raq Baby' }, { name: 'Opener A' }],
    },
  });
  assert.deepEqual(s, {
    date: '2026-09-13', time: '20:00', title: 'Raq Baby', support: 'Opener A',
    venue: 'Vivarium', hood: 'East Side', genre: 'hiphop', ticketer: 'Ticketmaster',
    url: 'https://www.ticketmaster.com/x',
  });
});

test('tmEventToShow handles untagged events (genre → other, name fallback)', () => {
  const s = tmEventToShow({
    name: 'Healing Gems',
    url: 'https://www.ticketweb.com/x',
    dates: { start: { localDate: '2026-08-15' } },   // no time, no classifications
    _embedded: { venues: [{ name: 'Cactus Club', city: { name: 'Milwaukee' } }] },
  });
  assert.equal(s.title, 'Healing Gems');
  assert.equal(s.time, '20:00');       // default when TM omits the time
  assert.equal(s.genre, 'other');
  assert.equal(s.hood, 'Bay View');
});

// --- dedupe ----------------------------------------------------------------

test('normKey squashes venue spellings that differ across sources', () => {
  assert.equal(normKey('The Rave-Eagles Club'), normKey('Rave / Eagles Club'));
  assert.equal(normKey('Turner Hall Ballroom'), normKey('turner hall ballroom'));
  assert.equal(normKey('Shank Hall'), normKey('The Shank Hall'));
  // SeatGeek appends a city / parent-complex suffix after a dash
  assert.equal(normKey('Miramar Theatre'), normKey('Miramar Theatre - Milwaukee'));
  assert.equal(normKey('Wilson Theater at Vogel Hall'),
               normKey('Wilson Theater at Vogel Hall - Marcus Center for the Performing Arts'));
  assert.notEqual(normKey('Cactus Club'), normKey('Vivarium'));
});

test('dedupe merges the same show from two sources, keeping the richer record', () => {
  const merged = dedupe([
    { date: '2026-09-01', time: '20:00', title: 'Band X', venue: 'The Rave-Eagles Club', ticketer: 'Ticketmaster' },
    { date: '2026-09-01', time: '20:00', title: 'Band X', venue: 'Rave / Eagles Club', ticketer: 'SeatGeek', img: 'pic.jpg', support: 'Opener' },
  ]);
  assert.equal(merged.length, 1, 'cross-source duplicate should collapse');
  assert.equal(merged[0].img, 'pic.jpg', 'the record with an image should win');
});

test('dedupe orders offers cheapest-first and makes that the primary link', () => {
  const [show] = dedupe([
    { date: '2026-10-01', time: '20:00', title: 'Band Z', venue: 'Pabst Theater', ticketer: 'SeatGeek', url: 'sg' },
    { date: '2026-10-01', time: '20:00', title: 'Band Z', venue: 'Pabst Theater', ticketer: 'Ticketmaster', url: 'tm', price: 30 },
  ]);
  assert.equal(show.offers.length, 2, 'both platforms should be offered');
  assert.equal(show.offers[0].src, 'Ticketmaster', 'the priced offer sorts first');
  assert.equal(show.url, 'tm', 'primary link follows the first offer');
});

test('dedupe never lists the same platform twice for one show', () => {
  const [show] = dedupe([
    { date: '2026-10-02', time: '20:00', title: 'Band Y', venue: 'Vivarium', ticketer: 'Ticketmaster', url: 'a' },
    { date: '2026-10-02', time: '20:00', title: 'Band Y', venue: 'Vivarium', ticketer: 'Ticketmaster', url: 'b' },
  ]);
  assert.equal(show.offers.length, 1);
});

test('dedupe collapses same date+title+venue into one merged listing', () => {
  const shows = [
    { date: '2026-06-10', title: 'Band A', venue: 'Shank Hall', ticketer: 'Ticketmaster' },
    { date: '2026-06-10', title: 'band a', venue: 'shank hall', ticketer: 'SeatGeek' }, // dup (case-insensitive)
    { date: '2026-06-10', title: 'Band A', venue: 'Cactus Club', ticketer: 'SeatGeek' }, // different venue
    { date: '2026-06-11', title: 'Band A', venue: 'Shank Hall', ticketer: 'SeatGeek' }, // different date
  ];
  const out = dedupe(shows);
  assert.equal(out.length, 3);
  assert.equal(out[0].offers.length, 2, 'the cross-source pair merges into one listing with both offers');
  assert.deepEqual(out[0].offers.map(o => o.src).sort(), ['SeatGeek', 'Ticketmaster']);
});

// --- images / entities / ics -----------------------------------------------

test('tmImage prefers a 16:9 image ≥500px wide, smallest first', () => {
  const url = tmImage({ images: [
    { ratio: '3_2', width: 305, url: 'small32' },
    { ratio: '16_9', width: 2048, url: 'huge169' },
    { ratio: '16_9', width: 640, url: 'right169' },
  ]});
  assert.equal(url, 'right169');
  assert.equal(tmImage({ images: [] }), undefined);
});

test('unentity decodes the HTML entities Squarespace feeds emit', () => {
  assert.equal(unentity('Wire &amp; Nail'), 'Wire & Nail');
  assert.equal(unentity('Josh Bryant &#039;Live&#039;'), "Josh Bryant 'Live'");
});

test('buildIcs produces a VEVENT per show with Central-time stamps', () => {
  const ics = buildIcs([{ date: '2026-09-20', time: '19:00', title: 'The Bouncing Souls, live', support: null, venue: 'The Argo', hood: 'Whitefish Bay', genre: 'punk', ticketer: 'Eventbrite', url: 'https://example.com/t' }]);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20260920T190000/);
  assert.match(ics, /SUMMARY:The Bouncing Souls\\, live @ The Argo/);
});

test('confluence.ics (if present) matches shows.json', () => {
  const p = path.join(__dirname, '..', 'confluence.ics');
  const sp = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p) || !fs.existsSync(sp)) return;
  const ics = fs.readFileSync(p, 'utf8');
  const shows = JSON.parse(fs.readFileSync(sp, 'utf8')).shows;
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, shows.length);
  assert.match(ics, /END:VCALENDAR/);
});

// --- data contract: the embedded seed + shows.json must be valid -----------

function validateShows(shows, label) {
  assert.ok(Array.isArray(shows) && shows.length > 0, `${label}: shows must be a non-empty array`);
  for (const s of shows) {
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, `${label}: bad date ${JSON.stringify(s.date)}`);
    assert.match(s.time, /^\d{2}:\d{2}$/, `${label}: bad time ${JSON.stringify(s.time)} for "${s.title}"`);
    assert.ok(s.title && typeof s.title === 'string', `${label}: missing title`);
    assert.ok(s.venue && typeof s.venue === 'string', `${label}: missing venue for "${s.title}"`);
    assert.ok(s.hood && typeof s.hood === 'string', `${label}: missing hood for "${s.title}"`);
    assert.ok(ALLOWED_GENRES.has(s.genre), `${label}: unknown genre "${s.genre}" for "${s.title}"`);
    assert.match(s.url, /^https?:\/\//, `${label}: bad url for "${s.title}"`);
  }
}

test('embedded seed data in the HTML is valid', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/<script id="embedded-shows"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'could not find embedded-shows block');
  const data = JSON.parse(m[1]);
  validateShows(data.shows, 'embedded seed');
});

test('shows.json (if present) is valid', () => {
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) { return; } // feed may not have run yet
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  validateShows(data.shows, 'shows.json');
});

// --- title-variant merging (multi-room venues must NOT collapse) ----------

test('similarity scores spelling variants high and different acts low', () => {
  assert.ok(similarity('jennifer lyn and the groove revival', 'jennifer lynn and the groove revival') > 0.9);
  assert.ok(similarity('rufus du sol', 'rufus du sol') === 1);
  assert.ok(similarity('eddie griffin', 'dl hughley') < 0.5);
  assert.ok(similarity('nonpoint', 'poke rave') < 0.5);
});

test('mergeTitleVariants folds spelling variants but keeps distinct shows', () => {
  const merged = mergeTitleVariants([
    { date: '2026-08-13', time: '19:00', title: 'Jennifer Lyn and the Groove Revival', venue: 'Peck Pavilion', offers: [{ src: 'Ticketmaster', url: 'a' }] },
    { date: '2026-08-13', time: '19:00', title: 'Jennifer Lynn and The Groove Revival', venue: 'Peck Pavilion', offers: [{ src: 'SeatGeek', url: 'b' }] },
  ]);
  assert.equal(merged.length, 1, 'spelling variants should merge');
  assert.equal(merged[0].offers.length, 2, 'and keep both places to buy');

  // The Rave runs several rooms at once — these are different shows
  const kept = mergeTitleVariants([
    { date: '2026-08-15', time: '19:30', title: 'Nonpoint', venue: 'The Rave / Eagles Club', offers: [{ src: 'Ticketmaster', url: 'a' }] },
    { date: '2026-08-15', time: '19:30', title: 'Poke-RAVE', venue: 'The Rave / Eagles Club', offers: [{ src: 'SeatGeek', url: 'b' }] },
  ]);
  assert.equal(kept.length, 2, 'different shows in the same building must stay separate');
});

// --- artist name cleanup for preview lookup --------------------------------

test('cleanArtist strips the noise that breaks music lookups', () => {
  assert.equal(cleanArtist('Live in the Lounge w/ Will Pfrang (Free)'), 'Live in the Lounge');
  assert.equal(cleanArtist('Milwaukee Metal Fest (Day 1)'), 'Milwaukee Metal Fest');
  assert.equal(cleanArtist('Dead Letter Office - A Tribute to R.E.M.'), 'Dead Letter Office');
  assert.equal(cleanArtist('Modest Mouse'), 'Modest Mouse');
  // tour branding hid real bands from Apple: no preview, no genre
  assert.equal(cleanArtist('Pinkshift: Saccharine 5 Year Anniversary Tour'), 'Pinkshift');
  assert.equal(cleanArtist("THE BOUNCING SOULS - 'Born To Be Tour'"), 'THE BOUNCING SOULS');
  assert.equal(cleanArtist('Zach Rushing: The Redneck Logic Tour'), 'Zach Rushing');
  // a colon that isn't tour branding is part of the name and must survive
  assert.equal(cleanArtist('Chad Gray: Voice of Mudvayne & Hellyeah'), 'Chad Gray: Voice of Mudvayne & Hellyeah');
});

// --- which ticket link wins ------------------------------------------------

test('a dead Ticketmaster link loses to any offer that actually works', () => {
  // TM's Discovery API lists shows it doesn't sell (The Rave, every Pabst
  // Theater Group room, Cactus Club) and returns a bare /event/<id> pointer
  // that errors when clicked. Real reports: Robby Hoffman, ILUKA.
  const shows = [{
    title: 'Robby Hoffman',
    offers: [
      { src: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/Z7r9jZ1A70E3p' },
      { src: 'SeatGeek', url: 'https://seatgeek.com/robby-hoffman-tickets/comedy/x/18400549' },
    ],
  }];
  pointAtBestOffer(shows);
  assert.equal(shows[0].ticketer, 'SeatGeek');
  assert.match(shows[0].url, /seatgeek/);
});

test('a real Ticketmaster link still outranks resale', () => {
  const shows = [
    { // full consumer URL — TM genuinely sells this one
      offers: [
        { src: 'SeatGeek', url: 'https://seatgeek.com/x/1' },
        { src: 'Ticketmaster', url: 'https://www.ticketmaster.com/ajr-milwaukee-08-15-2026/event/07006465DEA99891' },
      ],
    },
    { // TM's API reporting a TicketWeb box office — also the real seller
      offers: [
        { src: 'SeatGeek', url: 'https://seatgeek.com/x/2' },
        { src: 'Ticketmaster', url: 'https://www.ticketweb.com/event/healing-gems-cactus-club-tickets/14930273' },
      ],
    },
  ];
  pointAtBestOffer(shows);
  assert.equal(shows[0].ticketer, 'Ticketmaster');
  assert.equal(shows[1].ticketer, 'Ticketmaster');
  assert.match(shows[1].url, /ticketweb/);
});

test('a dead link is still better than no link at all', () => {
  // 26 shows have nothing else. Dropping the link would leave no way to buy.
  const shows = [{
    offers: [{ src: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/Z7r9jZ1A7Pgvw' }],
  }];
  pointAtBestOffer(shows);
  assert.equal(shows[0].url, 'https://www.ticketmaster.com/event/Z7r9jZ1A7Pgvw');
});

// --- genre refinement ------------------------------------------------------

test('itunesGenre tests specific styles before the general ones', () => {
  assert.equal(itunesGenre('Alternative'), 'indie');
  assert.equal(itunesGenre('Indie Rock'), 'indie');
  assert.equal(itunesGenre('Adult Alternative'), 'indie');
  // these two would both be "indie" if the general rule ran first
  assert.equal(itunesGenre('Alternative Country'), 'country');
  assert.equal(itunesGenre('Alternative Folk'), 'folk');
  assert.equal(itunesGenre('Hard Rock'), 'rock');
  assert.equal(itunesGenre('Hip-Hop/Rap'), 'hiphop');
  assert.equal(itunesGenre('Singer/Songwriter'), 'folk');
  assert.equal(itunesGenre('Urbano latino'), 'latin');
  // says nothing about which bucket a show belongs in
  assert.equal(itunesGenre('Christian'), null);
  assert.equal(itunesGenre(''), null);
  assert.equal(itunesGenre(undefined), null);
});

test('refineGenres fills "other" and sharpens rock, without flattening everything', () => {
  const cache = {
    'Hovvdy': { kind: 'Alternative' },
    'Foster the People': { kind: 'Alternative' },
    'Some Cover Band': { kind: 'Country' },
    'A Comedian': { kind: 'Comedy' },
  };
  const shows = [
    // the case Brian raised: unfiltered before, indie now
    { title: 'Hovvdy', genre: 'other' },
    // rock is Ticketmaster's parent bucket, so a narrower style refines it
    { title: 'Foster the People', genre: 'rock' },
    // country is a disagreement, not a refinement — the seller saw the billing
    { title: 'Some Cover Band', genre: 'rock' },
    // comedy comes from the ticket classification and is never overridden
    { title: 'A Comedian', genre: 'comedy' },
    // Apple files Beck under Pop; the override is a deliberate human call
    { title: 'Beck', genre: 'rock' },
    // Apple calls almost all punk "Alternative", so punk is hand-seeded —
    // and tour branding must be stripped before the override is looked up
    { title: "THE BOUNCING SOULS - 'Born To Be Tour' w/ The Suicide Machines", genre: 'other' },
    // nothing known, nothing invented
    { title: 'Some Local Band', genre: 'other' },
  ];
  refineGenres(shows, cache);
  assert.deepEqual(shows.map(s => s.genre),
    ['indie', 'indie', 'rock', 'comedy', 'indie', 'punk', 'other']);
});

test('refineGenres reads a genre out of a title only as a last resort', () => {
  const shows = [
    { title: 'Milwaukee Metal Fest', genre: 'other' },
    { title: 'K-Pop Rave', genre: 'other' },
    // not a genre — must stay filterable as "other", not guessed at
    { title: 'Golden Girls Drag Brunch', genre: 'other' },
    // already classified: the title must not second-guess the source
    { title: 'Jazz Night', genre: 'blues' },
  ];
  refineGenres(shows, {});
  assert.deepEqual(shows.map(s => s.genre), ['metal', 'pop', 'other', 'blues']);
});

// --- shareable per-show pages ----------------------------------------------

test('slugify makes a clean, readable, url-safe handle', () => {
  assert.equal(slugify('Big Head Todd and The Monsters'), 'big-head-todd-and-the-monsters');
  assert.equal(slugify('RÜFÜS DU SOL'), 'rufus-du-sol');
  assert.equal(slugify('Hall & Oates'), 'hall-and-oates');
  assert.equal(slugify('  D.L. Hughley!  '), 'd-l-hughley');
  assert.equal(slugify(''), 'show');
  // long titles get trimmed at a word, never mid-word or past the limit
  const long = slugify('Pink Talking Fish A Fusion of Pink Floyd Talking Heads and Phish');
  assert.ok(long.length <= 60);
  assert.ok(!long.endsWith('-'));
});

test('assignSlugs gives every show a unique address', () => {
  const shows = [
    { title: 'Nonpoint', date: '2026-08-15' },
    // same act, same night, two rooms — both need their own page
    { title: 'Nonpoint', date: '2026-08-15' },
    { title: 'Nonpoint', date: '2026-08-16' },
  ];
  assignSlugs(shows);
  assert.equal(shows[0].slug, 'nonpoint-2026-08-15');
  assert.equal(shows[1].slug, 'nonpoint-2026-08-15-2');
  assert.equal(shows[2].slug, 'nonpoint-2026-08-16');
  assert.equal(new Set(shows.map(s => s.slug)).size, 3);
});

test('a show page carries its own preview tags and a direct ticket link', () => {
  const show = {
    title: 'Modest Mouse', support: 'Mattress', date: '2026-10-18', time: '20:00',
    venue: 'The Rave / Eagles Club', hood: 'Westown', genre: 'indie',
    slug: 'modest-mouse-2026-10-18', img: 'https://img.example/pic.jpg',
    ticketer: 'Ticketmaster', url: 'https://tm.example/e/1',
    offers: [{ src: 'Ticketmaster', url: 'https://tm.example/e/1' }],
  };
  const html = showPageHtml(show);
  assert.match(html, /<meta property="og:title" content="Modest Mouse · The Rave \/ Eagles Club" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/img\.example\/pic\.jpg" \/>/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /og:url" content="https:\/\/theconfluencemke\.com\/show\/modest-mouse-2026-10-18\.html"/);
  assert.match(html, /Sunday, October 18, 2026 · 8:00 PM/);
  // the whole point: one click from a shared link to the ticket page
  assert.match(html, /<a class="buy" href="https:\/\/tm\.example\/e\/1"/);
  assert.match(html, /"@type":"MusicEvent"/);
});

test('a show page saves under the same id the calendar reads', () => {
  const html = showPageHtml({
    title: 'Modest Mouse', date: '2026-10-18', time: '20:00', venue: 'Turner Hall',
    hood: 'Westown', slug: 'modest-mouse-2026-10-18',
    offers: [{ src: 'Ticketmaster', url: 'https://tm.example/e/1' }],
  });
  // index.html: showId = `${s.date}|${s.time}|${s.title}` against 'confluence-mylist'.
  // If either side drifts, a show saved from its own page vanishes from My List.
  assert.match(html, /var ID = "2026-10-18\|20:00\|Modest Mouse"/);
  assert.match(html, /var KEY = 'confluence-mylist'/);
  assert.match(html, /id="save"/);
});

test('a show page reflects a cancellation instead of selling tickets', () => {
  const html = showPageHtml({
    title: 'Marshall Charloff', date: '2026-10-22', time: '19:30', venue: 'Pabst Theater',
    hood: 'Westown', slug: 'x-2026-10-22', status: 'cancelled',
    offers: [{ src: 'Ticketmaster', url: 'https://tm.example/e/2' }],
  });
  assert.doesNotMatch(html, /class="buy"/);
  assert.match(html, /Cancelled/);
  assert.match(html, /EventCancelled/);
});

test('a show page escapes titles that would otherwise break the markup', () => {
  const html = showPageHtml({
    title: 'AC/DC "Live" & <loud>', date: '2026-10-18', time: '20:00', venue: 'Fiserv Forum',
    hood: 'Westown', slug: 'x-2026-10-18', offers: [{ src: 'Ticketmaster', url: 'https://tm.example/e/3' }],
  });
  assert.doesNotMatch(html, /<loud>/);
  assert.match(html, /&quot;Live&quot; &amp; &lt;loud&gt;/);
  // the quote must not close the og:title attribute early
  assert.match(html, /og:title" content="AC\/DC &quot;Live&quot; &amp; &lt;loud&gt; · Fiserv Forum"/);
});

test('every show in shows.json has a unique slug and a page on disk', () => {
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) return;
  const shows = JSON.parse(fs.readFileSync(p, 'utf8')).shows;
  const slugs = shows.map(s => s.slug);
  assert.ok(slugs.every(Boolean), 'every show needs a slug for its share link');
  assert.equal(new Set(slugs).size, slugs.length, 'slugs must be unique');
  for (const s of slugs) assert.match(s, /^[a-z0-9-]+$/, `slug not url-safe: ${s}`);
  const dir = path.join(__dirname, '..', 'show');
  if (!fs.existsSync(dir)) return;
  for (const s of shows) {
    assert.ok(fs.existsSync(path.join(dir, `${s.slug}.html`)), `missing share page for ${s.title}`);
  }
});

test('shows.json previews (if present) carry a playable url', () => {
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) return;
  for (const s of JSON.parse(fs.readFileSync(p, 'utf8')).shows) {
    if (!s.preview) continue;
    assert.match(s.preview.url, /^https?:\/\//, `bad preview url for ${s.title}`);
    assert.ok(s.preview.artist, `preview missing artist for ${s.title}`);
  }
});
