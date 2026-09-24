#!/usr/bin/env node
/*
 * "This weekend in MKE" — every Friday–Sunday show, sent Thursday mornings
 * through Buttondown.
 *
 *   node promo/newsletter.js                     dry run for the coming weekend
 *   node promo/newsletter.js --friday=2026-10-02 dry run for a specific weekend
 *   node promo/newsletter.js --draft             create it as a Buttondown draft to preview
 *   node promo/newsletter.js --live              send it (the workflow does this)
 *   node promo/newsletter.js --auto --live       send only if it's Thursday morning
 *
 * DRY RUN IS THE DEFAULT. It writes promo/out/newsletter.html to open in a
 * browser. Sending needs BUTTONDOWN_API_KEY and --live.
 */

const fs = require('fs');
const path = require('path');
const { SITE, escH, fmtShort, dayHeading, chicagoNow, ticketUrl, buyOffer, MONTHS } = require('../feed/lib');
const config = require('./config');
const L = require('./lineup');
const { byTime } = require('./templates');
const S = require('./state');

const OUT_DIR = path.join(__dirname, 'out');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const LIVE = !!args.live;

function span(days) {
  const a = new Date(days[0].date + 'T12:00:00'), b = new Date(days[days.length - 1].date + 'T12:00:00');
  return a.getMonth() === b.getMonth()
    ? `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()}–${b.getDate()}`
    : `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${MONTHS[b.getMonth()].slice(0, 3)} ${b.getDate()}`;
}

// Lead with names — "They Might Be Giants, Russian Circles + 58 more" gets
// opened; "Weekly digest #14" doesn't.
function subjectFor(days) {
  const total = days.reduce((n, d) => n + d.shows.length, 0);
  // each day's list is billing-ordered, so [0] is that night's biggest show
  const names = [...new Set(days.map(d => d.shows[0]?.title).filter(Boolean))].slice(0, 2);
  const rest = total - names.length;
  const s = `This weekend in MKE: ${names.join(', ')}${rest > 0 ? ` + ${rest} more` : ''}`;
  return s.length <= 90 ? s : `${total} shows this weekend in Milwaukee (${span(days)})`;
}

// Email HTML: inline styles only, no web fonts, nothing clever — it has to
// survive Gmail, Outlook and Apple Mail. Buttondown wraps it in its own shell.
function emailHtml(days) {
  const total = days.reduce((n, d) => n + d.shows.length, 0);
  const sp = config.newsletterSponsor;
  const sponsor = sp
    ? `<p style="background:#eef4fd;border-left:4px solid #0168FB;padding:12px 14px;margin:18px 0;font-size:14px;">This week's email is supported by <a href="${escH(sp.url)}" style="color:#0168FB;font-weight:bold;">${escH(sp.name)}</a>${sp.line ? ` — ${escH(sp.line)}` : ''}</p>`
    : '';

  const dayBlock = d => {
    const rows = [...d.shows].sort(byTime).map(s => {
      const buy = buyOffer(s);
      const t = s.tbd ? 'TBA' : fmtShort(s.time);
      const tickets = buy.url && s.status !== 'cancelled' && s.status !== 'offsale'
        ? ` · <a href="${escH(ticketUrl(buy.url))}" style="color:#0168FB;">tickets</a>` : '';
      const flag = s.status === 'rescheduled' || s.status === 'postponed' ? ` <em style="color:#8a6a00;">(${s.status})</em>` : '';
      return `<p style="margin:0 0 9px;line-height:1.45;"><span style="color:#6f6f6f;">${escH(t)}</span> · <a href="${SITE}/show/${escH(s.slug)}.html" style="color:#111;font-weight:bold;text-decoration:none;">${escH(s.title)}</a>${flag} — ${escH(s.venue)}${tickets}</p>`;
    }).join('\n');
    return `<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#0168FB;border-bottom:1px solid #111;padding-bottom:6px;margin:28px 0 12px;">${escH(dayHeading(d.date))} · ${d.shows.length}</h2>\n${rows}`;
  };

  return `<!-- buttondown-editor-mode: fancy -->
<p style="font-size:16px;"><strong>${total} shows between Friday and Sunday.</strong> Here's every one, with tickets a click away.</p>
${sponsor}
${days.map(dayBlock).join('\n')}
<hr style="border:0;border-top:1px solid #e7e7e3;margin:28px 0 16px;">
<p style="font-size:14px;color:#6f6f6f;">Every show, every day: <a href="${SITE}/" style="color:#0168FB;">theconfluencemke.com</a><br>Missing a show? Just reply to this email.</p>`;
}

