'use strict';

const {
  Client, GatewayIntentBits, Partials, Events, Options,
  SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
} = require('discord.js');

const config = require('./config');
const db = require('./db');
const perms = require('./permissions');
const onboarding = require('./onboarding');
const campaigns = require('./campaigns');
const admin = require('./admin');

/**
 * ============================================================================
 *  EDITABLE GROUP BOT — ENTRY POINT
 * ============================================================================
 *  index.js does four things and nothing else:
 *    1. builds the client
 *    2. declares slash commands
 *    3. routes interactions to the right module
 *    4. boots
 *
 *  All business logic lives in campaigns.js / admin.js / onboarding.js.
 * ============================================================================
 */

// ── Client ──────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // privileged — enable in the Dev Portal
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // privileged — needed for DM screenshots
  ],
  partials: [Partials.Channel, Partials.Message],

  /**
   * Cache limits. This is not optional at your target size.
   *
   * By default discord.js caches every message it sees and every member it
   * touches, forever. On a 2,000-member server with active chat that is
   * hundreds of megabytes of RSS growth over days — and on Railway's Hobby
   * plan you are billed per GB of RAM per minute, so an unbounded cache is
   * both a crash risk and a bill.
   */
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    GuildMemberManager: { maxSize: 500, keepOverLimit: m => m.id === client.user?.id },
    UserManager: { maxSize: 500, keepOverLimit: u => u.id === client.user?.id },
    PresenceManager: 0,
    ReactionManager: 0,
    GuildBanManager: 0,
    ThreadManager: 25,
  }),
  sweepers: {
    messages: { interval: 600, lifetime: 900 },
    users: { interval: 3600, filter: () => u => u.id !== client.user?.id },
  },
});

// ── Crash safety ────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => console.error('[UnhandledRejection]', err));
process.on('uncaughtException', err => console.error('[UncaughtException]', err));
client.on('error', err => console.error('[ClientError]', err));
client.on('shardError', err => console.error('[ShardError]', err));

// ── Command definitions ─────────────────────────────────────────────────────

/**
 * Admin commands get BOTH:
 *   • an "(ADMIN ONLY)" description prefix — the greyed-out text preview you
 *     screenshotted from PayPerClip
 *   • setDefaultMemberPermissions(Administrator)
 *
 * With HARD_HIDE_ADMIN_COMMANDS = true (the default), Discord hides them from
 * non-admins entirely, so editors never even see them in the picker. Flip it to
 * false in config.js if you'd rather they be visible-but-locked like the
 * screenshot. Either way the runtime requireStaff() check is the real lock.
 */
const ADMIN_PREFIX = '(ADMIN ONLY) ';

function adminCmd(builder) {
  const desc = builder.description || '';
  builder.setDescription((ADMIN_PREFIX + desc).slice(0, 100));
  if (config.HARD_HIDE_ADMIN_COMMANDS) {
    builder.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  }
  builder.setDMPermission(false);
  return builder;
}

