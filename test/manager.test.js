import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parsePollAnswers, parseScheduledTime } from '../src/manager.js';
import { openDatabase } from '../src/database.js';
import { Manager } from '../src/manager.js';

test('parses a friendly date in the configured local timezone', () => {
  const now = DateTime.fromISO('2026-11-05T12:00:00', { zone: 'America/Regina' });
  const scheduled = parseScheduledTime('nov 6 2026 9am', 'America/Regina', now);
  assert.equal(scheduled.toISO(), '2026-11-06T09:00:00.000-06:00');
});

test('rejects past manager dates', () => {
  const now = DateTime.fromISO('2026-11-05T12:00:00', { zone: 'America/Regina' });
  assert.throws(() => parseScheduledTime('nov 4 2026 9am', 'America/Regina', now), /past/);
});

test('interprets relative dates from the configured timezone, not the host timezone', () => {
  const now = DateTime.fromISO('2026-11-05T23:30:00', { zone: 'America/Regina' });
  const scheduled = parseScheduledTime('tomorrow 9am', 'America/Regina', now);
  assert.equal(scheduled.toISO(), '2026-11-06T09:00:00.000-06:00');
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
