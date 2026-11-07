//! File-authored reports with embedded SQL and static chart rendering.
use crate::Workspace;
use crate::report_check::Problem;
use anyhow::{Context, Result, bail};
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};
/// A parsed file; queries and presentation remain ordinary authored source.
#[derive(Debug)]
pub struct Document {
    pub queries: BTreeMap<String, String>,
    pub blocks: Vec<(String, String)>,
    pub params: BTreeMap<String, Value>,
    /// Palette id from the front matter (`theme:`).
    pub theme: Option<String>,
    /// Style name from the front matter (`style:`).
    pub style: Option<String>,
    /// One short line about why the report exists (`purpose:`), shown in the top bar.
    pub purpose: Option<String>,
    /// Date shown in the top bar (`date:`); defaults to the day the report is built.
    pub date: Option<String>,
    /// DuckDB community extensions the queries use (`extensions:`), for example `behavioral`.
    pub extensions: Vec<String>,
    /// Source line (1-based) where each entry of `blocks` starts, for error messages.
    pub block_lines: Vec<usize>,
    /// Source line of each named query's fence.
    pub query_lines: BTreeMap<String, usize>,
    /// Problems found while parsing (duplicate queries, fences nested in lists, unknown front matter keys).
    pub problems: Vec<Problem>,
}

/// How a report should look; command-line choices win over the report's own front matter.
#[derive(Debug, Clone, Default)]
pub struct Look {
    /// Shorthand for `--theme pro-dark`.
    pub dark: bool,
    pub theme: Option<String>,
    pub style: Option<String>,
    /// A stylesheet appended after the style's own CSS.
    pub css: Option<std::path::PathBuf>,
}
/// The template and theme a report will use. Command-line values are relative to the current folder; the report's own
/// `style:` and `theme:` are relative to the report file. The command line wins.
pub fn resolve_look(
    doc: &Document,
    look: &Look,
    file: &Path,
) -> Result<(crate::report_style::Style, slurp_render::Theme)> {
    let here = Path::new(".");
    let report_dir = file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(here);
    let style = match (&look.style, &doc.style) {
        (Some(spec), _) => crate::report_style::Style::resolve(spec, here)?,
        (None, Some(spec)) => crate::report_style::Style::resolve(spec, report_dir)?,
        (None, None) => crate::report_style::Style::builtin(),
    };
    let theme = if look.dark {
        slurp_render::Theme::dark()
    } else {
        match (&look.theme, &doc.theme) {
            (Some(spec), _) => crate::report_style::resolve_theme(spec, here)?,
            (None, Some(spec)) => crate::report_style::resolve_theme(spec, report_dir)?,
            (None, None) => crate::report_style::resolve_theme(&style.default_theme, here)?,
        }
    };
    Ok((style, theme))
}

