// Builds the sample reports used on the website, from synthetic data, through the real pipeline:
//   events -> local Worker (wrangler dev) -> sealed archives -> `slurp sync` -> DuckDB -> `slurp report build`
//
//   node build-showcase.mjs data       # generate + load the demo database into examples/demo/.work (needs Worker deps)
//   node build-showcase.mjs reports    # build every report from that database, copy outputs into apps/site
//   node build-showcase.mjs reports activation   # only the named reports
//   node build-showcase.mjs styles     # the flagship report with the example themes/template in examples/styles
//   node build-showcase.mjs            # data + reports
//
// Needs: `cargo build -p slurp-cli`, `npm install` in backend/, a DuckDB 2 executable (SLURP_DUCKDB or ~/.slurp/bin/duckdb).
// The reports use the shared definitions in examples/definitions, copied into the demo project's slurp/definitions.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './generate-events.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const work = join(here, '.work')
const bin = process.env.SLURP_BIN ?? join(root, 'target/debug/slurp')
const duckdb = process.env.SLURP_DUCKDB ?? join(homedir(), '.slurp/bin/duckdb')
const mode = process.argv[2] ?? 'all'
const ws = join(work, 'app')
const env = { PATH: process.env.PATH, HOME: join(work, 'user'), SLURP_HOME: join(work, 'home'), NO_COLOR: '1' }
// `source` builds a different report file under this name; `args` adds build flags (a dark variant, for example).
const REPORTS = [
  { name: 'export-health', pdf: true },
  { name: 'retention' },
  { name: 'activation' },
  { name: 'recovery' },
  { name: 'engagement' },
  { name: 'release-compare' },
  { name: 'formats' },
  { name: 'funnel' },
  { name: 'formats-dark', source: 'formats', args: ['--theme', 'pro-dark'] },
  { name: 'by-release' },
]

const slurp = (args, { input, ok = true } = {}) => {
  const r = spawnSync(bin, args, { cwd: ws, env, input, encoding: 'utf8' })
  if (ok && r.status !== 0) throw new Error(`slurp ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r
}
const json = (args, opts) => JSON.parse(slurp(args, opts).stdout.trim())

if (!existsSync(bin)) throw new Error(`no CLI at ${bin}; run cargo build -p slurp-cli`)
if (!existsSync(duckdb)) throw new Error(`no DuckDB at ${duckdb}; set SLURP_DUCKDB`)

if (mode === 'all' || mode === 'data') {
  const { startWorker, ADMIN_TOKEN, publish, call } = await import('../../backend/test/http/worker.ts')
  rmSync(work, { recursive: true, force: true })
  for (const d of ['home', 'user', 'app']) mkdirSync(join(work, d), { recursive: true })
  const worker = await startWorker({ GROUP_COMMIT_MS: '0', SEAL_INTERVAL_MS: '3600000' })
  try {
    slurp(['connect', worker.base, '--token-stdin'], { input: `${ADMIN_TOKEN}\n` })
    slurp(['setup', '--library', join(work, 'library'), '--duckdb', duckdb, '--no-connect', '--no-open', '--json'])
    const { project } = json(['init', '--name', 'Pixel', '--project', ws, '--data-dir', join(ws, 'data'), '--duckdb', duckdb, '--no-open', '--no-install-skills', '--no-agent-notes', '--json'])
    const key = (await call(worker.base, ADMIN_TOKEN, 'SourceKey', { project, source: 'default' })).key.key
    const events = generate()
    console.log(`posting ${events.length} synthetic events to the Worker...`)
    for (let i = 0; i < events.length; i += 800) {
      const body = events.slice(i, i + 800).map(e => JSON.stringify(e)).join('\n') + '\n'
      const res = await fetch(`${worker.base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body })
      if (res.status !== 200) throw new Error(`ingest ${res.status}: ${await res.text()}`)
      if ((i / 800) % 12 === 11) await publish(worker.base, project)
    }
    await publish(worker.base, project)
    const synced = json(['sync', '--project', ws, '--json'])
    console.log(`synced: ${synced.downloaded} archives, ${synced.imported} events`)
    const count = json(['sql', 'SELECT count(*) AS n FROM events', '--project', ws, '--json']).rows[0][0]
    if (count !== events.length) throw new Error(`expected ${events.length} events in DuckDB, found ${count}`)
    writeFileSync(join(work, 'meta.json'), JSON.stringify({ project, events: count }))
  } finally { await worker.stop() }
}

