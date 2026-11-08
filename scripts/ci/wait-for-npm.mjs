import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

export async function waitForVersion(name, version, { timeoutMs = 300_000, intervalMs = 10_000, now = Date.now, pause = setTimeout, lookup = remaining => execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json', '--prefer-online'], { encoding: 'utf8', timeout: Math.min(10_000, remaining), stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try { if (JSON.parse(await lookup(deadline - now())) === version) return; } catch { /* Registry processing or temporary lookup failure. */ }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(intervalMs, remaining));
  }
  throw new Error(`${name}@${version} was accepted by npm but is not visible after ${timeoutMs / 1000}s. Check registry availability before retrying; do not automatically republish or bump the version.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
  await waitForVersion(name, version);
  console.log(`${name}@${version} is available from npm`);
}
