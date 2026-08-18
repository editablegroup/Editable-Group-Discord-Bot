'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const perms = require('./permissions');
const campaigns = require('./campaigns');

/**
 * ============================================================================
 *  SUBMIT PANEL (#submit)
 * ============================================================================
 *  Four buttons: Submit Edit, My Submissions, Leaderboard, Campaign Status.
 *
 *  Submit Edit opens a dropdown of everything the member can currently submit
 *  to, then a modal for the link. Two steps rather than one because a member in
 *  four campaigns needs to say which one this edit is for, and guessing wrong
 *  pays them from the wrong pot.
 *
 *  The old custom IDs (submit_clip, view_submissions, leaderboard_button,
 *  campaign_status) are still routed, so panels already posted in the server
 *  keep working after this deploys.
 * ============================================================================
 */

const COMP = config.COMPETITION;

// ── Panel message ───────────────────────────────────────────────────────────

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(copy.submit.panelTitle)
    .setDescription(copy.submit.panelIntro())
    .addFields(
      { name: `📤 ${copy.submit.btnSubmit}`, value: copy.submit.fieldSubmit, inline: true },
      { name: `📊 ${copy.submit.btnMine}`, value: copy.submit.fieldMine, inline: true },
      { name: `🏆 ${copy.submit.btnBoard}`, value: copy.submit.fieldBoard, inline: true },
      { name: `📈 ${copy.submit.btnStatus}`, value: copy.submit.fieldStatus, inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('submit_clip')
      .setLabel(copy.submit.btnSubmit).setEmoji('📤').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('view_submissions')
      .setLabel(copy.submit.btnMine).setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('leaderboard_button')
      .setLabel(copy.submit.btnBoard).setEmoji('🏆').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('campaign_status')
      .setLabel(copy.submit.btnStatus).setEmoji('📈').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function ensurePanel(client) {
  try {
    const channelId = ids.channelId('SUBMIT');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const saved = await getMeta('submitPanelMessageId');
    if (saved) {
      const msg = await channel.messages.fetch(saved).catch(() => null);
      if (msg) { await msg.edit(buildPanelMessage()); return; }
    }
    const msg = await channel.send(buildPanelMessage());
    await setMeta('submitPanelMessageId', msg.id);
    console.log('[Panel] Submit panel posted');
  } catch (err) {
    console.error('[Panel] ensurePanel:', err.message);
  }
}

// ── Shared: what can this member submit to? ─────────────────────────────────

/**
 * The single source of truth for "which campaigns can this member see".
 * Used by the submit picker, the leaderboard picker and campaign status, so
 * they can never disagree with each other.
 */
async function accessibleCampaigns(member) {
  const list = await campaigns.listCampaigns({ status: 'active' });
  const compRole = ids.roleId('COMPETITION');
  return list.filter(c => c.type === 'competition'
    ? Boolean(compRole) && member.roles.cache.has(compRole)
    : perms.canAccessCampaign(member, c));
}

function optionFor(c) {
  return c.type === 'competition'
    ? { label: COMP.DROPDOWN_LABEL.slice(0, 100), value: c.value,
        description: 'Competition entry' }
    : { label: c.label.slice(0, 100), value: c.value,
        description: `$${(c.rpm || 0).toFixed(2)} per 1,000 views` };
}

function pickerRow(customId, list, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(list.slice(0, 25).map(optionFor))
  );
}

// ── Submit Edit ─────────────────────────────────────────────────────────────

async function handleSubmitButton(interaction) {
  if (!await perms.enforceCooldown(interaction, 'panelsubmit', 3000)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const list = await accessibleCampaigns(interaction.member);
  if (!list.length) return perms.safeReply(interaction, copy.submit.nothingOpen());

  return interaction.reply({
    content: copy.submit.pickerPrompt,
    components: [pickerRow('submit:pick', list, copy.submit.pickerPlaceholder)],
    flags: MessageFlags.Ephemeral,
  });
}

/** Campaign chosen. Open the link modal, reusing the campaigns.js modal ID. */
async function handlePick(interaction) {
  const value = interaction.values[0];
  const campaign = await campaigns.getCampaign(value);
  if (!campaign) return perms.safeReply(interaction, copy.campaign.notFound);
  if (!campaigns.isLive(campaign)) return perms.safeReply(interaction, copy.campaign.closed);

  const modal = new ModalBuilder()
    .setCustomId(`camp:submitmodal:${value}`)
    .setTitle(copy.submit.modalTitle.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('link').setLabel(copy.submit.modalLink)
          .setPlaceholder(copy.submit.modalLinkPlaceholder)
          .setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel(copy.submit.modalName)
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)),
    );
  await interaction.showModal(modal);
}

// ── My Submissions ──────────────────────────────────────────────────────────

