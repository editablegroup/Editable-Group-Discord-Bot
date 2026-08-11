'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require('discord.js');
const { ObjectId } = require('mongodb');

const config = require('./config');
const { getDb, getMeta, setMeta } = require('./db');
const tiktok = require('./tiktok');
const perms = require('./permissions');

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
  const target = config.CHANNELS.ALERTS.startsWith('SET_ME')
    ? config.CHANNELS.LOGS : config.CHANNELS.ALERTS;
  try {
    const ch = await client.channels.fetch(target);
    await ch.send(content);
  } catch (err) { console.error('[alert]', err.message); }
}

// ── Campaign offer post ─────────────────────────────────────────────────────

function buildOfferEmbed(campaign, budget) {
  const isCore = campaign.tier === 'core';
  const bar = (pct) => {
    const filled = Math.round((pct / 100) * 12);
    return '▰'.repeat(filled) + '▱'.repeat(12 - filled);
  };

  const embed = new EmbedBuilder()
    .setColor(isCore ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(`${isCore ? '⭐ CORE — ' : '🔓 '}${campaign.label}`)
    .setDescription(campaign.brief || 'Brief to follow.')
    .addFields(
      { name: '💰 Rate', value: `$${campaign.rpm.toFixed(2)} / 1K views`, inline: true },
      { name: '🏆 Max per editor', value: `$${campaign.maxPayout}`, inline: true },
      { name: '📊 Min views to earn', value: campaign.minViews.toLocaleString('en-US'), inline: true },
      { name: '⏳ Ends', value: `<t:${Math.floor(new Date(campaign.endDate).getTime() / 1000)}:R>`, inline: true },
      { name: '🎯 Access', value: isCore ? 'Core members only' : 'Open to all Network editors', inline: true },
    )
    .setFooter({ text: 'Editable Group' })
    .setTimestamp();

  if (!campaign.hideBudget && budget) {
    embed.addFields({
      name: '💵 Budget',
      value: `${bar(budget.percentUsed)} ${Math.round(100 - budget.percentUsed)}% left`,
      inline: true,
    });
  }

  if (campaign.bonus1st && !campaign.hidePlacements) {
    embed.addFields({
      name: '🥇 Bonuses',
      value: `1st place: **$${campaign.bonus1st}**` +
             (campaign.bonus2nd ? ` · 2nd place: **$${campaign.bonus2nd}**` : ''),
      inline: false,
    });
  }
  if (campaign.audioUrl) {
    embed.addFields({ name: '🎵 Audio', value: campaign.audioUrl, inline: false });
  }
  return embed;
}

function buildOfferButtons(campaign) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`camp:join:${campaign.value}`)
      .setLabel('Join Campaign').setEmoji('🎬').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`camp:submit:${campaign.value}`)
      .setLabel('Submit Edit').setEmoji('📩').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`camp:board:${campaign.value}`)
      .setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
  );
}

async function postOffer(client, campaign) {
  const budget = await budgetStatus(campaign);
  const channelId = campaign.tier === 'core'
    ? (campaign.offerChannelId || config.CHANNELS.CORE_CAMPAIGNS)
    : (campaign.offerChannelId || config.CHANNELS.ACTIVE_CAMPAIGNS);

  if (!channelId || channelId.startsWith('SET_ME')) {
    throw new Error('No offer channel configured for this tier — check config.js');
  }

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.send({
    content: campaign.tier === 'core'
      ? `<@&${config.ROLES.CORE}>`
      : `<@&${config.ROLES.NETWORK}>`,
    embeds: [buildOfferEmbed(campaign, budget)],
    components: [buildOfferButtons(campaign)],
  });

  await getDb().collection('campaigns').updateOne(
    { value: campaign.value },
    { $set: { offerMessageId: msg.id, offerChannelId: channelId } }
  );
  return msg;
}

// ── Join ────────────────────────────────────────────────────────────────────

