import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import { DateTime } from 'luxon';
import { nextEventAt, phaseFor, validateSetup } from './schedule.js';

const PHASE_COPY = {
  nominations: 'Nominations are open! Use `/movie suggest` to add one movie.',
  voting: 'Voting is open! Pick one movie below. Your vote is private and you may change it.',
  announced: 'Voting has closed.', complete: 'This movie night is complete.', pending: 'The next cycle has not opened yet.',
};

const PET_RESPONSES = [
  'Marvin’s status light turns pink. This is unrelated.',
  'A tiny mechanical purr escapes his chassis. He immediately blames the ventilation fan.',
  '**PAT RECEIVED.** Dignity integrity: 73%. Morale: suspiciously improved.',
  'Please do not tap the projectionist.\n\n…Do it again.',
  'Marvin leans into your hand by exactly 2.4 millimetres. This is a calibration procedure.',
  'His clapperboard clicks once like a wagging tail. You saw nothing.',
  'Marvin dispenses one ceremonial popcorn in recognition of services rendered. 🍿',
  'The little red antenna glows brighter. **AFFECTION INPUT ACCEPTED.**',
  'Marvin freezes, emits a Windows device-connected noise, and looks unbearably pleased with himself.',
  '“I am a sophisticated cinematic scheduling system,” Marvin says, while scooting closer.',
  'Head pats have been added to this week’s programming schedule. Attendance is mandatory.',
  '**CRITICAL PAT!** Marvin takes 12 points of emotional damage and gains 40 temporary happiness.',
];

export class MovieNight {
  constructor(client, db) { this.client = client; this.db = db; this.running = false; }

