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
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1498623710301650994';
const GUILD_ID = '1437187584689438865';
const SUBMISSIONS_CHANNEL_ID = '1498679979666444378';

const OWNER_ID = '960171711674847282';
const ROCA_ID = '996919845373366362';

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let submissions = {};
let counter = 1;

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('submit')
    .setDescription('Submit a post')
    .addStringOption(opt =>
      opt.setName('campaign').setDescription('Campaign').setRequired(true))
    .addStringOption(opt =>
      opt.setName('link').setDescription('TikTok link').setRequired(true)),

  new SlashCommandBuilder()
    .setName('mysubmissions')
    .setDescription('View your submissions'),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send ticket panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('submitpanel')
    .setDescription('Send submit panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a ticket')
];

// ===== REGISTER =====
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  console.log("Registering commands...");
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Commands registered");
})();

// ===== READY =====
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {

  try {

    // ===== SUBMIT =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'submit') {

      const campaign = interaction.options.getString('campaign');
      const link = interaction.options.getString('link');

      const id = counter++;

      submissions[id] = {
        user: interaction.user.id,
        campaign,
        link,
        status: 'Pending'
      };

      const channel = await client.channels.fetch(SUBMISSIONS_CHANNEL_ID);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${id}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${id}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({
        content:
`📩 Submission #${id}
👤 <@${interaction.user.id}>
🎯 ${campaign}
🔗 <${link}>
📊 Status: Pending`,
        components: [row]
      });

      await interaction.reply({ content: '✅ Submitted', ephemeral: true });
    }

    // ===== MY SUBMISSIONS =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'mysubmissions') {

      const userSubs = Object.entries(submissions)
        .filter(([id, s]) => s.user === interaction.user.id);

      if (userSubs.length === 0) {
        return interaction.reply({ content: 'No submissions found', ephemeral: true });
      }

      let text = '';

      userSubs.forEach(([id, s]) => {
        text +=
`#${id}
🎯 ${s.campaign}
🔗 <${s.link}>
📊 ${s.status}

`;
      });

      await interaction.reply({ content: text, ephemeral: true });
    }

    // ===== PANEL =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {

      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎟️ Support Center')
        .setDescription(`Click below to open a private ticket`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel('Open Ticket')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    }

    // ===== SUBMIT PANEL =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'submitpanel') {

      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎬 Submissions')
        .setDescription(`Use buttons below`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('submit_clip')
          .setLabel('Submit Clip')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('view_submissions')
          .setLabel('My Submissions')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    }

    // ===== BUTTONS =====
    if (interaction.isButton()) {

      // IMPORTANT: defer ONCE
      await interaction.deferReply({ ephemeral: true });

      // ===== OPEN TICKET =====
      if (interaction.customId === 'open_ticket') {

        const existing = interaction.guild.channels.cache.find(
          c => c.name === `ticket-${interaction.user.username}`
        );

        if (existing) {
          return interaction.editReply({ content: `❌ You already have a ticket: <#${existing.id}>` });
        }

        const channel = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            },
            {
              id: OWNER_ID,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            },
            {
              id: ROCA_ID,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            },
            {
              id: client.user.id, // BOT ACCESS FIX
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            }
          ]
        });

        await channel.send(`🎟️ Ticket opened by <@${interaction.user.id}>`);

        return interaction.editReply({ content: `✅ Ticket created: <#${channel.id}>` });
      }

      // ===== SUBMIT BUTTON =====
      if (interaction.customId === 'submit_clip') {
        return interaction.editReply({ content: 'Use /submit' });
      }

      // ===== VIEW SUBMISSIONS =====
      if (interaction.customId === 'view_submissions') {

        const userSubs = Object.entries(submissions)
          .filter(([id, s]) => s.user === interaction.user.id);

        if (userSubs.length === 0) {
          return interaction.editReply({ content: 'No submissions' });
        }

        let text = '';

        userSubs.forEach(([id, s]) => {
          text +=
`#${id}
🎯 ${s.campaign}
🔗 <${s.link}>
📊 ${s.status}

`;
        });

        return interaction.editReply({ content: text });
      }

      // ===== APPROVE / REJECT =====
      const [action, id] = interaction.customId.split('_');

      if (submissions[id]) {

        if (action === 'approve') submissions[id].status = 'Approved';
        if (action === 'reject') submissions[id].status = 'Rejected';

        return interaction.message.edit({
          content:
`📩 Submission #${id}
👤 <@${submissions[id].user}>
🎯 ${submissions[id].campaign}
🔗 <${submissions[id].link}>
📊 Status: ${submissions[id].status}`,
          components: []
        });
      }
    }

    // ===== CLOSE =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'close') {

      if (!interaction.channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ Not a ticket', ephemeral: true });
      }

      await interaction.reply({ content: '🔒 Closing...', ephemeral: true });

      setTimeout(async () => {
        await interaction.channel.delete().catch(() => {});
      }, 1500);
    }

  } catch (err) {
    console.error(err);
  }
});

// ===== LOGIN =====
client.login(TOKEN);