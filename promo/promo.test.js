'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../feed/lib');
const L = require('./lineup');
const S = require('./state');
const { dueKind } = require('./social');
const { subjectFor, emailHtml } = require('./newsletter');
const { fitRows } = require('./templates');

const show = (title, venue, time, extra = {}) => ({
  title, venue, time, date: '2026-09-25', ...extra,
  offers: [{ src: 'SeatGeek', url: `https://seatgeek.com/${encodeURIComponent(title)}` }],
});
const tonight = [
  show('They Might Be Giants', 'Pabst Theater', '20:00', { slug: 'tmbg-2026-09-25' }),
  show('The Thorn', 'Miller High Life Theatre', '19:00', { slug: 'thorn-2026-09-25' }),
  show('Fellow Travelers', 'Cactus Club', '18:30', { slug: 'ft-2026-09-25' }),
  show('Cancelled Band', 'Shank Hall', '20:00', { status: 'cancelled', slug: 'x-2026-09-25' }),
];

// --- when to post -------------------------------------------------------------------

test('the tonight post fires anywhere in the afternoon, in Milwaukee time', () => {
  // GitHub's cron ran a median ~4h late in this repo, so the window is wide
  // and judged in local time whatever the runner's clock says.
  const at = iso => dueKind(lib.chicagoNow(new Date(iso)), 'auto');
  assert.equal(at('2026-07-15T15:59:00Z'), null, '10:59 AM CDT — too early');
  assert.equal(at('2026-07-15T16:00:00Z'), 'tonight', '11 AM CDT');
  assert.equal(at('2026-07-16T00:30:00Z'), 'tonight', '7:30 PM CDT, last call');
  assert.equal(at('2026-07-16T00:31:00Z'), null, '7:31 PM — too late to be useful');
  // winter: the same UTC instant is an hour earlier in Milwaukee
  assert.equal(at('2026-12-15T16:59:00Z'), null, '10:59 AM CST');
  assert.equal(at('2026-12-15T17:00:00Z'), 'tonight', '11 AM CST');
});

test('on Fridays the weekend post goes first, then tonight', () => {
  const now = lib.chicagoNow(new Date('2026-09-25T17:00:00Z'));    // Fri noon CDT
  assert.equal(dueKind(now, 'auto'), 'weekend');
  // once the weekend post is out, the next run moves on to tonight's
  assert.equal(dueKind(now, 'auto', k => k === 'weekend'), 'tonight');
  // and when both are done, nothing
  assert.equal(dueKind(now, 'auto', () => true), null);
  // no weekend post on a Thursday
  assert.equal(dueKind(lib.chicagoNow(new Date('2026-09-24T17:00:00Z')), 'auto'), 'tonight');
});

// --- what to post ---------------------------------------------------------------------

test('tonight excludes cancelled shows and puts the biggest rooms first', () => {
  const list = L.showsOn(tonight, '2026-09-25');
  assert.deepEqual(list.map(s => s.title), ['The Thorn', 'They Might Be Giants', 'Fellow Travelers']);
});

test('cards pick the biggest shows but list them in time order', () => {
  const list = L.showsOn(tonight, '2026-09-25');
  const { shown, extra } = fitRows(list, 2);
  assert.equal(extra, 2);
  assert.deepEqual(shown.map(s => s.title), ['The Thorn'], 'max 2 → one row plus "+2 more"');
  const all = fitRows(list, 8).shown.map(s => s.time);
  assert.deepEqual(all, [...all].sort(), 'displayed chronologically');
});

test('fridayFrom finds the coming Friday', () => {
  assert.equal(L.fridayFrom('2026-09-24'), '2026-09-25');   // Thursday → next day
  assert.equal(L.fridayFrom('2026-09-25'), '2026-09-25');   // Friday → itself
  assert.equal(L.fridayFrom('2026-09-27'), '2026-10-02');   // Sunday → next week
});

// --- Bluesky ----------------------------------------------------------------------------

test('Bluesky posts fit 300 graphemes and say how many were left off', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    show(`A Band With A Fairly Long Name ${i}`, 'The Rave / Eagles Club', '20:00'));
  const post = L.blueskyTonight('2026-09-25', many);
  assert.ok(L.graphemes(post.text) <= L.BSKY_LIMIT, `${L.graphemes(post.text)} graphemes`);
  assert.match(post.text, /\+ \d+ more → theconfluencemke\.com$/);
});

