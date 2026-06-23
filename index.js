const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const { MongoClient, ObjectId } = require('mongodb');

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1498623710301650994';
const GUILD_ID = '1437187584689438865';
const SUBMISSIONS_CHANNEL_ID = '1498679979666444378';
const OWNER_ID = '960171711674847282';
const ROCA_ID = '996919845373366362';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'tiktok-api23.p.rapidapi.com';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

const ONBOARDING_CHANNEL_ID = '1508909360510795837';
const LOG_CHANNEL_ID = '1505978732010274846';
const EDITOR_ROLE_ID = '1437195425819131915';
const ACTIVE_CAMPAIGNS_CHANNEL_ID = '1506778321969746092';
const DEMOGRAPHICS_CHANNEL_ID = '1519022400828739604';
// editorId -> { step: 'gender'|'age'|'locations', gender?, age?, locations? }  (guided collection)
const demographicsPending = {};
// OWNER_ID -> { editorId } while owner is typing in demographic numbers via DM
const demographicsEntry = {};
const DEMO_STEPS = ['gender', 'age', 'locations'];
const DEMO_STEP_LABELS = { gender: 'Gender', age: 'Age', locations: 'Locations' };

function isOwner(userId) {
  return userId === OWNER_ID || userId === ROCA_ID;
}
function dateStr(d) {
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}
function normalizeUrl(url) {
  if (!url) return '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) return 'https://' + url;
  return url;
}

// ===== CAMPAIGNS =====
const CAMPAIGNS = [
  {
    label: 'Alter Ego - Doechii Ft. JT',
    value: 'alter_ego_doechii',
    rpm: 1.00,
    maxPayout: 350,
    minViews: 1500,
    budget: 1075,
    bonus1st: 150,
    bonus2nd: 75,
    endDate: new Date('2026-05-20T23:59:59Z'),
  },
  {
    label: 'SHAKE THAT - JIG LeFrost',
    value: 'shake_that_jig',
    rpm: 1.00,
    maxPayout: 350,
    minViews: 1500,
    budget: 1000,
    bonus1st: 100,
    bonus2nd: 50,
    endDate: new Date('2026-05-24T23:59:59Z'),
  },
  {
    label: 'Fuëgo - BNYX®, Yeat & Peso Pluma',
    value: 'fuego_bnyx',
    rpm: 1.25,
    maxPayout: 400,
    minViews: 1500,
    budget: 1075,
    bonus1st: 150,
    bonus2nd: 75,
    endDate: new Date('2026-06-03T21:59:59Z'),
    roleId: '1506777268754579506',
    announcementChannelId: '1506777667020521472',
    offerChannelId: '1506778321969746092',
    brief: 'Popular TV shows, movies, thirst traps, and Latina characters — think Maddie Perez from Euphoria. Keep it cinematic, trending and visually striking.',
  },
  // { label: 'Campaign Name', value: 'campaign_value', rpm: 1.00, maxPayout: 350, minViews: 1500, budget: 1000, bonus1st: 150, bonus2nd: 75, endDate: new Date('2026-06-01T23:59:59Z'), roleId: 'ROLE_ID', announcementChannelId: 'CHANNEL_ID', offerChannelId: 'CHANNEL_ID', brief: 'Brief here.' },
];

// ===== MONGODB =====
let db;
async function connectDB() {
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db('editablegroup');
  console.log('Connected to MongoDB');
}

// ===== HELPERS =====
function timeAgo(date) {
  if (!date) return null;
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
function fmtViews(n) { return (n || 0).toLocaleString('en-US'); }
function fmtUSD(n) { return `$${(n || 0).toFixed(2)}`; }
function buildPostLinks(subs) {
  return subs.map((s, i) => `[${i + 1}](<${normalizeUrl(s.link)}>)`).join(' ');
}

async function getTotalDeducted(campaignValue) {
  const deductions = await db.collection('deductions').find({ campaignValue }).toArray();
  return deductions.reduce((sum, d) => sum + (d.amount || 0), 0);
}

const statsPageCache = {};
const onboardingState = {};

// ===== TIKTOK STATS =====
async function extractVideoId(url) {
  const direct = url.match(/video\/(\d+)/);
  if (direct) return direct[1];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    const match = res.url.match(/video\/(\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.error('Short URL resolve error:', err.message);
    return null;
  }
}

async function fetchTikTokStats(videoId) {
  try {
    const res = await fetch(
      `https://tiktok-api23.p.rapidapi.com/api/post/detail?videoId=${videoId}`,
      { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } }
    );
    const data = await res.json();
    const item = data?.itemList?.[0] || data?.itemInfo?.itemStruct;
    if (!item) return null;
    const views = item.stats?.playCount || item.statsV2?.playCount || 0;
    const likes = item.stats?.diggCount || item.statsV2?.diggCount || 0;
    const createTime = item.createTime ? parseInt(item.createTime) : null;
    return { views: parseInt(views), likes: parseInt(likes), createTime };
  } catch (err) {
    console.error('TikTok fetch error:', err.message);
    return null;
  }
}

function calculateEarnings(views, campaign) {
  if (new Date() > campaign.endDate) return null;
  if (views < campaign.minViews) return 0;
  return Math.min((views / 1000) * campaign.rpm, campaign.maxPayout);
}

async function canRunStats() {
  try {
    const record = await db.collection('metadata').findOne({ key: 'lastStatsRun' });
    if (!record) return true;
    return (Date.now() - new Date(record.value).getTime()) >= TWELVE_HOURS;
  } catch { return true; }
}

async function updateAllStats(force = false) {
  if (!force && !(await canRunStats())) {
    console.log('[Stats] Skipping — ran less than 12h ago');
    return;
  }
  console.log('[Stats] Starting update...');
  await db.collection('metadata').updateOne(
    { key: 'lastStatsRun' },
    { $set: { value: new Date() } },
    { upsert: true }
  );
  try {
    const approved = await db.collection('submissions').find({ status: 'Approved ✅' }).toArray();
    let updated = 0;
    for (const sub of approved) {
      const campaign = CAMPAIGNS.find(c => c.value === sub.campaignValue);
      if (!campaign) continue;
      if (new Date() > campaign.endDate && sub.views > 0) continue;
      const videoId = await extractVideoId(sub.link);
      if (!videoId) continue;
      const stats = await fetchTikTokStats(videoId);
      if (!stats) continue;
      const earnings = calculateEarnings(stats.views, campaign);
      const updateFields = { views: stats.views, likes: stats.likes, earnings, lastUpdated: new Date(), videoId };
      if (stats.createTime) updateFields.postedAt = new Date(stats.createTime * 1000);
      await db.collection('submissions').updateOne({ _id: sub._id }, { $set: updateFields });
      updated++;

      // --- Referral: $50 bonus, first single post by this invitee to cross 500k, before campaign deadline ---
      try {
        if (stats.views >= 500000 && new Date() <= campaign.endDate) {
          const referral = await db.collection('referrals').findOne({
            inviteeId: sub.userId,
            bonus500kPaid: false,
          });
          if (referral) {
            await db.collection('referrals').updateOne(
              { _id: referral._id },
              { $set: { bonus500kPaid: true, bonus500kAt: new Date(), bonus500kSubmissionId: sub._id } }
            );
            const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
            await logChannel.send(
              `🔗 **Referral bonus:** <@${referral.inviterId}> referred <@${sub.userId}>, whose post on **${sub.campaignLabel}** just crossed **500,000 views**.\n` +
              `💵 <@${referral.inviterId}> earns **$${REFERRAL_500K_BONUS}**.`
            );
          }
        }
      } catch (err) {
        console.error('[Referrals] 500k bonus error:', err.message);
      }
    }
    console.log(`[Stats] Updated ${updated}/${approved.length} submissions`);
  } catch (err) {
    console.error('[Stats] Error:', err.message);
  }
}

// ===== ONBOARDING COMPLETION =====
async function completeOnboarding(interaction, state) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  await member.roles.add(EDITOR_ROLE_ID);

  // Persist editor profile so it can be queried later (dashboard, /editor lookup)
  try {
    await db.collection('editors').updateOne(
      { userId: interaction.user.id },
      {
        $set: {
          userId: interaction.user.id,
          username: interaction.user.username,
          tiktok: state.tiktok || null,
          paymentMethod: state.payment || null,
          paypalEmail: state.payment === 'paypal' ? (state.paypalEmail || null) : null,
          updatedAt: new Date(),
        },
        $setOnInsert: { joinedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[Editors] Failed to persist profile:', err.message);
  }

  if (state.welcomeMessageId) {
    try {
      const onboardingChannel = await client.channels.fetch(ONBOARDING_CHANNEL_ID);
      const welcomeMsg = await onboardingChannel.messages.fetch(state.welcomeMessageId);
      await welcomeMsg.delete();
    } catch { }
  }

  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    const now = new Date();
    const timeString =
      `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}` +
      ` at ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const paymentString = state.payment === 'paypal'
      ? `PayPal — ${state.paypalEmail}`
      : 'Bank Transfer';
    await logChannel.send(
      `👋 **New Member:** <@${interaction.user.id}> (@${interaction.user.username})\n` +
      `🎵 **TikTok:** ${state.tiktok || 'Not provided'}\n` +
      `💳 **Payment:** ${paymentString}\n` +
      `🕐 **Joined:** ${timeString}`
    );
  } catch (err) {
    console.error('Log error:', err.message);
  }

  delete onboardingState[interaction.user.id];

  await interaction.reply({
    content:
      `✅ **You're all set! Welcome to Editable Group.**\n\n` +
      `📢 Check out **Active Campaigns** to see what we're running right now and start earning.\n\n` +
      `💬 **Stay on top of your DMs** — Cilord and Roca will reach out directly for payments, campaign updates and important info. Communication is what keeps Editable Group alive, so make sure you're always reachable. 🙏`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🎯 View Active Campaigns')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${GUILD_ID}/${ACTIVE_CAMPAIGNS_CHANNEL_ID}`)
    )],
    ephemeral: true,
  });
}

