//! The Worker commands (`send`, `identify`, `project key`, `project webhook`) against a fake Worker: which control API methods
//! they call, with what, and what they print.
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output},
    sync::{Arc, Mutex},
};

const PROJECT: &str = "prj_0123456789abcdef";

/// (request line, authorization header, body) of every request.
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

fn key(source: &str) -> String {
    format!("slurp_pk_0123456789abcdef_{source}_{}", "a".repeat(48))
}

fn respond(line: &str, body: &str) -> (u16, Value) {
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let project = json!({"id": PROJECT, "name": "app", "createdAt": "2026-11-07T12:00:00.000Z"});
    let api_key = |scope: &str, source: Option<&str>, name: Option<&str>| {
        let mut api = json!({"keyId": "k1", "project": PROJECT, "scope": scope, "createdAt": "2026-11-07T12:00:00.000Z"});
        if let Some(source) = source {
            api["source"] = json!(source);
            api["key"] = json!(key(source));
        }
        if let Some(name) = name {
            api["name"] = json!(name);
        }
        api
    };
    if line.contains("/v1/rpc/GetProject") {
        return (
            200,
            json!({"project": project, "ingestUrl": "http://x/v1/events"}),
        );
    }
    if line.contains("/v1/rpc/SourceKey") {
        let source = request["source"].as_str().unwrap_or("default").to_owned();
        return (
            200,
            json!({"key": api_key("publishable", Some(&source), None)}),
        );
    }
    if line.contains("/v1/rpc/CreateKey") {
        let publishable = request["scope"] == "publishable";
        return (
            200,
            json!({"key": api_key(
                request["scope"].as_str().unwrap(),
                request["source"].as_str().filter(|_| publishable),
                request["name"].as_str(),
            )}),
        );
    }
    if line.contains("/v1/rpc/ConnectWebhook") {
        return (
            200,
            json!({"provider": request["provider"], "url": "https://w/hooks/github?key=k", "secret": request["secret"].as_str().unwrap_or("generated"), "sender": request["provider"], "steps": ["Open the provider's settings.", "Paste the URL and the secret."]}),
        );
    }
    if line.starts_with("POST /v1/events") {
        return (200, json!({"ok": true, "accepted": 1}));
    }
    (
        404,
        json!({"error": {"code": "not_found", "message": "no such route"}}),
    )
}

fn worker() -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen: Seen = Arc::default();
    let record = seen.clone();
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
                .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                .map(|l| l[14..].trim().to_owned())
                .unwrap_or_default();
            let body = text.get(head_end..).unwrap_or_default().to_owned();
            let (status, answer) = respond(&line, &body);
            record.lock().unwrap().push((line, auth, body));
            let answer = answer.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    (url, seen)
}

fn slurp(url: &str, args: &[&str], envs: &[(&str, &str)]) -> Output {
    let dir = tempfile::tempdir().expect("dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_slurp"));
    command
        .current_dir(dir.path())
        .env("SLURP_HOME", dir.path().join("home"))
        .env("SLURP_TOKEN", "admin-token")
        .env_remove("SLURP_READ_KEY")
        .env_remove("SLURP_PUBLISHABLE_KEY")
        .env_remove("SLURP_PROJECT_ID")
        .env_remove("SLURP_BACKEND")
        .env_remove("SLURP_INGEST_URL")
        .args(["--backend", url, "--json"])
        .args(args);
    for (name, value) in envs {
        command.env(name, value);
    }
    command.output().expect("run slurp")
}

fn out(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn bodies(seen: &Seen, route: &str) -> Vec<Value> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|(line, _, _)| line.contains(route))
        .map(|(_, _, body)| serde_json::from_str(body).unwrap_or(Value::Null))
        .collect()
}

