import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { memoryStorage } from '../src/index.ts'
import type { FlushResult, SlurpClient, SlurpOptions, StorageAdapter } from '../src/index.ts'

/** What differs between the packages that run the shared scenarios: how a client is made, and what wraps its storage. */
export interface Harness {
  name: string
  create(options: SlurpOptions): SlurpClient
  /** The storage the client gets, built on `base` (the React Native package wraps it in chunkedStorage). */
  storage?(base: StorageAdapter): StorageAdapter
}

// The scenarios every SDK runs: sdks/conformance/delivery.json (its `description` documents the format, README.md the state machine).
const suite = JSON.parse(readFileSync(new URL('../../conformance/delivery.json', import.meta.url), 'utf8'))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const key = `slurp_pk_0123456789abcdef_web_${'a1'.repeat(24)}`
const later = <T>(ms: number, value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), ms))

export function runConformance(harness: Harness): void {
  for (const scenario of suite.scenarios) {
    test(`conformance (${harness.name}): ${scenario.name}`, async () => {
      const script: { status: number; retryAfter?: string; retryAfterDateSeconds?: number; rejected?: number[]; track?: string[] }[] = [...scenario.responses]
      const requests: { lines: string[]; at: number; key: string }[] = []
      const errors: { message: string; dropped: number }[] = []
      const pad = scenario.padBytes ? { pad: 'x'.repeat(scenario.padBytes) } : {}
      let client!: SlurpClient

      const memory = memoryStorage()
      const base: StorageAdapter = {
        getItem: name => scenario.storage?.delayMs ? later(scenario.storage.delayMs, () => memory.getItem(name) as string | null) : memory.getItem(name),
        setItem: (name, value) => {
          if (scenario.storage?.setItem === 'throws') throw new Error('storage unavailable')
          return scenario.storage?.delayMs ? later(scenario.storage.delayMs, () => memory.setItem(name, value) as void) : memory.setItem(name, value)
        },
        removeItem: name => memory.removeItem(name),
      }
      const storage = harness.storage ? harness.storage(base) : base
      const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
        requests.push({ lines: init.body.trimEnd().split('\n'), at: Date.now(), key: init.headers.Authorization.replace('Bearer ', '') })
        const next = script.shift() ?? { status: 200 }
        for (const name of next.track ?? []) client.track(name, pad)
        if (next.status === 0) throw new TypeError('network error')
        const headers: Record<string, string> = {}
        if (next.retryAfter !== undefined) headers['Retry-After'] = next.retryAfter
        if (next.retryAfterDateSeconds !== undefined) headers['Retry-After'] = new Date(Date.now() + next.retryAfterDateSeconds * 1000).toUTCString()
        const body = next.rejected ? JSON.stringify({ error: 'invalid records', rejected: next.rejected.map(line => ({ line, reason: 'bad record' })) }) : ''
        return new Response(next.status === 204 ? null : body, { status: next.status, headers })
      }) as any
      const make = (withKey = key) => harness.create({
        key: withKey, endpoint: 'https://worker.example/v1/events', flushIntervalMs: 3_600_000, storage, fetch,
        onError: (error, dropped) => { errors.push({ message: error.message, dropped }) }, ...scenario.options,
      })
      /** Flush, and flush again after each retry delay, until nothing is pending or the client has stopped. */
      const settle = async (): Promise<FlushResult> => {
        let result = await client.flush()
        for (let i = 0; i < 8 && result.pending > 0 && !result.stopped; i++) {
          await wait(Math.max(0, (result.retryAt ?? Date.now()) - Date.now()) + 30)
          result = await client.flush()
        }
        return result
      }
      const check = (result: FlushResult, expected: Record<string, unknown>) => {
        for (const field of ['accepted', 'rejected', 'stopped', 'pending']) {
          if (field in expected) assert.equal((result as any)[field], expected[field], field)
        }
      }

      client = make()
      const steps: Record<string, any>[] = scenario.steps ?? [{ track: scenario.events }, { flush: true }]
      for (const step of steps) {
        let result: FlushResult | undefined
        if (step.track) for (const name of step.track) client.track(name, pad)
        else if (step.flush) result = await settle()
        else if (step.flushOnce) result = await client.flush()
        else if (step.sleep !== undefined) await wait(step.sleep)
        else if (step.restart) { await client.close(); client = make(step.restart.key) }
        else if (step.replace) { void client.close(); client = make() }
        else assert.fail(`unknown step ${JSON.stringify(step)}`)
        if (step.expect) { assert.ok(result, 'expect belongs on a flush step'); check(result, step.expect) }
      }
      const result = await settle()

      const expected = scenario.expect
      const names = requests.map(request => request.lines.map(line => JSON.parse(line).event))
      assert.deepEqual(names, expected.requests, 'requests')
      check(result, expected)
      if (expected.keys) assert.deepEqual(requests.map(request => request.key), expected.keys, 'keys')
      if (expected.sameRecords) {
        const seen = new Map<string, string>()
        for (const { lines } of requests) for (const line of lines) {
          const id = JSON.parse(line).id
          assert.equal(seen.get(id) ?? line, line, `record ${id} is resent with the same bytes`)
          seen.set(id, line)
        }
      }
      if (expected.minRetryGapMs !== undefined) assert.ok(requests[1].at - requests[0].at >= expected.minRetryGapMs, `retry after ${requests[1].at - requests[0].at} ms`)
      if (expected.errorsAtLeast !== undefined) assert.ok(errors.length >= expected.errorsAtLeast, `reported ${errors.length} errors`)
      await client.close()
    })
  }
}
