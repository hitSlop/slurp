import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../test');
export function testFiles(mode, root = directory) {
  if (!['unit', 'integration'].includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  return readdirSync(root).filter(name => name.endsWith('.test.ts') && (name === 'gateway.test.ts') === (mode === 'integration')).sort().map(name => join(root, name));
}

export function runTests(mode = 'all', root = directory, spawn = spawnSync) {
  for (const group of mode === 'all' ? ['unit', 'integration'] : [mode]) {
    const files = testFiles(group, root);
    if (!files.length) throw new Error(`No ${group} tests found`);
    const result = spawn(process.execPath, ['--test', '--test-force-exit', '--test-timeout=150000', ...files], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runTests(process.argv[2]);
