'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelType, MessageFlags,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb } = require('./db');
const perms = require('./permissions');
const campaigns = require('./campaigns');
const tiktok = require('./tiktok');
const onboarding = require('./onboarding');
const provision = require('./provision');
const assets = require('./assets');
const leaderboard = require('./leaderboard');

/**
 * ============================================================================
 *  ADMIN
 * ============================================================================
 *  Every handler here calls requireStaff() before doing anything, regardless of
 *  what the slash-command registration says. Registration-time permissions are
 *  a UI hint; this is the actual boundary.
 * ============================================================================
 */

// ── /migratecore — one-time bulk grant ──────────────────────────────────────

/**
 * Grants Core to everyone currently holding your legacy Editor role — the 100
 * people you and Roshan hand-picked. Run this ONCE, before the promo goes live.
 * Throttled so Discord doesn't rate-limit you halfway through and leave the
 * roster in a half-migrated state.
 */
async function migrateCore(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  if (!ids.roleId('CORE')) {
    return perms.safeReply(interaction,
      'No Core role is configured. Run /setup, or set ROLES.CORE in config.js.');
  }
  await perms.safeDefer(interaction, true);

  const guild = interaction.guild;
  const members = await guild.members.fetch(); // one-off full fetch; fine here
  const legacy = members.filter(m =>
    m.roles.cache.has(config.ROLES.LEGACY_EDITOR) && !m.roles.cache.has(ids.roleId('CORE'))
  );

  await interaction.editReply(`Migrating ${legacy.size} members to Core…`);

  let ok = 0, fail = 0;
  for (const [, member] of legacy) {
    try {
      await member.roles.add(ids.roleId('CORE'), 'Legacy hand-picked editor promoted to Core');
      if (!member.roles.cache.has(config.ROLES.NETWORK)) {
        await member.roles.add(config.ROLES.NETWORK, 'Baseline access');
      }
      await getDb().collection('editors').updateOne(
        { userId: member.id },
        {
          $set: { tier: config.TIERS.CORE, corePromotedAt: new Date(), coreReason: 'founding' },
          $setOnInsert: {
            userId: member.id, username: member.user.username,
            joinedAt: new Date(), lifetimeEarnings: 0,
            pendingBalance: 0, clearedBalance: 0, paidOut: 0,
          },
        },
        { upsert: true }
      );
      ok++;
    } catch (err) {
      fail++;
      console.error(`[Migrate] ${member.user.tag}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 350)); // stay under Discord's role rate limit
  }

  await interaction.editReply(
    `Migration complete. **${ok}** granted Core, ${fail} failed.\n\n` +
    `Everyone else who joins from here lands in **Network**.`);
}

// ── /lockdown — pre-launch channel setup ────────────────────────────────────

/**
 * Sets @everyone to see nothing except #onboarding, and grants Network view on
 * the channels it should see.
 *
 * Worth doing from the bot rather than by hand: with a public invite going out
 * to TikTok, a single channel you forgot to lock is a channel where thousands
 * of un-onboarded strangers can post. Doing it in one pass means you can't miss
 * one at 1am.
 */
async function lockdown(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const guild = interaction.guild;
  const everyone = guild.roles.everyone;
  const results = [];

  for (const [, channel] of guild.channels.cache) {
    if (channel.type === ChannelType.GuildCategory) continue;
    try {
      if (channel.id === ids.channelId('ONBOARDING')) {
        await channel.permissionOverwrites.edit(everyone, {
          ViewChannel: true, SendMessages: false, ReadMessageHistory: true,
          AddReactions: false, CreatePublicThreads: false,
        });
        results.push(`✅ #${channel.name} visible to everyone, read-only`);
      } else {
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: false });
        if (channel.id === ids.channelId('CORE_CAMPAIGNS') && ids.roleId('CORE')) {
          await channel.permissionOverwrites.edit(ids.roleId('CORE'), { ViewChannel: true });
          results.push(`⭐ #${channel.name} Core only`);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      results.push(`❌ #${channel.name} ${err.message}`);
    }
  }

  const text = results.join('\n').slice(0, 3900);
  await interaction.editReply(
    `**Lockdown applied**\n\n${text}\n\n` +
    `⚠️ Now grant the **Network** role \`View Channel\` on the channels editors should see. ` +
    `The bot deliberately does not guess which those are.`);
}

