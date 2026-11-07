// Deterministic synthetic events for a fictional app ("Pixel", an export-heavy design tool). Used to build the sample
// reports shown on the website. Same seed, same events. Nothing here is real customer data.
//
//   node generate-events.mjs            # prints a summary
//   import { generate } from './generate-events.mjs'
const DAY = 86_400_000
export const END = Date.parse('2026-11-06T00:00:00Z')
export const RELEASES = [['v1.2.3', 0], ['v1.2.4', 30], ['v1.2.5', 60]] // [version, first day of the 90-day window]

function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const pick = (r, weights) => { let x = r() * weights.reduce((s, [, w]) => s + w, 0); for (const [v, w] of weights) { if ((x -= w) < 0) return v } return weights.at(-1)[0] }
const releaseAt = day => RELEASES.findLast(([, from]) => day >= from)[0]

// Share of validated exports that fail, by release and file size. v1.2.4 introduced a memory regression for big video
// exports; v1.2.5 fixed most of it.
const FAIL = {
  'v1.2.3': { small: 0.025, large: 0.10 },
  'v1.2.4': { small: 0.13, large: 0.9 },
  'v1.2.5': { small: 0.03, large: 0.30 },
}
const RETURN = [1, 0.46, 0.34, 0.27, 0.23, 0.2, 0.18, 0.16, 0.15, 0.14, 0.13, 0.12, 0.11] // weekly return probability

export function generate({ days = 90, seed = 7 } = {}) {
  const r = rng(seed)
  const start = END - days * DAY
  const events = []
  let n = 0
  const id = () => `evt_${(++n).toString(36).padStart(6, '0')}`
  const emit = (ts, event, user, session, version, data) => events.push({
    id: id(), type: 'track', event, timestamp: new Date(ts).toISOString(), user_id: user, session_id: session,
    data, context: { app: { name: 'Pixel', version }, library: { name: '@hitslop/slurp-sdk', version: '0.1.0' } },
  })
  const hourWeights = Array.from({ length: 24 }, (_, h) => [h, 0.15 + Math.max(0, Math.sin(((h - 7) / 17) * Math.PI)) ** 1.6])
  const at = (dayStart, jitter = 0) => dayStart + pick(r, hourWeights) * 3_600_000 + Math.floor(r() * 3_600_000) + jitter
  let user = 0
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY
    const weekday = new Date(dayStart).getUTCDay()
    const signups = Math.round((28 + 1.15 * d + gauss(r) * 4) * (weekday === 0 || weekday === 6 ? 0.7 : 1.05))
    for (let s = 0; s < signups; s++) {
      const uid = `u_${(++user).toString(36).padStart(5, '0')}`
      const pro = r() < 0.16
      const plan = pro ? 'pro' : 'free'
      const t0 = at(dayStart)
      emit(t0, 'signed_up', uid, `s_${uid}_0`, releaseAt(d), { plan, source: pick(r, [['organic', 5], ['referral', 2], ['ads', 2], ['social', 1]]) })
      for (let w = 0; w < RETURN.length; w++) {
        if (w > 0 && r() > RETURN[w] * (pro ? 1.25 : 1)) continue
        const weekStart = dayStart + w * 7 * DAY
        if (weekStart + 3_600_000 > END) break
        const sessions = 1 + Math.floor(r() * (w === 0 ? 2 : 3))
        for (let k = 0; k < sessions; k++) {
          const day = Math.min(6, Math.floor(r() * 7))
          let ts = w === 0 && k === 0 ? t0 + 120_000 : at(weekStart + day * DAY)
          if (ts >= END) continue
          const dayIndex = Math.floor((ts - start) / DAY)
          const version = releaseAt(dayIndex)
          const session = `s_${uid}_${w}_${k}`
          if (r() < (w === 0 && k === 0 ? 0.8 : 0.12)) { emit(ts, 'project_created', uid, session, version, { template: pick(r, [['blank', 4], ['social', 3], ['deck', 2]]) }); ts += 20_000 + r() * 90_000 }
          const attempts = pro ? 1 + Math.floor(r() * 3) : r() < 0.7 ? 1 : 2
          for (let a = 0; a < attempts; a++) {
            const format = pick(r, [['pdf', 45], ['png', 33], ['mp4', 22]])
            const size = Math.min(4000, Math.max(0.2, Math.exp({ pdf: Math.log(6) + gauss(r) * 1.0, png: Math.log(12) + gauss(r) * 0.9, mp4: Math.log(380) + gauss(r) * 0.85 }[format])))
            const file_size_mb = Math.round(size * 10) / 10
            const base = { format, file_size_mb, plan }
            if (ts >= END) break
            emit(ts, 'export_opened', uid, session, version, base)
            if (r() > 0.78) { ts += 60_000 + r() * 240_000; continue }
            ts += 5_000 + r() * 35_000; emit(ts, 'export_started', uid, session, version, base)
            ts += 2_000 + r() * 5_000
            if (r() > 0.975) { emit(ts, 'export_failed', uid, session, version, { ...base, stage: 'validation', duration_s: 3 }); ts += 90_000; continue }
            emit(ts, 'export_validated', uid, session, version, base)
            const duration = Math.max(4, Math.round(6 + size * (format === 'mp4' ? 0.11 : 0.9) * (0.6 + r() * 0.8)))
            const large = file_size_mb > 500
            if (r() < FAIL[version][large ? 'large' : 'small']) {
              emit(ts + duration * 1000 * (large ? 0.6 : 1), 'export_failed', uid, session, version, { ...base, stage: 'render', error: large ? 'out_of_memory' : pick(r, [['timeout', 3], ['codec_error', 2], ['network', 1]]), duration_s: Math.round(duration * (large ? 0.6 : 1)) })
            } else {
              emit(ts + duration * 1000, 'export_completed', uid, session, version, { ...base, duration_s: duration })
            }
            ts += duration * 1000 + 30_000 + r() * 120_000
          }
        }
      }
    }
  }
  return events.filter(e => Date.parse(e.timestamp) < END).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ev = generate()
  const count = (f) => ev.filter(f).length
  console.log('events', ev.length, 'users', new Set(ev.map(e => e.user_id)).size)
  for (const name of ['signed_up', 'project_created', 'export_opened', 'export_started', 'export_validated', 'export_completed', 'export_failed']) console.log(name.padEnd(18), count(e => e.event === name))
  for (const [v] of RELEASES) {
    const started = count(e => e.event === 'export_started' && e.context.app.version === v)
    const done = count(e => e.event === 'export_completed' && e.context.app.version === v)
    const big = ev.filter(e => e.event === 'export_validated' && e.context.app.version === v && e.data.file_size_mb > 500)
    const bigDone = count(e => e.event === 'export_completed' && e.context.app.version === v && e.data.file_size_mb > 500)
    console.log(v, 'started', started, 'completion', (100 * done / started).toFixed(1) + '%', '| >500MB validated', big.length, 'completed', (100 * bigDone / big.length).toFixed(0) + '%')
  }
  console.log('bytes (ndjson)', ev.reduce((s, e) => s + JSON.stringify(e).length + 1, 0))
}
