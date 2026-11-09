# Product learning loop

Use this reference when choosing what to instrument or improve. Preserve the user's product and priorities.

Start with the job people hire the product to do. Record the valuable outcome, intended audience, natural usage cadence, and whether the analysis unit is a person, account, project, or attempt. Inspect the product and existing events before asking questions.

Maintain a small project-owned product context, metric definitions, and dated decision records. Metric definitions live in `slurp/definitions/` as SQL macros or views (see the main skill), so every query and report computes them the same way; the file's leading comment states eligibility, unit, numerator/denominator, event mapping, window, timezone, observation cutoff, and smallest worthwhile improvement. Keep credentials and raw user data out of these files.

Choose the cheapest credible method: reproduce a deterministic bug; observe a user attempting a confusing task; inspect behavioral evidence to locate an obstacle; use interviews to investigate why; prepare a randomized experiment when a causal question and traffic warrant it. Correlation between activation and retention does not establish which activation step causes retention.

Instrument meaningful starts, outcomes and repeat value before adding click events. Include stable actor/account and attempt IDs, release/schema version, outcome, duration and relevant error category. Capture eligible non-completers. An absent outcome may be unfinished, delayed, abandoned or uninstrumented.

Investigate, instrument, test and prepare changes within the user's scope. Human approval is required before production experiments and releases. Do not create a background agent service or launch experiments as a side effect of analysis.

For each decision preserve the hypothesis, SQL, source/checkpoint, cutoff, counts, findings, uncertainty, prepared change and next question. The learning loop remembers evidence in project files; it does not train model weights.

Useful foundations: [HEART](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/), [Opportunity Solution Trees](https://www.producttalk.org/opportunity-solution-trees/), [Next Feature Fallacy](https://andrewchen.com/the-next-feature-fallacy-the-fallacy-that-the-next-new-feature-will-suddenly-make-people-use-your-product/).
