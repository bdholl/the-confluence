#!/usr/bin/env node
/*
 * "Tonight in Milwaukee" (daily ~3 PM) and "This weekend" (Fridays ~noon),
 * posted to Bluesky, a Facebook Page and Instagram.
 *
 *   node promo/social.js                      dry run: whatever is due right now
 *   node promo/social.js --mode=tonight       dry run: tonight's post, regardless of the clock
 *   node promo/social.js --mode=weekend --date=2026-10-02
 *   node promo/social.js --mode=tonight --live   actually post (the workflow does this)
 *
 * DRY RUN IS THE DEFAULT. Nothing is published without --live. A dry run
 * prints every platform's text and writes the card to promo/out/ to look at.
 *
 * In GitHub Actions it runs in two steps so the card can be deployed to the
 * site in between (Instagram fetches images by URL): --step=prepare, then the
 * workflow commits the card, then --step=publish.
 */

const fs = require('fs');
const path = require('path');
const { SITE, chicagoNow, addDays } = require('../feed/lib');
const config = require('./config');
const L = require('./lineup');
const T = require('./templates');
const { screenshot, toJpeg } = require('./render');
const P = require('./platforms');
const S = require('./state');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
const POST_FILE = path.join(OUT_DIR, 'post.json');
const CARD_DIR = path.join(ROOT, 'social');
const CARD_KEEP_DAYS = 14;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const LIVE = !!args.live;

// ---------- which platforms are set up ----------
const PLATFORMS = {
  bluesky: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'],
  facebook: ['META_PAGE_ID', 'META_PAGE_TOKEN'],
  instagram: ['INSTAGRAM_USER_ID', 'META_PAGE_TOKEN'],
};
const configured = p => PLATFORMS[p].every(k => !!process.env[k]);

// ---------- is anything due? ----------
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function inWindow(w, now) {
  return w.days.includes(now.weekday) && now.minutes >= toMin(w.from) && now.minutes <= toMin(w.to);
}
// On a Friday both windows can be open at once. The weekend post goes first;
// once it's done, the next run moves on to tonight's — so `isDone` matters.
function dueKind(now, mode, isDone = () => false) {
  if (mode === 'tonight' || mode === 'weekend') return mode;
  return ['weekend', 'tonight'].find(k => inWindow(config.windows[k], now) && !isDone(k)) || null;
}

function log(s = '') { console.log(s); }
const clock = now => `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`;

// ---------- prepare: decide, compose, render ----------
async function prepare() {
  const now = chicagoNow();
  const date = args.date || now.date;
  const state = S.loadState();
  const set = Object.keys(PLATFORMS).filter(configured);
  // "done" = posted everywhere that's set up. Only meaningful live — a dry run
  // records nothing, so it always has something to show.
  const isDone = k => LIVE && set.length > 0 && set.every(p => S.posted(state, `${date}/${k}`, p));
  const kind = dueKind(now, args.mode, isDone);
  if (!kind) {
    log(`Nothing due — it's ${clock(now)} in Milwaukee, and everything in an open window is already posted.`);
    S.setOutput('due', 'false');
    return null;
  }
  const shows = L.loadShows();

  let texts, html, alt;
  if (kind === 'tonight') {
    const list = L.showsOn(shows, date);
    if (!list.length) {
      log(`No shows on ${date} — not posting. (By design: no "nothing tonight" posts.)`);
      S.setOutput('due', 'false');
      return null;
    }
    const fb = L.facebookTonight(date, list);
    texts = { bluesky: L.blueskyTonight(date, list), facebook: fb, instagram: L.instagramCaption(fb) };
    html = T.tonightCardHtml(date, list);
    alt = L.altText('tonight', date, list);
  } else {
    const days = L.weekendDays(shows, L.fridayFrom(date));
    if (!days.length) {
      log('Nothing on the calendar this weekend — not posting.');
      S.setOutput('due', 'false');
      return null;
    }
    const fb = L.facebookWeekend(days);
    texts = { bluesky: L.blueskyWeekend(days), facebook: fb, instagram: L.instagramCaption(fb) };
    html = T.weekendCardHtml(days);
    alt = L.altText('weekend', days);
  }

  const key = `${date}/${kind}`;
  if (isDone(kind)) {                       // an explicit --mode that's already done
    log(`Already posted ${key} to every platform — nothing to do.`);
    S.setOutput('due', 'false');
    return null;
  }

  // Live cards go in /social so the site serves them (Instagram needs a URL);
  // dry-run cards stay in promo/out, which is gitignored.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = `${date}-${kind}.jpg`;
  const jpgPath = LIVE ? path.join(CARD_DIR, name) : path.join(OUT_DIR, name);
  fs.mkdirSync(path.dirname(jpgPath), { recursive: true });
  const png = path.join(OUT_DIR, `${date}-${kind}.png`);
  screenshot(html, { width: T.CARD_W, height: T.CARD_H, out: png });
  toJpeg(png, jpgPath, 88);

  const post = {
    kind, date, key, texts,
    image: { path: path.relative(ROOT, jpgPath), url: `${SITE}/social/${name}`, alt, width: T.CARD_W, height: T.CARD_H },
  };
  fs.writeFileSync(POST_FILE, JSON.stringify(post, null, 2));
  if (LIVE) pruneCards(date);

  preview(post, png);
  S.setOutput('due', 'true');
  S.setOutput('card', post.image.path);
  return post;
}

