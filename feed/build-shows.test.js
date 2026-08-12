'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ymd, hm, hoodFor, genreFor, geohash, dedupe, keepEvent, tmEventToShow, GENRE_MAP } = require('./build-shows.js');

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

test('dedupe collapses same date+title+venue, keeping the first', () => {
  const shows = [
    { date: '2026-06-10', title: 'Band A', venue: 'Shank Hall', ticketer: 'Ticketmaster' },
    { date: '2026-06-10', title: 'band a', venue: 'shank hall', ticketer: 'SeatGeek' }, // dup (case-insensitive)
    { date: '2026-06-10', title: 'Band A', venue: 'Cactus Club', ticketer: 'SeatGeek' }, // different venue
    { date: '2026-06-11', title: 'Band A', venue: 'Shank Hall', ticketer: 'SeatGeek' }, // different date
  ];
  const out = dedupe(shows);
  assert.equal(out.length, 3);
  assert.equal(out[0].ticketer, 'Ticketmaster'); // first one wins
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
