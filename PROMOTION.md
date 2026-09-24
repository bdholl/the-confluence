# Promotion — how the site grows on its own

Everything here runs on a schedule in GitHub Actions. Once it's set up, the
only thing that should ever need a human is a token that stops working — and
if that happens, a GitHub issue opens and emails you.

---

## What runs when

All times Milwaukee time.

**GitHub's scheduler is not punctual.** Over 30 days the feed job — set for
6:17 AM — started a median of 3.8 hours late, 6.7 hours at the 90th
percentile, and once 10 hours late. So nothing here is pinned to a minute:
each job fires every two hours, acts only inside a wide window, and the first
run to land there does the work. Later runs see it's done and do nothing.

| Job | Posts/sends somewhere in | What it does | Workflow |
| --- | --- | --- | --- |
| Show feed | the morning (set for 6:17 AM) | Rebuilds the calendar, every show and day page, sitemap, venue addresses | `update-feed.yml` |
| Tonight in Milwaukee | 11 AM – 7:30 PM daily | Tonight's lineup + card to Bluesky, Facebook, Instagram. Skips nights with nothing on | `social.yml` |
| This weekend | 9 AM – 2 PM Fridays | Same, for Friday–Sunday | `social.yml` |
| Weekend email | 7 AM – 4 PM Thursdays | Every Friday–Sunday show, through Buttondown | `newsletter.yml` |

The windows live in `promo/config.js`. If you ever want a post at an exact
time, the dependable fix is a scheduler outside GitHub — e.g. a Cloudflare
Worker cron trigger that calls the workflow's "Run workflow" API, since manual
runs start within seconds. It's a small addition, but it needs a GitHub token
that expires yearly, so it isn't set up by default.

