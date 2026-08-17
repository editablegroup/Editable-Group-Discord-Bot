'use strict';

const config = require('./config');

/**
 * ============================================================================
 *  EVERY USER-FACING STRING IN THE BOT
 * ============================================================================
 *  Nothing outside this file writes text a member will read. If you want to
 *  change wording, change it here and nowhere else.
 *
 *  House rules (CLAUDE.md), enforced by review not by code:
 *    • Every line carries a fact, a number, a constraint or an instruction.
 *    • No em dashes. Commas, full stops or brackets.
 *    • Exact numbers and channel names. Never "soon" or "a lot".
 *    • Explain why a rule exists when the reason isn't obvious.
 *    • Emoji only as a line-leading label.
 *
 *  Numbers are interpolated from config so the copy can never drift from the
 *  behaviour. If you change CLEARING_DAYS, every message that mentions it
 *  updates with it.
 * ============================================================================
 */

/**
 * Render a channel reference. Resolves through ids.js so a channel the bot
 * created itself is linked properly, and falls back to a plain name when the
 * ID is not known yet. Without the fallback an unconfigured channel renders as
 * the literal text "<#SET_ME_PAYMENTS_CHANNEL_ID>" in a member's face.
 *
 * Required lazily: ids.js loads db.js, and copy.js is required at the top of
 * almost every module, so importing it eagerly would force a load order.
 */
