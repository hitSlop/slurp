import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkBody, normalizeGeo, scan, spliceGeo, stampLines, validateRecord } from '../src/canonical.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(readFileSync(join(here, '../fixtures/canonical', `${name}.json`), 'utf8'))
const enc = new TextEncoder()

test('record vectors (ported from the Go canonical tests)', () => {
  for (const r of fixture('records').records) {
    const bytes = r.line_b64 !== undefined ? Buffer.from(r.line_b64, 'base64') : enc.encode(r.line)
    const res = checkBody(bytes, null)
    assert.equal('lines' in res, r.valid, `${r.name}: ${JSON.stringify(res)}`)
  }
})

test('a record is accepted whole up to exactly 1 MiB and refused above it', () => {
  const frame = '{"id":"one","type":"track","event":"e","timestamp":"2026-11-03T00:00:00Z","data":{"t":""}}'
  const make = (bytes: number) => frame.replace('"t":""', `"t":"${'x'.repeat(bytes - frame.length)}"`)
  assert.equal(enc.encode(make(1024 * 1024)).length, 1024 * 1024)
  assert.ok('lines' in checkBody(enc.encode(make(1024 * 1024)), null), 'exactly 1 MiB')
  const over = checkBody(enc.encode(make(1024 * 1024 + 1)), null)
  assert.ok('reason' in over && /exceeds 1 MiB/.test(over.reason))
})

test('nesting boundary matches the Go gateway (root -> data -> values nested d arrays)', () => {
  const n = fixture('nesting')
  for (const d of n.tried) {
    const line = n.template.replace(n.placeholder, `"values":${'['.repeat(d)}0${']'.repeat(d)}`)
    assert.equal('lines' in checkBody(enc.encode(line), null), d <= n.maxValidDepth, `depth ${d}`)
  }
})

test('stamping keeps client bytes verbatim', () => {
  for (const c of fixture('stamp').cases) {
    const out = stampLines([c.line.trimStart() === c.line ? c.line : c.line], c.batchId, c.at)
    assert.ok(out.startsWith(c.mustStartWith), out)
    for (const s of c.mustContain) assert.ok(out.includes(s), `${c.name}: ${out}`)
    assert.ok(out.endsWith('\n'))
    JSON.parse(out.trim().replace(/9007199254740993123456789|1e1000/g, '1'))
  }
})

test('whole-batch validation is all or nothing and names the line', () => {
  for (const c of fixture('batch').cases) {
    const res = checkBody(enc.encode(c.body), null)
    assert.equal('lines' in res, c.ok, c.name)
    if ('lines' in res) assert.equal(res.lines.length, c.lines, c.name)
    else assert.equal(res.line, c.line, c.name)
  }
})

test('body bytes that are not UTF-8 are rejected (a text decode would silently repair them)', () => {
  const ok = enc.encode('{"id":"a","type":"track","event":"e","timestamp":"2026-11-03T00:00:00Z","data":{"t":"x"}}')
  const bad = new Uint8Array([...ok.slice(0, 80), 0xff, ...ok.slice(81)])
  const res = checkBody(bad, null)
  assert.ok('reason' in res)
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...ok])
  assert.ok('reason' in checkBody(bom, null), 'BOM is not JSON')
})

test('geo normalization', () => {
  for (const c of fixture('geo').normalize) assert.deepEqual(normalizeGeo(c.cf), c.geo, c.name)
})

test('geo splice changes only the context', () => {
  for (const c of fixture('geo').splice) {
    const v = validateRecord(c.line)
    assert.ok('scanned' in v, c.name)
    assert.equal(spliceGeo(c.line, v.scanned, c.geo), c.expected, c.name)
    // The enriched record is valid JSON, and a client sending it back would be refused: context.geo is reserved.
    JSON.parse(c.expected.replace(/9007199254740993123456789/g, '1'))
    const again = checkBody(enc.encode(c.expected), null)
    assert.ok('reason' in again && /context\.geo is reserved/.test(again.reason), c.name)
  }
  const bigGeo = checkBody(enc.encode('{"id":"a","type":"track","event":"e","timestamp":"2026-11-03T00:00:00Z","data":{"n":9007199254740993123456789}}'), { country: 'CA' })
  assert.ok('lines' in bigGeo)
  assert.ok((bigGeo as any).lines[0].includes('9007199254740993123456789'), 'wide number survives enrichment')
  assert.ok((bigGeo as any).lines[0].includes('"context":{"geo":{"country":"CA"}}'))
})

// Differential fuzz against JSON.parse. Our scanner is stricter (duplicate names, lone surrogates, depth), never looser.
test('scanner is sound against JSON.parse under mutation fuzzing', () => {
  const seeds = [
    '{"id":"a","type":"track","event":"e","timestamp":"2026-11-03T00:00:00Z","data":{"a":[1,2,{"b":null}],"s":"x\\n\\u00e9\\ud83d\\ude00","n":-1.5e+3}}',
    '{"x":{"y":{"z":[true,false,null,"s",0,-0,1e5]}},"k":"v"}',
    '{ "a" : 1 , "b" : [ ] , "c" : { } }',
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
    let ours: ReturnType<typeof scan> | null = null
    let reason = ''
    try { ours = scan(s) } catch (e: any) { reason = e.message }
    let theirs: unknown
    let theirsOk = true
    try { theirs = JSON.parse(s) } catch { theirsOk = false }
    if (ours) {
      accepted++
      assert.ok(theirsOk, `scanner accepted what JSON.parse rejects: ${JSON.stringify(s)}`)
      assert.ok(theirs !== null && typeof theirs === 'object' && !Array.isArray(theirs))
      // Splice invariant: geo goes in, every other member is untouched.
      const g = spliceGeo(s, ours, { country: 'CA' })
      const back = JSON.parse(g) as any
      assert.deepEqual(back.context.geo, { country: 'CA' })
      const before = JSON.parse(s) as any
      if (before.context && typeof before.context === 'object') { delete back.context.geo; assert.deepEqual(back, before) }
      else { delete back.context; assert.deepEqual(back, before) }
    } else if (theirsOk && theirs !== null && typeof theirs === 'object' && !Array.isArray(theirs)) {
      assert.match(reason, /duplicate name|invalid surrogate|nesting too deep/, `scanner rejected valid JSON for the wrong reason: ${JSON.stringify(s)} (${reason})`)
    }
  }
  assert.ok(accepted > 500, `fuzz accepted only ${accepted} cases`)
})