// ── /campaign create|edit|post|end ──────────────────────────────────────────

/**
 * /campaign create is a slash command rather than a modal for one reason:
 * modals cannot accept file uploads, and a campaign needs its audio and example
 * videos attached. Slash commands support attachment options, so everything is
 * captured in a single action.
 *
 * The attachments are downloaded and stored in MongoDB immediately, because
 * Discord's attachment URLs are signed and expire in about a day.
 */
async function campaignCommand(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') return createCampaign(interaction);

  await perms.safeDefer(interaction, true);
  const value = interaction.options.getString('campaign');
  const campaign = await campaigns.getCampaign(value);
  if (!campaign) return interaction.editReply('That campaign does not exist.');

  if (sub === 'post') {
    try {
      const msg = await campaigns.postOffer(interaction.client, campaign);
      return interaction.editReply(`Posted: ${msg.url}`);
    } catch (err) {
      return interaction.editReply(err.message);
    }
  }

  if (sub === 'end') {
    await getDb().collection('campaigns').updateOne(
      { value }, { $set: { status: campaigns.STATUS.ENDED, endedAt: new Date() } });
    await campaigns.rebuildLeaderboard(value);

    // The all-time board is rebuilt on campaign end, which is the only moment
    // the numbers become final.
    await leaderboard.publish(interaction.client);

    let retired = '';
    try {
      const result = await provision.retireCampaignSpace(interaction.guild, campaign);
      if (result.done && result.mode === 'archived') {
        retired = `\nCategory archived and set read-only. The campaign role is deleted in ` +
          `${result.roleDeletesInDays} days, which is after earnings clear.`;
      } else if (result.done) {
        retired = '\nCategory, channels and role deleted.';
      }
    } catch (err) {
      retired = `\nCould not tidy up the campaign channels: ${err.message}`;
    }

    return interaction.editReply(
      `**${campaign.label}** ended. Leaderboard frozen and the all-time board rebuilt.${retired}`);
  }

  if (sub === 'budget') {
    const amount = interaction.options.getNumber('amount');
    await getDb().collection('campaigns').updateOne({ value }, { $set: { budget: amount } });
    const status = await campaigns.budgetStatus({ ...campaign, budget: amount });
    return interaction.editReply(
      `Budget for **${campaign.label}** set to $${amount.toFixed(2)}. ` +
      `$${status.spent.toFixed(2)} is already committed, leaving $${status.remaining.toFixed(2)}.`);
  }
}

