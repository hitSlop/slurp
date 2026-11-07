const base = 'http://localhost:8788', admin = { Authorization: 'Bearer spike-admin-token' }
const rpc = (s: string, m: string, b: object) => fetch(`${base}/rpc/${s}/${m}`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()) as Promise<any>
const c = await rpc('Source', 'CreateSource', { name: 'm-' + Math.random().toString(16).slice(2, 8), requestId: crypto.randomUUID() })
const src = c.source.id, pk = c.publishableKey
const ev = (i: number, pad = 0) => JSON.stringify({ id: crypto.randomUUID(), type: 'track', event: 'e' + (i % 7), timestamp: '2026-11-06T00:00:00Z', data: { i, pad: 'x'.repeat(pad) } })
const post = async (body: string) => { const t = performance.now(); const r = await fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${pk}` }, body }); const j: any = await r.json().catch(() => ({})); return { s: r.status, ms: performance.now() - t, ...j } }

// 1) rows written per small batch
const small = []; for (let i = 0; i < 20; i++) small.push(await post(Array.from({ length: 25 }, (_, k) => ev(k, 600)).join('\n')))
console.log('25-event batches: status', [...new Set(small.map(x => x.s))], 'rowsWritten/batch', [...new Set(small.map(x => x.rowsWritten))], 'median ms', small.map(x => x.ms).sort((a, b) => a - b)[10].toFixed(1))

// 2) max SDK batch: 1000 events ~900KiB
const big = await post(Array.from({ length: 1000 }, (_, k) => ev(k, 800)).join('\n'))
console.log('1000-event ~900KiB batch:', big.s, big.ms.toFixed(0) + 'ms', 'rowsWritten', big.rowsWritten)

// 3) concurrency: 50 parallel batches to one source
const t0 = performance.now()
const par = await Promise.all(Array.from({ length: 50 }, (_, i) => post(Array.from({ length: 25 }, (_, k) => ev(i * 100 + k, 300)).join('\n'))))
console.log('50 parallel batches:', [...new Set(par.map(x => x.s))], (performance.now() - t0).toFixed(0) + 'ms total')

console.log('stats before alarm', await (await fetch(`${base}/__debug/stats/${src}`, { headers: admin })).json())
await new Promise(r => setTimeout(r, 7000))
console.log('stats after 7s (alarm interval 5s)', await (await fetch(`${base}/__debug/stats/${src}`, { headers: admin })).json())
const sk = (await rpc('Source', 'CreateKey', { source: src, scope: 'secret' })).key
const list = await (await fetch(`${base}/rpc/Archive/ListObjects`, { method: 'POST', headers: { Authorization: `Bearer ${sk}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: src }) })).json() as any
console.log('archives', list.objects.map((o: any) => ({ seq: o.seq, size: o.size })), 'total events expected', 20 * 25 + 1000 + 50 * 25)
