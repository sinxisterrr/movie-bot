import { DateTime, IANAZone } from 'luxon';

export function validateSetup(timezone, time) {
  if (!IANAZone.isValidZone(timezone)) throw new Error('That timezone is not valid. Try something like `America/Regina`.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Time must use 24-hour `HH:mm` format, such as `20:00`.');
}

export function nextEventAt(config, now = DateTime.utc()) {
  const local = now.setZone(config.timezone);
  const [hour, minute] = config.event_time.split(':').map(Number);
  let candidate = local.startOf('day').set({ hour, minute }).plus({ days: (config.event_weekday - local.weekday + 7) % 7 });
  // Never create a new cycle too late to run its full nomination window.
  if (candidate <= local.plus({ days: 6 })) candidate = candidate.plus({ weeks: 1 });
  return candidate.toUTC();
}

// A deliberately calm weekly rhythm: nominations open 6 days before the event,
// voting opens 3 days before it, and closes 24 hours before it.
export function phaseFor(eventAt, now = DateTime.utc()) {
  const event = DateTime.fromISO(eventAt, { zone: 'utc' });
  if (now < event.minus({ days: 6 })) return 'pending';
  if (now < event.minus({ days: 3 })) return 'nominations';
  if (now < event.minus({ days: 1 })) return 'voting';
  if (now < event) return 'announced';
  return 'complete';
}
