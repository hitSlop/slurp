mod common;
use serde_json::{Value, json};
use slurp_app::Workspace;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
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
    Some((temp, w))
}
fn cli(root: &std::path::Path, args: &[&str], tz: &str) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_slurp"));
    cmd.args(args)
        .arg("--project")
        .arg(root)
        .arg("--json")
        .env("SLURP_HOME", root.join("home"))
        .env("TZ", tz);
    cmd
}
fn old_helpers(w: &Workspace) {
    w.execute(
        "DROP VIEW slurp_summary; CREATE OR REPLACE MACRO slurp_helpers_version() AS 5",
        false,
    )
    .unwrap();
}
fn mcp_summary(w: &Workspace, root: &std::path::Path) -> Value {
    let server =
        slurp_app::mcp::Server::new(w, root.into(), env!("CARGO_BIN_EXE_slurp").into(), false);
    server.handle_line(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}).to_string()).unwrap();
    server.handle_line(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"describe_schema","arguments":{}}}).to_string()).unwrap()
}
#[test]
fn reader_blocks_helper_update_but_not_reads_and_retry_recovers() {
    let Some((temp, w)) = workspace() else { return };
    old_helpers(&w);
    struct Holder(std::process::Child);
    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut holder = Holder(
        Command::new(&w.duckdb)
            .args(["-no-agent", "-init", "/dev/null", "-readonly"])
            .arg(&w.database)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let ready = temp.path().join("reader-ready.csv");
    writeln!(
        holder.0.stdin.as_mut().unwrap(),
        "COPY (SELECT 1) TO {} (FORMAT CSV);",
        slurp_app::literal(&ready.to_string_lossy())
    )
    .unwrap();
    holder.0.stdin.as_mut().unwrap().flush().unwrap();
    let started = std::time::Instant::now();
    while !ready.is_file() {
        assert!(holder.0.try_wait().unwrap().is_none());
        assert!(started.elapsed().as_secs() < 5);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let out = cli(
        temp.path(),
        &["sql", "SELECT count(*) AS n FROM events"],
        "UTC",
    )
    .output()
    .unwrap();
    assert!(out.status.success(), "{:?}", out);
    assert!(String::from_utf8_lossy(&out.stderr).contains("a later open will retry"));
    let loaded = Workspace::load_at(&temp.path().join("home"), temp.path()).unwrap();
    assert!(
        mcp_summary(&loaded, temp.path())["result"]["isError"]
            .as_bool()
            .unwrap()
    );
    assert!(
        mcp_summary(&loaded, temp.path())
            .to_string()
            .contains("writable database")
    );
    slurp_app::health::run(&loaded).unwrap();
    assert_eq!(
        loaded
            .execute("SELECT slurp_helpers_version() AS v", true)
            .unwrap()[0]["v"],
        5
    );
    drop(holder);
    let loaded = Workspace::load_at(&temp.path().join("home"), temp.path()).unwrap();
    loaded.require_helper("slurp_summary").unwrap();
    assert_eq!(
        loaded
            .execute("SELECT slurp_helpers_version() AS v", true)
            .unwrap()[0]["v"],
        6
    );
}
#[test]
fn read_only_file_with_old_helpers_still_allows_sql() {
    use std::os::unix::fs::PermissionsExt;
    let Some((temp, w)) = workspace() else { return };
    old_helpers(&w);
    std::fs::set_permissions(&w.database, std::fs::Permissions::from_mode(0o400)).unwrap();
    let out = cli(
        temp.path(),
        &["sql", "SELECT count(*) AS n FROM events"],
        "UTC",
    )
    .output()
    .unwrap();
    assert!(out.status.success(), "{:?}", out);
    assert!(String::from_utf8_lossy(&out.stderr).contains("could not update Slurp helper views"));
}
#[test]
fn sessions_and_shell_default_to_utc_in_both_offset_directions() {
    let Some((temp, w)) = workspace() else { return };
    let sql = "SELECT current_setting('TimeZone') AS zone, TIMESTAMPTZ '2026-11-08 03:00:00+00'::DATE AS early, TIMESTAMPTZ '2026-11-08 23:00:00+00'::DATE AS late, biz_date(now()) = current_date AS today, biz_date(TIMESTAMPTZ '2026-11-08 03:00:00+00') AS business_day";
    for tz in ["America/Regina", "Asia/Tokyo"] {
        let out = cli(temp.path(), &["sql", sql], tz).output().unwrap();
        assert!(out.status.success(), "{:?}", out);
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            result["rows"][0],
            json!(["UTC", "2026-11-08", "2026-11-08", true, "2026-11-08"])
        );
        let mut child = cli(temp.path(), &["duckdb"], tz)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"SELECT current_setting('TimeZone');\n")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("UTC"));
        // Test sandbox execution in a subprocess without mutating the test runner's environment.
        let requests = format!(
            "{}\n{}\n",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sql","arguments":{"query":sql}}})
        );
        let mut child = cli(temp.path(), &["mcp"], tz)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(requests.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        let response: Value =
            serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().last().unwrap())
                .unwrap();
        let result: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(result["rows"][0][0], "UTC");
    }
    let local = w
        .execute(
            "SELECT timezone('America/Regina', TIMESTAMPTZ '2026-11-08 03:00:00+00')::DATE AS day",
            true,
        )
        .unwrap();
    assert_eq!(local[0]["day"], "2026-11-07");
}

#[test]
fn overview_daily_query_uses_utc_buckets_and_window_boundaries() {
    let Some((temp, w)) = workspace() else { return };
    // Anchor to today's UTC date, so this test remains valid after the launch month.
    w.execute("INSERT INTO events(sender,id,type,event,user_id,timestamp) SELECT 'web',id,'track','view','person',instant FROM (VALUES ('early', timezone('UTC', current_date::TIMESTAMP + INTERVAL 3 HOUR)), ('late', timezone('UTC', current_date::TIMESTAMP + INTERVAL 23 HOUR)), ('first', timezone('UTC', (current_date-29)::TIMESTAMP)), ('too-old', timezone('UTC', (current_date-29)::TIMESTAMP) - INTERVAL 1 MICROSECOND), ('tomorrow', timezone('UTC', (current_date+1)::TIMESTAMP))) v(id,instant)",false).unwrap();
    let doc = slurp_app::report::parse(include_str!("../assets/overview.md")).unwrap();
    for tz in ["America/Regina", "Asia/Tokyo"] {
        let sql = format!(
            "WITH daily AS ({}) SELECT count(*) AS days,sum(events)::BIGINT AS events,sum(people)::BIGINT AS people,min(day)::VARCHAR AS first_day,max(day)::VARCHAR AS last_day FROM daily",
            doc.queries["daily"]
        );
        let out = cli(temp.path(), &["sql", &sql], tz).output().unwrap();
        assert!(out.status.success(), "{:?}", out);
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            &result["rows"][0].as_array().unwrap()[..3],
            &[json!(30), json!(3), json!(2)]
        );
        let out = cli(
            temp.path(),
            &[
                "report",
                "build",
                temp.path()
                    .join("slurp/reports/overview.md")
                    .to_str()
                    .unwrap(),
                "--out",
                temp.path().join(tz.replace('/', "-")).to_str().unwrap(),
                "--png",
            ],
            tz,
        )
        .output()
        .unwrap();
        assert!(out.status.success(), "{:?}", out);
    }
}
