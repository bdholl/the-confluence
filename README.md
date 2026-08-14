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
| `confluence.ics` | Calendar subscription file, regenerated each build |
| `guestbook.json` | Read-only fallback if the guestbook Worker is unreachable |
| `feed/build-shows.js` | Pulls, normalizes, dedupes, and writes the feed |
| `feed/preview-cache.json` | Artist → song-preview lookups, so builds only fetch new names |
| `feed/manual-extras.json` | Hand-added shows the APIs miss |
| `worker/` | Cloudflare Worker + KV backing the guestbook |
| `.github/workflows/update-feed.yml` | The daily rebuild |

## Running it

```bash
npm test                                   # 28 tests
TICKETMASTER_API_KEY=… SEATGEEK_CLIENT_ID=… npm run build-feed
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

## Known gaps

- **Anodyne and The Cooperage** don't list on any API we can reach. Add their
  shows to `feed/manual-extras.json` by hand.
- **AXS and pabsttheatergroup.com block automated requests** (403/406). SeatGeek
  covers most of that inventory; a headless-browser scraper is the only other
  option and hasn't been built.
- **Prices** come from Ticketmaster only, on roughly a quarter of shows.
  SeatGeek gates pricing behind a partner tier. Prices are stored but not shown.

## Not finished

- **Affiliate links earn nothing yet.** The plumbing is in `index.html` as
  `AFFILIATE` and every outbound ticket link already routes through
  `ticketUrl()`. It stays inert until the entries are filled in, which needs
  approval from Ticketmaster (via Impact) and SeatGeek first.
- **Shareable per-show links** — discussed, not built. The good version
  generates a small page per show at build time so pasted links get a real
  preview; a `#hash` deep link is simpler but previews poorly when shared.
- **A sponsor** — the slot renders a pitch until `SPONSOR` is filled in.
