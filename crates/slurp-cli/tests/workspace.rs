use serde_json::json;
use slurp_app::Workspace;
fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = std::env::var_os("SLURP_TEST_DUCKDB")?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(
        temp.path(),
        "http://localhost:8080".into(),
        "src_test".into(),
        None,
        exe.into(),
    )
    .expect("initialize workspace");
    Some((temp, w))
}
fn archive(lines: &str) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().expect("archive file");
    let bytes = zstd::encode_all(lines.as_bytes(), 1).expect("compress");
    std::io::Write::write_all(&mut f, &bytes).expect("write");
    f
}
#[test]
fn replay_conflict_and_binding() {
    let Some((temp, w)) = workspace() else {
        eprintln!("set SLURP_TEST_DUCKDB for native integration tests");
        return;
    };
    let event = r#"{"id":"e1","type":"track","event":"signup","timestamp":"2026-11-04T00:00:00Z","data":{"amount":12345678901234567890},"received_at":"2026-11-04T00:00:01Z","received_seq":"1"}"#;
    let f = archive(&format!("{event}\n{event}\n"));
    w.import("a", 1, "hash", 1, f.path()).expect("first import");
    w.import("a", 1, "hash", 1, f.path()).expect("replay");
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM events", true)
            .expect("count"),
        json!([{"n":1}])
    );
    let second = archive(&event.replace("00:00:01Z", "00:00:02Z"));
    w.import("a", 2, "hash2", 2, second.path())
        .expect("changed stamps retry");
    let conflict = archive(&event.replace("signup", "purchase"));
    assert!(w.import("a", 3, "hash3", 3, conflict.path()).is_err());
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM _slurp.deliveries", true)
            .expect("receipts"),
        json!([{"n":2}])
    );
    assert!(w.import("a", 1, "changed", 1, f.path()).is_err());
    Workspace::load(temp.path()).expect("matching identity");
    assert!(
        Workspace::init(
            temp.path(),
            "http://localhost:8080".into(),
            "src_other".into(),
            None,
            w.duckdb.clone()
        )
        .is_err()
    );
}
#[test]
fn report_outputs() {
    let Some((temp, w)) = workspace() else { return };
    let file = temp.path().join("report.md");
    std::fs::write(&file,"# Events\n\n```sql total\nSELECT count(*) AS n FROM events\n```\n\n```metric\nquery: total\nfield: n\nlabel: Events\n```\n").expect("report");
    slurp_app::report::build(&w, &file, &temp.path().join("output"), false, true, true)
        .expect("render report");
    assert!(temp.path().join("output/report.pdf").is_file());
}

