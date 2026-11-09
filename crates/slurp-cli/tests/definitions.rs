//! Project definitions (`slurp/definitions/*.sql`) load into every read-only surface — `slurp sql`, `slurp definitions`,
//! the MCP server, reports and `slurp duckdb` — give the same answers there, are never stored in the database, and a
//! definition that cannot load is named by its file. Skipped unless `SLURP_TEST_DUCKDB` points at a DuckDB CLI.
mod common;
use serde_json::{Value, json};
use slurp_app::Workspace;
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn event(sender: &str, id: &str, name: &str, user: &str) -> String {
    let at = "2026-11-02T10:00:00Z";
    let record = json!({"id": id, "type": "track", "event": name, "timestamp": at, "user_id": user, "data": {"plan": if user == "u1" { "pro" } else { "free" }}});
    format!(r#"{{"received_at":"{at}","sender":"{sender}","record":{record}}}"#) + "\n"
}

/// A project with two customers who exported, a staff member who exported, and an export sent by the MCP test tools.
fn seeded() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = common::duckdb()?;
    let temp = tempfile::tempdir().unwrap();
    let w = Workspace::init(
        &temp.path().join("home"),
        temp.path(),
        "http://localhost:8080".into(),
        "prj_test".into(),
        None,
        exe.into(),
    )
    .unwrap();
    let lines = event("web", "e1", "signed_up", "u1")
        + &event("web", "e2", "exported", "u1")
        + &event("web", "e3", "exported", "u2")
        + &event("web", "e4", "exported", "staff1")
        + &event("mcp", "e5", "exported", "u3");
    let mut archive = tempfile::NamedTempFile::new().unwrap();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(lines.as_bytes()).unwrap();
    archive.write_all(&encoder.finish().unwrap()).unwrap();
    w.import(1, "hash", 1, archive.path()).unwrap();
    std::fs::create_dir_all(temp.path().join("slurp/definitions")).unwrap();
    Some((temp, w))
}

fn define(root: &Path, file: &str, sql: &str) {
    std::fs::write(root.join("slurp/definitions").join(file), sql).unwrap();
}

fn slurp(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .args(args)
        .arg("--project")
        .arg(root)
        .arg("--json")
        .env("SLURP_HOME", root.join("home"))
        .output()
        .unwrap()
}

fn ok(output: &Output) -> Value {
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).unwrap()
}

