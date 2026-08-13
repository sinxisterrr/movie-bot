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
].map((command) => command.toJSON());
