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
| `describe_schema` | The `events` columns, every event name with its count and first and last time, event types, the helper views and macros, and the project's shared definitions. Call this first. |
| `definitions` | The project's shared definitions from `slurp/definitions/` (TEMP macros and views loaded into every `sql` call and report), with parameters and descriptions; pass `name` for one definition's SQL. Names the file of a definition that does not load. See [Project definitions](cli.md#project-definitions). |
| `sql` | One read-only DuckDB statement; up to 1000 rows (`truncated` says if there were more); 60 second limit. |
| `status` | Project, database, event count and the last sync. |
| `sync` | Download new archives from your Worker (events are readable about 10 minutes after they are sent). `now: true` asks the Worker to publish what it has buffered first (needs the admin token). Events the import set aside are counted in its output. |
| `health` | Data-quality checks: spelling variants of event names, bad clocks, bots, double tracking, and anything the import set aside (`_slurp.problems`). |
| `report_check`, `report_build` | Validate a Markdown report, then build `report.html` (and `report.png`, optionally `report.pdf`) into a new folder. |
| `send_event`, `identify` | **Only with `--allow-send`.** Write to the real event stream through the project's `mcp` source key; each event has an `id`, and its `sender` is `mcp`. |

**Reading is sandboxed.** The server runs DuckDB read-only with external file access switched off and its settings locked, so SQL an agent writes cannot read local files (`read_csv('/etc/...')` is refused) or change its own limits. `slurp sql` on the command line is deliberately not sandboxed, because joining a local CSV there is a feature.

**Sending is off by default.** An agent that sends made-up events would pollute your analytics, so `send_event` and `identify` exist only when you start the server with `--allow-send`, and every event they write has `sender = 'mcp'`, so you can filter it out (`WHERE sender <> 'mcp'`). They need the saved admin connection to get that key.

Protocol: the server speaks MCP versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. If a client asks for another version it is answered with 2025-11-25 and the client decides whether to continue; requests that are not valid JSON-RPC 2.0 get a protocol error, and tools are refused until the client has sent `initialize`. It does not yet act on a client's cancel notification: a running query or report finishes first. The newer stateless protocol version (2026-07-28) is not implemented.

Tested: the server is exercised end to end over stdio in this repository's tests and with the official MCP Inspector client. The configuration snippets for Claude Code, Claude Desktop, Cursor, Windsurf and Codex follow those tools' documented formats but have not been run here. Not available yet: an HTTP transport, which cloud-hosted agents (for example xAI's Grok API) would need because their servers cannot reach a local stdio process. Bots with their own terminal can instead install and run the CLI on their own machine.

### Bots that run commands

An agent that can run a shell (Claude Code, Codex, a Grok or Muse bot with a sandbox) does not need MCP: give it its own revocable read key, and it uses the CLI. See [bot access](cli.md).

## Goal-driven improvement

The public [agent guides](https://slurp.run/agents/) cover local coding agents and CLI workspace recipes for Grok Bot and Meta's personal Muse agent. Install the skill bundle with `slurp agent setup --out .agents/skills/slurp --all` and ask your agent to read the Slurp skill.

For improvement work, the skill asks for missing product priorities and keeps agreed goals, measurement plans, dated learnings, and the next check in `slurp/GOALS.md`. SQL definitions and full reports remain in their existing folders. Each invocation resumes from that file; recurring execution belongs to the agent's routines or an external scheduler. Repository access and release permissions are configured separately from Slurp analytics access.

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
