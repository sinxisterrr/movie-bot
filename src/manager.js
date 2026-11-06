import { randomUUID } from 'node:crypto';
import * as chrono from 'chrono-node';
import {
  ActionRowBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { DateTime, IANAZone } from 'luxon';

const DISCORD_MESSAGE_LIMIT = 2000;
const POLL_QUESTION_LIMIT = 300;
const POLL_ANSWER_LIMIT = 55;

export class Manager {
  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.drafts = new Map();
    this.running = false;
  }

  async handle(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Middle management only operates inside a server.', ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server to operate Marvin’s clipboard.', ephemeral: true });
    }
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === 'setup') return this.setup(interaction);
      if (sub === 'announce') return this.openAnnouncement(interaction);
      if (sub === 'poll') return this.openPoll(interaction);
      if (sub === 'list') return this.list(interaction);
      if (sub === 'cancel') return this.cancel(interaction);
      if (sub === 'response-add') return this.openResponse(interaction);
      if (sub === 'response-list') return this.listResponses(interaction);
      if (sub === 'response-remove') return this.removeResponse(interaction);
    } catch (error) {
      console.error(error);
      return this.replyError(interaction, error);
    }
  }

  async handleModal(interaction) {
    try {
      const [, kind, token] = interaction.customId.split(':');
      const draft = this.drafts.get(token);
      this.drafts.delete(token);
      if (!draft || draft.guildId !== interaction.guildId || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
        throw new Error('That form expired. Please run the command again.');
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('You need Manage Server to do that.');
      if (kind === 'announce') return this.saveAnnouncement(interaction, draft);
      if (kind === 'poll') return this.savePoll(interaction, draft);
      if (kind === 'response') return this.saveResponse(interaction);
      throw new Error('Unknown manager form.');
    } catch (error) {
      console.error(error);
      return this.replyError(interaction, error);
    }
  }

  async setup(interaction) {
    const timezone = interaction.options.getString('timezone', true).trim();
    if (!IANAZone.isValidZone(timezone)) throw new Error('That timezone is invalid. Try something like `America/Regina`.');
    this.db.prepare(`INSERT INTO manager_config (guild_id, timezone) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET timezone = excluded.timezone`).run(interaction.guildId, timezone);
    return interaction.reply({ content: `📋 Marvin’s managerial timezone is now **${timezone}**.`, ephemeral: true });
  }

  async openAnnouncement(interaction) {
    const draft = this.baseDraft(interaction);
    const role = interaction.options.getRole('role');
    draft.roleId = role?.id ?? null;
    const maxLength = DISCORD_MESSAGE_LIMIT - (draft.roleId ? `<@&${draft.roleId}>\n`.length : 0);
    const token = this.storeDraft(draft);
    const body = new TextInputBuilder().setCustomId('body').setLabel('Exact announcement Markdown')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(maxLength)
      .setPlaceholder('# Your heading\nPaste the complete announcement exactly as it should appear.');
    return interaction.showModal(new ModalBuilder().setCustomId(`manager:announce:${token}`)
      .setTitle('Schedule announcement').addComponents(new ActionRowBuilder().addComponents(body)));
  }

  async openPoll(interaction) {
    const draft = this.baseDraft(interaction);
    draft.roleId = interaction.options.getRole('role')?.id ?? null;
    draft.duration = interaction.options.getInteger('duration', true);
    draft.multiple = interaction.options.getBoolean('multiple') ?? false;
    const token = this.storeDraft(draft);
    const question = new TextInputBuilder().setCustomId('question').setLabel('Poll question')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(POLL_QUESTION_LIMIT);
    const answers = new TextInputBuilder().setCustomId('answers').setLabel('Answers — one per line, 2–10 total')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1200)
      .setPlaceholder('🍄 | Mushrooms\n🌲 | The forest\n<:marvin:123456789> | Marvin decides');
    return interaction.showModal(new ModalBuilder().setCustomId(`manager:poll:${token}`)
      .setTitle('Schedule poll').addComponents(
        new ActionRowBuilder().addComponents(question),
        new ActionRowBuilder().addComponents(answers),
      ));
  }

  async openResponse(interaction) {
    const token = this.storeDraft({ guildId: interaction.guildId, userId: interaction.user.id, expiresAt: Date.now() + 15 * 60_000 });
    const response = new TextInputBuilder().setCustomId('response').setLabel('New /pet response')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(DISCORD_MESSAGE_LIMIT - 100)
      .setPlaceholder('Marvin’s tie spins once. This is a standard quarterly procedure.');
    return interaction.showModal(new ModalBuilder().setCustomId(`manager:response:${token}`)
      .setTitle('Teach Marvin a response').addComponents(new ActionRowBuilder().addComponents(response)));
  }

  baseDraft(interaction) {
    const timezone = this.getTimezone(interaction.guildId);
    if (!timezone) throw new Error('Run `/manager setup` once so Marvin knows your local timezone.');
    const runAt = parseScheduledTime(interaction.options.getString('when', true), timezone);
    return {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: interaction.options.getChannel('channel', true).id,
      timezone,
      runAt: runAt.toUTC().toISO(),
      expiresAt: Date.now() + 15 * 60_000,
    };
  }

  storeDraft(draft) {
    for (const [token, value] of this.drafts) if (value.expiresAt < Date.now()) this.drafts.delete(token);
    const token = randomUUID().replaceAll('-', '').slice(0, 16);
    this.drafts.set(token, draft);
    return token;
  }

  saveAnnouncement(interaction, draft) {
    const body = interaction.fields.getTextInputValue('body');
    const prefix = draft.roleId ? `<@&${draft.roleId}>\n` : '';
    if ((prefix + body).length > DISCORD_MESSAGE_LIMIT) throw new Error('That announcement is too long for one Discord message.');
    const id = this.insertJob(draft, 'announcement', { body });
    return this.confirmJob(interaction, id, draft, 'announcement');
  }

  savePoll(interaction, draft) {
    const question = interaction.fields.getTextInputValue('question').trim();
    const answers = parsePollAnswers(interaction.fields.getTextInputValue('answers'));
    const id = this.insertJob(draft, 'poll', { question, answers, duration: draft.duration, multiple: draft.multiple });
    return this.confirmJob(interaction, id, draft, 'poll');
  }

  saveResponse(interaction) {
    const text = interaction.fields.getTextInputValue('response').trim();
    const result = this.db.prepare(`INSERT INTO marvin_responses (guild_id, text, created_by, created_at)
      VALUES (?, ?, ?, ?)`).run(interaction.guildId, text, interaction.user.id, DateTime.utc().toISO());
    return interaction.reply({ content: `🤖 Response **#${result.lastInsertRowid}** added to Marvin’s approved head-pat procedures.`, ephemeral: true });
  }

  insertJob(draft, type, payload) {
    const result = this.db.prepare(`INSERT INTO scheduled_jobs
      (guild_id, channel_id, creator_id, type, payload_json, role_id, run_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      draft.guildId, draft.channelId, draft.userId, type, JSON.stringify(payload), draft.roleId,
      draft.runAt, DateTime.utc().toISO(),
    );
    return Number(result.lastInsertRowid);
  }

  confirmJob(interaction, id, draft, type) {
    const timestamp = Math.floor(DateTime.fromISO(draft.runAt).toSeconds());
    return interaction.reply({
      content: `📋 Scheduled ${type} **#${id}** for <#${draft.channelId}> at <t:${timestamp}:F> (<t:${timestamp}:R>).`,
      ephemeral: true,
    });
  }

  list(interaction) {
    const jobs = this.db.prepare(`SELECT id, type, channel_id, run_at, status FROM scheduled_jobs
      WHERE guild_id = ? AND status IN ('pending', 'running') ORDER BY run_at LIMIT 20`).all(interaction.guildId);
    if (!jobs.length) return interaction.reply({ content: '📋 Marvin’s clipboard is empty.', ephemeral: true });
    const lines = jobs.map((job) => {
      const timestamp = Math.floor(DateTime.fromISO(job.run_at).toSeconds());
      return `**#${job.id}** · ${job.type} · <#${job.channel_id}> · <t:${timestamp}:F> · ${job.status}`;
    });
    return interaction.reply({ content: `📋 **Upcoming work**\n${lines.join('\n')}`, ephemeral: true });
  }

  cancel(interaction) {
    const id = interaction.options.getInteger('id', true);
    const result = this.db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled'
      WHERE id = ? AND guild_id = ? AND status = 'pending'`).run(id, interaction.guildId);
    if (!result.changes) throw new Error(`Pending job #${id} was not found.`);
    return interaction.reply({ content: `🗑️ Job **#${id}** has been removed from Marvin’s clipboard.`, ephemeral: true });
  }

  listResponses(interaction) {
    const responses = this.db.prepare('SELECT id, text FROM marvin_responses WHERE guild_id = ? ORDER BY id LIMIT 20').all(interaction.guildId);
    if (!responses.length) return interaction.reply({ content: 'Marvin has no custom responses yet; only his factory-installed dignity problems.', ephemeral: true });
    const lines = responses.map((row) => `**#${row.id}** ${truncate(row.text.replaceAll('\n', ' '), 120)}`);
    return interaction.reply({ content: `🤖 **Custom /pet responses**\n${lines.join('\n')}`, ephemeral: true });
  }

  removeResponse(interaction) {
    const id = interaction.options.getInteger('id', true);
    const result = this.db.prepare('DELETE FROM marvin_responses WHERE id = ? AND guild_id = ?').run(id, interaction.guildId);
    if (!result.changes) throw new Error(`Custom response #${id} was not found.`);
    return interaction.reply({ content: `🧹 Custom response **#${id}** has been removed from Marvin’s handbook.`, ephemeral: true });
  }

  getTimezone(guildId) {
    return this.db.prepare('SELECT timezone FROM manager_config WHERE guild_id = ?').get(guildId)?.timezone
      ?? this.db.prepare('SELECT timezone FROM guild_config WHERE guild_id = ?').get(guildId)?.timezone;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db.prepare(`SELECT * FROM scheduled_jobs
        WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 25`).all(DateTime.utc().toISO());
      for (const job of due) await this.execute(job);
    } finally {
      this.running = false;
    }
  }

  async execute(job) {
    const claimed = this.db.prepare("UPDATE scheduled_jobs SET status = 'running' WHERE id = ? AND status = 'pending'").run(job.id);
    if (!claimed.changes) return;
    try {
      const channel = await this.client.channels.fetch(job.channel_id);
      if (!channel?.isTextBased()) throw new Error('The destination channel is unavailable or is not text-based.');
      const payload = JSON.parse(job.payload_json);
      const mention = job.role_id ? `<@&${job.role_id}>` : undefined;
      const allowedMentions = { parse: [], roles: job.role_id ? [job.role_id] : [], users: [] };
      let message;
      if (job.type === 'announcement') {
        message = await channel.send({ content: mention ? `${mention}\n${payload.body}` : payload.body, allowedMentions });
      } else if (job.type === 'poll') {
        message = await channel.send({
          content: mention,
          allowedMentions,
          poll: {
            question: { text: payload.question },
            answers: payload.answers,
            duration: payload.duration,
            allowMultiselect: payload.multiple,
          },
        });
      } else throw new Error(`Unknown scheduled job type: ${job.type}`);
      this.db.prepare(`UPDATE scheduled_jobs SET status = 'completed', executed_at = ?, message_id = ?, error = NULL WHERE id = ?`)
        .run(DateTime.utc().toISO(), message.id, job.id);
    } catch (error) {
      console.error(`Scheduled job #${job.id} failed`, error);
      this.db.prepare("UPDATE scheduled_jobs SET status = 'failed', executed_at = ?, error = ? WHERE id = ?")
        .run(DateTime.utc().toISO(), String(error.message ?? error).slice(0, 1000), job.id);
    }
  }

  replyError(interaction, error) {
    const options = { content: `I couldn’t do that: ${error.message}`, ephemeral: true };
    return interaction.replied || interaction.deferred ? interaction.followUp(options) : interaction.reply(options);
  }
}

