'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelType, MessageFlags,
} = require('discord.js');

const config = require('./config');
const { getDb } = require('./db');
const perms = require('./permissions');
const campaigns = require('./campaigns');
const tiktok = require('./tiktok');
const onboarding = require('./onboarding');

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
  if (config.ROLES.CORE.startsWith('SET_ME')) {
    return perms.safeReply(interaction, '❌ Set `ROLES.CORE` in config.js first.');
  }
  await perms.safeDefer(interaction, true);

  const guild = interaction.guild;
  const members = await guild.members.fetch(); // one-off full fetch; fine here
  const legacy = members.filter(m =>
    m.roles.cache.has(config.ROLES.LEGACY_EDITOR) && !m.roles.cache.has(config.ROLES.CORE)
  );

  await interaction.editReply(`Migrating ${legacy.size} members to Core…`);

  let ok = 0, fail = 0;
  for (const [, member] of legacy) {
    try {
      await member.roles.add(config.ROLES.CORE, 'Legacy hand-picked editor → Core');
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
    `✅ Migration complete — **${ok}** granted Core, ${fail} failed.\n\n` +
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
      if (channel.id === config.CHANNELS.ONBOARDING) {
        await channel.permissionOverwrites.edit(everyone, {
          ViewChannel: true, SendMessages: false, ReadMessageHistory: true,
          AddReactions: false, CreatePublicThreads: false,
        });
        results.push(`✅ #${channel.name} — visible to everyone, read-only`);
      } else {
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: false });
        if (channel.id === config.CHANNELS.CORE_CAMPAIGNS && !config.ROLES.CORE.startsWith('SET_ME')) {
          await channel.permissionOverwrites.edit(config.ROLES.CORE, { ViewChannel: true });
          results.push(`⭐ #${channel.name} — Core only`);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      results.push(`❌ #${channel.name} — ${err.message}`);
    }
  }

  const text = results.join('\n').slice(0, 3900);
  await interaction.editReply(
    `**Lockdown applied**\n\n${text}\n\n` +
    `⚠️ Now grant the **Network** role \`View Channel\` on the channels editors should see. ` +
    `The bot deliberately does not guess which those are.`);
}

// ── /campaign create|edit|post|end ──────────────────────────────────────────

async function campaignCommand(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const modal = new ModalBuilder()
      .setCustomId('admin:campcreate')
      .setTitle('New Campaign')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('label').setLabel('Track name — Artist')
          .setPlaceholder('TAKE RISKS - thekidszn')
          .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('economics').setLabel('RPM / maxPayout / minViews / budget')
          .setPlaceholder('1.00 / 350 / 1500 / 1000')
          .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('tier').setLabel('Tier: core or network')
          .setPlaceholder('network')
          .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('days').setLabel('Runs for how many days?')
          .setPlaceholder('14')
          .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('brief').setLabel('Creative brief')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
      );
    return interaction.showModal(modal);
  }

  await perms.safeDefer(interaction, true);
  const value = interaction.options.getString('campaign');
  const campaign = await campaigns.getCampaign(value);
  if (!campaign) return interaction.editReply('❌ Campaign not found.');

  if (sub === 'post') {
    try {
      const msg = await campaigns.postOffer(interaction.client, campaign);
      return interaction.editReply(`✅ Posted: ${msg.url}`);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  }

  if (sub === 'end') {
    await getDb().collection('campaigns').updateOne(
      { value }, { $set: { status: campaigns.STATUS.ENDED, endedAt: new Date() } });
    await campaigns.rebuildLeaderboard(value);
    return interaction.editReply(`✅ **${campaign.label}** ended. Leaderboard frozen.`);
  }

  if (sub === 'budget') {
    const amount = interaction.options.getNumber('amount');
    await getDb().collection('campaigns').updateOne({ value }, { $set: { budget: amount } });
    const status = await campaigns.budgetStatus({ ...campaign, budget: amount });
    return interaction.editReply(
      `✅ Budget for **${campaign.label}** set to $${amount}.\n` +
      `Committed: $${status.spent.toFixed(2)} · Remaining: $${status.remaining.toFixed(2)}`);
  }
}

