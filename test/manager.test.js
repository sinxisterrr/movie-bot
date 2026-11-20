import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { ChannelType } from 'discord.js';
import { nextRecurringRun, parsePollAnswers, parseScheduledTime, resolveForumTags } from '../src/manager.js';
import { openDatabase } from '../src/database.js';
import { Manager } from '../src/manager.js';

test('parses a friendly date in the configured local timezone', () => {
  const now = DateTime.fromISO('2026-11-05T12:00:00', { zone: 'America/Regina' });
  const scheduled = parseScheduledTime('nov 6 2026 9am', 'America/Regina', now);
  assert.equal(scheduled.toISO(), '2026-11-06T09:00:00.000-06:00');
});

test('rejects past manager dates', () => {
  const now = DateTime.fromISO('2026-11-05T12:00:00', { zone: 'America/Regina' });
  assert.throws(() => parseScheduledTime('nov 4 2026 9am', 'America/Regina', now), /which is in the past/);
});

test('reports invalid command times instead of leaving the interaction unanswered', async () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO manager_config (guild_id, timezone) VALUES (?, ?)').run('guild', 'America/Regina');
  const manager = new Manager({}, db);
  let reply;
  const interaction = {
    inGuild: () => true,
    guildId: 'guild', user: { id: 'admin' }, commandName: 'manager', replied: false, deferred: false,
    memberPermissions: { has: () => true },
    options: {
      getSubcommand: () => 'announce', getChannel: () => ({ id: 'channel' }),
      getString: () => 'January 1 2020 9am', getRole: () => null,
    },
    reply: async (value) => { reply = value; },
  };
  await manager.handle(interaction);
  assert.match(reply.content, /which is in the past/);
  assert.equal(reply.ephemeral, true);
  db.close();
});

test('interprets relative dates from the configured timezone, not the host timezone', () => {
  const now = DateTime.fromISO('2026-11-05T23:30:00', { zone: 'America/Regina' });
  const scheduled = parseScheduledTime('tomorrow 9am', 'America/Regina', now);
  assert.equal(scheduled.toISO(), '2026-11-06T09:00:00.000-06:00');
});

test('calculates recurring calendar dates in the configured local timezone', () => {
  const base = {
    id: 9,
    run_at: '2027-01-31T15:00:00.000Z',
    recurrence_timezone: 'America/Regina',
    recurrence_anchor_day: 31,
    recurrence_anchor_month: 1,
  };
  const monthly = nextRecurringRun({ ...base, recurrence: 'monthly' }, DateTime.fromISO('2027-02-01T00:00:00Z'));
  assert.equal(monthly.toISO(), '2027-02-28T09:00:00.000-06:00');
  const march = nextRecurringRun({ ...base, recurrence: 'monthly' }, DateTime.fromISO('2027-03-01T00:00:00Z'));
  assert.equal(march.toISO(), '2027-03-31T09:00:00.000-06:00');

  const leap = nextRecurringRun({
    ...base,
    run_at: '2028-02-29T15:00:00.000Z',
    recurrence: 'annually',
    recurrence_anchor_day: 29,
    recurrence_anchor_month: 2,
  }, DateTime.fromISO('2028-03-01T00:00:00Z'));
  assert.equal(leap.toISO(), '2029-02-28T09:00:00.000-06:00');
});

test('parses decorated poll answers including custom emoji', () => {
  assert.deepEqual(parsePollAnswers('🍄 | Mushrooms\n<:marvin:123456789> | Marvin decides'), [
    { text: 'Mushrooms', emoji: { name: '🍄' } },
    { text: 'Marvin decides', emoji: { id: '123456789', name: 'marvin' } },
  ]);
});

test('requires between two and ten poll answers', () => {
  assert.throws(() => parsePollAnswers('Only one'), /between 2 and 10/);
});

test('matches forum tags case-insensitively and rejects missing tags', () => {
  const available = [{ id: 'one', name: 'Day One' }, { id: 'event', name: 'Event' }];
  assert.deepEqual(resolveForumTags(available, 'day one, EVENT'), available);
  assert.throws(() => resolveForumTags(available, 'Missing'), /does not exist/);
});

