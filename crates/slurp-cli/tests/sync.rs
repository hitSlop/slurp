//! `slurp sync` against a fake Worker: the `ListArchives` and `Publish` calls and the authenticated archive download, with the
//! real importer and DuckDB behind them.
mod common;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use slurp_app::Workspace;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};

const PROJECT: &str = "prj_0123456789abcdef";

#[derive(Default)]
struct State {
    /// (seq, gzip bytes) of every archive still on the Worker.
    archives: Vec<(u64, Vec<u8>)>,
    /// Gzip bytes that `Publish` turns into the next archive.
    buffered: Option<Vec<u8>>,
    /// `Publish` answers 403 (a secret key).
    publish_forbidden: bool,
    /// An archive that answers 404 on download although it is listed.
    missing: Option<u64>,
    /// Every request: (request line, authorization header, body).
    seen: Vec<(String, String, String)>,
}

fn gz(text: &str) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(text.as_bytes()).expect("compress");
    encoder.finish().expect("compress")
}

fn envelope(sender: &str, received_at: &str, record: &str) -> String {
    format!(r#"{{"received_at":"{received_at}","sender":"{sender}","record":{record}}}"#)
}

fn archive_text(lines: &[String]) -> String {
    lines.join("\n") + "\n"
}

fn reply(status: u16, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

fn error(status: u16, code: &str) -> Vec<u8> {
    reply(
        status,
        json!({"error": {"code": code, "message": code}})
            .to_string()
            .as_bytes(),
    )
}

fn handle(state: &Mutex<State>, line: &str, body: &str) -> Vec<u8> {
    let mut state = state.lock().unwrap();
    if line.starts_with("POST /v1/rpc/Publish") {
        if state.publish_forbidden {
            return error(403, "forbidden");
        }
        if let Some(bytes) = state.buffered.take() {
            let seq = state.archives.last().map_or(1, |(seq, _)| seq + 1);
            state.archives.push((seq, bytes));
        }
        return reply(
            200,
            json!({"coverage": {"pending": false}})
                .to_string()
                .as_bytes(),
        );
    }
    if line.starts_with("POST /v1/rpc/ListArchives") {
        let request: Value = serde_json::from_str(body).unwrap();
        let after = request["after"].as_u64();
        let limit = request["limit"].as_u64().unwrap_or(1000) as usize;
        let first = state.archives.first().map(|(seq, _)| *seq);
        let last = state.archives.last().map(|(seq, _)| *seq);
        let start = after.unwrap_or(first.unwrap_or(1) - first.map_or(0, |_| 1));
        let gap = first
            .zip(after)
            .filter(|(first, after)| after + 1 < *first)
            .map(|(first, after)| json!({"from": after + 1, "to": first - 1}));
        let archives: Vec<Value> = state
            .archives
            .iter()
            .filter(|(seq, _)| *seq > start)
            .take(limit)
            .map(|(seq, bytes)| {
                json!({"seq": seq, "size": bytes.len(), "sha256": hex::encode(Sha256::digest(bytes)), "events": 1, "createdAt": "2026-11-07T12:00:00.000Z"})
            })
            .collect();
        let mut coverage = json!({"pending": state.buffered.is_some()});
        if let (Some(first), Some(last)) = (first, last) {
            coverage["first"] = json!(first);
            coverage["last"] = json!(last);
            coverage["lastAt"] = json!("2026-11-07T12:00:00.000Z");
        }
        let mut page = json!({"coverage": coverage, "archives": archives});
        if let Some(gap) = gap {
            page["gap"] = gap;
        }
        return reply(200, page.to_string().as_bytes());
    }
    if let Some(rest) = line.strip_prefix(&format!("GET /v1/projects/{PROJECT}/archives/")) {
        let seq: u64 = rest.split(' ').next().unwrap().parse().unwrap();
        if state.missing == Some(seq) {
            return error(404, "not_found");
        }
        return match state.archives.iter().find(|(s, _)| *s == seq) {
            Some((_, bytes)) => reply(200, bytes),
            None => error(404, "not_found"),
        };
    }
    error(404, "not_found")
}

/// Starts the fake Worker; returns its URL and the shared state.
fn worker(state: State) -> (String, Arc<Mutex<State>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state = Arc::new(Mutex::new(state));
    let shared = state.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head_end, length) = loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break (0, 0);
                }
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buffer[..at]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (at + 4, length);
                }
            };
            while buffer.len() < head_end + length {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
            }
            let text = String::from_utf8_lossy(&buffer).into_owned();
            let line = text.lines().next().unwrap_or_default().to_owned();
            let auth = text
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .starts_with("authorization:")
                        .then(|| l[14..].trim().to_owned())
                })
                .unwrap_or_default();
            let body = text.get(head_end..).unwrap_or_default().to_owned();
            shared
                .lock()
                .unwrap()
                .seen
                .push((line.clone(), auth, body.clone()));
            let _ = stream.write_all(&handle(&shared, &line, &body));
        }
    });
    (url, state)
}

