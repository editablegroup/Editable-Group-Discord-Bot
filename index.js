'use strict';

const {
  Client, GatewayIntentBits, Partials, Events, Options,
  SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const db = require('./db');
const ids = require('./ids');
const perms = require('./permissions');
const logging = require('./logging');
const provision = require('./provision');
const onboarding = require('./onboarding');
const campaigns = require('./campaigns');
const leaderboard = require('./leaderboard');
const payments = require('./payments');
const tickets = require('./tickets');
const admin = require('./admin');
const competition = require('./competition');
const panel = require('./panel');
const ratings = require('./ratings');

/**
 * ============================================================================
 *  EDITABLE GROUP BOT — ENTRY POINT
 * ============================================================================
 *  index.js does five things and nothing else:
 *    1. builds the client
 *    2. declares slash commands
 *    3. routes interactions to the right module
 *    4. runs the schedules
 *    5. boots
 *
 *  All business logic lives in the modules. All user-facing text lives in
 *  copy.js. All channel and role IDs resolve through ids.js.
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
    GatewayIntentBits.MessageContent, // privileged — needed for #chat-logs
  ],
  partials: [Partials.Channel, Partials.Message],

  /**
   * Cache limits. Not optional at this size.
   *
   * By default discord.js caches every message it sees and every member it
   * touches, forever. On a 2,000-member server with active chat that is
   * hundreds of megabytes of RSS growth over days, and Railway bills per GB per
   * minute, so an unbounded cache is both a crash risk and a bill.
   *
   * MessageManager is raised from 50 to 200 because #chat-logs can only report
   * the "before" text of an edit or deletion if the message is still cached.
   */
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 200,
    GuildMemberManager: { maxSize: 500, keepOverLimit: m => m.id === client.user?.id },
    UserManager: { maxSize: 500, keepOverLimit: u => u.id === client.user?.id },
    PresenceManager: 0,
    ReactionManager: 0,
    GuildBanManager: 0,
    ThreadManager: 25,
  }),
  sweepers: {
    messages: { interval: 900, lifetime: 3600 },
    users: { interval: 3600, filter: () => u => u.id !== client.user?.id },
  },
});

// ── Crash safety ────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => console.error('[UnhandledRejection]', err));
process.on('uncaughtException', err => console.error('[UncaughtException]', err));
client.on('error', err => console.error('[ClientError]', err));
client.on('shardError', err => console.error('[ShardError]', err));

// ── Command definitions ─────────────────────────────────────────────────────

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

const NICHE_CHOICES = config.NICHES.map(n => ({ name: n.label, value: n.value }));
// Defined in admin.js so the command choices and the handler cannot disagree.
const CHANNEL_CHOICES = admin.CHANNEL_KEYS.map(k => ({ name: k.name, value: k.value }));

