mod common;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use slurp_app::{ImportStats, Workspace};
fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = common::duckdb()?;
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
/// One archive line: the Worker's envelope around a client's record, which is kept byte for byte.
fn envelope(sender: &str, received_at: &str, record: &str) -> String {
    format!(r#"{{"received_at":"{received_at}","sender":"{sender}","record":{record}}}"#)
}
fn text(lines: &[String]) -> String {
    lines.join("\n") + "\n"
}
fn stats(imported: u64, duplicates: u64, conflicts: u64, invalid: u64) -> ImportStats {
    ImportStats {
        imported,
        duplicates,
        conflicts,
        invalid,
    }
}
const AT: &str = "2026-11-04T00:00:01.000Z";
fn signup(id: &str, event: &str) -> String {
    envelope(
        "web",
        AT,
        &format!(r#"{{"id":"{id}","event":"{event}","timestamp":"2026-11-04T00:00:00Z"}}"#),
    )
}
/// Everything the import wrote, without the clock: what "replaying changes nothing" compares.
fn snapshot(w: &Workspace) -> Value {
    json!([
        w.execute("SELECT * FROM events ORDER BY sender, id", true).expect("events"),
        w.execute("SELECT project, sequence, sha256, bytes FROM _slurp.deliveries ORDER BY sequence", true).expect("receipts"),
        w.execute("SELECT kind, sender, id, archive_seq, line, record, detail FROM _slurp.problems ORDER BY kind, archive_seq, line", true).expect("problems"),
    ])
}

#[test]
fn a_replayed_archive_changes_nothing_and_a_changed_one_is_refused() {
    let Some((temp, w)) = workspace() else {
        return;
    };
    let f = archive(&text(&[
        signup("e1", "signup"),
        signup("e1", "signup"),   // a duplicate: the same content
        signup("e1", "purchase"), // a conflict
        "{not json".to_owned(),   // an invalid line
        signup("e2", "signup"),
    ]));
    assert_eq!(
        w.import(1, "hash", 1, f.path()).expect("first import"),
        stats(2, 1, 1, 1)
    );
    let first = snapshot(&w);
    assert_eq!(
        w.import(1, "hash", 1, f.path()).expect("replay"),
        stats(0, 0, 0, 0),
        "a replay counts nothing"
    );
    assert_eq!(
        snapshot(&w),
        first,
        "events, receipts and problems are unchanged"
    );
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM _slurp.problems", true)
            .expect("problems"),
        json!([{"n": 2}])
    );
    assert!(
        w.import(1, "changed", 1, f.path()).is_err(),
        "a receipt for the same sequence with another digest is an integrity failure"
    );
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

#[test]
fn a_conflicting_id_is_set_aside_and_the_rest_of_the_archive_is_imported() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    w.import(1, "h1", 1, archive(&text(&[signup("e1", "signup")])).path())
        .expect("first archive");
    let second = archive(&text(&[signup("e1", "purchase"), signup("e2", "signup")]));
    assert_eq!(
        w.import(2, "h2", 1, second.path())
            .expect("conflicts are not errors"),
        stats(1, 0, 1, 0)
    );
    assert_eq!(
        w.execute("SELECT id, event FROM events ORDER BY id", true)
            .expect("events"),
        json!([{"id": "e1", "event": "signup"}, {"id": "e2", "event": "signup"}]),
        "the first copy is kept"
    );
    let problems = w
        .execute(
            "SELECT kind, sender, id, archive_seq, line, detail, record FROM _slurp.problems",
            true,
        )
        .expect("problems");
    assert_eq!(problems[0]["kind"], "conflict");
    assert_eq!(
        (
            problems[0]["sender"].clone(),
            problems[0]["id"].clone(),
            problems[0]["archive_seq"].clone(),
            problems[0]["line"].clone()
        ),
        (json!("web"), json!("e1"), json!(2), json!(1))
    );
    assert!(
        problems[0]["detail"]
            .as_str()
            .unwrap()
            .contains("archive 1 line 1")
    );
    assert!(
        problems[0]["record"].as_str().unwrap().contains("purchase"),
        "the rejected record is kept"
    );
}

/// A record only has to be an object with what its type needs; the importer fills in the rest, in one place.
#[test]
fn a_minimal_record_imports_with_defaults_and_keeps_its_exact_bytes_in_the_fingerprint() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let record = r#"{ "event" : "opened",  "n":1.0, "wide":12345678901234567890 }"#;
    let geo = r#","geo":{"city":"Lyon","country":"FR","region":"ARA"}"#;
    let line = format!(
        r#"{{"received_at":"2026-11-07T12:00:00.000Z","sender":"ios"{geo},"record":{record}}}"#
    );
    assert_eq!(
        w.import(7, "h", 1, archive(&text(&[line])).path())
            .expect("import"),
        stats(1, 0, 0, 0)
    );
    let row = &w
        .execute("SELECT sender, id, type, event, strftime(timestamp, '%Y-%m-%dT%H:%M:%S') AS timestamp, strftime(received_at, '%Y-%m-%dT%H:%M:%S') AS received_at, data::VARCHAR AS data, context, geo->>'country' AS country, archive_seq, line, fingerprint, raw->>'wide' AS wide FROM events", true)
        .expect("event")[0];
    assert_eq!(row["sender"], "ios");
    assert_eq!(
        row["id"], "slurp:7:1",
        "a missing id is derived from the archive and line"
    );
    assert_eq!(row["type"], "track");
    assert_eq!(row["event"], "opened");
    assert_eq!(
        row["timestamp"], row["received_at"],
        "a missing timestamp is the time received"
    );
    assert_eq!(row["data"], "{}");
    assert_eq!(row["context"], Value::Null);
    assert_eq!(row["country"], "FR");
    assert_eq!(
        (row["archive_seq"].clone(), row["line"].clone()),
        (json!(7), json!(1))
    );
    assert_eq!(
        row["fingerprint"],
        hex::encode(Sha256::digest(record.as_bytes()))
    );
    assert_eq!(row["wide"], "12345678901234567890");
    // An identify record needs a user_id and nothing else.
    let identify = envelope("web", AT, r#"{"type":"identify","user_id":"u1"}"#);
    assert_eq!(
        w.import(8, "h8", 1, archive(&text(&[identify])).path())
            .expect("identify"),
        stats(1, 0, 0, 0)
    );
}

/// The first copy by (archive_seq, line) wins, whatever order the copies arrive in within the files.
#[test]
fn the_first_copy_is_deterministic_by_archive_seq_and_line() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let archive1 = archive(&text(&[
        signup("other", "signup"),
        signup("x", "from_line_2"),
        signup("x", "from_line_3"), // a different copy after the winner
        signup("y", "from_line_4"),
        signup("y", "from_line_4"), // the same copy: a duplicate
    ]));
    assert_eq!(
        w.import(1, "h1", 1, archive1.path()).unwrap(),
        stats(3, 1, 1, 0)
    );
    // A later archive repeats both ids with other content and one with the same content.
    let archive2 = archive(&text(&[
        signup("y", "from_line_4"),
        signup("x", "later"),
        signup("z", "z"),
    ]));
    assert_eq!(
        w.import(2, "h2", 1, archive2.path()).unwrap(),
        stats(1, 1, 1, 0)
    );
    assert_eq!(
        w.execute(
            "SELECT id, event, archive_seq, line FROM events ORDER BY id",
            true
        )
        .unwrap(),
        json!([
            {"id": "other", "event": "signup", "archive_seq": 1, "line": 1},
            {"id": "x", "event": "from_line_2", "archive_seq": 1, "line": 2},
            {"id": "y", "event": "from_line_4", "archive_seq": 1, "line": 4},
            {"id": "z", "event": "z", "archive_seq": 2, "line": 3},
        ])
    );
    assert_eq!(
        w.execute(
            "SELECT id, archive_seq, line FROM _slurp.problems ORDER BY archive_seq, line",
            true
        )
        .unwrap(),
        json!([
            {"id": "x", "archive_seq": 1, "line": 3},
            {"id": "x", "archive_seq": 2, "line": 2},
        ])
    );
}