/// Parse named SQL and chart/metric/table fences, preserving prose.
pub fn parse(source: &str) -> Result<Document> {
    let text = source;
    let (front, text) = if let Some(rest) = text.strip_prefix("---\n") {
        let (front, body) = rest
            .split_once("\n---\n")
            .context("unterminated front matter")?;
        (serde_norway::from_str::<Value>(front)?, body)
    } else {
        (json!({}), text)
    };
    // Lines before the body (front matter), so positions in errors are lines of the file the author is editing.
    let line_base = source[..source.len() - text.len()].matches('\n').count();
    let line_at = |offset: usize| line_base + text[..offset].matches('\n').count() + 1;
    let mut problems = vec![];
    if let Some(map) = front.as_object() {
        const FRONT_KEYS: [&str; 6] = ["params", "theme", "style", "purpose", "date", "extensions"];
        for key in map.keys().filter(|k| !FRONT_KEYS.contains(&k.as_str())) {
            problems.push(Problem::warning(
                Some(1),
                "front matter",
                crate::report_check::unknown_key_message(key, &FRONT_KEYS),
            ));
        }
    }
    let theme = front["theme"].as_str().map(str::to_owned);
    let style = front["style"].as_str().map(str::to_owned);
    let purpose = front["purpose"].as_str().map(str::to_owned);
    let date = front["date"].as_str().map(str::to_owned);
    let extensions: Vec<String> = match &front["extensions"] {
        Value::Null => vec![],
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .context("extensions must be a list of names")
            })
            .collect::<Result<_>>()?,
        _ => bail!("extensions must be a list of names"),
    };
    crate::setup::check_extension_names(&extensions)?;
    let mut params = BTreeMap::new();
    if let Some(values) = front["params"].as_object() {
        for (name, def) in values {
            if let Some(v) = def.get("default") {
                params.insert(name.clone(), v.clone());
            }
        }
    }
    let mut queries = BTreeMap::new();
    let mut query_lines = BTreeMap::new();
    let mut blocks = vec![];
    let mut block_lines = vec![];
    let mut cursor = 0;
    let mut fence = None;
    // Depth of lists and block quotes around the current position: a report block must be at the top level.
    let mut nesting = 0usize;
    for (event, range) in Parser::new(text).into_offset_iter() {
        match event {
            Event::Start(Tag::List(_) | Tag::BlockQuote(_)) => nesting += 1,
            Event::End(TagEnd::List(_) | TagEnd::BlockQuote(_)) => {
                nesting = nesting.saturating_sub(1);
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let kind = info.trim().to_string();
                if kind.starts_with("sql ") || matches!(kind.as_str(), "chart" | "metric" | "table")
                {
                    if nesting > 0 {
                        problems.push(Problem::error(
                            Some(line_at(range.start)),
                            &format!("`{kind}` block"),
                            "report blocks (sql, chart, metric, table) must be at the top level of the report, not inside a list or quote. Move this block out and refer to it from the text instead.".into(),
                        ));
                    }
                    if range.start > cursor {
                        block_lines.push(line_at(cursor));
                        blocks.push(("markdown".into(), text[cursor..range.start].into()));
                    }
                    fence = Some((kind, range.start, String::new()));
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                if !dest_url.starts_with("data:") {
                    problems.push(Problem::error(
                        Some(line_at(range.start)),
                        "image",
                        "reports require embedded data images (a data: URL); remote images are not supported".into(),
                    ));
                }
            }
            Event::Text(s) => {
                if let Some((_, _, body)) = &mut fence {
                    body.push_str(&s);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((kind, start, body)) = fence.take() {
                    if let Some(name) = kind.strip_prefix("sql ") {
                        let name = name.trim().to_owned();
                        match queries.entry(name.clone()) {
                            std::collections::btree_map::Entry::Occupied(_) => {
                                problems.push(Problem::error(
                                    Some(line_at(start)),
                                    &format!("query `{name}`"),
                                    format!(
                                        "a query named `{name}` is already defined on line {}; query names must be unique",
                                        query_lines[&name]
                                    ),
                                ));
                            }
                            std::collections::btree_map::Entry::Vacant(slot) => {
                                query_lines.insert(name, line_at(start));
                                slot.insert(body);
                            }
                        }
                    } else {
                        block_lines.push(line_at(start));
                        blocks.push((kind, body));
                    }
                    cursor = range.end;
                }
            }
            _ => {}
        }
    }
    if cursor < text.len() {
        block_lines.push(line_at(cursor));
        blocks.push(("markdown".into(), text[cursor..].into()));
    }
    Ok(Document {
        queries,
        blocks,
        params,
        theme,
        style,
        purpose,
        date,
        extensions,
        block_lines,
        query_lines,
        problems,
    })
}
fn escape(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
/// Render one read-only snapshot to self-contained HTML and optional PNG/PDF.
pub fn build(
    w: &Workspace,
    file: &Path,
    out: &Path,
    dark: bool,
    png: bool,
    pdf: bool,
) -> Result<Value> {
    let look = Look {
        dark,
        ..Look::default()
    };
    build_with_params(w, file, out, &look, png, pdf, &BTreeMap::new())
}
/// Build with explicit scalar parameter overrides.
pub fn build_with_params(
    w: &Workspace,
    file: &Path,
    out: &Path,
    look: &Look,
    png: bool,
    pdf: bool,
    overrides: &BTreeMap<String, Value>,
) -> Result<Value> {
    let text = fs::read_to_string(file)?;
    let mut doc = parse(&text)?;
    let (style, theme) = resolve_look(&doc, look, file)?;
    let w = &w.with_extensions(&doc.extensions)?;
    let palette = theme.palette();
    let extra_css = match &look.css {
        Some(path) => {
            fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
        }
        None => String::new(),
    };
    for (name, value) in overrides {
        anyhow::ensure!(doc.params.contains_key(name), "unknown parameter {name}");
        doc.params.insert(name.clone(), value.clone());
    }
    // Every mistake in the report is reported together, with its line, before anything is rendered.
    let problems = crate::report_check::validate(&doc, Some(w))?;
    if let Some(summary) = crate::report_check::error_summary(&problems) {
        bail!(crate::error::Failure::new(
            crate::error::ErrorCode::InvalidInput,
            summary
        ));
    }
    let mut warnings: Vec<crate::report_check::Problem> = problems;
    warnings.extend(crate::report_check::theme_warnings(palette));
    // A single subprocess/transaction keeps all named queries on one snapshot.
    let mut sql = String::from("BEGIN TRANSACTION READ ONLY;\n");
    sql.push_str(&param_preamble(&doc.params)?);
    for (i, query) in doc.queries.values().enumerate() {
        let query = bind_variables(query, &doc.params)?;
        sql.push_str(&format!(
            "CREATE TEMP TABLE report_{i} AS SELECT * FROM ({query}) LIMIT 1001;\n"
        ));
    }
    sql.push_str("SELECT ");
    if doc.queries.is_empty() {
        sql.push_str("'{}' AS results");
    } else {
        sql.push_str("json_object(");
        for (i, name) in doc.queries.keys().enumerate() {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&format!(
                "{},(SELECT coalesce(json_group_array(t),'[]'::JSON) FROM report_{i} t)",
                crate::literal(name)
            ));
        }
        sql.push_str(")::VARCHAR AS results");
    }
    sql.push_str(", (SELECT coalesce(json_group_array(d),'[]'::JSON) FROM (SELECT * FROM _slurp.deliveries ORDER BY sequence DESC LIMIT 1) d) AS inputs; COMMIT;");
    let result = match w.execute(&sql, true) {
        Ok(result) => result,
        Err(error) => return Err(name_failing_query(w, &doc, error)),
    };
    let results_text = result[0]["results"]
        .as_str()
        .map(|text| crate::null_non_finite(text).into_owned());
    let results = match &results_text {
        Some(text) => serde_json::from_str(text)?,
        None => result[0]["results"].clone(),
    };
    // serde_json maps are sorted by key; the query's own column order is what a reader expects in a table.
    let orders = results_text
        .as_deref()
        .map(column_orders)
        .unwrap_or_default();
    if png || pdf {
        // The PNG and PDF use the bundled fonts only; say so when the report has text they cannot draw.
        let mut text = String::new();
        fn strings(value: &Value, out: &mut String) {
            match value {
                Value::String(s) => {
                    out.push_str(s);
                    out.push(' ');
                }
                Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
                Value::Object(map) => map.values().for_each(|v| strings(v, out)),
                _ => {}
            }
        }
        strings(&results, &mut text);
        for (_, block) in &doc.blocks {
            text.push_str(block);
        }
        text.push_str(doc.purpose.as_deref().unwrap_or_default());
        let missing = slurp_render::undrawable_chars(&text, style.font);
        if !missing.is_empty() {
            let shown: String = missing.iter().take(8).map(|c| format!("{c} ")).collect();
            warnings.push(crate::report_check::Problem::warning(
                None,
                "png/pdf fonts",
                format!(
                    "{} character{} cannot be drawn with the fonts bundled for PNG and PDF and will appear as empty boxes there ({}{}). The HTML report is not affected.",
                    missing.len(),
                    if missing.len() == 1 { "" } else { "s" },
                    shown.trim_end(),
                    if missing.len() > 8 { ", …" } else { "" }
                ),
            ));
        }
    }
    let mut body = String::new();
    let mut renderer = slurp_render::ChartRenderer::new();
    let purpose = doc
        .purpose
        .clone()
        .or_else(|| first_heading(&doc.blocks))
        .unwrap_or_default();
    let date = doc
        .date
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().format("%b %-d, %Y").to_string());
    body.push_str(&format!(
        "<div class=\"bar\"><span class=\"brand\"><b>slurp</b></span><span class=\"purpose\">{}</span><span class=\"date\">{}</span></div>",
        escape(&purpose),
        escape(&date)
    ));
    let mut section_no = 0;
    // Consecutive half / third width blocks share a row; Takumi lays out plain flex rows reliably.
    let mut row: Vec<String> = vec![];
    let mut row_width = String::new();
    fn flush(body: &mut String, row: &mut Vec<String>) {
        if !row.is_empty() {
            body.push_str("<div class=\"row\">");
            body.push_str(&row.join(""));
            body.push_str("</div>");
            row.clear();
        }
    }
    for (kind, body_text) in doc.blocks {
        if kind == "markdown" {
            let html =
                slurp_document::render(&body_text, &doc.params.clone().into_iter().collect());
            let html = html.as_str();
            if html.trim().is_empty() {
                // Whitespace between code fences: not content, and it must not break up a row.
                continue;
            }
            flush(&mut body, &mut row);
            body.push_str("<div class=\"text\">");
            body.push_str(html);
            body.push_str("</div>");
            continue;
        }
        let spec: Value = serde_norway::from_str(&body_text)?;
        let rows = if let Some(name) = spec["query"].as_str() {
            results.get(name).context("unknown query")?
        } else {
            bail!("report block requires query: NAME")
        };
        let rows = rows.as_array().context("query rows")?;
        // A table shows its first rows and says how many there are; a chart or metric must not silently use partial data.
        if rows.len() > 1000 && kind != "table" {
            bail!(
                "query `{}` returned more than 1,000 rows; a report block shows at most 1,000, so aggregate or limit it in SQL",
                spec["query"].as_str().unwrap_or_default()
            )
        }
        section_no += 1;
        let outer = std::mem::take(&mut body);
        let width = spec["width"].as_str().unwrap_or("full");
        body.push_str(&format!(
            "<section class=\"{kind}{}\"><header>",
            if width == "full" {
                String::new()
            } else {
                format!(" {width}")
            }
        ));
        if let Some(title) = spec["title"].as_str() {
            body.push_str(&format!(
                "<h2><span class=\"n\">§{section_no}</span>{}</h2>",
                escape(title)
            ));
        }
        body.push_str(&format!(
            "<span class=\"q\">{}</span></header><div class=\"body\">",
            escape(spec["query"].as_str().unwrap_or_default())
        ));
        match kind.as_str() {
            "metric" => {
                if rows.len() != 1 {
                    bail!(
                        "metric (query `{}`) needs exactly one row but the query returned {}; aggregate it to one row in SQL",
                        spec["query"].as_str().unwrap_or_default(),
                        rows.len()
                    )
                };
                let field = spec["field"].as_str().context("metric field")?;
                let value = rows[0].get(field).with_context(|| {
                    format!(
                        "metric field `{field}` is not a column of query `{}`",
                        spec["query"].as_str().unwrap_or_default()
                    )
                })?;
                let format = crate::report_format::NumberFormat::from_spec(&spec)
                    .map_err(anyhow::Error::msg)?;
                body.push_str(&format!(
                    "<p class=\"label\">{}</p><strong class=\"value\">{}</strong>",
                    escape(spec["label"].as_str().unwrap_or(field)),
                    escape(&format.show(value, 1000.0))
                ));
            }
            "table" => {
                body.push_str("<table>");
                let columns: Vec<String> = spec["query"]
                    .as_str()
                    .and_then(|query| orders.get(query))
                    .cloned()
                    .or_else(|| {
                        rows.first()
                            .and_then(Value::as_object)
                            .map(|row| row.keys().cloned().collect())
                    })
                    .unwrap_or_default();
                // A column is numeric when its first non-null value is, so a NULL in the first row does not misalign it.
                let numeric: Vec<bool> = columns
                    .iter()
                    .map(|name| {
                        rows.iter()
                            .map(|row| &row[name])
                            .find(|v| !v.is_null())
                            .is_some_and(Value::is_number)
                    })
                    .collect();
                let formats: Vec<crate::report_format::NumberFormat> = columns
                    .iter()
                    .map(|name| match spec["formats"].get(name) {
                        Some(format) => crate::report_format::NumberFormat::from_spec(format)
                            .map_err(anyhow::Error::msg),
                        None => Ok(Default::default()),
                    })
                    .collect::<Result<_>>()?;
                if !columns.is_empty() {
                    body.push_str("<tr>");
                    for (name, numeric) in columns.iter().zip(&numeric) {
                        body.push_str(&format!(
                            "<th{}>{}</th>",
                            if *numeric { " class=\"num\"" } else { "" },
                            escape(name)
                        ));
                    }
                    body.push_str("</tr>");
                }
                if rows.is_empty() {
                    body.push_str("<tr><td>No rows match this query.</td></tr>");
                }
                let limit = spec["limit"].as_u64().unwrap_or(100) as usize;
                for row in rows.iter().take(limit) {
                    body.push_str("<tr>");
                    let row = row.as_object().context("row")?;
                    for ((name, numeric), format) in columns.iter().zip(&numeric).zip(&formats) {
                        body.push_str(&format!(
                            "<td{}>{}</td>",
                            if *numeric { " class=\"num\"" } else { "" },
                            escape(&format.show(row.get(name).unwrap_or(&Value::Null), 10_000.0))
                        ));
                    }
                    body.push_str("</tr>");
                }
                body.push_str("</table>");
                if rows.len() > limit {
                    // The query is fetched with LIMIT 1001, so 1001 rows means "more than 1,000".
                    let total = if rows.len() > 1000 {
                        "more than 1,000".to_owned()
                    } else {
                        group_digits(&rows.len().to_string())
                    };
                    body.push_str(&format!(
                        "<p class=\"more\">Showing the first {} of {total} rows. Add <code>limit: N</code> to this block to show more, or aggregate in SQL.</p>",
                        group_digits(&limit.to_string())
                    ));
                }
            }
            "chart" if rows.is_empty() => {
                body.push_str("<p class=\"empty\">No rows match this query.</p>");
            }
            "chart" => {
                let names: Vec<_> = rows
                    .first()
                    .and_then(Value::as_object)
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                let data: Vec<Vec<Value>> = rows
                    .iter()
                    .map(|r| {
                        names
                            .iter()
                            .map(|n| match &r[n] {
                                Value::Number(v) => Value::String(v.to_string()),
                                v => v.clone(),
                            })
                            .collect()
                    })
                    .collect();
                let query = json!({"columns":names.iter().map(|n|json!({"name":n,"type":if rows.iter().any(|r|r[n].is_number()){"DECIMAL"}else{"VARCHAR"}})).collect::<Vec<_>>(),"rows":data,"row_count":rows.len(),"truncated":false,"elapsed_ms":0});
                let chart = renderer.compile(
                    &spec["spec"],
                    &query,
                    slurp_render::CompileOptions {
                        theme: theme.clone(),
                        font: style.font.to_owned(),
                        width: style.chart_width(width),
                        ..Default::default()
                    },
                )?;
                body.push_str(&chart.svg);
            }
            _ => bail!("unsupported block"),
        }
        body.push_str("</div></section>");
        let section = std::mem::replace(&mut body, outer);
        let capacity = match width {
            "half" => 2,
            "third" => 3,
            _ => 1,
        };
        if capacity == 1 || (!row.is_empty() && row_width != width) {
            flush(&mut body, &mut row);
        }
        if capacity == 1 {
            body.push_str(&section);
        } else {
            row_width = width.to_owned();
            row.push(section);
            if row.len() == capacity {
                flush(&mut body, &mut row);
            }
        }
    }
    flush(&mut body, &mut row);
    let font = if style.font == slurp_render::MONO {
        &include_bytes!("../../slurp-render/assets/GeistMonoVariable.ttf")[..]
    } else {
        &include_bytes!("../../slurp-render/assets/GeistVariable.ttf")[..]
    };
    let css = format!(
        "{}{}",
        style.css(palette, &{
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(font)
        }),
        extra_css.replace("</", "<\\/")
    );
    use std::io::Write;
    // The PNG and PDF are drawn from the plain page. The HTML file adds hover details: a <title> on every data mark, and one
    // inline script that the Content-Security-Policy allows by its hash and nothing else.
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'\"><style>{css}</style></head><body><main>{body}</main></body></html>"
    );
    let interactive = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src {}\"><style>{css}{}</style></head><body><main>{}</main><script>{}</script></body></html>",
        crate::report_hover::script_source(),
        crate::report_hover::css(palette),
        crate::report_hover::titles(&body),
        crate::report_hover::SCRIPT
    );
    fs::create_dir_all(out.parent().unwrap_or(Path::new(".")))?;
    let temp = tempfile::tempdir_in(out.parent().unwrap_or(Path::new(".")))?;
    fs::write(temp.path().join("report.html"), &interactive)?;
    if png || pdf {
        let page = renderer.render_page(&html, png, pdf)?;
        if let Some(bytes) = page.png {
            fs::write(temp.path().join("report.png"), bytes)?
        }
        if let Some(bytes) = page.pdf {
            fs::write(temp.path().join("report.pdf"), bytes)?
        }
    }
    let manifest = json!({"version":1,"source":w.source,"generated_at":chrono::Utc::now(),"inputs":result[0]["inputs"]});
    fs::File::create(temp.path().join("manifest.json"))?
        .write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    if out.exists() {
        bail!("output directory exists; choose a fresh --out directory")
    }
    fs::rename(temp.keep(), out)?;
    let mut output = manifest;
    if !warnings.is_empty() {
        output["warnings"] = json!(warnings);
    }
    Ok(output)
}

