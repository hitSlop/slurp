//! Project definitions: shared business SQL in `slurp/definitions/*.sql`, committed with the app and loaded into every
//! read-only session (`slurp sql`, MCP queries, reports, `slurp duckdb`).
//!
//! A definition file is plain DuckDB SQL that creates one TEMP macro, table macro or view named after the file. Slurp parses
//! nothing but the leading comment block (the description, and an optional `-- extensions:` line). It runs the files as
//! written before the caller's SQL, ordered so a definition loads after the definitions it refers to, then a guard that
//! fails unless each file created exactly its own object and none replaced a built-in. Only when a run fails does Slurp
//! load the definitions alone to find the file at fault (or a better order). TEMP objects live only in that DuckDB
//! session, so nothing is stored in the database: two checkouts on different branches can share one database file and
//! still see their own definitions.
use crate::{
    QUERY_TIMEOUT, Workspace,
    error::{ErrorCode, Failure},
    literal, setup,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

/// Where definitions live, relative to the project root.
pub const FOLDER: &str = "slurp/definitions";
/// Starts the guard's error message, so the message can be shown without DuckDB's prefix.
const GUARD_MARKER: &str = "slurp_definitions:";

/// One definition file.
#[derive(Debug, Clone)]
pub struct Definition {
    /// The file stem, which is also the name of the macro or view the file creates.
    pub name: String,
    pub file: PathBuf,
    pub sql: String,
    /// The leading `--` comment lines, without the `extensions:` line.
    pub description: String,
    /// Community extensions the SQL needs (`-- extensions: behavioral`), checked against the allow-list.
    pub extensions: Vec<String>,
}

impl Definition {
    /// The file as people see it in their project: `slurp/definitions/active_people.sql`.
    #[must_use]
    pub fn shown(&self) -> String {
        shown(&self.file)
    }
}

/// A loaded definition as `slurp definitions` and the MCP tools describe it.
#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    /// `macro`, `table_macro` or `view`, as DuckDB reports it.
    pub kind: String,
    pub parameters: Vec<String>,
    pub description: String,
    pub file: String,
    pub extensions: Vec<String>,
    /// The file's SQL, when one definition is shown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
}

fn shown(file: &Path) -> String {
    format!(
        "{FOLDER}/{}",
        file.file_name().unwrap_or_default().to_string_lossy()
    )
}

fn invalid(message: String) -> anyhow::Error {
    Failure::new(ErrorCode::InvalidInput, message).into()
}

/// Read a project's definitions, ordered so each loads after the definitions it refers to. A project without the folder
/// has none.
///
/// # Errors
/// Returns an error naming the file for an unreadable file, a name that is not a SQL identifier, two files whose names
/// differ only in case, or an extension that is not allowed.
pub fn read(root: &Path) -> Result<Vec<Definition>> {
    let entries = match fs::read_dir(root.join(FOLDER)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("reading {FOLDER}")),
    };
    let mut found: Vec<Definition> = Vec::new();
    for entry in entries {
        let file = entry.with_context(|| format!("reading {FOLDER}"))?.path();
        if file.extension().and_then(|e| e.to_str()) != Some("sql") || !file.is_file() {
            continue;
        }
        let name = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if !is_identifier(&name) {
            return Err(invalid(format!(
                "{}: name the file after the macro or view it creates, using letters, digits and underscores (for example active_people.sql)",
                shown(&file)
            )));
        }
        if let Some(other) = found.iter().find(|d| d.name.eq_ignore_ascii_case(&name)) {
            return Err(invalid(format!(
                "{} and {} name the same definition (SQL names ignore case); keep one",
                other.shown(),
                shown(&file)
            )));
        }
        let sql = fs::read_to_string(&file).with_context(|| format!("reading {}", shown(&file)))?;
        let (description, extensions) = header(&sql);
        setup::check_extension_names(&extensions)
            .map_err(|error| invalid(format!("{}: {error}", shown(&file))))?;
        found.push(Definition {
            name,
            file,
            sql,
            description,
            extensions,
        });
    }
    Ok(ordered(found))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The description (the leading `--` lines) and the extensions named on an `-- extensions:` line among them.
