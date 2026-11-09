# Slurp documentation

| Document | Purpose |
|---|---|
| [Self-hosting](self-hosting.md) | Deploy the Worker to your Cloudflare account, settings, security, operations, costs |
| [SDKs and compatibility](sdks.md) | JavaScript and React Native SDKs, plain HTTP, Swift through Segment's analytics-swift; use your Segment or Sentry SDK by changing a URL |
| [Webhooks](webhooks.md) | GitHub releases and deploys, Stripe and RevenueCat events and any other webhook, signed and stored whole |
| [Agents, MCP and notifications](integrations.md) | `slurp mcp` for Claude Code, Cursor, Codex and more; Slack and Discord posting; a scheduled report |
| [Writing reports](reports.md) | The report file, blocks, number formats, checking and output |
| [Project definitions](cli.md#project-definitions) | Shared business definitions (active people, activation) as plain SQL files in `slurp/definitions/`, loaded into every query, report and agent session; [examples](../examples/definitions) |
| [Report themes and templates](report-styling.md) | Choose or write the colors and page template of a report |
| [How the connection works](connection.md) | Admin token, secret and publishable keys and their sources, the saved connection, `whoami`, logout, revoking and rotating |
| [CLI](cli.md) | Setup, per-app init, storage, credentials, SQL, reports and agents |
| [Live walkthrough](live-walkthrough.md) | Send six events, publish them, sync and report |
| [Architecture](architecture.md) | Data flow, contracts and the durability design |
| [Wire contracts](contracts.md) | What the Worker, the CLI and the SDKs agree on: keys, the record and envelope formats, the control API, import rules, SDK delivery, versions and upgrades |
| [Releasing](releasing.md) | For maintainers: cutting a release of the CLI, the Worker and the SDKs, checking it, and recovering from a bad one |
| [Agent skills](../crates/slurp-cli/skills/slurp/SKILL.md) | Instrumentation, SQL analysis and the product learning loop |