test('Bluesky link facets use UTF-8 byte offsets, even after accented names', () => {
  // Bluesky indexes links by byte, not character. "RÜFÜS DU SOL" is where a
  // character count would put the link in the wrong place.
  const post = L.blueskyTonight('2026-09-25', [show('RÜFÜS DU SOL', 'Fiserv Forum', '20:00'), show('Sigur Rós', 'Riverside Theater', '20:00')]);
  const { byteStart, byteEnd } = post.facets[0].index;
  const linked = Buffer.from(post.text, 'utf8').slice(byteStart, byteEnd).toString('utf8');
  assert.equal(linked, 'theconfluencemke.com');
  assert.equal(post.facets[0].features[0].uri, 'https://theconfluencemke.com/day/2026-09-25.html');
});

test('the Bluesky weekend post fits too', () => {
  const days = ['2026-09-25', '2026-09-26', '2026-09-27'].map(date => ({
    date, shows: Array.from({ length: 20 }, (_, i) => ({ ...show(`Headliner Number ${i}`, 'Pabst Theater', '20:00'), date })),
  }));
  const post = L.blueskyWeekend(days);
  assert.ok(L.graphemes(post.text) <= L.BSKY_LIMIT);
  assert.match(post.text, /60 shows in all/);
});

// --- Instagram ------------------------------------------------------------------------------

test('Instagram captions have no dead URLs, carry hashtags, and fit 2,200 chars', () => {
  const fb = L.facebookTonight('2026-09-25', L.showsOn(tonight, '2026-09-25'));
  const ig = L.instagramCaption(fb);
  assert.doesNotMatch(ig, /https?:\/\//, 'links are not clickable in captions');
  assert.match(ig, /link in bio/);
  assert.match(ig, /#Milwaukee/);
  const huge = L.instagramCaption('x\n'.repeat(3000));
  assert.ok(huge.length <= 2200);
});

// --- idempotency ---------------------------------------------------------------------------------

test('state is recorded per platform, so a rerun only retries what failed', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promo-')), 'state.json');
  const st = S.loadState(file);
  S.markPosted(st, '2026-09-25/tonight', 'bluesky', 'at://x');
  S.saveState(st, file, '2026-09-25');
  const again = S.loadState(file);
  assert.equal(S.posted(again, '2026-09-25/tonight', 'bluesky'), true);
  assert.equal(S.posted(again, '2026-09-25/tonight', 'instagram'), false, 'Instagram still pending');
});

test('old state is pruned after two months', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promo-')), 'state.json');
  const st = { social: { '2026-01-01/tonight': { bluesky: {} }, '2026-09-20/tonight': { bluesky: {} } }, newsletter: {} };
  S.saveState(st, file, '2026-09-25');
  assert.deepEqual(Object.keys(S.loadState(file).social), ['2026-09-20/tonight']);
});

// --- newsletter ---------------------------------------------------------------------------------

test('the weekend email lists every show with a monetizable ticket link', () => {
  const days = [
    { date: '2026-09-25', shows: L.showsOn(tonight, '2026-09-25') },
    { date: '2026-09-26', shows: [{ ...show('Luke Bryan', 'Alpine Valley Music Theatre', '19:00'), date: '2026-09-26', slug: 'lb-2026-09-26' }] },
  ];
  const html = emailHtml(days);
  for (const d of days) for (const s of d.shows) assert.ok(html.includes(s.title), `missing ${s.title}`);
  assert.doesNotMatch(html, /Cancelled Band/, 'cancelled shows were already filtered out');
  assert.match(html, /href="https:\/\/theconfluencemke\.com\/show\/tmbg-2026-09-25\.html"/);
  assert.match(html, /<!-- buttondown-editor-mode: fancy -->/);
  assert.ok(Buffer.byteLength(html) < 100 * 1024, 'Gmail clips emails over ~102 KB');

  const subject = subjectFor(days);
  assert.match(subject, /^This weekend in MKE: The Thorn, Luke Bryan \+ \d+ more$/);
});
