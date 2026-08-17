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
 *  One button: Manage Payment Methods.
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
    .addFields(
      { name: `💳 ${copy.payments.btnManage}`, value: copy.payments.fieldManage, inline: false },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pay:manage')
      .setLabel(copy.payments.btnManage).setEmoji('💳').setStyle(ButtonStyle.Primary),
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

// ── Balance and payout requests: removed ────────────────────────────────────
//
// Check Balance, /balance and Request Payout were removed on request. The
// earnings ledger still records every approved submission, referral bonus and
// clearing event exactly as before, so nothing is lost and restoring the
// interface is a matter of putting these functions back. Nobody can see or
// request money from inside Discord in the meantime.

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('pay:')) return false;

  try {
    if (id === 'pay:manage') await handleManage(interaction);
    else if (id === 'pay:paypalmodal') await handlePaypalModal(interaction);
    else if (id.startsWith('pay:set:')) await handleSetMethod(interaction, id.split(':')[2]);
    else return false;
  } catch (err) {
    console.error('[Payments] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('payments'));
  }
  return true;
}

module.exports = { ensurePanel, buildPanelMessage, route };