/// The report's queries run together in one snapshot, so a failure at run time (a cast, a division) does not say which query
/// it was. Run them one at a time to find it, and report it by name and line.
fn name_failing_query(w: &Workspace, doc: &Document, error: anyhow::Error) -> anyhow::Error {
    let Ok(preamble) = param_preamble(&doc.params) else {
        return error;
    };
    for (name, query) in &doc.queries {
        let Ok(bound) = bind_variables(query, &doc.params) else {
            continue;
        };
        let sql = format!("{preamble}SELECT * FROM (\n{bound}\n) LIMIT 1001;");
        if let Err(failure) = w.execute(&sql, true) {
            let line = doc.query_lines.get(name).copied().unwrap_or(1);
            let message = crate::report_check::locate_sql_error(
                &failure.to_string(),
                line.saturating_sub(preamble.matches('\n').count()),
            );
            return anyhow::Error::new(crate::error::Failure::new(
                crate::error::ErrorCode::QueryFailed,
                format!("query `{name}` (the ```sql block on line {line}) failed: {message}"),
            ));
        }
    }
    error
}

/// `SET VARIABLE` statements that make the report's parameters available to its queries.
pub(crate) fn param_preamble(params: &BTreeMap<String, Value>) -> Result<String> {
    let mut sql = String::new();
    for (name, value) in params {
        anyhow::ensure!(
            name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "invalid parameter name"
        );
        let value = match value {
            Value::String(s) => crate::literal(s),
            Value::Null => "NULL".into(),
            Value::Bool(_) | Value::Number(_) => value.to_string(),
            _ => bail!("parameters must be scalar"),
        };
        sql.push_str(&format!("SET VARIABLE {name} = {value};\n"));
    }
    Ok(sql)
}

