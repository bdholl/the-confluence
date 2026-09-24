// What's already been posted, committed to the repo by the workflows.
//
// Recorded per platform, not per run: if Bluesky succeeds and Instagram fails,
// the rerun posts to Instagram only. Without that, fixing one broken platform
// would mean double-posting to the ones that worked.

const fs = require('fs');
const path = require('path');
const { addDays } = require('../feed/lib');

const STATE_FILE = path.join(__dirname, 'state.json');
const KEEP_DAYS = 60;

function loadState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { social: {}, newsletter: {} }; }
}

function saveState(state, file = STATE_FILE, today) {
  // keys start with a YYYY-MM-DD date; drop anything older than two months
  if (today) {
    const cutoff = addDays(today, -KEEP_DAYS);
    for (const bucket of ['social', 'newsletter']) {
      for (const k of Object.keys(state[bucket] || {})) if (k.slice(0, 10) < cutoff) delete state[bucket][k];
    }
  }
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

const posted = (state, key, platform) => !!state.social?.[key]?.[platform];

function markPosted(state, key, platform, id) {
  state.social = state.social || {};
  state.social[key] = state.social[key] || {};
  state.social[key][platform] = { id, at: new Date().toISOString() };
}

// GitHub Actions: append markdown to the run's summary page, which is where a
// dry run's output goes for review.
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

module.exports = { loadState, saveState, posted, markPosted, summary, setOutput, STATE_FILE };
