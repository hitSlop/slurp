import { test } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { assert } from './helpers.ts'

const DEFAULTS = { sealIntervalMs: 600000, archiveMaxBytes: 8388608, groupCommitMs: 500, bufferCapBytes: 67108864, maxBodyBytes: 10485760, retentionDays: 0, archiveRetryMs: 5000, geo: true }

test('an unset environment is the defaults, without a warning', () => {
  const warned: string[] = []
  assert.deepEqual(parseConfig({}, n => warned.push(n)), DEFAULTS)
  assert.deepEqual(warned, [])
})

test('numbers parse, fractions are allowed where meaningful, and GEO is on or off', () => {
  const c = parseConfig({ SEAL_INTERVAL_MS: '1500', ARCHIVE_MAX_BYTES: '4096', GROUP_COMMIT_MS: '0', BUFFER_CAP_BYTES: '3000', MAX_BODY_BYTES: '4096', RETENTION_DAYS: '0.00002', ARCHIVE_RETRY_MS: '100', GEO: 'off' })
  assert.deepEqual(c, { sealIntervalMs: 1500, archiveMaxBytes: 4096, groupCommitMs: 0, bufferCapBytes: 3000, maxBodyBytes: 4096, retentionDays: 0.00002, archiveRetryMs: 100, geo: false })
})

test('empty, non-numeric, non-finite and below-minimum values fall back to the default, with a warning each', () => {
  const warned: string[] = []
  const bad = { SEAL_INTERVAL_MS: '', ARCHIVE_MAX_BYTES: 'lots', GROUP_COMMIT_MS: '-1', BUFFER_CAP_BYTES: '0', MAX_BODY_BYTES: 'Infinity', RETENTION_DAYS: '-0.5', ARCHIVE_RETRY_MS: '0', GEO: 'maybe' }
  assert.deepEqual(parseConfig(bad, n => warned.push(n)), DEFAULTS)
  assert.deepEqual(warned.sort(), Object.keys(bad).sort())
})