#[test]
fn send_uses_the_cli_source_key_and_sends_a_plain_record() {
    let (url, seen) = worker();
    let output = slurp(&url, &["send", "signup", "--to", PROJECT], &[]);
    assert!(output.status.success(), "{}", out(&output));
    assert_eq!(
        bodies(&seen, "SourceKey"),
        [json!({"project": PROJECT, "source": "cli"})]
    );
    let seen = seen.lock().unwrap();
    let (_, auth, body) = seen
        .iter()
        .find(|(l, _, _)| l.starts_with("POST /v1/events"))
        .expect("an event was sent");
    assert_eq!(auth, &format!("Bearer {}", key("cli")));
    let record: Value = serde_json::from_str(body.trim()).unwrap();
    assert_eq!(record["event"], "signup");
    assert_eq!(record["type"], "track");
    assert!(record.get("context").is_none(), "{record}");
    assert!(String::from_utf8_lossy(&output.stdout).contains(r#""events":1"#));
}

#[test]
fn source_picks_the_key_and_an_explicit_key_in_the_environment_is_used_only_without_it() {
    let (url, seen) = worker();
    let env = [(
        "SLURP_PUBLISHABLE_KEY",
        "slurp_pk_0123456789abcdef_ios_ffff",
    )];
    // An explicit publishable key stands for itself: nothing is asked of the Worker.
    let output = slurp(&url, &["identify", "u1", "--to", PROJECT], &env);
    assert!(output.status.success(), "{}", out(&output));
    assert!(bodies(&seen, "SourceKey").is_empty());
    // --source names the source whose key is wanted, so the environment key is not used.
    let output = slurp(
        &url,
        &["send", "x", "--to", PROJECT, "--source", "mcp"],
        &env,
    );
    assert!(output.status.success(), "{}", out(&output));
    assert_eq!(
        bodies(&seen, "SourceKey"),
        [json!({"project": PROJECT, "source": "mcp"})]
    );
    let seen = seen.lock().unwrap();
    let auths: Vec<&str> = seen
        .iter()
        .filter(|(l, _, _)| l.starts_with("POST /v1/events"))
        .map(|(_, auth, _)| auth.as_str())
        .collect();
    assert_eq!(
        auths,
        [
            "Bearer slurp_pk_0123456789abcdef_ios_ffff".to_owned(),
            format!("Bearer {}", key("mcp"))
        ]
    );
}

#[test]
fn an_invalid_source_is_refused_before_anything_is_sent() {
    let (url, seen) = worker();
    let output = slurp(
        &url,
        &["send", "x", "--to", PROJECT, "--source", "Web Site"],
        &[],
    );
    assert!(!output.status.success());
    assert!(
        out(&output).contains("a source is a lowercase name"),
        "{}",
        out(&output)
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn keys_are_created_by_source_or_by_name() {
    let (url, seen) = worker();
    let output = slurp(
        &url,
        &[
            "project",
            "key",
            "create",
            PROJECT,
            "--scope",
            "publishable",
            "--source",
            "web",
        ],
        &[],
    );
    assert!(output.status.success(), "{}", out(&output));
    let output = slurp(
        &url,
        &[
            "project", "key", "create", PROJECT, "--scope", "secret", "--name", "ci",
        ],
        &[],
    );
    assert!(output.status.success(), "{}", out(&output));
    assert_eq!(
        bodies(&seen, "CreateKey"),
        [
            json!({"project": PROJECT, "scope": "publishable", "source": "web"}),
            json!({"project": PROJECT, "scope": "secret", "name": "ci"}),
        ]
    );
    for refused in [
        vec![
            "project",
            "key",
            "create",
            PROJECT,
            "--scope",
            "publishable",
        ],
        vec![
            "project",
            "key",
            "create",
            PROJECT,
            "--scope",
            "publishable",
            "--name",
            "web",
        ],
        vec![
            "project", "key", "create", PROJECT, "--scope", "secret", "--source", "web",
        ],
    ] {
        assert!(!slurp(&url, &refused, &[]).status.success(), "{refused:?}");
    }
}

#[test]
fn a_webhook_prints_the_workers_steps_and_the_removed_options_are_gone() {
    let (url, seen) = worker();
    let output = slurp(
        &url,
        &[
            "project",
            "webhook",
            PROJECT,
            "stripe",
            "--secret",
            "whsec_abc",
        ],
        &[],
    );
    assert!(output.status.success(), "{}", out(&output));
    assert_eq!(
        bodies(&seen, "ConnectWebhook"),
        [json!({"project": PROJECT, "provider": "stripe", "secret": "whsec_abc"})]
    );
    let printed: Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(
        printed["steps"],
        json!([
            "Open the provider's settings.",
            "Paste the URL and the secret."
        ])
    );
    assert_eq!(printed["sender"], "stripe");
    assert_eq!(printed["secret"], "whsec_abc");
    for removed in [
        vec!["project", "webhook", PROJECT, "github", "--rotate"],
        vec!["project", "update", PROJECT, "--title", "x"],
        vec!["project", "create", "app", "--no-geo"],
        vec!["project", "key", "list", PROJECT, "--geo"],
    ] {
        assert!(!slurp(&url, &removed, &[]).status.success(), "{removed:?}");
    }
}
