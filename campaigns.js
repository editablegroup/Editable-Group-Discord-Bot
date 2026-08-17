'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require('discord.js');
const { ObjectId } = require('mongodb');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const tiktok = require('./tiktok');
const perms = require('./permissions');
const assets = require('./assets');
const logging = require('./logging');

/**
 * ============================================================================
 *  CAMPAIGNS
 * ============================================================================
 *  Campaigns now live in MongoDB rather than a hardcoded array, so you can
 *  create one from Discord at 2am without a redeploy. Your three existing
 *  campaigns are auto-seeded on first boot (see db.js).
 *
 *  Tiering:
 *    tier: 'core'    → only Core members can see, join and submit
 *    tier: 'network' → Network and above
 *    tier: 'all'     → same as network, kept for clarity in briefs
 * ============================================================================
 */

const STATUS = { DRAFT: 'draft', ACTIVE: 'active', ENDED: 'ended', PAUSED: 'paused' };

// ── Data access ─────────────────────────────────────────────────────────────

async function getCampaign(value) {
  return getDb().collection('campaigns').findOne({ value });
}

async function listCampaigns(filter = {}) {
  return getDb().collection('campaigns').find(filter).sort({ createdAt: -1 }).toArray();
}

/** Campaigns a given member is allowed to see. */
async function visibleCampaigns(member, { activeOnly = true } = {}) {
  const filter = activeOnly ? { status: STATUS.ACTIVE } : {};
  const all = await listCampaigns(filter);
  return all.filter(c => perms.canAccessCampaign(member, c));
}

function isLive(campaign) {
  return campaign.status === STATUS.ACTIVE && new Date() < new Date(campaign.endDate);
}

// ── Money ───────────────────────────────────────────────────────────────────

function calculateEarnings(views, campaign) {
  if (views < (campaign.minViews || 0)) return 0;
  const gross = (views / 1000) * campaign.rpm;
  return Math.min(gross, campaign.maxPayout || Infinity);
}

/**
 * Live budget check.
 *
 * This is the failure mode that costs real money: your current bot tracks
 * budget nowhere in the submission path. If 300 Network editors each land
 * 200k views on a $1,000 campaign at $1 RPM, you owe $60,000 against a $1,000
 * budget. Nothing in the current code stops that.
 *
 * Now: every campaign has a committed-spend figure, and the campaign
 * auto-pauses when projected liability reaches the budget.
 */
async function getCommittedSpend(campaignValue) {
  const [agg] = await getDb().collection('submissions').aggregate([
    { $match: { campaignValue, status: 'approved' } },
    { $group: { _id: null, total: { $sum: '$earnings' } } },
  ]).toArray();
  const deductions = await getDb().collection('deductions')
    .aggregate([{ $match: { campaignValue } }, { $group: { _id: null, t: { $sum: '$amount' } } }])
    .toArray();
  return (agg?.total || 0) + (deductions[0]?.t || 0);
}

async function budgetStatus(campaign) {
  // Competitions have no RPM budget — prizes are fixed and paid manually.
  if (campaign.type === 'competition' || campaign.hideBudget) {
    return { spent: 0, remaining: Infinity, percentUsed: 0, exhausted: false };
  }
  const spent = await getCommittedSpend(campaign.value);
  const remaining = Math.max(0, campaign.budget - spent);
  return {
    spent,
    remaining,
    percentUsed: campaign.budget ? Math.min(100, (spent / campaign.budget) * 100) : 0,
    exhausted: remaining <= 0,
  };
}

async function autoPauseIfExhausted(campaign, client) {
  const status = await budgetStatus(campaign);
  if (!status.exhausted || campaign.status !== STATUS.ACTIVE) return status;

  await getDb().collection('campaigns').updateOne(
    { value: campaign.value },
    { $set: { status: STATUS.PAUSED, pausedReason: 'budget_exhausted', pausedAt: new Date() } }
  );
  await alert(client,
    `🛑 **Budget exhausted — campaign auto-paused**\n` +
    `**${campaign.label}** hit its $${campaign.budget} budget. Submissions are closed. ` +
    `Raise the budget with \`/campaign edit\` to reopen.`);
  return status;
}

