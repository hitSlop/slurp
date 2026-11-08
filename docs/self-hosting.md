# Self-hosting on Cloudflare

Slurp runs in your own Cloudflare account: one Worker, two SQLite Durable Object classes and one R2 bucket. You pay Cloudflare directly; most small apps fit inside the Workers Free plan.

## Deploy

You need a Cloudflare account and Node.js 20+ (slurp fetches wrangler itself with `npx`; an installed wrangler 4.100+ is used if you have one).

```sh
curl -LsSf https://slurp.run/install | sh
# or: npm install -g @hitslop/slurp
slurp cloud init
slurp setup
slurp init --name "My app"
```

`slurp cloud init` logs in with `wrangler login` if needed, picks your Cloudflare account (`--account` if you have several), creates the R2 bucket, deploys the Worker that is embedded in the CLI, sets a generated 256-bit `ADMIN_TOKEN` secret (never printed), waits for the Worker, saves the connection and writes a receipt to `~/.slurp/cloud/<worker>.json`. Options: `--worker` and `--bucket` to name things, `--seal-interval SECONDS`, `--retention-days N`, `--yes` for no prompts, `--no-open` to print the login URL instead of opening a browser.

Day to day:

| Command | What it does |
|---|---|
| `slurp cloud status` | Reachability, deployed version, projects and how far each has published |
| `slurp cloud doctor` | Checks wrangler, your Cloudflare login, the Worker, its token and your saved connection, with a fix for each problem |
| `slurp cloud upgrade` | Redeploys the Worker bundled with this CLI; data, secret and settings are kept |
| `slurp cloud destroy` | Empties and deletes the Worker and bucket (you type the Worker name; `--yes` skips the prompt). Synced DuckDB files are untouched |

If a step fails, slurp prints what wrangler said and the likely fix (for example, enabling R2 on a new Cloudflare account needs a payment method on file; the link goes straight to that page). Re-running `cloud init` is safe: it refuses to touch an existing Worker of the same name.

### Doing it by hand

```sh
cd backend
npm install
npx wrangler login
npx wrangler r2 bucket create slurp-archive
npx wrangler deploy
openssl rand -base64 32 > admin-token.txt
npx wrangler secret put ADMIN_TOKEN < admin-token.txt
slurp connect https://slurp.YOUR-SUBDOMAIN.workers.dev --token-stdin < admin-token.txt
```

The Worker name and bucket are in `backend/wrangler.jsonc` (`slurp`, `slurp-archive`). `backend/scripts/bundle.mjs` rebuilds the copy embedded in the CLI (`crates/slurp-cli/assets/worker`); CI checks it is current.

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FhitSlop%2Fslurp%2Ftree%2Fmaster%2Fbackend)

Cloudflare's "Deploy to Cloudflare" button clones the `backend/` directory of the public repository ([hitSlop/slurp](https://github.com/hitSlop/slurp)) into your account and provisions the bucket and Durable Objects from `wrangler.jsonc`. It asks for `ADMIN_TOKEN` (described in `backend/package.json`): choose a long random value, for example `openssl rand -base64 32`, and keep it. The website's deploy dialog uses the same link; its address is `deployRepoUrl` in `apps/site/src/lib/config.mjs`. `backend/` is deliberately self-contained (its own `package.json` and lockfile) so it builds on its own.

## From deploy to first event

Where each value comes from:

```
Worker URL     https://slurp.<your-subdomain>.workers.dev   printed by `wrangler deploy` / `slurp cloud init`,
                                                             or shown by Cloudflare after the button deploy.
                                                             Open it in a browser: it shows your connect command.
admin token    what you chose (button) or what `slurp cloud init` generated and saved. Controls the deployment.
ingest URL     <Worker URL>/v1/events        returned by the Worker when `slurp init` creates your project
publishable key slurp_pk_…                   created with the project; safe to put in a web page, can only send events
```

1. **Deploy.** `slurp cloud init` from a terminal, or the button above.
2. **Connect this computer.** After `slurp cloud init` this is already done. After the button, open your Worker's address and run the command it shows: `slurp connect https://slurp.<subdomain>.workers.dev --token-stdin` (paste the token when asked, or pipe it from a file).
3. **Create the project.** `slurp setup` once, then `slurp init --name "My app"` in your app's folder. The Worker creates the project and a publishable key and returns the ingest URL. The CLI opens a local quickstart page with the exact SDK snippet. You never type the URL or the key.
4. **Send an event, then `slurp sync`.** Install the SDK with `npm install @hitslop/slurp-sdk`; it needs only `endpoint` (the ingest URL) and `key` (the publishable key). From a terminal, `slurp send signed_up --data '{"plan":"pro"}'` does the same, and any language can POST to the ingest URL. Events appear in DuckDB after the next archive seal (about 10 minutes by default).

## Settings

Plain variables in `backend/wrangler.jsonc` (`vars`); change and run `wrangler deploy`.