const commands = [
  // ── Editor commands (open to Network+) ──────────────────────────────────
  new SlashCommandBuilder()
    .setName('submissions')
    .setDescription('View your submissions, views and earnings')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your available, pending and paid-out balance')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('See the top editors on a campaign')
    .addStringOption(o => o.setName('campaign')
      .setDescription('Which campaign').setRequired(true).setAutocomplete(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('campaigns')
    .setDescription('List every campaign you have access to')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the current ticket')
    .setDMPermission(false),

  // ── Admin commands ───────────────────────────────────────────────────────
  adminCmd(new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Full operational overview')),

  adminCmd(new SlashCommandBuilder()
    .setName('editor')
    .setDescription('Look up a single editor profile')
    .addUserOption(o => o.setName('user').setDescription('The editor').setRequired(true))),

  adminCmd(new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Promote an editor to Core')
    .addUserOption(o => o.setName('user').setDescription('The editor').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setRequired(false))),

  adminCmd(new SlashCommandBuilder()
    .setName('demote')
    .setDescription('Move an editor from Core back to Network')
    .addUserOption(o => o.setName('user').setDescription('The editor').setRequired(true))),

  adminCmd(new SlashCommandBuilder()
    .setName('nominations')
    .setDescription('Network editors who have earned Core consideration')),

  adminCmd(new SlashCommandBuilder()
    .setName('migratecore')
    .setDescription('One-time: grant Core to all legacy hand-picked editors')),

  adminCmd(new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Hide every channel from @everyone except #onboarding')),

  adminCmd(new SlashCommandBuilder()
    .setName('updatestats')
    .setDescription('Force a TikTok stats refresh now')),

  adminCmd(new SlashCommandBuilder()
    .setName('panels')
    .setDescription('Re-post the onboarding and support panels')),

  adminCmd(new SlashCommandBuilder()
    .setName('campaign')
    .setDescription('Manage campaigns')
    .addSubcommand(s => s.setName('create').setDescription('Create a new campaign'))
    .addSubcommand(s => s.setName('post').setDescription('Post the offer to its channel')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('end').setDescription('End a campaign')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('budget').setDescription('Change a campaign budget')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true))
      .addNumberOption(o => o.setName('amount').setDescription('New budget in USD')
        .setRequired(true)))),
].map(c => c.toJSON());

// ── Interaction router ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Autocomplete first — it has a 3s budget and must never queue behind work.
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);

    // Component interactions delegate to their owning module. Each router
    // returns true once it handles the ID, so we stop immediately instead of
    // falling through every branch like the old single-handler design did.
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
      if (await onboarding.route(interaction)) return;
      if (await campaigns.route(interaction)) return;
      if (await admin.route(interaction)) return;
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!await perms.enforceCooldown(interaction, 'cmd', config.COOLDOWNS.COMMAND_MS)) return;

    switch (interaction.commandName) {
      case 'submissions':  return mySubmissions(interaction);
      case 'balance':      return admin.balance(interaction);
      case 'leaderboard':  return leaderboardCommand(interaction);
      case 'campaigns':    return campaignList(interaction);
      case 'close':        return admin.closeTicket(interaction);

      case 'dashboard':    return admin.dashboard(interaction);
      case 'editor':       return admin.editorLookup(interaction);
      case 'promote':      return admin.promote(interaction);
      case 'demote':       return admin.demote(interaction);
      case 'nominations':  return admin.coreNominations(interaction);
      case 'migratecore':  return admin.migrateCore(interaction);
      case 'lockdown':     return admin.lockdown(interaction);
      case 'campaign':     return admin.campaignCommand(interaction);

      case 'updatestats': {
        if (!await perms.requireStaff(interaction)) return;
        await perms.safeDefer(interaction, true);
        const r = await campaigns.updateAllStats(client, { force: true });
        return interaction.editReply(
          `✅ Refresh complete — ${r.updated} updated, ${r.failed} failed.\n` +
          `TikWM ${r.usage.tikwm} · RapidAPI ${r.usage.rapidapi}`);
      }

      case 'panels': {
        if (!await perms.requireStaff(interaction)) return;
        await perms.safeDefer(interaction, true);
        await onboarding.ensurePanel(client);
        await postSupportPanel(client);
        return interaction.editReply('✅ Panels refreshed.');
      }
    }
  } catch (err) {
    console.error('[Interaction]', err);
    await perms.safeReply(interaction, '❌ Something went wrong. Try again in a moment.');
  }
});

async function handleAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'campaign') return interaction.respond([]);
    const list = perms.isStaff(interaction.user.id)
      ? await campaigns.listCampaigns()
      : await campaigns.visibleCampaigns(interaction.member, { activeOnly: false });
    const query = focused.value.toLowerCase();
    return interaction.respond(
      list.filter(c => c.label.toLowerCase().includes(query))
          .slice(0, 25)
          .map(c => ({ name: `${c.tier === 'core' ? '⭐ ' : ''}${c.label}`.slice(0, 100), value: c.value }))
    );
  } catch { return interaction.respond([]).catch(() => {}); }
}

