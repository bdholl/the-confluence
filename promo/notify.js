#!/usr/bin/env node
// Fail loudly. Called by a workflow's `if: failure()` step: opens a GitHub
// issue (which emails you), or — if one is already open for the same job —
// adds a comment instead of piling up duplicates. Silent failure is how
// set-and-forget turns into "it broke in October and nobody noticed".
//
//   node promo/notify.js "<job name>" [path/to/details.txt]

const fs = require('fs');

const LABEL = 'bot-failure';
const [job, detailsFile] = process.argv.slice(2);

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok && res.status !== 422) throw new Error(`GitHub API ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error('notify: not running in GitHub Actions — nothing to open.');
    return;
  }
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  let details = '';
  try { if (detailsFile) details = fs.readFileSync(detailsFile, 'utf8').trim(); } catch { /* no details file */ }

  const title = `${job || 'A scheduled job'} failed`;
  const body = [
    `**${title}** on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    details ? '```\n' + details.slice(0, 3000) + '\n```' : '_No details captured — see the run log._',
    '',
    `Run log: ${runUrl}`,
    '',
    'Most likely causes, in order: an expired or revoked token (see **PROMOTION.md → When a token expires**), ',
    'a platform API change, or GitHub Pages being slow to deploy the image. Re-run the workflow from the ',
    'Actions tab once fixed — it never double-posts.',
  ].join('\n');

  // label may not exist yet; 422 means it already does
  await gh('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'd73a4a', description: 'A scheduled bot failed' }) });

  const open = await gh(`/issues?state=open&labels=${LABEL}&per_page=50`);
  const existing = (open || []).find(i => i.title === title);
  if (existing) {
    await gh(`/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    console.log(`Commented on #${existing.number}`);
  } else {
    const issue = await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: [LABEL] }) });
    console.log(`Opened #${issue.number}`);
  }
}

main().catch(e => { console.error('notify failed:', e.message); process.exit(1); });
