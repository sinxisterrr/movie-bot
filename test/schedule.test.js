import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { nextEventAt, phaseFor, validateSetup } from '../src/schedule.js';

test('validates timezone and time', () => {
  assert.doesNotThrow(() => validateSetup('America/Regina', '20:00'));
  assert.throws(() => validateSetup('Middle/Earth', '20:00'));
  assert.throws(() => validateSetup('America/Regina', '8pm'));
});

test('calculates the next configured local watch party', () => {
  const config = { timezone: 'America/Regina', event_weekday: 6, event_time: '20:00' };
  const result = nextEventAt(config, DateTime.fromISO('2026-08-09T00:00:00Z'));
  assert.equal(result.toISO(), '2026-08-16T02:00:00.000Z');
});

test('advances through the weekly lifecycle at its boundaries', () => {
  const event = '2026-08-16T02:00:00.000Z';
  assert.equal(phaseFor(event, DateTime.fromISO('2026-08-09T02:00:00Z')), 'pending');
  assert.equal(phaseFor(event, DateTime.fromISO('2026-08-10T02:00:00Z')), 'nominations');
  assert.equal(phaseFor(event, DateTime.fromISO('2026-08-13T02:00:00Z')), 'voting');
  assert.equal(phaseFor(event, DateTime.fromISO('2026-08-15T02:00:00Z')), 'announced');
  assert.equal(phaseFor(event, DateTime.fromISO('2026-08-16T02:00:00Z')), 'complete');
});
