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
const { google } = require('googleapis');

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1498623710301650994';
const GUILD_ID = '1437187584689438865';
const SUBMISSIONS_CHANNEL_ID = '1498679979666444378';
const OWNER_ID = '960171711674847282';
const ROCA_ID = '996919845373366362';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'tiktok-api23.p.rapidapi.com';
const OFFICIAL_EMAIL = 'official@editablegroup.co.uk';

function isOwner(userId) {
  return userId === OWNER_ID || userId === ROCA_ID;
}

// ===== CAMPAIGNS =====
// sheetId = the ID from the Google Sheet URL for that campaign's existing sheet
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
    sheetId: '15fKPdzV82K2FuDtBl8dC6Q8THi4fC4h0K8cMCizBJTA',
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
    sheetId: '1PZt1hPoZPnoJIbsV_GaAaBqmetQT1ctfmo8ANzFt2F4',
  },
  // { label: 'Campaign Name', value: 'campaign_value', rpm: 1.00, maxPayout: 350, minViews: 1500, budget: 1000, bonus1st: 150, bonus2nd: 75, endDate: new Date('2026-06-01T23:59:59Z'), sheetId: 'SHEET_ID_HERE' },
];

// ===== MONGODB =====
let db;
async function connectDB() {
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db('editablegroup');
  console.log('Connected to MongoDB');
}

// ===== GOOGLE SHEETS =====
function getGoogleAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

// Updates views, likes and last updated in the existing campaign sheet.
// Matches by TikTok link in column C. If not found, appends a new row with just the link.
// Only touches columns C (link if new), D (views), E (likes), F (last updated).
async function updateSheetRow(submission) {
  try {
    const campaign = CAMPAIGNS.find(c => c.value === submission.campaignValue);
    if (!campaign || !campaign.sheetId) return;

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Read column C to find the row with matching link
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: campaign.sheetId,
      range: 'C:C',
    });

    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) { // start at 1 to skip header
      if (rows[i][0] === submission.link) { rowIndex = i + 1; break; } // 1-indexed
    }

    const today = new Date().toLocaleDateString('en-GB');

    if (rowIndex > 0) {
      // Row exists — update D, E, F only
      await sheets.spreadsheets.values.update({
        spreadsheetId: campaign.sheetId,
        range: `D${rowIndex}:F${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[submission.views || 0, submission.likes || 0, today]] },
      });
    } else {
      // Row doesn't exist — append link in C and stats in D, E, F
      // Find first empty row in column C
      const lastRow = rows.length + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: campaign.sheetId,
        range: `C${lastRow}:F${lastRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[submission.link, submission.views || 0, submission.likes || 0, today]] },
      });
    }
  } catch (err) {
    console.error('Sheets update error:', err.message);
  }
}

// Removes a row from the sheet by TikTok link
async function removeSheetRow(campaignValue, link) {
  try {
    const campaign = CAMPAIGNS.find(c => c.value === campaignValue);
    if (!campaign || !campaign.sheetId) return;

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: campaign.sheetId });
    const gid = spreadsheet.data.sheets[0].properties.sheetId;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: campaign.sheetId,
      range: 'C:C',
    });

    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === link) { rowIndex = i; break; } // 0-indexed for API
    }

    if (rowIndex < 0) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: campaign.sheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
          },
        }],
      },
    });
  } catch (err) {
    console.error('Sheets remove row error:', err.message);
  }
}

// ===== TIKTOK STATS =====
async function extractVideoId(url) {
  const direct = url.match(/video\/(\d+)/);
  if (direct) return direct[1];
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const finalUrl = res.url;
    const match = finalUrl.match(/video\/(\d+)/);
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
    return { views: parseInt(views), likes: parseInt(likes) };
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

async function updateAllStats() {
  console.log('[Stats] Starting update...');
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
      await db.collection('submissions').updateOne(
        { _id: sub._id },
        { $set: { views: stats.views, likes: stats.likes, earnings, lastUpdated: new Date() } }
      );
      await updateSheetRow({ ...sub, views: stats.views, likes: stats.likes });
      updated++;
    }
    console.log(`[Stats] Updated ${updated}/${approved.length} submissions`);
  } catch (err) {
    console.error('[Stats] Error:', err.message);
  }
}

