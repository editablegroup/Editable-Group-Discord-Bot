'use strict';

const { EmbedBuilder, Events, AuditLogEvent, ChannelType } = require('discord.js');

const config = require('./config');
const ids = require('./ids');

/**
 * ============================================================================
 *  LOGGING
 * ============================================================================
 *  Six channels, matching the category you already have:
 *
 *    #system           boot, stats runs, API failures, budget auto-pauses
 *    #join-leave       members joining and leaving
 *    #chat-logs        message edits and deletions
 *    #server-logs      channel, role and member changes
 *    #onboarding-logs  completed onboardings
 *    #submission-logs  submitted, approved, rejected
 *
 *  Not #automod. Discord's own AutoMod already does keyword filtering, spam
 *  detection and mention limits better than a hand-rolled version would, and it
 *  logs to a channel you pick in Server Settings. Point it at your #automod
 *  channel and it will fill itself.
 *
 *  Every send is fire-and-forget. A logging failure must never break the action
 *  being logged, so nothing here throws upward.
 * ============================================================================
 */

const COLORS = {
  good: 0x57f287,
  bad: 0xed4245,
  warn: 0xf5b800,
  neutral: 0x8b8f95,
  info: config.BRAND_COLOR,
};

let clientRef = null;

/** Send to a log channel by key. Silently does nothing if unconfigured. */
async function send(key, payload) {
  try {
    const id = ids.channelId(`LOG:${key}`);
    if (!id || !clientRef) return;
    const channel = await clientRef.channels.fetch(id).catch(() => null);
    if (!channel) return;
    await channel.send(payload);
  } catch (err) {
    console.error(`[Log:${key}]`, err.message);
  }
}

function embed(color, title) {
  return new EmbedBuilder().setColor(COLORS[color] || COLORS.neutral)
    .setTitle(title).setTimestamp();
}

// ── Called directly by other modules ────────────────────────────────────────

const system = (title, description, color = 'info') =>
  send('SYSTEM', { embeds: [embed(color, title).setDescription(description)] });

const onboarded = (user, profile) =>
  send('ONBOARDING', {
    embeds: [embed('good', 'Onboarding completed')
      .setDescription(`<@${user.id}> (${user.tag})`)
      .addFields(
        { name: 'TikTok', value: `[@${profile.tiktokHandle}](https://www.tiktok.com/@${profile.tiktokHandle})`, inline: true },
        { name: 'Niches', value: (profile.nicheLabels || []).join(', ') || 'None', inline: true },
        { name: 'Payment', value: profile.paymentMethod || 'Not set', inline: true },
      )
      .setThumbnail(user.displayAvatarURL())],
  });

const submitted = (sub, campaign) =>
  send('SUBMISSION', {
    embeds: [embed(sub.status === 'flagged' ? 'warn' : 'info',
      sub.status === 'flagged' ? 'Submission flagged' : 'Submission received')
      .setDescription(`<@${sub.userId}> to **${campaign.label}**\n[${sub.clipName}](${sub.link})`)
      .addFields(
        { name: 'Handle', value: `@${sub.tiktokHandle}`, inline: true },
        { name: 'Views at submit', value: Number(sub.views || 0).toLocaleString('en-US'), inline: true },
      )],
  });

const reviewed = (sub, approved, reviewerId, earnings) =>
  send('SUBMISSION', {
    embeds: [embed(approved ? 'good' : 'bad', approved ? 'Submission approved' : 'Submission rejected')
      .setDescription(`<@${sub.userId}>, **${sub.campaignLabel}**\n[${sub.clipName}](${sub.link})`)
      .addFields(
        { name: 'Reviewed by', value: `<@${reviewerId}>`, inline: true },
        { name: 'Earnings', value: `$${Number(earnings || 0).toFixed(2)}`, inline: true },
      )],
  });

// ── Passive guild listeners ─────────────────────────────────────────────────

