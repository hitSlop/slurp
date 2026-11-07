# Experiments with limited traffic

Predeclare a falsifiable hypothesis, stable randomization unit, eligible population, primary outcome, guardrails, practical effect threshold, observation window and stopping rule. Choose accounts when shared experiences cause interference. Repeated events from one person are not independent users.

Distinguish assignment from exposure. Use intention-to-treat as the default estimand for assigned eligible units; any triggered analysis needs a treatment-independent eligibility definition. Do not filter to successful users or only people who produced the desired outcome. Validate missing exposure logging, cross-variant contamination and sample-ratio mismatch before interpreting effects.

Prepare per-unit outcomes in SQL. Use an established, validated inference implementation; do not invent p-values in SQL or improvise formulas. Report absolute effects, intervals, denominators, maturity and guardrails. Use a predefined fixed horizon or a valid sequential method, not stop-when-significant peeking. Label post-hoc segments exploratory. Before/after release comparisons alone do not identify causal effects.

CUPED requires suitable pre-treatment history. New users may have none. Small samples cannot resolve arbitrarily small effects; inconclusive and instrumentation_gap are useful outcomes. Prefer task observation or bug reproduction when they answer the question faster.

Prepare code, tests, assignment/exposure logging, scorecard and rollback instructions. Obtain human approval before production experiments or releases.

Sources: [Microsoft design guidance](https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-pre-experiment-stage/), [SRM](https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/), [sequential testing](https://www.growthbook.io/insights/sequential-testing), [CUPED](https://ai.stanford.edu/~ronnyk/2013-02CUPEDImprovingSensitivityOfControlledExperiments.pdf).