fn header(sql: &str) -> (String, Vec<String>) {
    let mut lines = Vec::new();
    let mut extensions = Vec::new();
    for line in sql.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        let Some(text) = line.strip_prefix("--") else {
            break;
        };
        let text = text.trim();
        if let Some(names) = text.strip_prefix("extensions:") {
            extensions.extend(
                names
                    .split([',', ' '])
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        } else {
            lines.push(text);
        }
    }
    (lines.join("\n").trim().to_string(), extensions)
}

/// Order definitions so each loads after the definitions it refers to (DuckDB binds every reference when an object is
/// created, so a definition that uses another fails if it loads first). Ties, and any cycle, keep name order. A name that
/// only looks like a reference (a parameter named like another definition) can still misplace a file; [`resolve`]
/// corrects that from DuckDB's own error.
fn ordered(mut definitions: Vec<Definition>) -> Vec<Definition> {
    definitions.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<String> = definitions
        .iter()
        .map(|d| d.name.to_ascii_lowercase())
        .collect();
    let needs: Vec<Vec<usize>> = definitions
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let references = references(&d.sql);
            (0..names.len())
                .filter(|&j| j != i && references.contains(&names[j]))
                .collect()
        })
        .collect();
    let mut placed = vec![false; definitions.len()];
    let mut order = Vec::with_capacity(definitions.len());
    while let Some(i) =
        (0..definitions.len()).find(|&i| !placed[i] && needs[i].iter().all(|&j| placed[j]))
    {
        placed[i] = true;
        order.push(i);
    }
    order.extend((0..definitions.len()).filter(|&i| !placed[i]));
    let mut slots: Vec<Option<Definition>> = definitions.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

/// The lowercase names SQL refers to: its identifiers, `"quoted"` ones included, but nothing inside a comment (`--`,
/// `/* */`) or a string literal (`'...'`, `$$...$$`, `$tag$...$tag$`).
fn references(sql: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut rest = sql;
    while let Some(c) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |end| &after[end..]);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |end| &after[end + 2..]);
        } else if let Some(after) = rest.strip_prefix('\'') {
            rest = closing(after, '\'').map_or("", |end| &after[end + 1..]);
        } else if let Some(after) = rest.strip_prefix('"') {
            let end = closing(after, '"').unwrap_or(after.len());
            names.insert(after[..end].replace("\"\"", "\"").to_ascii_lowercase());
            rest = after.get(end + 1..).unwrap_or_default();
        } else if let Some((tag, after)) = dollar_tag(rest) {
            rest = after.find(tag).map_or("", |end| &after[end + tag.len()..]);
        } else if c.is_ascii_alphabetic() || c == '_' {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            names.insert(rest[..end].to_ascii_lowercase());
            rest = &rest[end..];
        } else {
            rest = &rest[c.len_utf8()..];
        }
    }
    names
}

/// The byte index of the `quote` that closes a quoted token whose opening quote was just read; a doubled quote stands
/// for itself.
fn closing(text: &str, quote: char) -> Option<usize> {
    let mut from = 0;
    loop {
        let at = from + text[from..].find(quote)?;
        if text[at + 1..].starts_with(quote) {
            from = at + 2;
        } else {
            return Some(at);
        }
    }
}

/// A dollar-quoted string's opening `$tag$` (the tag may be empty) and the text after it.
fn dollar_tag(text: &str) -> Option<(&str, &str)> {
    let after = text.strip_prefix('$')?;
    let end = after
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(after.len());
    after[end..]
        .starts_with('$')
        .then(|| (&text[..end + 2], &after[end + 1..]))
}