if (mode === 'styles') {
  // The flagship report with the example custom looks in examples/styles, as a contact sheet in .work/styles.
  if (!existsSync(join(work, 'meta.json'))) throw new Error('no demo database; run `node build-showcase.mjs data` first')
  const base = join(work, 'styles'); rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true })
  const looks = [
    ['grid (built in)', []],
    ['paper theme', ['--theme', join(here, '..', 'styles', 'paper.json')]],
    ['midnight theme', ['--theme', join(here, '..', 'styles', 'midnight.json')]],
    ['ledger template + paper', ['--style', join(here, '..', 'styles', 'ledger.css'), '--theme', join(here, '..', 'styles', 'paper.json')]],
  ]
  const cards = []
  for (const [i, [label, args]] of looks.entries()) {
    const out = join(base, String(i))
    slurp(['report', 'build', join(here, 'export-health.md'), ...args, '--out', out, '--png', '--project', ws])
    cards.push([label, i])
    console.log(`${label}: ok`)
  }
  const page = `<!doctype html><meta charset=utf-8><title>Report looks</title><style>body{margin:0;padding:24px;background:#e9e9e9;font:13px ui-monospace,monospace}h1{font-size:15px}.row{display:flex;gap:24px;align-items:flex-start;overflow-x:auto}figure{margin:0;flex:none}figcaption{padding:6px 0;font-weight:700}img{width:600px;display:block;box-shadow:0 2px 14px #0003}a{color:#06c}</style><h1>Flagship report with the example themes and template (PNG; click for the HTML)</h1><div class=row>${cards.map(([l, i]) => `<figure><figcaption>${l} <a href="${i}/report.html">html</a></figcaption><img src="${i}/report.png"></figure>`).join('')}</div>`
  writeFileSync(join(base, 'index.html'), page)
  console.log(`contact sheet: ${join(base, 'index.html')}`)
}

if (mode === 'all' || mode === 'reports') {
  if (!existsSync(join(work, 'meta.json'))) throw new Error('no demo database; run `node build-showcase.mjs data` first')
  const publicDir = join(root, 'apps/site/public/reports')
  const assetDir = join(root, 'apps/site/src/assets/reports')
  mkdirSync(assetDir, { recursive: true })
  // The shared definitions the reports call, checked before any report is built.
  const definitions = join(ws, 'slurp', 'definitions')
  rmSync(definitions, { recursive: true, force: true })
  mkdirSync(definitions, { recursive: true })
  const shared = join(root, 'examples', 'definitions')
  for (const f of readdirSync(shared).filter(f => f.endsWith('.sql'))) copyFileSync(join(shared, f), join(definitions, f))
  console.log(`definitions: ${json(['definitions', '--project', ws, '--json']).definitions.map(d => d.name).join(', ')}`)
  const only = process.argv.slice(3)
  for (const { name, pdf, source, args: extra = [] } of REPORTS.filter(r => only.length === 0 || only.includes(r.name))) {
    const file = join(here, `${source ?? name}.md`)
    const out = join(work, 'out', name)
    rmSync(out, { recursive: true, force: true })
    const args = ['report', 'build', file, '--out', out, '--png', ...(pdf ? ['--pdf'] : []), ...extra, '--project', ws]
    slurp(['report', 'check', file, '--project', ws])
    slurp(args)
    const files = readdirSync(out)
    console.log(`${name}: ${files.join(', ')}`)
    const html = files.find(f => f.endsWith('.html')), png = files.find(f => f.endsWith('.png')), pdfFile = files.find(f => f.endsWith('.pdf'))
    mkdirSync(join(publicDir, name), { recursive: true })
    copyFileSync(join(out, html), join(publicDir, name, 'index.html'))
    if (png) copyFileSync(join(out, png), join(assetDir, `${name}.png`))
    if (pdfFile) copyFileSync(join(out, pdfFile), join(publicDir, name, `${name}.pdf`))
  }
}
