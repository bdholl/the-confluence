// Posting to each platform. Plain fetch against each API — no SDKs to keep
// patched. Tokens are only ever sent in request bodies or headers and never
// appear in thrown errors, so a failure message is safe to paste into an issue.

const config = require('./config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(url, opts, what) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body.error || body).slice(0, 500);
    const err = new Error(`${what} failed: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- Bluesky ----------
// App password, not the account password (Settings → Privacy and security →
// App passwords). Blobs over ~1 MB are rejected, so check before uploading.
const BSKY_MAX_BLOB = 976 * 1024;

async function postBluesky({ handle, appPassword }, post, image) {
  const svc = config.blueskyService;
  if (image.jpeg.length > BSKY_MAX_BLOB) throw new Error(`Bluesky: card is ${Math.round(image.jpeg.length / 1024)} KB, over the ~976 KB limit`);
  const session = await call(`${svc}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  }, 'Bluesky login');
  const auth = { authorization: `Bearer ${session.accessJwt}` };
  const up = await call(`${svc}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST', headers: { ...auth, 'content-type': 'image/jpeg' }, body: image.jpeg,
  }, 'Bluesky image upload');
  const record = {
    $type: 'app.bsky.feed.post',
    text: post.text,
    facets: post.facets,
    langs: ['en'],
    createdAt: new Date().toISOString(),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ alt: image.alt, image: up.blob, aspectRatio: { width: image.width, height: image.height } }],
    },
  };
  const out = await call(`${svc}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
  }, 'Bluesky post');
  return out.uri;
}

// ---------- Facebook Page ----------
// Uploads the card bytes directly, so it doesn't depend on the site deploy.
const graph = path => `https://graph.facebook.com/${config.graphVersion}/${path}`;

async function postFacebook({ pageId, pageToken }, message, image) {
  const form = new FormData();
  form.append('source', new Blob([image.jpeg], { type: 'image/jpeg' }), 'card.jpg');
  form.append('message', message);
  form.append('published', 'true');
  form.append('access_token', pageToken);
  const out = await call(graph(`${pageId}/photos`), { method: 'POST', body: form }, 'Facebook post');
  return out.post_id || out.id;
}

// ---------- Instagram ----------
// Instagram won't take an upload: it fetches the image from a public URL, and
// only JPEG. The workflow commits the card to the site first; this waits until
// GitHub Pages is actually serving it before asking Instagram to fetch it.
async function waitForImage(url, { tries = 40, gapMs = 15000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (res.ok && /image\/jpe?g/.test(res.headers.get('content-type') || '')) return;
    } catch { /* not up yet */ }
    await sleep(gapMs);
  }
  throw new Error(`Instagram: ${url} never went live (waited ${Math.round(tries * gapMs / 60000)} min for the site deploy)`);
}

async function postInstagram({ igUserId, pageToken }, caption, image) {
  await waitForImage(image.url);
  const container = await call(graph(`${igUserId}/media`), {
    method: 'POST', body: new URLSearchParams({ image_url: image.url, caption, access_token: pageToken }),
  }, 'Instagram container');
  // images are usually ready at once; give it up to a minute
  for (let i = 0; i < 20; i++) {
    const st = await call(graph(`${container.id}?fields=status_code`), {
      headers: { authorization: `Bearer ${pageToken}` },
    }, 'Instagram status');
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram container ${st.status_code}`);
    await sleep(3000);
  }
  const out = await call(graph(`${igUserId}/media_publish`), {
    method: 'POST', body: new URLSearchParams({ creation_id: container.id, access_token: pageToken }),
  }, 'Instagram publish');
  return out.id;
}

module.exports = { postBluesky, postFacebook, postInstagram, waitForImage, BSKY_MAX_BLOB };