#[test]
fn a_report_uses_its_own_theme_and_template_files() {
    let Some((temp, w)) = workspace() else { return };
    let dir = temp.path();
    std::fs::write(
        dir.join("paper.json"),
        r##"{"name":"Paper","bg":"#fffaf0","fg":"#222222","accent":"#c2410c","series":["#c2410c","#0f766e"]}"##,
    )
    .unwrap();
    std::fs::write(
        dir.join("mine.css"),
        "/* slurp-template\n font: sans\n*/body{background:%BG%;color:%FG%;font-family:%FONT%}.value{color:%ACCENT%}",
    )
    .unwrap();
    let report = dir.join("report.md");
    std::fs::write(&report, "---\nstyle: mine.css\ntheme: paper.json\npurpose: Counting events\ndate: Jan 2, 2027\n---\n# Events\n\n```sql total\nSELECT count(*) AS n FROM events\n```\n\n```metric\nquery: total\nfield: n\nlabel: Events\n```\n").unwrap();
    slurp_app::report::build(&w, &report, &dir.join("out"), false, true, false)
        .expect("custom look");
    let html = std::fs::read_to_string(dir.join("out/report.html")).unwrap();
    assert!(
        html.contains("background:#fffaf0"),
        "theme colour reaches the template"
    );
    assert!(html.contains("color:#c2410c") && html.contains("font-family:'Geist',sans-serif"));
    assert!(html.contains("Counting events") && html.contains("Jan 2, 2027"));
    assert!(dir.join("out/report.png").is_file());
    // The command line wins over the front matter, and a bad file is a clear error.
    let look = slurp_app::report::Look {
        theme: Some("gruvbox-light".into()),
        ..Default::default()
    };
    slurp_app::report::build_with_params(
        &w,
        &report,
        &dir.join("out2"),
        &look,
        false,
        false,
        &Default::default(),
    )
    .unwrap();
    assert!(
        std::fs::read_to_string(dir.join("out2/report.html"))
            .unwrap()
            .contains("#fbf1c7")
    );
    std::fs::write(dir.join("paper.json"), r#"{"bg":"red"}"#).unwrap();
    let err =
        slurp_app::report::build(&w, &report, &dir.join("out3"), false, false, false).unwrap_err();
    assert!(format!("{err:#}").contains("paper.json"), "{err:#}");
}

#[test]
fn truncation_parameters_and_cancelled_transaction() {
    let Some((temp, w)) = workspace() else { return };
    let result = w
        .query("SELECT i FROM range(2000) t(i)")
        .expect("bounded query");
    assert_eq!(result["truncated"], true);
    assert_eq!(result["rows"].as_array().expect("rows").len(), 1000);
    let file = temp.path().join("parameter.md");
    std::fs::write(&file,"---\nparams:\n  amount: {type: number, default: 42}\n---\n# Parameter\n```sql total\nSELECT $amount AS n\n```\n```metric\nquery: total\nfield: n\n```\n").expect("report source");
    slurp_app::report::build(
        &w,
        &file,
        &temp.path().join("parameter-output"),
        false,
        false,
        false,
    )
    .expect("parameter report");
    let cancel = w.cancellation.clone();
    let worker = std::thread::spawn(move || {
        w.execute("BEGIN; INSERT INTO events(id) VALUES('uncommitted'); SELECT sum(i) FROM range(1000000000000) t(i); COMMIT;",false)
    });
    std::thread::sleep(std::time::Duration::from_millis(100));
    cancel.cancel();
    assert!(worker.join().expect("query thread").is_err());
    let reopened = Workspace::load(temp.path()).expect("open after killed transaction");
    assert_eq!(
        reopened
            .execute("SELECT count(*) AS n FROM events", true)
            .expect("rollback"),
        json!([{"n":0}])
    );
    std::fs::remove_file(&reopened.database).expect("remove database");
    assert!(Workspace::load(temp.path()).is_err());
    assert!(
        !reopened.database.exists(),
        "loading must not replace missing database"
    );
}

#[test]
fn behavioral_retention_runs_in_queries_and_reports() {
    let Some((temp, w)) = workspace() else { return };
    // Only allow-listed community extensions may load; this needs no network.
    assert!(
        w.with_extensions(&["httpfs".to_owned()])
            .unwrap_err()
            .to_string()
            .contains("unsupported DuckDB extension")
    );
    let Ok(w) = w.with_extensions(&["behavioral".to_owned()]) else {
        eprintln!(
            "skipped: the behavioral extension is not installed and this computer is offline"
        );
        return;
    };
    let days = [
        ("u1", "2026-11-02"),
        ("u1", "2026-11-09"),
        ("u2", "2026-11-02"),
        ("u3", "2026-11-03"),
        ("u3", "2026-11-10"),
    ];
    let lines: String = days
        .iter()
        .enumerate()
        .map(|(i, (user, day))| format!(r#"{{"id":"e{i}","type":"track","event":"seen","timestamp":"{day}T10:00:00Z","user_id":"{user}","data":{{}},"received_at":"{day}T10:00:01Z","received_seq":"{i}"}}"#) + "\n")
        .collect();
    w.import("a", 1, "hash", 1, archive(&lines).path())
        .expect("import");
    // Week 0 is everyone; week 1 is u1 and u3 (2 of 3 users came back).
    let rows = w
        .query(
            "SELECT sum(CASE WHEN r[1] THEN 1 ELSE 0 END)::INTEGER AS week0, sum(CASE WHEN r[2] THEN 1 ELSE 0 END)::INTEGER AS week1 FROM (\
             SELECT retention(date_trunc('week', timestamp::DATE) = DATE '2026-11-02', date_trunc('week', timestamp::DATE) = DATE '2026-11-09') AS r \
             FROM events GROUP BY user_id)",
        )
        .expect("retention query");
    assert_eq!(rows["rows"], json!([[3, 2]]));
    let report = temp.path().join("r.md");
    std::fs::write(&report, "---\nextensions: [behavioral]\n---\n# R\n\n```sql n\nSELECT behavioral_version() IS NOT NULL AS ok\n```\n\n```metric\nquery: n\nfield: ok\nlabel: Loaded\n```\n").unwrap();
    // The plain workspace does not have the extension loaded; the report loads it itself.
    let plain = Workspace::load(temp.path()).expect("reload");
    slurp_app::report::build(
        &plain,
        &report,
        &temp.path().join("out"),
        false,
        false,
        false,
    )
    .expect("report with extensions");
}

#[test]
fn non_finite_numbers_become_null_instead_of_breaking_queries_and_reports() {
    assert_eq!(
        slurp_app::null_non_finite(
            r#"[{"a":Infinity,"b":-Infinity,"c":NaN,"d":"NaN \"Infinity\"","e":1}]"#
        ),
        r#"[{"a":null,"b":null,"c":null,"d":"NaN \"Infinity\"","e":1}]"#
    );
    assert_eq!(slurp_app::null_non_finite("[1,2]"), "[1,2]");
    let Some((temp, w)) = workspace() else { return };
    let rows = w
        .query("SELECT 1.0 / 0 AS ratio, 'nan'::DOUBLE AS nothing, 2 AS ok")
        .expect("query");
    assert_eq!(rows["rows"], json!([[null, null, 2]]));
    let report = temp.path().join("r.md");
    std::fs::write(
        &report,
        "```sql q\nSELECT 1.0 / 0 AS ratio, 3 AS n\n```\n\n```table\nquery: q\n```\n",
    )
    .unwrap();
    slurp_app::report::build(&w, &report, &temp.path().join("out"), false, false, false)
        .expect("a report with an infinite ratio builds");
}
