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
4. **Send an event, then `slurp sync`.** Install the SDK with `npm install @hitslop/slurp-sdk`; it needs only `endpoint` (the ingest URL) and `key` (the publishable key). From a terminal, `slurp send signed_up --data '{"plan":"pro"}'` does the same, and any language can POST to the ingest URL. Events appear in DuckDB after the Worker next publishes an archive (about 10 minutes by default); `slurp sync --now` publishes first, so they show up at once (admin token).

## Settings

Plain variables in `backend/wrangler.jsonc` (`vars`); change and run `wrangler deploy`. They are parsed once, in `backend/src/config.ts`: an empty, non-numeric or below-minimum value falls back to the default and the Worker logs one warning for it.

| Variable | Default | Minimum | Meaning |
|---|---|---|---|
| `SEAL_INTERVAL_MS` | `600000` | 1 | An archive is published this long after its oldest buffered event was committed. Lower is fresher and creates more, smaller archives. |
| `ARCHIVE_MAX_BYTES` | `8388608` | 1 | The uncompressed input of one archive. Publishing starts at once when this much is buffered. |
| `GROUP_COMMIT_MS` | `500` | 0 | Concurrent requests inside this window share one write. `0` writes each request on its own. Higher saves cost, adds latency to each acknowledgement. |
| `BUFFER_CAP_BYTES` | `67108864` | 1 | Unpublished data per project. Beyond it ingestion answers `429` with `Retry-After`. |
| `MAX_BODY_BYTES` | `10485760` | 1 | Largest accepted request body (`413` beyond). |
| `RETENTION_DAYS` | `0` | 0 | Delete archives older than this many days, even when the project has gone quiet (the Worker wakes itself when the oldest archive expires). `0` keeps everything. |
| `ARCHIVE_RETRY_MS` | `5000` | 1 | If writing an archive to R2 fails, the first retry comes after this long, then doubles up to `SEAL_INTERVAL_MS` and keeps trying until R2 answers. A quiet project publishes by itself once R2 is back. Not in `wrangler.jsonc`; add it to `vars` to change it. |
| `GEO` | `on` | | `on` or `off`, for the whole Worker. When on, each event's envelope carries the visitor's `city`, `country` and `region` from Cloudflare. `off` stores none. |

Secret: `ADMIN_TOKEN` (at least 20 characters).

## Security

- **Admin token** controls the deployment: create projects and keys, read every archive. Keep it out of repositories and browser code. Rotate with `wrangler secret put ADMIN_TOKEN`, then `slurp connect` again. Nothing else changes: keys and webhook secrets are stored by the Worker, not derived from the token.
- **Publishable keys** (`slurp_pk_`) can only send events, so they are safe in browser code. Revoke with `slurp project key revoke`. A revoked key stops working on its next request. Rotate by creating another key for the same source, then revoking the old one.
- **Secret keys** (`slurp_sk_`) read one project's archives. Create one per bot: `slurp project key create PROJECT --scope secret --name bot`.
- **Geo** (country, region, city) comes only from Cloudflare's own request metadata, and only while `GEO` is `on` (the default); client-supplied geo headers are ignored. A webhook never gets geo, because the caller is the provider's server.
- The CLI never receives R2 credentials. It downloads each archive from your Worker with `GET /v1/projects/<id>/archives/<seq>`, authenticated with the admin token or that project's secret key.

## Costs and limits

Cloudflare bills your account at list price. The site's [cost table](../apps/site/src/pages/self-host.astro) estimates it from the measured behavior of this Worker. Cloudflare's published Free plan limits include 100,000 requests a day for Workers and for Durable Objects; at 20 events per request that is roughly 2M events a day. When a Free limit is hit, Cloudflare rejects requests, the SDK keeps events and retries, and you can upgrade to Workers Paid ($5 a month) to lift it. Durable Object SQLite rejects rows over 8 MB, which the Worker respects by storing events in chunks of at most 6 MiB.

R2 storage keeps growing at $0.015 per GB-month until you set `RETENTION_DAYS`. Local data is never deleted by retention: committed rows stay in your DuckDB file.

### How much one project can take

Measured on a real Worker (with `backend/scripts/load.mjs`, below): one project sustained about **5,000 events a second** with every request accepted, whether sent as 20 events at 200 requests a second or 100 events at 50. That is roughly 13 billion events a month if it never let up, so most apps are nowhere near it. Latency is about 0.5 s (the group-commit window) up to about 4,000 events a second, and rises past that. Beyond the limit the Worker answers `503` and the SDK retries. If one app needs more, send to several projects.

Measure your own: `SLURP_TOKEN=<admin token> node backend/scripts/load.mjs https://YOUR-WORKER.workers.dev --steps 50,100,200 --seconds 30`. It creates a new project, so use a Worker you can throw away (`slurp cloud init --worker slurp-test`, then `slurp cloud destroy`).

## Operations

- **Health:** `curl https://YOUR-WORKER/v1/health` answers `{ok, apiVersion, configured, build, geo}` with no credentials.
- **Logs and CPU:** `npx wrangler tail` (observability is enabled).
- **Upgrade:** run `slurp cloud upgrade` (or, by hand, pull the repository and `cd backend && npx wrangler deploy`).
  - Data, the secret and settings are kept. Each project's storage upgrades itself the next time it's used.
  - After deploying, the command waits for the new build and checks storage.
  - It refuses to install an older Worker than the one deployed, and it refuses a Worker it can't reach. `--force` bypasses unavailable or unrecognizable health only; known incompatible deployments and newer releases are still refused.
  - It needs the admin token saved by `slurp cloud init` or `slurp connect`, because it checks storage through the API after deploying.
  - A Worker with unsupported deployment metadata cannot be upgraded: deploy a new one with `slurp cloud init --worker NEW`.
  - See [contracts.md, "Versions and upgrades"](contracts.md#versions-and-upgrades).
- **Back up:** archives are plain gzip NDJSON in R2 and are already on your machine after `slurp sync`.
- **Remove everything:** `slurp cloud destroy`. By hand: `POST /v1/admin/purge` with `{"confirm":"delete-all-data"}` and the admin token empties all data, then `npx wrangler delete` and delete the bucket.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `slurp cloud init` failed its readiness check | The receipt and admin token are saved. Run `slurp cloud status --worker NAME`, then retry `slurp cloud upgrade --worker NAME`. A matching build still checks storage. The default backend changes only after successful initialization. |
| `slurp connect`: "could not reach" | Wrong URL, or the Worker is not deployed. Check `/v1/health`. |
| `slurp connect`: "no ADMIN_TOKEN configured" | Set the secret (see Deploy). |
| `slurp connect`: "rejected that admin token" | Token differs from the secret. |
| `slurp sync` imports nothing | No archive published yet. Wait for `SEAL_INTERVAL_MS`, run `slurp sync --now` (admin token), or check `slurp status`. |
| Events return `429` | Buffer cap reached for a project; it clears when the next archive is published. |
| Events return `400` | At least one line is invalid, so nothing was stored. The response lists every bad line and why. |
| Events return `401` / `403` | Revoked or wrong key; a secret key cannot send events. |
| `slurp sync` reports a gap, or `slurp health` reports import problems | Archives older than `RETENTION_DAYS` were deleted before this database read them, or an event reused an id with different content, or a line had the wrong shape. Sync never stops on these: each is a row in `_slurp.problems` (`SELECT * FROM _slurp.problems`), and the first copy of a reused id is kept. |