async function alert(client, content) {
  const target = ids.channelId('ALERTS') || ids.channelId('LOG:SYSTEM') || ids.channelId('LOGS');
  if (!target) return console.warn('[alert] No alert channel configured:', content);
  try {
    const ch = await client.channels.fetch(target);
    await ch.send(content);
  } catch (err) { console.error('[alert]', err.message); }
}

// ── Campaign offer post ─────────────────────────────────────────────────────

/**
 * The campaign post. Leads with the money, the way the reference posts do,
 * then lists every number an editor needs before deciding to join.
 *
 * Note "Max pay-out per video", not per editor. calculateEarnings() caps each
 * submission independently, so an editor with four good edits can earn four
 * times this figure. The old label said "per editor" and was simply wrong.
 */
function buildOfferEmbed(campaign, budget) {
  const isCore = campaign.tier === 'core';
  const endsUnix = Math.floor(new Date(campaign.endDate).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(isCore ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(copy.campaign.postTitle(campaign).slice(0, 256))
    .addFields(
      { name: copy.campaign.fRate, value: copy.campaign.vRate(campaign.rpm), inline: true },
      { name: copy.campaign.fMinViews, value: campaign.minViews.toLocaleString('en-US'), inline: true },
      { name: copy.campaign.fMaxPayout,
        value: copy.campaign.vMaxPayout(campaign.maxPayout, campaign.rpm), inline: true },
      { name: copy.campaign.fEnds, value: copy.campaign.vEnds(endsUnix), inline: false },
      { name: copy.campaign.fPayment, value: copy.campaign.vPayment, inline: true },
      { name: copy.campaign.fPlatform, value: campaign.platform || 'TikTok', inline: true },
      { name: copy.campaign.fAccess,
        value: isCore ? copy.campaign.vAccessCore : copy.campaign.vAccessNetwork, inline: true },
    )
    .setTimestamp();

  // Pot in dollars rather than a progress bar. An editor deciding whether to
  // spend three hours on an edit needs to know there is $180 left, not "40%".
  if (!campaign.hideBudget && budget && Number.isFinite(budget.remaining)) {
    embed.addFields({
      name: copy.campaign.fPot,
      value: copy.campaign.vPot(campaign.budget, budget.remaining),
      inline: false,
    });
  }

  embed.addFields({
    name: copy.campaign.fBrief,
    value: (campaign.brief || copy.campaign.vBriefMissing).slice(0, 1024),
    inline: false,
  });

  if (campaign.bonus1st && !campaign.hidePlacements) {
    embed.addFields({
      name: '🥇 Placement bonuses',
      value: `1st: **$${campaign.bonus1st}**` +
             (campaign.bonus2nd ? `, 2nd: **$${campaign.bonus2nd}**` : ''),
      inline: false,
    });
  }

  return embed;
}

function buildOfferButtons(campaign) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`camp:join:${campaign.value}`)
      .setLabel(copy.campaign.btnJoin).setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`camp:leave:${campaign.value}`)
      .setLabel(copy.campaign.btnLeave).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`camp:board:${campaign.value}`)
      .setLabel(copy.campaign.btnStatus).setEmoji('📈').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Who gets pinged. Niche roles by default, because a Sports editor does not
 * need a notification about a K-drama campaign, and pinging everyone for every
 * campaign is how a server trains people to mute it.
 *
 * campaign.pingEveryone is an explicit per-campaign opt-in for the ones that
 * genuinely warrant it.
 */
function buildPingLine(campaign, guildId) {
  if (campaign.pingEveryone) return '@everyone';

  const niches = (campaign.niches || [])
    .map(v => ids.nicheRoleId(v))
    .filter(Boolean)
    .map(id => `<@&${id}>`);

  if (niches.length) return niches.join(' ');

  const fallback = campaign.tier === 'core' ? ids.roleId('CORE') : ids.roleId('NETWORK');
  return fallback ? `<@&${fallback}>` : '';
}