// ===== CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});
const pendingCampaign = {};

// ===== REFERRAL CONFIG =====
const REFERRAL_FIRST_POST_BONUS = 5;   // paid to inviter when invitee's first submission is approved (ever)
const REFERRAL_500K_BONUS = 50;        // paid to inviter when invitee's single post crosses 500k views for the first time
const inviteCache = new Map(); // guildId -> Map(code -> uses)

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('mysubmissions')
    .setDescription('View your submissions and earnings'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('See the top editors by views for a campaign')
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Which campaign').setRequired(true)
        .addChoices(...CAMPAIGNS.map(c => ({ name: c.label, value: c.value })))
    ),

  new SlashCommandBuilder()
    .setName('earnings')
    .setDescription('Full earnings breakdown for a campaign — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Which campaign').setRequired(true)
        .addChoices(...CAMPAIGNS.map(c => ({ name: c.label, value: c.value })))
    ),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('All posts sorted by date with views + likes — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Which campaign').setRequired(true)
        .addChoices(...CAMPAIGNS.map(c => ({ name: c.label, value: c.value })))
    )
    .addUserOption(opt =>
      opt.setName('user').setDescription('Filter to a specific editor').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('campaignoffer')
    .setDescription('Post a campaign offer message — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Which campaign to post the offer for').setRequired(true)
        .addChoices(...CAMPAIGNS.filter(c => c.offerChannelId).map(c => ({ name: c.label, value: c.value })))
    ),

  new SlashCommandBuilder()
    .setName('addsubmission')
    .setDescription('Manually add a past submission — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt => opt.setName('user').setDescription('The editor').setRequired(true))
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Campaign').setRequired(true)
        .addChoices(...CAMPAIGNS.map(c => ({ name: c.label, value: c.value })))
    )
    .addStringOption(opt => opt.setName('link').setDescription('TikTok link').setRequired(true))
    .addStringOption(opt => opt.setName('name').setDescription('Edit name').setRequired(false))
    .addStringOption(opt => opt.setName('date').setDescription('Date submitted (DD/MM/YYYY)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('removesubmission')
    .setDescription('Remove a submission by TikTok link — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('link').setDescription('TikTok link to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('deductbudget')
    .setDescription('Manually deduct an amount from a campaign budget — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Which campaign').setRequired(true)
        .addChoices(...CAMPAIGNS.map(c => ({ name: c.label, value: c.value })))
    )
    .addNumberOption(opt => opt.setName('amount').setDescription('Amount to deduct in USD (e.g. 80)').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for deduction').setRequired(true)),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send the support ticket panel — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('submitpanel')
    .setDescription('Send the submission panel — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('onboardingpanel')
    .setDescription('Post the onboarding panel in #onboarding — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a ticket'),

  new SlashCommandBuilder()
    .setName('updatestats')
    .setDescription('Manually trigger a TikTok stats update — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Full operational overview — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('editor')
    .setDescription('Look up a single editor profile — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt =>
      opt.setName('user').setDescription('The editor to look up').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('demographicspanel')
    .setDescription('Post the demographics submission panel in #demographics — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  console.log('Registering commands...');
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Commands registered');
})();

// ===== READY =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  setTimeout(() => updateAllStats(false), 15000);
  setInterval(() => updateAllStats(false), TWELVE_HOURS);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const invites = await guild.invites.fetch();
    const codeMap = new Map();
    invites.forEach(inv => codeMap.set(inv.code, inv.uses));
    inviteCache.set(GUILD_ID, codeMap);
    console.log(`[Referrals] Cached ${codeMap.size} invite codes`);
  } catch (err) {
    console.error('[Referrals] Failed to cache invites on ready:', err.message);
  }
});

// ===== NEW MEMBER =====
client.on('guildMemberAdd', async member => {
  try {
    // --- Referral detection: diff invite uses against the cache ---
    try {
      const guild = member.guild;
      const newInvites = await guild.invites.fetch();
      const oldCodeMap = inviteCache.get(guild.id) || new Map();
      let usedInvite = null;

      for (const inv of newInvites.values()) {
        const oldUses = oldCodeMap.get(inv.code) || 0;
        if (inv.uses > oldUses) {
          usedInvite = inv;
          break;
        }
      }

      // refresh cache regardless of whether we found a match
      const refreshedMap = new Map();
      newInvites.forEach(inv => refreshedMap.set(inv.code, inv.uses));
      inviteCache.set(guild.id, refreshedMap);

      if (usedInvite && usedInvite.inviter && usedInvite.inviter.id !== member.id) {
        await db.collection('referrals').insertOne({
          inviterId: usedInvite.inviter.id,
          inviteeId: member.id,
          inviteeUsername: member.user.username,
          inviteCode: usedInvite.code,
          firstPostBonusPaid: false,
          bonus500kPaid: false,
          createdAt: new Date(),
        });
        console.log(`[Referrals] ${member.user.username} was invited by ${usedInvite.inviter.username} (code ${usedInvite.code})`);
      }
    } catch (err) {
      console.error('[Referrals] Invite detection error:', err.message);
    }

    const channel = await client.channels.fetch(ONBOARDING_CHANNEL_ID);
    const msg = await channel.send({
      content: `👋 Welcome! Please complete the onboarding below to get access to the server.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_onboarding')
          .setLabel('🚀 Start Onboarding')
          .setStyle(ButtonStyle.Primary)
      )],
    });
    onboardingState[member.id] = { welcomeMessageId: msg.id };
  } catch (err) {
    console.error('guildMemberAdd error:', err.message);
  }
});

// ===== INVITE CREATE/DELETE: keep cache fresh =====
client.on('inviteCreate', invite => {
  const map = inviteCache.get(invite.guild.id) || new Map();
  map.set(invite.code, invite.uses);
  inviteCache.set(invite.guild.id, map);
});
client.on('inviteDelete', invite => {
  const map = inviteCache.get(invite.guild.id);
  if (map) map.delete(invite.code);
});

// ===== DEMOGRAPHICS: guided collection + owner data entry (DM only) =====
client.on('messageCreate', async message => {
  console.log('[DEBUG] messageCreate fired. bot:', message.author.bot, 'channelType:', message.channel?.type, 'from:', message.author.username, 'attachments:', message.attachments.size);
  try {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;

    // ---- (A) OWNER is typing in the numbers for an editor ----
    if (message.author.id === OWNER_ID && demographicsEntry[OWNER_ID]) {
      const entry = demographicsEntry[OWNER_ID];
      const text = message.content.trim();
      if (text.toLowerCase() === 'cancel') {
        delete demographicsEntry[OWNER_ID];
        return message.reply('❌ Cancelled. No data saved.').catch(() => {});
      }
      // Expecting: topCountry | usPercent | topAge | malePercent
      const parts = text.split('|').map(p => p.trim());
      if (parts.length < 4) {
        return message.reply(
          '⚠️ Format not recognised. Please send as:\n' +
          '`TopCountry | US% | TopAgeBracket | Male%`\n' +
          'Example: `United States | 26.5 | 18-24 | 75`\n' +
          'Or type `cancel` to stop.'
        ).catch(() => {});
      }
      const [topCountry, usPercent, topAge, malePercent] = parts;
      await db.collection('editors').updateOne(
        { userId: entry.editorId },
        {
          $set: {
            demographicsData: {
              topCountry,
              usPercent: parseFloat(usPercent) || 0,
              topAge,
              malePercent: parseFloat(malePercent) || 0,
              enteredAt: new Date(),
            },
          },
          $setOnInsert: { joinedAt: new Date() },
        },
        { upsert: true }
      );
      delete demographicsEntry[OWNER_ID];
      return message.reply(
        `✅ Saved demographics for <@${entry.editorId}>:\n` +
        `🌍 Top country: **${topCountry}** · 🇺🇸 US: **${usPercent}%** · 🎂 Top age: **${topAge}** · 👤 Male: **${malePercent}%**`
      ).catch(() => {});
    }

    // ---- (B) EDITOR is in the guided screenshot flow ----
    const pending = demographicsPending[message.author.id];
    if (!pending) return;

    const image = message.attachments.find(a =>
      (a.contentType && a.contentType.startsWith('image/')) ||
      /\.(png|jpe?g|webp|gif)$/i.test(a.name || '')
    );
    if (!image) {
      return message.reply(`⚠️ That wasn't an image. Please send your **${DEMO_STEP_LABELS[pending.step]}** screenshot.`).catch(() => {});
    }

    // store this step's image URL on the pending state
    pending[pending.step] = image.url;
    const currentIndex = DEMO_STEPS.indexOf(pending.step);
    const nextStep = DEMO_STEPS[currentIndex + 1];

    if (nextStep) {
      pending.step = nextStep;
      demographicsPending[message.author.id] = pending;
      const stepNum = currentIndex + 2;
      return message.reply(
        `✅ ${DEMO_STEP_LABELS[DEMO_STEPS[currentIndex]]} saved.\n\n` +
        `**Step ${stepNum} of 3 — ${DEMO_STEP_LABELS[nextStep]}**\nPlease send your **${DEMO_STEP_LABELS[nextStep]}** screenshot now.`
      ).catch(() => {});
    }

    // all three collected — persist URLs and forward to owner
    delete demographicsPending[message.author.id];

    await db.collection('editors').updateOne(
      { userId: message.author.id },
      {
        $set: {
          userId: message.author.id,
          username: message.author.username,
          demographicsImages: {
            gender: pending.gender,
            age: pending.age,
            locations: pending.locations,
          },
          demographicsSubmittedAt: new Date(),
        },
        $setOnInsert: { joinedAt: new Date() },
      },
      { upsert: true }
    );

    await message.reply('✅ All three saved — thank you! You\'re all set. 🙌').catch(() => {});

    // forward the three images to OWNER only, with a button to enter the numbers
    try {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send(
        `📷 **New demographics submitted** by <@${message.author.id}> (@${message.author.username})\n` +
        `Below: Gender, Age, Locations. Click the button to type in the numbers.`
      );
      for (const step of DEMO_STEPS) {
        const e = new EmbedBuilder()
          .setColor(0x1a3fb0)
          .setTitle(`${DEMO_STEP_LABELS[step]} — @${message.author.username}`)
          .setImage(pending[step]);
        await owner.send({ embeds: [e] });
      }
      await owner.send({
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`enter_demographics_${message.author.id}`)
            .setLabel('✍️ Enter numbers for this editor')
            .setStyle(ButtonStyle.Primary)
        )],
      });
    } catch (err) {
      console.error('[Demographics] Owner forward error:', err.message);
    }
  } catch (err) {
    console.error('[Demographics] Capture error:', err.message);
  }
});

