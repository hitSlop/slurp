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

fn event_line(
    id: &str,
    kind: &str,
    event: &str,
    user: Option<&str>,
    anon: Option<&str>,
    at: &str,
    seq: usize,
) -> String {
    let mut record = json!({"id": id, "type": kind, "timestamp": at, "data": {}, "received_at": at, "received_seq": seq.to_string()});
    if kind == "track" {
        record["event"] = json!(event);
    }
    if let Some(user) = user {
        record["user_id"] = json!(user);
    }
    if let Some(anon) = anon {
        record["anonymous_id"] = json!(anon);
    }
    record.to_string() + "\n"
}

#[test]
fn helpers_are_installed_and_identities_are_stitched_without_guessing() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let t = "2026-11-02T10:00:00Z";
    let mut lines = String::new();
    // a1 browses, then identifies as exactly one user (u1); a2 identifies as two users (ambiguous); a3 never identifies.
    lines += &event_line("e1", "track", "viewed", None, Some("a1"), t, 1);
    lines += &event_line("i1", "identify", "", Some("u1"), Some("a1"), t, 2);
    lines += &event_line("e2", "track", "viewed", Some("u1"), None, t, 3);
    lines += &event_line("e3", "track", "viewed", None, Some("a2"), t, 4);
    lines += &event_line("i2", "identify", "", Some("u2"), Some("a2"), t, 5);
    lines += &event_line("i3", "identify", "", Some("u3"), Some("a2"), t, 6);
    lines += &event_line("e4", "track", "viewed", None, Some("a3"), t, 7);
    w.import("a", 1, "hash", 1, archive(&lines).path())
        .expect("import");
    let rows = w
        .query("SELECT id, person_id FROM events_with_person ORDER BY id")
        .expect("people");
    let people: std::collections::BTreeMap<String, String> = rows["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r[0].as_str().unwrap().to_owned(),
                r[1].as_str().unwrap_or("none").to_owned(),
            )
        })
        .collect();
    assert_eq!(
        people["e1"], "u:u1",
        "an anonymous event joins the user it was identified as"
    );
    assert_eq!(people["e2"], "u:u1");
    assert_eq!(
        people["e3"], "a:a2",
        "a visitor tied to two users is not merged by guesswork"
    );
    assert_eq!(people["e4"], "a:a3");
    // The small macros.
    let macros = w
        .query("SELECT pct(25, 200) AS p, safe_num('x') AS bad, biz_date(TIMESTAMPTZ '2026-10-01 03:00:00+00') AS d, (SELECT count(*) FROM calendar('2026-10-01', '2026-10-04')) AS days, session_start(TIMESTAMP '2026-01-01 10:40', TIMESTAMP '2026-01-01 10:00', 30) AS gap, session_start(TIMESTAMP '2026-01-01 10:10', TIMESTAMP '2026-01-01 10:00', 30) AS same")
        .expect("macros");
    assert_eq!(macros["rows"], json!([[12.5, null, "2026-10-01", 4, 1, 0]]));
}

#[test]
fn health_reports_only_what_needs_attention() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let ok = slurp_app::health::run(&w).expect("health on an empty database");
    assert_eq!(ok["ok"], json!(true));
    let t = "2026-11-02T10:00:00Z";
    let mut lines = String::new();
    let mut seq = 0;
    let mut next = || {
        seq += 1;
        seq
    };
    // Event names spelled two ways.
    for (i, name) in ["Signed_Up", "signed_up", "signed_up"].iter().enumerate() {
        lines += &event_line(
            &format!("c{i}"),
            "track",
            name,
            Some(&format!("c{i}")),
            None,
            t,
            next(),
        );
    }
    // A client clock a day ahead.
    let mut ahead = event_line(
        "f1",
        "track",
        "opened",
        Some("f1"),
        None,
        "2026-11-03T10:00:00Z",
        next(),
    );
    ahead = ahead.replace(
        "\"received_at\":\"2026-11-03T10:00:00Z\"",
        "\"received_at\":\"2026-11-02T10:00:00Z\"",
    );
    lines += &ahead;
    // One id that is far busier than 30 ordinary ones.
    for i in 0..30 {
        lines += &event_line(
            &format!("n{i}"),
            "track",
            "opened",
            Some(&format!("normal{i}")),
            None,
            t,
            next(),
        );
    }
    for i in 0..1100 {
        lines += &event_line(
            &format!("b{i}"),
            "track",
            "opened",
            Some("bot_1"),
            None,
            &format!("2026-11-02T10:{:02}:{:02}Z", i / 60 % 60, i % 60),
            next(),
        );
    }
    // The same event tracked twice under different ids.
    lines += &event_line("d1", "track", "paid", Some("d"), None, t, next());
    lines += &event_line("d2", "track", "paid", Some("d"), None, t, next());
    w.import("a", 1, "hash", 1, archive(&lines).path())
        .expect("import");
    let found = slurp_app::health::run(&w).expect("health");
    assert_eq!(found["ok"], json!(false));
    let checks: Vec<&str> = found["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["check"].as_str().unwrap())
        .collect();
    assert_eq!(
        checks,
        [
            "casing_variants",
            "future_timestamps",
            "duplicate_events",
            "heavy_hitters"
        ],
        "{found}"
    );
    let heavy = &found["findings"][3];
    assert_eq!(
        heavy["evidence"]["people"][0]["person_id"],
        json!("u:bot_1")
    );
    assert!(
        heavy["suggestion"]
            .as_str()
            .unwrap()
            .contains("Nothing was changed")
    );
    assert_eq!(found["findings"][2]["evidence"]["extra_events"], json!(1));
}
