import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { openDatabase } from '../src/database.js';
import { deterministicAngle, Passport, tierForCount } from '../src/passport.js';

test('maps permanent stamp counts across all five passport volumes', () => {
  assert.deepEqual(tierForCount(0), { volume: 1, tier: 'Citizen' });
  assert.deepEqual(tierForCount(12), { volume: 1, tier: 'Citizen' });
  assert.deepEqual(tierForCount(13), { volume: 2, tier: 'Resident' });
  assert.deepEqual(tierForCount(25), { volume: 3, tier: 'Veteran' });
  assert.deepEqual(tierForCount(37), { volume: 4, tier: 'Luminary' });
  assert.deepEqual(tierForCount(49), { volume: 5, tier: 'Legend' });
  assert.deepEqual(tierForCount(60), { volume: 5, tier: 'Legend' });
});

test('uses stable stamp rotations contained within the requested range', () => {
  const first = deterministicAngle('member', 42);
  assert.equal(first, deterministicAngle('member', 42));
  assert.ok(first >= -45 && first <= 45);
});

test('awards each event once and queues milestone notice when DMs are closed', async () => {
  const db = openDatabase(':memory:');
  const passport = new Passport({}, db);
  const member = { id: 'member', guild: { id: 'guild' }, send: async () => { throw new Error('closed'); } };
  for (let id = 1; id <= 3; id += 1) {
    db.prepare(`INSERT INTO passport_events
      (id, guild_id, role_id, name, stamp_path, active, created_by, created_at)
      VALUES (?, 'guild', ?, ?, 'stamp.png', 1, 'admin', '2026-01-01')`).run(id, `role-${id}`, `Event ${id}`);
    assert.equal((await passport.award(member, passport.eventById(id))).awarded, true);
  }
  assert.equal((await passport.award(member, passport.eventById(3))).awarded, false);
  assert.equal(passport.count('guild', 'member'), 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM passport_pending_notices').get().total, 1);
  assert.equal(db.prepare('SELECT threshold FROM passport_milestones').get().threshold, 3);
});

test('renders a private passport PNG at the template dimensions', async () => {
  const db = openDatabase(':memory:');
  const passport = new Passport({}, db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#8040c0"/></svg>`));
  try {
    const member = { id: 'member', displayName: 'Test Citizen', displayAvatarURL: () => 'https://avatar.invalid/test.png' };
    const output = await passport.render(member, [], 1);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 1536);
    assert.equal(metadata.height, 1024);
    assert.equal(metadata.format, 'png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
