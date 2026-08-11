'use strict';

/**
 * ============================================================================
 *  EDITABLE GROUP — CENTRAL CONFIG
 * ============================================================================
 *  Every ID, threshold and tunable lives here. Nothing else in the codebase
 *  should contain a hardcoded snowflake. If you need to change a channel,
 *  change it once, here.
 *
 *  ⚠️  ACTION REQUIRED before deploy: search for "SET_ME" and fill in.
 * ============================================================================
 */

module.exports = {
  // ── Identity ──────────────────────────────────────────────────────────────
  TOKEN: process.env.TOKEN,
  CLIENT_ID: '1498623710301650994',
  GUILD_ID: '1437187584689438865',
  MONGODB_URI: process.env.MONGODB_URI,
  DB_NAME: 'editablegroup',

  // ── Staff ─────────────────────────────────────────────────────────────────
  // Anyone in this list bypasses every tier gate. Keep it short.
  STAFF_IDS: [
    '960171711674847282', // Max  (Cilord)
    '996919845373366362', // Roshan (Roca)
  ],
  OWNER_ID: '960171711674847282',
  ROCA_ID: '996919845373366362',

  // ── Roles ─────────────────────────────────────────────────────────────────
  ROLES: {
    // Everyone who completes onboarding lands here.
    NETWORK: '1536415553332322314',

    // Hand-picked / promoted editors. Create this role in Discord and paste
    // its ID. It must sit ABOVE @everyone and BELOW the bot's own role.
    CORE: 'SET_ME_CORE_ROLE_ID',

    // Your existing "Editor" role — the 100 hand-picked people.
    // Used once by /migratecore to bulk-grant Core, then it can be retired.
    LEGACY_EDITOR: '1437195425819131915',

    // Granted by the Join button — unlocks the private competition category
    COMPETITION: '1536767907948798113',
  },

  // ── Channels ──────────────────────────────────────────────────────────────
  CHANNELS: {
    ONBOARDING: '1508909360510795837',
    LOGS: '1505978732010274846',
    SUBMISSIONS: '1498679979666444378',
    ACTIVE_CAMPAIGNS: '1506778321969746092',
    DEMOGRAPHICS: '1519022400828739604',

    // Where editors submit (the dropdown panel lives here)
    SUBMIT: '1498679508247511230',

    // Competition
    COMP_ANNOUNCE_PUBLIC: '1536461950710448168', // public, has Join/Leave
    COMP_ANNOUNCEMENT:    '1536768296316182689', // private category
    COMP_RULES:           '1536768345800577165',
    COMP_SUBMIT_INFO:     '1536768512817893466',

    // NEW — create these. Core campaigns must not be visible to Network.
    CORE_CAMPAIGNS: 'SET_ME_CORE_CAMPAIGNS_CHANNEL_ID',

    // Optional: high-signal alerts (fraud flags, budget warnings, API failures).
    // Falls back to LOGS if left as SET_ME.
    ALERTS: 'SET_ME_ALERTS_CHANNEL_ID',
  },

  // ── Tier system ───────────────────────────────────────────────────────────
  TIERS: {
    NONE: 'none',       // joined, has not onboarded — sees #onboarding only
    NETWORK: 'network', // onboarded, open campaigns
    CORE: 'core',       // vetted, exclusive quality-controlled campaigns
    STAFF: 'staff',
  },

  // Auto-promotion thresholds. The bot never promotes on its own — it posts a
  // nomination to #logs for you to approve. Automatic promotion would let
  // people farm their way into Core.
  CORE_NOMINATION: {
    MIN_APPROVED_SUBS: 3,
    MIN_AVG_VIEWS: 25000,
    MIN_TOTAL_VIEWS: 150000,
    MAX_REJECTION_RATE: 0.25,
  },

  // ── Anti-fraud / integrity ────────────────────────────────────────────────
  INTEGRITY: {
    // Reject a submission whose TikTok author handle doesn't match the handle
    // the editor registered at onboarding. This is the single highest-value
    // check once the server is public.
    ENFORCE_HANDLE_MATCH: false,

    // Videos posted before this many hours ago are rejected — stops people
    // submitting old viral posts that were never made for your campaign.
    MAX_VIDEO_AGE_HOURS: 720, // 30 days

    // A video already above this view count at submission time is flagged for
    // manual review rather than auto-accepted.
    SUSPICIOUS_INITIAL_VIEWS: 100000,

    // Hard cap on submissions per editor per campaign.
    MAX_SUBS_PER_CAMPAIGN: 15,
  },

  // ── Payouts ───────────────────────────────────────────────────────────────
  PAYOUTS: {
    // Editors request payout themselves once cleared balance passes this.
    // Batching payouts is the only way this survives 1,000+ members.
    MINIMUM_USD: 25,

    // Days after a campaign ends before pending earnings become "cleared".
    // Gives you a window to catch view-botting before money moves.
    CLEARING_DAYS: 7,
  },

  // ── Stats engine ──────────────────────────────────────────────────────────
  STATS: {
    INTERVAL_MS: 12 * 60 * 60 * 1000, // 12h
    CONCURRENCY: 4,                    // parallel lookups — do not raise blindly
    DELAY_BETWEEN_MS: 250,             // politeness gap
    MAX_LOOKUPS_PER_RUN: 4000,         // hard ceiling so one run can't burn your quota
  },

  // ── Rate limiting (per user, in-process) ──────────────────────────────────
  COOLDOWNS: {
    SUBMIT_MS: 10_000,
    BUTTON_MS: 2_000,
    COMMAND_MS: 3_000,
  },

  // ── Command visibility ────────────────────────────────────────────────────
  // true  → Discord hides admin commands from non-admins entirely (most secure)
  // false → commands are visible but greyed out, with "(ADMIN ONLY)" in the
  //         description, matching the PayPerClip screenshot look
  HARD_HIDE_ADMIN_COMMANDS: true,

  // ── Referrals ─────────────────────────────────────────────────────────────
  REFERRALS: {
    FIRST_POST_BONUS: 5,
    MILESTONE_VIEWS: 500_000,
    MILESTONE_BONUS: 50,
    // Invite-diffing is expensive. Batch refreshes instead of one fetch per join.
    CACHE_REFRESH_MS: 10_000,
  },

  BRAND_COLOR: 0x1e4fd8,

  // ── Edit competition ────────────────────────────────────────────
  // Everything the competition says lives here. Change the copy in this block,
  // run /comp preview, and you'll see it before anything is posted.
  COMPETITION: {
    VALUE: 'edit_comp_1000',
    TITLE: '$1,000 Edit Competition',

    // Deadline: 24 August 2026, 23:59 BST (= 22:59 UTC).
    // Discord renders this in each member's own timezone automatically.
    DEADLINE_UNIX: 1787612340,

    // ⚠️ SET YOUR PRIZE SPLIT. These are placeholders — change them.
    PRIZE_SUMMARY: '**$1,000** total — 1st $500 · 2nd $250 · 3rd $150 · 4th $100',
    PRIZES_DETAIL:
      '🥇 **1st — $500**\n' +
      '🥈 **2nd — $250**\n' +
      '🥉 **3rd — $150**\n' +
      '🏅 **4th — $100**',

    // Plain-text variants (used by the non-embed announcement panels)
    PRIZE_SUMMARY_PLAIN: '1st $500 · 2nd $250 · 3rd $150 · 4th $100',
    JUDGING_PLAIN: 'Edit quality, creativity and execution, alongside performance. '
                 + 'Not views alone.',
    BRIEF_PLAIN: 'Open brief, any style, any niche. High quality edits.',

    JUDGING: 'Quality and performance',
    JUDGING_DETAIL:
      'Judged by the Editable team on **edit quality, creativity and execution**, '
    + 'alongside how the post performed.\n\n'
    + '**This is not a view count competition.** A well-made edit with modest '
    + 'numbers can beat a lazy one that got lucky.',

    PLATFORMS: ['TikTok', 'Instagram Reels', 'YouTube Shorts'],

    BRIEF_SHORT: 'Open brief — any style, any niche. High quality edits.',
    BRIEF_FULL:
      '**Open brief.** Any style, any niche — anime, film, TV, sports, '
    + 'celeb, fancam, gaming, music, whatever you\'re best at.\n\n'
    + 'The only requirement is that it\'s a **high quality edit**. Show us what '
    + 'you can actually do.',

    CAPTION: 'Get paid for your edits, join Editable: discord.gg/editable #editable1k',
    HASHTAG: '#editable1k',

    DROPDOWN_LABEL: '💲1000 EDIT COMPETITION',
    MAX_ENTRIES: 5,
  },

  /**
   * Legacy campaigns — seeded into MongoDB on first boot ONLY if the
   * `campaigns` collection is empty. After that, campaigns live in the DB and
   * are managed with /campaign create. Never edit these again.
   */
  LEGACY_CAMPAIGNS: [
    {
      value: 'alter_ego_doechii',
      label: 'Alter Ego - Doechii Ft. JT',
      tier: 'core', rpm: 1.0, maxPayout: 350, minViews: 1500, budget: 1075,
      bonus1st: 150, bonus2nd: 75,
      endDate: new Date('2026-05-20T23:59:59Z'), status: 'ended',
    },
    {
      value: 'shake_that_jig',
      label: 'SHAKE THAT - JIG LeFrost',
      tier: 'core', rpm: 1.0, maxPayout: 350, minViews: 1500, budget: 1000,
      bonus1st: 100, bonus2nd: 50,
      endDate: new Date('2026-05-24T23:59:59Z'), status: 'ended',
    },
    {
      value: 'fuego_bnyx',
      label: 'Fuëgo - BNYX®, Yeat & Peso Pluma',
      tier: 'core', rpm: 1.25, maxPayout: 400, minViews: 1500, budget: 1075,
      bonus1st: 150, bonus2nd: 75,
      endDate: new Date('2026-06-03T21:59:59Z'), status: 'ended',
      roleId: '1506777268754579506',
      announcementChannelId: '1506777667020521472',
      offerChannelId: '1506778321969746092',
      brief: 'Popular TV shows, movies, thirst traps, and Latina characters — think Maddie Perez from Euphoria. Keep it cinematic, trending and visually striking.',
    },
  ],
};