pub(crate) fn bind_variables(sql: &str, params: &BTreeMap<String, Value>) -> Result<String> {
    let mut out = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                if chars.peek() == Some(&q) {
                    out.push(chars.next().context("escaped quote")?);
                } else {
                    quote = None;
                }
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            out.push(c);
            continue;
        }
        if c == '$' {
            let mut name = String::new();
            while chars
                .peek()
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                name.push(chars.next().context("parameter")?);
            }
            anyhow::ensure!(params.contains_key(&name), "missing parameter {name}");
            out.push_str(&format!("getvariable('{}')", name));
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

/// `1234567` becomes `1,234,567`.
fn group_digits(digits: &str) -> String {
    let (sign, digits) = digits.strip_prefix('-').map_or(("", digits), |d| ("-", d));
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    format!("{sign}{out}")
}

/// Column names of each named query's first row, in the order the query returned them.
fn column_orders(results: &str) -> BTreeMap<String, Vec<String>> {
    use serde::{
        Deserialize, Deserializer,
        de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
    };
    struct Keys(Vec<String>);
    impl<'de> Deserialize<'de> for Keys {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Keys;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a row object")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Keys, A::Error> {
                    let mut keys = Vec::new();
                    while let Some((key, _)) = map.next_entry::<String, IgnoredAny>()? {
                        keys.push(key);
                    }
                    Ok(Keys(keys))
                }
            }
            deserializer.deserialize_map(V)
        }
    }
    struct FirstRow(Vec<String>);
    impl<'de> Deserialize<'de> for FirstRow {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = FirstRow;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("an array of rows")
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<FirstRow, A::Error> {
                    let first = seq.next_element::<Keys>()?.map(|keys| keys.0);
                    while seq.next_element::<IgnoredAny>()?.is_some() {}
                    Ok(FirstRow(first.unwrap_or_default()))
                }
            }
            deserializer.deserialize_seq(V)
        }
    }
    serde_json::from_str::<BTreeMap<String, FirstRow>>(results)
        .map(|queries| {
            queries
                .into_iter()
                .map(|(name, row)| (name, row.0))
                .collect()
        })
        .unwrap_or_default()
}

