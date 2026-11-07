// One version of each shared tool across the repo. The Worker keeps its own lockfile (the Deploy to Cloudflare button builds
// from backend/ alone), so nothing else would notice if its pins drifted from the workspace's.
//   node scripts/ci/pins.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const packages = ['backend', 'apps/site', 'apps/setup', 'sdks/js', 'sdks/react-native', 'report-assets']
const shared = ['wrangler', 'typescript', 'esbuild', 'vite']
const seen = new Map()
for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  for (const group of ['dependencies', 'devDependencies'])
    for (const name of shared) {
      const version = manifest[group]?.[name]
      if (!version) continue
      if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${dir}: ${name} is "${version}"; pin an exact version`)
      seen.set(name, [...(seen.get(name) ?? []), { dir, version }])
    }
}
for (const [name, uses] of seen) {
  const versions = new Set(uses.map(u => u.version))
  if (versions.size > 1) fail(`${name} differs: ${uses.map(u => `${u.dir}@${u.version}`).join(', ')}`)
}
console.log(`pins agree: ${[...seen].map(([n, u]) => `${n}@${u[0].version}`).join(', ')}`)
function fail(message) { console.error(`pins: ${message}`); process.exit(1) }
