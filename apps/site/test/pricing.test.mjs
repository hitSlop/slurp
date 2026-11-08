import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amplitudeCost, assumptions, projectsNeeded, cloudflareCost, cloudflareRange, headlineVolume, rangeFrom, roughly, mixpanelCost, money, openpanelCost, posthogCost, tools, volumes } from '../src/lib/pricing.mjs';

test('PostHog marginal tiers', () => {
  assert.equal(posthogCost(1e6), 0);
  assert.equal(posthogCost(2e6), 50);
  assert.equal(posthogCost(10e6), 324.4);
  assert.equal(posthogCost(100e6), 2618.4);
});
test('Mixpanel, Amplitude and OpenPanel follow published tiers and are null where unpublished', () => {
  assert.deepEqual([1e5, 1e6, 10e6].map(n => mixpanelCost(n)), [0, 0, 840]);
  assert.equal(mixpanelCost(100e6), null);
  assert.deepEqual([1e5, 1e6, 10e6].map(n => openpanelCost(n)), [20, 90, 350]);
  assert.equal(openpanelCost(100e6), null);
  assert.equal(amplitudeCost(2e6), 0);
  assert.equal(amplitudeCost(10e6), null);
});
test('self-hosted Cloudflare cost: R2 storage always billed, Workers Paid once past half the Free daily cap', () => {
  assert.deepEqual(volumes.map(n => cloudflareCost(n)), [0, 0.43, 7.96, 11.21, 82.2, 896.91]);
  assert.equal(cloudflareCost(headlineVolume), 7.96); // $5 + 1.5M Durable Object requests over the 1M included + 182 GB of R2 over the free 10
  // fewer events per request means more requests, so Workers Paid starts sooner
  assert.ok(cloudflareCost(10e6, { ...assumptions, eventsPerRequest: 1 }) > 5);
  // shorter retention is cheaper
  assert.ok(cloudflareCost(50e6, { ...assumptions, retentionMonths: 1 }) < cloudflareCost(50e6));
});
test('headline comparison at 50M events', () => {
  assert.equal(posthogCost(headlineVolume), 1528.4);
  assert.equal(openpanelCost(headlineVolume), 900);
  assert.equal(mixpanelCost(headlineVolume), null);
  assert.equal(posthogCost(1e9), 11618.4);
  assert.equal(posthogCost(1e10), 92618.4);
});
test('every table cell renders to a price or an explicit note', () => {
  for (const tool of tools) for (const n of volumes) {
    const cost = tool.cost(n);
    assert.ok(cost === null ? tool.unpublished.length > 0 : money(cost).length > 0, `${tool.name} @ ${n}`);
  }
});

test('1B and 10B are ranges that contain the central estimate and widen with scale', () => {
  assert.equal(rangeFrom, 1e9);
  let previousSpread = 0;
  for (const n of volumes) {
    const [lo, hi] = cloudflareRange(n), mid = cloudflareCost(n);
    assert.ok(lo <= mid && mid <= hi, `${n}: ${lo} <= ${mid} <= ${hi}`);
    assert.ok(hi - lo >= previousSpread, 'the range never narrows as volume grows');
    previousSpread = hi - lo;
  }
  assert.deepEqual(cloudflareRange(1e10), [415.54, 3215.5]);
  assert.deepEqual(cloudflareRange(1e9), [42.2, 275.1]);
});

test('extrapolated figures are rounded', () => {
  assert.deepEqual([42.2, 275.1, 415.54, 3215.5].map(roughly), [42, 280, 420, 3200]);
});

test('sources needed follow the measured per-project capacity, and extra always-busy projects add Durable Object duration', () => {
  assert.deepEqual([1e6, 1e9, 3e9, 1e10].map(n => projectsNeeded(n)), [1, 1, 1, 3]);
  // one always-busy project (~332K GB-s) fits in the 400K GB-s included; three do not
  const one = cloudflareCost(1e10, { ...assumptions, eventsPerSecondPerProject: 1e9 });
  assert.ok(cloudflareCost(1e10) > one, 'sharding across projects costs a little more');
  assert.ok(cloudflareCost(1e10) - one < 20, 'but only a little');
});