/// The first `# Heading` in the report's prose, used as the purpose when none is given.
fn first_heading(blocks: &[(String, String)]) -> Option<String> {
    blocks
        .iter()
        .filter(|(kind, _)| kind == "markdown")
        .flat_map(|(_, text)| text.lines())
        .find_map(|line| line.strip_prefix("# ").map(|t| t.trim().to_owned()))
}

#[cfg(test)]
mod column_order_tests {
    use super::column_orders;

    #[test]
    fn table_columns_follow_the_query_not_the_alphabet() {
        let orders = column_orders(
            r#"{"q":[{"zeta":1,"alpha":2,"mid":3},{"zeta":4,"alpha":5,"mid":6}],"empty":[]}"#,
        );
        assert_eq!(orders["q"], ["zeta", "alpha", "mid"]);
        assert!(orders["empty"].is_empty());
        assert!(column_orders("not json").is_empty());
    }
}

#[cfg(test)]
mod extension_tests {
    use super::parse;

    #[test]
    fn a_report_may_name_only_allowed_extensions() {
        let ok = parse("---\nextensions: [behavioral]\n---\n# R\n").unwrap();
        assert_eq!(ok.extensions, ["behavioral"]);
        assert!(parse("# R\n").unwrap().extensions.is_empty());
        let refused = parse("---\nextensions: [httpfs]\n---\n# R\n").unwrap_err();
        assert!(refused.to_string().contains("unsupported DuckDB extension"));
        assert!(parse("---\nextensions: behavioral\n---\n# R\n").is_err());
        assert!(parse("---\nextensions: [1]\n---\n# R\n").is_err());
    }
}