async function createCampaign(interaction) {
  await perms.safeDefer(interaction, true);

  const label = interaction.options.getString('name').trim();
  const rpm = interaction.options.getNumber('rpm');
  const maxPayout = interaction.options.getNumber('max_payout');
  const minViews = interaction.options.getInteger('min_views');
  const budget = interaction.options.getNumber('pot');
  const days = interaction.options.getInteger('days');
  const brief = interaction.options.getString('brief').trim();
  const tier = (interaction.options.getString('tier') || 'network').toLowerCase();
  const platform = interaction.options.getString('platform') || 'TikTok';
  const pingEveryone = interaction.options.getBoolean('ping_everyone') || false;
  const nicheRaw = interaction.options.getString('niches') || '';

  if (rpm <= 0 || maxPayout <= 0 || minViews < 0 || budget <= 0 || days <= 0) {
    return interaction.editReply(
      'Rate, max pay-out, pot and length all have to be above zero.');
  }
  if (maxPayout > budget) {
    return interaction.editReply(
      `Max pay-out per video ($${maxPayout}) is larger than the whole pot ($${budget}), ` +
      `so one video could take everything. Raise the pot or lower the cap.`);
  }

  // Niches: comma separated, validated against config so a typo does not
  // silently create a campaign nobody gets pinged about.
  const niches = nicheRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const unknown = niches.filter(n => !ids.nicheByValue(n));
  if (unknown.length) {
    return interaction.editReply(
      `Unknown niche: ${unknown.join(', ')}. Valid values are ` +
      `${config.NICHES.map(n => `\`${n.value}\``).join(', ')}.`);
  }

  const value = provision.slug(label).replace(/-/g, '_').slice(0, 40);
  if (await campaigns.getCampaign(value)) {
    return interaction.editReply(
      `A campaign with the key \`${value}\` already exists. Use a different name.`);
  }

  // Attachments first. If one fails we stop before creating anything, rather
  // than leaving a half-built campaign behind.
  const stored = [];
  for (let i = 1; i <= config.CAMPAIGN_AUTOMATION.MAX_ASSETS; i++) {
    const file = interaction.options.getAttachment(`file${i}`);
    if (!file) continue;
    try {
      stored.push(await assets.store(value, file));
    } catch (err) {
      return interaction.editReply(err.message);
    }
  }

  const endDate = new Date(Date.now() + days * 86_400_000);
  const campaign = {
    value, label, tier, rpm, maxPayout, minViews, budget, brief, platform,
    niches, pingEveryone,
    assets: stored,
    endDate, status: campaigns.STATUS.ACTIVE,
    participants: 0, createdAt: new Date(), createdBy: interaction.user.id,
  };
  await getDb().collection('campaigns').insertOne(campaign);

  // Role, private category and channels.
  let spaceLine = '';
  if (config.CAMPAIGN_AUTOMATION.ENABLED) {
    try {
      const space = await provision.createCampaignSpace(interaction.guild, campaign);
      campaign.roleId = space.roleId;
      campaign.space = space;
      spaceLine =
        `\nCreated the **${space.categoryName}** role and category with ` +
        `${Object.keys(space.channels).length} channels. Joining the campaign unlocks it.`;
    } catch (err) {
      spaceLine =
        `\nThe campaign exists but its role and category were not created: ${err.message}`;
    }
  }

  const pingLine = pingEveryone
    ? 'Posting it pings @everyone.'
    : niches.length
      ? `Posting it pings ${niches.map(n => ids.nicheByValue(n).label).join(', ')}.`
      : `No niches set, so posting it pings the whole ${tier === 'core' ? 'Core' : 'Network'} role.`;

  return interaction.editReply(
    `Created **${label}** (\`${value}\`).\n` +
    `$${rpm.toFixed(2)} per 1,000 views, max $${maxPayout.toFixed(2)} per video, ` +
    `pot $${budget.toFixed(2)}, minimum ${minViews.toLocaleString('en-US')} views.\n` +
    `Ends <t:${Math.floor(endDate.getTime() / 1000)}:F>.\n` +
    `${stored.length} file${stored.length === 1 ? '' : 's'} stored.` +
    spaceLine +
    `\n${pingLine}\n\nPost it with \`/campaign post campaign:${value}\`.`);
}

// ── /setup — provision the server ───────────────────────────────────────────

/**
 * Creates every channel and role the bot needs and records the IDs in Mongo,
 * so a fresh server does not need anyone to paste snowflakes into config.js.
 * Safe to run repeatedly: anything already resolved is skipped.
 */
