import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, requiresFullSuite } from './changes.mjs';

test('only nonempty changes entirely under apps/site qualify', () => {
  assert.equal(requiresFullSuite(['apps/site/src/lib/slurp.ts', 'apps/site/test/measure.test.mjs']), false);
  for (const path of ['pnpm-lock.yaml', 'sdks/js/src/feedback.ts', 'packages/web-shared/a.ts', 'docs/cli.md', '.github/workflows/check.yml', 'crates/slurp-cli/assets/setup.html', 'unknown']) {
    assert.equal(requiresFullSuite(['apps/site/a.ts', path]), true, path);
  }
  assert.equal(requiresFullSuite([]), true);
});

test('PRs use the merge base; deleted files and both sides of renames are considered', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40);
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
  const calls = [];
  const git = args => { calls.push(args); return args[0] === 'merge-base' ? merge : 'apps/site/deleted.ts\0apps/site/renamed.ts\0'; };
  assert.equal(classify('pull_request', event, git), false);
  assert.deepEqual(calls[1], ['diff', '--name-only', '--no-renames', '-z', merge, head]);
  assert.equal(classify('push', { before: base, after: head }, () => 'apps/site/old.ts\0docs/moved.ts\0'), true);
  assert.equal(classify('push', { before: base, after: head }, () => 'apps/site/deleted.ts\0'), false);
});

test('manual runs, missing history, malformed events, and empty diffs run everything', () => {
  const event = { before: 'a'.repeat(40), after: 'b'.repeat(40) };
  assert.equal(classify('workflow_dispatch', {}), true);
  assert.equal(classify('pull_request', {}), true);
  assert.equal(classify('push', { ...event, before: '0'.repeat(40) }), true);
  assert.equal(classify('push', event, () => { throw new Error('missing history'); }), true);
  assert.equal(classify('push', event, () => ''), true);
});

test('the workflow entry point emits a full-suite output even for unreadable metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slurp-changes-'));
  try {
    const event = join(dir, 'event.json'), output = join(dir, 'output');
    writeFileSync(event, '{broken');
    execFileSync(process.execPath, [new URL('./changes.mjs', import.meta.url).pathname], {
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
    });
    assert.equal(readFileSync(output, 'utf8'), 'full=true\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