/// The SQL that creates every definition, in the given order. Each file is closed with its own `;`, so a file may end
/// without one (an extra `;` is an empty statement).
fn preamble(definitions: &[Definition]) -> String {
    let mut script = String::new();
    for definition in definitions {
        script.push_str(&definition.sql);
        script.push_str("\n;\n");
    }
    script
}

/// SQL that fails, listing every problem, unless the session's TEMP macros and views are exactly one per definition
/// file, each named after its file, and none replaces a built-in: a Slurp helper, a table, or a DuckDB or extension
/// function. Without it, a file could quietly change what `pct()` or `events_with_person` mean. It prints nothing when
/// it passes.
fn guard(definitions: &[Definition]) -> String {
    let expected = definitions
        .iter()
        .map(|d| format!("({})", literal(&d.name.to_ascii_lowercase())))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SET VARIABLE slurp_definitions_check = (
  WITH created AS (
    SELECT DISTINCT lower(function_name) AS name FROM duckdb_functions() WHERE database_name = 'temp'
    UNION SELECT lower(view_name) FROM duckdb_views() WHERE database_name = 'temp' AND NOT internal
  ), expected(name) AS (VALUES {expected}),
  builtin AS (
    SELECT lower(function_name) AS name FROM duckdb_functions() WHERE database_name <> 'temp'
    UNION SELECT lower(view_name) FROM duckdb_views() WHERE database_name <> 'temp'
    UNION SELECT lower(table_name) FROM duckdb_tables() WHERE database_name <> 'temp'
  ), problems AS (
    SELECT '{FOLDER}/' || name || '.sql does not create `' || name || '`: a file must create the TEMP macro or view it is named after' AS problem
      FROM expected WHERE name NOT IN (SELECT name FROM created)
    UNION ALL SELECT '`' || name || '` is created by a file named after something else: give it its own file, {FOLDER}/' || name || '.sql'
      FROM created WHERE name NOT IN (SELECT name FROM expected)
    UNION ALL SELECT '`' || name || '` would replace a built-in (a Slurp helper, a table or a DuckDB function): choose another name'
      FROM created WHERE name IN (SELECT name FROM builtin)
  )
  SELECT CASE WHEN count(*) = 0 THEN true ELSE error('{GUARD_MARKER}' || chr(10) || string_agg(problem, chr(10) ORDER BY problem)) END
  FROM problems
);
RESET VARIABLE slurp_definitions_check;
"
    )
}

/// The definitions, the guard, then `sql`.
fn script(definitions: &[Definition], sql: &str) -> String {
    let mut script = preamble(definitions);
    script.push_str(&guard(definitions));
    script.push_str(sql);
    script
}