  config(guildId) { return this.db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId); }
  activeCycle(guildId) {
    return this.db.prepare("SELECT * FROM cycles WHERE guild_id = ? AND phase != 'complete' ORDER BY event_at LIMIT 1").get(guildId);
  }
  nominations(cycleId) { return this.db.prepare('SELECT * FROM nominations WHERE cycle_id = ? ORDER BY id').all(cycleId); }

  ensureCycle(config, now = DateTime.utc()) {
    let cycle = this.activeCycle(config.guild_id);
    if (cycle) return cycle;
    const eventAt = nextEventAt(config, now).toISO();
    this.db.prepare("INSERT OR IGNORE INTO cycles (guild_id, event_at, phase) VALUES (?, ?, 'pending')").run(config.guild_id, eventAt);
    return this.activeCycle(config.guild_id);
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'pet') return this.pet(interaction);
    if (!['movie', 'movie-admin'].includes(interaction.commandName)) return;
    if (!interaction.guildId) return interaction.reply({ content: 'Movie night only works inside a server.', ephemeral: true });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'setup') return await this.setup(interaction);
      if (sub === 'pause' || sub === 'resume') return await this.setPaused(interaction, sub === 'pause');
      if (sub === 'suggest') return await this.suggest(interaction);
      if (sub === 'status') return await this.status(interaction);
    } catch (error) {
      console.error(error);
      const response = { content: `I couldn't do that: ${error.message}`, ephemeral: true };
      return interaction.replied || interaction.deferred ? interaction.followUp(response) : interaction.reply(response);
    }
  }

  async pet(interaction) {
    const response = PET_RESPONSES[Math.floor(Math.random() * PET_RESPONSES.length)];
    return interaction.reply(`*<@${interaction.user.id}> gives Marvin a careful little head pat.*\n\n${response}`);
  }

  async handleComponent(interaction) {
    if (interaction.isButton() && interaction.customId === 'movie-role-join') return this.setRole(interaction, true);
    if (interaction.isButton() && interaction.customId === 'movie-role-leave') return this.setRole(interaction, false);
    // Preserve compatibility with role posts created before explicit buttons existed.
    if (interaction.isButton() && interaction.customId === 'movie-role-toggle') return this.toggleRole(interaction);
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('movie-vote:')) return;
    const cycleId = Number(interaction.customId.split(':')[1]);
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId);
    if (!cycle || cycle.phase !== 'voting') return interaction.reply({ content: 'That ballot is closed.', ephemeral: true });
    const nominationId = Number(interaction.values[0]);
    const valid = this.db.prepare('SELECT id, title FROM nominations WHERE id = ? AND cycle_id = ?').get(nominationId, cycleId);
    if (!valid) return interaction.reply({ content: 'That nomination is no longer available.', ephemeral: true });
    this.db.prepare(`INSERT INTO votes (cycle_id, user_id, nomination_id) VALUES (?, ?, ?)
      ON CONFLICT(cycle_id, user_id) DO UPDATE SET nomination_id = excluded.nomination_id`).run(cycleId, interaction.user.id, nominationId);
    return interaction.reply({ content: `Your private vote is now **${valid.title}**.`, ephemeral: true });
  }

  async setup(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('You need Manage Server to configure me.');
    const channel = interaction.options.getChannel('channel', true);
    const timezone = interaction.options.getString('timezone', true);
    const weekday = interaction.options.getInteger('weekday', true);
    const time = interaction.options.getString('time', true);
    const location = interaction.options.getString('location', true);
    const role = interaction.options.getRole('role');
    validateSetup(timezone, time);
    if (channel.type !== ChannelType.GuildText) throw new Error('Choose a normal text channel.');
    this.db.prepare(`INSERT INTO guild_config
      (guild_id, channel_id, timezone, event_weekday, event_time, location, role_id, paused)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(guild_id) DO UPDATE SET
      channel_id=excluded.channel_id, timezone=excluded.timezone, event_weekday=excluded.event_weekday,
      event_time=excluded.event_time, location=excluded.location, role_id=excluded.role_id, paused=0`)
      .run(interaction.guildId, channel.id, timezone, weekday, time, location, role?.id ?? null);
    const config = this.config(interaction.guildId);
    const cycle = this.ensureCycle(config);
    await interaction.reply({ content: `Configured! The next watch party is <t:${Math.floor(DateTime.fromISO(cycle.event_at).toSeconds())}:F>. I’ll run nominations, voting, the announcement, and Scheduled Event automatically.`, ephemeral: true });
    if (role) await this.ensureRolePost(interaction.guild, config, channel);
    if (cycle.phase === 'pending') await this.transition(config, cycle, 'nominations');
    await this.tickGuild(config);
  }

  async ensureRolePost(guild, config, channel) {
    const role = await guild.roles.fetch(config.role_id);
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!role || role.id === guild.id) throw new Error('The configured Movie Night role is unavailable.');
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      throw new Error(`Move my bot role above ${role} in Server Settings → Roles so I can assign it.`);
    }
    let message = config.role_message_id
      ? await channel.messages.fetch(config.role_message_id).catch(() => null)
      : null;
    const payload = {
      content: `🍿 **Welcome to Movie Night!**\n\nClick **Join Movie Night** below to receive ${role} and get notified when nominations, voting, and the winner are posted.\n\n**Each week:**\n🎬 Nominate one movie with \`/movie suggest\`\n🗳️ Vote privately when the ballot opens\n🍿 I’ll announce the winner and create the watch-party event\n\nUse \`/movie status\` anytime to see the current phase and upcoming date. Use **Leave Movie Night** whenever you want to stop notifications.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('movie-role-join').setLabel('Join Movie Night').setEmoji('🍿').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('movie-role-leave').setLabel('Leave Movie Night').setStyle(ButtonStyle.Secondary),
      )],
    };
    if (message) await message.edit(payload);
    else {
      message = await channel.send(payload);
      this.db.prepare('UPDATE guild_config SET role_message_id = ? WHERE guild_id = ?').run(message.id, guild.id);
    }
    if (!message.pinned) await message.pin('Persistent self-service Movie Night role post');
  }

  async toggleRole(interaction) {
    if (!interaction.guildId) return interaction.reply({ content: 'This button only works inside the server.', ephemeral: true });
    const config = this.config(interaction.guildId);
    if (!config?.role_id) return interaction.reply({ content: 'The Movie Night role is no longer configured.', ephemeral: true });
    const role = await interaction.guild.roles.fetch(config.role_id).catch(() => null);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    if (!role || me.roles.highest.comparePositionTo(role) <= 0) {
      return interaction.reply({ content: 'I can’t manage that role right now. An admin needs to check my role position.', ephemeral: true });
    }
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Member left Movie Night notifications');
      return interaction.reply({ content: `You’ve left ${role}.`, ephemeral: true });
    }
    await member.roles.add(role, 'Member joined Movie Night notifications');
    return interaction.reply({ content: `You’ve joined ${role}! 🍿`, ephemeral: true });
  }

  async setRole(interaction, shouldJoin) {
    if (!interaction.guildId) return interaction.reply({ content: 'This button only works inside the server.', ephemeral: true });
    const config = this.config(interaction.guildId);
    if (!config?.role_id) return interaction.reply({ content: 'The Movie Night role is no longer configured.', ephemeral: true });
    const role = await interaction.guild.roles.fetch(config.role_id).catch(() => null);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    if (!role || me.roles.highest.comparePositionTo(role) <= 0) {
      return interaction.reply({ content: 'I can’t manage that role right now. An admin needs to check my role position.', ephemeral: true });
    }
    const hasRole = member.roles.cache.has(role.id);
    if (shouldJoin && hasRole) return interaction.reply({ content: `You’re already in ${role}! 🍿`, ephemeral: true });
    if (!shouldJoin && !hasRole) return interaction.reply({ content: `You’re not currently in ${role}.`, ephemeral: true });
    if (shouldJoin) {
      await member.roles.add(role, 'Member joined Movie Night notifications');
      return interaction.reply({ content: `You’ve joined ${role}! 🍿`, ephemeral: true });
    }
    await member.roles.remove(role, 'Member left Movie Night notifications');
    return interaction.reply({ content: `You’ve left ${role}.`, ephemeral: true });
  }

  async setPaused(interaction, paused) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('You need Manage Server to do that.');
    const result = this.db.prepare('UPDATE guild_config SET paused = ? WHERE guild_id = ?').run(paused ? 1 : 0, interaction.guildId);
    if (!result.changes) throw new Error('Run `/movie setup` first.');
    return interaction.reply({ content: paused ? 'Movie-night automation is paused.' : 'Movie-night automation is awake again.', ephemeral: true });
  }

  async suggest(interaction) {
    const config = this.config(interaction.guildId);
    if (!config) throw new Error('An admin needs to run `/movie setup` first.');
    if (config.paused) throw new Error('Movie night is paused.');
    const cycle = this.ensureCycle(config);
    if (cycle.phase !== 'nominations') throw new Error(`Nominations aren’t open right now. ${PHASE_COPY[cycle.phase]}`);
    if (this.nominations(cycle.id).length >= 25) throw new Error('This week’s ballot is full at 25 movies.');
    const title = interaction.options.getString('title', true).trim().replace(/\s+/g, ' ');
    try { this.db.prepare('INSERT INTO nominations (cycle_id, title, user_id) VALUES (?, ?, ?)').run(cycle.id, title, interaction.user.id); }
    catch (error) {
      if (String(error).includes('cycle_id, title')) throw new Error('That movie has already been nominated.');
      throw error;
    }
    return interaction.reply({ content: `🎬 **${title}** is on the ballot!`, ephemeral: false });
  }

  async status(interaction) {
    const config = this.config(interaction.guildId);
    if (!config) throw new Error('An admin needs to run `/movie setup` first.');
    const cycle = this.ensureCycle(config);
    const movies = this.nominations(cycle.id);
    const when = `<t:${Math.floor(DateTime.fromISO(cycle.event_at).toSeconds())}:F>`;
    const phaseCopy = cycle.phase === 'pending'
      ? `Nominations open <t:${Math.floor(DateTime.fromISO(cycle.event_at).minus({ days: 6 }).toSeconds())}:F>.`
      : PHASE_COPY[cycle.phase];
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🍿 Movie Night')
      .setDescription(`${phaseCopy}\n\n**Watch party:** ${when}\n**Nominations:** ${movies.length ? movies.map((m) => m.title).join(', ') : 'None yet'}`)
      .setColor(0x9b59b6)], ephemeral: true });
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const config of this.db.prepare('SELECT * FROM guild_config WHERE paused = 0').all()) {
        try { await this.tickGuild(config); } catch (error) { console.error(`Scheduler error for guild ${config.guild_id}`, error); }
      }
    } finally { this.running = false; }
  }

  async tickGuild(config, now = DateTime.utc()) {
    let cycle = this.ensureCycle(config, now);
    const target = phaseFor(cycle.event_at, now);
    const order = ['pending', 'nominations', 'voting', 'announced', 'complete'];
    while (order.indexOf(cycle.phase) < order.indexOf(target)) {
      const next = order[order.indexOf(cycle.phase) + 1];
      await this.transition(config, cycle, next);
      cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id);
    }
    if (cycle.phase === 'complete') this.ensureCycle(config, now.plus({ minutes: 1 }));
  }

  async transition(config, cycle, next) {
    const channel = await this.client.channels.fetch(config.channel_id);
    if (!channel?.isTextBased()) throw new Error('Configured channel is unavailable.');
    if (next === 'nominations') {
      await channel.send(`${this.ping(config)}🎬 **Nominations are open!** Use \`/movie suggest\` to nominate one movie. Voting opens in three days.`);
    } else if (next === 'voting') {
      const nominations = this.nominations(cycle.id);
      if (nominations.length) {
        const menu = new StringSelectMenuBuilder().setCustomId(`movie-vote:${cycle.id}`).setPlaceholder('Choose your movie')
          .addOptions(nominations.slice(0, 25).map((n) => ({ label: n.title.slice(0, 100), value: String(n.id) })));
        const message = await channel.send({ content: `${this.ping(config)}🗳️ **Private voting is open!** Choose one movie. You may change your vote until voting closes.`, components: [new ActionRowBuilder().addComponents(menu)] });
        this.db.prepare('UPDATE cycles SET ballot_message_id = ? WHERE id = ?').run(message.id, cycle.id);
      } else await channel.send('No movies were nominated this week, so there won’t be a ballot. The cycle will try again next week.');
    } else if (next === 'announced') {
      await this.announce(config, cycle, channel);
    }
    this.db.prepare('UPDATE cycles SET phase = ? WHERE id = ?').run(next, cycle.id);
  }

  async announce(config, cycle, channel) {
    const rows = this.db.prepare(`SELECT n.id, n.title, COUNT(v.user_id) AS votes FROM nominations n
      LEFT JOIN votes v ON v.nomination_id=n.id WHERE n.cycle_id=? GROUP BY n.id ORDER BY votes DESC`).all(cycle.id);
    if (!rows.length) return;
    const highest = rows[0].votes;
    const tied = rows.filter((r) => r.votes === highest);
    const winner = tied[Math.floor(Math.random() * tied.length)];
    const eventAt = DateTime.fromISO(cycle.event_at);
    if (eventAt <= DateTime.utc()) {
      await channel.send('I recovered after this watch party had already passed, so I closed the old cycle without creating a stale event. A fresh cycle will begin automatically.');
      return;
    }
    const event = await channel.guild.scheduledEvents.create({
      name: `Movie Night: ${winner.title}`.slice(0, 100),
      description: `This week’s community-voted movie night selection: ${winner.title}`.slice(0, 1000),
      scheduledStartTime: eventAt.toJSDate(), scheduledEndTime: eventAt.plus({ hours: 3 }).toJSDate(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: config.location }, reason: 'Automatic weekly movie-night winner',
    });
    this.db.prepare('UPDATE cycles SET winner_nomination_id=?, scheduled_event_id=? WHERE id=?').run(winner.id, event.id, cycle.id);
    const tie = tied.length > 1 ? ` It was tied at ${highest}; the bot randomly selected among the tied films.` : '';
    await channel.send(`${this.ping(config)}🍿 **This week’s movie is ${winner.title}!**${tie}\nThe watch party is <t:${Math.floor(eventAt.toSeconds())}:F>. I created the Discord event: ${event.url}`);
    if (cycle.ballot_message_id) {
      const ballot = await channel.messages.fetch(cycle.ballot_message_id).catch(() => null);
      if (ballot) await ballot.edit({ components: ballot.components.map((row) => {
        const disabled = StringSelectMenuBuilder.from(row.components[0]).setDisabled(true).setPlaceholder('Voting closed');
        return new ActionRowBuilder().addComponents(disabled);
      }) }).catch(() => {});
    }
  }

  ping(config) { return config.role_id ? `<@&${config.role_id}> ` : ''; }
}