// ===== BUILD: MY SUBMISSIONS EMBED =====
async function buildMySubmissionsEmbed(userId) {
  const userSubs = await db.collection('submissions')
    .find({ userId })
    .sort({ submittedAt: -1 })
    .toArray();

  if (userSubs.length === 0) return null;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎬 Clip Status')
    .setFooter({ text: 'Stats update every 12 hours' });

  let description = 'Your submitted clips are listed below.\n\n';

  for (const sub of userSubs) {
    const campaign = CAMPAIGNS.find(c => c.value === sub.campaignValue);
    const isApproved = sub.status === 'Approved ✅';
    const views = sub.views || 0;
    const earnings = sub.earnings;
    const url = normalizeUrl(sub.link);

    description += `**${sub.campaignLabel}**\n`;

    if (isApproved && campaign) {
      const campaignEnded = new Date() > campaign.endDate;
      let earningsDisplay;
      if (campaignEnded || earnings === null) {
        earningsDisplay = `${fmtUSD(sub.earnings || 0)} earned (final)`;
      } else if (earnings === 0) {
        earningsDisplay = `$0.00 earned (needs ${campaign.minViews.toLocaleString()} views)`;
      } else {
        earningsDisplay = `${fmtUSD(earnings)} earned`;
      }

      description += `🟢 **${sub.clipName}**: ${fmtViews(views)} views | ${earningsDisplay}\n`;

      if (views > 0) {
        const allApproved = await db.collection('submissions')
          .find({ campaignValue: sub.campaignValue, status: 'Approved ✅' })
          .toArray();
        const userTotals = {};
        for (const s of allApproved) {
          if (!userTotals[s.userId]) userTotals[s.userId] = 0;
          userTotals[s.userId] += s.views || 0;
        }
        const sorted = Object.entries(userTotals).sort((a, b) => b[1] - a[1]);
        const rank = sorted.findIndex(([uid]) => uid === sub.userId) + 1;
        const totalEarnings = allApproved
          .filter(s => s.userId === sub.userId)
          .reduce((sum, s) => sum + (s.earnings || 0), 0);
        if (rank === 1)
          description += `🥇 1st place — +${fmtUSD(campaign.bonus1st)} bonus | Total: ${fmtUSD(totalEarnings + campaign.bonus1st)}\n`;
        else if (rank === 2)
          description += `🥈 2nd place — +${fmtUSD(campaign.bonus2nd)} bonus | Total: ${fmtUSD(totalEarnings + campaign.bonus2nd)}\n`;
      }

      const ago = timeAgo(sub.lastUpdated);
      description += `└ [Watch on TikTok](<${url}>) · 🕐 ${ago ? `Updated ${ago}` : 'Not updated yet — check back in 12 hours'}\n\n`;
    } else if (sub.status === 'Rejected ❌') {
      description += `🔴 **${sub.clipName}** — Rejected · [View post](<${url}>)\n\n`;
    } else {
      description += `⏳ **${sub.clipName}** — Pending review · [View post](<${url}>)\n\n`;
    }
  }

  embed.setDescription(description);
  return embed;
}

