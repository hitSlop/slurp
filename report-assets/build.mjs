import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeTextMetrics } from './native-text-plugin.mjs';

const check = process.argv.includes('--check');
const result = await build({
  entryPoints: ['src/lib/chart/render-entry.ts'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2020', minify: true, write: false,
  plugins: [nativeTextMetrics],
  banner: { js: readFileSync('src/lib/chart/polyfills.js', 'utf8') },
});
const bytes = result.outputFiles[0].contents;
const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8'));
const versions = Object.fromEntries(['vega', 'vega-lite', 'vega-interpreter'].map(name => [name.replaceAll('-', '_'), dependencies[name]]));
versions.bundle_sha256 = createHash('sha256').update(bytes).digest('hex');

const palettes = await build({ entryPoints: ['src/lib/themes/palette.ts'], bundle: true, format: 'esm', platform: 'node', write: false, loader: { '.json': 'json' } });
const mod = await import('data:text/javascript;base64,' + Buffer.from(palettes.outputFiles[0].text).toString('base64'));
const artifacts = {
  'versions.json': Buffer.from(JSON.stringify(versions, null, 2) + '\n'),
  'themes.json': Buffer.from(JSON.stringify(mod.themes.map(({ gradient, ...theme }) => theme), null, 1) + '\n'),
};
const directory = '../crates/slurp-render/assets/';
if (check) {
  // Compare the decompressed bytes: compressor upgrades must not cause false failures.
  const embedded = execFileSync('zstd', ['--decompress', '--stdout', directory + 'render.js.zst']);
  const stale = Buffer.compare(embedded, Buffer.from(bytes)) !== 0
    || Object.entries(artifacts).some(([name, value]) => Buffer.compare(readFileSync(directory + name), value) !== 0);
  if (stale) throw new Error('Embedded chart assets are stale; run pnpm --dir report-assets build');
  console.log('Embedded chart bundle, versions and themes match their source');
} else {
  const compressed = execFileSync('zstd', ['-19', '--stdout', '--no-progress'], { input: bytes });
  writeFileSync(directory + 'render.js.zst', compressed);
  for (const [name, value] of Object.entries(artifacts)) writeFileSync(directory + name, value);
}
