//! Report validation: every mistake an author can make, found together, each with the line and the block it is in.
//!
//! `slurp report check` and `slurp report build` both run [`validate`]. It needs no database for the structural checks
//! (unknown keys, widths, unknown queries, chart marks) and uses the project's DuckDB, when there is one, to check the
//! queries themselves and that every metric, table and chart refers to columns the query really returns.
use crate::{Workspace, report::Document};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
}

/// One finding. `block` names what it is about (for example `chart "Weekly retention"`), `line` is the 1-based line in the file.
#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    pub severity: Severity,
    pub line: Option<usize>,
    pub block: String,
    pub message: String,
}
impl Problem {
    pub fn error(line: Option<usize>, block: &str, message: String) -> Self {
        Self {
            severity: Severity::Error,
            line,
            block: block.into(),
            message,
        }
    }
    pub fn warning(line: Option<usize>, block: &str, message: String) -> Self {
        Self {
            severity: Severity::Warning,
            ..Self::error(line, block, message)
        }
    }
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}
impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(line) => write!(f, "line {line}, {}: {}", self.block, self.message),
            None => write!(f, "{}: {}", self.block, self.message),
        }
    }
}

/// Warnings about a theme whose colours are hard to read: body text needs 4.5:1 against the background, the accent (used for
/// big numbers and links) 3:1. Colours that are not plain hex are skipped.
pub fn theme_warnings(palette: &slurp_render::Palette) -> Vec<Problem> {
    let mut out = vec![];
    for (name, colour, needed) in [("fg", &palette.fg, 4.5), ("accent", &palette.accent, 3.0)] {
        if let Some(ratio) = slurp_render::contrast_ratio(colour, &palette.bg)
            && ratio < needed
        {
            out.push(Problem::warning(
                None,
                &format!("theme {}", palette.name),
                format!(
                    "`{name}` ({colour}) on `bg` ({}) has a contrast of {ratio:.1}:1; aim for at least {needed}:1 so it is easy to read",
                    palette.bg
                ),
            ));
        }
    }
    out
}

/// All errors as one readable message (one problem per line), or `None` when there are none.
pub fn error_summary(problems: &[Problem]) -> Option<String> {
    let errors: Vec<_> = problems.iter().filter(|p| p.is_error()).collect();
    if errors.is_empty() {
        return None;
    }
    let mut text = format!(
        "the report has {} problem{}:",
        errors.len(),
        if errors.len() == 1 { "" } else { "s" }
    );
    for problem in errors {
        text.push_str(&format!("\n  {problem}"));
    }
    // Warnings often explain the errors (a misspelled key leaves a required one missing), so show them too.
    for problem in problems.iter().filter(|p| !p.is_error()) {
        text.push_str(&format!("\n  warning: {problem}"));
    }
    Some(text)
}

const CHART_KEYS: [&str; 4] = ["query", "title", "width", "spec"];
const METRIC_KEYS: [&str; 9] = [
    "query", "field", "label", "width", "title", "decimals", "prefix", "suffix", "compact",
];
const TABLE_KEYS: [&str; 5] = ["query", "title", "width", "limit", "formats"];
const MARKS: [&str; 17] = [
    "arc",
    "area",
    "bar",
    "boxplot",
    "circle",
    "errorband",
    "errorbar",
    "geoshape",
    "image",
    "line",
    "point",
    "rect",
    "rule",
    "square",
    "text",
    "tick",
    "trail",
];

/// Edit distance where swapping two neighbouring letters (`feild`) counts as one change.
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}
/// The candidate closest to `word`, when it is plausibly a typo of it.
pub fn closest<'a>(word: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let limit = (word.chars().count() / 3).clamp(1, 3);
    candidates
        .into_iter()
        .map(|c| (distance(&word.to_lowercase(), &c.to_lowercase()), c))
        .filter(|(d, _)| *d <= limit)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}
