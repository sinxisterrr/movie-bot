import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Give Marvin the Movie Bot a head pat'),
  new SlashCommandBuilder()
    .setName('movie')
    .setDescription('Join movie night')
    .addSubcommand((s) => s.setName('suggest').setDescription('Nominate a movie')
      .addStringOption((o) => o.setName('title').setDescription('Movie title').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('status').setDescription('Show this week’s movie-night status')),
  new SlashCommandBuilder()
    .setName('movie-admin')
    .setDescription('Configure movie night')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('setup').setDescription('Configure automatic movie nights')
      .addChannelOption((o) => o.setName('channel').setDescription('Movie-night channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. America/Regina').setRequired(true))
      .addIntegerOption((o) => o.setName('weekday').setDescription('Watch-party day').setRequired(true)
        .addChoices(
          { name: 'Monday', value: 1 }, { name: 'Tuesday', value: 2 }, { name: 'Wednesday', value: 3 },
          { name: 'Thursday', value: 4 }, { name: 'Friday', value: 5 }, { name: 'Saturday', value: 6 }, { name: 'Sunday', value: 7 },
        ))
      .addStringOption((o) => o.setName('time').setDescription('24-hour local time, e.g. 20:00').setRequired(true))
      .addStringOption((o) => o.setName('location').setDescription('Where/how to watch').setRequired(true).setMaxLength(100))
      .addRoleOption((o) => o.setName('role').setDescription('Optional role to ping')))
    .addSubcommand((s) => s.setName('pause').setDescription('Pause automatic cycles'))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume automatic cycles')),
  new SlashCommandBuilder()
    .setName('manager')
    .setDescription('Marvin the Middle Manager')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('setup').setDescription('Set the timezone used for scheduled jobs')
      .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. America/Regina').setRequired(true)))
    .addSubcommand((s) => s.setName('announce').setDescription('Schedule an exact Markdown announcement')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('when').setDescription('Your local time, e.g. Nov 6 2026 9am').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Optional role to ping')))
    .addSubcommand((s) => s.setName('poll').setDescription('Schedule a native Discord poll')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('when').setDescription('Your local time, e.g. tomorrow 9am').setRequired(true))
      .addIntegerOption((o) => o.setName('duration').setDescription('How long voting stays open').setRequired(true)
        .addChoices(
          { name: '1 hour', value: 1 }, { name: '4 hours', value: 4 }, { name: '8 hours', value: 8 },
          { name: '24 hours', value: 24 }, { name: '3 days', value: 72 }, { name: '1 week', value: 168 },
        ))
      .addBooleanOption((o) => o.setName('multiple').setDescription('Allow people to choose multiple answers'))
      .addRoleOption((o) => o.setName('role').setDescription('Optional role to ping')))
    .addSubcommand((s) => s.setName('list').setDescription('List upcoming scheduled jobs'))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a pending scheduled job')
      .addIntegerOption((o) => o.setName('id').setDescription('Job ID from /manager list').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('response-add').setDescription('Add a custom Marvin /pet response'))
    .addSubcommand((s) => s.setName('response-list').setDescription('List custom Marvin /pet responses'))
    .addSubcommand((s) => s.setName('response-remove').setDescription('Remove a custom Marvin /pet response')
      .addIntegerOption((o) => o.setName('id').setDescription('Response ID from /manager response-list').setRequired(true).setMinValue(1))),
].map((command) => command.toJSON());
