# Slurp measures slurp.run

The landing page uses Slurp itself. Its events go to a Worker in the maintainers' own Cloudflare account (`events.slurp.run`), into a project called `slurp-site`, and the agent loop from the README runs on them: sync into DuckDB, query with SQL, write a report.

This folder is that setup, kept as a worked example.

- [`reports/site.md`](reports/site.md) is the report source. Everything in it is one SQL query; `slurp report build reports/site.md` makes the page.
- Built reports are committed under `reports/out/` as the site gathers data, so you can see what a real one looks like.
- `.slurp/` (the local binding to the project, with absolute paths) is not committed.

## What the site captures

| Event | When | Properties |
|---|---|---|
| `page_view` | Once per page load | `path`, `referrer` (origin and path only), `utm_source`, `utm_medium`, `utm_campaign` if present |
| `deploy_clicked` | The Deploy to Cloudflare button | `where` (which page) |
| `install_copied` | An install command's Copy button | none |
| `feedback` | The feedback widget's form | `message`, `rating`, `path` |

Every event also carries the SDK's context: user agent, language, time zone, the page's address **without its query string or fragment**, and a random `anonymous_id` the SDK keeps in the browser's local storage. There is no cookie, no fingerprinting, no IP address stored (Cloudflare's coarse country and city are added by the Worker), and no text a visitor typed except in the feedback form. Feedback messages are read by the maintainers and are not published; the report shows only their count and average rating.

The code is [`apps/site/src/lib/slurp.ts`](../apps/site/src/lib/slurp.ts), with the tracked fields pinned by [a test](../apps/site/test/measure.test.mjs). The key in [`links.mjs`](../apps/site/src/lib/links.mjs) is a publishable key: it can only add events.

## Run it yourself

```sh
slurp connect https://events.slurp.run --token-stdin   # needs the admin token: only the maintainers have it
slurp init --connect slurp-site                        # in this folder
slurp sync
slurp report build reports/site.md --out reports/out/$(date +%F) --png
```

To measure your own site the same way, see [the JavaScript SDK](../docs/sdks.md) and `mountFeedback`.