async function setup(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const capability = provision.checkCapability(interaction.guild);
  const lines = [];

  const niches = await provision.ensureNicheRoles(interaction.guild);
  lines.push(niches.length
    ? `Created niche roles: ${niches.join(', ')}.`
    : 'Niche roles already exist.');

  const { created, reused } = await provision.ensureStandingChannels(interaction.guild);
  if (created.length) lines.push(`Created channels: ${created.join(', ')}.`);
  if (reused.length) lines.push(`Adopted existing channels: ${reused.join(', ')}.`);
  if (!created.length && !reused.length) lines.push('All channels were already configured.');

  // Panels go up once the channels they live in exist.
  const panel = require('./panel');
  const payments = require('./payments');
  const tickets = require('./tickets');
  await onboarding.ensurePanel(interaction.client);
  await panel.ensurePanel(interaction.client);
  await payments.ensurePanel(interaction.client);
  await tickets.ensurePanel(interaction.client);
  await leaderboard.publish(interaction.client);
  lines.push('Panels posted in onboarding, submit, payments, tickets and leaderboard.');

  const stillMissing = ids.missing();
  if (stillMissing.length) {
    lines.push(`Still unset: ${stillMissing.join(', ')}. Fill these in config.js by hand.`);
  }

  if (!capability.ok) {
    lines.push(`\n**Permissions to fix:**\n${capability.problems.join('\n')}`);
  } else {
    lines.push(
      `\nRole position looks fine. ${capability.rolesAbove} roles sit above the bot, ` +
      `${capability.roleCount} roles and ${capability.channelCount} channels exist ` +
      `against Discord's limit of 500 each.`);
  }

  return interaction.editReply(lines.join('\n').slice(0, 1900));
}

// ── Core promotion ──────────────────────────────────────────────────────────

async function promote(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'Performance';
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.editReply('❌ Not in the server.');
  if (member.roles.cache.has(ids.roleId('CORE'))) return interaction.editReply('They are already Core.');

  await member.roles.add(ids.roleId('CORE'), `Promoted by ${interaction.user.tag}: ${reason}`);
  await getDb().collection('editors').updateOne(
    { userId: user.id },
    { $set: { tier: config.TIERS.CORE, corePromotedAt: new Date(), coreReason: reason, corePromotedBy: interaction.user.id } }
  );

  try {
    await user.send({
      embeds: [new EmbedBuilder().setColor(0xf5b800)
        .setTitle("⭐ You've been promoted to Core")
        .setDescription(
          'Core is the vetted tier at Editable Group. You now get access to exclusive ' +
          'campaigns for clients who pay for quality control — smaller rosters, higher rates, ' +
          'and briefs matched to your genre.\n\nKeep doing what got you here.')
        .addFields({ name: 'Reason', value: reason })],
    });
  } catch { /* DMs closed */ }

  await campaigns.alert(interaction.client,
    `⭐ <@${user.id}> promoted to **Core** by <@${interaction.user.id}>. Reason: ${reason}`);
  return interaction.editReply(`✅ <@${user.id}> is now Core.`);
}

async function demote(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);
  const user = interaction.options.getUser('user');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.editReply('❌ Not in the server.');
  await member.roles.remove(ids.roleId('CORE'), `Demoted by ${interaction.user.tag}`).catch(() => {});
  await getDb().collection('editors').updateOne(
    { userId: user.id }, { $set: { tier: config.TIERS.NETWORK, coreRemovedAt: new Date() } });
  return interaction.editReply(`✅ <@${user.id}> moved back to Network.`);
}

/**
 * Surfaces Network editors who've met the Core bar. Deliberately a suggestion
 * list, not an auto-promotion: Core's whole value proposition to clients is
 * that a human vetted it. An algorithm promoting people quietly undermines the
 * thing you're selling.
 */
async function coreNominations(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);
  const t = config.CORE_NOMINATION;

  const rows = await getDb().collection('submissions').aggregate([
    { $group: {
        _id: '$userId',
        username: { $first: '$username' },
        approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        totalViews: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$views', 0] } },
    }},
    { $match: { approved: { $gte: t.MIN_APPROVED_SUBS }, totalViews: { $gte: t.MIN_TOTAL_VIEWS } } },
    { $sort: { totalViews: -1 } },
    { $limit: 40 },
  ]).toArray();

  const guild = interaction.guild;
  const candidates = [];
  for (const r of rows) {
    const member = await guild.members.fetch(r._id).catch(() => null);
    if (!member || member.roles.cache.has(ids.roleId('CORE'))) continue;
    const total = r.approved + r.rejected;
    const rejectRate = total ? r.rejected / total : 0;
    const avg = r.totalViews / r.approved;
    if (rejectRate > t.MAX_REJECTION_RATE || avg < t.MIN_AVG_VIEWS) continue;
    candidates.push({ ...r, avg, rejectRate });
    if (candidates.length >= 15) break;
  }

  if (!candidates.length) {
    return interaction.editReply('No Network editors currently meet the Core bar.');
  }

  const embed = new EmbedBuilder()
    .setColor(0xf5b800)
    .setTitle('⭐ Core candidates')
    .setDescription(candidates.map((c, i) =>
      `**${i + 1}. ${c.username}** <@${c._id}>\n` +
      `　${c.approved} approved · ${Math.round(c.avg).toLocaleString('en-US')} avg views · ` +
      `${Math.round(c.rejectRate * 100)}% rejected`
    ).join('\n\n'))
    .setFooter({ text: 'Promote with /promote user:@them' });
  return interaction.editReply({ embeds: [embed] });
}

