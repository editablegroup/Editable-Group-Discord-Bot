'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, ChannelType, PermissionFlagsBits,
} = require('discord.js');

const config = require('./config');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const tiktok = require('./tiktok');
const perms = require('./permissions');
const campaigns = require('./campaigns');
const provision = require('./provision');

/**
 * ============================================================================
 *  EDIT COMPETITION
 * ============================================================================
 *  Deliberately NOT a normal campaign:
 *    • no budget bar, no RPM, no committed-spend tracking
 *    • no 1st/2nd placement bonuses — winners are chosen by you, later
 *    • leaderboard shows posts and views only, no ranking medals
 *    • accepts TikTok, Instagram Reels and YouTube Shorts
 *
 *  Nothing here posts to a channel on its own. Everything goes through
 *  /comp preview first, and the @everyone ping is an explicit opt-in flag on
 *  /comp post. You will never accidentally ping the server from this file.
 * ============================================================================
 */

const COMP = config.COMPETITION;

// ── Panels ──────────────────────────────────────────────────────────────────

/** Public announcement — the one with Join / Leave. Goes in the public channel. */
function buildPublicPanel() {
  const d = COMP.DEADLINE_UNIX;
  const content =
    `🏆 **${COMP.TITLE}**\n\n` +
    `🥇 **Prizes:** ${COMP.PRIZE_SUMMARY_PLAIN}\n` +
    `\u2696\ufe0f **Judged on:** ${COMP.JUDGING}\n` +
    `📅 **Deadline:** <t:${d}:F> (<t:${d}:R>)\n` +
    `📱 **Platforms:** ${COMP.PLATFORMS.join(', ')}\n\n` +
    `**Brief:** ${COMP.BRIEF_SHORT}\n\n` +
    `👇 **JOIN BELOW TO ENTER**`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('comp:join')
      .setLabel('Join').setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('comp:leave')
      .setLabel('Leave').setStyle(ButtonStyle.Danger),
  );

  return { content, components: [row] };
}

/**
 * Only the public announcement is built by the bot, because it is the one that
 * carries the Join and Leave buttons and therefore has to be a bot message.
 *
 * The announcement, rules and chat channels inside the competition category are
 * written by hand. The bot creates the channels and stops there: rule text in
 * config would be a second copy of the rules that drifts out of step with the
 * one people actually read.
 */

// ── Submit dropdown (lives in the submit channel) ────────────────────────────

/**
 * One persistent dropdown listing everything the member can submit to.
 * Replaces per-campaign buttons scattered across channels.
 */
async function buildSubmitDropdown(member) {
  const list = await campaigns.listCampaigns({ status: 'active' });
  const options = [];

  for (const c of list) {
    if (c.type === 'competition') {
      const compRole = ids.roleId('COMPETITION');
      if (!member || !compRole || !member.roles.cache.has(compRole)) continue;
      options.push({
        label: COMP.DROPDOWN_LABEL.slice(0, 100),
        description: 'Submit your competition entry',
        value: c.value,
      });
    } else {
      if (member && !perms.canAccessCampaign(member, c)) continue;
      options.push({
        label: c.label.slice(0, 100),
        description: `$${c.rpm.toFixed(2)} per 1K views`,
        value: c.value,
      });
    }
  }

  if (!options.length) {
    options.push({ label: 'No campaigns open right now', value: 'none' });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('comp:pick')
      .setPlaceholder('Choose what to submit to…')
      .addOptions(options.slice(0, 25))
  );
}


/**
 * Refresh the submit panel.
 *
 * panel.js owns #submit now. Both modules used to write the same
 * `submitPanelMessageId` metadata key, so whichever ran last overwrote the
 * other's message and the two panels fought over the channel on every boot.
 * This delegates rather than posting a competing panel.
 */
async function ensureSubmitPanel(client) {
  return require('./panel').ensurePanel(client);
}

// ── Competition space (role + category + channels) ──────────────────────────

/**
 * Build the competition's private home: one role, one category only that role
 * can see, and the channels inside it.
 *
 * announcements and rules are read-only for entrants, chat is not. Staff keep
 * send access everywhere so you can write the rules once the channels exist.
 *
 * The role is matched by name so running this twice does not leave two
 * competition roles behind, and so a new competition never inherits the role
 * from the last one.
 */
