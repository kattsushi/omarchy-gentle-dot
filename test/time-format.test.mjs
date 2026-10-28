import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, timestampOf } from '../bridge/time-format.mjs';

const now = new Date(2026, 9, 27, 15, 30, 0).getTime();
const ago = ms => now - ms;
const MIN = 60 * 1000, HOUR = 60 * MIN;

test('relative timestamps: just now, minutes and hours within a day', () => {
  assert.equal(relativeTime(now, now), 'just now');
  assert.equal(relativeTime(ago(59 * 1000), now), 'just now');
  assert.equal(relativeTime(ago(MIN), now), '1 min ago');
  assert.equal(relativeTime(ago(5 * MIN + 30 * 1000), now), '5 min ago');
  assert.equal(relativeTime(ago(59 * MIN + 59 * 1000), now), '59 min ago');
  assert.equal(relativeTime(ago(HOUR), now), '1 h ago');
  assert.equal(relativeTime(ago(23 * HOUR + 59 * MIN), now), '23 h ago');
});

test('a day or older shows the date, with the year only for other years', () => {
  assert.equal(relativeTime(ago(24 * HOUR), now), 'Oct 26');
  assert.equal(relativeTime(new Date(2026, 0, 3, 9, 0).getTime(), now), 'Jan 3');
  assert.equal(relativeTime(new Date(2025, 9, 26, 9, 0).getTime(), now), 'Oct 26, 2025');
});

test('a clock slightly ahead counts as just now; no time means no label', () => {
  assert.equal(relativeTime(now + 30 * 1000, now), 'just now');
  assert.equal(relativeTime(0, now), '');
  assert.equal(relativeTime(undefined, now), '');
  assert.equal(relativeTime(NaN, now), '');
});

test('message times are accepted as milliseconds or ISO strings, anything else is no time', () => {
  assert.equal(timestampOf(1793137664830), 1793137664830);
  assert.equal(timestampOf('1793137664830'), 1793137664830);
  assert.equal(timestampOf('2026-10-27T15:30:00.000Z'), Date.parse('2026-10-27T15:30:00.000Z'));
  for (const bad of [undefined, null, '', 'yesterday', -5, 0, NaN, {}, true]) assert.equal(timestampOf(bad), 0, String(bad));
});