async function handleCampaignCreateModal(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const label = interaction.fields.getTextInputValue('label').trim();
  const economics = interaction.fields.getTextInputValue('economics').split('/').map(s => parseFloat(s.trim()));
  const tier = interaction.fields.getTextInputValue('tier').trim().toLowerCase();
  const days = parseInt(interaction.fields.getTextInputValue('days').trim(), 10);
  const brief = interaction.fields.getTextInputValue('brief').trim();

  const [rpm, maxPayout, minViews, budget] = economics;
  if ([rpm, maxPayout, minViews, budget].some(n => !Number.isFinite(n))) {
    return interaction.editReply('❌ Economics must be four numbers: `RPM / maxPayout / minViews / budget`');
  }
  if (!['core', 'network', 'all'].includes(tier)) {
    return interaction.editReply('❌ Tier must be `core` or `network`.');
  }

  const value = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (await campaigns.getCampaign(value)) {
    return interaction.editReply(`❌ A campaign with the key \`${value}\` already exists.`);
  }

  const endDate = new Date(Date.now() + days * 86_400_000);
  await getDb().collection('campaigns').insertOne({
    value, label, tier, rpm, maxPayout, minViews, budget, brief,
    endDate, status: campaigns.STATUS.ACTIVE,
    participants: 0, createdAt: new Date(), createdBy: interaction.user.id,
  });

  await interaction.editReply(
    `✅ Created **${label}** (\`${value}\`)\n` +
    `${tier === 'core' ? '⭐ Core only' : '🔓 Open to Network'} · $${rpm}/1K · cap $${maxPayout} · ` +
    `budget $${budget} · ends <t:${Math.floor(endDate.getTime() / 1000)}:R>\n\n` +
    `Post it with \`/campaign post campaign:${value}\``);
}

// ── Core promotion ──────────────────────────────────────────────────────────

async function promote(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'Performance';
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.editReply('❌ Not in the server.');
  if (member.roles.cache.has(config.ROLES.CORE)) return interaction.editReply('Already Core.');

  await member.roles.add(config.ROLES.CORE, `Promoted by ${interaction.user.tag}: ${reason}`);
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
    `⭐ <@${user.id}> promoted to **Core** by <@${interaction.user.id}> — ${reason}`);
  return interaction.editReply(`✅ <@${user.id}> is now Core.`);
}

async function demote(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);
  const user = interaction.options.getUser('user');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.editReply('❌ Not in the server.');
  await member.roles.remove(config.ROLES.CORE, `Demoted by ${interaction.user.tag}`).catch(() => {});
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
    if (!member || member.roles.cache.has(config.ROLES.CORE)) continue;
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
    .setTitle('Editable Group — Operations')
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
  if (!editor) return interaction.editReply('No profile — they haven\'t onboarded.');

  const subs = await db.collection('submissions')
    .find({ userId: user.id }).sort({ submittedAt: -1 }).limit(50).toArray();
  const approved = subs.filter(s => s.status === 'approved');
  const totalViews = approved.reduce((n, s) => n + (s.views || 0), 0);
  const totalEarned = approved.reduce((n, s) => n + (s.earnings || 0), 0);

  const embed = new EmbedBuilder()
    .setColor(editor.tier === config.TIERS.CORE ? 0xf5b800 : config.BRAND_COLOR)
    .setTitle(`${editor.tier === config.TIERS.CORE ? '⭐ ' : ''}${editor.username}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'TikTok', value: editor.tiktokHandle ? `[@${editor.tiktokHandle}](https://www.tiktok.com/@${editor.tiktokHandle})` : '—', inline: true },
      { name: 'Tier', value: editor.tier || 'network', inline: true },
      { name: 'Joined', value: `<t:${Math.floor(new Date(editor.joinedAt).getTime() / 1000)}:R>`, inline: true },
      { name: 'Genres', value: (editor.genres || []).join(', ') || '—', inline: false },
      { name: 'Styles', value: (editor.styles || []).join(', ') || '—', inline: false },
      { name: 'Performance', value:
        `${approved.length} approved / ${subs.length} submitted\n` +
        `${totalViews.toLocaleString('en-US')} views · $${totalEarned.toFixed(2)} earned`, inline: false },
      { name: 'Payment', value:
        editor.paymentMethod === 'paypal' ? `PayPal — ${editor.paypalEmail}`
        : editor.paymentMethod === 'crypto' ? `Crypto — \`${editor.cryptoWallet}\``
        : editor.paymentMethod || '—', inline: false },
    );
  return interaction.editReply({ embeds: [embed] });
}

// ── Payouts ─────────────────────────────────────────────────────────────────

async function balance(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const rows = await getDb().collection('earnings')
    .find({ userId: interaction.user.id }).toArray();
  const pending = rows.filter(r => r.state === 'pending').reduce((n, r) => n + r.amount, 0);
  const cleared = rows.filter(r => r.state === 'cleared').reduce((n, r) => n + r.amount, 0);
  const paid = rows.filter(r => r.state === 'paid').reduce((n, r) => n + r.amount, 0);

  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle('Your balance')
    .addFields(
      { name: '💵 Available', value: `$${cleared.toFixed(2)}`, inline: true },
      { name: '⏳ Pending', value: `$${pending.toFixed(2)}`, inline: true },
      { name: '✅ Paid out', value: `$${paid.toFixed(2)}`, inline: true },
    )
    .setFooter({ text:
      `Pending clears ${config.PAYOUTS.CLEARING_DAYS} days after a campaign ends. ` +
      `Minimum payout $${config.PAYOUTS.MINIMUM_USD}.` });

  const components = cleared >= config.PAYOUTS.MINIMUM_USD
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin:payout').setLabel('Request Payout')
          .setEmoji('💸').setStyle(ButtonStyle.Success))]
    : [];

  return interaction.editReply({ embeds: [embed], components });
}