async function postOffer(client, campaign) {
  const budget = await budgetStatus(campaign);
  const channelId = campaign.offerChannelId
    || (campaign.tier === 'core' ? ids.channelId('CORE_CAMPAIGNS') : ids.channelId('ACTIVE_CAMPAIGNS'));

  if (!channelId) {
    throw new Error(
      campaign.tier === 'core'
        ? 'No Core campaigns channel is set. Run /setup, or fill in CHANNELS.CORE_CAMPAIGNS.'
        : 'No active campaigns channel is set. Run /setup, or fill in CHANNELS.ACTIVE_CAMPAIGNS.');
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);

  // A category cannot be posted into. This is an easy ID to get wrong, because
  // "ACTIVE_CAMPAIGNS" is the name of a category in the sidebar as well as the
  // channel campaigns are announced in, and the failure without this check is
  // an unhelpful "channel.send is not a function" halfway through posting.
  if (!channel || typeof channel.send !== 'function') {
    throw new Error(
      `The ${campaign.tier === 'core' ? 'Core campaigns' : 'active campaigns'} setting points at ` +
      `something that cannot be posted into, usually a category rather than a text channel. ` +
      `Set it with \`/channels set\` and post again.`);
  }

  // Assets are re-uploaded from MongoDB every time. Discord's own attachment
  // URLs expire in roughly a day, so anything stored as a link would be dead
  // by the time most people read the post.
  const files = await assets.load(campaign.assets || []);

  const msg = await channel.send({
    content: buildPingLine(campaign, channel.guildId),
    embeds: [buildOfferEmbed(campaign, budget)],
    components: [buildOfferButtons(campaign)],
    files,
  });

  await getDb().collection('campaigns').updateOne(
    { value: campaign.value },
    { $set: { offerMessageId: msg.id, offerChannelId: channelId, postedAt: new Date() } }
  );
  return msg;
}

// ── Join ────────────────────────────────────────────────────────────────────

async function handleJoin(interaction, campaignValue) {
  if (!await perms.enforceCooldown(interaction, 'join', config.COOLDOWNS.BUTTON_MS)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const campaign = await getCampaign(campaignValue);
  if (!campaign) return perms.safeReply(interaction, copy.campaign.notFound);

  if (!perms.canAccessCampaign(interaction.member, campaign)) {
    return perms.safeReply(interaction, copy.campaign.denyCore());
  }
  if (!isLive(campaign)) {
    return perms.safeReply(interaction, copy.campaign.closed);
  }

  // The role is what unlocks the campaign's private category, so granting it is
  // the join. Everything else here is bookkeeping.
  if (campaign.roleId) {
    if (interaction.member.roles.cache.has(campaign.roleId)) {
      return perms.safeReply(interaction, copy.campaign.alreadyJoined);
    }
    try {
      await interaction.member.roles.add(campaign.roleId, `Joined ${campaign.value}`);
    } catch (err) {
      console.error('[Campaigns] join role:', err.message);
      return perms.safeReply(interaction,
        'Could not give you the campaign role, so the campaign channels stay locked. ' +
        'That is a bot permissions problem on our end. Open a ticket and we will fix it.');
    }
  }

  await getDb().collection('campaigns').updateOne(
    { value: campaignValue }, { $inc: { participants: 1 } }
  );

  const endsUnix = Math.floor(new Date(campaign.endDate).getTime() / 1000);
  return perms.safeReply(interaction,
    copy.campaign.joined(campaign, campaign.space?.categoryName, endsUnix));
}

async function handleLeave(interaction, campaignValue) {
  if (!await perms.enforceCooldown(interaction, 'leave', config.COOLDOWNS.BUTTON_MS)) return;

  const campaign = await getCampaign(campaignValue);
  if (!campaign) return perms.safeReply(interaction, copy.campaign.notFound);

  if (!campaign.roleId || !interaction.member.roles.cache.has(campaign.roleId)) {
    return perms.safeReply(interaction, copy.campaign.notJoined);
  }

  await interaction.member.roles.remove(campaign.roleId, `Left ${campaign.value}`)
    .catch(() => {});
  await getDb().collection('campaigns').updateOne(
    { value: campaignValue }, { $inc: { participants: -1 } }
  );

  // Submissions are never touched. Leaving hides the channels, it does not
  // withdraw work already approved, and saying so stops the support ticket.
  return perms.safeReply(interaction, copy.campaign.left(campaign.label));
}

// ── Submission ──────────────────────────────────────────────────────────────

async function handleSubmitButton(interaction, campaignValue) {
  if (!await perms.enforceCooldown(interaction, 'submit', config.COOLDOWNS.SUBMIT_MS)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const campaign = await getCampaign(campaignValue);
  if (!campaign) return perms.safeReply(interaction, '❌ Campaign not found.');
  if (!perms.canAccessCampaign(interaction.member, campaign)) {
    return perms.safeReply(interaction, perms.DENY.core);
  }
  if (!isLive(campaign)) return perms.safeReply(interaction, '⌛ This campaign is closed.');

  const modal = new ModalBuilder()
    .setCustomId(`camp:submitmodal:${campaignValue}`)
    .setTitle('Submit your edit')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('link').setLabel('TikTok link')
          .setPlaceholder('https://www.tiktok.com/@you/video/…')
          .setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Edit name (optional)')
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
      ),
    );
  await interaction.showModal(modal);
}

