# The Confluence

Live music calendar for Milwaukee. **https://theconfluencemke.com**

A single static page that reads `shows.json`, plus a Node script that rebuilds
that file from ticketing APIs every morning. No framework, no build step for
the site itself.

---

## Where everything lives

| Path | What it is |
| --- | --- |
| `index.html` | The entire site — markup, CSS, JS, and a baked-in copy of the show data for `file://` use |
| `shows.json` | The live feed the page fetches on load |
| `show/` | One small shareable page per show, written by the feed builder |
| `confluence.ics` | Calendar subscription file, regenerated each build |
| `guestbook.json` | Read-only fallback if the guestbook Worker is unreachable |
| `feed/build-shows.js` | Pulls, normalizes, dedupes, and writes the feed |
| `feed/preview-cache.json` | Artist → song-preview lookups, so builds only fetch new names |
| `feed/manual-extras.json` | Hand-added shows the APIs miss |
| `worker/` | Cloudflare Worker + KV backing the guestbook |
| `.github/workflows/update-feed.yml` | The daily rebuild |

## Running it

```bash
npm test                                   # 41 tests
TICKETMASTER_API_KEY=… SEATGEEK_CLIENT_ID=… npm run build-feed
npm run build-pages                        # previews, genres, slugs, share pages
                                           # — no ticketing keys, iTunes only
```

Preview locally with the `mkelive` server in `.claude/launch.json` (port 8753).
Opening `index.html` directly also works — it falls back to the embedded copy
of the data, because browsers block `fetch` on `file://`.

## How the data works

Three sources, merged:

- **Ticketmaster Discovery** — a metro-radius geo search *plus* a second pass
  over ~16 hand-listed venue IDs. The venue pass matters: the geo search filters
  to `classificationName=music` and silently drops small-room shows that
  Ticketmaster leaves untagged.
- **SeatGeek** — carries the AXS/Pabst Theater Group inventory Ticketmaster
  misses (Pabst, Riverside, Turner Hall, Vivarium).
- **The Argo** — not on either, so it comes from the public feed behind their
  Eventbrite widget.

Merging is the fiddly part, and most of it exists because of a real bug:

- `canonVenue()` collapses the several names each room goes by.
- `dedupe()` merges the same show from two sources into one listing carrying
  both places to buy.
- `mergeTitleVariants()` folds spelling and accent variants, and clusters
  showtimes — gaps under two hours are one show whose sources disagree, gaps
  over two hours are a genuine double-header (comedy clubs run two sets).
- Placeholder timestamps are honored as "TBA" rather than trusted as showtimes.
- When sources disagree on ticket status, the more serious one wins.

**The build never wipes good data.** If every source fails it exits non-zero and
leaves `shows.json` alone.

### Which ticket link a show gets

`pointAtBestOffer()` is the single place that decides where "Get Tickets" goes.
Box office before resale, with one important exception.

Ticketmaster's Discovery API lists events Ticketmaster **doesn't sell** — The
Rave, every Pabst Theater Group room, Cactus Club — and for those it returns a
bare `ticketmaster.com/event/<id>` pointer to an internal record rather than a
ticket page. Those links error out when clicked; two got reported from the live
site before this was caught.

The tell is the URL shape, so `DEAD_TM_LINK` ranks by where a link actually
goes rather than which API reported it:

| Shape | Meaning | Rank |
| --- | --- | --- |
| `ticketmaster.com/<slug>/event/<id>` | TM genuinely sells it | first |
| `ticketweb.com/…`, `pabsttheatergroup.com/…` | TM's API reporting the real box office | first |
| SeatGeek | resale, but it works | after |
| `ticketmaster.com/event/<id>` | dead internal record | last |

A working resale listing beats a box-office link that 404s. A dead link is
still used when it's the only offer a show has — no link at all would be worse.

## Sharing a single show

A calendar spreads when someone texts three friends "look at this", so every
show gets its own address: `/show/lindsey-stirling-2026-08-14.html`.

Each page is written at build time with its own `og:` tags — the artist's
photo, name, venue and date — so pasting the link into iMessage, Facebook, or
a group chat produces a real preview instead of this site's generic blurb. A
`#hash` deep link into the homepage would have been an hour's work, but link
crawlers never see anything after the `#`, so shared links would have looked
broken. The page itself has one job: a button straight to the ticket page.

The slug is the artist plus the date, which keeps it readable and lets the
builder read the date back off the filename. Two acts with the same name on
the same night (The Rave runs several rooms) get a `-2` suffix. Pages outlive
their show by 30 days so a link shared the week of the gig still resolves,
then the next build prunes them.

Rows on the calendar carry a **Share** button beside "Add to my list": phones
get the native share sheet, everything else copies the link. "Get Tickets"
stays exactly what it was — one click, straight to the seller.

