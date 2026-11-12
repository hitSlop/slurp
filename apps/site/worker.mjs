// Only the homepage needs negotiation; every other route stays asset-first.
export function prefersMarkdown(accept = '') {
  const entries = accept.toLowerCase().split(',').map(part => {
    const [type, ...params] = part.trim().split(';');
    const quality = params.find(p => p.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { type: type.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  const markdown = entries.find(e => e.type === 'text/markdown')?.q ?? 0;
  const html = entries.find(e => e.type === 'text/html')?.q ?? 0;
  return markdown > 0 && markdown >= html;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const homepage = url.pathname === '/' && ['GET', 'HEAD'].includes(request.method);
    const markdown = homepage && prefersMarkdown(request.headers.get('accept') ?? '');
    if (markdown) url.pathname = '/index.md';
    const response = await env.ASSETS.fetch(markdown ? new Request(url, request) : request);
    if (!homepage) return response;
    const headers = new Headers(response.headers);
    headers.append('Vary', 'Accept');
    headers.set('Content-Signal', 'ai-train=yes, search=yes, ai-input=yes');
    if (markdown && response.ok) headers.set('Content-Type', 'text/markdown; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  },
};
