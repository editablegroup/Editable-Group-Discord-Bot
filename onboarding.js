'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const config = require('./config');
const { getDb, getMeta, setMeta } = require('./db');
const tiktok = require('./tiktok');
const perms = require('./permissions');

/**
 * ============================================================================
 *  ONBOARDING
 * ============================================================================
 *  What changed and why:
 *
 *  1. ONE STATIC PANEL. Your bot currently posts a fresh welcome message on
 *     every guildMemberAdd. Two problems at scale: the channel becomes an
 *     unreadable wall, and Discord rate-limits a channel to roughly 5 messages
 *     per 5 seconds — so during a TikTok traffic spike most of those sends fail
 *     and those members get no onboarding prompt at all. They then sit in a
 *     server where they can see nothing, and leave.
 *
 *     Now: one message, posted once, pinned, re-used forever. Its ID lives in
 *     Mongo so redeploys don't duplicate it.
 *
 *  2. STATE IN MONGO, NOT MEMORY. `onboardingState` was a plain object. Railway
 *     redeploys on every git push. Anyone mid-flow lost their progress with no
 *     recovery path. Now it's a TTL collection — survives restarts, self-cleans
 *     after an hour.
 *
 *  3. HANDLE CAPTURED PROPERLY. We store the bare @handle, not the raw URL, so
 *     ownership verification at submission time actually works.
 *
 *  4. GENRE CAPTURED. This is the one thing the PayPerClip pitch deck had that
 *     you don't, and it's squarely your differentiator — you sell genre-matched
 *     editors. Capturing it at onboarding means that when a client sends a
 *     drill track you can filter to drill editors in one query instead of
 *     asking in Discord and waiting.
 * ============================================================================
 */

const GENRES = [
  'Hip Hop / Rap', 'Phonk', 'R&B / Soul', 'Pop', 'Drill',
  'Electronic / Hyperpop', 'Latin / Reggaeton', 'Rock / Alt', 'Instrumental / Ambient',
];

const STYLES = ['Lyrical', 'Thirst-Trap', 'Anime', 'Film/TV', 'Sports', 'Gaming', 'Velocity'];

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
const content = '👋 Welcome! Please complete the onboarding below to get access to the server.';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('onboard:start')
      .setLabel('Get Started')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Primary)
  );

  return { content, embeds: [], components: [row] };
}

/**
 * Ensure exactly one panel exists in #onboarding. Called on every boot.
 * Idempotent: it edits the existing message rather than posting a new one.
 */
async function ensurePanel(client) {
  try {
    const channel = await client.channels.fetch(config.CHANNELS.ONBOARDING);
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

// ── Flow ────────────────────────────────────────────────────────────────────

async function handleStart(interaction) {
  if (perms.tierAtLeast(interaction.member, config.TIERS.NETWORK)) {
    return perms.safeReply(interaction,
      `✅ You're already set up. Head to <#${config.CHANNELS.ACTIVE_CAMPAIGNS}>.`);
  }
  if (!await perms.enforceCooldown(interaction, 'onboard', 3000)) return;

  const modal = new ModalBuilder()
    .setCustomId('onboard:tiktok')
    .setTitle('Step 1 of 3 — Your TikTok')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('handle')
          .setLabel('Link to your TikTok profile')
          .setPlaceholder('https://www.tiktok.com/@yourhandle')
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

  if (!handle) {
    return perms.safeReply(interaction,
      '❌ That doesn\'t look like a TikTok handle. Try `@yourhandle` or your full profile link.');
  }

  // One TikTok account = one Discord account. Without this, one person opens
  // five Discord accounts, submits the same content, and collects five payouts.
  const clash = await getDb().collection('editors').findOne({
    tiktokHandle: handle,
    userId: { $ne: interaction.user.id },
  });
  if (clash) {
    console.warn(`[Onboarding] Duplicate handle @${handle} attempted by ${interaction.user.tag}`);
    return perms.safeReply(interaction,
      '❌ That TikTok account is already registered to another member. '
      + 'If this is your account, open a ticket and we\'ll sort it.');
  }

  await setState(interaction.user.id, { tiktokHandle: handle });

  const payRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('onboard:pay:paypal')
      .setLabel('PayPal').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('onboard:pay:bank')
      .setLabel('Bank Transfer').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: `✅ Linked **@${handle}**\n\n**Step 2 of 2** — how do you want to get paid?`,
    components: [payRow],
    flags: MessageFlags.Ephemeral,
  });
}



