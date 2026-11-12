import { siteUrl, githubUrl, defaultBranch } from './links.mjs';

export const connectPrompt = `Help me connect Slurp to my app so you can use real usage, errors, and feedback to improve it.

Start by reading:
- Product overview and prerequisites: ${siteUrl}/index.md
- Setup and capture instructions: ${siteUrl}/docs/
- Agent connection recipes: ${siteUrl}/agents/
- Slurp skill: ${githubUrl}/blob/${defaultBranch}/crates/slurp-cli/skills/slurp/SKILL.md
Follow the skill's linked references when relevant. Use the current docs rather than guessing commands.

1. Find the app repository and inspect its existing Slurp configuration, installed skill, instrumentation, and slurp/GOALS.md. If the app is unclear, ask me which repository to use.
2. If Slurp is already connected, reuse it. Run slurp status and inspect the existing project before making changes. If it is a fresh setup, check CLI, Node, DuckDB, and Cloudflare prerequisites and follow the quickstart. Ask me for missing setup choices or required sign-in. Don't create a duplicate project.
3. If you run on another machine, use its own app checkout and a separate revocable project read key supplied privately as SLURP_TOKEN. Ask me for the backend URL and project ID if missing. Don't ask me to paste secrets into chat. If terminal or repository access is unavailable, explain the missing access and give me a concrete handoff to my coding agent; don't pretend setup succeeded.
4. Once the workspace is initialized, install the skills with:
   slurp agent setup --out .agents/skills/slurp --all
   Read .agents/skills/slurp/SKILL.md. Preserve existing skill edits rather than overwriting them with --force.
5. Reuse our agreed goals. If none are recorded, ask what matters most: revenue, meaningful usage, retention, or reliability. Save the agreed goals and measurement plan in slurp/GOALS.md.
6. Inspect existing events and code. Reuse tracking where possible, add only missing instrumentation, and verify collection. Sync, check data health and schema, then investigate one useful question. If no real events exist yet, report that and verify instrumentation instead of inventing findings.
7. Prepare a scoped improvement with tests, working within my existing permissions. Record dated learnings, evidence links, limitations, and the next check in GOALS.md. Keep shared SQL in slurp/definitions/ and full reports in slurp/reports/.

Tell me what is connected, what you verified, and the next useful action. After a change reaches users, measure the result before choosing another improvement. Once a first run works, discuss a suitable follow-up cadence; don't silently create a background job or grant yourself release permissions.`;

export const grokPrompt = `Grok Bot: help me set up a product improvement workflow for my app. Use your terminal and persistent workspace if available. If code changes require a connected coding agent, coordinate that agent in the same repository and keep slurp/GOALS.md as shared context. After the first verified run, help me choose a routine cadence using the scheduling tools available to you.\n\n${connectPrompt}`;

export const musePrompt = `Muse: help me set up a product improvement workflow for my app. Check whether your environment can run terminal commands and keep a persistent app checkout. If not, coordinate a coding agent on a machine that can, and give me the exact setup handoff it needs. Keep goals and findings in the app's slurp/GOALS.md. After one verified run, help me choose follow-up checks using scheduling tools available in my account.\n\n${connectPrompt}`;
