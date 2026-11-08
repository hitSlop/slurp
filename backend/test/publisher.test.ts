// The publication schedule is a pure function of stored facts, so it needs no Worker.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.ts'
import { type Facts, Publisher, nextWake } from '../src/publisher.ts'

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
  { name: 'an overdue deletion while R2 is failing waits for the retry time', facts: { retryAt: NOW + 5000, oldestLiveAt: NOW - 2 * DAY }, wake: NOW + 5000 },
  { name: 'retention keeps its time while publication fails', facts: { retryAt: NOW + DAY * 2, bufferedBytes: 10, oldestChunkAt: NOW - 5, oldestLiveAt: NOW - DAY / 2 }, wake: NOW + DAY / 2 },
]

for (const c of cases) test(`nextWake: ${c.name}`, () => {
  assert.equal(nextWake({ ...idle, ...c.facts }, c.config ?? cfg, NOW), c.wake)
})

// A failed alarm write must not leave the cache claiming an alarm that does not exist: the next rearm would skip the write.
test('rearm: the armed cache changes only after the write succeeded', async () => {
  const calls: string[] = []
  let failing = true
  const storage = {
    setAlarm: async (t: number) => { calls.push(`set ${t}`); if (failing) throw new Error('storage unavailable') },
    deleteAlarm: async () => { calls.push('delete'); if (failing) throw new Error('storage unavailable') },
  }
  let buffered = true
  const db = {
    alarmWrites: 0,
    one: (sql: string) => (sql.includes('FROM chunks ORDER BY id') && buffered ? { t: Date.now() } : undefined),
    rows: () => [],
  }
  const publisher = new Publisher({ storage } as any, {} as any, db as any, cfg, 'prj_0')

  await assert.rejects(publisher.rearm(), /storage unavailable/)
  assert.equal(publisher.armed, null, 'a failed setAlarm leaves the cache unchanged')
  assert.equal(db.alarmWrites, 0)
  failing = false
  await publisher.rearm()
  assert.equal(calls.length, 2, 'the next call writes again instead of trusting the cache')
  assert.notEqual(publisher.armed, null)
  assert.equal(db.alarmWrites, 1)

  // and the same for clearing: nothing is waiting any more, the delete fails, and the cache still says an alarm is armed
  buffered = false; failing = true
  const armed = publisher.armed
  await assert.rejects(publisher.rearm(), /storage unavailable/)
  assert.equal(publisher.armed, armed, 'a failed deleteAlarm leaves the cache unchanged')
})
