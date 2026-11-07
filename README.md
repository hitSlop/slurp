# Slurp

Bring your events home. Capture application events into **your own Cloudflare account**, sync them into a local DuckDB file, and give your coding agent raw data for product analysis and reports.

```
your app ──► Worker + Durable Objects ──► R2 archives      (in your Cloudflare account)
                                              │
                              slurp sync ◄────┘   (verified, idempotent)
                                   │
                                   ▼
            DuckDB on your machine ──► SQL, reports, your coding agent
```

No servers to run, no data leaving your account. The Cloudflare Free plan is enough to start; see the cost comparison on the website (`apps/site`, page "Self-host").

## Quickstart

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FhitSlop%2Fslurp%2Ftree%2Fmain%2Fbackend)

One click deploys the Worker, Durable Objects and R2 bucket to your Cloudflare account (you choose an `ADMIN_TOKEN`). Then open the Worker's address: it shows the command that connects the CLI. Or do it all from a terminal:

```sh
# 1. Build the CLI, then deploy your Worker (needs a Cloudflare account and Node 20+)
cargo build -p slurp-cli
export PATH="$PWD/target/debug:$PATH"
slurp cloud init             # logs in, creates the bucket, deploys the Worker, connects this computer
slurp setup                  # once per computer: library folder and DuckDB

# 2. In your app
cd /path/to/your/app
slurp init --name "My app"   # connects this app, opens its private quickstart
slurp send signed_up --user-id demo_alice --data '{"demo":true}'
slurp sync                   # archives are sealed about every 10 minutes
slurp sql 'SELECT event, count(*) AS n FROM events GROUP BY event'
```

Each project binds one source to one DuckDB file, stored locally or on an external drive. SQL, report definitions and project metadata stay with your app. No daemon is required. DuckDB 2.x is used for analysis.

## Repository

| Path | What |
|---|---|
| `backend/` | The Worker (TypeScript): ingest, archives, control plane. Self-contained so it can be deployed on its own. |
| `crates/` | Rust CLI (`slurp-cli`), client and archive reader (`slurp-client`), Markdown reports (`slurp-document`, `slurp-render`) |
| `packages/sdk-js` | JavaScript SDK |
| `apps/site` | The public site (home, docs, self-host page, cost comparison) |
| `apps/setup` | The private offline setup page `slurp init` opens (built into the CLI as `setup.html`) |
| `docs/` | [Documentation](docs/README.md) |

## Development

```sh
pnpm install                      # website, landing, SDK
pnpm --filter slurp-setup build   # the quickstart page the CLI embeds (crates/slurp-cli/assets/setup.html)
pnpm --filter slurp-site build
cargo test --workspace
(cd backend && npm install && npm test)   # Worker tests under wrangler dev, incl. the real CLI
(cd packages/sdk-js && node --test test/*.test.ts)
backend/api/generate.sh --check   # regenerate webrpc clients (needs Go; webrpc-gen is pinned in the script)
```

The CLI contract test needs `cargo build -p slurp-cli` and a DuckDB 2 executable (`SLURP_DUCKDB`, default `~/.slurp/bin/duckdb`); it skips cleanly without them.

## License

MIT. See [LICENSE](LICENSE).
