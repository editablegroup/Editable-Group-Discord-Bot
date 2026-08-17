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

    // Payment methods + balance panel. Members must be able to change a PayPal
    // address after onboarding, so this channel is not optional.
    PAYMENTS: 'SET_ME_PAYMENTS_CHANNEL_ID',

    // Ticket panel. The old build posted it into LOGS, where members cannot see
    // it, which meant nobody could open a ticket at all.
    TICKETS: 'SET_ME_TICKETS_CHANNEL_ID',

    // Where ticket channels get created. Leave as SET_ME to create them at the
    // top level of the server instead.
    TICKETS_CATEGORY: 'SET_ME_TICKETS_CATEGORY_ID',

    // Persistent all-time leaderboard. One message, edited in place.
    LEADERBOARD: 'SET_ME_LEADERBOARD_CHANNEL_ID',

    // Where /campaign create puts each campaign's own category.
    CAMPAIGN_PARENT: 'SET_ME_CAMPAIGN_PARENT_CATEGORY_ID',
  },

  // ── Category names ────────────────────────────────────────────────────────
  // Discord has no way to link a category. `<#categoryId>` renders as "#unknown"
  // for everyone, which is what members saw when the welcome message tried to
  // point them at the campaigns category. So categories are named in plain text
  // instead, and the name has to match what is actually in the sidebar.
  CATEGORY_LABELS: {
    ACTIVE_CAMPAIGNS: '🔥 — ACTIVE Campaigns',
  },

  // ── Logging ───────────────────────────────────────────────────────────────
  // Every key that is left as SET_ME is simply skipped, so you can wire these
  // up one at a time. `automod` is deliberately absent: Discord's own AutoMod
  // does that job better than a hand-rolled filter would.
  LOG_CHANNELS: {
    SYSTEM: 'SET_ME_LOG_SYSTEM',            // boot, stats runs, API failures
    JOIN_LEAVE: 'SET_ME_LOG_JOIN_LEAVE',    // member joins and leaves
    CHAT: 'SET_ME_LOG_CHAT',                // message edits and deletions
    SERVER: 'SET_ME_LOG_SERVER',            // channel/role/member updates
    ONBOARDING: 'SET_ME_LOG_ONBOARDING',    // completed onboardings
    SUBMISSION: 'SET_ME_LOG_SUBMISSION',    // submitted, approved, rejected
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
    // 3h. Every view count the members see is quoted from this number, so if you
    // change it the copy in copy.js changes with it automatically.
    //
    // Going below 3h is a money decision, not a technical one: the lookup chain
    // is free oEmbed, then free TikWM, then PAID RapidAPI. Four runs a day
    // against 5,000 approved submissions is 20,000 lookups, and every one that
    // falls through to RapidAPI costs you. MAX_PAID_LOOKUPS_PER_DAY is the
    // circuit breaker for the day TikWM goes down and every lookup falls
    // through at once.
    INTERVAL_MS: 3 * 60 * 60 * 1000,   // 3h
    CONCURRENCY: 4,                    // parallel lookups — do not raise blindly
    DELAY_BETWEEN_MS: 250,             // politeness gap
    MAX_LOOKUPS_PER_RUN: 4000,         // hard ceiling so one run can't burn your quota
    MAX_PAID_LOOKUPS_PER_DAY: 2000,    // RapidAPI circuit breaker
  },

  // ── Niches ────────────────────────────────────────────────────────────────
  // Picked at onboarding, granted as roles, used to decide who a campaign pings.
  // Add one here and it appears in onboarding and in /campaign create with no
  // other change. Leave roleId as SET_ME and the bot creates the role on boot.
  NICHES: [
    { value: 'film_tv', label: 'Film & TV', emoji: '🎬', roleId: 'SET_ME_NICHE_FILM_TV' },
    { value: 'celebs',  label: 'Celebs',    emoji: '⭐', roleId: 'SET_ME_NICHE_CELEBS' },
    { value: 'sports',  label: 'Sports',    emoji: '🏀', roleId: 'SET_ME_NICHE_SPORTS' },
  ],

  // ── Campaign automation ───────────────────────────────────────────────────
  CAMPAIGN_AUTOMATION: {
    // Create a role + private category + channels for every new campaign.
    ENABLED: true,

    // Channels created inside each campaign category.
    CHANNELS: ['announcements', 'rules-and-resources', 'general'],

    // What happens to the category when a campaign ends. 'archive' renames it
    // and makes it read-only, keeping the history. 'delete' removes it.
    // A server caps at 500 channels and 500 roles, and each campaign spends 4
    // channels and 1 role, so with 'archive' you should sweep old ones by hand
    // every few months.
    ON_END: 'archive',
    ARCHIVE_PREFIX: '🔒 ',

    // Delete the campaign role this many days after the campaign ends, which
    // frees the role slot. Set to 0 to keep roles forever.
    // Defaults to the payout clearing window so nobody loses access to the
    // channels while their money is still pending.
    DELETE_ROLE_AFTER_DAYS: 7,

    // Maximum size of a campaign asset (audio, example video) in megabytes.
    // Stored in MongoDB GridFS, not as a Discord CDN link, because Discord's
    // attachment URLs are signed and expire in roughly 24 hours. Anything
    // linked rather than stored would be a dead link by the next day.
    MAX_ASSET_MB: 25,
    MAX_ASSETS: 4,
  },

  // ── Tickets ───────────────────────────────────────────────────────────────
  // Buttons on the ticket panel, in order. `staffOnlyPing` marks the categories
  // worth pinging staff for immediately.
  TICKET_CATEGORIES: [
    { value: 'general',    label: 'General Question',  emoji: '❓',
      blurb: 'Anything the other buttons do not cover.' },
    { value: 'report',     label: 'Report a User',     emoji: '🚨', staffOnlyPing: true,
      blurb: 'Stolen edits, view botting, harassment. Include links.' },
    { value: 'payment',    label: 'Payment Issue',     emoji: '💰', staffOnlyPing: true,
      blurb: 'Missing payout, wrong amount, or changing your payment details.' },
    { value: 'submission', label: 'Submission Issue',  emoji: '🎬',
      blurb: 'An edit was rejected, or the submit button will not take your link.' },
    { value: 'business',   label: 'Business Enquiry',  emoji: '💼',
      blurb: 'Campaigns, sponsorships, and working with us.' },
  ],

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
    JUDGING_PLAIN: 'Highest view count. Most views wins.',
    BRIEF_PLAIN: 'Open brief, any style, any niche. High quality edits.',

    JUDGING: 'Highest view count',
    JUDGING_DETAIL: 'Highest view count on a single entry. Submit as many as you '
                  + 'like — your best one counts.',

    PLATFORMS: ['TikTok', 'Instagram Reels', 'YouTube Shorts'],

    BRIEF_SHORT: 'Open brief — any style, any niche. High quality edits.',
    BRIEF_FULL:
      '**Open brief.** Any style, any niche — anime, film, TV, sports, '
    + 'celeb, fancam, gaming, music, whatever you\'re best at.\n\n'
    + 'The only requirement is that it\'s a **high quality edit**. Show us what '
    + 'you can actually do.',

    CAPTION: 'Get paid for your edits, join Editable: discord.gg/editable @editable.group #editable1k',
    HASHTAG: '#editable1k',
    MENTION: '@editable.group',

    DROPDOWN_LABEL: '💲1000 EDIT COMPETITION',
    MAX_ENTRIES: 0, // 0 = unlimited
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