const commands = [
  // ── Editor commands ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('submissions')
    .setDescription('Your edits, their status, views and earnings')
    .setDMPermission(false),

  // No required option any more: it opens a dropdown of the campaigns you can
  // see, which is one fewer thing to type and cannot 404 on a bad name.
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Pick a campaign and see its full leaderboard')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('campaigns')
    .setDescription('Every campaign open to you, with rate, pot left and deadline')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket')
    .setDMPermission(false),

  // ── Admin commands ───────────────────────────────────────────────────────
  adminCmd(new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create missing channels, roles and panels')),

  /**
   * Name matching in /setup is a guess. This is the manual override for when it
   * guesses wrong, which it will on any server whose channels carry emoji.
   */
  adminCmd(new SlashCommandBuilder()
    .setName('channels')
    .setDescription('See or change which channel the bot uses for what')
    .addSubcommand(s => s.setName('list')
      .setDescription('Show every channel the bot is currently pointing at'))
    .addSubcommand(s => s.setName('set')
      .setDescription('Point the bot at an existing channel')
      .addStringOption(o => o.setName('what').setDescription('Which one')
        .setRequired(true).addChoices(...CHANNEL_CHOICES))
      .addChannelOption(o => o.setName('channel').setDescription('The channel')
        .setRequired(true)))
    .addSubcommand(s => s.setName('clear')
      .setDescription('Forget a channel so /setup finds or creates one again')
      .addStringOption(o => o.setName('what').setDescription('Which one')
        .setRequired(true).addChoices(...CHANNEL_CHOICES)))
    .addSubcommand(s => s.setName('rematch')
      .setDescription('Re-find every channel by name. Delete duplicates first'))),

  adminCmd(new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Full operational overview')),

  adminCmd(new SlashCommandBuilder()
    .setName('editor')
    .setDescription('Look up one editor: tier, niches, payment method')
    .addUserOption(o => o.setName('user').setDescription('The editor').setRequired(true))),

  adminCmd(new SlashCommandBuilder()
    .setName('update')
    .setDescription('Refresh data on demand')
    .addSubcommand(s => s.setName('views')
      .setDescription('Force a TikTok view refresh now, outside the 3 hour cycle'))
    .addSubcommand(s => s.setName('leaderboard')
      .setDescription('Rebuild and repost the all-time leaderboard'))),

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
    .setDescription('Network editors who have met the Core bar')),

  adminCmd(new SlashCommandBuilder()
    .setName('migratecore')
    .setDescription('One-time: grant Core to all legacy hand-picked editors')),

  adminCmd(new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Hide every channel from @everyone except #onboarding')),

  adminCmd(new SlashCommandBuilder()
    .setName('panels')
    .setDescription('Repost onboarding, submit, payments and ticket panels')),

  adminCmd(new SlashCommandBuilder()
    .setName('submitpanel')
    .setDescription('Post the submissions panel in this channel')),

  adminCmd(new SlashCommandBuilder()
    .setName('comp')
    .setDescription('Manage the edit competition')
    .addSubcommand(s => s.setName('setup')
      .setDescription('Create the competition and enable the submit dropdown'))
    .addSubcommand(s => s.setName('preview')
      .setDescription('See a panel privately before posting it')
      .addStringOption(o => o.setName('panel').setDescription('Which panel').setRequired(true)
        .addChoices(
          { name: 'Public announcement (Join/Leave)', value: 'public' },
          { name: 'Announcement (private category)', value: 'announcement' },
          { name: 'Rules', value: 'rules' },
          { name: 'Submit info', value: 'submitinfo' },
        )))
    .addSubcommand(s => s.setName('post')
      .setDescription('Publish a panel to its channel')
      .addStringOption(o => o.setName('panel').setDescription('Which panel').setRequired(true)
        .addChoices(
          { name: 'Public announcement (Join/Leave)', value: 'public' },
          { name: 'Announcement (private category)', value: 'announcement' },
          { name: 'Rules', value: 'rules' },
          { name: 'Submit info', value: 'submitinfo' },
        ))
      .addBooleanOption(o => o.setName('ping')
        .setDescription('Ping @everyone? Defaults to NO').setRequired(false)))
    .addSubcommand(s => s.setName('board')
      .setDescription('Competition entries and views'))
    .addSubcommand(s => s.setName('close')
      .setDescription('Close the competition'))),

  /**
   * /campaign create takes attachments, which is why it is a command with
   * options rather than a modal. Discord modals cannot accept file uploads, and
   * a campaign post needs its audio and example videos.
   */
  adminCmd(new SlashCommandBuilder()
    .setName('campaign')
    .setDescription('Manage campaigns')
    .addSubcommand(s => s.setName('create')
      .setDescription('Create a campaign, its role, its category and its channels')
      .addStringOption(o => o.setName('name')
        .setDescription('Shown as the campaign title, eg "no na - HONK!"').setRequired(true))
      .addNumberOption(o => o.setName('rpm')
        .setDescription('Dollars per 1,000 views, eg 2').setRequired(true))
      .addNumberOption(o => o.setName('max_payout')
        .setDescription('Maximum one video can earn, eg 1200').setRequired(true))
      .addIntegerOption(o => o.setName('min_views')
        .setDescription('Views before a video earns anything, eg 2000').setRequired(true))
      .addNumberOption(o => o.setName('pot')
        .setDescription('Total budget for the campaign, eg 3000').setRequired(true))
      .addIntegerOption(o => o.setName('days')
        .setDescription('How many days it runs for').setRequired(true))
      .addStringOption(o => o.setName('brief')
        .setDescription('What editors should make').setRequired(true).setMaxLength(1000))
      .addStringOption(o => o.setName('tier')
        .setDescription('Who can join. Defaults to network')
        .addChoices(
          { name: 'Network (everyone onboarded)', value: 'network' },
          { name: 'Core only', value: 'core' },
        ))
      .addStringOption(o => o.setName('niches')
        .setDescription('Comma separated niches to ping, eg film_tv,celebs')
        .setAutocomplete(true))
      .addStringOption(o => o.setName('platform')
        .setDescription('Defaults to TikTok'))
      .addBooleanOption(o => o.setName('ping_everyone')
        .setDescription('Ping @everyone instead of the niche roles. Defaults to no'))
      .addAttachmentOption(o => o.setName('file1').setDescription('Audio or example video'))
      .addAttachmentOption(o => o.setName('file2').setDescription('Audio or example video'))
      .addAttachmentOption(o => o.setName('file3').setDescription('Audio or example video'))
      .addAttachmentOption(o => o.setName('file4').setDescription('Audio or example video')))
    .addSubcommand(s => s.setName('post').setDescription('Post the campaign to its channel')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('end').setDescription('End a campaign and archive its channels')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('budget').setDescription('Change a campaign pot')
      .addStringOption(o => o.setName('campaign').setDescription('Which campaign')
        .setRequired(true).setAutocomplete(true))
      .addNumberOption(o => o.setName('amount').setDescription('New pot in USD')
        .setRequired(true)))),
].map(c => c.toJSON());

// ── Interaction router ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Autocomplete first — it has a 3s budget and must never queue behind work.
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);

    // Component interactions delegate to their owning module. Each router
    // returns true once it handles the ID, so we stop immediately rather than
    // falling through every branch.
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
      if (await onboarding.route(interaction)) return;
      if (await payments.route(interaction)) return;
      if (await tickets.route(interaction)) return;
      if (await competition.route(interaction)) return;
      if (await panel.route(interaction)) return;
      if (await campaigns.route(interaction)) return;
      if (await admin.route(interaction)) return;
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!await perms.enforceCooldown(interaction, 'cmd', config.COOLDOWNS.COMMAND_MS)) return;

    switch (interaction.commandName) {
      case 'submissions':  return panel.handleMySubmissions(interaction);
      case 'leaderboard':  return leaderboardCommand(interaction);
      case 'campaigns':    return panel.handleStatus(interaction);
      case 'close':        return tickets.close(interaction);

      case 'setup':        return admin.setup(interaction);
      case 'channels':     return admin.channelsCommand(interaction);
      case 'dashboard':    return admin.dashboard(interaction);
      case 'editor':       return admin.editorLookup(interaction);
      case 'promote':      return admin.promote(interaction);
      case 'demote':       return admin.demote(interaction);
      case 'nominations':  return admin.coreNominations(interaction);
      case 'migratecore':  return admin.migrateCore(interaction);
      case 'lockdown':     return admin.lockdown(interaction);
      case 'campaign':     return admin.campaignCommand(interaction);
      case 'comp':         return competition.command(interaction);
      case 'submitpanel':  return panel.command(interaction);
      case 'update':       return updateCommand(interaction);

      case 'panels': {
        if (!await perms.requireStaff(interaction)) return;
        await perms.safeDefer(interaction, true);
        await onboarding.ensurePanel(client);
        await panel.ensurePanel(client);
        await payments.ensurePanel(client);
        await tickets.ensurePanel(client);
        return interaction.editReply(
          'Reposted the onboarding, submit, payments and ticket panels.');
      }
    }
  } catch (err) {
    console.error('[Interaction]', err);
    await perms.safeReply(interaction, copy.common.errIn('that command'));
  }
});