**Calendar view links here too.** A month-grid square is too small to hold a
star and a ticket link, so its entries open the show's own page, which has
room for all of it. The save button there writes the same `confluence-mylist`
localStorage key, under the same `date|time|title` id the calendar uses — save
a show from its page and it turns up under My List back on the calendar. Both
sides of that contract are covered by a test, because nothing would visibly
break if they drifted; shows would just quietly stop appearing.

## Traffic

Cloudflare Web Analytics, cookie-free, so there's no consent banner. The
beacon is on `index.html` and on all 466 show pages, all with the same token —
which is public by design and ships in the HTML, so it isn't a secret and
isn't in an env var.

The domain is DNS-only (grey cloud), so Cloudflare can't inject the beacon
automatically and the manual snippet is required. If the DNS is ever proxied,
check that automatic injection doesn't start double-counting.

Page path is the useful dimension: a hit on `/show/…` means someone followed a
shared link. Links shared in iMessage or a private group chat arrive with no
referrer and land in "direct" — unavoidable, but the path still says which
show traveled.

Note that these pages are written by Node and never run `index.html`'s JS, so
they carry their own copy of the `AFFILIATE` map. If those params are ever
filled in, fill them in **both** places.

## Little moments

The guestbook lives at the bottom of the footer and the arcade is a small
button at the end of the toolbar, so both are easy to never find. Rather than
shout about them on day one, `maybeNudge()` waits until someone reads as a
regular and then mentions one — once, ever.

Counted in **distinct days visited**, not page loads, so refreshing all
afternoon doesn't burn through them. Guestbook at five days, arcade at ten.

`NUDGES` is ordered deliberately: the guestbook always gets its turn first.
Someone who arrives on day 12 having seen neither gets the guestbook that
visit and the arcade the next — one at a time, never a pile. A nudge is marked
seen the moment it appears, whether or not it's clicked.

State is two localStorage keys, `confluence-visits` and `confluence-nudged`.
To see one again, clear those.

On a phone the radio dock owns the bottom-right, so the nudge takes the full
width and lifts the dock out of its way via a `nudge-on` class on `<body>`.

## Genres

The ticketing APIs describe the booking, not the band, so half the feed used
to arrive as "other" and the filters were close to decorative. `refineGenres()`
fixes that with Apple's `primaryGenreName`, which the preview cache already
holds for every artist we've looked up.

Precedence, in order:

1. **Comedy is never overridden.** It comes from the ticket classification
   rather than free text — the one label the sources are reliably right about.
2. **`ARTIST_GENRE`** — a short hand-maintained exception list. Apple files
   Beck under Pop, which is true of the catalogue and wrong for how anyone
   books or hears him. Keep this list short; it isn't a genre system.
3. **An Apple genre fills an "other"** outright.
4. **It only overrides "rock" when it's a narrower rock** — indie, punk,
   metal. Rock is Ticketmaster's parent bucket, so that's a refinement.
   Country or pop would be a *disagreement*, and there the seller who saw the
   billing is likelier to be right.
5. **Title keywords, last.** Only for shows still on "other", and only for
   words that are unambiguous. "Drag Brunch" and "Karaoke" match a rule whose
   genre is `null` — they aren't a genre and shouldn't be guessed at.

`ITUNES_GENRE` is an array of pairs, not an object, **because the order is
load-bearing**: "Alternative Country" has to be tested before "Alternative" or
it lands in indie. There's a test pinning exactly that.

Result: "other" went from 224 to 71 and indie from 19 to 61, without widening
any rule to match more loosely — the filters hold more shows because more
shows are correctly labelled.

Punk is the standing reason `ARTIST_GENRE` exists: Apple files nearly all punk
as "Alternative", so the filter held one show until Bikini Kill, The Bouncing
Souls, AFI, Public Image Ltd, Turnstile and Militarie Gun were named by hand.
Citizen, Free Throw and Taking Back Sunday are deliberately left in indie —
they're emo, and there's no emo bucket.

## Known gaps

- **Anodyne and The Cooperage** don't list on any API we can reach. Add their
  shows to `feed/manual-extras.json` by hand.
- **AXS and pabsttheatergroup.com block automated requests** (403/406). SeatGeek
  covers most of that inventory; a headless-browser scraper is the only other
  option and hasn't been built.
- **26 shows have only a dead Ticketmaster link** and no second offer, so
  "Get Tickets" still lands on an error page for them. They're at The Rave,
  Pabst, Riverside, Miller High Life, Cactus Club and X-Ray Arcade. Fixing it
  properly needs a per-venue box-office URL map as a last-resort fallback.
- **Prices** come from Ticketmaster only, on roughly a quarter of shows.
  SeatGeek gates pricing behind a partner tier. Prices are stored but not shown.

## Not finished

- **Affiliate links earn nothing yet.** The plumbing is in `index.html` as
  `AFFILIATE` and every outbound ticket link already routes through
  `ticketUrl()`. It stays inert until the entries are filled in, which needs
  approval from Ticketmaster (via Impact) and SeatGeek first.
- **A sponsor** — the slot renders a pitch until `SPONSOR` is filled in.