// ── Editor-facing command implementations ───────────────────────────────────

async function mySubmissions(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const subs = await db.getDb().collection('submissions')
    .find({ userId: interaction.user.id }).sort({ submittedAt: -1 }).limit(25).toArray();
  if (!subs.length) return interaction.editReply('📭 No submissions yet.');

  const icon = { approved: '✅', pending: '⏳', rejected: '❌', flagged: '⚠️' };
  const totals = subs.filter(s => s.status === 'approved')
    .reduce((a, s) => ({ v: a.v + (s.views || 0), e: a.e + (s.earnings || 0) }), { v: 0, e: 0 });

  const embed = new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle('Your submissions')
    .setDescription(subs.slice(0, 15).map(s =>
      `${icon[s.status] || '•'} [${s.clipName}](${s.link}) — ${(s.views || 0).toLocaleString('en-US')} views` +
      (s.earnings ? ` · **$${s.earnings.toFixed(2)}**` : '')
    ).join('\n'))
    .addFields(
      { name: 'Total views', value: totals.v.toLocaleString('en-US'), inline: true },
      { name: 'Total earned', value: `$${totals.e.toFixed(2)}`, inline: true },
    )
    .setFooter({ text: 'Views refresh every 12 hours' });
  return interaction.editReply({ embeds: [embed] });
}

async function leaderboardCommand(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);
  const value = interaction.options.getString('campaign');
  const campaign = await campaigns.getCampaign(value);
  if (!campaign) return interaction.editReply('❌ Campaign not found.');
  if (!perms.canAccessCampaign(interaction.member, campaign)) {
    return interaction.editReply(perms.DENY.core);
  }
  const embed = await campaigns.buildLeaderboardEmbed(value, interaction.user.id);
  return interaction.editReply({ embeds: [embed] });
}

async function campaignList(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);
  const list = await campaigns.visibleCampaigns(interaction.member);
  if (!list.length) return interaction.editReply('No campaigns are open to you right now.');

  const lines = [];
  for (const c of list) {
    const b = await campaigns.budgetStatus(c);
    lines.push(
      `${c.tier === 'core' ? '⭐' : '🔓'} **${c.label}**\n` +
      `　$${c.rpm.toFixed(2)}/1K · cap $${c.maxPayout} · ` +
      `${Math.round(100 - b.percentUsed)}% budget left · ` +
      `ends <t:${Math.floor(new Date(c.endDate).getTime() / 1000)}:R>`);
  }
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(config.BRAND_COLOR)
      .setTitle('Campaigns open to you').setDescription(lines.join('\n\n'))],
  });
}

// ── Support panel ───────────────────────────────────────────────────────────

async function postSupportPanel(client) {
  try {
    const channelId = config.CHANNELS.LOGS; // change to your support channel
    const channel = await client.channels.fetch(channelId);
    const saved = await db.getMeta('supportPanelMessageId');
    const payload = {
      embeds: [new EmbedBuilder().setColor(config.BRAND_COLOR)
        .setTitle('Need help?')
        .setDescription('Open a ticket for payment questions, submission issues, or anything else.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_ticket').setLabel('Open Ticket')
          .setEmoji('🎟️').setStyle(ButtonStyle.Primary))],
    };
    if (saved) {
      const msg = await channel.messages.fetch(saved).catch(() => null);
      if (msg) return msg.edit(payload);
    }
    const msg = await channel.send(payload);
    await db.setMeta('supportPanelMessageId', msg.id);
  } catch (err) { console.error('[SupportPanel]', err.message); }
}

// ── Member join ─────────────────────────────────────────────────────────────

