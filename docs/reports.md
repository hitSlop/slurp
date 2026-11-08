# Writing reports

A report is one Markdown file. Prose is Markdown, data comes from named SQL blocks, and `metric`, `table` and `chart` blocks show it. `slurp report build` runs the queries in one read-only snapshot of your DuckDB file and writes a self-contained `report.html`, plus a PNG and PDF on request. Look at [`examples/demo/`](../examples/demo) for finished ones (retention, activation, recovery, engagement, export health) and at [report-styling.md](report-styling.md) to change colors or the page template.

```sh
slurp report check report.md                       # find every mistake first
slurp report build report.md --out out/week-45 --png --pdf
slurp report open out/week-45
```

## The file

````markdown
---
purpose: Do new users come back in the weeks after signup   # one line shown in the top bar
extensions: [behavioral]                                   # optional, see "Behavioral SQL" in cli.md
params:
  days: {type: number, default: 30}                        # referenced as $days in SQL, set with --param days=7
---

# A title

Prose, **bold**, lists, tables, links, `code`.

```sql by_week
SELECT date_trunc('week', timestamp) AS week, count(*) AS events FROM events GROUP BY 1 ORDER BY 1
```

```chart
query: by_week
title: Events per week
spec: {mark: line, encoding: {x: {field: week, type: temporal}, y: {field: events, type: quantitative}}}
```
````

Front matter keys: `purpose`, `date`, `theme`, `style`, `params`, `extensions`. Unknown keys give a warning.

## Blocks

Every block needs `query: NAME`, the name of a ` ```sql NAME ` block. Blocks must be at the top level of the file, not inside a list or a quote. Any block takes `title:` and `width: full | half | third` (consecutive halves, or thirds, share a row).

| Block | Keys | Notes |
|---|---|---|
| `metric` | `field`, `label`, `decimals`, `prefix`, `suffix`, `compact` | The query must return exactly one row; `field` is the column to show. |
| `table` | `limit` (default 100), `formats` | Shows the first `limit` rows and says how many there are. A table may return more than 1,000 rows; charts and metrics may not. |
| `chart` | `spec` | A [Vega-Lite](https://vega.github.io/vega-lite/) spec without a `data` section: the query result is the data. Aggregate in SQL; a chart query returns at most 1,000 rows. A chart with no rows shows "No rows match this query". |

### Number formats

Numbers read naturally by default: thousands separators in metrics (and from 10,000 in tables, so years stay `2026`), no trailing `.0`, at most two decimals. Change them per metric, or per table column with `formats`:

```yaml
field: completion
suffix: "%"            # 92.4 becomes 92.4%
decimals: 1
```

```yaml
formats:
  revenue: {prefix: "$", decimals: 2}
  users: {compact: true}      # 1234567 becomes 1.2M
```

Non-finite results (such as a division by zero) show as `—`.

## Markdown

Supported: headings, paragraphs, emphasis, strikethrough, inline code, code blocks, links, lists, tables, block quotes (styled as a callout), horizontal rules and `data:` images. Not supported, and shown as plain text: task lists, footnotes, raw HTML (it is always escaped), remote images.

## Checking a report

`slurp report check` finds every problem in one pass and names the line and the block:

```
the report has 2 problems:
  line 14, chart "Retention": the chart reads field `weak`, which is not a column of query `cohorts`. Did you mean `week`? Its columns: cohort, week, retained.
  line 31, metric (query `headline`): unknown key `feild`, it is ignored. Did you mean `field`?
```

Inside a project it also runs each query's `DESCRIBE` (no data is read) to check the SQL, the columns that metrics, tables and charts use, and compiles each chart spec. Outside a project it checks the structure only. `build` runs the same check first, and a query that only fails when it runs (a bad cast) is reported by name and line. Warnings (unused queries, unknown keys, low-contrast themes, characters the PNG font cannot draw) do not stop a build; they are returned in the build output.

## HTML, PNG and PDF

The HTML is the primary output: it adapts to narrow screens and prints cleanly, and hovering (or tapping) a chart mark shows its data in a small tooltip, with a plain browser tooltip as the fallback when scripts are blocked. The tooltip text comes from the mark's description, which Vega-Lite builds from the fields you encode; set `description:` in a mark's `encoding` to write your own. A whole line is one mark, so to hover its points use `mark: {type: line, point: true}` or add a point layer. The only script in the file is allowed by its SHA-256 in the report's Content-Security-Policy; the PNG and PDF carry none of this. The PNG and PDF are laid out at 840 px (the PNG is drawn at twice that density, 1680 px wide, so it stays sharp on high-density screens and in chat) with the fonts bundled in Slurp (Geist and Geist Mono), so characters they do not contain (CJK, Arabic, emoji) appear as empty boxes there; `build` warns when it sees any, and the HTML is not affected. Long text and wide tables wrap instead of being cut off.

Chart compiler warnings and notices about data removed by chart transforms are returned by `build`, with the chart name and its source line. Labels are measured using the bundled fonts before chart layout, and ordinary PDF chart lines, shapes and text remain vector graphics.