test('executes an announcement with exact Markdown and only the selected role mention', async () => {
  const db = openDatabase(':memory:');
  let sent;
  const channel = { isTextBased: () => true, send: async (payload) => { sent = payload; return { id: 'message-1' }; } };
  const manager = new Manager({ channels: { fetch: async () => channel } }, db);
  const body = '# 🌲 Week Two\n-# November 9–15\n> exact markdown';
  db.prepare(`INSERT INTO scheduled_jobs
    (guild_id, channel_id, creator_id, type, payload_json, role_id, run_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    'guild', 'channel', 'admin', 'announcement', JSON.stringify({ body }), 'role',
    '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
  );
  await manager.tick();
  assert.equal(sent.content, `<@&role>\n${body}`);
  assert.deepEqual(sent.allowedMentions, { parse: [], roles: ['role'], users: [] });
  assert.equal(db.prepare('SELECT status FROM scheduled_jobs').get().status, 'completed');
  db.close();
});

test('reschedules a recurring announcement instead of completing it', async () => {
  const db = openDatabase(':memory:');
  let sends = 0;
  const channel = { isTextBased: () => true, send: async () => { sends += 1; return { id: 'message-repeat' }; } };
  const manager = new Manager({ channels: { fetch: async () => channel } }, db);
  db.prepare(`INSERT INTO scheduled_jobs
    (guild_id, channel_id, creator_id, type, payload_json, run_at, status, created_at,
     recurrence, recurrence_timezone, recurrence_anchor_day, recurrence_anchor_month)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(
    'guild', 'channel', 'admin', 'announcement', JSON.stringify({ body: 'It is Friday, bureaucratically.' }),
    '2026-11-20T15:00:00.000Z', '2026-11-01T00:00:00.000Z', 'weekly', 'America/Regina', 20, 11,
  );
  await manager.tick();
  const job = db.prepare('SELECT status, recurrence, run_at FROM scheduled_jobs').get();
  assert.equal(sends, 1);
  assert.equal(job.status, 'pending');
  assert.equal(job.recurrence, 'weekly');
  assert.ok(DateTime.fromISO(job.run_at) > DateTime.utc());
  db.close();
});

test('creates a tagged forum post with its cached attachment and cleans the cache', async () => {
  const db = openDatabase(':memory:');
  const root = await mkdtemp(join(tmpdir(), 'marvin-manager-'));
  const jobDirectory = join(root, '1');
  await mkdir(jobDirectory, { recursive: true });
  const storagePath = join(jobDirectory, '1-cover.png');
  await writeFile(storagePath, Buffer.from('pretend image'));
  let created;
  const channel = {
    type: ChannelType.GuildForum,
    threads: { create: async (payload) => { created = payload; return { id: 'thread-1' }; } },
  };
  const manager = new Manager({ channels: { fetch: async () => channel } }, db);
  manager.filesRoot = root;
  const job = db.prepare(`INSERT INTO scheduled_jobs
    (guild_id, channel_id, creator_id, type, payload_json, role_id, run_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    'guild', 'forum', 'admin', 'forum', JSON.stringify({
      title: 'Day One', body: '# Welcome', tagIds: ['tag-1'], tagNames: ['Event'], attachmentNames: ['cover.png'],
    }), 'role', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
  );
  db.prepare(`INSERT INTO scheduled_job_files
    (job_id, filename, storage_path, content_type, size, description)
    VALUES (?, ?, ?, ?, ?, ?)`).run(job.lastInsertRowid, 'cover.png', storagePath, 'image/png', 13, 'Cover');
  await manager.tick();
  assert.equal(created.name, 'Day One');
  assert.deepEqual(created.appliedTags, ['tag-1']);
  assert.equal(created.message.content, '<@&role>\n# Welcome');
  assert.equal(created.message.files[0].name, 'cover.png');
  assert.equal(db.prepare('SELECT status FROM scheduled_jobs').get().status, 'completed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_job_files').get().count, 0);
  db.close();
});

test('keeps cached attachments for recurring forum posts', async () => {
  const db = openDatabase(':memory:');
  const root = await mkdtemp(join(tmpdir(), 'marvin-recurring-forum-'));
  const jobDirectory = join(root, '1');
  await mkdir(jobDirectory, { recursive: true });
  const storagePath = join(jobDirectory, '1-cover.png');
  await writeFile(storagePath, Buffer.from('reusable image'));
  const channel = {
    type: ChannelType.GuildForum,
    threads: { create: async () => ({ id: 'thread-repeat' }) },
  };
  const manager = new Manager({ channels: { fetch: async () => channel } }, db);
  manager.filesRoot = root;
  const job = db.prepare(`INSERT INTO scheduled_jobs
    (guild_id, channel_id, creator_id, type, payload_json, run_at, status, created_at,
     recurrence, recurrence_timezone, recurrence_anchor_day, recurrence_anchor_month)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(
    'guild', 'forum', 'admin', 'forum', JSON.stringify({
      title: 'Every Friday', body: '# Flat Fuck Friday', tagIds: [], tagNames: [], attachmentNames: ['cover.png'],
    }), '2026-11-20T15:00:00.000Z', '2026-11-01T00:00:00.000Z', 'weekly', 'America/Regina', 20, 11,
  );
  db.prepare(`INSERT INTO scheduled_job_files
    (job_id, filename, storage_path, content_type, size, description)
    VALUES (?, ?, ?, ?, ?, ?)`).run(job.lastInsertRowid, 'cover.png', storagePath, 'image/png', 14, 'Cover');
  await manager.tick();
  assert.equal(db.prepare('SELECT status FROM scheduled_jobs').get().status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_job_files').get().count, 1);
  db.close();
});
