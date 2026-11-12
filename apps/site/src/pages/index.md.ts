import { installShell, installNpm, githubUrl, siteUrl } from '../lib/links.mjs';
import { count, freePlanEventsPerMonth, headlineVolume, cloudflareCost } from '../lib/pricing.mjs';
export const prerender = true;
export function GET() {
  return new Response(`# Slurp: product analytics for your coding agent

Slurp gives coding agents real usage, errors, and feedback so they can investigate problems, prepare improvements, and measure results. Set goals, choose what to track, learn, improve, and repeat.

## When to use Slurp
Use it when you need evidence about activation, retention, failed flows, or the impact of a release. Events live in your own Cloudflare account and sync into local DuckDB. Query with SQL, use JSON CLI output or local stdio MCP, and build reports from Markdown with SQL attached.

## Get started
Prerequisites: macOS or Linux, Node 20+, a Cloudflare account, and DuckDB 2.x. Setup can help install DuckDB interactively; unattended runs need prerequisites supplied in advance.

\`\`\`sh
${installShell}
# Alternative installation:
${installNpm}
slurp cloud init
slurp setup
cd /path/to/your/app
slurp init --name "My app"
slurp agent setup --out .agents/skills/slurp --all
\`\`\`

Follow the [quickstart](${siteUrl}/docs/) to add the SDK and send real app events. Then:

\`\`\`sh
slurp sync
slurp health
slurp describe
slurp --json sql 'SELECT event, count(*) AS n FROM events GROUP BY event'
\`\`\`

Ask the agent to read the installed Slurp skill, establish your goals, and keep agreed goals, dated learnings, and the next check in slurp/GOALS.md. Reuse SQL definitions in slurp/definitions/ and save reports in slurp/reports/.

## Connect an agent
[Agent guides](${siteUrl}/agents/) cover Claude Code, Codex, Cursor, Grok Bot, Muse, and other shell-capable agents. Remote bots use a separately revocable project read key in SLURP_TOKEN. Repository access and release permissions are configured separately. Never put credentials in prompts, reports, or source control.

## Costs and limits
Slurp is open source and adds no fee. Cloudflare's free plan covers about ${count(freePlanEventsPerMonth())} events/month under our assumptions; ${count(headlineVolume)} events/month is estimated at about $${Math.round(cloudflareCost(headlineVolume))}. You pay Cloudflare directly. See [cost assumptions](${siteUrl}/self-host/#cost).

Archives normally publish about every 10 minutes. Slurp does not run a scheduler: recurring execution belongs to your agent or external scheduler. MCP is local stdio, not a hosted HTTP endpoint. Before/after comparisons do not prove causality. Production releases follow your configured approval process.

## Evidence and references
- [Interactive sample report: export failures](${siteUrl}/reports/export-health/) — fictional sample data, not customer results.
- [SDK and connection recipes](${siteUrl}/connections/)
- [CLI reference](${githubUrl}/blob/master/docs/cli.md)
- [Source and bundled agent skills](${githubUrl})
- [Feedback demo](${siteUrl}/#feedback) — public-site feedback is private and available for our agents to read; no instant response is promised.
`, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
