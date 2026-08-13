# Guestbook API (Cloudflare Worker)

A tiny free backend so guestbook signatures post instantly and show up for
everyone. Cloudflare's free tier covers it (100k requests/day).

## Deploy (one time, ~3 minutes)

From this folder:

```bash
cd worker
npx wrangler login                          # opens Cloudflare in your browser
npx wrangler kv namespace create GUESTBOOK  # prints an id
```

Paste that id into `wrangler.toml` (replacing `PASTE_KV_NAMESPACE_ID_HERE`), then:

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://confluence-guestbook.<you>.workers.dev`.
Put it in `index.html`:

```js
const GUESTBOOK_API = 'https://confluence-guestbook.<you>.workers.dev';
```

Commit and push — signatures now post live.

## What it does

- `GET /` returns all entries (oldest first)
- `POST /` with `{name, note}` appends one and returns the updated list
- Keeps the most recent 500 entries
- Rate limits one post per IP per 30s, ignores exact duplicate repeats
- Trims control characters; the page HTML-escapes on render

## Moderating

Entries live in the `GUESTBOOK` KV namespace under the key `entries`.
To remove something, edit that value in the Cloudflare dashboard
(Workers & Pages → KV → GUESTBOOK → entries), or:

```bash
npx wrangler kv key get entries --binding GUESTBOOK --remote > gb.json
# edit gb.json
npx wrangler kv key put entries --binding GUESTBOOK --remote --path gb.json
```
