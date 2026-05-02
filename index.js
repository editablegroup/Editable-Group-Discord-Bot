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

const OWNER_ID = '960171711674847282';   // Cilord
const ROCA_ID = '996919845373366362';    // Roca

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
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

  // ===== SUBMIT =====
  if (interaction.isChatInputCommand() && interaction.commandName === 'submit') {
    try {
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
    } catch (err) {
      console.error('Submit error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }
  }

  // ===== MY SUBMISSIONS =====
  if (interaction.isChatInputCommand() && interaction.commandName === 'mysubmissions') {
    try {
      const userSubs = Object.entries(submissions)
        .filter(([id, s]) => s.user === interaction.user.id);

      if (userSubs.length === 0) {
        return interaction.reply({ content: 'No submissions found.', ephemeral: true });
      }

      let text = '';
      userSubs.forEach(([id, s]) => {
        text += `#${id}\n🎯 ${s.campaign}\n🔗 <${s.link}>\n📊 ${s.status}\n\n`;
      });

      await interaction.reply({ content: text, ephemeral: true });
    } catch (err) {
      console.error('My submissions error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }
  }

  // ===== PANEL =====
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎟️ Support Center')
        .setDescription('Use the button below to open a ticket.\n\n• Submissions\n• Payments\n• Issues');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel('Open Ticket')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    } catch (err) {
      console.error('Panel error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }
  }

  // ===== SUBMIT PANEL =====
  if (interaction.isChatInputCommand() && interaction.commandName === 'submitpanel') {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('🎬 Submissions')
        .setDescription('Use buttons below');

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
    } catch (err) {
      console.error('Submit panel error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }
  }

  // ===== BUTTONS =====
  if (interaction.isButton()) {

    // ===== OPEN TICKET =====
    if (interaction.customId === 'open_ticket') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const existing = interaction.guild.channels.cache.find(
          c => c.name === `ticket-${interaction.user.username}`
        );

        if (existing) {
          return interaction.editReply({ content: `❌ You already have an open ticket: <#${existing.id}>` });
        }

        // Fetch members so Discord.js can resolve them in permission overwrites
        const ownerMember = await interaction.guild.members.fetch(OWNER_ID).catch(() => null);
        const rocaMember = await interaction.guild.members.fetch(ROCA_ID).catch(() => null);

        const permissionOverwrites = [
          {
            id: interaction.guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
          {
            id: client.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          }
        ];

        if (ownerMember) permissionOverwrites.push({
          id: ownerMember.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });

        if (rocaMember) permissionOverwrites.push({
          id: rocaMember.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });

        const channel = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites
        });

        // Ping Cilord and Roca so they get notified
        await channel.send(
          `🎟️ New ticket opened by <@${interaction.user.id}>!\n<@${OWNER_ID}> <@${ROCA_ID}> — please assist when available.\n\nType \`/close\` to close this ticket when resolved.`
        );

        return interaction.editReply({ content: `✅ Your ticket has been created: <#${channel.id}>` });

      } catch (err) {
        console.error('Open ticket error:', err);
        return interaction.editReply({ content: '❌ Failed to create ticket. Make sure the bot has **Manage Channels** permission.' });
      }
    }

    // ===== SUBMIT BUTTON =====
    if (interaction.customId === 'submit_clip') {
      await interaction.deferReply({ ephemeral: true });
      try {
        return interaction.editReply({ content: 'Use /submit to submit a clip.' });
      } catch (err) {
        console.error('Submit clip error:', err);
        return interaction.editReply({ content: '❌ Something went wrong.' }).catch(() => {});
      }
    }

    // ===== VIEW SUBMISSIONS =====
    if (interaction.customId === 'view_submissions') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const userSubs = Object.entries(submissions)
          .filter(([id, s]) => s.user === interaction.user.id);

        if (userSubs.length === 0) {
          return interaction.editReply({ content: 'You have no submissions yet.' });
        }

        let text = '';
        userSubs.forEach(([id, s]) => {
          text += `#${id}\n🎯 ${s.campaign}\n🔗 <${s.link}>\n📊 ${s.status}\n\n`;
        });

        return interaction.editReply({ content: text });
      } catch (err) {
        console.error('View submissions error:', err);
        return interaction.editReply({ content: '❌ Something went wrong.' }).catch(() => {});
      }
    }

    // ===== APPROVE / REJECT =====
    const [action, id] = interaction.customId.split('_');

    if ((action === 'approve' || action === 'reject') && submissions[id]) {
      try {
        await interaction.deferUpdate();

        if (action === 'approve') submissions[id].status = 'Approved ✅';
        if (action === 'reject') submissions[id].status = 'Rejected ❌';

        return interaction.message.edit({
          content:
`📩 Submission #${id}
👤 <@${submissions[id].user}>
🎯 ${submissions[id].campaign}
🔗 <${submissions[id].link}>
📊 Status: ${submissions[id].status}`,
          components: []
        });
      } catch (err) {
        console.error('Approve/reject error:', err);
      }
    }
  }

  // ===== CLOSE =====
  if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
    try {
      if (!interaction.channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ This command can only be used inside a ticket channel.', ephemeral: true });
      }

      await interaction.reply({ content: '🔒 Closing ticket in 3 seconds...' });

      setTimeout(async () => {
        await interaction.channel.delete().catch(() => {});
      }, 3000);
    } catch (err) {
      console.error('Close error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to close ticket.', ephemeral: true }).catch(() => {});
      }
    }
  }

});

// ===== LOGIN =====
client.login(TOKEN);