async function handleAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'niches') {
      // Suggest each niche on its own, plus every niche at once, and let the
      // typed value through so combinations can be entered by hand.
      const all = config.NICHES.map(n => n.value).join(',');
      const options = [
        ...config.NICHES.map(n => ({ name: n.label, value: n.value })),
        { name: 'Every niche', value: all },
      ];
      const typed = focused.value.trim();
      if (typed) options.unshift({ name: typed.slice(0, 100), value: typed.slice(0, 100) });
      return interaction.respond(options.slice(0, 25));
    }

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

// ── /leaderboard and /update ────────────────────────────────────────────────

async function leaderboardCommand(interaction) {
  if (!await perms.requireOnboarded(interaction)) return;
  await perms.safeDefer(interaction, true);

  const list = await panel.accessibleCampaigns(interaction.member);
  if (!list.length) return interaction.editReply(copy.campaign.statusNone());

  if (list.length === 1) {
    const embed = await campaigns.buildLeaderboardEmbed(list[0].value, interaction.user.id);
    return interaction.editReply({ embeds: [embed] });
  }

  const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
  return interaction.editReply({
    content: copy.leaderboard.pickPrompt,
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('panel:board')
        .setPlaceholder(copy.leaderboard.pickPlaceholder)
        .addOptions(list.slice(0, 25).map(c => ({
          label: c.label.slice(0, 100),
          value: c.value,
        }))))],
  });
}

