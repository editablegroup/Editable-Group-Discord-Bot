'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');
const tiktok = require('./tiktok');
const perms = require('./permissions');
const logging = require('./logging');

/**
 * ============================================================================
 *  ONBOARDING — 3 obligatory steps
 * ============================================================================
 *    1. TikTok profile link
 *    2. Niches (multi-select: Film & TV, Celebs, Sports)
 *    3. Payment method (PayPal address, or bank transfer collected at payout)
 *
 *  Design notes that still hold from the previous build:
 *
 *  ONE STATIC PANEL, not a message per join. Discord rate-limits a channel to
 *  roughly 5 messages per 5 seconds, so during a TikTok traffic spike most
 *  per-join sends fail and those members get no prompt at all.
 *
 *  STATE IN MONGO, NOT MEMORY. Railway redeploys on every push. In-memory state
 *  strands anyone mid-flow with no recovery. The TTL index cleans it up after
 *  an hour.
 *
 *  What is new: niches are granted as real roles, because they are the ping
 *  targets for campaigns. Picking "Sports" is what puts a sports campaign in
 *  front of you, so the selector is not a survey question, it is routing.
 * ============================================================================
 */

// ── State (Mongo-backed) ────────────────────────────────────────────────────

async function getState(userId) {
  const doc = await getDb().collection('onboardingState').findOne({ userId });
  return doc?.data || null;
}

async function setState(userId, patch) {
  const existing = (await getState(userId)) || {};
  const data = { ...existing, ...patch };
  await getDb().collection('onboardingState').updateOne(
    { userId },
    { $set: { userId, data, updatedAt: new Date() } },
    { upsert: true }
  );
  return data;
}

async function clearState(userId) {
  await getDb().collection('onboardingState').deleteOne({ userId }).catch(() => {});
}

// ── The static panel ────────────────────────────────────────────────────────

function buildPanel() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('onboard:start')
      .setLabel(copy.onboarding.startButton)
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Primary)
  );

  return { content: copy.onboarding.panel(), embeds: [], components: [row] };
}

/**
 * Ensure exactly one panel exists in #onboarding. Called on every boot.
 * Idempotent: edits the existing message rather than posting a new one.
 */
async function ensurePanel(client) {
  try {
    const channelId = ids.channelId('ONBOARDING');
    if (!channelId) return console.error('[Onboarding] No onboarding channel configured');

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.error('[Onboarding] Channel not found');

    const savedId = await getMeta('onboardPanelMessageId');
    if (savedId) {
      const existing = await channel.messages.fetch(savedId).catch(() => null);
      if (existing) {
        await existing.edit(buildPanel()).catch(() => {});
        console.log('[Onboarding] Static panel verified');
        return;
      }
    }

    const msg = await channel.send(buildPanel());
    await msg.pin().catch(() => {});
    await setMeta('onboardPanelMessageId', msg.id);
    console.log('[Onboarding] Static panel posted');
  } catch (err) {
    console.error('[Onboarding] ensurePanel failed:', err.message);
  }
}

// ── Step 1: TikTok ──────────────────────────────────────────────────────────

async function handleStart(interaction) {
  if (perms.tierAtLeast(interaction.member, config.TIERS.NETWORK)) {
    return perms.safeReply(interaction, copy.onboarding.alreadyDone());
  }
  if (!await perms.enforceCooldown(interaction, 'onboard', 3000)) return;

  const modal = new ModalBuilder()
    .setCustomId('onboard:tiktok')
    .setTitle(copy.onboarding.step1Title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('handle')
          .setLabel(copy.onboarding.step1Label)
          .setPlaceholder(copy.onboarding.step1Placeholder)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(true)
      )
    );
  await interaction.showModal(modal);
}

async function handleTikTokModal(interaction) {
  const raw = interaction.fields.getTextInputValue('handle');
  const handle = tiktok.parseHandle(raw);

  if (!handle) return perms.safeReply(interaction, copy.onboarding.errBadHandle);

  // One TikTok account = one Discord account. Without this, one person opens
  // five Discord accounts, submits the same content, and collects five payouts.
  const clash = await getDb().collection('editors').findOne({
    tiktokHandle: handle,
    userId: { $ne: interaction.user.id },
  });
  if (clash) {
    console.warn(`[Onboarding] Duplicate handle @${handle} attempted by ${interaction.user.tag}`);
    return perms.safeReply(interaction, copy.onboarding.errDuplicateHandle(handle));
  }

  await setState(interaction.user.id, { tiktokHandle: handle });

  return interaction.reply({
    content: copy.onboarding.step2().replace('%HANDLE%', handle),
    components: [buildNicheRow()],
    flags: MessageFlags.Ephemeral,
  });
}

// ── Step 2: niches ──────────────────────────────────────────────────────────

function buildNicheRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('onboard:niches')
      .setPlaceholder(copy.onboarding.step2Placeholder)
      .setMinValues(1)
      .setMaxValues(config.NICHES.length)
      .addOptions(config.NICHES.map(n => ({
        label: n.label,
        value: n.value,
        emoji: n.emoji,
      })))
  );
}

async function handleNicheSelect(interaction) {
  const chosen = interaction.values || [];
  if (!chosen.length) return perms.safeReply(interaction, copy.onboarding.errNoNiche);

  await setState(interaction.user.id, { niches: chosen });
  const labels = chosen.map(v => ids.nicheByValue(v)?.label || v);

  const payRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('onboard:pay:paypal')
      .setLabel('PayPal').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('onboard:pay:bank')
      .setLabel('Bank Transfer').setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({
    content: copy.onboarding.step3(labels),
    components: [payRow],
  });
}

// ── Step 3: payment ─────────────────────────────────────────────────────────

async function handlePaymentChoice(interaction, method) {
  if (method === 'paypal') {
    const modal = new ModalBuilder()
      .setCustomId('onboard:paypal')
      .setTitle(copy.onboarding.paypalModalTitle)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('email').setLabel(copy.onboarding.paypalLabel)
          .setStyle(TextInputStyle.Short).setRequired(true)
      ));
    return interaction.showModal(modal);
  }

  // Bank details are collected by ticket at payout time, so there is nothing to
  // ask for here. Saying so is the whole point, otherwise it looks broken.
  await setState(interaction.user.id, { paymentMethod: 'bank' });
  await interaction.update({ content: copy.onboarding.bankChosen(), components: [] })
    .catch(() => {});
  await complete(interaction);
}

async function handlePaymentModal(interaction) {
  await setState(interaction.user.id, {
    paymentMethod: 'paypal',
    paypalEmail: interaction.fields.getTextInputValue('email').trim(),
  });
  await complete(interaction);
}

// ── Completion ──────────────────────────────────────────────────────────────

async function complete(interaction) {
  const userId = interaction.user.id;
  const state = (await getState(userId)) || {};

  if (!state.tiktokHandle || !state.niches?.length) {
    return perms.safeReply(interaction, copy.onboarding.errExpired);
  }

  const nicheLabels = state.niches.map(v => ids.nicheByValue(v)?.label || v);

  // 1. Roles: Network, plus one per niche. Niche roles are the ping targets, so
  //    a failure here means the member silently stops hearing about campaigns.
  try {
    const networkRole = ids.roleId('NETWORK');
    if (networkRole) {
      await interaction.member.roles.add(networkRole, 'Completed onboarding');
    }
  } catch (err) {
    console.error('[Onboarding] Network role grant failed:', err.message);
    return perms.safeReply(interaction, copy.onboarding.errRoleFailed());
  }

  for (const value of state.niches) {
    const roleId = ids.nicheRoleId(value);
    if (!roleId) continue;
    await interaction.member.roles.add(roleId, 'Niche selected at onboarding')
      .catch(err => console.error(`[Onboarding] Niche role ${value}:`, err.message));
  }

  // 2. Persist the editor profile.
  await getDb().collection('editors').updateOne(
    { userId },
    {
      $set: {
        userId,
        username: interaction.user.username,
        displayName: interaction.user.globalName || interaction.user.username,
        tiktokHandle: state.tiktokHandle,
        tiktokUrl: `https://www.tiktok.com/@${state.tiktokHandle}`,
        niches: state.niches,
        paymentMethod: state.paymentMethod || null,
        paypalEmail: state.paypalEmail || null,
        tier: config.TIERS.NETWORK,
        onboardedAt: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        joinedAt: new Date(),
        lifetimeEarnings: 0,
        pendingBalance: 0,
        clearedBalance: 0,
        paidOut: 0,
      },
    },
    { upsert: true }
  );

  await clearState(userId);

  logging.onboarded(interaction.user, {
    tiktokHandle: state.tiktokHandle,
    nicheLabels,
    paymentMethod: state.paymentMethod,
  });

  const payload = {
    content: copy.onboarding.complete(nicheLabels),
    components: [],
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

async function route(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('onboard:')) return false;

  try {
    if (id === 'onboard:start') await handleStart(interaction);
    else if (id === 'onboard:tiktok') await handleTikTokModal(interaction);
    else if (id === 'onboard:niches') await handleNicheSelect(interaction);
    else if (id === 'onboard:paypal') await handlePaymentModal(interaction);
    else if (id.startsWith('onboard:pay:')) await handlePaymentChoice(interaction, id.split(':')[2]);
    else return false;
  } catch (err) {
    console.error('[Onboarding] route error:', err);
    await perms.safeReply(interaction, copy.common.errIn('onboarding'));
  }
  return true;
}

module.exports = { ensurePanel, route, buildPanel, complete };