async function requestPayout(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const db = getDb();
  const open = await db.collection('payoutRequests')
    .findOne({ userId: interaction.user.id, status: 'pending' });
  if (open) return interaction.editReply('You already have a payout request open.');

  const rows = await db.collection('earnings')
    .find({ userId: interaction.user.id, state: 'cleared' }).toArray();
  const cleared = rows.reduce((n, r) => n + r.amount, 0);
  if (cleared < config.PAYOUTS.MINIMUM_USD) {
    return interaction.editReply(
      `Minimum payout is $${config.PAYOUTS.MINIMUM_USD}. You have $${cleared.toFixed(2)} available.`);
  }

  const editor = await db.collection('editors').findOne({ userId: interaction.user.id });
  await db.collection('payoutRequests').insertOne({
    userId: interaction.user.id,
    username: interaction.user.username,
    amount: cleared,
    method: editor?.paymentMethod,
    destination: editor?.paypalEmail || editor?.cryptoWallet || 'bank (see ticket)',
    status: 'pending',
    createdAt: new Date(),
  });

  await campaigns.alert(interaction.client,
    `💸 **Payout request** — <@${interaction.user.id}> requested **$${cleared.toFixed(2)}** ` +
    `via ${editor?.paymentMethod || 'unset'}.`);
  return interaction.editReply(
    `✅ Requested **$${cleared.toFixed(2)}**. You'll get a DM once it's sent.`);
}

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

// ── Tickets ─────────────────────────────────────────────────────────────────

async function openTicket(interaction) {
  if (!await perms.enforceCooldown(interaction, 'ticket', 30_000)) return;
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const db = getDb();
  const existing = await db.collection('tickets')
    .findOne({ userId: interaction.user.id, status: 'open' });
  if (existing) {
    const ch = await interaction.client.channels.fetch(existing.channelId).catch(() => null);
    if (ch) return interaction.editReply(`You already have a ticket open: <#${ch.id}>`);
    await db.collection('tickets').updateOne({ _id: existing._id }, { $set: { status: 'closed' } });
  }

  // Ticket channels are capped at 500 per guild. Track and warn before you hit
  // the wall mid-launch and channel creation starts failing silently.
  const openCount = await db.collection('tickets').countDocuments({ status: 'open' });
  if (openCount >= 150) {
    await campaigns.alert(interaction.client,
      `⚠️ **${openCount} tickets open.** Discord caps a server at 500 channels. Close some.`);
  }

  try {
    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90),
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        ...config.STAFF_IDS.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ],
    });

    await db.collection('tickets').insertOne({
      userId: interaction.user.id, username: interaction.user.username,
      channelId: channel.id, status: 'open', createdAt: new Date(),
    });

    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [new EmbedBuilder().setColor(config.BRAND_COLOR)
        .setTitle('Ticket opened')
        .setDescription('Describe your issue and a staff member will reply. Use `/close` when done.')],
    });
    return interaction.editReply(`✅ Ticket created: <#${channel.id}>`);
  } catch (err) {
    console.error('[Ticket]', err.message);
    return interaction.editReply('❌ Couldn\'t create a ticket. Check the bot has **Manage Channels**.');
  }
}

async function closeTicket(interaction) {
  const db = getDb();
  const ticket = await db.collection('tickets').findOne({ channelId: interaction.channelId, status: 'open' });
  if (!ticket) return perms.safeReply(interaction, '❌ This isn\'t an open ticket channel.');
  if (ticket.userId !== interaction.user.id && !perms.isStaff(interaction.user.id)) {
    return perms.safeReply(interaction, '❌ Only the ticket owner or staff can close this.');
  }
  await db.collection('tickets').updateOne({ _id: ticket._id },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: interaction.user.id } });
  await interaction.reply({ content: '🔒 Closing in 5 seconds…' });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('admin:') && id !== 'open_ticket') return false;
  try {
    if (id === 'open_ticket') await openTicket(interaction);
    else if (id === 'admin:payout') await requestPayout(interaction);
    else if (id === 'admin:campcreate') await handleCampaignCreateModal(interaction);
    else return false;
  } catch (err) {
    console.error('[Admin] route error:', err);
    await perms.safeReply(interaction, '❌ Something went wrong.');
  }
  return true;
}

module.exports = {
  migrateCore, lockdown, campaignCommand, handleCampaignCreateModal,
  promote, demote, coreNominations, dashboard, editorLookup,
  balance, requestPayout, clearMaturedEarnings,
  openTicket, closeTicket, route,
};