export function parseScheduledTime(input, timezone, now = DateTime.now().setZone(timezone)) {
  if (!IANAZone.isValidZone(timezone)) throw new Error('The configured timezone is invalid.');
  const results = chrono.parse(input, { instant: now.toJSDate(), timezone: now.offset }, { forwardDate: true });
  if (!results.length) throw new Error('I couldn’t understand that time. Try `Nov 6 2026 9am` or `tomorrow 7:30pm`.');
  const start = results[0].start;
  const scheduled = DateTime.fromObject({
    year: start.get('year'), month: start.get('month'), day: start.get('day'),
    hour: start.get('hour'), minute: start.get('minute'), second: 0, millisecond: 0,
  }, { zone: timezone });
  if (!scheduled.isValid) throw new Error('That date or time is invalid.');
  if (scheduled <= now) throw new Error('That time is in the past. Marvin’s authority does not extend to time travel.');
  return scheduled;
}

export function parsePollAnswers(input) {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 10) throw new Error('A poll needs between 2 and 10 answers.');
  return lines.map((line, index) => {
    const divider = line.indexOf('|');
    let emoji;
    let text = line;
    if (divider !== -1) {
      const emojiText = line.slice(0, divider).trim();
      text = line.slice(divider + 1).trim();
      const custom = emojiText.match(/^<a?:([A-Za-z0-9_]+):(\d+)>$/);
      emoji = custom ? { id: custom[2], name: custom[1] } : { name: emojiText };
    }
    if (!text) throw new Error(`Poll answer ${index + 1} has no text.`);
    if (text.length > POLL_ANSWER_LIMIT) throw new Error(`Poll answer ${index + 1} exceeds ${POLL_ANSWER_LIMIT} characters.`);
    return emoji ? { text, emoji } : { text };
  });
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
