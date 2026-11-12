# Product learning loop

Use this reference when choosing what to instrument or improve. Preserve the user's product and priorities.

Start with the job people hire the product to do. Record the valuable outcome, intended audience, natural usage cadence, and whether the analysis unit is a person, account, project, or attempt. Inspect the product and existing events before asking questions.

## Goals and continuity

For improvement work, read `slurp/GOALS.md` and previous reports before choosing a task. If goals are missing or unclear, inspect the product and ask the user what outcome matters most (for example revenue, meaningful usage, retention or reliability). Reuse priorities already stated in the conversation. Do not interrupt a standalone query or report request with goal-setting questions. In unattended work with no agreed goal, record that goal selection needs user input rather than inventing priorities.

After goals are agreed, create or update `slurp/GOALS.md` as ordinary Markdown. Keep current priorities, the measurement plan, dated learnings and the next check in this one file. Record a baseline, target and observation window when known; mark unknowns instead of fabricating numbers. Link to SQL definitions and full reports rather than duplicating them. Keep credentials and raw personal data out of the file. Preserve existing user notes and prior decisions.

Choose the smallest useful measurement plan from existing events and code. Propose missing instrumentation only where it changes a decision. On each invocation, sync and check data quality, investigate the highest-priority agreed goal, prepare a scoped improvement with appropriate tests, and record evidence and the next action. After a release, measure the outcome before starting another change. If evidence is insufficient, record the missing data and when to check again; do not repeatedly rerun unchanged analysis. A scheduled run uses the same workflow, but scheduling belongs to the user's agent or external scheduler—do not create a background service as a side effect.

A compact example (illustrative, not a required schema):

```markdown
# Goals
Help more new users complete their first export.

## Measurement plan
Measure eligible first attempts and completion by release and file size.
Baseline and target: establish after validating current instrumentation.
Definition: definitions/first_export.sql (once created and checked).

## Learnings
- YYYY-MM-DD: Large exports appear to fail more often. See reports/export-health.md.
  Prepared change: investigate timeout handling; no release measured yet.
  Limitation: not enough post-release observations to assess impact.

## Next check
After the change reaches users and enough attempts arrive, compare completion
using the same definition and record the cutoff, counts, and limitations.
```

Maintain a small project-owned product context, metric definitions, and dated decision records. Metric definitions live in `slurp/definitions/` as SQL macros or views (see the main skill), so every query and report computes them the same way; the file's leading comment states eligibility, unit, numerator/denominator, event mapping, window, timezone, observation cutoff, and smallest worthwhile improvement. Keep credentials and raw user data out of these files.

Choose the cheapest credible method: reproduce a deterministic bug; observe a user attempting a confusing task; inspect behavioral evidence to locate an obstacle; use interviews to investigate why; prepare a randomized experiment when a causal question and traffic warrant it. Correlation between activation and retention does not establish which activation step causes retention.

Instrument meaningful starts, outcomes and repeat value before adding click events. Include stable actor/account and attempt IDs, release/schema version, outcome, duration and relevant error category. Capture eligible non-completers. An absent outcome may be unfinished, delayed, abandoned or uninstrumented.

Investigate, instrument, test and prepare changes within the user's scope. Human approval is required before production experiments and releases. Do not create a background agent service or launch experiments as a side effect of analysis.

For each decision preserve the hypothesis, SQL, source/checkpoint, cutoff, counts, findings, uncertainty, prepared change and next question. The learning loop remembers evidence in project files; it does not train model weights.

Useful foundations: [HEART](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/), [Opportunity Solution Trees](https://www.producttalk.org/opportunity-solution-trees/), [Next Feature Fallacy](https://andrewchen.com/the-next-feature-fallacy-the-fallacy-that-the-next-new-feature-will-suddenly-make-people-use-your-product/).
