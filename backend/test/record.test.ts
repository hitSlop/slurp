import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { MAX_REJECTED, checkBody, envelope, normalizeGeo, recordError } from '../src/record.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(readFileSync(join(here, '../fixtures/canonical', `${name}.json`), 'utf8'))
const enc = new TextEncoder()

test('record vectors', () => {
  for (const r of fixture('records').records) {
    const bytes = r.line_b64 !== undefined ? Buffer.from(r.line_b64, 'base64') : enc.encode(r.line)
    const res = checkBody(bytes)
    assert.equal('lines' in res && res.lines.length === 1, r.valid, `${r.name}: ${JSON.stringify(res)}`)
  }
})

test('a record is accepted whole up to exactly 1 MiB and refused above it', () => {
  const frame = '{"event":"e","data":{"t":""}}'
  const make = (bytes: number) => frame.replace('"t":""', `"t":"${'x'.repeat(bytes - frame.length)}"`)
  assert.equal(enc.encode(make(1024 * 1024)).length, 1024 * 1024)
  assert.equal(recordError(make(1024 * 1024)), null, 'exactly 1 MiB')
  assert.match(recordError(make(1024 * 1024 + 1))!, /exceeds 1 MiB/)
  // multi-byte text counts in bytes, not characters
  assert.match(recordError(`{"event":"e","data":{"t":"${'雪'.repeat(400_000)}"}}`)!, /exceeds 1 MiB/)
})

test('nesting boundary (root -> data -> values nested d arrays)', () => {
  const n = fixture('nesting')
  for (const d of n.tried) {
    const line = n.template.replace(n.placeholder, `"values":${'['.repeat(d)}0${']'.repeat(d)}`)
    assert.equal(recordError(line) === null, d <= n.maxValidDepth, `depth ${d}`)
  }
})

test('a body is validated whole, blank lines are skipped but counted, and every bad line is listed', () => {
  for (const c of fixture('batch').cases) {
    const res = checkBody(enc.encode(c.body))
    assert.equal('lines' in res, c.ok, c.name)
    if ('lines' in res) assert.equal(res.lines.length, c.lines, c.name)
    else assert.deepEqual(res.rejected.map(b => b.line), c.rejected, c.name)
  }
  const many = checkBody(enc.encode('{}\n'.repeat(250)))
  assert.ok('rejected' in many && many.rejected.length === MAX_REJECTED, 'the list is capped at 100')
})

test('lines are stored trimmed, exactly as sent', () => {
  const res = checkBody(enc.encode('  {"event":"a","n":1.2300}\r\n\t{"event":"b"}  \n'))
  assert.deepEqual('lines' in res && res.lines, ['{"event":"a","n":1.2300}', '{"event":"b"}'])
})

test('body bytes that are not UTF-8 are rejected (a text decode would silently repair them)', () => {
  const ok = enc.encode('{"event":"e","data":{"t":"x"}}')
  const bad = new Uint8Array([...ok.slice(0, 22), 0xff, ...ok.slice(23)])
  const res = checkBody(bad)
  assert.ok('rejected' in res && /UTF-8/.test(res.rejected[0].reason))
  assert.ok('rejected' in checkBody(new Uint8Array([0xef, 0xbb, 0xbf, ...ok])), 'a BOM is not JSON')
})

test('envelopes keep the record byte for byte, and put it last', () => {
  for (const c of fixture('envelope').cases)
    assert.equal(envelope(c.receivedAtMs, c.sender, c.geo ? JSON.stringify(c.geo) : null, c.line), c.expected, c.name)
})

test('an envelope is always exactly one line, however the record was spaced', () => {
  const pretty = readFileSync(join(here, '../fixtures/webhooks/github-release-pretty.json'), 'utf8')
  const crlf = '{\r\n  "event": "a",\r\n  "n": 12345678901234567890,\r\n  "s": "keeps \\n and \\r escapes"\r\n}'
  for (const record of [pretty.trim(), crlf, '{"event":"a"}']) {
    for (const geoJson of [null, '{"country":"NZ"}']) {
      const line = envelope(1_700_000_000_000, 'github', geoJson, record)
      assert.equal(line.indexOf('\n'), line.length - 1, 'one newline, at the end')
      assert.ok(!line.slice(0, -1).includes('\r'))
      assert.deepEqual(JSON.parse(line).record, JSON.parse(record), 'the same record')
    }
  }
  const line = envelope(0, 's', null, crlf)
  assert.ok(line.includes('"n": 12345678901234567890,'), 'numbers are untouched')
  assert.ok(line.includes('keeps \\n and \\r escapes'), 'escapes inside strings are untouched')
})

test('geo normalization', () => {
  for (const c of fixture('geo').normalize) assert.deepEqual(normalizeGeo(c.cf), c.geo, c.name)
})

// Differential fuzz against JSON.parse. The validator may be stricter (fields, lone surrogates, depth), never looser.
test('the validator never accepts what JSON.parse rejects, and rejects only for a reason', () => {
  const seeds = [
    '{"id":"a","type":"track","event":"e","timestamp":"2026-11-03T00:00:00Z","data":{"a":[1,2,{"b":null}],"s":"x\\n\\u00e9\\ud83d\\ude00","n":-1.5e+3}}',
    '{"event":"x","k":{"y":{"z":[true,false,null,"s",0,-0,1e5]}}}',
    '{ "event" : "x" , "b" : [ ] , "c" : { } }',
  ]
  const alphabet = ['{', '}', '[', ']', ',', ':', '"', '\\', 'u', '0', '-', 'e', ' ', 'n', 't', '\n', 'd', '8']
  let seed = 0x2545f491
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  let accepted = 0
  for (let i = 0; i < 40_000; i++) {
    let s = seeds[rnd(seeds.length)]
    for (let m = rnd(3) + 1; m > 0; m--) {
      const at = rnd(s.length + 1)
      const op = rnd(3)
      if (op === 0) s = s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at)
      else if (op === 1) s = s.slice(0, at) + s.slice(at + 1)
      else s = s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at + 1)
    }
    const reason = recordError(s)
    let parsed: unknown, ok = true
    try { parsed = JSON.parse(s) } catch { ok = false }
    if (reason === null) {
      accepted++
      assert.ok(ok && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `accepted what JSON.parse rejects: ${JSON.stringify(s)}`)
    } else if (!ok) assert.equal(reason, 'not valid JSON', JSON.stringify(s))
  }
  assert.ok(accepted > 500, `fuzz accepted only ${accepted} cases`)
})