// ===== BUILD: LEADERBOARD =====
async function buildLeaderboardText(campaignValue) {
  const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
  if (!campaign) return '❌ Campaign not found.';

  const approved = await db.collection('submissions')
    .find({ campaignValue, status: 'Approved ✅' })
    .toArray();

  const isActive = new Date() < campaign.endDate;
  const endTs = Math.floor(campaign.endDate.getTime() / 1000);

  let totalRpmEarned = 0;
  for (const sub of approved) totalRpmEarned += sub.earnings || 0;
  const totalDeducted = await getTotalDeducted(campaignValue);
  const budgetRemaining = Math.max(0, campaign.budget - totalRpmEarned - totalDeducted);

  const totalViews = approved.reduce((sum, s) => sum + (s.views || 0), 0);
  const lastRun = await db.collection('metadata').findOne({ key: 'lastStatsRun' });
  const lastRunAgo = lastRun ? timeAgo(lastRun.value) : null;

  let text = `🏆 **${campaign.label} — Leaderboard**\n`;
  text += isActive ? `🟢 Active — ends <t:${endTs}:R>\n` : `🔴 Campaign ended\n`;
  text += `👁️ Total views: ${fmtViews(totalViews)}\n`;
  text += `💰 Budget remaining: ${fmtUSD(budgetRemaining)} / ${fmtUSD(campaign.budget)}\n`;
  text += `🎁 Bonuses: 🥇 ${fmtUSD(campaign.bonus1st)} · 🥈 ${fmtUSD(campaign.bonus2nd)}\n`;
  text += `🕐 ${lastRunAgo ? `Updated ${lastRunAgo}` : 'Not updated yet'} · Updates every 12h\n\n`;

  if (approved.length === 0) { text += '*No approved submissions yet.*'; return text; }

  const userMap = {};
  for (const sub of approved) {
    if (!userMap[sub.userId]) userMap[sub.userId] = { views: 0, posts: [] };
    userMap[sub.userId].views += sub.views || 0;
    userMap[sub.userId].posts.push(sub);
  }
  const sorted = Object.entries(userMap).sort((a, b) => b[1].views - a[1].views);

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < sorted.length; i++) {
    const [userId, data] = sorted[i];
    const medal = medals[i] || `${i + 1}.`;
    let bonusNote = '';
    if (i === 0) bonusNote = ` *(+${fmtUSD(campaign.bonus1st)} bonus)*`;
    if (i === 1) bonusNote = ` *(+${fmtUSD(campaign.bonus2nd)} bonus)*`;
    const links = buildPostLinks(data.posts);
    text += `${medal} <@${userId}> — ${fmtViews(data.views)} views${bonusNote} · ${links}\n`;
  }

  return text;
}

// ===== BUILD: EARNINGS =====
async function buildEarningsText(campaignValue) {
  const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
  if (!campaign) return '❌ Campaign not found.';

  const approved = await db.collection('submissions')
    .find({ campaignValue, status: 'Approved ✅' })
    .toArray();

  const isActive = new Date() < campaign.endDate;
  const endTs = Math.floor(campaign.endDate.getTime() / 1000);

  const userMap = {};
  for (const sub of approved) {
    if (!userMap[sub.userId]) userMap[sub.userId] = { views: 0, earnings: 0, posts: [] };
    userMap[sub.userId].views += sub.views || 0;
    userMap[sub.userId].earnings += sub.earnings || 0;
    userMap[sub.userId].posts.push(sub);
  }
  const sorted = Object.entries(userMap).sort((a, b) => b[1].views - a[1].views);

  let totalRpm = 0;
  for (const [, data] of sorted) totalRpm += data.earnings;
  const totalDeducted = await getTotalDeducted(campaignValue);
  const budgetRemaining = Math.max(0, campaign.budget - totalRpm - totalDeducted);

  const totalViews = Object.values(userMap).reduce((sum, d) => sum + d.views, 0);
  const lastRun = await db.collection('metadata').findOne({ key: 'lastStatsRun' });
  const lastRunAgo = lastRun ? timeAgo(lastRun.value) : null;

  // Fetch deductions list for display
  const deductions = await db.collection('deductions').find({ campaignValue }).toArray();

  let text = `💰 **${campaign.label} — Earnings Breakdown**\n`;
  text += isActive ? `🟢 Active — ends <t:${endTs}:R>\n` : `🔴 Campaign ended\n`;
  text += `👁️ Total views: ${fmtViews(totalViews)}\n`;
  text += `📊 Budget: ${fmtUSD(campaign.budget)} | Spent: ${fmtUSD(totalRpm + totalDeducted)} | Remaining: ${fmtUSD(budgetRemaining)}\n`;
  if (deductions.length > 0) {
    text += `📋 Manual deductions: `;
    text += deductions.map(d => `${fmtUSD(d.amount)} (${d.reason})`).join(', ') + '\n';
  }
  text += `🎁 Bonuses (on top of budget): 🥇 ${fmtUSD(campaign.bonus1st)} · 🥈 ${fmtUSD(campaign.bonus2nd)}\n`;
  text += `🕐 ${lastRunAgo ? `Updated ${lastRunAgo}` : 'Not updated yet'} · Updates every 12h\n\n`;

  if (sorted.length === 0) { text += '*No approved submissions yet.*'; return text; }

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < sorted.length; i++) {
    const [userId, data] = sorted[i];
    const medal = medals[i] || `${i + 1}.`;
    const rpm = data.earnings;
    const links = buildPostLinks(data.posts);
    let line = `${medal} <@${userId}> — ${fmtViews(data.views)} views | ${fmtUSD(rpm)}`;
    if (i === 0) line += ` + ${fmtUSD(campaign.bonus1st)} bonus = **${fmtUSD(rpm + campaign.bonus1st)}**`;
    else if (i === 1) line += ` + ${fmtUSD(campaign.bonus2nd)} bonus = **${fmtUSD(rpm + campaign.bonus2nd)}**`;
    line += ` · ${links}`;
    text += line + '\n';
  }

  return text;
}

// ===== BUILD: STATS (paginated) =====
async function buildStatsPages(campaignValue, filterUserId = null) {
  const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
  if (!campaign) return ['❌ Campaign not found.'];

  const query = { campaignValue, status: 'Approved ✅' };
  if (filterUserId) query.userId = filterUserId;

  const approved = await db.collection('submissions').find(query).toArray();

  approved.sort((a, b) => {
    const aDate = a.postedAt || a.submittedAt;
    const bDate = b.postedAt || b.submittedAt;
    return new Date(aDate) - new Date(bDate);
  });

  const isActive = new Date() < campaign.endDate;
  const lastRun = await db.collection('metadata').findOne({ key: 'lastStatsRun' });
  const lastRunAgo = lastRun ? timeAgo(lastRun.value) : null;

  const header = (filterUserId
    ? `📊 **${campaign.label} — <@${filterUserId}> Posts**\n`
    : `📊 **${campaign.label} — All Posts**\n`) +
    (isActive ? `🟢 Active\n` : `🔴 Campaign ended\n`) +
    `🕐 ${lastRunAgo ? `Updated ${lastRunAgo}` : 'Not updated yet'}\n\n`;

  if (approved.length === 0) return [header + '*No approved submissions yet.*'];

  const blocks = approved.map(sub => {
    const postDate = sub.postedAt ? dateStr(sub.postedAt) : sub.submittedAt ? dateStr(sub.submittedAt) : 'Unknown';
    const url = normalizeUrl(sub.link);
    return `📅 Posted ${postDate} · <@${sub.userId}>\n👁️ ${fmtViews(sub.views || 0)} views · ❤️ ${fmtViews(sub.likes || 0)} likes · [🔗 Link](<${url}>)\n`;
  });

  const pages = [];
  let current = header;
  for (const block of blocks) {
    if ((current + block + '\n').length > 1800) {
      pages.push(current);
      current = block + '\n';
    } else {
      current += block + '\n';
    }
  }
  if (current.trim()) pages.push(current);

  return pages.map((p, i) => pages.length > 1 ? p + `\nPage ${i + 1}/${pages.length}` : p);
}

