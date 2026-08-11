'use strict';

const { MessageFlags } = require('discord.js');
const config = require('./config');

/**
 * ============================================================================
 *  TIER GATING + RATE LIMITING
 * ============================================================================
 *  Two rules that matter once the server is public:
 *
 *  1. Slash-command permissions set at REGISTRATION time are a UI convenience,
 *     NOT a security boundary. A server admin can re-enable any command for any
 *     role in Server Settings → Integrations, and Discord has historically had
 *     edge cases where the client shows a command it shouldn't. Every privileged
 *     handler must ALSO check at runtime. That is what requireStaff() is for.
 *
 *  2. Your current approve_/reject_ buttons have no check at all. Any member who
 *     can see #submissions can approve their own edit and become eligible for
 *     payout. With 100 hand-picked people that is a survivable trust model.
 *     With 2,000 strangers it is an open cash register. Fixed in campaigns.js.
 * ============================================================================
 */

// ── Tier resolution ─────────────────────────────────────────────────────────

function isStaff(userId) {
  return config.STAFF_IDS.includes(userId);
}

/** Resolve a member's tier from their roles. Cheap — no API call. */
function getTier(member) {
  if (!member) return config.TIERS.NONE;
  if (isStaff(member.id)) return config.TIERS.STAFF;
  if (member.roles.cache.has(config.ROLES.CORE)) return config.TIERS.CORE;
  // Your original hand-picked 100 — vetted before onboarding existed, so the
  // legacy Editor role counts as full access. No re-onboarding.
  if (member.roles.cache.has(config.ROLES.LEGACY_EDITOR)) return config.TIERS.CORE;
  if (member.roles.cache.has(config.ROLES.NETWORK)) return config.TIERS.NETWORK;
  return config.TIERS.NONE;
}

const TIER_RANK = {
  [config.TIERS.NONE]: 0,
  [config.TIERS.NETWORK]: 1,
  [config.TIERS.CORE]: 2,
  [config.TIERS.STAFF]: 3,
};

function tierAtLeast(member, minimum) {
  return TIER_RANK[getTier(member)] >= TIER_RANK[minimum];
}

/**
 * Can this member see/join a campaign?
 *   campaign.tier === 'core'    → Core and Staff only
 *   campaign.tier === 'network' → Network and above
 *   campaign.tier === 'all'     → anyone onboarded
 */
function canAccessCampaign(member, campaign) {
  const tier = getTier(member);
  if (tier === config.TIERS.STAFF) return true;
  if (tier === config.TIERS.NONE) return false;
  if (campaign.tier === 'core') return tier === config.TIERS.CORE;
  return true; // 'network' and 'all' are open to Network+
}

// ── Runtime guards ──────────────────────────────────────────────────────────

const DENY = {
  staff: '🔒 This is an admin-only command.',
  onboard: '👋 Finish onboarding in <#' + config.CHANNELS.ONBOARDING + '> first.',
  core: '⭐ This is a **Core** campaign. Core is earned through consistent '
      + 'performance on open campaigns — keep posting and you\'ll be considered.',
};

/**
 * Guard a staff-only interaction. Returns true if the caller may proceed.
 * Always await this BEFORE doing any work.
 */
async function requireStaff(interaction) {
  if (isStaff(interaction.user.id)) return true;
  await safeReply(interaction, DENY.staff);
  console.warn(
    `[SECURITY] ${interaction.user.tag} (${interaction.user.id}) attempted `
    + `privileged action: ${interaction.commandName || interaction.customId}`
  );
  return false;
}

/** Guard an editor-only interaction (must have completed onboarding). */
async function requireOnboarded(interaction) {
  const member = interaction.member;
  if (tierAtLeast(member, config.TIERS.NETWORK)) return true;
  await safeReply(interaction, DENY.onboard);
  return false;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * In-process cooldowns. Deliberately not in Mongo: a cooldown check must be
 * sub-millisecond, and losing them on restart is harmless.
 *
 * Why this matters: when you drop the TikTok promo, hundreds of people hit the
 * onboarding button within seconds. Discord's interaction budget and your Mongo
 * connection pool are both finite. Without this, a handful of users spamming a
 * button can starve everyone else's interactions and Discord will start
 * returning "This interaction failed" server-wide.
 */
const buckets = new Map(); // `${userId}:${action}` -> expiry ms

function checkCooldown(userId, action, ms) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const expiry = buckets.get(key);
  if (expiry && expiry > now) return Math.ceil((expiry - now) / 1000);
  buckets.set(key, now + ms);
  return 0;
}

/** Returns true if allowed; auto-replies and returns false if rate limited. */
async function enforceCooldown(interaction, action, ms) {
  if (isStaff(interaction.user.id)) return true;
  const wait = checkCooldown(interaction.user.id, action, ms);
  if (wait === 0) return true;
  await safeReply(interaction, `⏳ Slow down — try again in ${wait}s.`);
  return false;
}

// Sweep expired buckets every 5 minutes so this Map can't grow unbounded
// across thousands of members.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v <= now) buckets.delete(k);
}, 5 * 60 * 1000).unref();

// ── Reply helpers ───────────────────────────────────────────────────────────

/**
 * Reply without ever throwing. Interactions expire after 3 seconds and a
 * double-reply throws — both are extremely common under load and both currently
 * crash handlers in your bot.
 */
async function safeReply(interaction, content, extra = {}) {
  const payload = { content, flags: MessageFlags.Ephemeral, ...extra };
  try {
    if (interaction.deferred) return await interaction.editReply({ content, ...extra });
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    if (err.code !== 10062 && err.code !== 40060) {
      console.error('[safeReply]', err.message);
    }
  }
}

async function safeDefer(interaction, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    return true;
  } catch (err) {
    console.error('[safeDefer]', err.message);
    return false;
  }
}

module.exports = {
  isStaff, getTier, tierAtLeast, canAccessCampaign,
  requireStaff, requireOnboarded,
  checkCooldown, enforceCooldown,
  safeReply, safeDefer,
  DENY,
};
