//! `slurp cloud` against a fake `wrangler` (a shell script that records its calls) and a fake Worker (a tiny HTTP server).
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
};

struct Fake {
    dir: tempfile::TempDir,
    purges: Arc<Mutex<Vec<String>>>,
}
impl Fake {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.path("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

/// A fake Worker: health, the admin-token check, and purge.
fn fake_worker(purges: Arc<Mutex<Vec<String>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    thread::spawn(move || {
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
                if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buffer[..pos]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (pos + 4, length);
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
            let request_line = text.lines().next().unwrap_or_default().to_owned();
            let body = if request_line.contains("/v1/health") {
                r#"{"ok":true,"apiVersion":"v0.5.0","configured":true,"build":"fakebuild"}"#
            } else if request_line.contains("/rpc/Auth/CurrentUser") {
                r#"{"user":{"id":"admin","email":"admin@self-hosted"}}"#
            } else if request_line.contains("/v1/admin/purge") {
                purges.lock().expect("lock").push(text.clone());
                r#"{"ok":true,"sources":0,"archives":0,"strays":0}"#
            } else if request_line.contains("/rpc/Source/ListSources") {
                r#"{"sources":[]}"#
            } else {
                r#"{}"#
            };
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    port
}

fn fake_wrangler(dir: &Path, port: u16) {
    std::fs::write(dir.join("url.txt"), format!("http://127.0.0.1:{port}")).expect("url");
    std::fs::write(dir.join("buckets.txt"), "name:           audio\n").expect("buckets");
    let script = r#"#!/bin/sh
D="$(dirname "$0")"
echo "$*" >> "$D/calls.log"
case "$1 $2" in
  "whoami --json")
    if [ -f "$D/loggedout" ]; then echo '{"loggedIn": false}'; else echo 'banner line'; echo '{"loggedIn": true, "accounts": [{"id": "a1", "name": "Acme", "type": "standard"}]}'; fi ;;
  "deployments list") [ -f "$D/worker-exists" ] && exit 0; echo "This Worker does not exist on your account. [code: 10007]"; exit 1 ;;
  "r2 bucket")
    case "$3" in
      list) cat "$D/buckets.txt" ;;
      create) if [ -f "$D/fail-bucket" ]; then echo "Please enable R2 through the Cloudflare Dashboard. [code: 10042]"; exit 1; fi; echo "Created bucket $4" ;;
      delete) echo "Deleted bucket $4" ;;
    esac ;;
  "deploy --config") echo "Uploaded slurp"; echo "  $(cat "$D/url.txt")"; echo "Current Version ID: v1" ;;
  "secret put") cat > "$D/secret.txt"; echo "Success! Uploaded secret ADMIN_TOKEN" ;;
  "delete --name") echo "Successfully deleted $3" ;;
  *) echo "unexpected wrangler call: $*" >&2; exit 2 ;;
esac
"#;
    let path = dir.join("wrangler");
    std::fs::write(&path, script).expect("script");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

fn setup() -> Fake {
    let dir = tempfile::tempdir().expect("dir");
    let purges = Arc::new(Mutex::new(Vec::new()));
    let port = fake_worker(purges.clone());
    fake_wrangler(dir.path(), port);
    Fake { dir, purges }
}

fn slurp(fake: &Fake, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .args(args)
        .env("SLURP_HOME", fake.path("home"))
        .env("SLURP_WRANGLER", fake.path("wrangler"))
        .env_remove("SLURP_TOKEN")
        .env_remove("SLURP_BACKEND")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run slurp")
}
fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn init_deploys_sets_a_secret_and_connects_without_leaking_the_token() {
    let fake = setup();
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(out.status.success(), "{}", text(&out));
    let result: Value = serde_json::from_str(
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .lines()
            .last()
            .expect("json"),
    )
    .expect("json");
    assert_eq!(result["connected"], true);
    let calls = fake.calls();
    let order: Vec<&str> = calls
        .iter()
        .map(|c| {
            c.split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
                .leak() as &str
        })
        .collect();
    assert_eq!(
        order,
        [
            "whoami --json",
            "deployments list",
            "r2 bucket",
            "r2 bucket",
            "deploy --config",
            "secret put",
        ],
        "{calls:?}"
    );
    assert!(calls[3].contains("create slurp-archive"), "{calls:?}");
    let token = std::fs::read_to_string(fake.path("secret.txt")).expect("secret");
    assert_eq!(token.len(), 64, "a 256-bit hex token was generated");
    let everything = format!(
        "{}{}{}",
        text(&out),
        calls.join("\n"),
        std::fs::read_to_string(fake.path("home/cloud/slurp.json")).expect("receipt")
    );
    assert!(
        !everything.contains(&token),
        "the admin token must never be printed, logged or stored in the receipt"
    );
    // the connection was saved: a later command needs no flags
    let who = slurp(&fake, &["whoami"]);
    assert!(
        who.status.success() && text(&who).contains("admin@self-hosted"),
        "{}",
        text(&who)
    );
    let receipt: Value = serde_json::from_slice(
        &std::fs::read(fake.path("home/cloud/slurp.json")).expect("receipt"),
    )
    .expect("json");
    assert_eq!(receipt["bucket"], "slurp-archive");
    assert_eq!(receipt["account_id"], "a1");
    assert_eq!(receipt["vars"]["SEAL_INTERVAL_MS"], "600000");
    assert_eq!(
        receipt["vars"]["SLURP_BUILD"].as_str().map(str::len),
        Some(12)
    );
}

