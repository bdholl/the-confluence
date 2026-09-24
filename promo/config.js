// Everything about the promo bots you might want to change, in one place.
// Secrets are NOT here — they're GitHub Actions secrets (see PROMOTION.md).

module.exports = {
  // When each job is allowed to fire, in Milwaukee time.
  //
  // These are deliberately wide. GitHub's scheduler is not punctual: over 30
  // days the daily feed job (set for 6:17 AM) started a median of 3.8 hours
  // late, 6.7 hours at the 90th percentile, 10 hours at worst. So each
  // workflow fires every two hours, and the first run that lands inside the
  // window does the job; the state file makes every later run a no-op.
  // Expect "tonight" posts sometime in the afternoon, not at 3:00 sharp.
  windows: {
    tonight: { days: [0, 1, 2, 3, 4, 5, 6], from: '11:00', to: '19:30' },
    weekend: { days: [5], from: '09:00', to: '14:00' },            // Fridays
    newsletter: { days: [4], from: '07:00', to: '16:00' },          // Thursdays
  },

  // Opening lines. One is picked per day, deterministically, so a rerun says
  // the same thing and the feed doesn't repeat itself two days running.
  intros: {
    tonight: [
      'Tonight in Milwaukee.',
      'Where to be tonight:',
      'Milwaukee, tonight:',
      "Tonight's lineup. Pick one.",
      'You could stay in. Or:',
      'Get out of the house. Tonight:',
      'Come here, grab some tickets, go to the show. Tonight:',
    ],
    weekend: [
      'This weekend in Milwaukee.',
      'Weekend plans, sorted:',
      'The weekend, in shows:',
    ],
  },

  hashtags: '#Milwaukee #MKE #MilwaukeeMusic #LiveMusic',

  // Meta's Graph API version. Versions live about two years; if Meta sunsets
  // this one, posts fail loudly (a GitHub issue opens) and bumping this fixes it.
  graphVersion: 'v26.0',
  blueskyService: 'https://bsky.social',

  // The newsletter's sponsor line — null until someone pays for it. Shape:
  //   { name: 'Bullseye Records', url: 'https://…', line: 'Records, and the people who know them. Bay View.' }
  newsletterSponsor: null,
};
