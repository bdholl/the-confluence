// What to post, and how it reads on each platform. Pure functions, no network,
// so every rule here is covered by promo/promo.test.js.

const fs = require('fs');
const path = require('path');
const { SITE, byBilling, fmtShort, addDays, dayHeading, shortDate } = require('../feed/lib');
const { byTime } = require('./templates');
const config = require('./config');

const SHOWS_FILE = path.join(__dirname, '..', 'shows.json');

function loadShows(file = SHOWS_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).shows || [];
}

// A cancelled show isn't part of tonight. Everything else is, biggest rooms
// first — the same billing order as the calendar.
function showsOn(shows, date) {
  return shows.filter(s => s.date === date && s.status !== 'cancelled').sort(byBilling);
}

// The Friday on or after `date`.
function fridayFrom(date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  return addDays(date, (5 - dow + 7) % 7);
}

function weekendDays(shows, friday) {
  return [0, 1, 2].map(i => addDays(friday, i))
    .map(date => ({ date, shows: showsOn(shows, date) }))
    .filter(d => d.shows.length);
}

// Stable per date, so a rerun says the same thing.
function pickIntro(kind, date) {
  const list = config.intros[kind];
  const n = Math.round(Date.parse(date + 'T12:00:00Z') / 864e5);
  return list[((n % list.length) + list.length) % list.length];
}

const graphemes = s => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;
const when = s => (s.tbd ? 'time TBA' : fmtShort(s.time));
const line = s => `${s.title} — ${s.venue}, ${when(s)}`;

const tonightUrl = date => `${SITE}/day/${date}.html`;
const DISPLAY_URL = 'theconfluencemke.com';

// Bluesky: 300 graphemes, and a URL is only clickable if we say where it sits
// in the text by UTF-8 byte offset (a "facet"). Fit as many of the biggest
// shows as the limit allows, then say how many were left off.
const BSKY_LIMIT = 300;

function withLinkFacet(text, linkText, uri) {
  const at = text.lastIndexOf(linkText);
  const byteStart = Buffer.byteLength(text.slice(0, at), 'utf8');
  return {
    text,
    facets: [{
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(linkText, 'utf8') },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    }],
  };
}

function blueskyTonight(date, shows) {
  const intro = pickIntro('tonight', date);
  for (let k = shows.length; k >= 1; k--) {
    const listed = shows.slice(0, k).sort(byTime);
    const rest = shows.length - k;
    const tail = rest ? `+ ${rest} more → ${DISPLAY_URL}` : DISPLAY_URL;
    const text = `${intro}\n\n${listed.map(line).join('\n')}\n\n${tail}`;
    if (graphemes(text) <= BSKY_LIMIT) return withLinkFacet(text, DISPLAY_URL, tonightUrl(date));
  }
  // one show whose name alone blows the budget — say so without it
  return withLinkFacet(`${intro}\n\n${shows.length} shows tonight → ${DISPLAY_URL}`, DISPLAY_URL, tonightUrl(date));
}

function blueskyWeekend(days) {
  const intro = pickIntro('weekend', days[0].date);
  const total = days.reduce((n, d) => n + d.shows.length, 0);
  for (let per = 3; per >= 1; per--) {
    const body = days.map(d => `${shortDate(d.date).slice(0, 3)} — ${d.shows.slice(0, per).map(s => s.title).join(', ')}`).join('\n');
    const text = `${intro}\n\n${body}\n\n${total} shows in all → ${DISPLAY_URL}`;
    if (graphemes(text) <= BSKY_LIMIT) return withLinkFacet(text, DISPLAY_URL, SITE + '/');
  }
  return withLinkFacet(`${intro}\n\n${total} shows this weekend → ${DISPLAY_URL}`, DISPLAY_URL, SITE + '/');
}

// Facebook: no practical length limit, and it links URLs on its own.
function facebookTonight(date, shows) {
  const cap = 25;
  const listed = shows.slice(0, cap).sort(byTime);
  const rest = shows.length - listed.length;
  return `${pickIntro('tonight', date)}\n\n${listed.map(line).join('\n')}${rest ? `\n+ ${rest} more` : ''}\n\nEvery show, every night: ${tonightUrl(date)}`;
}

function facebookWeekend(days) {
  const blocks = days.map(d => {
    const listed = d.shows.slice(0, 8).sort(byTime);
    const rest = d.shows.length - listed.length;
    return `${dayHeading(d.date).toUpperCase()}\n${listed.map(line).join('\n')}${rest ? `\n+ ${rest} more` : ''}`;
  });
  return `${pickIntro('weekend', days[0].date)}\n\n${blocks.join('\n\n')}\n\nThe whole weekend: ${SITE}/`;
}

// Instagram: 2,200 characters, links in captions aren't clickable, hashtags
// are how people find you.
function instagramCaption(fbText) {
  const noUrls = fbText.replace(/https?:\/\/\S+/g, `${DISPLAY_URL} (link in bio)`);
  const caption = `${noUrls}\n\n${config.hashtags}`;
  return caption.length <= 2200 ? caption : caption.slice(0, 2150).replace(/\n[^\n]*$/, '') + `\n…\n\n${config.hashtags}`;
}

// Alt text for the card image — screen readers get the lineup, not "image".
function altText(kind, dateOrDays, shows) {
  if (kind === 'tonight') {
    return `Tonight in Milwaukee, ${dayHeading(dateOrDays)}: ${shows.slice(0, 8).map(s => `${s.title} at ${s.venue}`).join('; ')}.`;
  }
  return `This weekend in Milwaukee: ${dateOrDays.map(d => `${dayHeading(d.date)} — ${d.shows.slice(0, 3).map(s => s.title).join(', ')}`).join('; ')}.`;
}

module.exports = {
  loadShows, showsOn, fridayFrom, weekendDays, pickIntro, graphemes,
  blueskyTonight, blueskyWeekend, facebookTonight, facebookWeekend, instagramCaption, altText,
  BSKY_LIMIT, tonightUrl,
};