function attach(client) {
  clientRef = client;

  // Joins and leaves.
  client.on(Events.GuildMemberAdd, member => {
    const created = Math.floor(member.user.createdTimestamp / 1000);
    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
    send('JOIN_LEAVE', {
      embeds: [embed('good', 'Member joined')
        .setDescription(`<@${member.id}> (${member.user.tag})`)
        .addFields(
          { name: 'Account created', value: `<t:${created}:R>`, inline: true },
          // A wave of day-old accounts is what a raid looks like from here.
          { name: 'Account age', value: `${ageDays} days`, inline: true },
          { name: 'Members', value: String(member.guild.memberCount), inline: true },
        )
        .setThumbnail(member.user.displayAvatarURL())],
    });
  });

  client.on(Events.GuildMemberRemove, member => {
    const joined = member.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown';
    send('JOIN_LEAVE', {
      embeds: [embed('bad', 'Member left')
        .setDescription(`<@${member.id}> (${member.user?.tag || member.id})`)
        .addFields(
          { name: 'Joined', value: joined, inline: true },
          { name: 'Members', value: String(member.guild.memberCount), inline: true },
        )],
    });
  });

  // Message edits and deletions.
  client.on(Events.MessageDelete, message => {
    if (!message.guild || message.author?.bot) return;
    const content = message.content?.slice(0, 1000) || '(no text, or too old to be cached)';
    send('CHAT', {
      embeds: [embed('bad', 'Message deleted')
        .setDescription(`<@${message.author?.id}> in <#${message.channel.id}>`)
        .addFields({ name: 'Content', value: content })],
    });
  });

  client.on(Events.MessageUpdate, (before, after) => {
    if (!after.guild || after.author?.bot) return;
    if (before.content === after.content) return; // embed loads fire this too
    send('CHAT', {
      embeds: [embed('warn', 'Message edited')
        .setDescription(`<@${after.author?.id}> in <#${after.channel.id}>\n[Jump](${after.url})`)
        .addFields(
          { name: 'Before', value: (before.content || '(not cached)').slice(0, 1000) },
          { name: 'After', value: (after.content || '').slice(0, 1000) || '(empty)' },
        )],
    });
  });

  // Server structure.
  client.on(Events.ChannelCreate, channel => {
    if (!channel.guild) return;
    send('SERVER', {
      embeds: [embed('good', 'Channel created')
        .setDescription(`**#${channel.name}** (${channelKind(channel)})`)],
    });
  });

  client.on(Events.ChannelDelete, channel => {
    if (!channel.guild) return;
    send('SERVER', {
      embeds: [embed('bad', 'Channel deleted')
        .setDescription(`**#${channel.name}** (${channelKind(channel)})`)],
    });
  });

  client.on(Events.GuildRoleCreate, role => {
    send('SERVER', { embeds: [embed('good', 'Role created').setDescription(`**${role.name}**`)] });
  });

  client.on(Events.GuildRoleDelete, role => {
    send('SERVER', { embeds: [embed('bad', 'Role deleted').setDescription(`**${role.name}**`)] });
  });

  // Role grants and removals. Noisy if you log every campaign join, so this
  // only reports the roles that change what someone can do.
  const TRACKED = () => new Set([
    ids.roleId('CORE'), ids.roleId('NETWORK'), ids.roleId('COMPETITION'),
  ].filter(Boolean));

  client.on(Events.GuildMemberUpdate, (before, after) => {
    const tracked = TRACKED();
    const added = after.roles.cache.filter(r => !before.roles.cache.has(r.id) && tracked.has(r.id));
    const removed = before.roles.cache.filter(r => !after.roles.cache.has(r.id) && tracked.has(r.id));
    if (!added.size && !removed.size) return;

    const lines = [];
    if (added.size) lines.push(`Gained ${added.map(r => `**${r.name}**`).join(', ')}`);
    if (removed.size) lines.push(`Lost ${removed.map(r => `**${r.name}**`).join(', ')}`);

    send('SERVER', {
      embeds: [embed(added.size ? 'good' : 'warn', 'Roles changed')
        .setDescription(`<@${after.id}>\n${lines.join('\n')}`)],
    });
  });

  console.log('[Logging] Listeners attached');
}

function channelKind(channel) {
  if (channel.type === ChannelType.GuildCategory) return 'category';
  if (channel.type === ChannelType.GuildVoice) return 'voice';
  return 'text';
}

module.exports = { attach, send, system, onboarded, submitted, reviewed, COLORS };
