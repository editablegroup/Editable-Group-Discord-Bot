'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const perms = require('./permissions');

/**
 * ============================================================================
 *  PAYMENTS PANEL (#payments)
 * ============================================================================
 *  Two buttons: Manage Payment Methods, and Check Balance.
 *
 *  The gap this closes: onboarding took a PayPal address once and there was no
 *  way to change it afterwards. Someone whose PayPal is wrong had no route to
 *  fixing it short of opening a ticket, which is a support load you do not need
 *  and a payout that goes to the wrong address in the meantime.
 * ============================================================================
 */

// ── Panel ───────────────────────────────────────────────────────────────────

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(copy.payments.panelTitle)
    .setDescription(copy.payments.panelIntro())
    .addFields(
      { name: `💳 ${copy.payments.btnManage}`, value: copy.payments.fieldManage, inline: true },
      { name: `💰 ${copy.payments.btnBalance}`, value: copy.payments.fieldBalance, inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pay:manage')
      .setLabel(copy.payments.btnManage).setEmoji('💳').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pay:balance')
      .setLabel(copy.payments.btnBalance).setEmoji('💰').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

/** One persistent panel, edited in place. Safe to call on every boot. */
async function ensurePanel(client) {
  try {
    const channelId = ids.channelId('PAYMENTS');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const saved = await getMeta('paymentsPanelMessageId');
    if (saved) {
      const msg = await channel.messages.fetch(saved).catch(() => null);
      if (msg) { await msg.edit(buildPanelMessage()); return; }
    }
    const msg = await channel.send(buildPanelMessage());
    await msg.pin().catch(() => {});
    await setMeta('paymentsPanelMessageId', msg.id);
    console.log('[Payments] Panel posted');
  } catch (err) {
    console.error('[Payments] ensurePanel:', err.message);
  }
}

// ── Manage payment methods ──────────────────────────────────────────────────

async function handleManage(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const editor = await getDb().collection('editors').findOne({ userId: interaction.user.id });
  const method = editor?.paymentMethod;
  const destination = editor?.paypalEmail;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pay:set:paypal')
      .setLabel(method === 'paypal' ? 'Change PayPal address' : 'Switch to PayPal')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pay:set:bank')
      .setLabel('Switch to bank transfer')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(method === 'bank'),
  );

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(config.BRAND_COLOR)
      .setTitle(copy.payments.manageTitle)
      .setDescription(copy.payments.manageCurrent(method, destination))],
    components: [row],
  });
}

async function handleSetMethod(interaction, method) {
  if (method === 'paypal') {
    const modal = new ModalBuilder()
      .setCustomId('pay:paypalmodal')
      .setTitle(copy.onboarding.paypalModalTitle)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('email').setLabel(copy.onboarding.paypalLabel)
          .setStyle(TextInputStyle.Short).setRequired(true)
      ));
    return interaction.showModal(modal);
  }

  await getDb().collection('editors').updateOne(
    { userId: interaction.user.id },
    { $set: { paymentMethod: 'bank', paypalEmail: null, updatedAt: new Date() } }
  );
  return perms.safeReply(interaction, copy.payments.manageChanged('bank'));
}

async function handlePaypalModal(interaction) {
  const email = interaction.fields.getTextInputValue('email').trim();
  await getDb().collection('editors').updateOne(
    { userId: interaction.user.id },
    { $set: { paymentMethod: 'paypal', paypalEmail: email, updatedAt: new Date() } }
  );
  return perms.safeReply(interaction, copy.payments.manageChanged('paypal', email));
}

// ── Balance ─────────────────────────────────────────────────────────────────

async function balance(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const rows = await getDb().collection('earnings')
    .find({ userId: interaction.user.id }).toArray();
  const sum = state => rows.filter(r => r.state === state).reduce((n, r) => n + (r.amount || 0), 0);
  const pending = sum('pending');
  const cleared = sum('cleared');
  const paid = sum('paid');

  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle(copy.payments.balanceTitle)
    .addFields(
      { name: copy.payments.balAvailable, value: `$${cleared.toFixed(2)}`, inline: true },
      { name: copy.payments.balPending, value: `$${pending.toFixed(2)}`, inline: true },
      { name: copy.payments.balPaid, value: `$${paid.toFixed(2)}`, inline: true },
    )
    .setFooter({ text: copy.payments.balanceFooter() });

  const canRequest = cleared >= config.PAYOUTS.MINIMUM_USD;
  if (!canRequest) {
    embed.setDescription(copy.payments.balanceShortfall(config.PAYOUTS.MINIMUM_USD - cleared));
  }

  const components = canRequest
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pay:payout')
          .setLabel(copy.payments.btnPayout).setEmoji('💸').setStyle(ButtonStyle.Success))]
    : [];

  return interaction.editReply({ embeds: [embed], components });
}

// ── Payout request ──────────────────────────────────────────────────────────

async function requestPayout(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const db = getDb();
  const open = await db.collection('payoutRequests')
    .findOne({ userId: interaction.user.id, status: 'pending' });
  if (open) return interaction.editReply(copy.payments.payoutOpen);

  const rows = await db.collection('earnings')
    .find({ userId: interaction.user.id, state: 'cleared' }).toArray();
  const cleared = rows.reduce((n, r) => n + (r.amount || 0), 0);
  if (cleared < config.PAYOUTS.MINIMUM_USD) {
    return interaction.editReply(copy.payments.payoutTooSmall(cleared));
  }

  const editor = await db.collection('editors').findOne({ userId: interaction.user.id });
  if (!editor?.paymentMethod) {
    return interaction.editReply(copy.payments.payoutNoMethod());
  }

  await db.collection('payoutRequests').insertOne({
    userId: interaction.user.id,
    username: interaction.user.username,
    amount: cleared,
    method: editor.paymentMethod,
    destination: editor.paypalEmail || 'bank transfer, details to collect',
    status: 'pending',
    createdAt: new Date(),
  });

  const campaigns = require('./campaigns');
  await campaigns.alert(interaction.client,
    `💸 **Payout request** from <@${interaction.user.id}> for **$${cleared.toFixed(2)}** ` +
    `via ${editor.paymentMethod}${editor.paypalEmail ? ` (${editor.paypalEmail})` : ''}.`);

  return interaction.editReply(copy.payments.payoutRequested(cleared));
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('pay:')) return false;

  try {
    if (id === 'pay:manage') await handleManage(interaction);
    else if (id === 'pay:balance') await balance(interaction);
    else if (id === 'pay:payout') await requestPayout(interaction);
    else if (id === 'pay:paypalmodal') await handlePaypalModal(interaction);
    else if (id.startsWith('pay:set:')) await handleSetMethod(interaction, id.split(':')[2]);
    else return false;
  } catch (err) {
    console.error('[Payments] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('payments'));
  }
  return true;
}

module.exports = { ensurePanel, buildPanelMessage, balance, requestPayout, route };
