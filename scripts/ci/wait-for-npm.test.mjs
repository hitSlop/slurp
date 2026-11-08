import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForVersion } from './wait-for-npm.mjs';

test('publication waits through processing and succeeds only on the exact version', async () => {
  let clock = 0, attempts = 0;
  await waitForVersion('example', '0.2.1', { now: () => clock, pause: async ms => { clock += ms; }, timeoutMs: 100, intervalMs: 10,
    lookup: () => { attempts++; if (attempts === 1) throw new Error('404'); return JSON.stringify(attempts === 2 ? '0.2.0' : '0.2.1'); } });
  assert.equal(attempts, 3);
  assert.equal(clock, 20);
});

test('a registry timeout fails within the budget and never republishes', async () => {
  let clock = 0, attempts = 0;
  await assert.rejects(waitForVersion('example', '0.2.1', { now: () => clock, pause: async ms => { clock += ms; }, timeoutMs: 25, intervalMs: 10,
    lookup: () => { attempts++; return ''; } }), /do not automatically republish/);
  assert.equal(clock, 25);
  assert.equal(attempts, 3);
});
