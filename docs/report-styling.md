# Report themes and templates

A report's look has two independent parts:

- **Theme**: the colors. A built-in id such as `pro-light`, `pro-dark`, `solarized`, `gruvbox-light`, `nord` or `monokai`, or your own `.json` file. Charts use the theme's series colors too.
- **Template**: the page layout and typography, as one `.css` file. `grid` is built in.

The type is Geist Mono unless a template asks for sans. The same CSS makes the HTML you open in a browser and the PNG and PDF, so templates stick to properties both understand (see [limits](#limits)).

## Choose a look

```sh
slurp report build report.md --out out --theme solarized          # a built-in theme
slurp report build report.md --out out --dark                     # short for --theme pro-dark
slurp report build report.md --out out --theme ./my-theme.json    # your own
slurp report build report.md --out out --style ./my-template.css  # your own template
slurp report build report.md --out out --css ./tweaks.css         # extra CSS appended last
```

A report can set its own defaults in front matter. Paths are relative to the report file, and the command line wins:

```yaml
---
theme: ./my-theme.json
style: ./my-template.css
purpose: Why export completion dropped after v1.2.4   # one line, shown in the top bar
date: Nov 7, 2026                                      # top bar; defaults to the day you build
---
```

Without `purpose`, the top bar shows the report's first `# Heading`.

List the built-in theme ids with `slurp report show list`. Print one to copy and edit with `slurp report show theme pro-light` or `slurp report show style grid`.

## Write a theme

A theme is a JSON file. Four fields are enough; the rest are derived:

```json
{
  "name": "Paper",
  "bg": "#fffaf0",
  "fg": "#222222",
  "accent": "#c2410c",
  "series": ["#c2410c", "#0f766e", "#7c3aed", "#ca8a04", "#2563eb"]
}
```

Or start from a built-in and change a few colors:

```json
{ "extends": "pro-dark", "name": "Midnight", "bg": "#0b1020", "accent": "#7dd3fc" }
```

| Field | Meaning | If omitted |
|---|---|---|
| `bg`, `fg` | page background and text | required |
| `accent` | metric numbers and highlights | required |
| `series` | 1 to 20 chart colors, in order | required |
| `scheme` | `light` or `dark` | from the background |
| `border` | outer lines | `fg` mixed 15% into `bg` |
| `inactive` | muted text (labels, query names) | `fg` mixed 55% |
| `grid` | chart grid, table rules, section rules | `fg` mixed 8% |
| `axisTicks`, `axisLines`, `legend` | chart axes and legend text | derived from `fg` |
| `positive`, `negative` | good and bad values | first and second `series` color |
| `tooltipBg`, `tooltipFg` | chart tooltips | `bg` and `fg` |
| `id`, `name` | shown in error messages | derived from `name` |

Colors you type are `#rgb` or `#rrggbb`. A bad value is reported with the file and field name. `slurp report check report.md` validates the report's theme and template too.

## Write a template

Start from the built-in one:

```sh
slurp report show style grid > my-template.css
```

A template is plain CSS. Write `%TOKENS%` where a theme color goes:

| Token | Theme color |
|---|---|
| `%BG%` `%FG%` | background, text |
| `%MUTED%` | `inactive` |
| `%LINE%` | `border` |
| `%GRID%` | `grid` |
| `%AXIS%` | `axisLines` |
| `%ACCENT%` | `accent` |
| `%NEG%` | `negative` |
| `%S1%` `%S2%` | first and second series color |
| `%BRAND%` | Slurp red, for the top bar |
| `%FONT%` | the font stack |

An optional first comment sets options for the template, one per line:

```css
/* slurp-template
   font: mono                  mono (Geist Mono, the default) or sans (Geist)
   chart-widths: 782 382 250   pixel width of a full, half and third width chart
   default-theme: pro-light    used when nothing else picks a theme
*/
```

The page markup your CSS styles:

```text
main
  .bar                          the top bar: .brand (b), .purpose, .date
  .text                         Markdown prose (h1, p, blockquote, ...)
  .row                          groups consecutive half or third width blocks
    section.metric|chart|table  (+ .half or .third)
      header                    h2 (span.n "§1" + title) and span.q (the query name)
      .body                     a metric (p.label, strong.value), a table, or an svg chart
```

Table cells with numbers have `class="num"`. Set a block's width in its fence: `width: half` or `width: third`. A row holds two halves or three thirds.

Look at `examples/styles/` for a theme with four fields (`paper.json`), one that extends a built-in (`midnight.json`) and a complete template (`ledger.css`). `node examples/demo/build-showcase.mjs styles` builds the flagship report with each.

### Limits

PNG and PDF are laid out by Takumi, which understands a subset of CSS. Use `display:flex` with explicit `.row` containers and `flex:1`. Avoid `flex-wrap`, `grid` spans that rely on auto-placement, and `position`. If your template looks right in the browser but not in the PNG, simplify the layout; the HTML is the primary output.