pub fn unknown_key_message(key: &str, allowed: &[&str]) -> String {
    let hint = match closest(key, allowed.iter().copied()) {
        Some(near) => format!(" Did you mean `{near}`?"),
        None => String::new(),
    };
    format!(
        "unknown key `{key}`, it is ignored.{hint} Allowed keys: {}.",
        allowed.join(", ")
    )
}

fn describe(kind: &str, spec: &Value, query: Option<&str>) -> String {
    match (spec["title"].as_str(), query) {
        (Some(title), _) => format!("{kind} \"{title}\""),
        (None, Some(query)) => format!("{kind} (query `{query}`)"),
        (None, None) => kind.to_owned(),
    }
}

/// Collect every `field` name a chart spec reads from the data, the names its `transform`s create (`as:` outputs, and the
/// `key`/`value` a `fold` makes), and whether it has any transform at all.
fn spec_fields(
    spec: &Value,
    in_encoding: bool,
    fields: &mut BTreeSet<String>,
    derived: &mut BTreeSet<String>,
    has_transform: &mut bool,
) {
    match spec {
        Value::Object(map) => {
            for (key, value) in map {
                match key.as_str() {
                    "transform" => {
                        *has_transform = true;
                        derived_names(value, derived);
                    }
                    "encoding" => spec_fields(value, true, fields, derived, has_transform),
                    "field" if in_encoding => {
                        if let Some(name) = value.as_str() {
                            // `a.b` and `a\.b` address nested data; only the first segment is a column.
                            let first = name.split('.').next().unwrap_or(name).replace('\\', "");
                            fields.insert(first);
                        }
                    }
                    _ => spec_fields(value, in_encoding, fields, derived, has_transform),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                spec_fields(item, in_encoding, fields, derived, has_transform);
            }
        }
        _ => {}
    }
}
/// Names created by Vega-Lite transforms: every `as` (a name or a list of names), plus the defaults of `fold` and `pivot`.
fn derived_names(transform: &Value, out: &mut BTreeSet<String>) {
    match transform {
        Value::Object(map) => {
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("as", Value::String(name)) => {
                        out.insert(name.clone());
                    }
                    ("as", Value::Array(names)) => {
                        out.extend(names.iter().filter_map(Value::as_str).map(str::to_owned));
                    }
                    ("fold", _) if !map.contains_key("as") => {
                        out.extend(["key".to_owned(), "value".to_owned()]);
                    }
                    _ => derived_names(value, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| derived_names(item, out)),
        _ => {}
    }
}
fn marks(spec: &Value, out: &mut Vec<String>) {
    match spec {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "mark" {
                    match value {
                        Value::String(name) => out.push(name.clone()),
                        Value::Object(inner) => {
                            if let Some(name) = inner.get("type").and_then(Value::as_str) {
                                out.push(name.to_owned());
                            }
                        }
                        _ => {}
                    }
                } else {
                    marks(value, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| marks(item, out)),
        _ => {}
    }
}

/// Rewrite a DuckDB error so it points at the author's own line instead of the wrapper query's line.
pub(crate) fn locate_sql_error(message: &str, query_line: usize) -> String {
    let mut kind = String::new();
    let mut at = None;
    for line in message.trim().lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("LINE ")
            && let Some((number, _)) = rest.split_once(':')
            && let Ok(n) = number.parse::<usize>()
        {
            // The query text starts on the second line of the statement we ran, right after the fence line in the file.
            at.get_or_insert(query_line + n.saturating_sub(1));
        } else if at.is_none() && !line.is_empty() && !line.starts_with('^') {
            if !kind.is_empty() {
                kind.push(' ');
            }
            kind.push_str(line.strip_prefix("DuckDB: ").unwrap_or(line));
        }
    }
    match at {
        Some(line) => format!("{kind} (line {line})"),
        None => kind,
    }
}

/// Turn the line numbers inside a YAML error (relative to the block) into lines of the file; also returns the earliest one.
fn shift_yaml_lines(message: &str, base: usize) -> (String, Option<usize>) {
    let mut out = String::new();
    let mut earliest: Option<usize> = None;
    let mut rest = message;
    while let Some(at) = rest.find("line ") {
        let (before, after) = rest.split_at(at + 5);
        out.push_str(before);
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        match digits.parse::<usize>() {
            Ok(n) => {
                let absolute = base + n;
                earliest = Some(earliest.map_or(absolute, |e| e.min(absolute)));
                out.push_str(&absolute.to_string());
                rest = &after[digits.len()..];
            }
            Err(_) => rest = after,
        }
    }
    out.push_str(rest);
    (out, earliest)
}

fn is_numeric(duckdb_type: &str) -> bool {
    let t = duckdb_type.to_uppercase();
    (t.contains("INT") && !t.starts_with("INTERVAL"))
        || t.starts_with("DECIMAL")
        || t.starts_with("DOUBLE")
        || t.starts_with("FLOAT")
        || t.starts_with("REAL")
}

/// Check a parsed report. With a workspace the queries are also checked against the real database (`DESCRIBE`, no data is read);
/// the caller has already loaded the report's `extensions` into that workspace.
///
/// # Errors
/// Returns an error only when the check itself cannot run; problems with the report are returned as [`Problem`]s.
pub fn validate(doc: &Document, workspace: Option<&Workspace>) -> Result<Vec<Problem>> {
    let mut problems = doc.problems.clone();
    let mut used: BTreeSet<String> = BTreeSet::new();
    // (block index, kind, spec) of blocks whose YAML is usable.
    let mut specs: Vec<(usize, &str, Value)> = vec![];
    for (index, (kind, body)) in doc.blocks.iter().enumerate() {
        if kind == "markdown" {
            continue;
        }
        let line = doc.block_lines.get(index).copied();
        let spec: Value = match serde_norway::from_str(body) {
            Ok(value) => value,
            Err(error) => {
                let (text, earliest) = shift_yaml_lines(&error.to_string(), line.unwrap_or(1));
                problems.push(Problem::error(
                    earliest.or(line),
                    &format!("`{kind}` block"),
                    format!("the YAML in this block is not valid: {text}"),
                ));
                continue;
            }
        };
        let Some(map) = spec.as_object() else {
            problems.push(Problem::error(
                line,
                &format!("`{kind}` block"),
                "a block must be a YAML mapping such as `query: NAME`".into(),
            ));
            continue;
        };
        let query = spec["query"].as_str();
        let label = describe(kind, &spec, query);
        let allowed: &[&str] = match kind.as_str() {
            "chart" => &CHART_KEYS,
            "metric" => &METRIC_KEYS,
            _ => &TABLE_KEYS,
        };
        for key in map.keys().filter(|k| !allowed.contains(&k.as_str())) {
            problems.push(Problem::warning(
                line,
                &label,
                unknown_key_message(key, allowed),
            ));
        }
        match query {
            None => problems.push(Problem::error(
                line,
                &label,
                "this block needs `query: NAME`, the name of a ```sql NAME block".into(),
            )),
            Some(name) if !doc.queries.contains_key(name) => {
                let hint = match closest(name, doc.queries.keys().map(String::as_str)) {
                    Some(near) => format!(" Did you mean `{near}`?"),
                    None => String::new(),
                };
                let known = if doc.queries.is_empty() {
                    "the report defines no queries".to_owned()
                } else {
                    format!(
                        "queries defined: {}",
                        doc.queries.keys().cloned().collect::<Vec<_>>().join(", ")
                    )
                };
                problems.push(Problem::error(
                    line,
                    &label,
                    format!("unknown query `{name}`.{hint} {known}."),
                ));
            }
            Some(name) => {
                used.insert(name.to_owned());
            }
        }
        if let Some(width) = map.get("width")
            && !matches!(width.as_str(), Some("full" | "half" | "third"))
        {
            problems.push(Problem::error(
                line,
                &label,
                format!("`width` must be full, half or third, not {width}"),
            ));
        }
        match kind.as_str() {
            "metric" => {
                if spec["field"].as_str().is_none() {
                    problems.push(Problem::error(
                        line,
                        &label,
                        "a metric needs `field: COLUMN`, the column of its query to show".into(),
                    ));
                }
                if let Err(message) = crate::report_format::NumberFormat::from_spec(&spec) {
                    problems.push(Problem::error(line, &label, message));
                }
            }
            "table"
                if map
                    .get("limit")
                    .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0)) =>
            {
                problems.push(Problem::error(
                    line,
                    &label,
                    "`limit` must be a positive whole number".into(),
                ));
            }
            "chart" => {
                if !spec["spec"].is_object() {
                    problems.push(Problem::error(
                        line,
                        &label,
                        "a chart needs `spec:`, a Vega-Lite specification".into(),
                    ));
                } else {
                    let mut found = vec![];
                    marks(&spec["spec"], &mut found);
                    for mark in found.iter().filter(|m| !MARKS.contains(&m.as_str())) {
                        let hint = match closest(mark, MARKS) {
                            Some(near) => format!(" Did you mean `{near}`?"),
                            None => String::new(),
                        };
                        problems.push(Problem::error(
                            line,
                            &label,
                            format!(
                                "unknown chart mark `{mark}`.{hint} Marks: {}.",
                                MARKS.join(", ")
                            ),
                        ));
                    }
                }
            }
            _ => {}
        }
        specs.push((index, kind.as_str(), spec));
    }
    for (name, line) in &doc.query_lines {
        if !used.contains(name) {
            problems.push(Problem::warning(
                Some(*line),
                &format!("query `{name}`"),
                "no chart, metric or table uses this query".into(),
            ));
        }
    }

    if let Some(w) = workspace {
        check_against_database(doc, w, &specs, &mut problems)?;
    }
    problems.sort_by_key(|p| (p.line.unwrap_or(0), !p.is_error()));
    Ok(problems)
}

