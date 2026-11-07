# Agents, MCP and notifications

How other tools talk to your Slurp project: AI clients through MCP, and Slack or Discord for posting results. Sending events *into* Slurp from your app is covered in [SDKs and compatibility](sdks.md).

## MCP: let your AI client read your events

`slurp mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio for the project in the current folder (or `--project PATH`). Any MCP client can then look up your events, run read-only SQL and build reports, with no copy and paste.

Add it to your client. Use an absolute path so it works from any folder:

```sh
# Claude Code
claude mcp add slurp -- slurp mcp --project /path/to/your/project
```

```json
// Claude Desktop (claude_desktop_config.json), Cursor (.cursor/mcp.json), Windsurf (mcp_config.json)
{ "mcpServers": { "slurp": { "command": "slurp", "args": ["mcp", "--project", "/path/to/your/project"] } } }
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.slurp]
command = "slurp"
args = ["mcp", "--project", "/path/to/your/project"]
```

Tools:

| Tool | What it does |
| --- | --- |
| `describe_schema` | The `events` columns, every event name with its count and first and last time, event types, and the helper views and macros. Call this first. |
| `sql` | One read-only DuckDB statement; up to 1000 rows (`truncated` says if there were more); 60 second limit. |
| `status` | Project, database, event count and the last sync. |
| `sync` | Download new archives from your Worker (events are readable about 10 minutes after they are sent). |
| `health` | Data-quality checks: spelling variants of event names, bad clocks, bots, double tracking. |
| `report_check`, `report_build` | Validate a Markdown report, then build `report.html` (and `report.png`, optionally `report.pdf`) into a new folder. |
| `send_event`, `identify` | **Only with `--allow-send`.** Write to the real event stream through the project's publishable key; records carry `context.source = "mcp"`. |

**Reading is sandboxed.** The server runs DuckDB read-only with external file access switched off and its settings locked, so SQL an agent writes cannot read local files (`read_csv('/etc/...')` is refused) or change its own limits. `slurp sql` on the command line is deliberately not sandboxed, because joining a local CSV there is a feature.

**Sending is off by default.** An agent that sends made-up events would pollute your analytics, so `send_event` and `identify` exist only when you start the server with `--allow-send`, and every record they write is tagged so you can filter it out (`WHERE context->>'source' IS DISTINCT FROM 'mcp'`).

Tested: the server is exercised end to end over stdio in this repository's tests and with the official MCP Inspector client. The configuration snippets for Claude Code, Claude Desktop, Cursor, Windsurf and Codex follow those tools' documented formats but have not been run here. Not available yet: an HTTP transport, which cloud-hosted agents (for example xAI's Grok API) would need because their servers cannot reach a local stdio process.

### Bots that run commands

An agent that can run a shell (Claude Code, Codex, a Grok or Muse bot with a sandbox) does not need MCP: give it its own revocable read key, and it uses the CLI. See [bot access](cli.md).

## Slack and Discord

`slurp notify` posts a message, and optionally a report image, to Slack or Discord. Credentials come from the environment (never command-line arguments):

| Target | Environment | Can attach a file? |
| --- | --- | --- |
| Slack bot | `SLACK_BOT_TOKEN` (scopes `chat:write` and `files:write`) and `--channel` (the channel id, like `C0123ABCD`; invite the bot to the channel) | Yes |
| Slack webhook | `SLACK_WEBHOOK_URL` (an `https://hooks.slack.com/...` incoming webhook) | No: a webhook can only post text |
| Discord webhook | `DISCORD_WEBHOOK_URL` (an `https://discord.com/api/webhooks/...` URL) | Yes (messages are limited to 2000 characters) |

```sh
slurp notify slack --channel C0123ABCD --text "Weekly report" --file out/report.png
slurp notify slack --text "Signups are up 12% this week"        # webhook, text only
slurp notify discord --text "Weekly report" --file out/report.png
echo "multi-line text from a pipe" | slurp notify slack --channel C0123ABCD --text -
```

Webhook URLs on any other host are refused, so a mistyped variable cannot send your numbers somewhere else. Slack's file upload uses the current external-upload API (`files.getUploadURLExternal` then `files.completeUploadExternal`); the old `files.upload` was retired by Slack in November 2025.

Tested against a fake Slack and Discord server in this repository's tests (the exact requests and error handling); not yet against a real workspace.

### A scheduled report

Slurp does not run a scheduler; use cron, launchd or a scheduled coding agent. Save this as `weekly.sh`:

```sh
#!/bin/sh
set -e
cd /path/to/your/project
slurp sync
out="$(mktemp -d)/weekly"
slurp report build reports/weekly.md --out "$out" --png
slurp notify slack --channel C0123ABCD --text "Weekly product report" --file "$out/report.png"
```

and run it every Monday at 9:00 with `0 9 * * 1 SLACK_BOT_TOKEN=xoxb-... /path/to/weekly.sh` in `crontab -e` (keep the token in a secret store or a file only you can read, not in the crontab if the machine is shared). A report that fails `slurp report check` makes the script stop before anything is posted.