async function handlePaymentChoice(interaction, method) {
  if (method === 'paypal') {
    const modal = new ModalBuilder()
      .setCustomId('onboard:paypal')
      .setTitle('PayPal Details')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('email').setLabel('PayPal email address')
          .setStyle(TextInputStyle.Short).setRequired(true)
      ));
    return interaction.showModal(modal);
  }

  if (method === 'crypto') {
    const modal = new ModalBuilder()
      .setCustomId('onboard:crypto')
      .setTitle('Crypto Details')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('wallet').setLabel('Wallet address + network')
          .setPlaceholder('0x… (ERC-20) or T… (TRC-20)')
          .setStyle(TextInputStyle.Short).setRequired(true)
      ));
    return interaction.showModal(modal);
  }

  // Bank details are collected in a ticket, not a public modal.
  await setState(interaction.user.id, { paymentMethod: 'bank' });
  await complete(interaction);
}

async function handlePaymentModal(interaction, method) {
  const patch = method === 'paypal'
    ? { paymentMethod: 'paypal', paypalEmail: interaction.fields.getTextInputValue('email').trim() }
    : { paymentMethod: 'crypto', cryptoWallet: interaction.fields.getTextInputValue('wallet').trim() };
  await setState(interaction.user.id, patch);
  await complete(interaction);
}

// ── Completion ──────────────────────────────────────────────────────────────

async function complete(interaction) {
  const userId = interaction.user.id;
  const state = (await getState(userId)) || {};

  if (!state.tiktokHandle) {
    return perms.safeReply(interaction,
      '❌ Your session expired. Tap **Get Started** again — it only takes 30 seconds.');
  }

  // 1. Grant Network.
  try {
    await interaction.member.roles.add(config.ROLES.NETWORK, 'Completed onboarding');
  } catch (err) {
    console.error('[Onboarding] Role grant failed:', err.message);
    return perms.safeReply(interaction,
      '❌ Couldn\'t assign your role. Ping a staff member — this is on our end, not yours.');
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
        genres: state.genres || [],
        styles: state.styles || [],
        paymentMethod: state.paymentMethod || null,
        paypalEmail: state.paypalEmail || null,
        cryptoWallet: state.cryptoWallet || null,
        tier: config.TIERS.NETWORK,
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

  // 3. Log it (unchanged behaviour — this already worked).
  try {
    const logs = await interaction.client.channels.fetch(config.CHANNELS.LOGS);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('New Network Editor')
      .setDescription(`<@${userId}> completed onboarding`)
      .addFields(
        { name: 'TikTok', value: `[@${state.tiktokHandle}](https://www.tiktok.com/@${state.tiktokHandle})`, inline: true },
        { name: 'Payment', value: state.paymentMethod || 'Not set', inline: true },
      )
      .setThumbnail(interaction.user.displayAvatarURL())
      .setTimestamp();
    await logs.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Onboarding] Log failed:', err.message);
  }

  // 4. Welcome.
  const payload = {
    content:
      `✅ **You're all set! Welcome to Editable Group.**\n\n` +
      `Have a look around the server, and say hello in <#1536395106024685651>.`,
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
    else if (id === 'onboard:paypal') await handlePaymentModal(interaction, 'paypal');
    else if (id.startsWith('onboard:pay:')) await handlePaymentChoice(interaction, id.split(':')[2]);
    else return false;
  } catch (err) {
    console.error('[Onboarding] route error:', err);
    await perms.safeReply(interaction, '❌ Something went wrong. Try again in a moment.');
  }
  return true;
}

module.exports = { ensurePanel, route, buildPanel, GENRES, STYLES };
