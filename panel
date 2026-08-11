'use strict';

const {
  ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const config = require('./config');
const { getDb } = require('./db');
const perms = require('./permissions');
const campaigns = require('./campaigns');

/**
 * ============================================================================
 *  LEGACY SUBMIT PANEL
 * ============================================================================
 *  Handlers for the original four-button panel already posted in #submit.
 *  These custom IDs (submit_clip, view_submissions, leaderboard_button,
 *  campaign_status) lived in the old single-file bot and had no home after the
 *  refactor, which is why the buttons timed out.
 *
 *  Submit Edit now opens a dropdown listing everything the member can submit
 *  to — normal campaigns plus the competition, if they've joined it.
 * ============================================================================
 */

const COMP = config.COMPETITION;

/** Build the campaign picker for a given member. */
async function buildPicker(member) {
  const list = await campaigns.listCampaigns({ status: 'active' });
  const options = [];

  for (const c of list) {
    if (c.type === 'competition') {
      // Competition only shows for people who actually joined it.
      if (!member.roles.cache.has(config.ROLES.COMPETITION)) continue;
      options.push({
        label: COMP.DROPDOWN_LABEL.slice(0, 100),
        description: 'Submit your competition entry',
        value: c.value,
      });
    } else {
      if (!perms.canAccessCampaign(member, c)) continue;
      options.push({
        label: c.label.slice(0, 100),
        description: `$${(c.rpm || 0).toFixed(2)} per 1K views`,
        value: c.value,
      });
    }
  }

  if (!options.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('comp:pick')
      .setPlaceholder('Choose what to submit to…')
      .addOptions(options.slice(0, 25))
  );
}

// ── Submit Edit ─────────────────────────────────────────────────────────────

async function handleSubmitButton(interaction) {
  if (!await perms.enforceCooldown(interaction, 'panelsubmit', 3000)) return;
  if (!await perms.requireOnboarded(interaction)) return;

  const row = await buildPicker(interaction.member);
  if (!row) {
    return perms.safeReply(interaction,
      'Nothing is open for you to submit to right now.\n\n' +
      `If you're entering the competition, join it first in ` +
      `<#${config.CHANNELS.COMP_ANNOUNCE_PUBLIC}>.`);
  }

  return interaction.reply({
    content: '**What are you submitting to?**',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

// ── My Submissions ──────────────────────────────────────────────────────────

async function handleMySubmissions(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const subs = await getDb().collection('submissions')
    .find({ userId: interaction.user.id }).sort({ submittedAt: -1 }).limit(25).toArray();
  if (!subs.length) return interaction.editReply('📭 No submissions yet.');

  const icon = { approved: '✅', pending: '⏳', rejected: '❌', flagged: '⚠️' };
  const approved = subs.filter(s => s.status === 'approved');
  const totals = approved.reduce(
    (a, s) => ({ v: a.v + (s.views || 0), e: a.e + (s.earnings || 0) }), { v: 0, e: 0 });

  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle('Your submissions')
    .setDescription(subs.slice(0, 15).map(s =>
      `${icon[s.status] || '•'} [${s.clipName}](${s.link}) — ` +
      `${(s.views || 0).toLocaleString('en-US')} views` +
      (s.earnings ? ` · **$${s.earnings.toFixed(2)}**` : '')
    ).join('\n'))
    .addFields(
      { name: 'Total views', value: totals.v.toLocaleString('en-US'), inline: true },
      { name: 'Total earned', value: `$${totals.e.toFixed(2)}`, inline: true },
    )
    .setFooter({ text: 'Views refresh every 12 hours' });

  return interaction.editReply({ embeds: [embed] });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function handleLeaderboard(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const list = (await campaigns.listCampaigns({ status: 'active' }))
    .filter(c => c.type === 'competition'
      ? interaction.member.roles.cache.has(config.ROLES.COMPETITION)
      : perms.canAccessCampaign(interaction.member, c));

  if (!list.length) return interaction.editReply('No campaigns to show yet.');

  // Only one thing open — skip the picker.
  if (list.length === 1) {
    const embed = await campaigns.buildLeaderboardEmbed(list[0].value, interaction.user.id);
    return interaction.editReply({ embeds: [embed] });
  }

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel:board')
      .setPlaceholder('Pick a campaign…')
      .addOptions(list.slice(0, 25).map(c => ({
        label: (c.type === 'competition' ? COMP.DROPDOWN_LABEL : c.label).slice(0, 100),
        value: c.value,
      })))
  );
  return interaction.editReply({ content: '**Which leaderboard?**', components: [row] });
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

  const list = (await campaigns.listCampaigns({ status: 'active' }))
    .filter(c => c.type === 'competition'
      ? interaction.member.roles.cache.has(config.ROLES.COMPETITION)
      : perms.canAccessCampaign(interaction.member, c));

  if (!list.length) return interaction.editReply('No active campaigns right now.');

  const lines = [];
  for (const c of list) {
    const ends = Math.floor(new Date(c.endDate).getTime() / 1000);

    if (c.type === 'competition') {
      lines.push(
        `🏆 **${c.label}**\n` +
        `　${COMP.PRIZE_SUMMARY}\n` +
        `　Ends <t:${ends}:R>`);
      continue;
    }

    const b = await campaigns.budgetStatus(c);
    lines.push(
      `${c.tier === 'core' ? '⭐' : '🔓'} **${c.label}**\n` +
      `　$${c.rpm.toFixed(2)}/1K · cap $${c.maxPayout} · ` +
      `${Math.round(100 - b.percentUsed)}% budget left\n` +
      `　Ends <t:${ends}:R>`);
  }

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(config.BRAND_COLOR)
      .setTitle('📈 Active campaigns')
      .setDescription(lines.join('\n\n'))],
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  const known = ['submit_clip', 'view_submissions', 'leaderboard_button', 'campaign_status'];
  if (!known.includes(id) && id !== 'panel:board') return false;

  try {
    if (id === 'submit_clip') await handleSubmitButton(interaction);
    else if (id === 'view_submissions') await handleMySubmissions(interaction);
    else if (id === 'leaderboard_button') await handleLeaderboard(interaction);
    else if (id === 'campaign_status') await handleStatus(interaction);
    else if (id === 'panel:board') await handleBoardPick(interaction);
  } catch (err) {
    console.error('[Panel] route:', err);
    await perms.safeReply(interaction, '❌ Something went wrong. Try again.');
  }
  return true;
}

module.exports = { route, buildPicker };
