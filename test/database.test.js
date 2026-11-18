import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';

test('allows multiple distinct nominations from the same member', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO cycles (guild_id, event_at, phase) VALUES ('guild', '2026-08-21T00:00:00Z', 'nominations')").run();
  const cycle = db.prepare('SELECT id FROM cycles').get();
  const insert = db.prepare('INSERT INTO nominations (cycle_id, title, user_id) VALUES (?, ?, ?)');
  insert.run(cycle.id, 'Alien', 'member');
  insert.run(cycle.id, 'Aliens', 'member');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM nominations').get().count, 2);
  assert.throws(() => insert.run(cycle.id, 'alien', 'someone-else'));
  db.close();
});

test('stores separate custom response types while defaulting legacy rows to pet', () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO marvin_responses (guild_id, text, created_by, created_at)
    VALUES ('guild', 'legacy response', 'admin', '2026-11-18T00:00:00Z')`).run();
  db.prepare(`INSERT INTO marvin_responses (guild_id, text, created_by, created_at, kind)
    VALUES ('guild', 'treat response', 'admin', '2026-11-18T00:00:00Z', 'treat')`).run();
  const rows = db.prepare('SELECT text, kind FROM marvin_responses ORDER BY id').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { text: 'legacy response', kind: 'pet' },
    { text: 'treat response', kind: 'treat' },
  ]);
  db.close();
});