async function handleSubmitModal(interaction, campaignValue) {
  await perms.safeDefer(interaction, true);

  const link = interaction.fields.getTextInputValue('link').trim();
  const clipName = (interaction.fields.getTextInputValue('name') || '').trim() || 'Untitled';

  const campaign = await getCampaign(campaignValue);
  if (!campaign || !isLive(campaign)) {
    return perms.safeReply(interaction, copy.submit.errClosed);
  }

  // Budget gate — refuse rather than accrue liability you can't pay.
  const budget = await autoPauseIfExhausted(campaign, interaction.client);
  if (budget.exhausted) {
    return perms.safeReply(interaction, copy.submit.errBudgetGone);
  }

  const editor = await getDb().collection('editors').findOne({ userId: interaction.user.id });
  if (!editor) return perms.safeReply(interaction, copy.submit.errNotOnboarded());

  // Per-campaign submission cap.
  const existingCount = await getDb().collection('submissions').countDocuments({
    userId: interaction.user.id, campaignValue, status: { $ne: 'rejected' },
  });
  if (existingCount >= config.INTEGRITY.MAX_SUBS_PER_CAMPAIGN) {
    return perms.safeReply(interaction,
      copy.submit.errCapReached(config.INTEGRITY.MAX_SUBS_PER_CAMPAIGN));
  }

  // Resolve the video.
  const details = await tiktok.getVideoDetails(link);
  if (!details.ok) {
    const messages = {
      not_tiktok: copy.submit.errNotTikTok,
      unresolvable: copy.submit.errUnresolvable,
      lookup_failed: copy.submit.errLookupFailed,
    };
    return perms.safeReply(interaction, messages[details.reason] || copy.submit.errLookupFailed);
  }

  // Ownership check.
  const ownership = tiktok.verifyOwnership(details.handle, editor.tiktokHandle);
  if (!ownership.ok) {
    if (ownership.reason === 'handle_mismatch') {
      console.warn(`[FRAUD] ${interaction.user.tag} submitted @${ownership.videoHandle} `
        + `but is registered as @${ownership.registeredHandle}`);
      await alert(interaction.client,
        `⚠️ **Ownership mismatch**. <@${interaction.user.id}> tried to submit a video by ` +
        `**@${ownership.videoHandle}** but is registered as **@${ownership.registeredHandle}**.\n${details.url}`);
      return perms.safeReply(interaction,
        copy.submit.errHandleMismatch(ownership.videoHandle, ownership.registeredHandle));
    }
    return perms.safeReply(interaction, copy.submit.errOwnershipUnknown);
  }

  // Age check — stops old viral posts being farmed into new campaigns.
  if (details.createTime) {
    const ageHours = (Date.now() - details.createTime * 1000) / 3_600_000;
    if (ageHours > config.INTEGRITY.MAX_VIDEO_AGE_HOURS) {
      return perms.safeReply(interaction, copy.submit.errTooOld(
        Math.round(ageHours / 24),
        Math.round(config.INTEGRITY.MAX_VIDEO_AGE_HOURS / 24)));
    }
  }

  const suspicious = details.views >= config.INTEGRITY.SUSPICIOUS_INITIAL_VIEWS;

  // Insert. The unique index on (campaignValue, videoId) is what actually
  // enforces no-duplicates — the check-then-insert pattern races under load.
  let inserted;
  try {
    inserted = await getDb().collection('submissions').insertOne({
      userId: interaction.user.id,
      username: interaction.user.username,
      campaignValue,
      campaignLabel: campaign.label,
      clipName,
      link: details.url,
      videoId: details.videoId,
      tiktokHandle: details.handle,
      thumbnailUrl: details.thumbnailUrl,
      caption: details.caption,
      status: suspicious ? 'flagged' : 'pending',
      views: details.views,
      likes: details.likes,
      viewsAtSubmission: details.views,
      earnings: 0,
      postedAt: details.createTime ? new Date(details.createTime * 1000) : null,
      submittedAt: new Date(),
      lastUpdated: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) {
      return perms.safeReply(interaction, copy.submit.errDuplicate);
    }
    throw err;
  }

  // Review card.
  const subId = inserted.insertedId.toString();
  const reviewEmbed = new EmbedBuilder()
    .setColor(suspicious ? 0xf5b800 : 0x2b2d31)
    .setTitle(suspicious ? '⚠️ Flagged submission, review carefully' : '📩 New submission')
    .setDescription(`**${campaign.label}**\n[${clipName}](${details.url})`)
    .addFields(
      { name: 'Editor', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Handle', value: `@${details.handle}`, inline: true },
      { name: 'Views at submit', value: details.views.toLocaleString('en-US'), inline: true },
      { name: 'Tier', value: campaign.tier === 'core' ? '⭐ Core' : '🔓 Network', inline: true },
      { name: 'Posted', value: details.createTime ? `<t:${details.createTime}:R>` : 'Unknown', inline: true },
      { name: 'Prior subs', value: String(existingCount), inline: true },
    )
    .setTimestamp();
  if (details.thumbnailUrl) reviewEmbed.setThumbnail(details.thumbnailUrl);
  if (suspicious) {
    reviewEmbed.addFields({
      name: '⚠️ Why flagged',
      value: `Already at ${details.views.toLocaleString('en-US')} views at submission. Verify it was made for this campaign.`,
    });
  }

  const reviewChannelId = ids.channelId('SUBMISSIONS');
  if (reviewChannelId) {
    const reviewChannel = await interaction.client.channels.fetch(reviewChannelId);
    await reviewChannel.send({
      embeds: [reviewEmbed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`camp:approve:${subId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`camp:reject:${subId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
      )],
    });
  }

  logging.submitted({
    userId: interaction.user.id,
    clipName,
    link: details.url,
    tiktokHandle: details.handle,
    views: details.views,
    status: suspicious ? 'flagged' : 'pending',
  }, campaign);

  return perms.safeReply(interaction,
    copy.submit.submitted(clipName, details.url, details.handle, details.views));
}

// ── Review (STAFF ONLY — this was completely unguarded before) ──────────────

async function handleReview(interaction, action, subId) {
  // THE critical fix. Without this line, any member who can read #submissions
  // can approve their own edits and make themselves eligible for payout.
  if (!await perms.requireStaff(interaction)) return;

  await interaction.deferUpdate().catch(() => {});

  let sub;
  try {
    sub = await getDb().collection('submissions').findOne({ _id: new ObjectId(subId) });
  } catch { return; }
  if (!sub) return;
  if (sub.status === 'approved' || sub.status === 'rejected') {
    return interaction.followUp({
      content: `Already ${sub.status}. Nothing changed.`, flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const approved = action === 'approve';
  const campaign = await getCampaign(sub.campaignValue);
  const earnings = approved && campaign ? calculateEarnings(sub.views, campaign) : 0;

  await getDb().collection('submissions').updateOne(
    { _id: sub._id },
    {
      $set: {
        status: approved ? 'approved' : 'rejected',
        earnings,
        reviewedBy: interaction.user.id,
        reviewedAt: new Date(),
      },
    }
  );

  // Append-only ledger entry — the idea worth stealing from the PayPerClip
  // pitch. Earnings as a field on a submission can only ever hold "now".
  // A ledger holds history, which is what you need when an editor disputes a
  // payout three weeks later, or when you need to reconcile a campaign.
  if (approved && earnings > 0) {
    await getDb().collection('earnings').insertOne({
      userId: sub.userId,
      campaignValue: sub.campaignValue,
      submissionId: sub._id,
      amount: earnings,
      state: 'pending',
      createdAt: new Date(),
    });
  }

  // Update the review card in place.
  const original = interaction.message.embeds[0];
  const updated = EmbedBuilder.from(original)
    .setColor(approved ? 0x57f287 : 0xed4245)
    .setTitle(approved ? '✅ Approved' : '❌ Rejected')
    .addFields({ name: 'Reviewed by', value: `<@${interaction.user.id}>`, inline: true });
  await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => {});

  // Notify the editor.
  try {
    const user = await interaction.client.users.fetch(sub.userId);
    const ticketsId = ids.channelId('TICKETS');
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(approved ? 0x57f287 : 0xed4245)
        .setTitle(approved ? 'Edit approved' : 'Edit rejected')
        .setDescription(approved
          ? `**${sub.campaignLabel}**\nIt earns from now on. Views and earnings update every ` +
            `${copy.REFRESH_HOURS} hours.`
          : `**${sub.campaignLabel}**\nNothing is deducted, it simply will not earn. ` +
            (ticketsId ? `Ask why in <#${ticketsId}>.` : 'Open a ticket to ask why.'))
        .addFields({ name: 'Edit', value: `[${sub.clipName}](${sub.link})` })
        .setTimestamp()],
    });
  } catch { /* DMs closed */ }

  logging.reviewed(sub, approved, interaction.user.id, earnings);

  if (approved) {
    await handleReferralFirstPost(interaction.client, sub);
    if (campaign) await autoPauseIfExhausted(campaign, interaction.client);
  }
}

// ── Referrals ───────────────────────────────────────────────────────────────

async function handleReferralFirstPost(client, sub) {
  try {
    const prior = await getDb().collection('submissions').countDocuments({
      userId: sub.userId, status: 'approved', _id: { $ne: sub._id },
    });
    if (prior !== 0) return;

    const referral = await getDb().collection('referrals').findOne({
      inviteeId: sub.userId, firstPostBonusPaid: false,
    });
    if (!referral) return;

    await getDb().collection('referrals').updateOne(
      { _id: referral._id },
      { $set: { firstPostBonusPaid: true, firstPostBonusAt: new Date() } }
    );
    await getDb().collection('earnings').insertOne({
      userId: referral.inviterId,
      campaignValue: 'referral',
      amount: config.REFERRALS.FIRST_POST_BONUS,
      state: 'pending',
      note: `Referral: ${sub.username} first approved post`,
      createdAt: new Date(),
    });
    await alert(client,
      `🔗 **Referral bonus** — <@${referral.inviterId}> earns $${config.REFERRALS.FIRST_POST_BONUS} ` +
      `(referred <@${sub.userId}>, first approved post).`);
  } catch (err) {
    console.error('[Referrals] first post:', err.message);
  }
}

// ── Leaderboard (precomputed) ───────────────────────────────────────────────

/**
 * Your current /leaderboard scans every submission and sorts in Node on every
 * single call. With 2,000 editors and a popular campaign, that's a full
 * collection scan per button press — and the leaderboard button is the most
 * pressed button you have.
 *
 * This computes once per stats run and stores the result. Reads become a
 * single indexed document fetch.
 */
async function rebuildLeaderboard(campaignValue) {
  const rows = await getDb().collection('submissions').aggregate([
    { $match: { campaignValue, status: 'approved' } },
    {
      $group: {
        _id: '$userId',
        username: { $first: '$username' },
        views: { $sum: '$views' },
        likes: { $sum: '$likes' },
        posts: { $sum: 1 },
        earnings: { $sum: '$earnings' },
      },
    },
    // Ranked by money, not views. Two editors on the same campaign with the
    // same views earn the same, but once a per-video cap bites, the editor with
    // three capped videos has earned more than the one with a single huge one.
    // Money is the number they are competing over.
    { $sort: { earnings: -1, views: -1 } },
    { $limit: 100 },
  ]).toArray();

  await getDb().collection('leaderboards').updateOne(
    { campaignValue },
    { $set: { campaignValue, rows, updatedAt: new Date() } },
    { upsert: true }
  );
  return rows;
}

async function buildLeaderboardEmbed(campaignValue, viewerId = null) {
  const campaign = await getCampaign(campaignValue);
  if (!campaign) return null;

  let board = await getDb().collection('leaderboards').findOne({ campaignValue });
  if (!board) board = { rows: await rebuildLeaderboard(campaignValue), updatedAt: new Date() };
  const rows = board.rows || [];

  const medal = campaign.hidePlacements
    ? () => '•'
    : i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2, ' ')}\``;
  const top = rows.slice(0, 15).map((r, i) =>
    `${medal(i)} **${r.username}** $${(r.earnings || 0).toFixed(2)} ` +
    `(${r.views.toLocaleString('en-US')} views)`
  ).join('\n') || copy.leaderboard.campaignEmpty;

  const embed = new EmbedBuilder()
    .setColor(campaign.tier === 'core' ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(copy.leaderboard.campaignTitle(campaign.label))
    .setDescription(top)
    .setFooter({ text: copy.leaderboard.campaignFooter(
      rows.length, new Date(board.updatedAt).toUTCString()) })
    .setTimestamp(board.updatedAt);

  if (viewerId) {
    const idx = rows.findIndex(r => r._id === viewerId);
    if (idx >= 0) {
      embed.addFields({
        name: copy.leaderboard.yourPosition,
        value: campaign.hidePlacements
          ? `${rows[idx].posts} entries, ${rows[idx].views.toLocaleString('en-US')} views`
          : copy.leaderboard.yourPositionValue(
              idx + 1, rows[idx].views, rows[idx].earnings || 0),
      });
    } else {
      embed.addFields({
        name: copy.leaderboard.yourPosition,
        value: copy.leaderboard.yourPositionUnranked,
      });
    }
  }
  return embed;
}