const ch = (key, fallbackName) => {
  try {
    const id = require('./ids').channelId(key);
    if (id) return `<#${id}>`;
  } catch { /* ids not ready */ }
  return `#${fallbackName}`;
};
// Thousands separators matter here: "$1200.00" reads as a smaller number than
// "$1,200.00" at a glance, and these figures are the whole pitch of a campaign.
const money = n => `$${Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = n => Number(n).toLocaleString('en-US');

// Refresh interval in whole hours, used in a dozen strings.
const REFRESH_HOURS = Math.round(config.STATS.INTERVAL_MS / 3_600_000);

module.exports = {
  REFRESH_HOURS,

  // ── Onboarding ────────────────────────────────────────────────────────────
  onboarding: {
    panel: () =>
      'Onboarding takes about a minute and unlocks the rest of the server.\n' +
      'You need your TikTok profile link, the niches you edit, and a payment method.\n' +
      'Until you finish it you cannot see campaigns or submit edits.',

    startButton: 'Start',

    step1Title: 'Step 1 of 3: your TikTok',
    step1Label: 'Link to your TikTok profile',
    step1Placeholder: 'https://www.tiktok.com/@yourhandle',

    step2: () =>
      '✅ Linked **@%HANDLE%**\n\n' +
      '**Step 2 of 3: what do you edit?**\n' +
      'Pick every niche you actually post. This sets which campaigns ping you, ' +
      'so leaving one out means fewer pings, not fewer campaigns you can join.',
    step2Placeholder: 'Pick your niches',

    step3: (niches) =>
      `✅ Niches set: **${niches.join(', ')}**\n\n` +
      '**Step 3 of 3: how do you want to get paid?**',

    paypalModalTitle: 'PayPal details',
    paypalLabel: 'PayPal email address',

    bankChosen: () =>
      'Bank transfer selected. We ask for your account details by ticket at the point ' +
      'we actually pay you, so there is nothing to enter now.',

    complete: (niches) =>
      '✅ **You\'re in.**\n' +
      `Campaigns tagged ${niches.join(', ')} will ping you in ${ch('ACTIVE_CAMPAIGNS', 'active-campaigns')}.\n` +
      `Submit edits in ${ch('SUBMIT', 'submit')}. Views update every ${REFRESH_HOURS} hours.\n` +
      `Payment details live in ${ch('PAYMENTS', 'payments')} if you need to change them.`,

    alreadyDone: () =>
      `You have already onboarded. Campaigns are in ${ch('ACTIVE_CAMPAIGNS', 'active-campaigns')}.`,

    errBadHandle:
      'That is not a TikTok profile link. Open your profile in the TikTok app, ' +
      'tap Share, Copy link, and paste that. `@yourhandle` works too.',

    errDuplicateHandle: (handle) =>
      `**@${handle}** is already registered to another member. One TikTok account per person, ` +
      `because otherwise the same edit gets paid out twice.\n` +
      `If that account is yours, open a ticket in ${ch('TICKETS', 'open-a-ticket')}.`,

    errNoNiche: 'Pick at least one niche. You can change them later in a ticket.',

    errExpired:
      'Your onboarding expired after an hour of inactivity. Press Start again, ' +
      'nothing you entered was saved.',

    errRoleFailed: () =>
      'Your details saved but the Network role would not apply, which is a permissions ' +
      `problem on our end rather than anything you did. Open a ticket in ${ch('TICKETS', 'open-a-ticket')} ` +
      'and we will fix it by hand.',
  },

  // ── Submit panel (#submit) ────────────────────────────────────────────────
  submit: {
    panelTitle: '🎬 Submissions',
    panelIntro: () =>
      `Views update every ${REFRESH_HOURS} hours. Nothing earns until staff approve it.`,

    btnSubmit: 'Submit Edit',
    btnMine: 'My Submissions',
    btnBoard: 'Leaderboard',
    btnStatus: 'Campaign Status',

    fieldSubmit: 'Pick a campaign, paste your TikTok link.',
    fieldMine: 'Every edit you have sent, its status, and what it has earned.',
    fieldBoard: 'Top earners on any campaign you can see.',
    fieldStatus: 'Rate, pot left and deadline for everything open to you.',

    pickerPlaceholder: 'Choose a campaign',
    pickerPrompt: 'Which campaign is this edit for?',

    modalTitle: 'Submit your edit',
    modalLink: 'TikTok link',
    modalLinkPlaceholder: 'https://www.tiktok.com/@you/video/…',
    modalName: 'Name for this edit (optional)',

    nothingOpen: () =>
      `No campaign is open to you right now. New ones are posted in ` +
      `${ch('ACTIVE_CAMPAIGNS', 'active-campaigns')} and ping the niches you picked at onboarding.`,

    submitted: (name, url, handle, views) =>
      `✅ **Submitted:** [${name}](${url})\n` +
      `Posted by **@${handle}**, ${num(views)} views right now.\n` +
      `Staff review it by hand and you get a DM either way. ` +
      `After approval the view count updates every ${REFRESH_HOURS} hours.`,

    noSubmissions: () =>
      `No submissions yet. Pick a campaign in ${ch('ACTIVE_CAMPAIGNS', 'active-campaigns')}, post your edit, ` +
      `then submit the link here.`,

    mineTitle: 'Your submissions',
    mineTotalViews: 'Total views',
    mineTotalEarned: 'Total earned',
    mineFooter: (when) =>
      when
        ? `Views last updated ${when}. They refresh every ${REFRESH_HOURS} hours.`
        : `Views refresh every ${REFRESH_HOURS} hours.`,

    // Submission failures. Each says what broke and what to do next.
    errNotTikTok: 'That is not a TikTok link. Only TikTok posts count on this campaign.',
    errUnresolvable:
      'That link would not open. Use Share, Copy link in the TikTok app rather than ' +
      'copying it out of your browser bar.',
    errLookupFailed:
      'TikTok did not respond. Wait a minute and submit again. If it keeps failing, ' +
      'it is their API rather than your link.',
    errClosed: 'That campaign closed before this went through. Nothing was submitted.',
    errDuplicate: 'That video is already submitted to this campaign.',
    errCapReached: (cap) =>
      `You have hit the limit of ${cap} submissions on this campaign. ` +
      `Existing submissions keep earning, you just cannot add more.`,
    errBudgetGone:
      'This campaign\'s pot is fully committed, so submissions are closed. ' +
      'Approved edits already in keep earning until the deadline.',
    errTooOld: (ageDays, maxDays) =>
      `That video is ${ageDays} days old. Only edits posted in the last ${maxDays} days count, ` +
      `because campaigns pay for new work rather than back catalogue.`,
    errHandleMismatch: (videoHandle, registeredHandle) =>
      `That video was posted by **@${videoHandle}** but your account is registered as ` +
      `**@${registeredHandle}**. You can only submit edits from your own account.\n` +
      `Changed handle? Open a ticket in ${ch('TICKETS', 'open-a-ticket')}.`,
    errOwnershipUnknown:
      'Could not confirm who posted that video, which usually means TikTok is rate limiting us. ' +
      'Try again in a few minutes.',
    errNotOnboarded: () =>
      `Finish onboarding in ${ch('ONBOARDING', 'onboarding')} first.`,
  },

  // ── Payments panel (#payments) ────────────────────────────────────────────
  payments: {
    panelTitle: '💳 Payments',
    panelIntro: () =>
      `Minimum payout is ${money(config.PAYOUTS.MINIMUM_USD)}. Earnings clear ` +
      `${config.PAYOUTS.CLEARING_DAYS} days after a campaign ends, which is the window we use ` +
      `to catch view botting before money moves.`,

    btnManage: 'Manage Payment Methods',
    btnBalance: 'Check Balance',

    fieldManage: 'Switch between PayPal and bank transfer, or change your PayPal address.',
    fieldBalance: 'Pending, cleared, and what you have been paid.',

    manageTitle: 'Your payment method',
    manageCurrent: (method, destination) => {
      if (method === 'paypal') return `PayPal, paying out to **${destination}**.`;
      if (method === 'bank') return 'Bank transfer. We ask for account details by ticket at payout time.';
      return 'Not set. Pick one below or payouts cannot be sent.';
    },
    manageChanged: (method, destination) =>
      method === 'paypal'
        ? `✅ Payouts now go to PayPal at **${destination}**.`
        : '✅ Payouts now go by bank transfer. We will ask for account details when you first cash out.',

    balanceTitle: 'Your balance',
    balAvailable: '💵 Available',
    balPending: '⏳ Pending',
    balPaid: '✅ Paid out',
    balanceFooter: () =>
      `Pending clears ${config.PAYOUTS.CLEARING_DAYS} days after a campaign ends. ` +
      `Minimum payout ${money(config.PAYOUTS.MINIMUM_USD)}.`,
    balanceShortfall: (short) =>
      `${money(short)} more clears before you can request a payout.`,

    btnPayout: 'Request Payout',
    payoutOpen: 'You already have a payout request open. Staff process them in batches.',
    payoutTooSmall: (cleared) =>
      `Minimum payout is ${money(config.PAYOUTS.MINIMUM_USD)} and you have ${money(cleared)} cleared. ` +
      `Pending earnings are not included until they clear.`,
    payoutNoMethod: () =>
      `Set a payment method first, otherwise there is nowhere to send it. ` +
      `Use Manage Payment Methods in ${ch('PAYMENTS', 'payments')}.`,
    payoutRequested: (amount) =>
      `✅ Requested **${money(amount)}**. Payouts go out in batches and you get a DM when yours is sent.`,
  },

  // ── Campaign posts ────────────────────────────────────────────────────────
  campaign: {
    // Screenshot 3 leads with the money. So does this, without the hype.
    postTitle: (c) =>
      `${money(c.rpm)} per 1,000 views. Max ${money(c.maxPayout)} per video. ${c.label}`,

    fRate: '💰 Rate',
    fPot: '🪙 Pot',
    fMinViews: '📉 Minimum views to earn',
    fMaxPayout: '📈 Max pay-out per video',
    fEnds: '📅 End date',
    fPayment: '💵 Payment method',
    fPlatform: '📱 Platform',
    fBrief: '📝 Brief',
    fAccess: '🎯 Access',

    vRate: (rpm) => `${money(rpm)} per 1,000 views`,
    vPot: (budget, remaining) =>
      `${money(budget)} total, ${money(remaining)} left`,
    vMaxPayout: (maxPayout, rpm) =>
      `${money(maxPayout)} (${num(Math.round((maxPayout / rpm) * 1000))} views)`,
    vEnds: (unix) => `<t:${unix}:F>, or when the pot empties, whichever comes first`,
    vPayment: 'PayPal or bank transfer',
    vAccessCore: 'Core members only',
    vAccessNetwork: 'Every Network editor',
    vBriefMissing: 'Brief to follow before this campaign opens.',

    btnJoin: 'Join',
    btnLeave: 'Leave',
    btnStatus: 'Status',

    joined: (c, categoryName, endsUnix) =>
      `✅ **You're in: ${c.label}**\n` +
      `${money(c.rpm)} per 1,000 views, minimum ${num(c.minViews)} views before anything pays, ` +
      `capped at ${money(c.maxPayout)} per video.\n` +
      (categoryName ? `The **${categoryName}** category is now visible with the brief and assets.\n` : '') +
      `Post your edit, then submit the link in ${ch('SUBMIT', 'submit')}. ` +
      `Closes <t:${endsUnix}:R>.`,

    alreadyJoined: 'You are already in this campaign.',
    left: (label) =>
      `You have left **${label}**. Submissions you already made keep their status and earnings. ` +
      `Rejoin any time from the campaign post.`,
    notJoined: 'You are not in this campaign, so there is nothing to leave.',
    closed: 'This campaign is closed.',
    notFound: 'That campaign no longer exists.',
    denyCore: () =>
      `This is a **Core** campaign. Core is granted by hand once you pass ` +
      `${config.CORE_NOMINATION.MIN_APPROVED_SUBS} approved submissions, ` +
      `${num(config.CORE_NOMINATION.MIN_AVG_VIEWS)} average views, ` +
      `${num(config.CORE_NOMINATION.MIN_TOTAL_VIEWS)} total views, and a rejection rate under ` +
      `${Math.round(config.CORE_NOMINATION.MAX_REJECTION_RATE * 100)}%. ` +
      `Open campaigns are how you get there.`,

    statusTitle: '📈 Campaigns open to you',
    statusNone: () =>
      `Nothing is open to you right now. New campaigns post in ` +
      `${ch('ACTIVE_CAMPAIGNS', 'active-campaigns')}.`,
  },

  // ── Leaderboards ──────────────────────────────────────────────────────────
  leaderboard: {
    allTimeTitle: 'All Time Leaderboard',
    allTimeFooter: (when) => `Updated ${when}. Recalculated every time a campaign ends.`,
    allTimeEmpty: 'No approved submissions yet.',

    campaignTitle: (label) => `🏆 ${label}`,
    campaignEmpty: 'No approved submissions yet.',
    campaignFooter: (editors, when) =>
      `${editors} editor${editors === 1 ? '' : 's'}. Updated ${when}.`,

    yourPosition: 'Your position',
    yourPositionValue: (rank, views, earned) =>
      `**#${rank}**, ${num(views)} views, ${money(earned)} earned`,
    yourPositionUnranked: 'Not ranked. Get one edit approved and you appear here.',

    pickPrompt: 'Which campaign?',
    pickPlaceholder: 'Choose a campaign',
  },

  // ── Tickets ───────────────────────────────────────────────────────────────
  tickets: {
    panelTitle: '🎫 Open a ticket',
    panelIntro: 'Staff reply in the ticket channel, never by DM. One open ticket at a time.',

    created: (channelId) => `✅ Ticket open: ${ch(channelId)}`,
    alreadyOpen: (channelId) => `You already have a ticket open: ${ch(channelId)}`,
    openedHeader: (categoryLabel) =>
      `**${categoryLabel}**\nDescribe the problem in as much detail as you can. ` +
      `Links and screenshots get it solved faster. Use \`/close\` when you are done.`,
    createFailed:
      'Could not create the ticket channel. The bot is missing Manage Channels, ' +
      'which is on us to fix. Ping a staff member directly.',
    closingIn: 'Closing this ticket in 5 seconds.',
    notATicket: 'This is not a ticket channel.',
    notYourTicket: 'Only the person who opened this ticket, or staff, can close it.',
  },

  // ── Shared / errors ───────────────────────────────────────────────────────
  common: {
    denyStaff: 'That is an admin command.',
    denyOnboard: () => `Finish onboarding in ${ch('ONBOARDING', 'onboarding')} first.`,
    cooldown: (seconds) => `Too fast. Try again in ${seconds}s.`,

    // Generic catch-all handlers genuinely do not know what broke, so these say
    // where it broke instead. A screenshot then tells staff which module to check.
    errIn: (area) =>
      `Something failed in ${area}. Try once more, then open a ticket in ` +
      `${ch('TICKETS', 'open-a-ticket')} if it happens again.`,
  },
};
