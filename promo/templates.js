// The image cards: the site's default share image, and the daily/weekend
// lineups the social bot posts. Same palette, same three typefaces, same
// die-cut stickers as the site, so a post in someone's feed reads as ours.

const { escH, fmtShort, dayHeading, MONTHS } = require('../feed/lib');

const dayOf = date => new Date(date + 'T12:00:00');

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;600;700&display=block" rel="stylesheet">';

const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0}
:root{--paper:#fdfcf8;--cream:#f4efe2;--ink:#111;--gray:#6f6f6f;--faint:#9a9a9a;--line:#ddd8cb;--blue:#0168FB}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:'IBM Plex Sans',sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;position:relative}
.serif{font-family:'Instrument Serif',Georgia,serif;font-weight:400}
.sticker{position:absolute;filter:drop-shadow(0 4px 10px rgba(17,17,17,.22))}
.sticker svg{display:block;width:100%;height:100%}`;

// the site's sticker shapes, drawn in a -55..55 box; white outline outside the fill
const SHAPES = {
  starburst: '<polygon points="0,-50 7.25,-27.05 25,-43.3 19.8,-19.8 43.3,-25 27.05,-7.25 50,0 27.05,7.25 43.3,25 19.8,19.8 25,43.3 7.25,27.05 0,50 -7.25,27.05 -25,43.3 -19.8,19.8 -43.3,25 -27.05,7.25 -50,0 -27.05,-7.25 -43.3,-25 -19.8,-19.8 -25,-43.3 -7.25,-27.05" />',
  sparkle: '<path d="M0,-50 C6,-16 16,-6 50,0 C16,6 6,16 0,50 C-6,16 -16,6 -50,0 C-16,-6 -6,-16 0,-50 Z" />',
  bolt: '<path d="M14,-50 L-26,6 L-2,6 L-12,50 L28,-8 L4,-8 Z" />',
  blob: '<path d="M14,-46 C40,-52 54,-28 50,-6 C46,16 56,34 34,46 C12,58 -14,50 -32,38 C-50,26 -54,2 -46,-18 C-38,-38 -12,-40 14,-46 Z" />',
};
const sticker = (shape, color, style, rotate = 0) =>
  `<div class="sticker" style="${style}"><svg viewBox="-55 -55 110 110" style="transform:rotate(${rotate}deg)"><g fill="${color}" stroke="#fff" stroke-width="8" paint-order="stroke" stroke-linejoin="round">${SHAPES[shape]}</g></svg></div>`;

const doc = (w, h, css, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>${BASE_CSS}
html,body{width:${w}px;height:${h}px}
${css}</style></head><body>${body}</body></html>`;

// ---------- 1200×630 default share card ----------
function ogCardHtml() {
  return doc(1200, 630, `
body{background:var(--cream);padding:78px 84px}
.mark{font-size:148px;line-height:.95;color:var(--blue);letter-spacing:-.01em}
.line{margin-top:34px;font-size:40px;font-weight:700;line-height:1.2;max-width:760px}
.sub{margin-top:14px;font-size:28px;color:var(--gray)}
.url{position:absolute;left:84px;bottom:66px;font-size:28px;font-weight:600;color:var(--blue)}
.rule{position:absolute;left:0;right:0;bottom:0;height:14px;background:var(--blue)}`, `
<div class="mark serif">The Confluence</div>
<div class="line">Every live music show in Milwaukee.</div>
<div class="sub">One page. Updated every morning.</div>
<div class="url">theconfluencemke.com</div>
<div class="rule"></div>
${sticker('starburst', '#0168FB', 'right:92px;top:70px;width:190px;height:190px', 8)}
${sticker('bolt', '#5ad427', 'right:250px;top:300px;width:92px;height:92px', -10)}
${sticker('sparkle', '#ff3b8e', 'right:110px;top:330px;width:120px;height:120px', 0)}`);
}

// ---------- 1080×1350 lineup card (Instagram's 4:5 portrait) ----------
const CARD_W = 1080, CARD_H = 1350;

const LINEUP_CSS = `
body{background:var(--cream);padding:70px 76px 0}
.top{display:flex;align-items:baseline;justify-content:space-between}
.mark{font-size:52px;color:var(--blue);line-height:1}
.tag{display:inline-block;margin-top:34px;background:var(--blue);color:var(--paper);font-size:19px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;padding:9px 16px 8px}
h1{font-size:92px;line-height:1;margin:22px 0 30px;letter-spacing:-.01em}
.rows{border-top:3px solid var(--ink)}
.row{display:grid;grid-template-columns:128px 1fr;gap:22px;align-items:baseline;padding:17px 0 16px;border-bottom:1px solid var(--line)}
.t{font-size:25px;color:var(--gray);font-variant-numeric:tabular-nums;white-space:nowrap}
.a{font-family:'Space Grotesk',sans-serif;font-size:38px;font-weight:500;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v{font-size:23px;color:var(--gray);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.more{margin-top:22px;font-size:27px;font-weight:600;color:var(--blue)}
.foot{position:absolute;left:76px;right:76px;bottom:58px;display:flex;justify-content:space-between;align-items:baseline;font-size:27px}
.foot b{font-weight:700}
.foot .url{color:var(--blue);font-weight:600}`;

const row = s => `<div class="row"><div class="t">${escH(s.tbd ? 'TBA' : fmtShort(s.time))}</div><div><div class="a">${escH(s.title)}</div><div class="v">${escH(s.venue)}</div></div></div>`;

// Fit what fits; say how many didn't. Eight rows is what the card holds at a
// size you can read on a phone.
//
// `shows` arrives sorted by billing (biggest rooms first), which decides WHICH
// shows make the card. They're then shown in time order — a time column that
// runs 9 PM → 6:30 PM reads as a mistake.
const byTime = (a, b) => (a.tbd ? '99' : a.time).localeCompare(b.tbd ? '99' : b.time);
function fitRows(shows, max) {
  if (shows.length <= max) return { shown: [...shows].sort(byTime), extra: 0 };
  return { shown: shows.slice(0, max - 1).sort(byTime), extra: shows.length - (max - 1) };
}

function tonightCardHtml(date, shows) {
  const { shown, extra } = fitRows(shows, 8);
  return doc(CARD_W, CARD_H, LINEUP_CSS, `
<div class="top"><div class="mark serif">The Confluence</div></div>
<div class="tag">Tonight in Milwaukee</div>
<h1 class="serif">${escH(dayHeading(date))}</h1>
<div class="rows">${shown.map(row).join('')}</div>
${extra ? `<div class="more">+ ${extra} more tonight</div>` : ''}
<div class="foot"><b>Every show. Every night.</b><span class="url">theconfluencemke.com</span></div>
${sticker('sparkle', '#ff3b8e', 'right:66px;top:52px;width:110px;height:110px')}`);
}

// Fri/Sat/Sun, the biggest few from each — the weekend post is a teaser for
// the full list on the site, not the list itself.
function weekendCardHtml(days) {
  const first = dayOf(days[0].date), last = dayOf(days[days.length - 1].date);
  const span = first.getMonth() === last.getMonth()
    ? `${MONTHS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${MONTHS[first.getMonth()].slice(0, 3)} ${first.getDate()} – ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getDate()}`;
  const total = days.reduce((n, d) => n + d.shows.length, 0);
  const section = d => {
    const { shown, extra } = fitRows(d.shows, 3);
    return `<div class="day"><div class="dh">${escH(dayHeading(d.date).split(',')[0])}<span>${d.shows.length} shows</span></div>
<div class="rows">${shown.map(row).join('')}</div>${extra ? `<div class="dm">+ ${extra} more</div>` : ''}</div>`;
  };
  return doc(CARD_W, CARD_H, LINEUP_CSS + `
h1{font-size:88px;margin-bottom:20px}
.day{margin-top:14px}
.dh{display:flex;justify-content:space-between;align-items:baseline;font-size:22px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);margin-bottom:8px}
.dh span{font-size:20px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--gray)}
.rows{border-top:2px solid var(--ink)}
.row{padding:10px 0 9px}
.a{font-size:31px}.v{font-size:20px}.t{font-size:22px}
.dm{margin-top:8px;font-size:21px;font-weight:600;color:var(--blue)}`, `
<div class="top"><div class="mark serif">The Confluence</div></div>
<div class="tag">This weekend in Milwaukee</div>
<h1 class="serif">${escH(span)}</h1>
${days.map(section).join('')}
<div class="foot"><b>${total} shows. One page.</b><span class="url">theconfluencemke.com</span></div>
${sticker('starburst', '#0168FB', 'right:60px;top:48px;width:118px;height:118px', 10)}`);
}

module.exports = { ogCardHtml, tonightCardHtml, weekendCardHtml, CARD_W, CARD_H, fitRows, byTime };