async function updateCommand(interaction) {
  if (!await perms.requireStaff(interaction)) return;
  const sub = interaction.options.getSubcommand();
  await perms.safeDefer(interaction, true);

  if (sub === 'views') {
    const r = await campaigns.updateAllStats(client, { force: true });
    return interaction.editReply(
      `Refresh done. ${r.updated} updated, ${r.failed} failed.\n` +
      `Free lookups: ${r.usage.tikwm} TikWM. Paid: ${r.usage.rapidapi} RapidAPI, ` +
      `${r.paidToday} so far today against a ceiling of ` +
      `${config.STATS.MAX_PAID_LOOKUPS_PER_DAY}.`);
  }

  if (sub === 'leaderboard') {
    await leaderboard.publish(client);
    return interaction.editReply('All-time leaderboard rebuilt and reposted.');
  }
}

// ── Member join: invite attribution ─────────────────────────────────────────

/**
 * Deliberately does NOT post a welcome message. The old behaviour sent one per
 * join, and during a TikTok-driven spike that is hundreds of sends into one
 * channel, which Discord rate-limits at roughly 5 messages per 5 seconds. Most
 * would fail and the channel would be unreadable. The static panel in
 * #onboarding is strictly better. #join-leave logging covers the audit side.
 *
 * Invite attribution is throttled: fetching the invite list on every join is a
 * per-guild rate limit you WILL hit during a spike, and once limited the data
 * is wrong anyway. We refresh at most once per CACHE_REFRESH_MS and attribute
 * only when exactly one invite code incremented. An honest "unknown" beats a
 * confidently wrong attribution that pays the wrong person a referral bonus.
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

  const resolved = await ids.warm();
  console.log(`[Bot] ${resolved} IDs resolved from the database`);

  logging.attach(client);
  ratings.attach(client);

  const guild = await client.guilds.fetch(config.GUILD_ID).catch(() => null);
  if (guild) {
    const fresh = await refreshInvites(guild, true);
    if (fresh) for (const [c, d] of fresh) inviteCache.set(c, d);
    console.log(`[Bot] Cached ${inviteCache.size} invites`);

    const capability = provision.checkCapability(guild);
    if (!capability.ok) {
      console.warn('[Bot] Permission problems:', capability.problems.join(' '));
    }
  }

  // Panels are deliberately NOT posted on boot.
  //
  // Railway redeploys on every push, so doing this here meant every change to
  // any file reposted five panels and pinned them again. Panels are now only
  // touched when you explicitly ask: /setup, /panels, /submitpanel, or
  // /channels set after moving one.

  // Stats: first run after 30s, then on the configured interval.
  setTimeout(() => campaigns.updateAllStats(client).catch(console.error), 30_000);
  setInterval(() => campaigns.updateAllStats(client).catch(console.error), config.STATS.INTERVAL_MS);

  // Hourly: clear matured earnings, then delete campaign roles past their
  // grace period.
  setInterval(() => {
    admin.clearMaturedEarnings().catch(console.error);
    provision.sweepExpiredRoles(client).catch(console.error);
  }, 3_600_000);

  const unset = ids.missing();
  if (unset.length) {
    console.warn(`[Bot] Unresolved IDs (run /setup): ${unset.join(', ')}`);
  }

  logging.system('Bot online',
    `Logged in as ${client.user.tag}.\n` +
    `Views refresh every ${copy.REFRESH_HOURS} hours.\n` +
    (unset.length ? `Unresolved IDs: ${unset.length}. Run /setup.` : 'All IDs resolved.'),
    unset.length ? 'warn' : 'good');
});

// ── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (!config.TOKEN) throw new Error('TOKEN env var missing');
    if (!config.MONGODB_URI) throw new Error('MONGODB_URI env var missing');

    await db.connect();

    // Register commands BEFORE login and await it. Firing this as a floating
    // promise at module load makes a failure invisible and lets commands
    // silently not exist.
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