// ── Stats engine ────────────────────────────────────────────────────────────

/**
 * Refresh views for approved submissions.
 *
 * Rewritten for scale. The old version was a sequential for-loop with two
 * network calls per submission and no ceiling: at 5,000 submissions that's
 * 10,000 serial requests, which will not finish inside the 12-hour window,
 * let alone leave the event loop free to answer interactions.
 *
 * Now: bounded concurrency, a hard per-run ceiling, skips ended campaigns
 * whose numbers are already final, and rebuilds leaderboards at the end.
 */
async function updateAllStats(client, { force = false } = {}) {
  const last = await getMeta('lastStatsRun');
  if (!force && last && Date.now() - new Date(last).getTime() < config.STATS.INTERVAL_MS) {
    console.log('[Stats] Skipped — ran recently');
    return { skipped: true };
  }
  await setMeta('lastStatsRun', new Date());
  tiktok.resetUsage();

  const campaigns = await listCampaigns();
  const byValue = new Map(campaigns.map(c => [c.value, c]));

  // Only chase submissions that can still change.
  const liveValues = campaigns
    .filter(c => c.status !== STATUS.ENDED || new Date() < new Date(c.endDate))
    .map(c => c.value);

  const subs = await getDb().collection('submissions')
    .find({ status: 'approved', campaignValue: { $in: liveValues } })
    .sort({ lastUpdated: 1 })
    .limit(config.STATS.MAX_LOOKUPS_PER_RUN)
    .toArray();

  console.log(`[Stats] Refreshing ${subs.length} submissions`);
  let updated = 0, failed = 0;

  const queue = [...subs];
  const worker = async () => {
    while (queue.length) {
      const sub = queue.shift();
      if (!sub) break;
      try {
        const stats = await tiktok.getVideoStats(sub.link, sub.videoId);
        if (!stats) { failed++; continue; }

        const campaign = byValue.get(sub.campaignValue);
        const earnings = campaign ? calculateEarnings(stats.views, campaign) : sub.earnings;

        await getDb().collection('submissions').updateOne(
          { _id: sub._id },
          { $set: { views: stats.views, likes: stats.likes, earnings, lastUpdated: new Date() } }
        );

        if (earnings !== sub.earnings) {
          await getDb().collection('earnings').updateOne(
            { submissionId: sub._id },
            { $set: { amount: earnings, updatedAt: new Date() } }
          );
        }
        await checkMilestone(client, sub, stats.views, campaign);
        updated++;
      } catch (err) {
        failed++;
        console.error('[Stats] sub error:', err.message);
      }
      await new Promise(r => setTimeout(r, config.STATS.DELAY_BETWEEN_MS));
    }
  };

  await Promise.all(Array.from({ length: config.STATS.CONCURRENCY }, worker));

  for (const value of liveValues) await rebuildLeaderboard(value).catch(() => {});
  for (const c of campaigns.filter(x => x.status === STATUS.ACTIVE)) {
    await autoPauseIfExhausted(c, client).catch(() => {});
  }

  const usage = tiktok.getUsage();
  console.log(`[Stats] Done. ${updated} updated, ${failed} failed. API: `
    + `tikwm=${usage.tikwm} rapidapi=${usage.rapidapi} fail=${usage.failures}`);

  // Track paid calls across the day. At a 3h interval there are 8 runs a day,
  // so one bad day of TikWM outages would otherwise quietly drain the RapidAPI
  // quota before anyone noticed.
  const today = new Date().toISOString().slice(0, 10);
  const paidLog = await getMeta('paidLookups', { day: today, count: 0 });
  const paidToday = (paidLog.day === today ? paidLog.count : 0) + usage.rapidapi;
  await setMeta('paidLookups', { day: today, count: paidToday });

  if (paidToday >= config.STATS.MAX_PAID_LOOKUPS_PER_DAY) {
    await alert(client,
      `🛑 **Paid lookup ceiling hit.** ${paidToday} RapidAPI calls today against a limit of ` +
      `${config.STATS.MAX_PAID_LOOKUPS_PER_DAY}. Further runs skip RapidAPI until midnight UTC, ` +
      `so some view counts will go stale rather than cost money.`);
  } else if (usage.rapidapi > subs.length * 0.5 && subs.length > 20) {
    await alert(client,
      `⚠️ **TikWM is failing.** ${usage.rapidapi} of ${subs.length} lookups fell through to paid ` +
      `RapidAPI this run, ${paidToday} today. The ceiling is ` +
      `${config.STATS.MAX_PAID_LOOKUPS_PER_DAY} a day.`);
  }

  await logging.system('Stats refresh',
    `${updated} updated, ${failed} failed.\n` +
    `Free: ${usage.tikwm} TikWM, ${usage.oembed} oEmbed. Paid: ${usage.rapidapi} RapidAPI ` +
    `(${paidToday} today).`,
    failed > updated ? 'warn' : 'info');

  return { updated, failed, usage, paidToday };
}