| Variable | Default | Meaning |
|---|---|---|
| `SEAL_INTERVAL_MS` | `600000` | After the first buffered batch, wait this long, then seal everything into one archive. Lower is fresher and creates more, smaller archives. |
| `SEAL_MAX_BYTES` | `8388608` | Seal immediately when this much is buffered. |
| `GROUP_COMMIT_MS` | `500` | Concurrent requests inside this window share one write. `0` writes each request on its own. Higher saves cost, adds latency to each acknowledgement. |
| `BUFFER_CAP_BYTES` | `67108864` | Unsealed data per project. Beyond it ingestion answers `429` with `Retry-After`. |
| `MAX_BODY_BYTES` | `10485760` | Largest accepted request body (`413` beyond). |
| `ARCHIVE_RETRY_MS` | `5000` | If writing an archive to R2 fails, the first retry comes after this long, then doubles up to `SEAL_INTERVAL_MS` and keeps trying until R2 answers. A quiet project publishes by itself once R2 is back. Not in `wrangler.jsonc`; add it to `vars` to change it. |
| `RETENTION_DAYS` | `0` | Delete archives older than this many days, even when the project has gone quiet (the Worker wakes itself when the oldest archive expires). `0` keeps everything and the API reports a retention window of 0. |

Secret: `ADMIN_TOKEN` (at least 20 characters). `DEBUG` enables `/__debug` routes for tests; never set it on a real deployment.

## Security

- **Admin token** controls the deployment: create projects and keys, read every archive. Keep it out of repositories and browser code. Rotate with `wrangler secret put ADMIN_TOKEN`, then `slurp connect` again; signed download links derived from it stop working (they last an hour anyway).
- **Publishable keys** (`slurp_pk_`) can only send events, so they are safe in browser code. Revoke with `slurp project key revoke`. A revoked key stops working within about 5 seconds.
- **Secret keys** (`slurp_sk_`) read one project's archives. Create one per bot: `slurp project key create PROJECT --scope secret --name bot`.
- **Geo** (country, region, city) comes only from Cloudflare's own request metadata and only for projects with geo enabled; client-supplied geo headers and fields are rejected or ignored.
- The CLI never receives R2 credentials; archives are fetched through short-lived signed links from your Worker.

## Costs and limits

Cloudflare bills your account at list price. The site's [cost table](../apps/site/src/pages/self-host.astro) estimates it from the measured behavior of this Worker. Cloudflare's published Free plan limits include 100,000 requests a day for Workers and for Durable Objects; at 20 events per request that is roughly 2M events a day. When a Free limit is hit, Cloudflare rejects requests, the SDK keeps events and retries, and you can upgrade to Workers Paid ($5 a month) to lift it. Durable Object storage also has a 2 MB row limit, which the Worker respects by splitting rows at 1.5 MB.

R2 storage keeps growing at $0.015 per GB-month until you set `RETENTION_DAYS`. Local data is never deleted by retention: committed rows stay in your DuckDB file.

### How much one project can take

Measured on a real Worker (with `backend/scripts/load.mjs`, below): one project sustained about **5,000 events a second** with every request accepted, whether sent as 20 events at 200 requests a second or 100 events at 50. That is roughly 13 billion events a month if it never let up, so most apps are nowhere near it. Latency is about 0.5 s (the group-commit window) up to about 4,000 events a second, and rises past that. Beyond the limit the Worker answers `503` and the SDK retries. If one app needs more, send to several sources.

Measure your own: `SLURP_TOKEN=<admin token> node backend/scripts/load.mjs https://YOUR-WORKER.workers.dev --steps 50,100,200 --seconds 30`. It creates a new project, so use a Worker you can throw away (`slurp cloud init --worker slurp-test`, then `slurp cloud destroy`).

## Operations

- **Health:** `curl https://YOUR-WORKER/v1/health`.
- **Logs and CPU:** `npx wrangler tail` (observability is enabled).
- **Upgrade:** `slurp cloud upgrade` (or, by hand, pull the repository and `cd backend && npx wrangler deploy`). Durable Object migrations are declared in `wrangler.jsonc`; existing data is kept.
- **Back up:** archives are plain gzip NDJSON in R2 and are already on your machine after `slurp sync`.
- **Remove everything:** `slurp cloud destroy`. By hand: `POST /v1/admin/purge` with `{"confirm":"delete-all-data"}` and the admin token empties all data, then `npx wrangler delete` and delete the bucket.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `slurp connect`: "could not reach" | Wrong URL, or the Worker is not deployed. Check `/v1/health`. |
| `slurp connect`: "no ADMIN_TOKEN configured" | Set the secret (see Deploy). |
| `slurp connect`: "rejected that admin token" | Token differs from the secret. |
| `slurp sync` imports nothing | No archive sealed yet. Wait for `SEAL_INTERVAL_MS`, or check `slurp status`. |
| Events return `429` | Buffer cap reached for a project; it clears when the next seal finishes. |
| Events return `401` / `403` | Revoked or wrong key; a secret key cannot send events. |
| `410 RetentionGap` on sync | Archives older than `RETENTION_DAYS` were deleted; use a fresh workspace (existing data is kept). |
