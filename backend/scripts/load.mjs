// Drive a deployed Worker at a fixed request rate and report latency, errors and archive size.
//
//   SLURP_TOKEN=<admin token> node scripts/load.mjs https://slurp-x.you.workers.dev --steps 50,100,200 --seconds 30
//
// Open loop: requests are issued on a schedule whether or not earlier ones finished, so a slow server shows up as latency
// and errors instead of quietly lowering the rate. Each request is one ingest batch (JSON lines). Use a throwaway Worker.
import http from 'node:http'
import https from 'node:https'
import { randomBytes, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    steps: { type: 'string', default: '50,100,200' },     // requests per second, one step each
    seconds: { type: 'string', default: '30' },            // length of each step
    events: { type: 'string', default: '20' },             // events per request
    project: { type: 'string', default: '' },              // an existing project name; default creates one
    'wait-seal': { type: 'string', default: '0' },         // seconds to wait for the final seal before reading archive sizes
  },
})
const base = (positionals[0] ?? '').replace(/\/$/, '')
const admin = process.env.SLURP_TOKEN
if (!base || !admin) { console.error('usage: SLURP_TOKEN=... node load.mjs <worker url> [--steps 50,100] [--seconds 30]'); process.exit(2) }
const url = new URL(base)
// A local `wrangler dev` Worker is plain http; a deployed one is https.
const transport = url.protocol === 'http:' ? http : https
const agent = new transport.Agent({ keepAlive: true, maxSockets: 512 })

const request = (path, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve) => {
  const started = performance.now()
  const req = transport.request({ agent, hostname: url.hostname, port: url.port || undefined, path, method, headers: { ...headers, 'content-length': body ? Buffer.byteLength(body) : 0 } }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - started, text: Buffer.concat(chunks).toString() }))
  })
  req.on('error', (e) => resolve({ status: 0, ms: performance.now() - started, text: String(e) }))
  req.setTimeout(30000, () => req.destroy(new Error('timeout')))
  req.end(body)
})
const rpc = async (service, method, body) => JSON.parse((await request(`/rpc/${service}/${method}`, { headers: { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).text)

// Varied, realistic product events (about 0.5 KB as JSON); random ids and values keep gzip honest.
const names = ['page_viewed', 'button_clicked', 'export_started', 'export_completed', 'signed_up', 'project_created', 'error_shown']
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const event = () => JSON.stringify({
  id: randomUUID(), type: 'track', event: pick(names), timestamp: new Date().toISOString(), user_id: 'u_' + randomBytes(5).toString('hex'),
  anonymous_id: randomBytes(8).toString('hex'), session_id: randomBytes(6).toString('hex'),
  context: { app: { version: pick(['1.2.3', '1.2.4', '1.2.5']) }, locale: pick(['en-US', 'de-DE', 'fr-FR', 'ja-JP']), page: { path: '/app/' + randomBytes(3).toString('hex'), referrer: pick(['', 'https://google.com/', 'https://news.ycombinator.com/']) }, user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
  data: { plan: pick(['free', 'pro', 'team']), duration_ms: Math.floor(Math.random() * 5000), file_size_mb: +(Math.random() * 200).toFixed(2), format: pick(['pdf', 'png', 'mp4']), item_id: randomBytes(6).toString('hex') },
})
const batch = (n) => Array.from({ length: n }, event).join('\n')

const pct = (sorted, p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(0) : null

const name = opt.project || 'load_' + randomBytes(3).toString('hex')
const created = opt.project ? null : await rpc('Project', 'CreateProject', { name })
const projectId = created?.project?.id ?? (await rpc('Project', 'GetProject', { project: name })).project.id
const pk = created?.publishableKey
if (!pk) { console.error('need a fresh project (omit --project) to get an ingest key'); process.exit(2) }

const perRequest = Number(opt.events), seconds = Number(opt.seconds)
const report = { worker: base, project: name, eventsPerRequest: perRequest, steps: [] }
for (const rate of opt.steps.split(',').map(Number)) {
  const results = [], inflight = new Set()
  const t0 = performance.now()
  let sent = 0, bytes = 0
  const tick = 10
  await new Promise((done) => {
    const timer = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000
      if (elapsed >= seconds) { clearInterval(timer); done(); return }
      const due = Math.floor(elapsed * rate) - sent
      for (let i = 0; i < due && inflight.size < 2000; i++) {
        const body = batch(perRequest); bytes += body.length; sent++
        const p = request('/v1/events', { headers: { Authorization: `Bearer ${pk}`, 'content-type': 'application/x-ndjson' }, body }).then((r) => { results.push(r); inflight.delete(p) })
        inflight.add(p)
      }
    }, tick)
  })
  await Promise.all(inflight)
  const wall = (performance.now() - t0) / 1000
  const ok = results.filter((r) => r.status === 200)
  const by = {}; for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b)
  const step = { targetRps: rate, seconds, sent, ok: ok.length, byStatus: by, achievedRps: +(sent / seconds).toFixed(1), okRps: +(ok.length / wall).toFixed(1), p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.length ? +lat.at(-1).toFixed(0) : null, avgBodyBytes: Math.round(bytes / Math.max(1, sent)), sampleError: results.find((r) => r.status !== 200)?.text?.slice(0, 200) }
  report.steps.push(step); console.error(JSON.stringify(step))
  await new Promise((r) => setTimeout(r, 3000)) // let the Durable Object drain between steps
}

const wait = Number(opt['wait-seal'])
if (wait) { console.error(`waiting ${wait}s for the final seal`); await new Promise((r) => setTimeout(r, wait * 1000)) }
const listing = await rpc('Archive', 'ListObjects', { project: projectId, limit: 1000 }).catch((e) => ({ error: String(e) }))
const objects = listing.objects ?? []
const total = report.steps.reduce((n, s) => n + s.ok, 0) * perRequest
report.archive = { objects: objects.length, bytes: objects.reduce((n, o) => n + Number(o.size ?? o.sizeBytes ?? 0), 0), eventsAccepted: total }
report.archive.bytesPerEvent = report.archive.bytes && total ? +(report.archive.bytes / total).toFixed(1) : null
console.log(JSON.stringify(report, null, 2))
agent.destroy()
