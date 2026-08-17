'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const config = require('./config');
const { getDb } = require('./db');
const ids = require('./ids');

/**
 * ============================================================================
 *  SERVER PROVISIONING
 * ============================================================================
 *  Creates the roles, categories and channels the bot needs, so nobody has to
 *  paste snowflakes into config.js by hand. Anything it creates is written back
 *  to Mongo through ids.remember(), which is where the rest of the bot reads it.
 *
 *  Two hard Discord constraints shape everything here:
 *
 *  1. ROLE POSITION. The bot can only create, grant or delete roles that sit
 *     BELOW its own highest role. If the bot's role is at the bottom of the
 *     list, every campaign role it creates is unusable. checkCapability() below
 *     reports this before you find out the hard way at 2am.
 *
 *  2. GUILD CEILINGS. 500 roles, 500 channels, 50 channels per category. Each
 *     campaign spends 1 role, 1 category and 3 channels. At roughly 25
 *     campaigns a year that is fine for years, but it is not unlimited, which
 *     is why CAMPAIGN_AUTOMATION.ON_END defaults to archiving and reclaiming
 *     the role rather than leaving everything in place forever.
 * ============================================================================
 */

const AUTOMATION = config.CAMPAIGN_AUTOMATION;

/** Slug a campaign label into something Discord will accept as a channel name. */
function slug(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'campaign';
}

/**
 * Report what the bot can and cannot do here, in plain terms.
 * Called by /setup and at boot so problems surface before a campaign needs them.
 */
function checkCapability(guild) {
  const me = guild.members.me;
  const problems = [];
  if (!me) return { ok: false, problems: ['The bot is not a member of this guild.'] };

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    problems.push('Missing **Manage Roles**, so campaign roles cannot be created.');
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    problems.push('Missing **Manage Channels**, so campaign categories cannot be created.');
  }

  // Position check. This is the one that bites.
  const highest = me.roles.highest;
  const above = guild.roles.cache.filter(r => r.position > highest.position && r.id !== guild.id);
  if (highest.position <= 1) {
    problems.push(
      'The bot\'s role sits at the bottom of the role list. Drag it above every role ' +
      'it needs to manage, otherwise it cannot grant campaign or niche roles.');
  }

  return {
    ok: problems.length === 0,
    problems,
    botRolePosition: highest.position,
    rolesAbove: above.size,
    roleCount: guild.roles.cache.size,
    channelCount: guild.channels.cache.size,
  };
}

// ── Niche roles ─────────────────────────────────────────────────────────────

/**
 * Make sure every niche in config has a real role. Created once, then reused.
 * Niche roles are the ping targets for campaigns, which is the whole reason
 * onboarding asks for niches at all.
 */
async function ensureNicheRoles(guild) {
  const created = [];
  for (const niche of config.NICHES) {
    if (ids.nicheRoleId(niche.value)) continue;

    // A role with the right name may already exist from before the bot.
    const existing = guild.roles.cache.find(r => r.name === niche.label);
    if (existing) {
      await ids.remember(`NICHE:${niche.value}`, existing.id);
      continue;
    }

    try {
      const role = await guild.roles.create({
        name: niche.label,
        mentionable: true,
        reason: 'Niche ping role',
      });
      await ids.remember(`NICHE:${niche.value}`, role.id);
      created.push(niche.label);
    } catch (err) {
      console.error(`[Provision] Niche role ${niche.label}:`, err.message);
    }
  }
  return created;
}

// ── Standing channels ───────────────────────────────────────────────────────

/**
 * The channels the bot needs that may not exist yet. Each is created only if
 * unresolved, so running /setup twice is safe.
 *
 * `network` means Network editors can see it, `staff` means staff only.
 */
const STANDING_CHANNELS = [
  { key: 'PAYMENTS',    name: 'payments',       audience: 'network' },
  { key: 'TICKETS',     name: 'open-a-ticket',  audience: 'network' },
  { key: 'LEADERBOARD', name: 'leaderboard',    audience: 'network' },
  { key: 'LOG:SYSTEM',      name: 'system',           audience: 'staff' },
  { key: 'LOG:JOIN_LEAVE',  name: 'join-leave',       audience: 'staff' },
  { key: 'LOG:CHAT',        name: 'chat-logs',        audience: 'staff' },
  { key: 'LOG:SERVER',      name: 'server-logs',      audience: 'staff' },
  { key: 'LOG:ONBOARDING',  name: 'onboarding-logs',  audience: 'staff' },
  { key: 'LOG:SUBMISSION',  name: 'submission-logs',  audience: 'staff' },
];

