import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { runTests, testFiles } from '../../sdks/js/scripts/test.mjs';

test('unit discovery includes feedback and future tests; only gateway needs a Worker', () => {
  assert.ok(testFiles('unit').some(path => basename(path) === 'feedback.test.ts'));
  assert.deepEqual(testFiles('integration').map(path => basename(path)), ['gateway.test.ts']);
  const dir = mkdtempSync(join(tmpdir(), 'slurp-sdk-tests-'));
  try {
    for (const file of ['future.test.ts', 'gateway.test.ts', 'helper.ts']) writeFileSync(join(dir, file), '');
    assert.deepEqual(testFiles('unit', dir).map(path => basename(path)), ['future.test.ts']);
    assert.equal(runTests('all', dir, () => ({ status: 7 })), 7, 'a failing unit group stops the run');
    assert.equal(runTests('integration', dir, () => ({ status: null })), 1, 'a killed test process fails');
    assert.throws(() => runTests('unknown', dir), /Unknown test mode/);
    rmSync(join(dir, 'gateway.test.ts'));
    assert.throws(() => runTests('integration', dir), /No integration tests/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
