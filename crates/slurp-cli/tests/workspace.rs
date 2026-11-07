use serde_json::{Value, json};
use slurp_app::Workspace;
fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = std::env::var_os("SLURP_TEST_DUCKDB")?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(
        temp.path(),
        "http://localhost:8080".into(),
        "prj_test".into(),
        None,
        exe.into(),
    )
    .expect("initialize workspace");
    Some((temp, w))
}
fn archive(lines: &str) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().expect("archive file");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut encoder, lines.as_bytes()).expect("compress");
    let bytes = encoder.finish().expect("compress");
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
            "prj_other".into(),
            None,
            w.duckdb.clone()
        )
        .is_err()
    );
}
/// The event id is the identity. The Worker may archive the same event twice when two senders deliver it; the local database keeps
/// one copy (the first), and only a different payload under the same id is an error.
#[test]
fn an_event_id_sent_by_two_senders_is_one_event_and_a_different_payload_is_a_conflict() {
    let Some((_temp, w)) = workspace() else {
        eprintln!("set SLURP_TEST_DUCKDB for native integration tests");
        return;
    };
    let line = |sender: &str, seq: u32, event: &str| {
        format!(
            r#"{{"received_at":"2026-11-04T00:00:0{seq}Z","received_seq":"{seq}","sender":"{sender}","id":"same","type":"track","event":"{event}","timestamp":"2026-11-04T00:00:00Z","data":{{}}}}"#
        )
    };
    let both = archive(&format!(
        "{}\n{}\n",
        line("web", 1, "signup"),
        line("ios", 2, "signup")
    ));
    w.import("a", 1, "hash", 1, both.path())
        .expect("the same event from two senders");
    assert_eq!(
        w.execute(
            "SELECT count(*) AS n, any_value(sender) AS sender FROM events",
            true
        )
        .expect("count"),
        json!([{"n": 1, "sender": "web"}]),
        "one event, attributed to the first sender"
    );
    let other = archive(&line("ios", 3, "purchase"));
    assert!(
        w.import("a", 2, "hash2", 2, other.path()).is_err(),
        "the same id with a different payload is a conflict, whoever sent it"
    );
}
/// GitHub releases and deployments, received as webhooks, are one query away: the `releases` view.
#[test]
fn the_releases_view_lists_github_releases_and_deployments_from_webhooks() {
    let Some((_temp, w)) = workspace() else {
        eprintln!("set SLURP_TEST_DUCKDB for native integration tests");
        return;
    };
    let line = |seq: u32, id: &str, event: &str, at: &str, data: &str| {
        format!(
            r#"{{"received_at":"2026-11-06T19:00:0{seq}Z","received_seq":"{seq}","sender":"github","id":"{id}","type":"track","event":"{event}","timestamp":"{at}","data":{data},"context":{{"webhook":{{"provider":"github","delivery":"{id}"}}}}}}"#
        )
    };
    let lines = [
        line(1, "github:1", "github.release.published", "2026-11-06T18:02:11Z", r#"{"action":"published","release":{"tag_name":"v1.4.0","name":"Faster checkout","html_url":"https://github.com/acme/shop/releases/tag/v1.4.0"},"repository":{"full_name":"acme/shop"}}"#),
        line(2, "github:2", "github.deployment_status.created", "2026-11-06T18:20:00Z", r#"{"action":"created","deployment_status":{"state":"success","environment":"production"},"deployment":{"ref":"v1.4.0","environment":"production"},"repository":{"full_name":"acme/shop"}}"#),
        line(3, "github:3", "github.workflow_run.completed", "2026-11-06T18:30:00Z", r#"{"workflow_run":{"name":"ci"}}"#),
        line(4, "other:4", "signed_up", "2026-11-06T18:40:00Z", "{}"),
    ]
    .join("\n");
    w.import("a", 1, "hash", 1, archive(&lines).path())
        .expect("import");
    assert_eq!(
        w.execute("SELECT kind, tag, name, repo, environment, state, sender FROM releases ORDER BY happened_at", true).expect("releases"),
        json!([
            {"kind":"release","tag":"v1.4.0","name":"Faster checkout","repo":"acme/shop","environment":null,"state":null,"sender":"github"},
            {"kind":"deployment","tag":"v1.4.0","name":null,"repo":"acme/shop","environment":"production","state":"success","sender":"github"}
        ]),
        "other events are not releases"
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
    std::fs::write(&file,"---\nparams:\n  amount: {type: number, default: 42}\n---\n# Parameter\n```sql total\nSELECT $amount AS n -- a comment may mention $price without defining it\n```\n```metric\nquery: total\nfield: n\n```\n").expect("report source");
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
fn errors_view_reads_sentry_events_without_changing_what_was_stored() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let t = "2026-11-02T10:00:00Z";
    let exception = |frames: Value| {
        json!({"level": "error", "release": "app@1", "environment": "prod", "platform": "javascript", "tags": {"feature": "checkout"},
            "exception": {"values": [
                {"type": "Error", "value": "wrapper"},
                {"type": "TypeError", "value": "x is undefined", "mechanism": {"type": "generic", "handled": false}, "stacktrace": {"frames": frames}}]}})
    };
    let frames = |line: u32| {
        json!([
            {"filename": "node_modules/lib/index.js", "function": "run", "lineno": 3, "in_app": false},
            {"filename": "app/cart.js", "function": "total", "lineno": line, "in_app": true},
            {"filename": "node_modules/lib/util.js", "function": "call", "lineno": 9, "in_app": false}
        ])
    };
    let mut lines = String::new();
    for (i, (id, data)) in [
        ("x1", exception(frames(10))),
        ("x2", exception(frames(99))), // same place, different line: same group
        ("x3", json!({"level": "error", "message": "plain", "exception": {"values": [{"type": "Other", "value": "boom", "stacktrace": {"frames": [{"function": "f", "module": "m"}]}}]}})),
        ("x4", json!({"level": "info", "message": "hello"})), // not an error: stays out of the view
    ]
    .into_iter()
    .enumerate()
    {
        let mut record: Value = serde_json::from_str(&event_line(id, "track", if id == "x4" { "message" } else { "error" }, Some("u1"), None, t, i + 1)).unwrap();
        record["data"] = data;
        lines += &(record.to_string() + "\n");
    }
    w.import("a", 1, "hash", 1, archive(&lines).path())
        .expect("import");
    let rows = w
        .query("SELECT id, exception_type, message, handled, top_function, top_file, top_line, release, environment, group_key, tags->>'feature' FROM errors ORDER BY id")
        .expect("errors");
    let rows = rows["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "only error events");
    assert_eq!(
        rows[0][1],
        json!("TypeError"),
        "the last exception is the one that was thrown"
    );
    assert_eq!(rows[0][2], json!("x is undefined"));
    assert_eq!(rows[0][3], json!(false));
    assert_eq!(rows[0][4], json!("total"), "the innermost in-app frame");
    assert_eq!(rows[0][5], json!("app/cart.js"));
    assert_eq!(rows[0][6], json!(10));
    assert_eq!(
        (rows[0][7].clone(), rows[0][8].clone(), rows[0][10].clone()),
        (json!("app@1"), json!("prod"), json!("checkout"))
    );
    assert_eq!(rows[0][9], rows[1][9], "line numbers do not split a group");
    assert_ne!(rows[0][9], rows[2][9]);
    assert_eq!(
        rows[2][5],
        json!("m"),
        "frames without a file fall back to the module"
    );
    let stored = w
        .query("SELECT data->'exception'->'values'->0->>'value' FROM events WHERE id = 'x1'")
        .expect("raw");
    assert_eq!(
        stored["rows"],
        json!([["wrapper"]]),
        "the view never rewrites the stored event"
    );
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