// ── Dashboard ───────────────────────────────────────────────────────────────

async function dashboard(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const db = getDb();
  const guild = interaction.guild;

  const [totalEditors, coreCount, pendingSubs, flaggedSubs, activeCampaigns, pendingPayouts] =
    await Promise.all([
      db.collection('editors').countDocuments(),
      db.collection('editors').countDocuments({ tier: config.TIERS.CORE }),
      db.collection('submissions').countDocuments({ status: 'pending' }),
      db.collection('submissions').countDocuments({ status: 'flagged' }),
      db.collection('campaigns').find({ status: campaigns.STATUS.ACTIVE }).toArray(),
      db.collection('payoutRequests').countDocuments({ status: 'pending' }),
    ]);

  const [viewAgg] = await db.collection('submissions').aggregate([
    { $match: { status: 'approved' } },
    { $group: { _id: null, views: { $sum: '$views' }, owed: { $sum: '$earnings' }, posts: { $sum: 1 } } },
  ]).toArray();

  const campaignLines = [];
  for (const c of activeCampaigns) {
    const b = await campaigns.budgetStatus(c);
    campaignLines.push(
      `${c.tier === 'core' ? '⭐' : '🔓'} **${c.label}**\n` +
      `　$${b.spent.toFixed(0)}/$${c.budget} committed (${Math.round(b.percentUsed)}%) · ` +
      `ends <t:${Math.floor(new Date(c.endDate).getTime() / 1000)}:R>`);
  }

  const usage = tiktok.getUsage();
  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle('Editable Group operations')
    .addFields(
      { name: '👥 Server', value:
        `${guild.memberCount.toLocaleString('en-US')} members\n` +
        `${totalEditors.toLocaleString('en-US')} onboarded\n⭐ ${coreCount} Core`, inline: true },
      { name: '📥 Queue', value:
        `${pendingSubs} pending\n${flaggedSubs} flagged\n${pendingPayouts} payout requests`, inline: true },
      { name: '📊 All-time', value:
        `${(viewAgg?.views || 0).toLocaleString('en-US')} views\n` +
        `${viewAgg?.posts || 0} approved posts\n$${(viewAgg?.owed || 0).toFixed(2)} accrued`, inline: true },
      { name: '🎯 Active campaigns', value: campaignLines.join('\n') || '_None_', inline: false },
      { name: '🔌 API this run', value:
        `TikWM ${usage.tikwm} · RapidAPI ${usage.rapidapi} · failures ${usage.failures}`, inline: false },
    )
    .setTimestamp();

  if (flaggedSubs > 0) {
    embed.addFields({ name: '⚠️ Attention', value: `${flaggedSubs} submissions flagged for manual review.` });
  }
  return interaction.editReply({ embeds: [embed] });
}

// ── Editor lookup ───────────────────────────────────────────────────────────