function overwritesFor(guild, audience) {
  const everyone = guild.roles.everyone.id;
  const network = ids.roleId('NETWORK');

  if (audience === 'staff') {
    return [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }];
  }

  const rows = [
    { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
  ];
  if (network) {
    rows.push({
      id: network,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }
  return rows;
}

/** Create any standing channel that is still unresolved. Idempotent. */
async function ensureStandingChannels(guild) {
  const created = [];
  const reused = [];

  for (const spec of STANDING_CHANNELS) {
    if (ids.channelId(spec.key)) continue;

    const existing = guild.channels.cache.find(
      c => c.name === spec.name && c.type === ChannelType.GuildText);
    if (existing) {
      await ids.remember(`CHANNEL:${spec.key}`, existing.id);
      reused.push(`#${spec.name}`);
      continue;
    }

    try {
      const channel = await guild.channels.create({
        name: spec.name,
        type: ChannelType.GuildText,
        permissionOverwrites: overwritesFor(guild, spec.audience),
        reason: 'Bot setup',
      });
      await ids.remember(`CHANNEL:${spec.key}`, channel.id);
      created.push(`#${spec.name}`);
      await new Promise(r => setTimeout(r, 300)); // channel creation is rate limited
    } catch (err) {
      console.error(`[Provision] ${spec.name}:`, err.message);
    }
  }

  return { created, reused };
}

// ── Campaign space (role + category + channels) ─────────────────────────────

/**
 * Build a campaign's private home: one role, one category only that role can
 * see, and the channels inside it.
 *
 * Returns { roleId, categoryId, categoryName, channels } and records the same
 * on the campaign document so /campaign end can undo it.
 */
async function createCampaignSpace(guild, campaign) {
  if (!AUTOMATION.ENABLED) return null;

  const capability = checkCapability(guild);
  if (!capability.ok) {
    throw new Error(capability.problems.join(' '));
  }

  const name = campaign.label.slice(0, 90);

  // 1. Role.
  const role = await guild.roles.create({
    name,
    mentionable: true,
    reason: `Campaign: ${campaign.value}`,
  });

  // 2. Category, visible only to that role and staff.
  const parentless = ids.channelId('CAMPAIGN_PARENT');
  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
        ],
      },
    ],
    reason: `Campaign: ${campaign.value}`,
  });

  // 3. Channels inside it. They inherit the category's permissions, except
  //    announcements and rules, which are read-only for editors.
  const channels = {};
  for (const channelName of AUTOMATION.CHANNELS) {
    const readOnly = channelName !== 'general';
    try {
      const created = await guild.channels.create({
        name: `${slug(channelName)}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: readOnly
          ? [
              { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
              {
                id: role.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                deny: [PermissionFlagsBits.SendMessages],
              },
            ]
          : undefined,
        reason: `Campaign: ${campaign.value}`,
      });
      channels[channelName] = created.id;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[Provision] ${campaign.value}/${channelName}:`, err.message);
    }
  }

  const space = {
    roleId: role.id,
    categoryId: category.id,
    categoryName: name,
    channels,
    createdAt: new Date(),
  };

  await getDb().collection('campaigns').updateOne(
    { value: campaign.value },
    { $set: { roleId: role.id, space } }
  );

  // parentless is only used to keep the category near the others if you have
  // set a parent. Discord has no nested categories, so this is a sort hint.
  if (parentless) {
    await category.setPosition(1).catch(() => {});
  }

  return space;
}

/**
 * Undo a campaign space. Archiving renames the category, strips send access and
 * leaves the history readable. The role is scheduled for deletion rather than
 * removed immediately so nobody loses channel access while their earnings are
 * still in the clearing window.
 */
async function retireCampaignSpace(guild, campaign) {
  const space = campaign.space;
  if (!space) return { done: false, reason: 'no space' };

  if (AUTOMATION.ON_END === 'delete') {
    for (const id of Object.values(space.channels || {})) {
      await guild.channels.delete(id, 'Campaign ended').catch(() => {});
    }
    await guild.channels.delete(space.categoryId, 'Campaign ended').catch(() => {});
    await guild.roles.delete(space.roleId, 'Campaign ended').catch(() => {});
    return { done: true, mode: 'deleted' };
  }

  // Archive.
  const category = await guild.channels.fetch(space.categoryId).catch(() => null);
  if (category && !category.name.startsWith(AUTOMATION.ARCHIVE_PREFIX)) {
    await category.setName(`${AUTOMATION.ARCHIVE_PREFIX}${category.name}`.slice(0, 100))
      .catch(() => {});
  }
  for (const id of Object.values(space.channels || {})) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) continue;
    await channel.permissionOverwrites.edit(space.roleId, { SendMessages: false })
      .catch(() => {});
  }

  const deleteAfter = AUTOMATION.DELETE_ROLE_AFTER_DAYS;
  if (deleteAfter > 0) {
    await getDb().collection('campaigns').updateOne(
      { value: campaign.value },
      { $set: { 'space.roleDeleteAfter': new Date(Date.now() + deleteAfter * 86_400_000) } }
    );
  }

  return { done: true, mode: 'archived', roleDeletesInDays: deleteAfter };
}

/**
 * Delete campaign roles whose grace period has passed. Run on the same hourly
 * timer as earnings clearing.
 */
async function sweepExpiredRoles(client) {
  const due = await getDb().collection('campaigns').find({
    'space.roleDeleteAfter': { $lte: new Date() },
  }).toArray();
  if (!due.length) return 0;

  const guild = await client.guilds.fetch(config.GUILD_ID).catch(() => null);
  if (!guild) return 0;

  let removed = 0;
  for (const campaign of due) {
    await guild.roles.delete(campaign.space.roleId, `Campaign ${campaign.value} retired`)
      .then(() => { removed++; })
      .catch(() => {});
    await getDb().collection('campaigns').updateOne(
      { value: campaign.value },
      { $unset: { 'space.roleDeleteAfter': '' } }
    );
  }
  return removed;
}

module.exports = {
  slug, checkCapability, ensureNicheRoles, ensureStandingChannels,
  createCampaignSpace, retireCampaignSpace, sweepExpiredRoles,
  STANDING_CHANNELS,
};
