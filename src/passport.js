import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(__dirname, '../assets/passport');
const MAX_STAMP_BYTES = 8 * 1024 * 1024;
const MILESTONES = new Set([3, 6, 12, 24, 36, 48, 60]);
const SLOT_CENTERS = [
  [746, 374], [944, 374], [1141, 374], [1338, 374],
  [746, 545], [944, 545], [1141, 545], [1338, 545],
  [746, 713], [944, 713], [1141, 713], [1338, 713],
];
const PORTRAIT = { left: 150, top: 273, width: 405, height: 405 };

export class Passport {
  constructor(client, db) {
    this.client = client;
    this.db = db;
    const databasePath = resolve(process.env.DATABASE_PATH ?? './data/movie-night.sqlite');
    this.stampsRoot = resolve(process.env.PASSPORT_STAMPS_PATH ?? join(dirname(databasePath), 'passport-stamps'));
  }

  async handle(interaction) {
    try {
      if (!interaction.inGuild()) return interaction.reply({ content: 'Passports are issued inside Dystopian territory only.', ephemeral: true });
      if (interaction.commandName === 'passport') return await this.show(interaction);
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need Manage Server to operate the passport office.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'event-add') return await this.addEvent(interaction);
      if (sub === 'event-list') return await this.listEvents(interaction);
      if (sub === 'event-remove') return await this.removeEvent(interaction);
      if (sub === 'grant') return await this.grant(interaction);
    } catch (error) {
      console.error('Passport interaction error', error);
      const content = `Marvin could not process that passport paperwork: ${error.message}`;
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content, files: [] }).catch(() => {});
      return interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }

  async addEvent(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole('role', true);
    const name = interaction.options.getString('name', true).trim();
    const attachment = interaction.options.getAttachment('stamp', true);
    const backfill = interaction.options.getBoolean('backfill') ?? true;
    if (backfill && !this.client.options?.intents?.has(GatewayIntentBits.GuildMembers)) {
      throw new Error('Backfill needs Server Members Intent and PASSPORT_ROLE_TRACKING=true. Register with backfill:false until both are enabled.');
    }
    if (role.id === interaction.guildId) throw new Error('The everyone role cannot be an event stamp. Marvin checked twice.');
    if (attachment.size > MAX_STAMP_BYTES) throw new Error('Stamp artwork must be 8 MB or smaller. Bureaucracy has limits.');
    if (attachment.contentType && !attachment.contentType.startsWith('image/')) throw new Error('Stamp artwork must be an image.');
    const existing = this.eventForRole(interaction.guildId, role.id);
    if (existing) throw new Error(`${role.name} is already registered as **${existing.name}**. Existing event artwork is kept immutable.`);

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Marvin could not preserve that stamp (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_STAMP_BYTES) throw new Error('Stamp artwork must be 8 MB or smaller.');
    await sharp(buffer).metadata();
    await mkdir(this.stampsRoot, { recursive: true });

    const eventId = this.db.prepare(`INSERT INTO passport_events
      (guild_id, role_id, name, stamp_path, active, created_by, created_at)
      VALUES (?, ?, ?, '', 1, ?, ?)`).run(interaction.guildId, role.id, name, interaction.user.id, new Date().toISOString()).lastInsertRowid;
    const extension = safeImageExtension(attachment.name, attachment.contentType);
    const stampPath = join(this.stampsRoot, `${interaction.guildId}-${eventId}${extension}`);
    try {
      await writeFile(stampPath, buffer);
      this.db.prepare('UPDATE passport_events SET stamp_path = ? WHERE id = ?').run(stampPath, eventId);
    } catch (error) {
      this.db.prepare('DELETE FROM passport_events WHERE id = ?').run(eventId);
      throw error;
    }

    let awarded = 0;
    if (backfill) {
      const members = await interaction.guild.members.fetch();
      for (const member of members.values()) {
        if (!member.user.bot && member.roles.cache.has(role.id)) {
          const result = await this.award(member, this.eventById(eventId));
          if (result.awarded) awarded += 1;
        }
      }
    }
    return interaction.editReply(`🛂 Registered **${name}** for ${role}.${backfill ? ` Backfilled **${awarded}** new passport stamp${awarded === 1 ? '' : 's'}.` : ''}`);
  }

  async listEvents(interaction) {
    const rows = this.db.prepare(`SELECT id, role_id, name, active FROM passport_events
      WHERE guild_id = ? ORDER BY id`).all(interaction.guildId);
    if (!rows.length) return interaction.reply({ content: 'The passport office has no registered events yet.', ephemeral: true });
    const lines = rows.map((row) => `**#${row.id}** ${row.active ? '✅' : '⏸️'} <@&${row.role_id}> — ${row.name}`);
    return interaction.reply({ content: `🛂 **Registered event stamps**\n${lines.join('\n')}`.slice(0, 2000), ephemeral: true, allowedMentions: { parse: [] } });
  }

  async removeEvent(interaction) {
    const role = interaction.options.getRole('role', true);
    const event = this.eventForRole(interaction.guildId, role.id);
    if (!event) return interaction.reply({ content: `${role} is not registered with the passport office.`, ephemeral: true });
    this.db.prepare('UPDATE passport_events SET active = 0 WHERE id = ?').run(event.id);
    return interaction.reply({
      content: `⏸️ **${event.name}** will not award new stamps. Existing passport stamps remain permanent.`,
      ephemeral: true,
    });
  }

  async grant(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('member', true);
    const role = interaction.options.getRole('role', true);
    const event = this.eventForRole(interaction.guildId, role.id);
    if (!event) throw new Error(`${role.name} is not registered with the passport office.`);
    const member = await interaction.guild.members.fetch(user.id);
    const result = await this.award(member, event);
    return interaction.editReply(result.awarded
      ? `🛂 Granted **${event.name}** to **${member.displayName}**. Their passport now has **${result.total}** stamp${result.total === 1 ? '' : 's'}.`
      : `**${member.displayName}** already has the **${event.name}** stamp.`);
  }

  async handleMemberUpdate(before, after) {
    const addedRoleIds = after.roles.cache.filter((role) => !before.roles.cache.has(role.id)).map((role) => role.id);
    if (!addedRoleIds.length || after.user.bot) return;
    const placeholders = addedRoleIds.map(() => '?').join(',');
    const events = this.db.prepare(`SELECT * FROM passport_events
      WHERE guild_id = ? AND active = 1 AND role_id IN (${placeholders})`).all(after.guild.id, ...addedRoleIds);
    for (const event of events) await this.award(after, event);
  }

  async award(member, event) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO passport_stamps
      (guild_id, user_id, event_id, awarded_at) VALUES (?, ?, ?, ?)`)
      .run(member.guild.id, member.id, event.id, new Date().toISOString());
    const total = this.count(member.guild.id, member.id);
    if (!result.changes) return { awarded: false, total };
    await this.notifyAward(member, event, total);
    return { awarded: true, total };
  }

  async notifyAward(member, event, total) {
    if (!MILESTONES.has(total)) return;
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO passport_milestones
      (guild_id, user_id, threshold, reached_at) VALUES (?, ?, ?, ?)`).run(member.guild.id, member.id, total, new Date().toISOString());
    if (!inserted.changes) return;
    const tier = tierForCount(total);
    const lines = [`🛂 **Dystopian Event Passport milestone!**`, `**${event.name}** became stamp **#${total}**.`, `Your record now reads **${tier.tier}**, Volume ${roman(tier.volume)}.`, milestoneMessage(total)];
    lines.push('Use `/passport` in the server to inspect the evidence.');
    const message = lines.join('\n');
    try {
      await member.send(message);
    } catch {
      this.db.prepare(`INSERT INTO passport_pending_notices (guild_id, user_id, message, created_at)
        VALUES (?, ?, ?, ?)`).run(member.guild.id, member.id, message, new Date().toISOString());
    }
  }

  async show(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const stamps = this.memberStamps(interaction.guildId, interaction.user.id);
    const total = stamps.length;
    const current = tierForCount(total);
    const requested = interaction.options.getInteger('volume') ?? current.volume;
    const highestAvailable = Math.max(1, current.volume);
    if (requested > highestAvailable) {
      return interaction.editReply(`Volume ${roman(requested)} remains classified. Your current passport is Volume ${roman(current.volume)}.`);
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const buffer = await this.render(member, stamps, requested);
    const notices = this.db.prepare(`SELECT id, message FROM passport_pending_notices
      WHERE guild_id = ? AND user_id = ? ORDER BY id`).all(interaction.guildId, interaction.user.id);
    const noticeText = notices.length ? `\n\n📬 **Marvin’s previously undeliverable paperwork:**\n${notices.map((row) => row.message).join('\n\n')}` : '';
    const attachment = new AttachmentBuilder(buffer, { name: `dystopian-passport-volume-${requested}.png` });
    await interaction.editReply({
      content: `🛂 **${member.displayName}** — ${total}/60 permanent event stamps. Viewing **${tierForVolume(requested).tier}, Volume ${roman(requested)}**.${noticeText}`.slice(0, 2000),
      files: [attachment],
    });
    if (notices.length) {
      const ids = notices.map((row) => row.id);
      this.db.prepare(`DELETE FROM passport_pending_notices WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
  }

  async render(member, stamps, volume) {
    const templatePath = join(TEMPLATE_ROOT, `volume-${volume}-template.png`);
    const avatarResponse = await fetch(member.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true }));
    if (!avatarResponse.ok) throw new Error(`Marvin could not retrieve your passport photograph (${avatarResponse.status}).`);
    const avatarBuffer = Buffer.from(await avatarResponse.arrayBuffer());
    const avatar = await sharp(avatarBuffer).resize(PORTRAIT.width, PORTRAIT.height, { fit: 'cover' }).png().toBuffer();
    const composites = [{ input: avatar, left: PORTRAIT.left, top: PORTRAIT.top }, { input: templatePath, left: 0, top: 0 }];
    const volumeStamps = stamps.slice((volume - 1) * 12, volume * 12);
    for (const [index, stamp] of volumeStamps.entries()) {
      const angle = deterministicAngle(member.id, stamp.event_id);
      const art = await sharp(await readFile(stamp.stamp_path))
        .resize(110, 110, { fit: 'contain', withoutEnlargement: true })
        .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      const metadata = await sharp(art).metadata();
      composites.push({ input: art, left: Math.round(SLOT_CENTERS[index][0] - metadata.width / 2), top: Math.round(SLOT_CENTERS[index][1] - metadata.height / 2) });
    }
    composites.push({ input: nameplateSvg(member.displayName), left: 181, top: 614 });
    return sharp({ create: { width: 1536, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites).png().toBuffer();
  }

  eventForRole(guildId, roleId) {
    return this.db.prepare('SELECT * FROM passport_events WHERE guild_id = ? AND role_id = ?').get(guildId, roleId);
  }

  eventById(id) {
    return this.db.prepare('SELECT * FROM passport_events WHERE id = ?').get(id);
  }

  count(guildId, userId) {
    return this.db.prepare('SELECT COUNT(*) AS total FROM passport_stamps WHERE guild_id = ? AND user_id = ?').get(guildId, userId).total;
  }

  memberStamps(guildId, userId) {
    return this.db.prepare(`SELECT s.event_id, s.awarded_at, e.name, e.stamp_path
      FROM passport_stamps s JOIN passport_events e ON e.id = s.event_id
      WHERE s.guild_id = ? AND s.user_id = ? ORDER BY s.awarded_at, s.id`).all(guildId, userId);
  }
}

export function tierForCount(count) {
  const volume = Math.min(5, Math.max(1, Math.floor((Math.max(1, count) - 1) / 12) + 1));
  return tierForVolume(volume);
}

export function tierForVolume(volume) {
  return { volume, tier: ['Citizen', 'Resident', 'Veteran', 'Luminary', 'Legend'][volume - 1] };
}

export function deterministicAngle(userId, eventId) {
  const value = createHash('sha256').update(`${userId}:${eventId}`).digest().readUInt32BE(0);
  return (value % 91) - 45;
}

function safeImageExtension(name, contentType) {
  const extension = extname(name ?? '').toLowerCase();
  if (['.png', '.webp', '.jpg', '.jpeg', '.gif'].includes(extension)) return extension;
  if (contentType === 'image/webp') return '.webp';
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/gif') return '.gif';
  return '.png';
}

function milestoneMessage(total) {
  if (total === 3) return '✨ **Milestone unlocked:** three pieces of evidence. Management is beginning to notice.';
  if (total === 6) return '✨ **Milestone unlocked:** six events survived. This is becoming a pattern.';
  if (total === 12) return '🏅 **Volume I complete:** Citizen records sealed. Resident paperwork has been authorized.';
  if (total === 24) return '🏅 **Volume II complete:** Resident records sealed. Veteran status approved.';
  if (total === 36) return '🏅 **Volume III complete:** Veteran records sealed. Luminary clearance approved.';
  if (total === 48) return '🏅 **Volume IV complete:** Luminary records sealed. Legend classification approved.';
  return '👑 **Volume V complete:** sixty events documented. Dystopian Legend status is now a matter of permanent record.';
}

function roman(number) {
  return ['I', 'II', 'III', 'IV', 'V'][number - 1];
}

function nameplateSvg(name) {
  const safe = escapeXml(name.length > 24 ? `${name.slice(0, 23)}…` : name);
  return Buffer.from(`<svg width="342" height="54" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="340" height="52" rx="22" fill="#120b15" fill-opacity="0.82" stroke="#f0b948" stroke-width="2"/>
    <text x="171" y="35" text-anchor="middle" font-family="Georgia,serif" font-size="25" font-weight="700" fill="#ffe3a0">${safe}</text>
  </svg>`);
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