async function handleJoin(interaction, campaignValue) {
  if (!await perms.enforceCooldown(interaction, 'join', config.COOLDOWNS.BUTTON_MS)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const campaign = await getCampaign(campaignValue);
  if (!campaign) return perms.safeReply(interaction, '❌ Campaign not found.');

  if (!perms.canAccessCampaign(interaction.member, campaign)) {
    return perms.safeReply(interaction, perms.DENY.core);
  }
  if (!isLive(campaign)) {
    return perms.safeReply(interaction, '⌛ This campaign is closed.');
  }

  if (campaign.roleId) {
    if (interaction.member.roles.cache.has(campaign.roleId)) {
      return perms.safeReply(interaction, '✅ You\'re already in this campaign.');
    }
    await interaction.member.roles.add(campaign.roleId, `Joined ${campaign.value}`).catch(() => {});
  }

  await getDb().collection('campaigns').updateOne(
    { value: campaignValue }, { $inc: { participants: 1 } }
  );

  return perms.safeReply(interaction,
    `✅ You're in on **${campaign.label}**.\n\n` +
    `**Rate:** $${campaign.rpm.toFixed(2)}/1K views · **Cap:** $${campaign.maxPayout}\n` +
    `**Minimum to earn:** ${campaign.minViews.toLocaleString('en-US')} views\n\n` +
    `Post your edit, then hit **Submit Edit** with the link.`);
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
    return perms.safeReply(interaction, '⌛ This campaign closed while you were submitting.');
  }

  // Budget gate — refuse rather than accrue liability you can't pay.
  const budget = await autoPauseIfExhausted(campaign, interaction.client);
  if (budget.exhausted) {
    return perms.safeReply(interaction,
      '🛑 This campaign\'s budget is fully committed. No new submissions are being accepted.');
  }

  const editor = await getDb().collection('editors').findOne({ userId: interaction.user.id });
  if (!editor) return perms.safeReply(interaction, '❌ Complete onboarding first.');

  // Per-campaign submission cap.
  const existingCount = await getDb().collection('submissions').countDocuments({
    userId: interaction.user.id, campaignValue, status: { $ne: 'rejected' },
  });
  if (existingCount >= config.INTEGRITY.MAX_SUBS_PER_CAMPAIGN) {
    return perms.safeReply(interaction,
      `❌ You've hit the limit of ${config.INTEGRITY.MAX_SUBS_PER_CAMPAIGN} submissions on this campaign.`);
  }

  // Resolve the video.
  const details = await tiktok.getVideoDetails(link);
  if (!details.ok) {
    const messages = {
      not_tiktok: '❌ That isn\'t a TikTok link.',
      unresolvable: '❌ Couldn\'t read that link. Use the **Copy link** option in TikTok.',
      lookup_failed: '❌ TikTok didn\'t respond. Wait a minute and try again.',
    };
    return perms.safeReply(interaction, messages[details.reason] || '❌ Couldn\'t verify that link.');
  }

  // Ownership check.
  const ownership = tiktok.verifyOwnership(details.handle, editor.tiktokHandle);
  if (!ownership.ok) {
    if (ownership.reason === 'handle_mismatch') {
      console.warn(`[FRAUD] ${interaction.user.tag} submitted @${ownership.videoHandle} `
        + `but is registered as @${ownership.registeredHandle}`);
      await alert(interaction.client,
        `⚠️ **Ownership mismatch** — <@${interaction.user.id}> tried to submit a video by ` +
        `**@${ownership.videoHandle}** but is registered as **@${ownership.registeredHandle}**.\n${details.url}`);
      return perms.safeReply(interaction,
        `❌ That video was posted by **@${ownership.videoHandle}**, but your account is registered ` +
        `as **@${ownership.registeredHandle}**. You can only submit your own edits.\n\n` +
        `Changed handle? Open a ticket and we'll update it.`);
    }
    return perms.safeReply(interaction,
      '❌ Couldn\'t confirm who posted that video. Try again shortly, or open a ticket.');
  }

  // Age check — stops old viral posts being farmed into new campaigns.
  if (details.createTime) {
    const ageHours = (Date.now() - details.createTime * 1000) / 3_600_000;
    if (ageHours > config.INTEGRITY.MAX_VIDEO_AGE_HOURS) {
      return perms.safeReply(interaction,
        `❌ That video is ${Math.round(ageHours / 24)} days old. Only edits posted within the last ` +
        `${Math.round(config.INTEGRITY.MAX_VIDEO_AGE_HOURS / 24)} days count.`);
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
      return perms.safeReply(interaction,
        '❌ That video has already been submitted to this campaign.');
    }
    throw err;
  }

  // Review card.
  const subId = inserted.insertedId.toString();
  const reviewEmbed = new EmbedBuilder()
    .setColor(suspicious ? 0xf5b800 : 0x2b2d31)
    .setTitle(suspicious ? '⚠️ Flagged submission — review carefully' : '📩 New submission')
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
      value: `Already at ${details.views.toLocaleString('en-US')} views at submission — verify this was made for the campaign.`,
    });
  }

  const reviewChannel = await interaction.client.channels.fetch(config.CHANNELS.SUBMISSIONS);
  await reviewChannel.send({
    embeds: [reviewEmbed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`camp:approve:${subId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`camp:reject:${subId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )],
  });

  return perms.safeReply(interaction,
    `✅ **Submitted** — [${clipName}](${details.url})\n` +
    `Posted by **@${details.handle}** · ${details.views.toLocaleString('en-US')} views right now.\n\n` +
    `You'll get a DM once it's reviewed. Views refresh every 12 hours after approval.`);
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
      content: `Already ${sub.status} — no change made.`, flags: MessageFlags.Ephemeral,
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
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(approved ? 0x57f287 : 0xed4245)
        .setTitle(approved ? '✅ Your edit was approved' : '❌ Your edit was rejected')
        .setDescription(approved
          ? `**${sub.campaignLabel}**\nViews and earnings update every 12 hours.`
          : `**${sub.campaignLabel}**\nOpen a ticket if you'd like to know why.`)
        .addFields({ name: 'Edit', value: `[${sub.clipName}](${sub.link})` })
        .setTimestamp()],
    });
  } catch { /* DMs closed */ }

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
    { $sort: { views: -1 } },
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
    `${medal(i)} **${r.username}** — ${r.views.toLocaleString('en-US')} views · ${r.posts} post${r.posts === 1 ? '' : 's'}`
  ).join('\n') || '_No approved submissions yet._';

  const embed = new EmbedBuilder()
    .setColor(campaign.tier === 'core' ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(`🏆 ${campaign.label}`)
    .setDescription(top)
    .setFooter({ text: `${rows.length} editors · updated` })
    .setTimestamp(board.updatedAt);

  if (viewerId) {
    const idx = rows.findIndex(r => r._id === viewerId);
    if (idx >= 0) {
      embed.addFields({
        name: 'Your position',
        value: campaign.hidePlacements
          ? `${rows[idx].posts} entries · ${rows[idx].views.toLocaleString('en-US')} views`
          : `**#${idx + 1}** — ${rows[idx].views.toLocaleString('en-US')} views · `
            + `$${rows[idx].earnings.toFixed(2)} earned`,
      });
    } else {
      embed.addFields({ name: 'Your position', value: 'Not ranked yet — get an edit approved.' });
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
  console.log(`[Stats] Done — ${updated} updated, ${failed} failed. API: `
    + `tikwm=${usage.tikwm} rapidapi=${usage.rapidapi} fail=${usage.failures}`);

  if (usage.rapidapi > subs.length * 0.5 && subs.length > 20) {
    await alert(client,
      `⚠️ **TikWM is failing** — ${usage.rapidapi}/${subs.length} lookups fell through to paid ` +
      `RapidAPI this run. Check your RapidAPI quota before it runs out mid-campaign.`);
  }
  return { updated, failed, usage };
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
      case 'submit':      await handleSubmitButton(interaction, arg); break;
      case 'submitmodal': await handleSubmitModal(interaction, arg); break;
      case 'approve':     await handleReview(interaction, 'approve', arg); break;
      case 'reject':      await handleReview(interaction, 'reject', arg); break;
      case 'board': {
        await perms.safeDefer(interaction, true);
        const embed = await buildLeaderboardEmbed(arg, interaction.user.id);
        await interaction.editReply(embed ? { embeds: [embed] } : { content: '❌ Campaign not found.' });
        break;
      }
      default: return false;
    }
  } catch (err) {
    console.error('[Campaigns] route error:', err);
    await perms.safeReply(interaction, '❌ Something went wrong. Try again.');
  }
  return true;
}

module.exports = {
  STATUS,
  getCampaign, listCampaigns, visibleCampaigns, isLive,
  calculateEarnings, budgetStatus, getCommittedSpend,
  postOffer, buildOfferEmbed, buildOfferButtons,
  rebuildLeaderboard, buildLeaderboardEmbed,
  updateAllStats, route, alert,
};