async function createCompetitionSpace(guild) {
  const capability = provision.checkCapability(guild);
  if (!capability.ok) throw new Error(capability.problems.join(' '));

  const name = COMP.CATEGORY_NAME;

  // Role: matched by NAME, not by the ID in config.
  //
  // config.ROLES.COMPETITION still holds the role from the previous $1,000
  // competition. Reusing that would put this competition's entrants into the
  // old competition's role and category. Matching on the competition's own name
  // gives a fresh role per competition while still being safe to run twice.
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) {
    role = await guild.roles.create({
      name, mentionable: true, reason: 'Edit competition entrants',
    });
  }
  await ids.remember('ROLE:COMPETITION', role.id);

  const staffAllow = config.STAFF_IDS.map(id => ({
    id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ],
  }));

  // Reuse a category of the same name if one is already there, so running
  // /comp setup twice does not leave two competition categories behind.
  const existingCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === name);

  const category = existingCategory || await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: role.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      },
      ...staffAllow,
    ],
    reason: 'Edit competition',
  });

  const channels = {};
  for (const channelName of COMP.CHANNELS_TO_CREATE) {
    const readOnly = channelName !== 'chat';
    try {
      const already = guild.channels.cache.find(
        c => c.parentId === category.id && c.name === channelName);
      if (already) { channels[channelName] = already.id; continue; }

      const created = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            // Entrants read announcements and rules, they do not post in them.
            ...(readOnly
              ? { deny: [PermissionFlagsBits.SendMessages] }
              : { allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.AttachFiles,
                ] }),
          },
          ...staffAllow,
        ],
        reason: 'Edit competition',
      });
      channels[channelName] = created.id;
      await new Promise(r => setTimeout(r, 300)); // channel creation is rate limited
    } catch (err) {
      console.error(`[Comp] channel ${channelName}:`, err.message);
    }
  }

  const space = { roleId: role.id, categoryId: category.id, categoryName: name, channels };
  await getDb().collection('campaigns').updateOne(
    { value: COMP.VALUE }, { $set: { roleId: role.id, space } });
  return space;
}

// ── Join / Leave ────────────────────────────────────────────────────────────