#[test]
fn init_applies_settings_and_status_reads_the_receipt() {
    let fake = setup();
    let out = slurp(
        &fake,
        &[
            "cloud",
            "init",
            "--yes",
            "--json",
            "--worker",
            "mine",
            "--bucket",
            "my-bucket",
            "--seal-interval",
            "60",
            "--retention-days",
            "30",
        ],
    );
    assert!(out.status.success(), "{}", text(&out));
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(fake.path("home/cloud/mine.json")).expect("receipt"))
            .expect("json");
    assert_eq!(receipt["vars"]["SEAL_INTERVAL_MS"], "60000");
    assert_eq!(receipt["vars"]["RETENTION_DAYS"], "30");
    assert!(fake.calls().iter().any(|c| c.contains("create my-bucket")));
    let status = slurp(&fake, &["cloud", "status", "--json"]);
    assert!(status.status.success(), "{}", text(&status));
    let status: Value =
        serde_json::from_str(String::from_utf8_lossy(&status.stdout).trim()).expect("json");
    assert_eq!(status["worker"], "mine");
    assert_eq!(status["reachable"], true);
    assert_eq!(status["configured"], true);
    assert_eq!(
        status["up_to_date"], false,
        "the fake Worker reports a different build"
    );
}

#[test]
fn an_r2_failure_names_the_dashboard_and_deploys_nothing() {
    let fake = setup();
    std::fs::write(fake.path("fail-bucket"), "").expect("flag");
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(!out.status.success());
    let message = text(&out);
    assert!(
        message.contains("https://dash.cloudflare.com/a1/r2/overview"),
        "{message}"
    );
    assert!(
        message.contains("10042"),
        "wrangler's own message is kept: {message}"
    );
    assert!(
        !fake
            .calls()
            .iter()
            .any(|c| c.starts_with("deploy --config")),
        "nothing is deployed after the bucket fails"
    );
    assert!(!fake.path("home/cloud/slurp.json").exists());
}

#[test]
fn a_logged_out_wrangler_and_an_existing_worker_stop_before_changing_anything() {
    let fake = setup();
    std::fs::write(fake.path("loggedout"), "").expect("flag");
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("wrangler login"), "{}", text(&out));
    std::fs::remove_file(fake.path("loggedout")).expect("flag");
    std::fs::write(fake.path("worker-exists"), "").expect("flag");
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("already exists"), "{}", text(&out));
    assert!(!fake.calls().iter().any(|c| c.contains("create")
        || c.starts_with("deploy --config")
        || c.starts_with("secret")));
}

#[test]
fn destroy_purges_then_deletes_the_worker_and_bucket_and_forgets_the_connection() {
    let fake = setup();
    assert!(
        slurp(&fake, &["cloud", "init", "--yes", "--json"])
            .status
            .success()
    );
    let refused = slurp(&fake, &["cloud", "destroy", "--json"]);
    assert!(
        !refused.status.success(),
        "destroy needs --yes when there is no terminal"
    );
    assert!(fake.purges.lock().expect("lock").is_empty());
    let out = slurp(&fake, &["cloud", "destroy", "--yes", "--json"]);
    assert!(out.status.success(), "{}", text(&out));
    let purges = fake.purges.lock().expect("lock");
    assert_eq!(purges.len(), 1);
    assert!(purges[0].contains(r#""confirm":"delete-all-data""#));
    assert!(
        purges[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer ")
    );
    let calls = fake.calls();
    let delete_worker = calls
        .iter()
        .position(|c| c.starts_with("delete --name slurp --force"))
        .expect("worker deleted");
    let delete_bucket = calls
        .iter()
        .position(|c| c.starts_with("r2 bucket delete slurp-archive"))
        .expect("bucket deleted");
    assert!(
        delete_worker < delete_bucket,
        "the Worker goes before its bucket: {calls:?}"
    );
    assert!(
        !fake.path("home/cloud/slurp.json").exists(),
        "receipt removed"
    );
    let who = slurp(&fake, &["whoami"]);
    assert!(!who.status.success(), "the saved connection was forgotten");
}