/**
 * Deliberately does NOT post a message.
 *
 * The old behaviour sent one welcome message per join. During a TikTok-driven
 * spike that is hundreds of sends into one channel, which Discord rate-limits
 * (roughly 5 messages per 5 seconds per channel). Most would fail, the channel
 * would be unreadable, and the static panel is a strictly better UX anyway.
 *
 * Invite attribution is throttled: fetching the invite list on every single
 * join is a per-guild rate limit you WILL hit during a spike, and once you're
 * limited the referral data is wrong anyway. We refresh at most once per
 * REFERRALS.CACHE_REFRESH_MS and only attribute when exactly one invite code
 * incremented — an honest "unknown" beats a confidently wrong attribution that
 * pays the wrong person a referral bonus.
 */
const inviteCache = new Map();
let lastInviteFetch = 0;

async function refreshInvites(guild, force = false) {
  const now = Date.now();
  if (!force && now - lastInviteFetch < config.REFERRALS.CACHE_REFRESH_MS) return null;
  lastInviteFetch = now;
  try {
    const invites = await guild.invites.fetch();
    const fresh = new Map();
    invites.forEach(i => fresh.set(i.code, { uses: i.uses, inviter: i.inviter?.id }));
    return fresh;
  } catch { return null; }
}

client.on(Events.GuildMemberAdd, async member => {
  try {
    const fresh = await refreshInvites(member.guild);
    if (!fresh) return;

    const increased = [];
    for (const [code, data] of fresh) {
      const old = inviteCache.get(code);
      if (old && data.uses > old.uses) increased.push({ code, ...data });
    }
    inviteCache.clear();
    for (const [code, data] of fresh) inviteCache.set(code, data);

    if (increased.length !== 1) return; // ambiguous — record nothing
    const invite = increased[0];
    if (!invite.inviter || invite.inviter === member.id) return;

    await db.getDb().collection('referrals').insertOne({
      inviterId: invite.inviter,
      inviteeId: member.id,
      inviteeUsername: member.user.username,
      inviteCode: invite.code,
      firstPostBonusPaid: false,
      milestonePaid: false,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('[GuildMemberAdd]', err.message);
  }
});

// ── Ready ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(config.GUILD_ID).catch(() => null);
  if (guild) {
    const fresh = await refreshInvites(guild, true);
    if (fresh) for (const [c, d] of fresh) inviteCache.set(c, d);
    console.log(`[Bot] Cached ${inviteCache.size} invites`);
  }

  await onboarding.ensurePanel(client);

  // Stats: first run after 30s, then every 12h.
  setTimeout(() => campaigns.updateAllStats(client).catch(console.error), 30_000);
  setInterval(() => campaigns.updateAllStats(client).catch(console.error), config.STATS.INTERVAL_MS);

  // Earnings clearing: hourly.
  setInterval(() => admin.clearMaturedEarnings().catch(console.error), 3_600_000);

  // Config sanity check — better to see this in logs at boot than to discover
  // it when a Core campaign posts into a channel that doesn't exist.
  const unset = [];
  if (config.ROLES.CORE.startsWith('SET_ME')) unset.push('ROLES.CORE');
  if (config.CHANNELS.CORE_CAMPAIGNS.startsWith('SET_ME')) unset.push('CHANNELS.CORE_CAMPAIGNS');
  if (unset.length) console.warn(`[Bot] ⚠️  Unset config values: ${unset.join(', ')}`);
});

// ── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (!config.TOKEN) throw new Error('TOKEN env var missing');
    if (!config.MONGODB_URI) throw new Error('MONGODB_URI env var missing');

    await db.connect();

    // Register commands BEFORE login and await it. The old code fired this as a
    // floating promise at module load, so a failure was invisible and commands
    // could silently not exist.
    const rest = new REST({ version: '10' }).setToken(config.TOKEN);
    await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID), { body: commands });
    console.log(`[Bot] Registered ${commands.length} commands`);

    await client.login(config.TOKEN);
  } catch (err) {
    console.error('[Boot] Fatal:', err);
    process.exit(1);
  }
})();

// Graceful shutdown — Railway sends SIGTERM on every redeploy. Without this,
// in-flight Mongo writes are killed mid-operation.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[Bot] ${sig} — shutting down`);
    try { await client.destroy(); await db.close(); } catch {}
    process.exit(0);
  });
}