async function handleJoin(interaction) {
  if (!await perms.enforceCooldown(interaction, 'compjoin', 3000)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const compRole = ids.roleId('COMPETITION');
  if (compRole && interaction.member.roles.cache.has(compRole)) {
    return perms.safeReply(interaction, 'You are already entered.');
  }

  const comp = await campaigns.getCampaign(COMP.VALUE);
  if (!comp || comp.status !== 'active') {
    return perms.safeReply(interaction, '⌛ The competition isn\'t open.');
  }
  if (Date.now() > COMP.DEADLINE_UNIX * 1000) {
    return perms.safeReply(interaction, 'The deadline has passed. Entries are closed.');
  }

  try {
    await interaction.member.roles.add(compRole, 'Joined competition');
  } catch (err) {
    console.error('[Comp] role add:', err.message);
    return perms.safeReply(interaction,
      'Could not give you the competition role, so the category stays locked. ' +
      'That is a permissions problem on our end. Ping a staff member.');
  }

  await getDb().collection('campaigns').updateOne(
    { value: COMP.VALUE }, { $inc: { participants: 1 } }
  );

  // Point at the channels /comp setup created rather than any hardcoded ID, so
  // this cannot send people to a category from a previous competition.
  const made = comp.space?.channels || {};
  const rules = made.rules ? `<#${made.rules}>` : 'the rules channel';
  const where = comp.space?.categoryName
    ? `The **${comp.space.categoryName}** category is now visible.`
    : 'The competition category is now visible.';

  return perms.safeReply(interaction,
    `🎉 **You're in the ${COMP.TITLE}.**\n` +
    `${COMP.PRIZE_SUMMARY_PLAIN}, judged on ${COMP.JUDGING.toLowerCase()}.\n` +
    `${where} Read ${rules} before you post.\n` +
    `Submit entries in <#${ids.channelId('SUBMIT')}>. Closes <t:${COMP.DEADLINE_UNIX}:R>.`);
}

async function handleLeave(interaction) {
  if (!await perms.enforceCooldown(interaction, 'compleave', 3000)) return;
  const compRoleId = ids.roleId('COMPETITION');
  if (!compRoleId || !interaction.member.roles.cache.has(compRoleId)) {
    return perms.safeReply(interaction, 'You\'re not entered.');
  }
  await interaction.member.roles.remove(compRoleId, 'Left competition').catch(() => {});
  await getDb().collection('campaigns').updateOne(
    { value: COMP.VALUE }, { $inc: { participants: -1 } }
  );
  return perms.safeReply(interaction,
    'You\'ve left the competition. Any entries you already submitted still stand — ' +
    'hit **Join** again if you change your mind.');
}

// ── Submission ──────────────────────────────────────────────────────────────

const PLATFORM_PATTERNS = {
  TikTok: /tiktok\.com/i,
};

function detectPlatform(url) {
  for (const [name, re] of Object.entries(PLATFORM_PATTERNS)) {
    if (re.test(url)) return name;
  }
  return null;
}

async function handlePick(interaction) {
  const value = interaction.values[0];
  if (value === 'none') {
    return perms.safeReply(interaction, 'Nothing is open for submissions right now.');
  }

  const campaign = await campaigns.getCampaign(value);
  if (!campaign) return perms.safeReply(interaction, '❌ That campaign no longer exists.');

  // Competition entries use their own modal (multi-platform, no budget checks).
  if (campaign.type === 'competition') {
    const entrantRole = ids.roleId('COMPETITION');
    if (!entrantRole || !interaction.member.roles.cache.has(entrantRole)) {
      return perms.safeReply(interaction,
        `❌ Join the competition first in <#${config.CHANNELS.COMP_ANNOUNCE_PUBLIC}>.`);
    }
    if (Date.now() > COMP.DEADLINE_UNIX * 1000) {
      return perms.safeReply(interaction, '⌛ The deadline has passed.');
    }
    const modal = new ModalBuilder()
      .setCustomId('comp:entrymodal')
      .setTitle('Competition Entry')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('link')
            .setLabel('Link to your edit')
            .setPlaceholder('TikTok')
            .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('name')
            .setLabel('Edit name (optional)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)),
      );
    return interaction.showModal(modal);
  }

  // Normal campaigns fall through to the existing flow.
  return campaigns.route({
    ...interaction,
    customId: `camp:submit:${value}`,
    showModal: interaction.showModal.bind(interaction),
  }).catch(() => perms.safeReply(interaction, '❌ Something went wrong.'));
}

async function handleEntryModal(interaction) {
  await perms.safeDefer(interaction, true);

  const rawLink = interaction.fields.getTextInputValue('link').trim();
  const clipName = (interaction.fields.getTextInputValue('name') || '').trim() || 'Untitled';

  if (Date.now() > COMP.DEADLINE_UNIX * 1000) {
    return perms.safeReply(interaction, '⌛ The deadline passed while you were submitting.');
  }

  const platform = detectPlatform(rawLink);
  if (!platform) {
    return perms.safeReply(interaction,
      '❌ That link isn\'t recognised. Entries must be a **TikTok**, ' +.');
  }

  const count = await getDb().collection('submissions').countDocuments({
    userId: interaction.user.id, campaignValue: COMP.VALUE, status: { $ne: 'rejected' },
  });
  if (COMP.MAX_ENTRIES > 0 && count >= COMP.MAX_ENTRIES) {
    return perms.safeReply(interaction,
      `❌ You've submitted the maximum of ${COMP.MAX_ENTRIES} entries.`);
  }

  // Only TikTok can be auto-verified — Instagram and YouTube get reviewed by hand.
  let videoId = null, views = 0, likes = 0, thumb = null, handle = null;
  if (platform === 'TikTok') {
    const details = await tiktok.getVideoDetails(rawLink);
    if (details.ok) {
      videoId = details.videoId; views = details.views; likes = details.likes;
      thumb = details.thumbnailUrl; handle = details.handle;
    }
  }

  const dupe = await getDb().collection('submissions').findOne({
    campaignValue: COMP.VALUE, link: rawLink.split('?')[0],
  });
  if (dupe) return perms.safeReply(interaction, '❌ That link is already entered.');

  let inserted;
  try {
    inserted = await getDb().collection('submissions').insertOne({
      userId: interaction.user.id,
      username: interaction.user.username,
      campaignValue: COMP.VALUE,
      campaignLabel: COMP.TITLE,
      clipName, platform,
      link: rawLink.split('?')[0],
      videoId, tiktokHandle: handle, thumbnailUrl: thumb,
      status: 'pending',
      views, likes, viewsAtSubmission: views,
      earnings: 0,
      submittedAt: new Date(), lastUpdated: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) return perms.safeReply(interaction, '❌ That link is already entered.');
    throw err;
  }

  const subId = inserted.insertedId.toString();
  const embed = new EmbedBuilder()
    .setColor(0xf5b800)
    .setTitle('🏆 Competition entry')
    .setDescription(`[${clipName}](${rawLink})`)
    .addFields(
      { name: 'Editor', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Platform', value: platform, inline: true },
      { name: 'Views', value: platform === 'TikTok' ? views.toLocaleString('en-US') : 'Manual', inline: true },
      { name: 'Entry #', value: String(count + 1), inline: true },
    )
    .setTimestamp();
  if (thumb) embed.setThumbnail(thumb);

  const reviewChannel = await interaction.client.channels.fetch(ids.channelId('SUBMISSIONS'));
  await reviewChannel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`camp:approve:${subId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`camp:reject:${subId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )],
  });

  return perms.safeReply(interaction,
    `✅ **Entry submitted** — [${clipName}](${rawLink})\n` +
    `Platform: **${platform}** · Entry #${count + 1}\n\n` +
    (platform === 'TikTok'
      ? 'Views update every 3 hours.'
}

// ── Leaderboard (posts only — no medals, no budget, no placements) ──────────

async function buildBoard(viewerId = null) {
  const rows = await getDb().collection('submissions').aggregate([
    { $match: { campaignValue: COMP.VALUE, status: 'approved' } },
    { $sort: { views: -1 } },
    { $group: {
        _id: '$userId', username: { $first: '$username' },
        views: { $max: '$views' }, posts: { $sum: 1 },
        bestLink: { $first: '$link' },
    }},
    { $sort: { views: -1 } },
    { $limit: 50 },
  ]).toArray();

  const [totals] = await getDb().collection('submissions').aggregate([
    { $match: { campaignValue: COMP.VALUE, status: { $in: ['approved', 'pending'] } } },
    { $group: { _id: null, posts: { $sum: 1 }, views: { $sum: '$views' },
                editors: { $addToSet: '$userId' } } },
  ]).toArray();

  const medal = i => ['🥇', '🥈', '🥉', '🏅'][i] || `\`${String(i + 1).padStart(2, ' ')}\``;
  const body = rows.slice(0, 20).map((r, i) =>
    `${medal(i)} **${r.username}** — [${r.views.toLocaleString('en-US')} views](${r.bestLink})` +
    (r.posts > 1 ? ` · ${r.posts} entries` : '')
  ).join('\n') || '_No approved entries yet._';

  const embed = new EmbedBuilder()
    .setColor(0xf5b800)
    .setTitle(`🏆 ${COMP.TITLE}`)
    .setDescription(body)
    .addFields(
      { name: 'Entries', value: String(totals?.posts || 0), inline: true },
      { name: 'Editors', value: String(totals?.editors?.length || 0), inline: true },
      { name: 'Total views', value: (totals?.views || 0).toLocaleString('en-US'), inline: true },
    )
    .setFooter({ text: 'Ranked by your best single entry. Final at the deadline.' })
    .setTimestamp();

  if (viewerId) {
    const idx = rows.findIndex(r => r._id === viewerId);
    embed.addFields({
      name: 'Your position',
      value: idx >= 0
        ? `**#${idx + 1}** — best entry ${rows[idx].views.toLocaleString('en-US')} views ` +
          `· ${rows[idx].posts} submitted`
        : 'No approved entries yet.',
    });
  }
  return embed;
}

// ── /comp command ───────────────────────────────────────────────────────────

const TARGETS = {
  public: {
    channel: () => ids.channelId('COMP_ANNOUNCE_PUBLIC'),
    build: buildPublicPanel,
    key: 'compPublicMsgId',
  },
};

async function command(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  const sub = interaction.options.getSubcommand();

  // ── preview: shows it to you only. Never pings. ──
  if (sub === 'preview') {
    await perms.safeDefer(interaction, true);
    const which = interaction.options.getString('panel');
    const target = TARGETS[which];
    const payload = target.build();
    const header = `─── **PREVIEW: \`${which}\`** → <#${target.channel()}> ───\n\n`;
    return interaction.editReply({
      content: header + (payload.content || '_(embed only, see below)_'),
      embeds: payload.embeds || [],
      components: payload.components || [],
    });
  }

  // ── setup: create the competition record ──
  if (sub === 'setup') {
    await perms.safeDefer(interaction, true);
    await getDb().collection('campaigns').updateOne(
      { value: COMP.VALUE },
      { $set: {
          value: COMP.VALUE, label: COMP.TITLE, type: 'competition',
          tier: 'network', status: 'active',
          rpm: 0, maxPayout: 0, minViews: 0, budget: 0,
          hideBudget: true, hidePlacements: true,
          endDate: new Date(COMP.DEADLINE_UNIX * 1000),
          brief: COMP.BRIEF_FULL, createdAt: new Date(),
      }},
      { upsert: true }
    );
    await ensureSubmitPanel(interaction.client);

    let spaceLine;
    try {
      const space = await createCompetitionSpace(interaction.guild);
      const made = Object.keys(space.channels);
      spaceLine =
        `Created the **${space.categoryName}** role and category with ` +
        `${made.length} channels (${made.join(', ')}). ` +
        `Pressing Join grants the role and unlocks it.\n` +
        `announcements and rules are read-only for entrants. Staff can post in both, ` +
        `so write the rules there now.`;
    } catch (err) {
      spaceLine = `The competition exists but its role and category were not created: ${err.message}`;
    }

    const announce = ids.channelId('COMP_ANNOUNCE_PUBLIC');
    return interaction.editReply((
      `**${COMP.TITLE}** is set up. ${COMP.PRIZE_SUMMARY_PLAIN}. ` +
      `Closes <t:${COMP.DEADLINE_UNIX}:F>.\n` +
      `${spaceLine}\n` +
      `The submit dropdown is live in <#${ids.channelId('SUBMIT')}>.\n\n` +
      `Check the announcement with \`/comp preview panel:public\`, then post it to ` +
      `${announce ? `<#${announce}>` : 'the announcement channel'} with ` +
      `\`/comp post panel:public\`.`).slice(0, 1900));
  }

  // ── post: actually publishes ──
  if (sub === 'post') {
    await perms.safeDefer(interaction, true);
    const which = interaction.options.getString('panel');
    const ping = interaction.options.getBoolean('ping') ?? false;
    const target = TARGETS[which];

    // ids.channelId returns null rather than a SET_ME placeholder, so a missing
    // channel is a null check rather than a string prefix test.
    const channelId = target.channel();
    if (!channelId) {
      return interaction.editReply(
        `No channel is set for the ${which} announcement. ` +
        'Set CHANNELS.COMP_ANNOUNCE_PUBLIC in config.js.');
    }

    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return interaction.editReply(`❌ Can't reach <#${channelId}>.`);

    const payload = target.build();
    const base = payload.content || '';
    const body = {
      content: ping ? (base ? `@everyone\n\n${base}` : '@everyone') : base,
      embeds: payload.embeds || [],
      components: payload.components || [],
      allowedMentions: ping ? { parse: ['everyone'] } : { parse: [] },
    };

    const saved = await getMeta(target.key);
    if (saved) {
      const existing = await channel.messages.fetch(saved).catch(() => null);
      if (existing) {
        await existing.edit(body);
        return interaction.editReply(`✅ Updated the existing \`${which}\` panel: ${existing.url}`);
      }
    }

    const msg = await channel.send(body);
    await setMeta(target.key, msg.id);
    return interaction.editReply(
      `✅ Posted \`${which}\` ${ping ? '**with an @everyone ping**' : 'silently (no ping)'}: ${msg.url}`);
  }

  // ── board ──
  if (sub === 'board') {
    await perms.safeDefer(interaction, true);
    return interaction.editReply({ embeds: [await buildBoard(interaction.user.id)] });
  }

  // ── close ──
  if (sub === 'close') {
    await perms.safeDefer(interaction, true);
    await getDb().collection('campaigns').updateOne(
      { value: COMP.VALUE }, { $set: { status: 'ended', endedAt: new Date() } });
    await ensureSubmitPanel(interaction.client);
    return interaction.editReply('✅ Competition closed. It\'s been removed from the submit dropdown.');
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('comp:')) return false;
  try {
    if (id === 'comp:join') await handleJoin(interaction);
    else if (id === 'comp:leave') await handleLeave(interaction);
    else if (id === 'comp:pick') await handlePick(interaction);
    else if (id === 'comp:entrymodal') await handleEntryModal(interaction);
    else return false;
  } catch (err) {
    console.error('[Comp] route:', err);
    await perms.safeReply(interaction, '❌ Something went wrong. Try again.');
  }
  return true;
}

module.exports = {
  command, route, ensureSubmitPanel, buildSubmitDropdown, buildBoard,
  buildPublicPanel, createCompetitionSpace,
};
