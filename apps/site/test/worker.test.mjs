import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { prefersMarkdown } from '../worker.mjs';
test('Markdown requires an explicit, acceptable preference', () => {
  for (const value of ['', '*/*', 'text/html', 'text/markdown;q=0', 'text/markdown;q=.2,text/html;q=.9']) assert.equal(prefersMarkdown(value), false, value);
  for (const value of ['text/markdown', 'text/markdown, text/html', 'TEXT/MARKDOWN;q=.9,text/html;q=.2']) assert.equal(prefersMarkdown(value), true, value);
});
test('homepage variants use distinct assets and preserve HEAD and other routes', async () => {
  const env = { ASSETS: { async fetch(request) { return new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html', Vary: 'Origin' } }); } } };
  for (const [path, accept, expected] of [['/', 'text/markdown', '/index.md'], ['/', 'text/html', '/'], ['/docs/', 'text/markdown', '/docs/'], ['/index.md', '*/*', '/index.md']]) {
    const response = await worker.fetch(new Request('https://slurp.run'+path, { headers: { Accept: accept } }), env);
    assert.equal(await response.text(), expected);
    if (path === '/') { assert.match(response.headers.get('Vary'), /Accept/); assert.match(response.headers.get('Vary'), /Origin/); }
    if (expected === '/index.md' && path === '/') assert.match(response.headers.get('Content-Type'), /^text\/markdown/);
  }
  const head = await worker.fetch(new Request('https://slurp.run/', { method: 'HEAD', headers: { Accept: 'text/markdown' } }), env);
  assert.equal(await head.text(), '');
  assert.match(head.headers.get('Content-Type'), /^text\/markdown/);
});