// ===== HELPERS =====
function timeAgo(date) {
  if (!date) return 'never';
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
function fmtViews(n) { return (n || 0).toLocaleString('en-US'); }
function fmtUSD(n) { return `$${(n || 0).toFixed(2)}`; }

// ===== CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const pendingCampaign = {};

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
    .addStringOption(opt => opt.setName('link').setDescription('TikTok link of the submission to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send the support ticket panel — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('submitpanel')
    .setDescription('Send the submission panel — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a ticket'),

  new SlashCommandBuilder()
    .setName('updatestats')
    .setDescription('Manually trigger a TikTok stats update — owner only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  console.log('Registering commands...');
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Commands registered');
})();

// ===== READY =====
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(updateAllStats, 12 * 60 * 60 * 1000);
  setTimeout(updateAllStats, 15000);
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

        // Combine views per user for rank
        const userTotals = {};
        for (const s of allApproved) {
          if (!userTotals[s.userId]) userTotals[s.userId] = 0;
          userTotals[s.userId] += s.views || 0;
        }
        const sorted = Object.entries(userTotals).sort((a, b) => b[1] - a[1]);
        const rank = sorted.findIndex(([uid]) => uid === sub.userId) + 1;

        // Total earnings across all this user's posts in this campaign
        const totalEarnings = allApproved
          .filter(s => s.userId === sub.userId)
          .reduce((sum, s) => sum + (s.earnings || 0), 0);

        if (rank === 1) {
          description += `🥇 1st place — +${fmtUSD(campaign.bonus1st)} bonus | Total: ${fmtUSD(totalEarnings + campaign.bonus1st)}\n`;
        } else if (rank === 2) {
          description += `🥈 2nd place — +${fmtUSD(campaign.bonus2nd)} bonus | Total: ${fmtUSD(totalEarnings + campaign.bonus2nd)}\n`;
        }
      }

      description += `└ 🕐 Updated ${timeAgo(sub.lastUpdated)}\n\n`;
    } else if (sub.status === 'Rejected ❌') {
      description += `🔴 **${sub.clipName}** — Rejected\n\n`;
    } else {
      description += `⏳ **${sub.clipName}** — Pending review\n\n`;
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
  const budgetRemaining = Math.max(0, campaign.budget - totalRpmEarned);

  let text = `🏆 **${campaign.label} — Leaderboard**\n`;
  text += isActive ? `🟢 Active — ends <t:${endTs}:R>\n` : `🔴 Campaign ended\n`;
  text += `💰 Budget remaining: ${fmtUSD(budgetRemaining)} / ${fmtUSD(campaign.budget)}\n`;
  text += `🎁 Bonuses: 🥇 ${fmtUSD(campaign.bonus1st)} · 🥈 ${fmtUSD(campaign.bonus2nd)}\n\n`;

  if (approved.length === 0) { text += '*No approved submissions yet.*'; return text; }

  // Combine all posts per user into one total
  const userTotals = {};
  for (const sub of approved) {
    if (!userTotals[sub.userId]) userTotals[sub.userId] = 0;
    userTotals[sub.userId] += sub.views || 0;
  }
  const sorted = Object.entries(userTotals).sort((a, b) => b[1] - a[1]);

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < sorted.length; i++) {
    const [userId, totalViews] = sorted[i];
    const medal = medals[i] || `${i + 1}.`;
    let bonusNote = '';
    if (i === 0) bonusNote = ` *(+${fmtUSD(campaign.bonus1st)} bonus)*`;
    if (i === 1) bonusNote = ` *(+${fmtUSD(campaign.bonus2nd)} bonus)*`;
    text += `${medal} <@${userId}> — ${fmtViews(totalViews)} views${bonusNote}\n`;
  }
  text += `\n*Rankings update every 12 hours.*`;
  return text;
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

  // ── /addsubmission ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'addsubmission') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const user = interaction.options.getUser('user');
      const campaignValue = interaction.options.getString('campaign');
      const link = interaction.options.getString('link').trim();
      const clipName = interaction.options.getString('name') || 'Untitled';
      const campaign = CAMPAIGNS.find(c => c.value === campaignValue);

      if (!link.includes('tiktok.com'))
        return interaction.editReply({ content: '❌ Please provide a valid TikTok link.' });

      const counterDoc = await db.collection('counters').findOneAndUpdate(
        { campaignValue },
        { $inc: { count: 1 } },
        { upsert: true, returnDocument: 'after' }
      );
      const campaignNumber = counterDoc.count;

      await db.collection('submissions').insertOne({
        userId: user.id,
        username: user.username,
        campaignValue,
        campaignLabel: campaign.label,
        clipName,
        link,
        status: 'Approved ✅',
        campaignNumber,
        views: 0,
        likes: 0,
        earnings: 0,
        lastUpdated: null,
        submittedAt: new Date(),
      });

      await updateSheetRow({ campaignValue, link, views: 0, likes: 0 });

      return interaction.editReply({
        content: `✅ Added **${clipName}** for <@${user.id}> to **${campaign.label}** — Post #${campaignNumber}\nRun \`/updatestats\` to fetch views now.`,
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
      await removeSheetRow(sub.campaignValue, link);

      return interaction.editReply({
        content: `✅ Removed submission by <@${sub.userId}> from **${sub.campaignLabel}**\n🔗 ${link}`,
      });
    } catch (err) {
      console.error('removesubmission error:', err);
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

  // ── /updatestats ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'updatestats') {
    if (!isOwner(interaction.user.id))
      return interaction.reply({ content: '❌ Only Cilord and Roca can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    await updateAllStats();
    return interaction.editReply({ content: '✅ Stats updated.' });
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

    if (interaction.customId === 'submit_clip') {
      try {
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
            `👤 <@${sub.userId}>\n🎬 ${sub.clipName}\n🔗 <${sub.link}>\n📊 Status: ${newStatus}`,
          components: [],
        });

        if (isApproved) {
          await updateSheetRow({ campaignValue: sub.campaignValue, link: sub.link, views: 0, likes: 0 });
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
              { name: '🔗 Link', value: sub.link, inline: false }
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

  // ── MODAL SUBMIT ──────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'submit_modal') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const clipName = interaction.fields.getTextInputValue('clip_name') || 'Untitled';
      const clipLink = interaction.fields.getTextInputValue('clip_link').trim();
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
      const campaignNumber = counterDoc.count;

      const result = await db.collection('submissions').insertOne({
        userId: interaction.user.id,
        username: interaction.user.username,
        campaignValue: campaignInfo.value,
        campaignLabel: campaignInfo.label,
        clipName,
        link: clipLink,
        status: 'Pending',
        campaignNumber,
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
          `📩 ${campaignInfo.label} — Post #${campaignNumber}\n` +
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
});

// ===== BOOT =====
(async () => {
  await connectDB();
  client.login(TOKEN);
})();
