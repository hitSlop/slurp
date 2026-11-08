// The publication schedule is a pure function of stored facts, so it needs no Worker.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.ts'
import { type Facts, nextWake } from '../src/publisher.ts'

const cfg = parseConfig({ SEAL_INTERVAL_MS: '600000', ARCHIVE_MAX_BYTES: '1000', RETENTION_DAYS: '1' })
const noRetention = parseConfig({ SEAL_INTERVAL_MS: '600000', ARCHIVE_MAX_BYTES: '1000' })
const NOW = 1_000_000_000_000
const DAY = 86_400_000
const idle: Facts = { retryAt: null, hasIntent: false, bufferedBytes: 0, oldestChunkAt: null, oldestLiveAt: null }

const cases: { name: string; facts: Partial<Facts>; config?: typeof cfg; wake: number | null }[] = [
  { name: 'nothing stored: no alarm', facts: {}, wake: null },
  { name: 'an event waits one interval after it was committed', facts: { bufferedBytes: 10, oldestChunkAt: NOW - 1000 }, wake: NOW - 1000 + 600000 },
  { name: 'an interval already past is due', facts: { bufferedBytes: 10, oldestChunkAt: NOW - 700000 }, wake: NOW - 100000 },
  { name: 'a full archive is due at once', facts: { bufferedBytes: 1000, oldestChunkAt: NOW - 5 }, wake: NOW },
  { name: 'an unfinished publish (a stored intent) is due at once', facts: { hasIntent: true, bufferedBytes: 10, oldestChunkAt: NOW - 5 }, wake: NOW },
  { name: 'while publication is failing, the retry time rules', facts: { retryAt: NOW + 5000, hasIntent: true, bufferedBytes: 5000, oldestChunkAt: NOW - 5 }, wake: NOW + 5000 },
  { name: 'retention alone: the oldest live archive plus the window', facts: { oldestLiveAt: NOW - DAY / 2 }, wake: NOW + DAY / 2 },
  { name: 'retention is never sooner than a second from now', facts: { oldestLiveAt: NOW - 2 * DAY }, wake: NOW + 1000 },
  { name: 'retention off: archives never wake the object', facts: { oldestLiveAt: NOW - 100 * DAY }, config: noRetention, wake: null },
  { name: 'the earlier of publication and retention', facts: { bufferedBytes: 10, oldestChunkAt: NOW, oldestLiveAt: NOW - DAY + 60_000 }, wake: NOW + 60_000 },
  { name: 'retention keeps its time while publication fails', facts: { retryAt: NOW + DAY * 2, bufferedBytes: 10, oldestChunkAt: NOW - 5, oldestLiveAt: NOW - DAY / 2 }, wake: NOW + DAY / 2 },
]

for (const c of cases) test(`nextWake: ${c.name}`, () => {
  assert.equal(nextWake({ ...idle, ...c.facts }, c.config ?? cfg, NOW), c.wake)
})