async function handleMySubmissions(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const subs = await getDb().collection('submissions')
    .find({ userId: interaction.user.id }).sort({ submittedAt: -1 }).limit(25).toArray();
  if (!subs.length) return interaction.editReply(copy.submit.noSubmissions());

  const icon = { approved: '✅', pending: '⏳', rejected: '❌', flagged: '⚠️' };
  const approved = subs.filter(s => s.status === 'approved');
  const totals = approved.reduce(
    (a, s) => ({ v: a.v + (s.views || 0), e: a.e + (s.earnings || 0) }), { v: 0, e: 0 });

  // "Last updated at" comes from the newest lastUpdated across their approved
  // submissions, which is the number they are actually asking about.
  const newest = approved
    .map(s => s.lastUpdated && new Date(s.lastUpdated).getTime())
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  const when = newest ? `<t:${Math.floor(newest / 1000)}:R>` : null;

  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle(copy.submit.mineTitle)
    .setDescription(subs.slice(0, 15).map(s =>
      `${icon[s.status] || '•'} [${s.clipName}](${s.link}) ` +
      `${(s.views || 0).toLocaleString('en-US')} views` +
      (s.earnings ? ` · **$${s.earnings.toFixed(2)}**` : '')
    ).join('\n'))
    .addFields(
      { name: copy.submit.mineTotalViews, value: totals.v.toLocaleString('en-US'), inline: true },
      { name: copy.submit.mineTotalEarned, value: `$${totals.e.toFixed(2)}`, inline: true },
    );

  // Footer cannot render a Discord timestamp, so the relative time goes in the
  // description instead when we have one.
  if (when) {
    embed.setDescription(`${embed.data.description}\n\n${copy.submit.mineFooter(when)}`);
  } else {
    embed.setFooter({ text: copy.submit.mineFooter(null) });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function handleLeaderboard(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const list = await accessibleCampaigns(interaction.member);
  if (!list.length) return interaction.editReply(copy.campaign.statusNone());

  if (list.length === 1) {
    const embed = await campaigns.buildLeaderboardEmbed(list[0].value, interaction.user.id);
    return interaction.editReply({ embeds: [embed] });
  }

  return interaction.editReply({
    content: copy.leaderboard.pickPrompt,
    components: [pickerRow('panel:board', list, copy.leaderboard.pickPlaceholder)],
  });
}

async function handleBoardPick(interaction) {
  await interaction.deferUpdate().catch(() => {});
  const embed = await campaigns.buildLeaderboardEmbed(interaction.values[0], interaction.user.id);
  return interaction.editReply({ content: '', embeds: [embed], components: [] });
}

// ── Campaign Status ─────────────────────────────────────────────────────────

async function handleStatus(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const list = await accessibleCampaigns(interaction.member);
  if (!list.length) return interaction.editReply(copy.campaign.statusNone());

  const lines = [];
  for (const c of list) {
    const ends = Math.floor(new Date(c.endDate).getTime() / 1000);

    if (c.type === 'competition') {
      lines.push(
        `🏆 **${c.label}**\n` +
        `　${COMP.PRIZE_SUMMARY}\n` +
        `　Closes <t:${ends}:R>`);
      continue;
    }

    const b = await campaigns.budgetStatus(c);
    lines.push(
      `${c.tier === 'core' ? '⭐' : '🔓'} **${c.label}**\n` +
      `　$${c.rpm.toFixed(2)} per 1,000 views, max $${c.maxPayout} per video\n` +
      `　$${b.remaining.toFixed(2)} left of $${(c.budget || 0).toFixed(2)}\n` +
      `　Closes <t:${ends}:R>`);
  }

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(config.BRAND_COLOR)
      .setTitle(copy.campaign.statusTitle)
      .setDescription(lines.join('\n\n').slice(0, 4000))],
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

const KNOWN = new Set([
  'submit_clip', 'view_submissions', 'leaderboard_button', 'campaign_status',
  'submit:pick', 'panel:board',
]);

async function route(interaction) {
  const id = interaction.customId;
  if (!KNOWN.has(id)) return false;

  try {
    if (id === 'submit_clip') await handleSubmitButton(interaction);
    else if (id === 'view_submissions') await handleMySubmissions(interaction);
    else if (id === 'leaderboard_button') await handleLeaderboard(interaction);
    else if (id === 'campaign_status') await handleStatus(interaction);
    else if (id === 'submit:pick') await handlePick(interaction);
    else if (id === 'panel:board') await handleBoardPick(interaction);
  } catch (err) {
    console.error('[Panel] route:', err);
    await perms.safeReply(interaction, copy.common.errIn('submissions'));
  }
  return true;
}

// ── /submitpanel ────────────────────────────────────────────────────────────

async function command(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  await perms.safeDefer(interaction, true);
  try {
    await interaction.channel.send(buildPanelMessage());
    return interaction.editReply('Panel posted.');
  } catch (err) {
    console.error('[Panel] send:', err.message);
    return interaction.editReply(
      'Could not post here. The bot needs Send Messages and Embed Links in this channel.');
  }
}

module.exports = {
  route, command, buildPanelMessage, ensurePanel,
  accessibleCampaigns, handleMySubmissions, handleStatus,
};
