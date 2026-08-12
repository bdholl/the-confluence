# The Confluence — show feed

`build-shows.js` fetches real, upcoming Milwaukee live-music listings and writes
`../shows.json`, which the site loads on page open. Run it on a schedule and the
calendar stays current with no code changes.

## 1. Get at least one API key (both are free)

You need **at least one**; using both improves coverage.

| Source | Where to get a key | Env variable |
| --- | --- | --- |
| Ticketmaster Discovery | https://developer.ticketmaster.com (create an app → "Consumer Key") | `TICKETMASTER_API_KEY` |
| SeatGeek Platform | https://seatgeek.com/account/develop (register an app → "Client ID") | `SEATGEEK_CLIENT_ID` |

## 2. Run it

From the project root (`mkelive/`):

```bash
TICKETMASTER_API_KEY=your_key SEATGEEK_CLIENT_ID=your_id node feed/build-shows.js
```

You'll see a per-source count and `✓ Wrote N shows … to shows.json`. Reload the
site and the live data replaces the built-in sample. If every source fails or
returns nothing, the script exits without touching `shows.json` (so a bad run
never wipes good data).

Optional env: `FEED_DAYS_AHEAD` (default `120`) — how far ahead to pull.

## 3. Automate it

### Option A — locally on your Mac (launchd, daily at 6am)

Create `~/Library/LaunchAgents/com.theconfluence.feed.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.theconfluence.feed</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/Users/Brian/Desktop/Personal/Claude Code/mkelive/feed/build-shows.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TICKETMASTER_API_KEY</key><string>your_key</string>
    <key>SEATGEEK_CLIENT_ID</key><string>your_id</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/confluence-feed.log</string>
  <key>StandardOutPath</key><string>/tmp/confluence-feed.log</string>
</dict></plist>
```

Then: `launchctl load ~/Library/LaunchAgents/com.theconfluence.feed.plist`

### Option B — in the cloud (GitHub Actions, for the deployed site)

`.github/workflows/update-feed.yml` is included. Once the site is a GitHub repo
(deployed via GitHub Pages, Netlify, Vercel, etc.), add `TICKETMASTER_API_KEY`
and `SEATGEEK_CLIENT_ID` as repository **Secrets**, and the workflow runs daily,
commits the refreshed `shows.json`, and your host redeploys.

## Hand-adding shows the APIs miss

DIY spaces, bar shows, and free gigs often aren't in the ticketing APIs. Add
them to `manual-extras.json` (a JSON array) and they're merged in every build:

```json
[
  {
    "date": "2026-06-09",
    "time": "20:00",
    "title": "Local Band Name",
    "support": null,
    "venue": "Linneman's Riverwest Inn",
    "hood": "Riverwest",
    "genre": "indie",
    "ticketer": "At the door",
    "url": "https://venue-or-event-link.com"
  }
]
```

Time is 24-hour local (`HH:MM`). Genre keys: `rock metal jazz blues punk indie
country pop latin folk festival electronic hiphop rnb other`.

## Tuning

- **Neighborhoods** — `VENUE_HOODS` in `build-shows.js` maps venue names to
  Milwaukee neighborhoods. Add venues as you see them.
- **Genres** — `GENRE_MAP` translates each source's genre wording to the app's
  genre keys.
- **Coverage area** — `LAT` / `LON` / `RADIUS` set the metro search circle.