/// The identity is (sender, id): two senders may use the same id for different events.
#[test]
fn the_same_id_from_two_senders_is_two_events() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let record = |event: &str| {
        format!(r#"{{"id":"same","event":"{event}","timestamp":"2026-11-04T00:00:00Z"}}"#)
    };
    let both = archive(&text(&[
        envelope("web", AT, &record("signup")),
        envelope("ios", AT, &record("purchase")),
        envelope("ios", AT, &record("purchase")), // the same sender again: a duplicate, not a conflict
    ]));
    assert_eq!(w.import(1, "h", 1, both.path()).unwrap(), stats(2, 1, 0, 0));
    assert_eq!(
        w.execute("SELECT sender, id, event FROM events ORDER BY sender", true)
            .unwrap(),
        json!([
            {"sender": "ios", "id": "same", "event": "purchase"},
            {"sender": "web", "id": "same", "event": "signup"},
        ])
    );
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM _slurp.problems", true)
            .unwrap(),
        json!([{"n": 0}])
    );
}

/// Lines that cannot be events become problems; they never stop an import.
#[test]
fn lines_of_the_wrong_shape_become_invalid_problems() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let lines = [
        "{not json".to_owned(),
        r#"{"received_at":"2026-11-07T12:00:00.000Z","sender":"web","record":[1]}"#.to_owned(),
        r#"{"received_at":"2026-11-07T12:00:00.000Z","record":{"event":"a"}}"#.to_owned(),
        envelope("web", AT, r#"{"type":"bad","event":"a"}"#),
        envelope("web", AT, r#"{"type":"track"}"#),
        envelope("web", AT, r#"{"type":"identify"}"#),
        envelope("web", AT, r#"{"event":"a","timestamp":"yesterday"}"#),
        envelope("web", AT, r#"{"event":"a","data":[1]}"#),
        envelope("web", AT, r#"{"id":"ok","event":"fine"}"#),
    ];
    assert_eq!(
        w.import(1, "h", 1, archive(&text(&lines)).path())
            .expect("import"),
        stats(1, 0, 0, 8)
    );
    let problems = w
        .execute(
            "SELECT line, detail FROM _slurp.problems WHERE kind = 'invalid' ORDER BY line",
            true,
        )
        .unwrap();
    assert_eq!(problems.as_array().unwrap().len(), 8);
    assert!(
        problems[0]["detail"]
            .as_str()
            .unwrap()
            .contains("not a JSON envelope")
    );
    assert_eq!(problems[1]["detail"], "the record is not a JSON object");
    assert_eq!(problems[2]["detail"], "the envelope has no sender");
    assert_eq!(problems[3]["detail"], "unknown type bad");
    assert_eq!(problems[4]["detail"], "a track record needs an event");
    assert_eq!(problems[5]["detail"], "an identify record needs a user_id");
    assert_eq!(problems[6]["detail"], "timestamp is not RFC 3339");
    assert_eq!(problems[7]["detail"], "data is not an object");
}

#[test]
fn a_truncated_archive_fails_before_anything_is_written() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let whole = std::fs::read(archive(&text(&[signup("e1", "signup")])).path()).unwrap();
    let cut = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(cut.path(), &whole[..whole.len() - 6]).unwrap();
    assert!(w.import(1, "h", 1, cut.path()).is_err());
    assert_eq!(
        w.execute("SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM _slurp.deliveries) AS receipts", true).unwrap(),
        json!([{"events": 0, "receipts": 0}])
    );
}

#[test]
fn a_retention_gap_is_one_problem_however_often_it_is_read() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let gap = slurp_client::api::Gap { from: 3, to: 4 };
    w.record_gap(&gap).expect("gap");
    w.record_gap(&gap).expect("the same gap again");
    assert_eq!(
        w.execute(
            "SELECT kind, archive_seq, line, detail FROM _slurp.problems",
            true
        )
        .expect("problems"),
        json!([{"kind": "gap", "archive_seq": 3, "line": 0, "detail": "archives 3 to 4 were deleted by retention before they were read"}])
    );
}

#[test]
fn a_retention_gap_makes_status_and_health_report_history_incomplete() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    assert!(w.status().unwrap().get("history_incomplete").is_none());
    assert!(
        slurp_app::health::run(&w)
            .unwrap()
            .get("history_incomplete")
            .is_none()
    );
    w.record_gap(&slurp_client::api::Gap { from: 3, to: 4 })
        .unwrap();
    w.record_gap(&slurp_client::api::Gap { from: 6, to: 7 })
        .unwrap();
    let expected = json!({"from": 3, "to": 7});
    let status = w.status().unwrap();
    assert_eq!(status["history_incomplete"], expected);
    assert_eq!(
        slurp_app::health::run(&w).unwrap()["history_incomplete"],
        expected
    );
}

#[test]
fn receipts_of_another_project_stop_a_sync_before_any_request() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    w.execute(
        "INSERT INTO _slurp.deliveries(project, sequence, sha256, bytes) VALUES('prj_ffffffffffffffff', 1, 'x', 1)",
        false,
    )
    .expect("a foreign receipt");
    let error = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(w.sync("t"))
        .expect_err("a different project's archives");
    assert!(error.to_string().contains("different project"), "{error}");
}

#[test]
fn health_reports_what_the_import_set_aside() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    w.import(
        1,
        "h",
        1,
        archive(&text(&[
            signup("e1", "a"),
            signup("e1", "b"),
            "oops".to_owned(),
        ]))
        .path(),
    )
    .unwrap();
    w.record_gap(&slurp_client::api::Gap { from: 5, to: 6 })
        .unwrap();
    let found = slurp_app::health::run(&w).expect("health");
    assert_eq!(
        found["problems"]["counts"],
        json!({"conflict": 1, "invalid": 1, "gap": 1})
    );
    assert_eq!(found["problems"]["latest"].as_array().unwrap().len(), 3);
    let finding = found["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["check"] == "import_problems")
        .expect("a finding for the problems");
    assert_eq!(finding["severity"], "warning");
}

/// GitHub releases and deployments, received as webhooks, are one query away: the `releases` view.
#[test]
fn the_releases_view_lists_github_releases_and_deployments_from_webhooks() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let line = |seq: u32, id: &str, event: &str, at: &str, data: &str| {
        envelope(
            if id.starts_with("other") {
                "web"
            } else {
                "github"
            },
            &format!("2026-11-06T19:00:0{seq}Z"),
            &format!(
                r#"{{"id":"{id}","type":"track","event":"{event}","timestamp":"{at}","data":{data},"context":{{"webhook":{{"provider":"github","delivery":"{id}"}}}}}}"#
            ),
        )
    };
    let lines = [
        line(1, "github:1", "github.release.published", "2026-11-06T18:02:11Z", r#"{"action":"published","release":{"tag_name":"v1.4.0","name":"Faster checkout","html_url":"https://github.com/acme/shop/releases/tag/v1.4.0"},"repository":{"full_name":"acme/shop"}}"#),
        line(2, "github:2", "github.deployment_status.created", "2026-11-06T18:20:00Z", r#"{"action":"created","deployment_status":{"state":"success","environment":"production"},"deployment":{"ref":"v1.4.0","environment":"production"},"repository":{"full_name":"acme/shop"}}"#),
        line(3, "github:3", "github.workflow_run.completed", "2026-11-06T18:30:00Z", r#"{"workflow_run":{"name":"ci"}}"#),
        line(4, "other:4", "signed_up", "2026-11-06T18:40:00Z", "{}"),
    ]
    .join("\n");
    w.import(1, "hash", 1, archive(&lines).path())
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

/// RevenueCat purchases, received as webhooks, are one query away: the `revenue` view.
#[test]
fn the_revenue_view_lists_revenuecat_purchases_and_leaves_out_the_test_event() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let line = |seq: u32, id: &str, event: &str, at: &str, data: &str| {
        envelope(
            if id.starts_with("other") {
                "web"
            } else {
                "revenuecat"
            },
            &format!("2026-11-06T19:00:0{seq}Z"),
            &format!(
                r#"{{"id":"{id}","type":"track","event":"{event}","timestamp":"{at}","data":{data},"context":{{"webhook":{{"provider":"revenuecat","delivery":"{id}"}}}}}}"#
            ),
        )
    };
    let lines = [
        line(1, "revenuecat:1", "revenuecat.initial_purchase", "2026-11-06T18:02:11Z", r#"{"api_version":"1.0","event":{"type":"INITIAL_PURCHASE","app_user_id":"u1","product_id":"pro_monthly","period_type":"NORMAL","renewal_number":1,"price":9.99,"price_in_purchased_currency":8.99,"currency":"EUR","store":"APP_STORE","environment":"PRODUCTION","country_code":"DE"}}"#),
        line(2, "revenuecat:2", "revenuecat.cancellation", "2026-11-06T18:10:00Z", r#"{"event":{"type":"CANCELLATION","app_user_id":"u1","product_id":"pro_monthly","environment":"PRODUCTION"}}"#),
        line(3, "revenuecat:3", "revenuecat.test", "2026-11-06T18:20:00Z", r#"{"event":{"type":"TEST","environment":"SANDBOX"}}"#),
        line(4, "other:4", "signed_up", "2026-11-06T18:40:00Z", "{}"),
    ]
    .join("\n");
    w.import(1, "hash", 1, archive(&lines).path())
        .expect("import");
    assert_eq!(
        w.execute("SELECT type, app_user_id, product_id, period_type, renewal_number, price, price_in_purchased_currency, currency, store, environment, country_code, sender FROM revenue ORDER BY happened_at", true).expect("revenue"),
        json!([
            {"type":"INITIAL_PURCHASE","app_user_id":"u1","product_id":"pro_monthly","period_type":"NORMAL","renewal_number":1,"price":9.99,"price_in_purchased_currency":8.99,"currency":"EUR","store":"APP_STORE","environment":"PRODUCTION","country_code":"DE","sender":"revenuecat"},
            {"type":"CANCELLATION","app_user_id":"u1","product_id":"pro_monthly","period_type":null,"renewal_number":null,"price":null,"price_in_purchased_currency":null,"currency":null,"store":null,"environment":"PRODUCTION","country_code":null,"sender":"revenuecat"}
        ]),
        "the dashboard test event and other events are not revenue"
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
        w.execute("BEGIN; INSERT INTO events(sender, id) VALUES('web', 'uncommitted'); SELECT sum(i) FROM range(1000000000000) t(i); COMMIT;",false)
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
        // Installing it needs the network; CI has it, so there a failure is a failure.
        common::may_skip("the behavioral extension is not installed and this computer is offline");
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
        .map(|(i, (user, day))| {
            envelope(
                "web",
                &format!("{day}T10:00:01Z"),
                &format!(r#"{{"id":"e{i}","type":"track","event":"seen","timestamp":"{day}T10:00:00Z","user_id":"{user}","data":{{}}}}"#),
            ) + "\n"
        })
        .collect();
    w.import(1, "hash", 1, archive(&lines).path())
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
    _seq: usize,
) -> String {
    let mut record = json!({"id": id, "type": kind, "timestamp": at, "data": {}});
    if kind == "track" {
        record["event"] = json!(event);
    }
    if let Some(user) = user {
        record["user_id"] = json!(user);
    }
    if let Some(anon) = anon {
        record["anonymous_id"] = json!(anon);
    }
    envelope("web", at, &record.to_string()) + "\n"
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
    w.import(1, "hash", 1, archive(&lines).path())
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
        record["record"]["data"] = data;
        lines += &(record.to_string() + "\n");
    }
    w.import(1, "hash", 1, archive(&lines).path())
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
    next();
    lines += &(envelope(
        "web",
        "2026-11-02T10:00:00Z",
        r#"{"id":"f1","type":"track","event":"opened","user_id":"f1","timestamp":"2026-11-03T10:00:00Z","data":{}}"#,
    ) + "\n");
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
    w.import(1, "hash", 1, archive(&lines).path())
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
