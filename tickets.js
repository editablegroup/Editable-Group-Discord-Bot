'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const perms = require('./permissions');

/**
 * ============================================================================
 *  TICKETS
 * ============================================================================
 *  Five categories, matching the panel in screenshot 8. The category is not
 *  decoration: it sets the channel name prefix and decides whether staff get
 *  pinged straight away, so a payment problem does not sit behind six general
 *  questions.
 *
 *  The old build posted its ticket panel into #logs, which members cannot see.
 *  Nobody could open a ticket at all. This one refuses to post anywhere except
 *  a channel resolved through ids.js, so that failure mode cannot repeat.
 * ============================================================================
 */

const CATEGORIES = config.TICKET_CATEGORIES;

function categoryByValue(value) {
  return CATEGORIES.find(c => c.value === value) || null;
}

// ── Panel ───────────────────────────────────────────────────────────────────

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(copy.tickets.panelTitle)
    .setDescription(copy.tickets.panelIntro)
    .addFields(CATEGORIES.map(c => ({
      name: `${c.emoji} ${c.label}`,
      value: c.blurb,
      inline: false,
    })));

  // Five buttons fit on one row.
  const row = new ActionRowBuilder().addComponents(
    CATEGORIES.slice(0, 5).map(c =>
      new ButtonBuilder()
        .setCustomId(`ticket:open:${c.value}`)
        .setLabel(c.label)
        .setEmoji(c.emoji)
        .setStyle(c.staffOnlyPing ? ButtonStyle.Danger : ButtonStyle.Secondary))
  );

  return { embeds: [embed], components: [row] };
}

async function ensurePanel(client) {
  try {
    const channelId = ids.channelId('TICKETS');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const saved = await getMeta('ticketPanelMessageId');
    if (saved) {
      const msg = await channel.messages.fetch(saved).catch(() => null);
      if (msg) { await msg.edit(buildPanelMessage()); return; }
    }
    const msg = await channel.send(buildPanelMessage());
    await msg.pin().catch(() => {});
    await setMeta('ticketPanelMessageId', msg.id);
    console.log('[Tickets] Panel posted');
  } catch (err) {
    console.error('[Tickets] ensurePanel:', err.message);
  }
}

// ── Open ────────────────────────────────────────────────────────────────────

async function open(interaction, categoryValue) {
  if (!await perms.enforceCooldown(interaction, 'ticket', 5000)) return;
  await perms.safeDefer(interaction, true);

  const category = categoryByValue(categoryValue);
  if (!category) return interaction.editReply(copy.common.errIn('tickets'));

  // One open ticket per person, otherwise a frustrated member opens six.
  const existing = await getDb().collection('tickets')
    .findOne({ userId: interaction.user.id, status: 'open' });
  if (existing) {
    const stillThere = await interaction.guild.channels
      .fetch(existing.channelId).catch(() => null);
    if (stillThere) return interaction.editReply(copy.tickets.alreadyOpen(existing.channelId));
    // Channel was deleted by hand. Close the record and let them open a new one.
    await getDb().collection('tickets').updateOne(
      { _id: existing._id }, { $set: { status: 'closed', closedAt: new Date() } });
  }

  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  for (const staffId of config.STAFF_IDS) {
    overwrites.push({
      id: staffId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  try {
    const parent = ids.channelId('TICKETS_CATEGORY');
    const channel = await interaction.guild.channels.create({
      name: `${category.value}-${interaction.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: parent || undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket: ${category.label}`,
    });

    await getDb().collection('tickets').insertOne({
      userId: interaction.user.id,
      username: interaction.user.username,
      channelId: channel.id,
      category: category.value,
      categoryLabel: category.label,
      status: 'open',
      createdAt: new Date(),
    });

    // Ping staff immediately on the categories where waiting costs money or
    // lets a problem continue.
    const ping = category.staffOnlyPing
      ? config.STAFF_IDS.map(id => `<@${id}>`).join(' ')
      : '';

    await channel.send({
      content: `<@${interaction.user.id}> ${ping}`.trim(),
      embeds: [new EmbedBuilder()
        .setColor(config.BRAND_COLOR)
        .setTitle(`${category.emoji} ${category.label}`)
        .setDescription(copy.tickets.openedHeader(category.label))],
    });

    return interaction.editReply(copy.tickets.created(channel.id));
  } catch (err) {
    console.error('[Tickets] create:', err.message);
    return interaction.editReply(copy.tickets.createFailed);
  }
}

// ── Close ───────────────────────────────────────────────────────────────────

async function close(interaction) {
  const ticket = await getDb().collection('tickets')
    .findOne({ channelId: interaction.channelId, status: 'open' });
  if (!ticket) return perms.safeReply(interaction, copy.tickets.notATicket);

  if (ticket.userId !== interaction.user.id && !perms.isStaff(interaction.user.id)) {
    return perms.safeReply(interaction, copy.tickets.notYourTicket);
  }

  await getDb().collection('tickets').updateOne(
    { _id: ticket._id },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: interaction.user.id } }
  );

  await interaction.reply({ content: copy.tickets.closingIn });
  setTimeout(() => {
    interaction.channel.delete('Ticket closed').catch(() => {});
  }, 5000);
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('ticket:')) return false;

  try {
    if (id.startsWith('ticket:open:')) await open(interaction, id.split(':')[2]);
    else return false;
  } catch (err) {
    console.error('[Tickets] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('tickets'));
  }
  return true;
}

module.exports = { ensurePanel, buildPanelMessage, open, close, route, CATEGORIES };