// A standalone page wrapping the email body, for opening in a browser.
const previewPage = (subject, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escH(subject)}</title>
<style>body{font-family:Georgia,serif;max-width:620px;margin:40px auto;padding:0 20px;color:#111;background:#fdfcf8}
.subj{font-family:system-ui,sans-serif;font-size:13px;color:#6f6f6f;border-bottom:1px solid #e7e7e3;padding-bottom:12px;margin-bottom:20px}</style></head>
<body><div class="subj">Subject: <b>${escH(subject)}</b></div>${body}</body></html>`;

async function sendButtondown({ subject, body, status }) {
  const res = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: { authorization: `Token ${process.env.BUTTONDOWN_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subject, body, status }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' — check BUTTONDOWN_API_KEY, and that your Buttondown plan includes API access' : '';
    throw new Error(`Buttondown: HTTP ${res.status} ${raw.slice(0, 300)}${hint}`);
  }
  return JSON.parse(raw).id;
}

async function main() {
  const now = chicagoNow();
  if (args.auto) {
    const w = config.windows.newsletter;
    const [fh, fm] = w.from.split(':').map(Number), [th, tm] = w.to.split(':').map(Number);
    const ok = w.days.includes(now.weekday) && now.minutes >= fh * 60 + fm && now.minutes <= th * 60 + tm;
    if (!ok) { console.log('Not Thursday morning in Milwaukee — nothing to send.'); S.setOutput('due', 'false'); return; }
  }
  const friday = args.friday || L.fridayFrom(now.date);
  const days = L.weekendDays(L.loadShows(), friday);
  if (!days.length) { console.log(`Nothing on the calendar the weekend of ${friday} — not sending.`); S.setOutput('due', 'false'); return; }

  const state = S.loadState();
  if (LIVE && state.newsletter?.[friday]) {
    console.log(`Already sent the ${friday} weekend email — nothing to do.`);
    S.setOutput('due', 'false');
    return;
  }

  const subject = subjectFor(days);
  const body = emailHtml(days);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const preview = path.join(OUT_DIR, 'newsletter.html');
  fs.writeFileSync(preview, previewPage(subject, body));
  const total = days.reduce((n, d) => n + d.shows.length, 0);

  console.log(`=== WEEKEND EMAIL · ${friday} · ${LIVE ? 'LIVE' : args.draft ? 'DRAFT' : 'DRY RUN'} ===`);
  console.log(`Subject: ${subject}`);
  console.log(`${total} shows across ${days.length} days · ${Math.round(Buffer.byteLength(body) / 1024)} KB`);
  console.log(`Preview: ${path.relative(path.join(__dirname, '..'), preview)}`);
  S.summary(`## Weekend email — ${friday} ${LIVE ? '(live)' : args.draft ? '(Buttondown draft)' : '(dry run — nothing sent)'}\n\n**Subject:** ${subject}\n\n${total} shows across ${days.length} days. The rendered email is attached to this run as an artifact.`);
  S.setOutput('due', 'true');

  if (!LIVE && !args.draft) return;
  if (!process.env.BUTTONDOWN_API_KEY) throw new Error('BUTTONDOWN_API_KEY is not set');

  const id = await sendButtondown({ subject, body, status: LIVE ? 'about_to_send' : 'draft' });
  if (LIVE) {
    state.newsletter = state.newsletter || {};
    state.newsletter[friday] = { id, at: new Date().toISOString() };
    S.saveState(state, undefined, now.date);
    console.log(`✓ Sent (${id})`);
  } else {
    console.log(`✓ Draft created in Buttondown (${id}) — open it there to preview`);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`\n✗ ${e.message}`);
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'failures.txt'), e.message); } catch { /* best effort */ }
    process.exit(1);
  });
}

module.exports = { subjectFor, emailHtml, span };