/** True when today's paid lookups are already at the ceiling. */
async function paidLookupsExhausted() {
  const today = new Date().toISOString().slice(0, 10);
  const paidLog = await getMeta('paidLookups', { day: today, count: 0 });
  return paidLog.day === today && paidLog.count >= config.STATS.MAX_PAID_LOOKUPS_PER_DAY;
}

async function checkMilestone(client, sub, views, campaign) {
  if (views < config.REFERRALS.MILESTONE_VIEWS) return;
  if (campaign && new Date() > new Date(campaign.endDate)) return;
  const referral = await getDb().collection('referrals').findOne({
    inviteeId: sub.userId, milestonePaid: { $ne: true },
  });
  if (!referral) return;
  await getDb().collection('referrals').updateOne(
    { _id: referral._id }, { $set: { milestonePaid: true, milestoneAt: new Date() } }
  );
  await getDb().collection('earnings').insertOne({
    userId: referral.inviterId, campaignValue: 'referral',
    amount: config.REFERRALS.MILESTONE_BONUS, state: 'pending',
    note: `Referral milestone: ${sub.username} crossed ${config.REFERRALS.MILESTONE_VIEWS.toLocaleString('en-US')} views`,
    createdAt: new Date(),
  });
  await alert(client,
    `🔗 **Referral milestone** — <@${referral.inviterId}> earns $${config.REFERRALS.MILESTONE_BONUS}.`);
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('camp:')) return false;
  const [, action, arg] = id.split(':');

  try {
    switch (action) {
      case 'join':        await handleJoin(interaction, arg); break;
      case 'leave':       await handleLeave(interaction, arg); break;
      case 'submit':      await handleSubmitButton(interaction, arg); break;
      case 'submitmodal': await handleSubmitModal(interaction, arg); break;
      case 'approve':     await handleReview(interaction, 'approve', arg); break;
      case 'reject':      await handleReview(interaction, 'reject', arg); break;
      case 'board': {
        await perms.safeDefer(interaction, true);
        const embed = await buildLeaderboardEmbed(arg, interaction.user.id);
        await interaction.editReply(
          embed ? { embeds: [embed] } : { content: copy.campaign.notFound });
        break;
      }
      default: return false;
    }
  } catch (err) {
    console.error('[Campaigns] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('campaigns'));
  }
  return true;
}

module.exports = {
  STATUS,
  getCampaign, listCampaigns, visibleCampaigns, isLive,
  calculateEarnings, budgetStatus, getCommittedSpend,
  postOffer, buildOfferEmbed, buildOfferButtons, buildPingLine,
  handleJoin, handleLeave,
  rebuildLeaderboard, buildLeaderboardEmbed,
  updateAllStats, paidLookupsExhausted, route, alert,
};
