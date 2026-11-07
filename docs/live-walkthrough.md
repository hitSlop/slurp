# Live walkthrough

Send six events to your own Worker, wait for the next archive, sync them into DuckDB and open a local report. It assumes you have deployed the Worker ([self-hosting](self-hosting.md)).

## 1. Connect this computer

```sh
curl -LsSf https://slurp.run/install | sh      # or: npm install -g @hitslop/slurp
slurp cloud init            # skip if you already deployed: slurp connect <url> --token-stdin
slurp setup
```

`cloud init` deploys your Worker and connects this computer to it. `setup` chooses a library folder and finds or installs DuckDB. An already configured computer shows its settings and a short menu: choose **Done** to keep them. Changing the default library affects future projects only.

## 2. Create and connect a fresh app folder

```sh
mkdir -p ~/slurp-walkthrough
cd ~/slurp-walkthrough
slurp init --name "Slurp live walkthrough"
```

Review and accept the proposed data folder. Init opens a local quickstart page with your SDK snippet and saves the source binding and SDK key for the commands below. There is no source ID or key to copy.

## 3. Send six synthetic events

Use a run marker so later queries isolate this batch even if you repeat the walkthrough. Send each command once; every invocation creates a new event ID.

```sh
SLURP_DEMO_RUN="live-$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s\n' "$SLURP_DEMO_RUN" > .slurp/walkthrough-run
SLURP_DEMO_DATA="{\"demo_run\":\"$SLURP_DEMO_RUN\"}"

slurp send signed_up --user-id demo_alice --data "$SLURP_DEMO_DATA"
slurp send signed_up --user-id demo_bob --data "$SLURP_DEMO_DATA"
slurp send signed_up --user-id demo_cora --data "$SLURP_DEMO_DATA"
slurp send project_created --user-id demo_alice --data "$SLURP_DEMO_DATA"
slurp send project_created --user-id demo_bob --data "$SLURP_DEMO_DATA"
slurp send report_built --user-id demo_alice --data "$SLURP_DEMO_DATA"

slurp sync
```

Successful sends report `Accepted 1 event.` (`accepted: true` in JSON) and your Worker's estimate of its next archive seal. That is a source-level estimate, not confirmation that an individual event is published. An immediate sync may import zero rows. Do not resend events to make them appear.

## 4. Pull after the next seal

Your Worker seals archives about every 10 minutes by default (sooner when a batch reaches 8 MB). Return after the estimated time. This block also works in a new terminal:

```sh
cd ~/slurp-walkthrough
SLURP_DEMO_RUN="$(cat .slurp/walkthrough-run)"

slurp sync
slurp sql "
SELECT event, count(*) AS n, any_value(context->>'\$.geo.country') AS country
FROM events
WHERE json_extract_string(data, '$.demo_run') = '$SLURP_DEMO_RUN'
GROUP BY event
ORDER BY n DESC
"
slurp sync
```

Expected totals: `signed_up = 3`, `project_created = 2`, `report_built = 1`. `country` is filled from Cloudflare's request metadata when the source allows geo enrichment. If the archive is not sealed yet, retry **sync** later. The final sync imports nothing when nothing new was sealed.

## 5. Open a local report

```sh
curl -fsSL https://raw.githubusercontent.com/hitSlop/slurp/master/examples/events.md -o events.md   # a small sample report
slurp report build events.md --out .slurp/output/first
slurp report open .slurp/output/first
```

The sample report shows all events in this project's database. Choose a fresh output folder for another report.

Project commands also work inside the app's subfolders; the nearest initialized parent determines the project. Use `--workspace /absolute/path/to/app` to select an exact project folder. Sending uses its saved binding without opening DuckDB; sync, SQL and reports need the data drive connected.