fn workspace(url: &str) -> Option<(tempfile::TempDir, Workspace)> {
    let exe = common::duckdb()?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(temp.path(), url.into(), PROJECT.into(), None, exe.into())
        .expect("initialize workspace");
    Some((temp, w))
}

fn run(w: &Workspace, token: &str) -> anyhow::Result<Value> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(w.sync(token))
}

fn rows(w: &Workspace, sql: &str) -> Value {
    w.execute(sql, true).expect("query")
}

fn track(id: &str, event: &str) -> String {
    envelope(
        "web",
        "2026-11-07T12:00:00.000Z",
        &format!(r#"{{"id":"{id}","event":"{event}","timestamp":"2026-11-07T11:59:00Z"}}"#),
    )
}

#[test]
fn a_conflicting_id_is_set_aside_and_sync_continues() {
    let archives = vec![
        (1, gz(&archive_text(&[track("e1", "signup")]))),
        (
            2,
            gz(&archive_text(&[
                track("e1", "purchase"), // same (sender, id), different content
                track("e2", "signup"),
                "this is not an envelope".into(),
            ])),
        ),
        (3, gz(&archive_text(&[track("e3", "signup")]))),
    ];
    let (url, state) = worker(State {
        archives,
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    let result = run(&w, "reader-token").expect("sync does not stop on content");
    assert_eq!(result["downloaded"], 3);
    assert_eq!(result["imported"], 3);
    assert_eq!(result["conflicts"], 1);
    assert_eq!(result["invalid"], 1);
    assert_eq!(result["gaps"], 0);
    assert_eq!(result["checkpoint"], "3");
    assert_eq!(result["has_published_archives"], true);
    assert_eq!(
        rows(&w, "SELECT id, event, archive_seq FROM events ORDER BY id"),
        json!([
            {"id": "e1", "event": "signup", "archive_seq": 1},
            {"id": "e2", "event": "signup", "archive_seq": 2},
            {"id": "e3", "event": "signup", "archive_seq": 3},
        ]),
        "the first copy of e1 is kept"
    );
    assert_eq!(
        rows(
            &w,
            "SELECT kind, archive_seq, line, id FROM _slurp.problems ORDER BY archive_seq, line"
        ),
        json!([
            {"kind": "conflict", "archive_seq": 2, "line": 1, "id": "e1"},
            {"kind": "invalid", "archive_seq": 2, "line": 3, "id": null},
        ])
    );
    assert_eq!(
        rows(
            &w,
            "SELECT project, count(*) AS n FROM _slurp.deliveries GROUP BY project"
        ),
        json!([{"project": PROJECT, "n": 3}])
    );

    // Archives are downloaded with the bearer token, and the next sync starts after the receipts.
    let again = run(&w, "reader-token").expect("second sync");
    assert_eq!(again["downloaded"], 0);
    assert_eq!(again["conflicts"], 0);
    let state = state.lock().unwrap();
    let downloads: Vec<_> = state
        .seen
        .iter()
        .filter(|(line, _, _)| line.starts_with("GET /v1/projects/"))
        .collect();
    assert_eq!(downloads.len(), 3);
    assert!(
        downloads
            .iter()
            .all(|(_, auth, _)| auth == "Bearer reader-token")
    );
    let last_list: Value = serde_json::from_str(
        &state
            .seen
            .iter()
            .rev()
            .find(|(line, _, _)| line.contains("ListArchives"))
            .unwrap()
            .2,
    )
    .unwrap();
    assert_eq!(last_list["after"], 3);
    assert_eq!(last_list["project"], PROJECT);
}

#[test]
fn archives_deleted_by_retention_are_a_gap_problem_and_sync_goes_on() {
    let (url, _state) = worker(State {
        archives: (4..=5)
            .map(|n| (n, gz(&archive_text(&[track(&format!("e{n}"), "signup")]))))
            .collect(),
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    // This database already has archives 1 and 2; 3 was deleted by retention before it was read.
    let empty = _temp.path().join("empty.jsonl.gz");
    std::fs::write(&empty, gz("")).unwrap();
    for n in 1..=2 {
        w.import(n, &format!("hash{n}"), 1, &empty)
            .expect("earlier import");
    }
    let result = run(&w, "t").expect("sync");
    assert_eq!(result["gaps"], 1);
    assert_eq!(result["imported"], 2);
    assert_eq!(result["checkpoint"], "5");
    assert_eq!(
        rows(
            &w,
            "SELECT kind, archive_seq, line, detail FROM _slurp.problems"
        ),
        json!([{"kind": "gap", "archive_seq": 3, "line": 0, "detail": "archives 3 to 3 were deleted by retention before they were read"}])
    );
    // Reading the same gap again records nothing new.
    w.record_gap(&slurp_client::api::Gap { from: 3, to: 3 })
        .expect("again");
    assert_eq!(
        rows(&w, "SELECT count(*) AS n FROM _slurp.problems"),
        json!([{"n": 1}])
    );
}

#[test]
fn a_fresh_database_starts_at_the_oldest_retained_archive_without_a_gap() {
    let (url, _state) = worker(State {
        archives: (4..=5)
            .map(|n| (n, gz(&archive_text(&[track(&format!("e{n}"), "signup")]))))
            .collect(),
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    let result = run(&w, "t").expect("sync");
    assert_eq!(
        (result["gaps"].as_u64(), result["imported"].as_u64()),
        (Some(0), Some(2))
    );
    assert_eq!(
        rows(&w, "SELECT count(*) AS n FROM _slurp.problems"),
        json!([{"n": 0}])
    );
}

#[test]
fn nothing_published_and_pending_events_are_reported() {
    let (url, _state) = worker(State {
        buffered: Some(gz("")),
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    let result = run(&w, "t").expect("sync");
    assert_eq!(result["downloaded"], 0);
    assert_eq!(result["has_published_archives"], false);
    assert_eq!(result["pending"], true);
}

#[test]
fn a_listed_archive_that_answers_404_stops_the_sync_and_names_its_sequence() {
    let (url, _state) = worker(State {
        archives: (1..=3)
            .map(|n| (n, gz(&archive_text(&[track(&format!("e{n}"), "signup")]))))
            .collect(),
        missing: Some(2),
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    let error = run(&w, "t").expect_err("a missing archive is fatal");
    assert!(error.to_string().contains("archive 2"), "{error}");
    assert_eq!(
        rows(&w, "SELECT max(sequence) AS n FROM _slurp.deliveries"),
        json!([{"n": 1}]),
        "archive 1 stays imported"
    );
}

#[test]
fn sync_now_publishes_first_and_a_key_that_cannot_publish_gets_a_clear_error() {
    let (url, state) = worker(State {
        archives: vec![(1, gz(&archive_text(&[track("e1", "signup")])))],
        buffered: Some(gz(&archive_text(&[track("e2", "signup")]))),
        ..Default::default()
    });
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    let tokio = tokio::runtime::Runtime::new().unwrap();
    let plain = run(&w, "admin").expect("plain sync");
    assert_eq!(plain["downloaded"], 1);
    assert_eq!(
        plain["pending"], true,
        "the buffered events are not readable yet"
    );
    assert!(
        !state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(line, _, _)| line.contains("Publish")),
        "a plain sync never publishes"
    );
    let now = tokio.block_on(w.sync_now("admin")).expect("sync --now");
    assert_eq!(
        now["downloaded"], 1,
        "the published archive is picked up at once"
    );
    assert_eq!(now["pending"], false);
    assert_eq!(now["published_now"], true);
    let publish = state
        .lock()
        .unwrap()
        .seen
        .iter()
        .find(|(line, _, _)| line.contains("Publish"))
        .cloned()
        .expect("Publish was called");
    assert_eq!(publish.1, "Bearer admin");
    assert_eq!(
        serde_json::from_str::<Value>(&publish.2).unwrap(),
        json!({"project": PROJECT})
    );

    state.lock().unwrap().publish_forbidden = true;
    let error = tokio
        .block_on(w.sync_now("secret-key"))
        .expect_err("a secret key cannot publish");
    assert!(
        error.to_string().contains("needs the admin token"),
        "{error}"
    );
}

#[test]
fn receipts_of_another_project_stop_the_sync() {
    let (url, _state) = worker(State::default());
    let Some((_temp, w)) = workspace(&url) else {
        return;
    };
    w.execute(
        "INSERT INTO _slurp.deliveries(project, sequence, sha256, bytes) VALUES('prj_ffffffffffffffff', 1, 'x', 1)",
        false,
    )
    .expect("a foreign receipt");
    let error = run(&w, "t").expect_err("a different project's archives");
    assert!(error.to_string().contains("different project"), "{error}");
}