fn failure(output: &Output) -> String {
    assert!(!output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Call one MCP tool on an in-process server; returns (`is_error`, parsed JSON of the text result).
fn tool(server: &slurp_app::mcp::Server, name: &str, arguments: &Value) -> (bool, Value) {
    let response = server
        .handle_line(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":arguments}}).to_string())
        .unwrap();
    let result = &response["result"];
    (
        result["isError"].as_bool().unwrap(),
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap(),
    )
}

fn server(w: &Workspace, root: &Path) -> slurp_app::mcp::Server {
    let server =
        slurp_app::mcp::Server::new(w, root.into(), env!("CARGO_BIN_EXE_slurp").into(), false);
    server.handle_line(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}).to_string()).unwrap();
    server
}

#[test]
fn definitions_compose_and_reach_every_surface() {
    let Some((temp, w)) = seeded() else { return };
    let root = temp.path();
    // active_people sorts before is_internal but uses it, so the files must load in dependency order.
    define(
        root,
        "active_people.sql",
        "-- People who exported since a time. Unit: person (events_with_person.person_id).\n\
         -- Excludes staff and events sent by the MCP test tools.\n\
         CREATE OR REPLACE TEMP MACRO active_people(since := TIMESTAMPTZ '2026-01-01') AS TABLE\n\
         SELECT person_id, min(timestamp) AS first_seen FROM events_with_person\n\
         WHERE event = 'exported' AND sender <> 'mcp' AND NOT is_internal(person_id) AND timestamp >= since\n\
         GROUP BY person_id",
    );
    define(
        root,
        "is_internal.sql",
        "-- Staff accounts.\nCREATE OR REPLACE TEMP MACRO is_internal(person) AS person LIKE 'u:staff%';\n",
    );
    define(
        root,
        "pro_events.sql",
        "-- Events from people on the pro plan.\nCREATE OR REPLACE TEMP VIEW pro_events AS SELECT * FROM events WHERE data->>'plan' = 'pro';",
    );
    // A name in a string is not a reference: y_code needs nothing, so x_label loads after it.
    define(
        root,
        "x_label.sql",
        "CREATE OR REPLACE TEMP MACRO x_label() AS y_code();",
    );
    define(
        root,
        "y_code.sql",
        "CREATE OR REPLACE TEMP MACRO y_code() AS 'x_label';",
    );
    // q_times's parameter shares p_double's name, which the text alone reads as a cycle; DuckDB's error settles it.
    define(
        root,
        "p_double.sql",
        "CREATE OR REPLACE TEMP MACRO p_double() AS q_times(2);",
    );
    define(
        root,
        "q_times.sql",
        "CREATE OR REPLACE TEMP MACRO q_times(p_double) AS p_double * 2;",
    );
    // A default is evaluated when the macro is created, so every session must be in UTC by then.
    define(
        root,
        "session_zone.sql",
        "CREATE OR REPLACE TEMP MACRO session_zone(zone := current_setting('TimeZone')) AS zone;",
    );
    let result = ok(&slurp(
        root,
        &[
            "sql",
            "SELECT x_label() AS label, p_double() AS doubled, session_zone() AS zone",
        ],
    ));
    assert_eq!(result["rows"], json!([["x_label", 4, "UTC"]]));
    let count = "SELECT count(*) AS n FROM active_people()";

    let result = ok(&slurp(root, &["sql", count]));
    assert_eq!(result["rows"], json!([[2]]));
    let result = ok(&slurp(
        root,
        &["sql", "SELECT count(*) AS n FROM pro_events"],
    ));
    assert_eq!(result["rows"], json!([[2]]));
    let own_mistake = failure(&slurp(root, &["sql", "SELECT nope FROM events"]));
    assert!(
        own_mistake.contains("nope") && !own_mistake.contains("slurp/definitions"),
        "an error in the caller's SQL is reported as it is: {own_mistake}"
    );

    let listed = ok(&slurp(root, &["definitions"]));
    let by_name = |name: &str| {
        listed["definitions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("{name} is listed: {listed}"))
    };
    let active = by_name("active_people");
    assert_eq!(active["kind"], "table_macro");
    assert_eq!(active["parameters"], json!(["since"]));
    assert_eq!(active["file"], "slurp/definitions/active_people.sql");
    assert!(
        active["description"]
            .as_str()
            .unwrap()
            .starts_with("People who exported")
    );
    assert_eq!(by_name("is_internal")["kind"], "macro");
    assert_eq!(by_name("pro_events")["kind"], "view");
    let one = ok(&slurp(root, &["definitions", "active_people"]));
    assert!(
        one["sql"]
            .as_str()
            .unwrap()
            .contains("is_internal(person_id)")
    );

    // The MCP server reads the same files, inside its sandbox, and picks up an edit without a restart.
    let server = server(&w, root);
    let (is_error, result) = tool(&server, "sql", &json!({"query": count}));
    assert!(!is_error, "{result}");
    assert_eq!(result["rows"], json!([[2]]));
    let (_, schema) = tool(&server, "describe_schema", &json!({}));
    assert_eq!(
        schema["definitions"].as_array().unwrap().len(),
        8,
        "{schema}"
    );
    define(
        root,
        "is_internal.sql",
        "CREATE OR REPLACE TEMP MACRO is_internal(person) AS person LIKE 'u:staff%' OR person = 'u:u2';",
    );
    let (_, result) = tool(&server, "sql", &json!({"query": count}));
    assert_eq!(result["rows"], json!([[1]]));
    let (is_error, blocked) = tool(
        &server,
        "sql",
        &json!({"query": "SELECT * FROM read_csv('/etc/passwd')"}),
    );
    assert!(is_error, "{blocked}");
    assert!(
        !blocked.to_string().contains("slurp/definitions"),
        "{blocked}"
    );

    // Reports call definitions like any SQL.
    let report = root.join("people.md");
    std::fs::write(
        &report,
        "# Active\n\n```sql who\nSELECT string_agg(person_id, '+' ORDER BY person_id) AS who FROM active_people()\n```\n\n```table\nquery: who\n```\n",
    )
    .unwrap();
    ok(&slurp(root, &["report", "check", report.to_str().unwrap()]));
    let out = root.join("out");
    ok(&slurp(
        root,
        &[
            "report",
            "build",
            report.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ],
    ));
    let html = std::fs::read_to_string(out.join("report.html")).unwrap();
    assert!(
        html.contains("u:u1"),
        "the report shows the definition's rows"
    );

    let mut shell = Command::new(env!("CARGO_BIN_EXE_slurp"))
        .args(["duckdb", "--project"])
        .arg(root)
        .env("SLURP_HOME", root.join("home"))
        .env("TZ", "Pacific/Kiritimati")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    shell
        .stdin
        .take()
        .unwrap()
        .write_all(b"SELECT 'people=' || count(*) || ' zone=' || any_value(session_zone()) AS answer FROM active_people();\n")
        .unwrap();
    let shell = shell.wait_with_output().unwrap();
    assert!(
        String::from_utf8_lossy(&shell.stdout).contains("people=1 zone=UTC"),
        "{shell:?}"
    );

    // Nothing was stored: a session without the definitions does not know them.
    let stored = w
        .execute(
            "SELECT count(*) AS n FROM duckdb_functions() WHERE function_name IN ('active_people', 'is_internal')",
            true,
        )
        .unwrap();
    assert_eq!(stored[0]["n"], 0);
}

#[test]
fn a_broken_or_unsafe_definition_is_named() {
    let Some((temp, w)) = seeded() else { return };
    let root = temp.path();
    define(
        root,
        "is_internal.sql",
        "CREATE OR REPLACE TEMP MACRO is_internal(person) AS person LIKE 'u:staff%';",
    );

    define(
        root,
        "broken.sql",
        "CREATE OR REPLACE TEMP MACRO broken() AS TABLE SELECT * FROM evnts;",
    );
    let error = failure(&slurp(root, &["sql", "SELECT 1 AS one"]));
    assert!(
        error.contains("slurp/definitions/broken.sql did not load") && error.contains("evnts"),
        "{error}"
    );
    assert!(failure(&slurp(root, &["definitions"])).contains("broken.sql"));
    // Schema discovery keeps working and says what is wrong.
    let (is_error, schema) = tool(&server(&w, root), "describe_schema", &json!({}));
    assert!(!is_error, "{schema}");
    assert!(
        schema["definition_problem"]
            .as_str()
            .unwrap()
            .contains("broken.sql"),
        "{schema}"
    );

    // A definition that is not TEMP would be stored in the database; the read-only session refuses it.
    define(root, "broken.sql", "CREATE OR REPLACE MACRO broken() AS 1;");
    let error = failure(&slurp(root, &["sql", "SELECT 1 AS one"]));
    assert!(
        error.contains("broken.sql") && error.contains("TEMP"),
        "{error}"
    );

    // A file may only create objects: a stray query would mix its rows into the caller's result.
    define(
        root,
        "broken.sql",
        "CREATE OR REPLACE TEMP VIEW broken AS SELECT 1 AS x;\nSELECT 42 AS stray;",
    );
    let error = failure(&slurp(root, &["sql", "SELECT 1 AS one"]));
    assert!(
        error.contains("broken.sql printed a query result"),
        "{error}"
    );

    // A file named after a different object, or one that replaces a built-in, is refused by every command.
    define(
        root,
        "broken.sql",
        "CREATE OR REPLACE TEMP VIEW something_else AS SELECT 1 AS x;",
    );
    let error = failure(&slurp(root, &["definitions"]));
    assert!(
        error.contains("broken.sql does not create `broken`") && error.contains("something_else"),
        "{error}"
    );
    std::fs::remove_file(root.join("slurp/definitions/broken.sql")).unwrap();
    define(
        root,
        "business.sql",
        "CREATE OR REPLACE TEMP MACRO pct(part, total) AS 999;",
    );
    let error = failure(&slurp(root, &["sql", "SELECT pct(1, 4) AS share"]));
    assert!(
        error.contains("`pct` would replace a built-in")
            && error.contains("business.sql does not create `business`"),
        "{error}"
    );
    std::fs::remove_file(root.join("slurp/definitions/business.sql")).unwrap();
    define(
        root,
        "events_with_person.sql",
        "CREATE OR REPLACE TEMP VIEW events_with_person AS SELECT * FROM events;",
    );
    let error = failure(&slurp(root, &["sql", "SELECT 1 AS one"]));
    assert!(
        error.contains("`events_with_person` would replace a built-in"),
        "{error}"
    );
    std::fs::remove_file(root.join("slurp/definitions/events_with_person.sql")).unwrap();

    // Definitions that use each other cannot load in any order.
    define(
        root,
        "cyc_a.sql",
        "CREATE OR REPLACE TEMP MACRO cyc_a() AS cyc_b();",
    );
    define(
        root,
        "cyc_b.sql",
        "CREATE OR REPLACE TEMP MACRO cyc_b() AS cyc_a();",
    );
    let error = failure(&slurp(root, &["sql", "SELECT 1 AS one"]));
    assert!(
        error.contains("cannot load in any order") && error.contains("cyc_"),
        "{error}"
    );
}

#[test]
fn a_snapshot_keeps_definitions_stable_until_the_next_operation() {
    let Some((temp, w)) = seeded() else { return };
    define(
        temp.path(),
        "sample.sql",
        "CREATE TEMP MACRO sample() AS TABLE SELECT 1 AS value;",
    );
    let live = w.with_definitions(temp.path());
    let frozen = live.snapshot_definitions().unwrap();
    define(
        temp.path(),
        "sample.sql",
        "CREATE TEMP MACRO sample() AS TABLE SELECT 2 AS changed;",
    );
    assert_eq!(
        frozen.query("SELECT * FROM sample()").unwrap()["rows"],
        json!([[1]])
    );
    let fresh = live.query("SELECT * FROM sample()").unwrap();
    assert_eq!(fresh["columns"][0]["name"], "changed");
    assert_eq!(fresh["rows"], json!([[2]]));
}

#[test]
fn report_check_rejects_a_broken_selected_project() {
    let Some((temp, _)) = seeded() else { return };
    let report = temp.path().join("report.md");
    std::fs::write(
        &report,
        "# Report\n\n```sql q\nSELECT missing FROM missing_table\n```\n",
    )
    .unwrap();
    std::fs::write(temp.path().join("slurp/slurp.toml"), "invalid TOML").unwrap();
    let error = failure(&slurp(
        temp.path(),
        &["report", "check", report.to_str().unwrap()],
    ));
    assert!(error.contains("--project"), "{error}");
}

/// The definitions published in `examples/definitions` load as they are and give the answer their README promises.
#[test]
fn the_published_example_definitions_answer_the_readme_query() {
    let Some((temp, w)) = seeded() else { return };
    let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/definitions");
    for entry in std::fs::read_dir(&examples).unwrap() {
        let file = entry.unwrap().path();
        if file.extension().is_some_and(|e| e == "sql") {
            std::fs::copy(
                &file,
                temp.path()
                    .join("slurp/definitions")
                    .join(file.file_name().unwrap()),
            )
            .unwrap();
        }
    }
    // u1 (pro) exports a day after signing up; u2 (free) only after ten days, outside the default week.
    w.execute(
        "INSERT INTO events(sender, id, type, event, user_id, timestamp, data) VALUES \
         ('web', 'x1', 'track', 'export_completed', 'u1', TIMESTAMPTZ '2026-11-03 10:00:00+00', NULL), \
         ('web', 'x2', 'track', 'signed_up', 'u2', TIMESTAMPTZ '2026-11-02 10:00:00+00', '{\"plan\":\"free\"}'), \
         ('web', 'x3', 'track', 'export_completed', 'u2', TIMESTAMPTZ '2026-11-12 10:00:00+00', NULL)",
        false,
    )
    .unwrap();
    let readme = std::fs::read_to_string(examples.join("README.md")).unwrap();
    let query = readme
        .split("```sql\n")
        .nth(1)
        .and_then(|rest| rest.split("```").next())
        .expect("the README has a sql block");
    // A query that starts with a `--` comment goes through --file (as an argument it would read as a flag).
    let file = temp.path().join("activation.sql");
    std::fs::write(&file, query).unwrap();
    let result = ok(&slurp(
        temp.path(),
        &["sql", "--file", file.to_str().unwrap()],
    ));
    let rows: Vec<(String, f64)> = result["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row[0].as_str().unwrap().to_owned(),
                row[1].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(rows, [("free".to_owned(), 0.0), ("pro".to_owned(), 100.0)]);
    let week_and_a_half = ok(&slurp(
        temp.path(),
        &[
            "sql",
            "SELECT count(*) AS n FROM activated_people(within := INTERVAL 11 DAY)",
        ],
    ));
    assert_eq!(week_and_a_half["rows"], json!([[2]]));
}