The social and email jobs **run as dry runs until you switch them on** (see
[Going live](#going-live)). A dry run does everything except publish: the post
text lands on the run's summary page and the card image is attached to the run.

## Where things live

| | |
| --- | --- |
| Secrets (tokens, passwords) | GitHub → the repo → **Settings → Secrets and variables → Actions → Secrets** |
| On/off switches | Same page, **Variables** tab: `SOCIAL_LIVE`, `NEWSLETTER_LIVE` |
| Post wording, hashtags, time windows, newsletter sponsor | `promo/config.js` |
| Affiliate tracking links | `feed/affiliate.json` |
| Venue street addresses | `feed/venues.json` (learned automatically; see below) |
| What's already been posted | `promo/state.json` (the bots write this) |

| Secret | Used by |
| --- | --- |
| `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | Bluesky |
| `META_PAGE_ID`, `META_PAGE_TOKEN` | Facebook |
| `INSTAGRAM_USER_ID` (+ `META_PAGE_TOKEN`) | Instagram |
| `BUTTONDOWN_API_KEY` | Weekend email |
| `TICKETMASTER_API_KEY`, `SEATGEEK_CLIENT_ID` | Show feed (already set) |

A platform with no secrets is simply skipped, so you can turn them on one at a time.

## Dry runs

**From the Actions tab** (no setup needed): Actions → *Social posts* → **Run
workflow** → pick `tonight` or `weekend`, leave *live* unchecked. Open the
finished run: the posts are on the summary page, the card is under Artifacts.
Same for *Weekend email* with `dry-run`, or `draft` to put it in Buttondown
where you can see exactly how it renders.

**On your Mac:**

```bash
node promo/social.js --mode=tonight
node promo/social.js --mode=weekend --date=2026-10-02
node promo/newsletter.js
```

Cards and the email preview land in `promo/out/` (not committed). Nothing is
ever published without `--live`.

## Going live

Do each platform's setup below first. Then, for each bot:

1. Run it once as a dry run from the Actions tab and read the output.
2. Run it again with **live** checked (social) or **send** (email) — that's
   your first real post, and proves the tokens work.
3. Add the repository variable `SOCIAL_LIVE` = `true` (or
   `NEWSLETTER_LIVE` = `true`). From then on the schedule posts for real.

To pause a bot, delete the variable or set it to anything else.

## When something breaks

A failed run opens an issue labelled `bot-failure` (or comments on the open
one) with the error and a link to the log. The usual causes:

- **A token expired or was revoked.** Redo that platform's setup below and
  update the secret. Most likely with Meta: changing your Facebook password, or
  removing the app, invalidates the Page token.
- **Meta retired the API version.** Bump `graphVersion` in `promo/config.js`
  (versions last about two years; the current one is listed at
  developers.facebook.com/docs/graph-api/changelog).
- **Instagram couldn't fetch the card.** It downloads the image from the site,
  so a slow GitHub Pages deploy can time it out. Re-run — it won't repost to
  the platforms that already worked.

After fixing, re-run the failed workflow from the Actions tab and close the issue.

One quiet failure mode to know about: GitHub switches off scheduled workflows
in a repo with no commits for 60 days. The daily feed commits every morning,
so this can only happen if the feed itself stops — which would open an issue.

---

## One-time setup (about 45 minutes, mostly Meta)

### 1. Bluesky — 5 minutes

1. Create the account at **bsky.app** (e.g. `theconfluencemke.bsky.social`).
2. Set the profile's website to `https://theconfluencemke.com`.
3. **Settings → Privacy and security → App passwords → Add App Password**,
   name it `GitHub`. Copy it — it's shown once.
4. Add repo secrets `BLUESKY_HANDLE` (the handle, no @) and `BLUESKY_APP_PASSWORD`.

*Optional, free, worth it:* use the domain as the handle (`@theconfluencemke.com`).
Bluesky → Settings → Account → Handle → "I have my own domain" gives you a TXT
record; add it in Cloudflare DNS. If you do, update `BLUESKY_HANDLE`.

### 2. Facebook Page + Instagram — 25–30 minutes

Meta needs four things wired together: a Facebook Page, an Instagram
professional account linked to it, a developer app, and a Page token that
doesn't expire.

1. **Facebook Page:** facebook.com → Pages → Create new Page → "The
   Confluence". Add the website.
2. **Instagram:** create the account, then switch it to a professional account
   (Settings → Account type and tools → Switch to professional account →
   Business). Set the bio link to `https://theconfluencemke.com` — captions say
   "link in bio".
3. **Link them:** on the Facebook Page, Settings → Linked accounts → Instagram
   → Connect.
4. **Developer app:** developers.facebook.com → My Apps → Create App. Choose the
   use cases for managing a Page's content and Instagram content (Meta renames
   these every so often). Leave the app in Development mode — that's enough to
   post to accounts you own; App Review is only for other people's accounts.
5. **Short-lived token:** developers.facebook.com/tools/explorer → pick your
   app → *Get User Access Token* → tick `pages_show_list`,
   `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`, `business_management` → Generate, and approve
   for your Page and Instagram account.
6. **Make it long-lived:** paste that token into
   developers.facebook.com/tools/debug/accesstoken → **Extend Access Token**.
7. **Page token that never expires:** back in the Explorer, with the
   long-lived token, run `GET me/accounts`. Your Page's `access_token` in the
   result is a Page token with no expiry, and its `id` is the Page ID. Check it
   in the Access Token Debugger — *Expires: Never*.
8. **Instagram user ID:** in the Explorer, `GET <page-id>?fields=instagram_business_account`.
9. Add repo secrets `META_PAGE_TOKEN`, `META_PAGE_ID`, `INSTAGRAM_USER_ID`.

Instagram allows 25 API posts a day; this uses at most two.

### 3. Buttondown — 10 minutes

1. Sign up at **buttondown.com**. Your username becomes the newsletter's
   address, so pick something like `theconfluence`.
2. Settings → set the reply-to address to `hello@theconfluencemke.com`, so
   "just reply to this email" reaches you.
3. Settings → API → copy the key → repo secret `BUTTONDOWN_API_KEY`.
4. Put your username in `NEWSLETTER_USER` near the top of the script in
   `index.html`. The signup form in the footer stays hidden until you do.

**Check the plan before you rely on it:** Buttondown's free tier covers 100
subscribers, and several independent reviews say API access needs the
Standard plan (~$29/month). Buttondown's own pricing page didn't say either
way when this was written. If the API is paywalled, the email generator is
provider-agnostic — only `sendButtondown()` in `promo/newsletter.js` is
Buttondown-specific. MailerLite's free tier (250 subscribers) is the likeliest
free alternative; its help pages imply the API works on free, but confirm
before switching.

### 4. Google Search Console — 5 minutes

1. search.google.com/search-console → Add property → **Domain** →
   `theconfluencemke.com`.
2. Google shows a TXT record. Add it in Cloudflare → DNS → Records → Add
   (type TXT, name `@`). Back in Search Console → Verify. The DNS method covers
   every version of the domain and needs no code.
3. Sitemaps → submit `sitemap.xml`.

Rich results usually start appearing within a couple of weeks. Search Console →
Enhancements → Events shows which shows qualify and flags any that don't.

### 5. Affiliate programs — 15 minutes, then a wait

Both ticket programs run on **impact.com**. Sign up there as a partner and
apply to **SeatGeek** and **Ticketmaster** (Ticketmaster's covers TicketWeb
links too). Approval takes days to weeks.

Once approved, create a deep link for each program in Impact. It looks like
`https://seatgeek.pxf.io/c/1234567/890123/12345?u=…` — the destination goes in
`u`. Paste it into the matching `wrap` in `feed/affiliate.json`, with `{url}`
where the destination goes:

```json
"wrap": "https://seatgeek.pxf.io/c/1234567/890123/12345?u={url}"
```

The next morning's build applies it to every ticket link on the calendar, every
show and day page, the social posts and the email.

---

## Venue addresses

Google won't show an event in rich results without a street address. The daily
build learns each venue's address from the ticketing APIs into
`feed/venues.json` and lists any venue still missing one in the build log. To
fix one by hand, edit its entry and add `"manual": true` — the build never
overwrites a manual entry.
