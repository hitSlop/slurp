// Bundle the Worker into one JavaScript file for `slurp cloud init`, which embeds it in the CLI.
//   node scripts/bundle.mjs           # write ../crates/slurp-cli/assets/worker/{index.js,build.json}
//   node scripts/bundle.mjs --check   # exit 1 if the committed bundle is stale
// The bundle needs no npm install on the user's machine: its only import is Cloudflare's built-in `cloudflare:workers`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backend = join(here, '..')
const assets = join(backend, '../crates/slurp-cli/assets/worker')
const check = process.argv.includes('--check')

const out = mkdtempSync(join(tmpdir(), 'slurp-bundle-'))
try {
  const r = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out, '--minify=false'], { cwd: backend, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`wrangler bundle failed:\n${r.stdout}${r.stderr}`)
  const code = readFileSync(join(out, 'index.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd() + '\n'
  const build = createHash('sha256').update(code).digest('hex').slice(0, 12)
  const config = JSON.parse(readFileSync(join(backend, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const meta = JSON.stringify({ build, compatibility_date: config.compatibility_date, vars: config.vars }, null, 2) + '\n'
  if (check) {
    const stale = !existsSync(join(assets, 'index.js')) || readFileSync(join(assets, 'index.js'), 'utf8') !== code || readFileSync(join(assets, 'build.json'), 'utf8') !== meta
    if (stale) { console.error('stale: crates/slurp-cli/assets/worker (run node backend/scripts/bundle.mjs)'); process.exit(1) }
    console.log(`worker bundle is current (${build})`)
  } else {
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'index.js'), code)
    writeFileSync(join(assets, 'build.json'), meta)
    console.log(`wrote crates/slurp-cli/assets/worker (${build}, ${(code.length / 1024).toFixed(0)} KB)`)
  }
} finally { rmSync(out, { recursive: true, force: true }) }