function statsNavButtons(currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('stats_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
    new ButtonBuilder().setCustomId('stats_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
  );
}

// ===== BUILD: CAMPAIGN STATUS =====
function buildCampaignStatusText() {
  const now = new Date();
  let text = '📈 **Campaign Status**\n\n';
  for (const c of CAMPAIGNS) {
    const active = now < c.endDate;
    const endTs = Math.floor(c.endDate.getTime() / 1000);
    text += `**${c.label}**\n`;
    text += `${active ? '🟢 Active' : '🔴 Ended'} — ${active ? `ends <t:${endTs}:R>` : `ended <t:${endTs}:R>`}\n`;
    text += `💰 Budget: ${fmtUSD(c.budget)} | Payout: ${fmtUSD(c.rpm)}/1k views\n`;
    text += `📈 Min. views: ${c.minViews.toLocaleString()} | Max per edit: ${fmtUSD(c.maxPayout)}\n`;
    text += `🎁 Bonuses: 🥇 ${fmtUSD(c.bonus1st)} · 🥈 ${fmtUSD(c.bonus2nd)}\n\n`;
  }
  return text;
}

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {

  // ── /mysubmissions ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'mysubmissions') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const embed = await buildMySubmissionsEmbed(interaction.user.id);
      if (!embed) return interaction.editReply({ content: '📭 You have no submissions yet.' });
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('mysubmissions error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /leaderboard ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
    await interaction.deferReply({ ephemeral: false });
    try {
      return interaction.editReply({ content: await buildLeaderboardText(interaction.options.getString('campaign')) });
    } catch (err) {
      console.error('leaderboard error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /earnings ─────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'earnings') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      return interaction.editReply({ content: await buildEarningsText(interaction.options.getString('campaign')) });
    } catch (err) {
      console.error('earnings error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /stats ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const campaignValue = interaction.options.getString('campaign');
      const user = interaction.options.getUser('user');
      const pages = await buildStatsPages(campaignValue, user?.id || null);
      statsPageCache[interaction.user.id] = { pages, currentPage: 0 };
      const components = pages.length > 1 ? [statsNavButtons(0, pages.length)] : [];
      return interaction.editReply({ content: pages[0], components });
    } catch (err) {
      console.error('stats error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /campaignoffer ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'campaignoffer') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    try {
      const campaignValue = interaction.options.getString('campaign');
      const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
      if (!campaign || !campaign.offerChannelId)
        return interaction.reply({ content: '❌ This campaign has no offer channel configured.', ephemeral: true });

      const offerChannel = await client.channels.fetch(campaign.offerChannelId);

      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`🎬 ${campaign.label}`)
        .addFields(
          { name: '📋 Campaign Info', value:
            `💰 RPM: ${fmtUSD(campaign.rpm)} per 1,000 views\n` +
            `🏆 Max payout per edit: ${fmtUSD(campaign.maxPayout)}\n` +
            `💵 Total budget: ${fmtUSD(campaign.budget + campaign.bonus1st + campaign.bonus2nd)}\n` +
            `🎁 Bonuses: 🥇 ${fmtUSD(campaign.bonus1st)} · 🥈 ${fmtUSD(campaign.bonus2nd)}\n` +
            `📈 Min. views to earn: ${campaign.minViews.toLocaleString()}\n` +
            `📅 End date: May 31st (11:59 PM ET)`
          },
          { name: '📝 Brief', value: campaign.brief || 'No brief provided.' },
          { name: '\u200b', value: '👇 **JOIN BELOW TO START EARNING NOW!**' },
        );

      await offerChannel.send({
        content: '@everyone',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`join_campaign_${campaignValue}`)
            .setLabel('🎯 Join Campaign')
            .setStyle(ButtonStyle.Success)
        )],
      });

      return interaction.reply({ content: `✅ Offer posted in <#${campaign.offerChannelId}>`, ephemeral: true });
    } catch (err) {
      console.error('campaignoffer error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }

  // ── /addsubmission ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'addsubmission') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const user = interaction.options.getUser('user');
      const campaignValue = interaction.options.getString('campaign');
      const link = normalizeUrl(interaction.options.getString('link').trim());
      const clipName = interaction.options.getString('name') || 'Untitled';
      const campaign = CAMPAIGNS.find(c => c.value === campaignValue);

      if (!link.includes('tiktok.com'))
        return interaction.editReply({ content: '❌ Please provide a valid TikTok link.' });

      const counterDoc = await db.collection('counters').findOneAndUpdate(
        { campaignValue },
        { $inc: { count: 1 } },
        { upsert: true, returnDocument: 'after' }
      );

      await db.collection('submissions').insertOne({
        userId: user.id,
        username: user.username,
        campaignValue,
        campaignLabel: campaign.label,
        clipName,
        link,
        status: 'Approved ✅',
        campaignNumber: counterDoc.count,
        views: 0,
        likes: 0,
        earnings: 0,
        lastUpdated: null,
        submittedAt: new Date(),
      });

      return interaction.editReply({
        content: `✅ Added **${clipName}** for <@${user.id}> to **${campaign.label}** — Post #${counterDoc.count}\nRun \`/updatestats\` to fetch views and correct post date.`,
      });
    } catch (err) {
      console.error('addsubmission error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /removesubmission ─────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'removesubmission') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const link = interaction.options.getString('link').trim();
      const sub = await db.collection('submissions').findOne({ link });
      if (!sub) return interaction.editReply({ content: '❌ No submission found with that link.' });
      await db.collection('submissions').deleteOne({ link });
      return interaction.editReply({ content: `✅ Removed submission by <@${sub.userId}> from **${sub.campaignLabel}**\n🔗 ${link}` });
    } catch (err) {
      console.error('removesubmission error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /deductbudget ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'deductbudget') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const campaignValue = interaction.options.getString('campaign');
      const amount = interaction.options.getNumber('amount');
      const reason = interaction.options.getString('reason');
      const campaign = CAMPAIGNS.find(c => c.value === campaignValue);

      await db.collection('deductions').insertOne({
        campaignValue,
        amount,
        reason,
        createdBy: interaction.user.id,
        createdAt: new Date(),
      });

      return interaction.editReply({
        content: `✅ Deducted **${fmtUSD(amount)}** from **${campaign.label}**\n📝 Reason: ${reason}\n\nThis will now be reflected in \`/earnings\` and \`/leaderboard\`.`,
      });
    } catch (err) {
      console.error('deductbudget error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /panel ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    try {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎟️ Support Center')
        .setDescription('Use the button below to open a ticket.\n\n• Submissions\n• Payments\n• Issues');
      await interaction.channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_ticket').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Primary)
        )],
      });
      await interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    } catch (err) {
      console.error('panel error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }

  // ── /submitpanel ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'submitpanel') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    try {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎬 Manage Your Submissions')
        .setDescription('Use the buttons below to manage your edits.\n\u200b')
        .addFields(
          { name: '📤 Submit Edit', value: 'Submit a TikTok edit to a campaign.', inline: true },
          { name: '📊 My Submissions', value: 'View your edits, views and earnings.', inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
          { name: '🏆 Leaderboard', value: 'See who has the most views per campaign.', inline: true },
          { name: '📈 Campaign Status', value: 'View active campaigns, budgets and deadlines.', inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
        );
      await interaction.channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('submit_clip').setLabel('📤 Submit Edit').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('view_submissions').setLabel('📊 My Submissions').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('leaderboard_button').setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('campaign_status').setLabel('📈 Campaign Status').setStyle(ButtonStyle.Secondary)
        )],
      });
      await interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    } catch (err) {
      console.error('submitpanel error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }

  // ── /onboardingpanel ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'onboardingpanel') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    try {
      const channel = await client.channels.fetch(ONBOARDING_CHANNEL_ID);
      await channel.send({
        content: `👋 Welcome! Please complete the onboarding below to get access to the server.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('start_onboarding')
            .setLabel('🚀 Start Onboarding')
            .setStyle(ButtonStyle.Primary)
        )],
      });
      return interaction.reply({ content: '✅ Onboarding panel posted.', ephemeral: true });
    } catch (err) {
      console.error('onboardingpanel error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }

  // ── /updatestats ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'updatestats') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    await updateAllStats(true);
    return interaction.editReply({ content: '✅ Stats updated.' });
  }

  // ── /dashboard ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const subs = await db.collection('submissions').find({}).toArray();
      const editors = await db.collection('editors').find({}).toArray();
      const referrals = await db.collection('referrals').find({}).toArray();
      const deductions = await db.collection('deductions').find({}).toArray();

      const approved = subs.filter(s => s.status === 'Approved ✅');
      const totalViews = approved.reduce((a, s) => a + (s.views || 0), 0);
      const totalLikes = approved.reduce((a, s) => a + (s.likes || 0), 0);
      const totalEarnings = approved.reduce((a, s) => a + (s.earnings || 0), 0);
      const totalDeducted = deductions.reduce((a, d) => a + (d.amount || 0), 0);

      const now = new Date();
      const activeCampaigns = CAMPAIGNS.filter(c => c.endDate >= now);

      // top editors by approved views
      const byEditor = {};
      for (const s of approved) {
        if (!byEditor[s.userId]) byEditor[s.userId] = { username: s.username, views: 0, posts: 0 };
        byEditor[s.userId].views += (s.views || 0);
        byEditor[s.userId].posts += 1;
      }
      const topEditors = Object.entries(byEditor)
        .sort((a, b) => b[1].views - a[1].views)
        .slice(0, 5)
        .map(([id, e], i) => `${i + 1}. <@${id}> — ${e.views.toLocaleString()} views (${e.posts} posts)`)
        .join('\n') || 'No approved posts yet.';

      // per-campaign breakdown
      const campaignLines = CAMPAIGNS.map(c => {
        const cSubs = approved.filter(s => s.campaignValue === c.value);
        const cViews = cSubs.reduce((a, s) => a + (s.views || 0), 0);
        const status = c.endDate >= now ? '🟢' : '🔴';
        return `${status} **${c.label}** — ${cSubs.length} posts · ${cViews.toLocaleString()} views`;
      }).join('\n');

      const demoCount = editors.filter(e => e.demographicsImages).length;
      const dataCount = editors.filter(e => e.demographicsData).length;
      const paypalCount = editors.filter(e => e.paypalEmail).length;
      const referralsPaid = referrals.filter(r => r.firstPostBonusPaid).length;
      const referrals500k = referrals.filter(r => r.bonus500kPaid).length;

      // audience aggregates from entered data
      const withData = editors.filter(e => e.demographicsData);
      const avgUs = withData.length
        ? (withData.reduce((a, e) => a + (e.demographicsData.usPercent || 0), 0) / withData.length).toFixed(1)
        : '—';
      const majorityUs = withData.filter(e => (e.demographicsData.usPercent || 0) >= 50).length;
      const topCountryTally = {};
      withData.forEach(e => {
        const c = e.demographicsData.topCountry;
        if (c) topCountryTally[c] = (topCountryTally[c] || 0) + 1;
      });
      const commonCountry = Object.entries(topCountryTally).sort((a, b) => b[1] - a[1])[0];
      const audienceLine = withData.length
        ? `Editors with data: **${dataCount}**\nAvg US audience: **${avgUs}%**\nMajority-US editors: **${majorityUs}**\nMost common top country: **${commonCountry ? commonCountry[0] : '—'}**`
        : `No demographic numbers entered yet.`;

      const embed = new EmbedBuilder()
        .setColor(0x1a3fb0)
        .setTitle('📊 Editable Group — Dashboard')
        .addFields(
          { name: '👥 Editors', value:
            `Onboarded: **${editors.length}**\nPayPal on file: **${paypalCount}**\nDemographics submitted: **${demoCount}**`, inline: true },
          { name: '📈 Performance', value:
            `Approved posts: **${approved.length}**\nTotal views: **${totalViews.toLocaleString()}**\nTotal likes: **${totalLikes.toLocaleString()}**`, inline: true },
          { name: '💰 Money', value:
            `Earnings accrued: **$${totalEarnings.toFixed(2)}**\nDeductions: **$${totalDeducted.toFixed(2)}**`, inline: true },
          { name: '🎯 Campaigns', value: campaignLines || 'None', inline: false },
          { name: '🏆 Top Editors (by views)', value: topEditors, inline: false },
          { name: '🔗 Referrals', value:
            `Total tracked: **${referrals.length}**\n$5 bonuses paid: **${referralsPaid}**\n$50 bonuses paid: **${referrals500k}**`, inline: true },
          { name: '🟢 Active Campaigns', value: `**${activeCampaigns.length}** running now`, inline: true },
          { name: '🌍 Audience (from entered data)', value: audienceLine, inline: false },
        )
        .setFooter({ text: `Generated ${dateStr(now)}` });

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('dashboard error:', err);
      return interaction.editReply({ content: '❌ Failed to build dashboard.' });
    }
  }

  // ── /editor ───────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'editor') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const target = interaction.options.getUser('user');
      const profile = await db.collection('editors').findOne({ userId: target.id });
      const subs = await db.collection('submissions').find({ userId: target.id }).toArray();
      const approved = subs.filter(s => s.status === 'Approved ✅');
      const totalViews = approved.reduce((a, s) => a + (s.views || 0), 0);
      const totalEarnings = approved.reduce((a, s) => a + (s.earnings || 0), 0);
      const referralsMade = await db.collection('referrals').countDocuments({ inviterId: target.id });
      const wasReferredBy = await db.collection('referrals').findOne({ inviteeId: target.id });

      const embed = new EmbedBuilder()
        .setColor(0x1a3fb0)
        .setTitle(`👤 ${target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🎵 TikTok', value: profile?.tiktok || 'Not on file', inline: false },
          { name: '💳 Payment', value: profile?.paypalEmail
              ? `PayPal — ${profile.paypalEmail}`
              : (profile?.paymentMethod === 'bank' ? 'Bank Transfer' : 'Not on file'), inline: true },
          { name: '📅 Joined', value: profile?.joinedAt ? dateStr(profile.joinedAt) : 'Unknown', inline: true },
          { name: '📊 Submissions', value:
            `Total: **${subs.length}**\nApproved: **${approved.length}**`, inline: true },
          { name: '📈 Views (approved)', value: `**${totalViews.toLocaleString()}**`, inline: true },
          { name: '💰 Earnings', value: `**$${totalEarnings.toFixed(2)}**`, inline: true },
          { name: '🔗 Referrals made', value: `**${referralsMade}**`, inline: true },
          { name: '🙋 Referred by', value: wasReferredBy ? `<@${wasReferredBy.inviterId}>` : 'Nobody', inline: true },
          { name: '📷 Demographics', value: profile?.demographicsImages ? '✅ Screenshots on file' : '❌ Not submitted', inline: true },
          { name: '🌍 Audience data', value: profile?.demographicsData
              ? `Top country: **${profile.demographicsData.topCountry}**\nUS: **${profile.demographicsData.usPercent}%** · Top age: **${profile.demographicsData.topAge}** · Male: **${profile.demographicsData.malePercent}%**`
              : 'Not entered yet', inline: false },
        );
      if (profile?.demographicsImages?.locations) embed.setImage(profile.demographicsImages.locations);

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('editor lookup error:', err);
      return interaction.editReply({ content: '❌ Failed to look up editor.' });
    }
  }

  // ── /demographicspanel ─────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'demographicspanel') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    try {
      const channel = await client.channels.fetch(DEMOGRAPHICS_CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setColor(0x1a3fb0)
        .setTitle('📷 Submit Your Audience Demographics')
        .setDescription(
          'Help us land bigger campaigns by sharing your TikTok audience demographics.\n\n' +
          '**How to find it:** TikTok app → Profile → ☰ menu → **Creator Tools** → **Analytics** → **Viewers** tab. Screenshot the age, gender and location breakdown.\n\n' +
          'Click the button below, then upload your screenshot when prompted. This is only visible to the Editable Group team.'
        );
      await channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('submit_demographics')
            .setLabel('📷 Submit Demographics')
            .setStyle(ButtonStyle.Primary)
        )],
      });
      return interaction.reply({ content: '✅ Demographics panel posted.', ephemeral: true });
    } catch (err) {
      console.error('demographicspanel error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }

  // ── /close ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
    try {
      if (!interaction.channel.name.startsWith('ticket-'))
        return interaction.reply({ content: '❌ This can only be used inside a ticket.', ephemeral: true });
      await interaction.reply({ content: '🔒 Closing in 3 seconds...' });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    } catch (err) {
      console.error('close error:', err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Failed to close ticket.', ephemeral: true }).catch(() => {});
    }
  }

  // ── BUTTONS ───────────────────────────────────────────────────────────────
  if (interaction.isButton()) {

    if (interaction.customId === 'stats_prev' || interaction.customId === 'stats_next') {
      await interaction.deferUpdate();
      try {
        const cache = statsPageCache[interaction.user.id];
        if (!cache) return;
        if (interaction.customId === 'stats_prev') cache.currentPage--;
        else cache.currentPage++;
        const { pages, currentPage } = cache;
        const components = pages.length > 1 ? [statsNavButtons(currentPage, pages.length)] : [];
        await interaction.editReply({ content: pages[currentPage], components });
      } catch (err) {
        console.error('stats pagination error:', err);
      }
    }

    if (interaction.customId === 'start_onboarding') {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(EDITOR_ROLE_ID))
          return interaction.reply({ content: '✅ You\'ve already completed onboarding!', ephemeral: true });

        if (!onboardingState[interaction.user.id]) onboardingState[interaction.user.id] = {};

        const modal = new ModalBuilder()
          .setCustomId('onboarding_tiktok')
          .setTitle('Step 1/2 — TikTok Profile');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('tiktok_url')
            .setLabel('Your TikTok profile link')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://www.tiktok.com/@yourprofile')
            .setRequired(true)
        ));
        await interaction.showModal(modal);
      } catch (err) {
        console.error('start_onboarding error:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.customId === 'onboarding_paypal') {
      try {
        const modal = new ModalBuilder()
          .setCustomId('onboarding_paypal_email')
          .setTitle('Step 2/2 — PayPal Email');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('paypal_email')
            .setLabel('Your PayPal email address')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('your@email.com')
            .setRequired(true)
        ));
        await interaction.showModal(modal);
      } catch (err) {
        console.error('onboarding_paypal error:', err);
      }
    }

    if (interaction.customId === 'onboarding_bank') {
      try {
        if (!onboardingState[interaction.user.id]) onboardingState[interaction.user.id] = {};
        onboardingState[interaction.user.id].payment = 'bank';
        const state = onboardingState[interaction.user.id];
        await completeOnboarding(interaction, state);
      } catch (err) {
        console.error('onboarding_bank error:', err);
      }
    }

    if (interaction.customId.startsWith('join_campaign_')) {
      try {
        const campaignValue = interaction.customId.replace('join_campaign_', '');
        const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
        if (!campaign || !campaign.roleId)
          return interaction.reply({ content: '❌ Campaign not found.', ephemeral: true });

        const member = await interaction.guild.members.fetch(interaction.user.id);

        if (member.roles.cache.has(campaign.roleId)) {
          return interaction.reply({
            content: `✅ You're already in this campaign! Head over to <#${campaign.announcementChannelId}> to get started.`,
            ephemeral: true,
          });
        }

        await member.roles.add(campaign.roleId);

        await interaction.reply({
          content:
            `✅ You've successfully joined **${campaign.label}**!\n\n` +
            `Before you start posting, make sure to check out **#rules** and **#audios** in the campaign channel. Good luck! 🎬`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('🎬 Start Earning')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${GUILD_ID}/${campaign.announcementChannelId}`)
          )],
          ephemeral: true,
        });
      } catch (err) {
        console.error('join_campaign error:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.customId === 'submit_demographics') {
      try {
        await interaction.user.send(
          '📷 **Demographics submission**\n\n' +
          'I\'ll collect three screenshots, one at a time. Let\'s start.\n\n' +
          '**Step 1 of 3 — Gender**\nPlease send your **Gender** screenshot now.\n\n' +
          '_(TikTok app → Profile → ☰ → Creator Tools → Analytics → Viewers tab → Gender)_'
        );
        demographicsPending[interaction.user.id] = { step: 'gender' };
        setTimeout(() => { delete demographicsPending[interaction.user.id]; }, 15 * 60 * 1000);
        return interaction.reply({
          content: '📬 Check your DMs — I\'ll walk you through sending your three screenshots privately.',
          ephemeral: true,
        });
      } catch (err) {
        return interaction.reply({
          content: '❌ I couldn\'t DM you. Please enable **Direct Messages** from server members (Server → Privacy Settings) and try again.',
          ephemeral: true,
        });
      }
    }

    if (interaction.customId.startsWith('enter_demographics_')) {
      if (interaction.user.id !== OWNER_ID)
        return interaction.reply({ content: '❌ Only Cilord can enter demographics data.', ephemeral: true });
      const editorId = interaction.customId.replace('enter_demographics_', '');
      demographicsEntry[OWNER_ID] = { editorId };
      setTimeout(() => { if (demographicsEntry[OWNER_ID]?.editorId === editorId) delete demographicsEntry[OWNER_ID]; }, 15 * 60 * 1000);
      return interaction.reply({
        content:
          `✍️ Reading the screenshots above, reply in this DM with the numbers for <@${editorId}> in this format:\n` +
          '`TopCountry | US% | TopAgeBracket | Male%`\n' +
          'Example: `United States | 26.5 | 18-24 | 75`\n\n' +
          'Type `cancel` to stop.',
        ephemeral: false,
      });
    }

    if (interaction.customId === 'open_ticket') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const existing = interaction.guild.channels.cache.find(c => c.name === `ticket-${interaction.user.username}`);
        if (existing) return interaction.editReply({ content: `❌ You already have a ticket: <#${existing.id}>` });
        const ownerMember = await interaction.guild.members.fetch(OWNER_ID).catch(() => null);
        const rocaMember = await interaction.guild.members.fetch(ROCA_ID).catch(() => null);
        const permissionOverwrites = [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        if (ownerMember) permissionOverwrites.push({ id: ownerMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        if (rocaMember) permissionOverwrites.push({ id: rocaMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        const channel = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites,
        });
        await channel.send(`🎟️ Ticket opened by <@${interaction.user.id}>!\n<@${OWNER_ID}> <@${ROCA_ID}> — please assist.\n\nType \`/close\` to close this ticket.`);
        return interaction.editReply({ content: `✅ Ticket created: <#${channel.id}>` });
      } catch (err) {
        console.error('open_ticket error:', err);
        return interaction.editReply({ content: '❌ Failed to create ticket. Check the bot has **Manage Channels** permission.' });
      }
    }

    if (interaction.customId === 'submit_clip') {      try {
        const active = CAMPAIGNS.filter(c => new Date() < c.endDate);
        if (active.length === 0)
          return interaction.reply({ content: '❌ There are no active campaigns right now.', ephemeral: true });
        const select = new StringSelectMenuBuilder()
          .setCustomId('campaign_select')
          .setPlaceholder('Select a campaign')
          .addOptions(active.map(c => new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.value)));
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('🎯 Select a Campaign').setDescription('Choose the campaign you want to submit your edit to.')],
          components: [new ActionRowBuilder().addComponents(select)],
          ephemeral: true,
        });
      } catch (err) {
        console.error('submit_clip error:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.customId === 'view_submissions') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const embed = await buildMySubmissionsEmbed(interaction.user.id);
        if (!embed) return interaction.editReply({ content: '📭 You have no submissions yet.' });
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('view_submissions error:', err);
        return interaction.editReply({ content: '❌ Something went wrong.' });
      }
    }

    if (interaction.customId === 'leaderboard_button') {
      try {
        const select = new StringSelectMenuBuilder()
          .setCustomId('leaderboard_campaign_select')
          .setPlaceholder('Select a campaign')
          .addOptions(CAMPAIGNS.map(c => new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.value)));
        await interaction.reply({
          content: '🏆 Which campaign leaderboard would you like to see?',
          components: [new ActionRowBuilder().addComponents(select)],
          ephemeral: true,
        });
      } catch (err) {
        console.error('leaderboard_button error:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.customId === 'campaign_status') {
      await interaction.deferReply({ ephemeral: true });
      try {
        return interaction.editReply({ content: buildCampaignStatusText() });
      } catch (err) {
        console.error('campaign_status error:', err);
        return interaction.editReply({ content: '❌ Something went wrong.' });
      }
    }

    if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('reject_')) {
      await interaction.deferUpdate();
      try {
        const isApproved = interaction.customId.startsWith('approve_');
        const subId = interaction.customId.replace(/^(approve|reject)_/, '');
        const sub = await db.collection('submissions').findOne({ _id: new ObjectId(subId) });
        if (!sub) return;
        const newStatus = isApproved ? 'Approved ✅' : 'Rejected ❌';
        await db.collection('submissions').updateOne({ _id: sub._id }, { $set: { status: newStatus } });
        await interaction.message.edit({
          content:
            `📩 ${sub.campaignLabel} — Post #${sub.campaignNumber}\n` +
            `👤 <@${sub.userId}>\n🎬 ${sub.clipName}\n🔗 <${normalizeUrl(sub.link)}>\n📊 Status: ${newStatus}`,
          components: [],
        });

        // --- Referral: $5 first-post bonus (fires once ever, on the invitee's first approval) ---
        if (isApproved) {
          try {
            const priorApproved = await db.collection('submissions').countDocuments({
              userId: sub.userId,
              status: 'Approved ✅',
              _id: { $ne: sub._id },
            });
            if (priorApproved === 0) {
              const referral = await db.collection('referrals').findOne({
                inviteeId: sub.userId,
                firstPostBonusPaid: false,
              });
              if (referral) {
                await db.collection('referrals').updateOne(
                  { _id: referral._id },
                  { $set: { firstPostBonusPaid: true, firstPostBonusAt: new Date() } }
                );
                const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
                await logChannel.send(
                  `🔗 **Referral bonus:** <@${referral.inviterId}> referred <@${sub.userId}>, who just posted their first approved edit on **${sub.campaignLabel}**.\n` +
                  `💵 <@${referral.inviterId}> earns **$${REFERRAL_FIRST_POST_BONUS}**.`
                );
              }
            }
          } catch (err) {
            console.error('[Referrals] First-post bonus error:', err.message);
          }
        }
        try {
          const user = await client.users.fetch(sub.userId);
          const embed = new EmbedBuilder()
            .setColor(isApproved ? 0x57f287 : 0xed4245)
            .setTitle(isApproved ? '✅ Submission Approved!' : '❌ Submission Rejected')
            .setDescription(isApproved
              ? 'Your submission has been **approved**! Views and earnings update every 12 hours. Use the **My Submissions** button to track your progress and ranking.'
              : 'Your submission has been **rejected**. Feel free to open a ticket if you have questions.')
            .addFields(
              { name: '🎯 Campaign', value: sub.campaignLabel, inline: true },
              { name: '🎬 Edit', value: sub.clipName, inline: true },
              { name: '🔗 Link', value: normalizeUrl(sub.link), inline: false }
            )
            .setTimestamp();
          await user.send({ embeds: [embed] });
        } catch { /* DMs disabled */ }
      } catch (err) {
        console.error('approve/reject error:', err);
      }
    }
  }

  // ── SELECT MENUS ──────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {

    if (interaction.customId === 'campaign_select') {
      try {
        const selected = CAMPAIGNS.find(c => c.value === interaction.values[0]);
        pendingCampaign[interaction.user.id] = { value: selected.value, label: selected.label };
        const modal = new ModalBuilder().setCustomId('submit_modal').setTitle('Submit an Edit');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('clip_name').setLabel('Edit Name').setStyle(TextInputStyle.Short).setPlaceholder('e.g. My Awesome Edit').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('clip_link').setLabel('TikTok Link').setStyle(TextInputStyle.Short).setPlaceholder('https://www.tiktok.com/@user/video/...').setRequired(true)
          )
        );
        await interaction.showModal(modal);
      } catch (err) {
        console.error('campaign_select error:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.customId === 'leaderboard_campaign_select') {
      await interaction.deferUpdate();
      try {
        const text = await buildLeaderboardText(interaction.values[0]);
        await interaction.editReply({ content: text, components: [] });
      } catch (err) {
        console.error('leaderboard_campaign_select error:', err);
        await interaction.editReply({ content: '❌ Something went wrong.', components: [] });
      }
    }
  }

  // ── MODALS ────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {

    if (interaction.customId === 'onboarding_tiktok') {
      try {
        const tiktok = interaction.fields.getTextInputValue('tiktok_url').trim();
        if (!tiktok.includes('tiktok.com'))
          return interaction.reply({ content: '❌ Please enter a valid TikTok profile URL (must include tiktok.com).', ephemeral: true });

        if (!onboardingState[interaction.user.id]) onboardingState[interaction.user.id] = {};
        onboardingState[interaction.user.id].tiktok = tiktok;

        await interaction.reply({
          content:
            `✅ **Step 1/2 done!**\n\n` +
            `💳 **Step 2/2 — Payment method**\nHow would you like to receive your payments?`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('onboarding_paypal').setLabel('💸 PayPal').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('onboarding_bank').setLabel('🏦 Bank Transfer').setStyle(ButtonStyle.Secondary),
          )],
          ephemeral: true,
        });
      } catch (err) {
        console.error('onboarding_tiktok error:', err);
      }
    }

    if (interaction.customId === 'onboarding_paypal_email') {
      try {
        const email = interaction.fields.getTextInputValue('paypal_email').trim();
        if (!onboardingState[interaction.user.id]) onboardingState[interaction.user.id] = {};
        onboardingState[interaction.user.id].payment = 'paypal';
        onboardingState[interaction.user.id].paypalEmail = email;
        const state = onboardingState[interaction.user.id];
        await completeOnboarding(interaction, state);
      } catch (err) {
        console.error('onboarding_paypal_email error:', err);
      }
    }

    if (interaction.customId === 'submit_modal') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const clipName = interaction.fields.getTextInputValue('clip_name') || 'Untitled';
        const clipLink = normalizeUrl(interaction.fields.getTextInputValue('clip_link').trim());
        const campaignInfo = pendingCampaign[interaction.user.id];
        delete pendingCampaign[interaction.user.id];

        if (!campaignInfo)
          return interaction.editReply({ content: '❌ Session expired — please try submitting again.' });
        if (!clipLink.includes('tiktok.com'))
          return interaction.editReply({ content: '❌ Please provide a valid TikTok link.' });

        const counterDoc = await db.collection('counters').findOneAndUpdate(
          { campaignValue: campaignInfo.value },
          { $inc: { count: 1 } },
          { upsert: true, returnDocument: 'after' }
        );

        const result = await db.collection('submissions').insertOne({
          userId: interaction.user.id,
          username: interaction.user.username,
          campaignValue: campaignInfo.value,
          campaignLabel: campaignInfo.label,
          clipName,
          link: clipLink,
          status: 'Pending',
          campaignNumber: counterDoc.count,
          views: 0,
          likes: 0,
          earnings: 0,
          lastUpdated: null,
          submittedAt: new Date(),
        });

        const subId = result.insertedId.toString();
        const submissionsChannel = await client.channels.fetch(SUBMISSIONS_CHANNEL_ID);
        await submissionsChannel.send({
          content:
            `📩 ${campaignInfo.label} — Post #${counterDoc.count}\n` +
            `👤 <@${interaction.user.id}>\n🎬 ${clipName}\n🔗 <${clipLink}>\n📊 Status: Pending`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${subId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${subId}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
          )],
        });

        return interaction.editReply({ content: '✅ Edit submitted! You\'ll receive a DM once it\'s been reviewed.' });
      } catch (err) {
        console.error('submit_modal error:', err);
        return interaction.editReply({ content: '❌ Something went wrong. Please try again.' });
      }
    }
  }
});

// ===== BOOT =====
(async () => {
  await connectDB();
  client.login(TOKEN);
})();
