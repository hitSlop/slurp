// What slurp.run tells Slurp about its visitors, pinned. If this test changes, the site's privacy note (apps/site/slurp/README.md) changes with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickEvent, origin_and_path, pageContext, pageProperties } from '../src/lib/measure.ts';
import { slurpEndpoint, slurpKey } from '../src/lib/links.mjs';

const page = (path, search = '') => ({ origin: 'https://slurp.run', pathname: path, search });

test('a page view carries the path, the referrer without its query, and only the utm fields', () => {
  assert.deepEqual(
    pageProperties(page('/docs/', '?utm_source=hn&utm_medium=post&utm_campaign=launch&email=a@b.co&token=secret'), 'https://news.ycombinator.com/item?id=1#c'),
    { path: '/docs/', referrer: 'https://news.ycombinator.com/item', utm_source: 'hn', utm_medium: 'post', utm_campaign: 'launch' },
  );
  assert.deepEqual(pageProperties(page('/'), ''), { path: '/' }, 'no referrer, no utm');
  assert.deepEqual(pageProperties(page('/'), 'not a url'), { path: '/' });
  assert.equal(pageProperties(page('/', `?utm_source=${'x'.repeat(500)}`), '').utm_source.length, 100);
});

test('the event context never has a query string or a fragment', () => {
  const context = pageContext(page('/docs/', '?token=secret'), 'https://example.com/a?b=c#d', 'Docs');
  assert.deepEqual(context, { page: { url: 'https://slurp.run/docs/', path: '/docs/', referrer: 'https://example.com/a', title: 'Docs' } });
  assert.equal(origin_and_path('https://example.com/a/b?x=1#y'), 'https://example.com/a/b');
  assert.equal(origin_and_path(''), '');
});

test('only the Deploy button and the install commands are tracked, and nothing but where on the page', () => {
  assert.deepEqual(clickEvent({ dataset: { track: 'deploy_clicked', trackWhere: 'home' } }), { event: 'deploy_clicked', properties: { where: 'home' } });
  assert.deepEqual(clickEvent({ dataset: { track: 'install_copied' } }), { event: 'install_copied', properties: {} });
  assert.equal(clickEvent({ dataset: { track: 'anything_else' } }), null, 'an unknown name is ignored');
  assert.equal(clickEvent({ dataset: {} }), null);
  assert.equal(clickEvent(null), null);
});

test('the site sends to its own events host with a publishable key, or sends nothing', () => {
  assert.equal(slurpEndpoint, 'https://events.slurp.run/v1/events');
  assert.ok(slurpKey === '' || /^slurp_pk_[0-9a-f]{16}_site_[0-9a-f]{48}$/.test(slurpKey), 'a publishable key, never a secret one');
});
