/**
 * The page shown at the Worker's own address. After a one-click deploy the first thing people have is this URL, so it says
 * what it is and the exact command that connects the CLI. It holds no secrets and no data: only the request's own origin.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function setupPage(origin: string, configured: boolean): string {
  const o = esc(origin)
  const setup = configured
    ? ''
    : `<p class="warn"><strong>Not finished.</strong> The <code>ADMIN_TOKEN</code> secret is missing or too short (20 characters minimum). Set it in the Cloudflare dashboard under this Worker's Settings, Variables and Secrets, or run <code>npx wrangler secret put ADMIN_TOKEN</code>. Then reload this page.</p>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Slurp is running</title>
<style>
:root{--bg:#fff;--fg:#17191c;--muted:#535c66;--rule:#e4e7eb;--code:#f6f9fc;--accent:#e8002a}
@media(prefers-color-scheme:dark){:root{--bg:#101215;--fg:#eceff2;--muted:#9aa4af;--rule:#262b31;--code:#171b20}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:56px 20px}
h1{font-size:28px;margin:0 0 8px}p{color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${configured ? '#1a9d5c' : '#e8a000'};margin-right:10px}
pre{background:var(--code);border:1px solid var(--rule);border-radius:7px;padding:14px 16px;overflow:auto;font-size:13px;color:var(--fg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warn{border:1px solid var(--rule);border-left:3px solid #e8a000;padding:12px 16px;border-radius:4px}
ol{padding-left:20px}li{margin:10px 0}a{color:var(--accent)}
</style></head><body><main>
<h1><span class="dot"></span>Slurp is running</h1>
<p>This is your own Slurp Worker. Events you send here are stored in your Cloudflare account and nowhere else.</p>
${setup}
<h2>Connect your computer</h2>
<ol>
<li>Install the Slurp CLI.</li>
<li>Connect it to this Worker with the <code>ADMIN_TOKEN</code> you chose when you deployed. The token is read from standard input, so it never shows up in your shell history:
<pre><code>slurp connect ${o} --token-stdin</code></pre></li>
<li>In your app's folder, create a source and get the SDK snippet:
<pre><code>slurp setup
slurp init --name "My app"</code></pre></li>
</ol>
<p>Your SDK sends events to <code>${o}/v1/events</code> with a publishable key. <code>slurp init</code> prints both for you.</p>
<p><a href="https://github.com/hitSlop/slurp/blob/main/docs/self-hosting.md">Self-hosting guide</a> · <a href="${o}/v1/health">Health</a></p>
</main></body></html>`
}
