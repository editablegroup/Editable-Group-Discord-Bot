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

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1498623710301650994';
const GUILD_ID = '1437187584689438865';
const SUBMISSIONS_CHANNEL_ID = '1498679979666444378';

const OWNER_ID = '960171711674847282';   // Cilord
const ROCA_ID = '996919845373366362';    // Roca

// ===== CAMPAIGNS =====
// To add or remove campaigns, edit this list.
// 'label' is what users see in the dropdown.
// 'value' must be unique, lowercase, no spaces.
const CAMPAIGNS = [
  { label: 'Alter Ego - Doechii Ft. JT', value: 'alter_ego_doechii' },
  // Add more campaigns below like this:
  // { label: 'Campaign Name Here', value: 'campaign_value_here' },
];

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

let submissions = {};
let counter = 1;

// Temporarily stores which campaign a user selected before the modal opens
let pendingCampaign = {};

// ===== COMMANDS =====
const commands = [
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
        .setTitle('🎬 Manage Your Submissions')
        .setDescription('Use the buttons below.\n\n📤 Submit edits\n📊 View your submissions');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('submit_clip')
          .setLabel('Submit Edit')
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

        await channel.send(
          `🎟️ New ticket opened by <@${interaction.user.id}>!\n<@${OWNER_ID}> <@${ROCA_ID}> — please assist when available.\n\nType \`/close\` to close this ticket when resolved.`
        );

        return interaction.editReply({ content: `✅ Your ticket has been created: <#${channel.id}>` });

      } catch (err) {
        console.error('Open ticket error:', err);
        return interaction.editReply({ content: '❌ Failed to create ticket. Make sure the bot has **Manage Channels** permission.' });
      }
    }

    // ===== SUBMIT EDIT BUTTON — show campaign dropdown =====
    if (interaction.customId === 'submit_clip') {
      try {
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('campaign_select')
          .setPlaceholder('Select a campaign')
          .addOptions(
            CAMPAIGNS.map(c =>
              new StringSelectMenuOptionBuilder()
                .setLabel(c.label)
                .setValue(c.value)
            )
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
          .setColor(0x2b2d31)
          .setTitle('🎯 Select a Campaign')
          .setDescription('Please choose the campaign you want to submit your edit to from the dropdown below.');

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      } catch (err) {
        console.error('Submit edit button error:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
        }
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

        const isApproved = action === 'approve';
        submissions[id].status = isApproved ? 'Approved ✅' : 'Rejected ❌';

        // Update the submission message in #submissions
        await interaction.message.edit({
          content:
`📩 Submission #${id}
👤 <@${submissions[id].user}>
🎯 ${submissions[id].campaign}
🔗 <${submissions[id].link}>
📊 Status: ${submissions[id].status}`,
          components: []
        });

        // DM the user who submitted
        try {
          const submitter = await client.users.fetch(submissions[id].user);

          const dmEmbed = new EmbedBuilder()
            .setColor(isApproved ? 0x57f287 : 0xed4245)
            .setTitle(isApproved ? '✅ Submission Approved!' : '❌ Submission Rejected')
            .setDescription(isApproved
              ? 'Your submission has been reviewed and **approved**. Thank you!'
              : 'Your submission has been reviewed and **rejected**. Feel free to open a ticket if you have any questions.')
            .addFields(
              { name: '🎯 Campaign', value: submissions[id].campaign, inline: true },
              { name: '🔗 Link', value: submissions[id].link, inline: true }
            )
            .setTimestamp();

          await submitter.send({ embeds: [dmEmbed] });
        } catch (dmErr) {
          // User has DMs disabled — silently skip
          console.log(`Could not DM user ${submissions[id].user} — they likely have DMs disabled.`);
        }

      } catch (err) {
        console.error('Approve/reject error:', err);
      }
    }
  }

  // ===== CAMPAIGN SELECT MENU — show modal =====
  if (interaction.isStringSelectMenu() && interaction.customId === 'campaign_select') {
    try {
      const selectedValue = interaction.values[0];
      const selectedCampaign = CAMPAIGNS.find(c => c.value === selectedValue);

      // Store the selected campaign for this user so we can use it when the modal is submitted
      pendingCampaign[interaction.user.id] = selectedCampaign.label;

      // Build the modal (popup form)
      const modal = new ModalBuilder()
        .setCustomId('submit_modal')
        .setTitle('Submit an edit');

      const clipNameInput = new TextInputBuilder()
        .setCustomId('clip_name')
        .setLabel('Edit Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. My Awesome Edit')
        .setRequired(false);

      const clipLinkInput = new TextInputBuilder()
        .setCustomId('clip_link')
        .setLabel('Edit Link')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. https://www.tiktok.com/@user/video/...')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(clipNameInput),
        new ActionRowBuilder().addComponents(clipLinkInput)
      );

      // Show the modal — must be done directly, no defer
      await interaction.showModal(modal);
    } catch (err) {
      console.error('Campaign select error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
      }
    }
  }

  // ===== MODAL SUBMIT =====
  if (interaction.isModalSubmit() && interaction.customId === 'submit_modal') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const clipName = interaction.fields.getTextInputValue('clip_name') || 'Untitled';
      const clipLink = interaction.fields.getTextInputValue('clip_link');
      const campaign = pendingCampaign[interaction.user.id] || 'Unknown Campaign';

      // Clear the pending campaign for this user
      delete pendingCampaign[interaction.user.id];

      const id = counter++;

      submissions[id] = {
        user: interaction.user.id,
        campaign,
        clipName,
        link: clipLink,
        status: 'Pending'
      };

      const submissionsChannel = await client.channels.fetch(SUBMISSIONS_CHANNEL_ID);

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

      await submissionsChannel.send({
        content:
`📩 Submission #${id}
👤 <@${interaction.user.id}>
🎯 ${campaign}
🎬 ${clipName}
🔗 <${clipLink}>
📊 Status: Pending`,
        components: [row]
      });

      await interaction.editReply({ content: '✅ Your edit has been submitted! You will receive a DM once it has been reviewed.' });
    } catch (err) {
      console.error('Modal submit error:', err);
      return interaction.editReply({ content: '❌ Something went wrong. Please try again.' }).catch(() => {});
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