/// Every extension the definitions need, once each.
#[must_use]
pub fn extensions(definitions: &[Definition]) -> Vec<String> {
    let mut names: Vec<String> = definitions
        .iter()
        .flat_map(|d| d.extensions.iter().cloned())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// A copy of `w` that loads the extensions the definitions need and does not load the definitions again itself.
fn loading(w: &Workspace, definitions: &[Definition]) -> Workspace {
    let mut w = w.without_definitions();
    for name in extensions(definitions) {
        if !w.extensions.contains(&name) {
            w.extensions.push(name);
        }
    }
    w
}

/// Run read-only `sql` after the definitions. The first run is the only one when it succeeds. When it fails:
///
/// - an extension that is not installed yet is installed (online, once) and the run repeated;
/// - a guard failure is reported as its list of problems;
/// - a definition that does not load is reported with its file, and definitions that load only in another order are
///   run again in that order (see [`resolve`]);
/// - anything else is the caller's own failure and is returned as it was.
pub(crate) fn execute(w: &Workspace, definitions: &[Definition], sql: &str) -> Result<Value> {
    let w = loading(w, definitions);
    let run = |order: &[Definition]| w.execute_script(&script(order, sql), true, false);
    let mut result = run(definitions);
    if let Err(error) = &result
        && install_missing(&w, error)?
    {
        result = run(definitions);
    }
    let error = match result {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    if let Some(problems) = guard_problems(&error.to_string()) {
        return Err(invalid(problems));
    }
    // Waiting for a lock, timeouts and cancellation concern the run, not a definition.
    if let Some(failure) = error.downcast_ref::<Failure>()
        && !matches!(failure.code, ErrorCode::QueryFailed)
    {
        return Err(error);
    }
    match resolve(&w, definitions) {
        Ok(order)
            if order
                .iter()
                .map(|d| &d.name)
                .eq(definitions.iter().map(|d| &d.name)) =>
        {
            Err(error)
        }
        Ok(order) => run(&order),
        Err(problem) => Err(Failure::new(ErrorCode::QueryFailed, problem).into()),
    }
}

/// Install each extension of `w` that `error` says is missing. Whether any was installed.
fn install_missing(w: &Workspace, error: &anyhow::Error) -> Result<bool> {
    let text = error.to_string();
    let mut installed = false;
    for name in &w.extensions {
        if text.contains("Extension") && text.contains("not found") && text.contains(name.as_str())
        {
            setup::install_extension(&w.duckdb, name)?;
            installed = true;
        }
    }
    Ok(installed)
}

/// The guard's problems, one per line, when `message` is a guard failure.
fn guard_problems(message: &str) -> Option<String> {
    let (_, problems) = message.split_once(GUARD_MARKER)?;
    let problems: Vec<&str> = problems
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    Some(format!(
        "the definitions have {} problem{}:\n  {}",
        problems.len(),
        if problems.len() == 1 { "" } else { "s" },
        problems.join("\n  ")
    ))
}

/// How far loading the definitions alone got.
enum Load {
    /// Every definition loaded and the guard passed.
    Loaded,
    /// The definition at `at` failed because it uses the one at `needed`, which comes later.
    NeedsLater { at: usize, needed: usize },
    /// A problem to report as it is.
    Problem(String),
}

/// The definitions in an order DuckDB accepts, checked by loading them alone, followed by the guard.
///
/// The order from their text (see [`ordered`]) can be wrong when a name appears in a way the scan cannot tell apart from
/// a reference. DuckDB names what it is missing (`... with name X does not exist`), so a definition that needs one placed
/// later is moved after it and the load repeated, until it loads or an order comes back (the definitions depend on each
/// other).
///
/// # Errors
/// Returns the problem, naming the file: a definition that does not load, prints a query result, or is part of a cycle;
/// or the guard's problems.
fn resolve(w: &Workspace, definitions: &[Definition]) -> Result<Vec<Definition>, String> {
    let mut order = definitions.to_vec();
    let mut tried: HashSet<Vec<String>> = HashSet::new();
    // The last move: a file, and the definition it needed first.
    let mut last: Option<(String, String)> = None;
    loop {
        if !tried.insert(order.iter().map(|d| d.name.clone()).collect()) {
            let (file, needed) = last.unwrap_or_default();
            return Err(format!(
                "the definitions cannot load in any order: {file} uses `{needed}`, which uses it in turn (directly or through other definitions). Remove the cycle, then run `slurp definitions`"
            ));
        }
        match load(w, &order) {
            Load::Loaded => return Ok(order),
            Load::NeedsLater { at, needed } => {
                let needed = order.remove(needed);
                last = Some((order[at].shown(), needed.name.clone()));
                order.insert(at, needed);
            }
            Load::Problem(problem) => return Err(problem),
        }
    }
}

/// Load the definitions in `order` with a marker after each file, then the guard, and say how far that got.
fn load(w: &Workspace, order: &[Definition]) -> Load {
    let mut script = String::new();
    for (i, definition) in order.iter().enumerate() {
        script.push_str(&definition.sql);
        // Writing to a String cannot fail.
        let _ = write!(script, "\n;\nSELECT {i} AS slurp_definition;\n");
    }
    script.push_str(&guard(order));
    let run = match w.run_raw(&script, true, false, QUERY_TIMEOUT) {
        Ok(run) => run,
        Err(error) => return Load::Problem(format!("could not check the definitions: {error:#}")),
    };
    let mut loaded = 0;
    for value in serde_json::Deserializer::from_slice(&run.stdout).into_iter::<Value>() {
        let Ok(value) = value else { break };
        if value[0]["slurp_definition"].as_u64() == u64::try_from(loaded).ok() {
            loaded += 1;
            continue;
        }
        let file = order
            .get(loaded)
            .map_or_else(|| FOLDER.to_owned(), Definition::shown);
        return Load::Problem(format!(
            "{file} printed a query result; a definition file may only create a TEMP macro or view. Remove the SELECT, then run `slurp definitions`"
        ));
    }
    if run.success {
        return Load::Loaded;
    }
    let cause = run.stderr.trim().trim_end_matches('.');
    if let Some(problems) = guard_problems(cause) {
        return Load::Problem(problems);
    }
    let Some(failed) = order.get(loaded) else {
        return Load::Problem(format!("the definitions did not load: {cause}"));
    };
    let later = missing_name(cause).and_then(|missing| {
        order[loaded + 1..]
            .iter()
            .position(|d| d.name.eq_ignore_ascii_case(missing))
    });
    if let Some(offset) = later {
        return Load::NeedsLater {
            at: loaded,
            needed: loaded + 1 + offset,
        };
    }
    let hint = if cause.contains("read-only") {
        " Definitions must create TEMP objects, for example CREATE OR REPLACE TEMP MACRO name(...) AS TABLE SELECT ...;"
    } else {
        ""
    };
    Load::Problem(format!(
        "{} did not load: {cause}.{hint} Fix the file, or run `slurp definitions` to check every definition",
        failed.shown()
    ))
}

/// The name in DuckDB's "Scalar Function with name X does not exist" (also `Table`, `Table Function`, `Macro`).
fn missing_name(cause: &str) -> Option<&str> {
    let (_, after) = cause.split_once("with name ")?;
    let (name, _) = after.split_once(" does not exist")?;
    Some(name.trim_matches('"'))
}

/// The kind and parameters DuckDB reports for one TEMP macro or view.
#[derive(Deserialize)]
struct CatalogRow {
    name: String,
    kind: String,
    parameters: Vec<String>,
}

const CATALOG: &str = "SELECT function_name AS name, function_type AS kind, parameters FROM duckdb_functions() \
    WHERE database_name = 'temp' AND function_type IN ('macro', 'table_macro') \
    UNION ALL SELECT view_name, 'view', []::VARCHAR[] FROM duckdb_views() WHERE database_name = 'temp' AND NOT internal";

/// Every definition of the project, after loading them all, so this is also the check that they load.
///
/// # Errors
/// Returns the problem, naming the file, when a definition does not load or the guard fails, and an error when `w` was
/// not given a project (see [`Workspace::with_definitions`]).
pub fn list(w: &Workspace) -> Result<Vec<Entry>> {
    let (definitions, rows) = catalog(w)?;
    Ok(definitions
        .into_iter()
        .map(|definition| entry(definition, &rows))
        .collect())
}

/// One definition, with its SQL, after loading them all.
///
/// # Errors
/// As [`list`], and for a name that is not a definition.
pub fn show(w: &Workspace, name: &str) -> Result<Entry> {
    let (definitions, rows) = catalog(w)?;
    let available: Vec<&str> = definitions.iter().map(|d| d.name.as_str()).collect();
    let unknown = invalid(format!(
        "no definition named '{name}' in {FOLDER}; available: {}",
        if available.is_empty() {
            "none".to_owned()
        } else {
            available.join(", ")
        }
    ));
    let definition = definitions
        .iter()
        .find(|d| d.name.eq_ignore_ascii_case(name))
        .ok_or(unknown)?
        .clone();
    let sql = definition.sql.clone();
    Ok(Entry {
        sql: Some(sql),
        ..entry(definition, &rows)
    })
}

/// The project's definitions in an order that loads, and what DuckDB reports for the objects they create. Installs the
/// extensions they need now, so later queries also work offline.
fn catalog(w: &Workspace) -> Result<(Vec<Definition>, Vec<CatalogRow>)> {
    let root = w
        .definitions
        .as_deref()
        .context("definitions belong to a project; run this inside one")?;
    let definitions = read(root)?;
    if definitions.is_empty() {
        return Ok((definitions, Vec::new()));
    }
    for extension in extensions(&definitions) {
        setup::install_extension(&w.duckdb, &extension)?;
    }
    let w = loading(w, &definitions);
    let definitions = resolve(&w, &definitions).map_err(invalid)?;
    let rows = w.execute_script(&script(&definitions, CATALOG), true, false)?;
    Ok((definitions, serde_json::from_value(rows)?))
}

fn entry(definition: Definition, rows: &[CatalogRow]) -> Entry {
    // The guard has checked that every definition created its object.
    let row = rows
        .iter()
        .find(|row| row.name.eq_ignore_ascii_case(&definition.name));
    Entry {
        file: definition.shown(),
        kind: row.map(|row| row.kind.clone()).unwrap_or_default(),
        parameters: row.map(|row| row.parameters.clone()).unwrap_or_default(),
        name: definition.name,
        description: definition.description,
        extensions: definition.extensions,
        sql: None,
    }
}

/// The DuckDB shell `-init` script for a project, or `None` when it has no definitions. It sets up the session the way
/// Slurp runs queries: UTC first (a definition's defaults are evaluated when it is created), then the extensions the
/// definitions need, then the definitions in an order checked to load, then the guard.
///
/// # Errors
/// Returns the problem, naming the file, when the definitions do not load; the shell should not open then.
pub fn shell_init(w: &Workspace, root: &Path) -> Result<Option<String>> {
    let definitions = read(root)?;
    if definitions.is_empty() {
        return Ok(None);
    }
    for extension in extensions(&definitions) {
        setup::install_extension(&w.duckdb, &extension)?;
    }
    let w = loading(w, &definitions);
    let definitions = resolve(&w, &definitions).map_err(invalid)?;
    let mut init = String::from(crate::SESSION_SETTINGS);
    init.push('\n');
    for name in &w.extensions {
        // Writing to a String cannot fail.
        let _ = writeln!(init, "LOAD {name};");
    }
    init.push_str(&script(&definitions, ""));
    Ok(Some(init))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(name: &str, sql: &str) -> Definition {
        Definition {
            name: name.into(),
            file: PathBuf::from(format!("{name}.sql")),
            sql: sql.into(),
            description: String::new(),
            extensions: Vec::new(),
        }
    }

    #[test]
    fn a_definition_loads_after_the_ones_it_refers_to_and_text_is_not_a_reference() {
        // Were comments or strings read as references, active_people and by_plan would form a cycle, and aa_label would
        // have to wait for by_plan.
        let order: Vec<String> = ordered(vec![
            definition(
                "active_people",
                "-- by_plan counts these\nCREATE TEMP MACRO active_people() AS TABLE \
                 SELECT * FROM range(3) WHERE NOT \"is_internal\"(range)",
            ),
            definition("is_internal", "CREATE TEMP MACRO is_internal(x) AS x = 1"),
            definition(
                "aa_label",
                "CREATE TEMP VIEW aa_label AS SELECT 'by_plan' AS a, 'it''s by_plan' AS b, \
                 $$ by_plan $$ AS c, $q$ by_plan $q$ AS d /* by_plan */",
            ),
            definition(
                "by_plan",
                "CREATE TEMP VIEW by_plan AS SELECT count(*) FROM active_people()",
            ),
        ])
        .into_iter()
        .map(|d| d.name)
        .collect();
        assert_eq!(
            order,
            ["aa_label", "is_internal", "active_people", "by_plan"]
        );
    }
}