fn check_against_database(
    doc: &Document,
    w: &Workspace,
    specs: &[(usize, &str, Value)],
    problems: &mut Vec<Problem>,
) -> Result<()> {
    let preamble = crate::report::param_preamble(&doc.params)?;
    let mut columns: BTreeMap<&str, Vec<(String, String)>> = BTreeMap::new();
    for (name, query) in &doc.queries {
        let line = doc.query_lines.get(name).copied().unwrap_or(1);
        let sql = match crate::report::bind_variables(query, &doc.params) {
            Ok(sql) => sql,
            Err(error) => {
                problems.push(Problem::error(
                    Some(line),
                    &format!("query `{name}`"),
                    error.to_string(),
                ));
                continue;
            }
        };
        // The query text begins on the second line of this statement, so error line numbers map back to the file.
        match w.execute(
            &format!("{preamble}DESCRIBE SELECT * FROM (\n{sql}\n);"),
            true,
        ) {
            Ok(rows) => {
                let list = rows
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|r| {
                                Some((
                                    r["column_name"].as_str()?.to_owned(),
                                    r["column_type"].as_str()?.to_owned(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                columns.insert(name.as_str(), list);
            }
            Err(error) => problems.push(Problem::error(
                Some(line),
                &format!("query `{name}`"),
                locate_sql_error(
                    &error.to_string(),
                    line.saturating_sub(preamble.matches('\n').count()),
                ),
            )),
        }
    }
    let mut renderer = slurp_render::ChartRenderer::new();
    for (index, kind, spec) in specs {
        let Some(query) = spec["query"].as_str() else {
            continue;
        };
        let Some(cols) = columns.get(query) else {
            continue;
        };
        let line = doc.block_lines.get(*index).copied();
        let label = describe(kind, spec, Some(query));
        let names: Vec<&str> = cols.iter().map(|(n, _)| n.as_str()).collect();
        let list = names.join(", ");
        match *kind {
            "metric" => {
                if let Some(field) = spec["field"].as_str()
                    && !names.contains(&field)
                {
                    let hint = closest(field, names.iter().copied())
                        .map(|near| format!(" Did you mean `{near}`?"))
                        .unwrap_or_default();
                    problems.push(Problem::error(
                        line,
                        &label,
                        format!("`field: {field}` is not a column of query `{query}`.{hint} Its columns: {list}."),
                    ));
                }
            }
            "table" => {
                if let Some(formats) = spec["formats"].as_object() {
                    for column in formats.keys().filter(|c| !names.contains(&c.as_str())) {
                        let hint = closest(column, names.iter().copied())
                            .map(|near| format!(" Did you mean `{near}`?"))
                            .unwrap_or_default();
                        problems.push(Problem::error(
                            line,
                            &label,
                            format!("`formats` names `{column}`, which is not a column of query `{query}`.{hint} Its columns: {list}."),
                        ));
                    }
                }
            }
            "chart" if spec["spec"].is_object() => {
                let (mut fields, mut derived, mut derives) =
                    (BTreeSet::new(), BTreeSet::new(), false);
                spec_fields(
                    &spec["spec"],
                    false,
                    &mut fields,
                    &mut derived,
                    &mut derives,
                );
                for field in fields
                    .iter()
                    .filter(|f| !names.contains(&f.as_str()) && !derived.contains(*f))
                {
                    let hint = closest(field, names.iter().copied())
                        .map(|near| format!(" Did you mean `{near}`?"))
                        .unwrap_or_default();
                    let message = format!(
                        "the chart reads field `{field}`, which is not a column of query `{query}`.{hint} Its columns: {list}."
                    );
                    // Calculated fields we cannot trace (an expression, a lookup) make this a warning when a transform exists.
                    problems.push(if derives {
                        Problem::warning(
                            line,
                            &label,
                            format!("{message} (Ignore this if a transform creates it.)"),
                        )
                    } else {
                        Problem::error(line, &label, message)
                    });
                }
                let table = json!({
                    "columns": cols.iter().map(|(n, t)| json!({"name": n, "type": if is_numeric(t) {"DECIMAL"} else {"VARCHAR"}})).collect::<Vec<_>>(),
                    "rows": [], "row_count": 0, "truncated": false, "elapsed_ms": 0
                });
                let options = slurp_render::CompileOptions {
                    theme: slurp_render::Theme::light(),
                    font: "Geist".into(),
                    width: 420,
                    ..Default::default()
                };
                if let Err(error) = renderer.compile(&spec["spec"], &table, options)
                    && !problems.iter().any(|p| p.is_error() && p.line == line)
                {
                    problems.push(Problem::error(
                        line,
                        &label,
                        format!("the chart specification is not valid: {error}"),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::parse;

    fn problems(text: &str) -> Vec<Problem> {
        validate(&parse(text).unwrap(), None).unwrap()
    }
    fn errors(text: &str) -> Vec<String> {
        problems(text)
            .iter()
            .filter(|p| p.is_error())
            .map(|p| p.to_string())
            .collect()
    }

    #[test]
    fn typos_are_found_with_their_line_and_a_suggestion() {
        let text = "# R\n\n```sql q\nSELECT 1 AS a\n```\n\n```metric\nquery: q\nfeild: a\nwidht: half\n```\n";
        let found = problems(text);
        let text_of: Vec<String> = found.iter().map(|p| p.to_string()).collect();
        assert!(
            text_of.iter().any(|t| t.contains("line 7")
                && t.contains("`feild`")
                && t.contains("Did you mean `field`?")),
            "{text_of:?}"
        );
        assert!(
            text_of
                .iter()
                .any(|t| t.contains("`widht`") && t.contains("Did you mean `width`?")),
            "{text_of:?}"
        );
        assert!(
            found
                .iter()
                .any(|p| p.is_error() && p.message.contains("needs `field")),
            "{text_of:?}"
        );
    }

    #[test]
    fn every_problem_is_reported_together() {
        let text = "```sql a\nSELECT 1\n```\n\n```sql a\nSELECT 2\n```\n\n```metric\nquery: nope\nfield: x\nwidth: quarter\n```\n\n```chart\nquery: a\nspec: {mark: barr}\n```\n";
        let found = errors(text);
        assert!(
            found
                .iter()
                .any(|e| e.contains("already defined on line 1")),
            "{found:?}"
        );
        assert!(
            found
                .iter()
                .any(|e| e.contains("unknown query `nope`") && e.contains("queries defined: a")),
            "{found:?}"
        );
        assert!(
            found
                .iter()
                .any(|e| e.contains("width` must be full, half or third")),
            "{found:?}"
        );
        assert!(
            found
                .iter()
                .any(|e| e.contains("unknown chart mark `barr`")
                    && e.contains("Did you mean `bar`?")),
            "{found:?}"
        );
        assert!(
            error_summary(&problems(text))
                .unwrap()
                .starts_with("the report has 4 problems:")
        );
    }

    #[test]
    fn yaml_errors_point_at_the_line_inside_the_block() {
        let text = "# R\n\n```sql q\nSELECT 1\n```\n\n```chart\nquery: q\nspec: {mark: bar, encoding: {x: {field: a\n```\n";
        let found = errors(text);
        assert!(
            found
                .iter()
                .any(|e| e.starts_with("line 9") && e.contains("not valid")),
            "{found:?}"
        );
    }

    #[test]
    fn blocks_inside_lists_and_quotes_are_refused_with_a_reason() {
        let found = errors(
            "1. step\n\n   ```sql q\n   SELECT 1\n   ```\n\n> ```sql r\n> SELECT 2\n> ```\n",
        );
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().all(|e| e.contains("top level")), "{found:?}");
    }

    #[test]
    fn unused_queries_and_unknown_front_matter_are_warnings_not_errors() {
        let found = problems("---\ntitel: x\n---\n```sql q\nSELECT 1\n```\n");
        assert!(found.iter().all(|p| !p.is_error()));
        assert!(
            found
                .iter()
                .any(|p| p.message.contains("unknown key `titel`"))
        );
        assert!(
            found
                .iter()
                .any(|p| p.message.contains("no chart, metric or table uses"))
        );
    }

    #[test]
    fn sql_errors_are_mapped_to_the_authors_line() {
        let msg = "DuckDB: Parser Error: syntax error at or near \")\"\n\nLINE 3: ) \n        ^\n";
        // `DESCRIBE SELECT * FROM (` is line 1 of the statement, so the query's own line N is statement line N + 1.
        assert_eq!(
            locate_sql_error(msg, 10),
            "Parser Error: syntax error at or near \")\" (line 12)"
        );
    }

    #[test]
    fn low_contrast_themes_are_flagged_and_good_ones_are_not() {
        let mut palette = slurp_render::palette("pro-light").unwrap().clone();
        assert!(theme_warnings(&palette).is_empty());
        palette.fg = "#bbbbbb".into();
        palette.accent = "#f0f0f0".into();
        let found = theme_warnings(&palette);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].message.contains("contrast of"));
    }

    #[test]
    fn fields_created_by_transforms_are_not_reported_as_missing() {
        let spec = json!({"transform": [{"fold": ["a", "b"], "as": ["series", "pct"]}, {"calculate": "datum.pct * 2", "as": "double"}],
            "encoding": {"x": {"field": "series"}, "y": {"field": "double"}, "color": {"field": "real"}}});
        let (mut fields, mut derived, mut has) = (BTreeSet::new(), BTreeSet::new(), false);
        spec_fields(&spec, false, &mut fields, &mut derived, &mut has);
        assert!(has);
        assert_eq!(
            derived.iter().cloned().collect::<Vec<_>>(),
            ["double", "pct", "series"]
        );
        assert_eq!(
            fields.iter().cloned().collect::<Vec<_>>(),
            ["double", "real", "series"]
        );
    }

    #[test]
    fn closest_only_suggests_plausible_matches() {
        assert_eq!(closest("feild", ["field", "label"]), Some("field"));
        assert_eq!(closest("zzzzz", ["field", "label"]), None);
    }
}