function pruneCards(today) {
  if (!fs.existsSync(CARD_DIR)) return;
  const cutoff = addDays(today, -CARD_KEEP_DAYS);
  for (const f of fs.readdirSync(CARD_DIR)) {
    if (f.slice(0, 10) < cutoff) fs.unlinkSync(path.join(CARD_DIR, f));
  }
}

function preview(post, png) {
  const b = post.texts.bluesky;
  const lines = [
    `=== ${post.kind.toUpperCase()} · ${post.date} · ${LIVE ? 'LIVE' : 'DRY RUN'} ===`,
    '',
    `--- Bluesky (${L.graphemes(b.text)}/${L.BSKY_LIMIT}) ---`, b.text,
    '', '--- Facebook ---', post.texts.facebook,
    '', '--- Instagram ---', post.texts.instagram,
    '', `Card: ${post.image.path}  (preview PNG: ${path.relative(ROOT, png)})`,
    `Alt text: ${post.image.alt}`,
  ];
  log(lines.join('\n'));
  S.summary([
    `## ${post.kind === 'tonight' ? 'Tonight' : 'This weekend'} — ${post.date} ${LIVE ? '(live)' : '(dry run — nothing posted)'}`,
    '', `**Bluesky** (${L.graphemes(b.text)}/${L.BSKY_LIMIT})`, '```', b.text, '```',
    '**Facebook**', '```', post.texts.facebook, '```',
    '**Instagram**', '```', post.texts.instagram, '```',
    'The card is attached to this run as an artifact.',
  ].join('\n'));
}

// ---------- publish: post to every platform that's set up ----------
const POSTERS = {
  bluesky: (post, image) => P.postBluesky(
    { handle: process.env.BLUESKY_HANDLE, appPassword: process.env.BLUESKY_APP_PASSWORD }, post.texts.bluesky, image),
  facebook: (post, image) => P.postFacebook(
    { pageId: process.env.META_PAGE_ID, pageToken: process.env.META_PAGE_TOKEN }, post.texts.facebook, image),
  instagram: (post, image) => P.postInstagram(
    { igUserId: process.env.INSTAGRAM_USER_ID, pageToken: process.env.META_PAGE_TOKEN }, post.texts.instagram, image),
};

async function publish(prepared) {
  const post = prepared || JSON.parse(fs.readFileSync(POST_FILE, 'utf8'));
  const image = { ...post.image, jpeg: fs.readFileSync(path.join(ROOT, post.image.path)) };
  const state = S.loadState();
  const failures = [];
  let set = 0;

  for (const p of Object.keys(PLATFORMS)) {
    if (!configured(p)) { log(`– ${p}: not set up (no secrets) — skipped`); continue; }
    set++;
    if (S.posted(state, post.key, p)) { log(`– ${p}: already posted ${post.key}`); continue; }
    if (!LIVE) { log(`– ${p}: [dry run] would post`); continue; }
    try {
      const id = await POSTERS[p](post, image);
      S.markPosted(state, post.key, p, id);
      S.saveState(state, undefined, post.date);          // record each success immediately
      log(`✓ ${p}: posted (${id})`);
    } catch (e) {
      failures.push(`${p}: ${e.message}`);
      log(`✗ ${p}: ${e.message}`);
    }
  }

  if (LIVE && !set) failures.push('SOCIAL_LIVE is on, but no platform has its secrets set. See PROMOTION.md.');
  if (failures.length) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'failures.txt'), failures.join('\n'));
    S.summary(`### Failed\n${failures.map(f => `- ${f}`).join('\n')}`);
    throw new Error(`${failures.length} platform(s) failed:\n${failures.join('\n')}`);
  }
}

async function main() {
  const step = args.step || 'all';
  if (step === 'prepare') return void await prepare();
  if (step === 'publish') return void await publish();
  const post = await prepare();
  if (post) await publish(post);
}

if (require.main === module) {
  main().catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
}

module.exports = { dueKind, inWindow };
