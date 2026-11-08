//! The MCP server, driven the way a client drives it: the real `slurp` binary over stdio, against a seeded DuckDB project.
//! Skipped unless SLURP_TEST_DUCKDB points at a DuckDB CLI (like the other native tests).
mod common;
use serde_json::{Value, json};
use slurp_app::Workspace;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

fn event(id: &str, name: &str, user: &str, _seq: usize) -> String {
    let at = "2026-11-02T10:00:00Z";
    let record = json!({"id": id, "type": "track", "event": name, "timestamp": at, "user_id": user, "data": {"plan": "pro"}});
    format!(r#"{{"received_at":"{at}","sender":"web","record":{record}}}"#) + "\n"
}

fn seeded() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = common::duckdb()?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(
        &(temp.path()).join("private-home"),
        temp.path(),
        "http://localhost:8080".into(),
        "prj_test".into(),
        None,
        exe.into(),
    )
    .expect("initialize workspace");
    let lines = event("e1", "signed_up", "u1", 1)
        + &event("e2", "signed_up", "u2", 2)
        + &event("e3", "exported", "u1", 3);
    let mut archive = tempfile::NamedTempFile::new().expect("archive file");
    archive
        .write_all(&{
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(lines.as_bytes()).expect("compress");
            encoder.finish().expect("compress")
        })
        .expect("write");
    w.import(1, "hash", 1, archive.path()).expect("import");
    Some((temp, w))
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Client {
    fn start(root: &std::path::Path, extra: &[&str]) -> Self {
        let (client, init) = Self::start_unchecked(root, extra, "2025-11-25");
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        client
    }
    /// Start the server and perform the handshake for `version`; returns the client and the raw initialize response.
    fn start_unchecked(root: &std::path::Path, extra: &[&str], version: &str) -> (Self, Value) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_slurp"))
            .arg("mcp")
            .arg("--project")
            .arg(root)
            .args(extra)
            .env("SLURP_HOME", root.join("private-home"))
            .env_remove("SLURP_TOKEN")
            .env("HOME", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start slurp mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut client = Self {
            child,
            stdin,
            stdout,
            next: 1,
        };
        let init = client.request("initialize", json!({"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}));
        assert_eq!(init["result"]["serverInfo"]["name"], "slurp");
        client.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        (client, init)
    }
    fn send(&mut self, message: &Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("a response");
        let response: Value = serde_json::from_str(&line)
            .unwrap_or_else(|_| panic!("stdout must carry only JSON, got {line:?}"));
        assert_eq!(response["id"], id);
        response
    }
    /// Call a tool; returns (is_error, parsed JSON of the text result).
    fn tool(&mut self, name: &str, arguments: Value) -> (bool, Value) {
        let response = self.request("tools/call", json!({"name": name, "arguments": arguments}));
        let result = &response["result"];
        let text = result["content"][0]["text"].as_str().expect("text content");
        (
            result["isError"].as_bool().unwrap(),
            serde_json::from_str(text).expect("JSON text"),
        )
    }
    fn names(&mut self) -> Vec<String> {
        let tools = self.request("tools/list", json!({}))["result"]["tools"].clone();
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn tools_and_the_send_switch() {
    let Some((temp, _w)) = seeded() else { return };
    let mut read_only = Client::start(temp.path(), &[]);
    let names = read_only.names();
    for expected in [
        "status",
        "describe_schema",
        "sql",
        "sync",
        "health",
        "report_check",
        "report_build",
    ] {
        assert!(
            names.contains(&expected.to_owned()),
            "missing {expected}: {names:?}"
        );
    }
    assert!(
        !names.iter().any(|n| n == "send_event" || n == "identify"),
        "writing is off by default: {names:?}"
    );
    let (is_error, body) = read_only.tool("send_event", json!({"event": "x"}));
    assert!(
        is_error,
        "a refused call is reported as a tool error the model can read"
    );
    assert!(
        body["error"].as_str().unwrap().contains("--allow-send"),
        "{body}"
    );
    drop(read_only);
    let mut writer = Client::start(temp.path(), &["--allow-send"]);
    let names = writer.names();
    assert!(
        names.contains(&"send_event".to_owned()) && names.contains(&"identify".to_owned()),
        "{names:?}"
    );
}

#[test]
fn reading_events_describing_the_schema_and_the_sandbox() {
    let Some((temp, _w)) = seeded() else { return };
    let mut client = Client::start(temp.path(), &[]);
    let (is_error, body) = client.tool(
        "sql",
        json!({"query": "SELECT event, count(*) AS n FROM events GROUP BY 1 ORDER BY n DESC;"}),
    );
    assert!(!is_error, "{body}");
    assert_eq!(body["rows"], json!([["signed_up", 2], ["exported", 1]]));
    let (is_error, schema) = client.tool("describe_schema", json!({}));
    assert!(!is_error, "{schema}");
    assert_eq!(schema["summary"][0]["events"], 3);
    let events: Vec<&str> = schema["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(events, ["signed_up", "exported"]);
    let views: Vec<&str> = schema["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert!(
        views.contains(&"events_with_person") && views.contains(&"errors"),
        "{views:?}"
    );
    let (is_error, status) = client.tool("status", json!({}));
    assert!(!is_error && status["events"][0]["count"] == 3, "{status}");
    let (is_error, _) = client.tool("health", json!({}));
    assert!(!is_error);
    // The sandbox: SQL cannot read local files.
    let secret = temp.path().join("secret.csv");
    std::fs::write(&secret, "token\nhunter2\n").unwrap();
    let (is_error, body) = client.tool(
        "sql",
        json!({"query": format!("SELECT * FROM read_csv('{}')", secret.display())}),
    );
    assert!(is_error, "reading a local file must be refused: {body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("disabled by configuration"),
        "{body}"
    );
    assert!(!body.to_string().contains("hunter2"));
    // One statement only, and bad SQL is a readable tool error, not a protocol failure.
    assert!(client.tool("sql", json!({"query": "SELECT 1; SELECT 2"})).0);
    assert!(client.tool("sql", json!({"query": "SELEC nope"})).0);
    assert!(
        client.tool("sql", json!({})).0,
        "a missing argument is a tool error"
    );
    assert!(client.tool("no_such_tool", json!({})).0);
}

#[test]
fn reports_are_checked_and_built_into_a_new_folder() {
    let Some((temp, _w)) = seeded() else { return };
    let mut client = Client::start(temp.path(), &[]);
    let file = temp.path().join("r.md");
    std::fs::write(&file, "# Signups\n\n```sql q\nSELECT count(*) AS n FROM events WHERE event = 'signed_up'\n```\n\n```table\nquery: q\n```\n").unwrap();
    let (is_error, checked) = client.tool("report_check", json!({"file": file}));
    assert!(!is_error && checked["ok"] == true, "{checked}");
    let out = temp.path().join("out");
    let (is_error, built) = client.tool(
        "report_build",
        json!({"file": file, "out": out, "png": false}),
    );
    assert!(!is_error, "{built}");
    assert!(out.join("report.html").exists());
    assert!(
        built["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "report.html")
    );
    let (is_error, _) = client.tool("report_build", json!({"file": file, "out": out}));
    assert!(
        is_error,
        "an existing output folder is refused, as on the command line"
    );
    let broken = temp.path().join("broken.md");
    std::fs::write(
        &broken,
        "```sql q\nSELECT nope FROM events\n```\n\n```table\nquery: q\n```\n",
    )
    .unwrap();
    assert!(
        client.tool("report_check", json!({"file": broken})).0,
        "SQL errors are found by the check"
    );
}

#[test]
fn protocol_errors_do_not_break_the_session() {
    let Some((temp, _w)) = seeded() else { return };
    let mut client = Client::start(temp.path(), &[]);
    assert_eq!(
        client.request("no/such/method", json!({}))["error"]["code"],
        -32601
    );
    assert_eq!(client.request("ping", json!({}))["result"], json!({}));
    client.stdin.write_all(b"this is not json\n").unwrap();
    let mut line = String::new();
    client.stdout.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["error"]["code"], -32700);
    assert!(
        !client.tool("sql", json!({"query": "SELECT 1 AS one"})).0,
        "the session still works afterwards"
    );
}

#[test]
fn a_protocol_version_the_server_does_not_speak_is_negotiated_down_not_echoed() {
    let Some((temp, _w)) = seeded() else { return };
    let (_client, init) = Client::start_unchecked(temp.path(), &[], "1999-01-01");
    let version = init["result"]["protocolVersion"]
        .as_str()
        .expect("a version");
    assert_ne!(version, "1999-01-01", "an unknown version is never claimed");
    assert!(
        ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&version),
        "the server answers with a version it implements, got {version}"
    );
}

#[test]
fn malformed_requests_get_protocol_errors_and_calls_before_the_handshake_are_refused() {
    let Some((temp, _w)) = seeded() else { return };
    let mut client = Client::start(temp.path(), &[]);
    // Not JSON-RPC 2.0, and a batch: both are invalid requests, answered with an error and the session survives.
    client.send(&json!({"jsonrpc": "1.0", "id": 90, "method": "ping"}));
    let mut line = String::new();
    client.stdout.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
        -32600
    );
    assert_eq!(client.request("ping", json!({}))["result"], json!({}));

    // A fresh server that has not been initialized does not run tools.
    let mut child = Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("mcp")
        .arg("--project")
        .arg(temp.path())
        .env("SLURP_HOME", temp.path().join("private-home"))
        .env("HOME", temp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start slurp mcp");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "status", "arguments": {}}})).unwrap();
    stdin.flush().unwrap();
    let mut answer = String::new();
    stdout.read_line(&mut answer).unwrap();
    let answer: Value = serde_json::from_str(&answer).expect("a JSON-RPC error");
    assert!(
        answer["error"].is_object() && answer.get("result").is_none(),
        "{answer}"
    );
    let _ = child.kill();
    let _ = child.wait();
}

/// The send tools run `slurp send --source mcp` (so events carry sender = mcp, with no marker inside the record), and the sync
/// tool passes `--now` only when asked.
#[test]
fn the_send_tools_use_the_mcp_source_and_sync_can_publish_first() {
    let Some((temp, w)) = seeded() else { return };
    let log = temp.path().join("calls.log");
    let exe = temp.path().join("fake-slurp");
    std::fs::write(
        &exe,
        format!(
            "#!/bin/sh\necho \"ARGS $*\" >> {log}\ncat >> {log}\necho '{{\"ok\":true}}'\n",
            log = log.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let server = slurp_app::mcp::Server::new(&w, temp.path().to_path_buf(), exe, true);
    let call = |id: u64, method: &str, params: Value| {
        server
            .handle_line(
                &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
                    .to_string(),
            )
            .expect("a response")
    };
    call(1, "initialize", json!({"protocolVersion": "2025-11-25"}));
    let tool = |id: u64, name: &str, arguments: Value| {
        let response = call(
            id,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        );
        assert_eq!(response["result"]["isError"], false, "{response}");
    };
    tool(2, "send_event", json!({"event": "x", "data": {"a": 1}}));
    tool(
        3,
        "identify",
        json!({"user_id": "u1", "traits": {"plan": "pro"}}),
    );
    tool(4, "sync", json!({}));
    tool(5, "sync", json!({"now": true}));
    let log = std::fs::read_to_string(&log).unwrap();
    let args: Vec<&str> = log.lines().filter(|l| l.starts_with("ARGS")).collect();
    assert_eq!(args.len(), 4);
    assert!(args[0].contains("send --stdin --source mcp"), "{args:?}");
    assert!(args[1].contains("send --stdin --source mcp"), "{args:?}");
    assert!(
        args[2].starts_with("ARGS sync --project") && !args[2].contains("--now"),
        "{args:?}"
    );
    assert!(args[3].starts_with("ARGS sync --now --project"), "{args:?}");
    assert!(
        !log.contains("\"source\""),
        "the record carries no source marker: {log}"
    );
}
