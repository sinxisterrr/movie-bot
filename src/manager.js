import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as chrono from 'chrono-node';
import {
  ActionRowBuilder, ChannelFlags, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { DateTime, IANAZone } from 'luxon';

const DISCORD_MESSAGE_LIMIT = 2000;
const POLL_QUESTION_LIMIT = 300;
const POLL_ANSWER_LIMIT = 55;
const FORUM_TITLE_LIMIT = 100;
const MAX_FORUM_TAGS = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class Manager {
  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.drafts = new Map();
    this.running = false;
    const databasePath = resolve(process.env.DATABASE_PATH ?? './data/movie-night.sqlite');
    this.filesRoot = resolve(process.env.MANAGER_FILES_PATH ?? join(dirname(databasePath), 'manager-attachments'));
  }

  async handle(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Middle management only operates inside a server.', ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server to operate Marvin’s clipboard.', ephemeral: true });
    }
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === 'setup') return await this.setup(interaction);
      if (sub === 'announce') return await this.openAnnouncement(interaction);
      if (sub === 'poll') return await this.openPoll(interaction);
      if (sub === 'forum') return await this.openForum(interaction);
      if (sub === 'list') return await this.list(interaction);
      if (sub === 'show') return await this.show(interaction);
      if (sub === 'cancel') return await this.cancel(interaction);
      if (sub === 'response-add') return await this.openResponse(interaction);
      if (sub === 'response-list') return await this.listResponses(interaction);
      if (sub === 'response-remove') return await this.removeResponse(interaction);
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
      if (kind === 'announce') return await this.saveAnnouncement(interaction, draft);
      if (kind === 'poll') return await this.savePoll(interaction, draft);
      if (kind === 'forum') return await this.saveForum(interaction, draft);
      if (kind === 'response') return await this.saveResponse(interaction, draft);
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

  async openForum(interaction) {
    const draft = this.baseDraft(interaction);
    draft.roleId = interaction.options.getRole('role')?.id ?? null;
    draft.attachments = ['attachment-1', 'attachment-2', 'attachment-3', 'attachment-4']
      .map((name) => interaction.options.getAttachment(name))
      .filter(Boolean)
      .map((attachment) => ({
        name: attachment.name,
        url: attachment.url,
        size: attachment.size,
        contentType: attachment.contentType ?? null,
        description: attachment.description ?? null,
      }));
    for (const attachment of draft.attachments) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`**${attachment.name}** exceeds Marvin’s 20 MB scheduled-file limit.`);
      }
    }
    const token = this.storeDraft(draft);
    const title = new TextInputBuilder().setCustomId('title').setLabel('Forum post title')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(FORUM_TITLE_LIMIT);
    const tags = new TextInputBuilder().setCustomId('tags').setLabel('Existing forum tags — comma separated')
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
      .setPlaceholder('Day One, Event, Featured');
    const maxLength = DISCORD_MESSAGE_LIMIT - (draft.roleId ? `<@&${draft.roleId}>\n`.length : 0);
    const body = new TextInputBuilder().setCustomId('body').setLabel('Exact opening-post Markdown')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(maxLength)
      .setPlaceholder('# Day One\nPaste the complete forum post exactly as it should appear.');
    return interaction.showModal(new ModalBuilder().setCustomId(`manager:forum:${token}`)
      .setTitle('Schedule forum post').addComponents(
        new ActionRowBuilder().addComponents(title),
        new ActionRowBuilder().addComponents(tags),
        new ActionRowBuilder().addComponents(body),
      ));
  }

  async openResponse(interaction) {
    const kind = interaction.options.getString('kind', true);
    const token = this.storeDraft({ guildId: interaction.guildId, userId: interaction.user.id, kind, expiresAt: Date.now() + 15 * 60_000 });
    const response = new TextInputBuilder().setCustomId('response').setLabel(`New /${kind} response`)
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(DISCORD_MESSAGE_LIMIT - 100)
      .setPlaceholder('Marvin’s tie spins once. This is a standard quarterly procedure.');
    return interaction.showModal(new ModalBuilder().setCustomId(`manager:response:${token}`)
      .setTitle(`Teach Marvin a /${kind} response`).addComponents(new ActionRowBuilder().addComponents(response)));
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

  async saveForum(interaction, draft) {
    await interaction.deferReply({ ephemeral: true });
    const channel = await interaction.guild.channels.fetch(draft.channelId);
    if (!channel || ![ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
      throw new Error('The selected destination is no longer a forum or media channel.');
    }
    const title = interaction.fields.getTextInputValue('title').trim();
    const body = interaction.fields.getTextInputValue('body');
    const requestedTags = interaction.fields.getTextInputValue('tags');
    const tags = resolveForumTags(channel.availableTags ?? [], requestedTags);
    if (channel.flags?.has(ChannelFlags.RequireTag) && !tags.length) {
      throw new Error('That forum requires at least one tag. Add an existing tag name and try again.');
    }
    const prefix = draft.roleId ? `<@&${draft.roleId}>\n` : '';
    if ((prefix + body).length > DISCORD_MESSAGE_LIMIT) throw new Error('That opening post is too long for one Discord message.');

    const payload = {
      title,
      body,
      tagIds: tags.map((tag) => tag.id),
      tagNames: tags.map((tag) => tag.name),
      attachmentNames: draft.attachments.map((attachment) => attachment.name),
    };
    const id = this.insertJob(draft, 'forum', payload);
    try {
      await this.persistAttachments(id, draft.attachments);
    } catch (error) {
      this.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
      await this.cleanupFiles(id);
      throw error;
    }
    return this.confirmJob(interaction, id, draft, 'forum post');
  }

  saveResponse(interaction, draft) {
    const text = interaction.fields.getTextInputValue('response').trim();
    const result = this.db.prepare(`INSERT INTO marvin_responses (guild_id, text, created_by, created_at, kind)
      VALUES (?, ?, ?, ?, ?)`).run(interaction.guildId, text, interaction.user.id, DateTime.utc().toISO(), draft.kind);
    return interaction.reply({ content: `🤖 Response **#${result.lastInsertRowid}** added to Marvin’s approved /${draft.kind} procedures.`, ephemeral: true });
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
    const response = { content: `📋 Scheduled ${type} **#${id}** for <#${draft.channelId}> at <t:${timestamp}:F> (<t:${timestamp}:R>).` };
    return interaction.deferred ? interaction.editReply(response) : interaction.reply({ ...response, ephemeral: true });
  }

  async persistAttachments(jobId, attachments) {
    if (!attachments.length) return;
    const directory = join(this.filesRoot, String(jobId));
    await mkdir(directory, { recursive: true });
    for (const [index, attachment] of attachments.entries()) {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`Marvin could not preserve **${attachment.name}** (${response.status}).`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`**${attachment.name}** exceeds Marvin’s 20 MB scheduled-file limit.`);
      const filename = safeFilename(attachment.name, index);
      const storagePath = join(directory, `${index + 1}-${filename}`);
      await writeFile(storagePath, buffer);
      this.db.prepare(`INSERT INTO scheduled_job_files
        (job_id, filename, storage_path, content_type, size, description)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        jobId, filename, storagePath, attachment.contentType, buffer.length, attachment.description,
      );
    }
  }

  list(interaction) {
    const jobs = this.db.prepare(`SELECT id, type, channel_id, run_at, status FROM scheduled_jobs
      WHERE guild_id = ? AND status IN ('pending', 'running') ORDER BY run_at LIMIT 20`).all(interaction.guildId);
    if (!jobs.length) return interaction.reply({ content: '📋 Marvin’s clipboard is empty.', ephemeral: true });
    const lines = jobs.map((job) => {
      const timestamp = Math.floor(DateTime.fromISO(job.run_at).toSeconds());
      return `**#${job.id}** · ${job.type} · <#${job.channel_id}> · <t:${timestamp}:F> · ${job.status}`;
    });
    return interaction.reply({ content: `📋 **Upcoming work**\n${lines.join('\n')}\n\nUse \`/manager show id:<number>\` to inspect the complete scheduled content.`, ephemeral: true });
  }

  async show(interaction) {
    const id = interaction.options.getInteger('id', true);
    const job = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ? AND guild_id = ?').get(id, interaction.guildId);
    if (!job) throw new Error(`Job #${id} was not found.`);
    const payload = JSON.parse(job.payload_json);
    const timestamp = Math.floor(DateTime.fromISO(job.run_at).toSeconds());
    const files = this.db.prepare('SELECT filename, size FROM scheduled_job_files WHERE job_id = ? ORDER BY id').all(id);
    const embed = new EmbedBuilder()
      .setTitle(`📋 Job #${id} · ${job.type}`)
      .setColor(job.status === 'failed' ? 0xe74c3c : job.status === 'cancelled' ? 0x7f8c8d : 0x9b59b6)
      .addFields(
        { name: 'Status', value: job.status, inline: true },
        { name: 'Destination', value: `<#${job.channel_id}>`, inline: true },
        { name: 'Scheduled', value: `<t:${timestamp}:F>\n<t:${timestamp}:R>`, inline: true },
      );
    if (job.role_id) embed.addFields({ name: 'Role mention', value: `<@&${job.role_id}>`, inline: true });
    if (payload.title) embed.addFields({ name: 'Title', value: payload.title });
    if (payload.tagNames?.length) embed.addFields({ name: 'Forum tags', value: payload.tagNames.join(', ') });
    if (job.type === 'poll') {
      embed.addFields({ name: 'Question', value: payload.question });
      const answers = payload.answers.map((answer, index) => `${index + 1}. ${formatPollEmoji(answer.emoji)}${answer.text}`).join('\n');
      embed.addFields({ name: 'Answers', value: answers });
    }
    const body = payload.body;
    if (body) embed.setDescription(body);
    const attachmentNames = files.length ? files : (payload.attachmentNames ?? []).map((filename) => ({ filename, size: null }));
    if (attachmentNames.length) {
      embed.addFields({
        name: 'Attachments',
        value: attachmentNames.map((file) => `• ${file.filename}${file.size == null ? '' : ` (${formatBytes(file.size)})`}`).join('\n'),
      });
    }
    if (job.error) embed.addFields({ name: 'Error', value: truncate(job.error, 1000) });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  async cancel(interaction) {
    const id = interaction.options.getInteger('id', true);
    const result = this.db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled'
      WHERE id = ? AND guild_id = ? AND status = 'pending'`).run(id, interaction.guildId);
    if (!result.changes) throw new Error(`Pending job #${id} was not found.`);
    await this.cleanupFiles(id);
    return interaction.reply({ content: `🗑️ Job **#${id}** has been removed from Marvin’s clipboard.`, ephemeral: true });
  }

  listResponses(interaction) {
    const kind = interaction.options.getString('kind');
    const responses = kind
      ? this.db.prepare('SELECT id, text, kind FROM marvin_responses WHERE guild_id = ? AND kind = ? ORDER BY id LIMIT 20').all(interaction.guildId, kind)
      : this.db.prepare('SELECT id, text, kind FROM marvin_responses WHERE guild_id = ? ORDER BY id LIMIT 20').all(interaction.guildId);
    if (!responses.length) return interaction.reply({ content: 'Marvin has no custom responses yet; only his factory-installed dignity problems.', ephemeral: true });
    const lines = responses.map((row) => `**#${row.id}** · /${row.kind} · ${truncate(row.text.replaceAll('\n', ' '), 120)}`);
    return interaction.reply({ content: `🤖 **Custom Marvin responses**\n${lines.join('\n')}`, ephemeral: true });
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
      const payload = JSON.parse(job.payload_json);
      const mention = job.role_id ? `<@&${job.role_id}>` : undefined;
      const allowedMentions = { parse: [], roles: job.role_id ? [job.role_id] : [], users: [] };
      let message;
      if (job.type === 'announcement') {
        if (!channel?.isTextBased()) throw new Error('The destination channel is unavailable or is not text-based.');
        message = await channel.send({ content: mention ? `${mention}\n${payload.body}` : payload.body, allowedMentions });
      } else if (job.type === 'poll') {
        if (!channel?.isTextBased()) throw new Error('The destination channel is unavailable or is not text-based.');
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
      } else if (job.type === 'forum') {
        if (!channel || ![ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
          throw new Error('The destination forum channel is unavailable.');
        }
        const fileRows = this.db.prepare('SELECT * FROM scheduled_job_files WHERE job_id = ? ORDER BY id').all(job.id);
        const files = await Promise.all(fileRows.map(async (file) => ({
          attachment: await readFile(file.storage_path),
          name: file.filename,
          description: file.description ?? undefined,
        })));
        message = await channel.threads.create({
          name: payload.title,
          appliedTags: payload.tagIds,
          message: {
            content: mention ? `${mention}\n${payload.body}` : payload.body,
            allowedMentions,
            files,
          },
          reason: `Scheduled by Marvin job #${job.id}`,
        });
      } else throw new Error(`Unknown scheduled job type: ${job.type}`);
      this.db.prepare(`UPDATE scheduled_jobs SET status = 'completed', executed_at = ?, message_id = ?, error = NULL WHERE id = ?`)
        .run(DateTime.utc().toISO(), message.id, job.id);
      await this.cleanupFiles(job.id);
    } catch (error) {
      console.error(`Scheduled job #${job.id} failed`, error);
      this.db.prepare("UPDATE scheduled_jobs SET status = 'failed', executed_at = ?, error = ? WHERE id = ?")
        .run(DateTime.utc().toISO(), String(error.message ?? error).slice(0, 1000), job.id);
    }
  }

  async cleanupFiles(jobId) {
    const directory = join(this.filesRoot, String(jobId));
    await rm(directory, { recursive: true, force: true });
    this.db.prepare('DELETE FROM scheduled_job_files WHERE job_id = ?').run(jobId);
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
  if (scheduled <= now) {
    const timestamp = Math.floor(scheduled.toSeconds());
    throw new Error(`I read that as <t:${timestamp}:F>, which is in the past. Try a future date or something like \`tomorrow 9am\`.`);
  }
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

export function resolveForumTags(availableTags, input) {
  const names = input.split(/[,\n]/).map((name) => name.trim()).filter(Boolean);
  const uniqueNames = [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()];
  if (uniqueNames.length > MAX_FORUM_TAGS) throw new Error(`Forum posts can use at most ${MAX_FORUM_TAGS} tags.`);
  return uniqueNames.map((requested) => {
    const matches = availableTags.filter((tag) => tag.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
    if (!matches.length) {
      const available = availableTags.map((tag) => tag.name).join(', ') || 'none';
      throw new Error(`Forum tag **${requested}** does not exist. Available tags: ${available}.`);
    }
    if (matches.length > 1) throw new Error(`Forum tag **${requested}** is ambiguous because more than one tag has that name.`);
    return matches[0];
  });
}

function safeFilename(name, index) {
  const cleaned = basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || `attachment-${index + 1}`;
}

function formatPollEmoji(emoji) {
  if (!emoji) return '';
  return emoji.id ? `<:${emoji.name}:${emoji.id}> ` : `${emoji.name} `;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
