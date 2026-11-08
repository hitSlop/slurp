import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiresFullSuite = paths => paths.length === 0 || paths.some(path => !path.startsWith('apps/site/'));

export function classify(eventName, event, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  try {
    let base, head;
    if (eventName === 'pull_request') {
      head = event.pull_request.head.sha;
      base = git(['merge-base', event.pull_request.base.sha, head]).trim();
    } else if (eventName === 'push') {
      base = event.before;
      head = event.after;
    } else return true;
    if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha))) return true;
    const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
    return requiresFullSuite(paths);
  } catch {
    return true; // Missing history or an unknown event must never skip validation.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let full = true;
  try { full = classify(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))); } catch { /* full suite */ }
  console.log(full ? 'Running the full suite' : 'Only apps/site changed; running web checks');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
}