async function editorLookup(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const user = interaction.options.getUser('user');
  const db = getDb();
  const editor = await db.collection('editors').findOne({ userId: user.id });
  if (!editor) return interaction.editReply('No profile. They have not onboarded.');

  const embed = new EmbedBuilder()
    .setColor(editor.tier === config.TIERS.CORE ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(`${editor.tier === config.TIERS.CORE ? '⭐ ' : ''}${editor.username}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'TikTok', value: editor.tiktokHandle ? `[@${editor.tiktokHandle}](https://www.tiktok.com/@${editor.tiktokHandle})` : 'Not set', inline: true },
      { name: 'Tier', value: editor.tier || 'network', inline: true },
      { name: 'Joined', value: `<t:${Math.floor(new Date(editor.joinedAt).getTime() / 1000)}:R>`, inline: true },
      { name: 'Niches', value:
        (editor.niches || []).map(n => ids.nicheByValue(n)?.label || n).join(', ') || 'None',
        inline: false },
      { name: 'Payment', value:
        editor.paymentMethod === 'paypal' ? `PayPal, ${editor.paypalEmail}`
        : editor.paymentMethod === 'bank' ? 'Bank transfer, details collected at payout'
        : 'Not set', inline: false },
    );

  return interaction.editReply({ embeds: [embed] });
}

// ── Payouts ─────────────────────────────────────────────────────────────────
//
// balance() and requestPayout() now live in payments.js, next to the panel that
// owns those buttons. Tickets moved to tickets.js for the same reason.

/**
 * Moves pending earnings to cleared for campaigns that ended more than
 * CLEARING_DAYS ago. Run on a schedule from index.js.
 */
async function clearMaturedEarnings() {
  const cutoff = new Date(Date.now() - config.PAYOUTS.CLEARING_DAYS * 86_400_000);
  const ended = await getDb().collection('campaigns')
    .find({ endDate: { $lt: cutoff } }).project({ value: 1 }).toArray();
  if (!ended.length) return 0;

  const res = await getDb().collection('earnings').updateMany(
    { campaignValue: { $in: ended.map(c => c.value) }, state: 'pending' },
    { $set: { state: 'cleared', clearedAt: new Date() } }
  );
  if (res.modifiedCount) console.log(`[Payouts] Cleared ${res.modifiedCount} earnings rows`);
  return res.modifiedCount;
}

// ── /channels — see and fix what the bot is pointing at ─────────────────────

/**
 * Name matching in /setup is a guess, and a guess is sometimes wrong. This is
 * the manual override: point any key at any channel, or clear it so /setup
 * makes a fresh one.
 *
 * Rebind before deleting a duplicate channel. If you delete first, the bot
 * keeps a binding to a channel that no longer exists and its panel quietly
 * stops appearing.
 */
const CHANNEL_KEYS = [
  { name: 'Payments panel', value: 'PAYMENTS' },
  { name: 'Ticket panel', value: 'TICKETS' },
  { name: 'Ticket channels are created under', value: 'TICKETS_CATEGORY' },
  { name: 'Leaderboard', value: 'LEADERBOARD' },
  { name: 'Onboarding', value: 'ONBOARDING' },
  { name: 'Submit panel', value: 'SUBMIT' },
  { name: 'Staff review queue', value: 'SUBMISSIONS' },
  { name: 'Active campaigns', value: 'ACTIVE_CAMPAIGNS' },
  { name: 'Core campaigns', value: 'CORE_CAMPAIGNS' },
  { name: 'Alerts', value: 'ALERTS' },
  { name: 'Campaign categories created under', value: 'CAMPAIGN_PARENT' },
  { name: 'Log: system', value: 'LOG:SYSTEM' },
  { name: 'Log: join-leave', value: 'LOG:JOIN_LEAVE' },
  { name: 'Log: chat', value: 'LOG:CHAT' },
  { name: 'Log: server', value: 'LOG:SERVER' },
  { name: 'Log: onboarding', value: 'LOG:ONBOARDING' },
  { name: 'Log: submissions', value: 'LOG:SUBMISSION' },
];

async function channelsCommand(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  const sub = interaction.options.getSubcommand();
  await perms.safeDefer(interaction, true);

  if (sub === 'list') {
    const lines = CHANNEL_KEYS.map(k => {
      const id = ids.channelId(k.value);
      return `${id ? '✅' : '⬜'} **${k.name}**: ${id ? `<#${id}>` : 'not set'}`;
    });
    return interaction.editReply(
      `${lines.join('\n')}\n\n` +
      `Change one with \`/channels set\`. Rebind before deleting any duplicate ` +
      `channel, otherwise the bot keeps pointing at a channel that is gone.`
        .slice(0, 1900));
  }

  if (sub === 'rematch') {
    // Forget every standing channel, then look again. Only useful once the
    // duplicates are deleted: a duplicate named exactly "leaderboard" matches
    // just as well as your "🏆 • leaderboard", and which one wins is luck.
    for (const spec of provision.STANDING_CHANNELS) {
      await ids.remember(`CHANNEL:${spec.key}`, null);
    }
    const { created, reused } = await provision.ensureStandingChannels(interaction.guild);

    // Panels were pointing at the old channels, so drop the stored message IDs
    // and post fresh ones wherever they now belong.
    const dbm = require('./db');
    for (const k of ['paymentsPanelMessageId', 'ticketPanelMessageId', 'leaderboardMessageId']) {
      await dbm.setMeta(k, null);
    }
    await require('./payments').ensurePanel(interaction.client);
    await require('./tickets').ensurePanel(interaction.client);
    await leaderboard.publish(interaction.client, { rebuild: false });

    return interaction.editReply(
      (reused.length ? `Now using your existing channels: ${reused.join(', ')}.\n` : '') +
      (created.length ? `Created because nothing matched: ${created.join(', ')}.\n` : '') +
      `Panels reposted. Check with \`/channels list\`.`);
  }

  const key = interaction.options.getString('what');
  const label = CHANNEL_KEYS.find(k => k.value === key)?.name || key;

  if (sub === 'clear') {
    await ids.remember(`CHANNEL:${key}`, null);
    return interaction.editReply(
      `**${label}** cleared. The next \`/setup\` will look for a matching channel ` +
      `or create one.`);
  }

  // set
  const channel = interaction.options.getChannel('channel');
  await ids.remember(`CHANNEL:${key}`, channel.id);

  // Repost whichever panel lives in the channel that just moved, so the change
  // is visible immediately rather than after the next restart.
  const panels = {
    PAYMENTS: () => require('./payments').ensurePanel(interaction.client),
    TICKETS: () => require('./tickets').ensurePanel(interaction.client),
    SUBMIT: () => require('./panel').ensurePanel(interaction.client),
    ONBOARDING: () => onboarding.ensurePanel(interaction.client),
    LEADERBOARD: () => leaderboard.publish(interaction.client, { rebuild: false }),
  };
  let posted = '';
  if (panels[key]) {
    // The stored message ID belongs to the old channel, so drop it first or the
    // bot edits the panel it left behind instead of posting a new one.
    const metaKeys = {
      PAYMENTS: 'paymentsPanelMessageId', TICKETS: 'ticketPanelMessageId',
      SUBMIT: 'submitPanelMessageId', ONBOARDING: 'onboardPanelMessageId',
      LEADERBOARD: 'leaderboardMessageId',
    };
    await require('./db').setMeta(metaKeys[key], null);
    await panels[key]();
    posted = ' Panel posted there.';
  }

  return interaction.editReply(`**${label}** now points at <#${channel.id}>.${posted}`);
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * `open_ticket` was the old single ticket button and is still sitting in panels
 * already posted in the server, so it forwards to the module that owns tickets
 * now rather than breaking for anyone who presses an old message.
 */
async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('admin:') && id !== 'open_ticket') return false;
  try {
    if (id === 'open_ticket') {
      await require('./tickets').open(interaction, 'general');
    } else return false;
  } catch (err) {
    console.error('[Admin] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('admin'));
  }
  return true;
}

module.exports = {
  migrateCore, lockdown, campaignCommand, createCampaign, setup, channelsCommand,
  promote, demote, coreNominations, dashboard, editorLookup,
  clearMaturedEarnings, route, CHANNEL_KEYS,
};
