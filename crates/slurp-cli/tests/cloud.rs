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

/// What the fake Worker says and does; tests change it between commands.
struct State {
    /// The body of `/v1/health`.
    health: String,
    /// Answer `/v1/health` with a 503 that is not JSON, as an unreachable Worker would.
    down: bool,
    /// Answer `ListProjects` with a 500.
    list_projects_fails: bool,
}
type Shared = Arc<Mutex<State>>;

/// The build id of the Worker bundled in this CLI, which a deployed Worker reports once the deploy has landed.
fn bundle_build() -> String {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/worker/build.json"),
    )
    .expect("build.json");
    serde_json::from_str::<Value>(&text).expect("json")["build"]
        .as_str()
        .expect("build")
        .to_owned()
}
fn health_body(release: Option<&str>, api_version: Value, build: &str) -> String {
    let mut body = serde_json::json!({"ok": true, "apiVersion": api_version, "configured": true, "build": build});
    if let Some(release) = release {
        body["release"] = release.into();
    }
    body.to_string()
}
fn current_health() -> String {
    health_body(Some(env!("CARGO_PKG_VERSION")), 2.into(), &bundle_build())
}

struct Fake {
    dir: tempfile::TempDir,
    purges: Arc<Mutex<Vec<String>>>,
    state: Shared,
}
impl Fake {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    fn deploys(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.starts_with("deploy --config"))
            .count()
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
fn fake_worker(purges: Arc<Mutex<Vec<String>>>, state: Shared) -> u16 {
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
            let mut status = "200 OK";
            let body = if request_line.contains("/v1/health") {
                let state = state.lock().expect("lock");
                if state.down {
                    status = "503 Service Unavailable";
                    "down".to_owned()
                } else {
                    state.health.clone()
                }
            } else if request_line.contains("/v1/rpc/Whoami") {
                r#"{"scope":"admin"}"#.to_owned()
            } else if request_line.contains("/v1/admin/purge") {
                purges.lock().expect("lock").push(text.clone());
                r#"{"ok":true,"projects":0,"archives":0,"strays":0}"#.to_owned()
            } else if request_line.contains("/v1/rpc/ListProjects") {
                if state.lock().expect("lock").list_projects_fails {
                    status = "500 Internal Server Error";
                    r#"{"error":{"code":"internal","message":"storage is broken"}}"#.to_owned()
                } else {
                    r#"{"projects":[]}"#.to_owned()
                }
            } else {
                r#"{}"#.to_owned()
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
    let state = Arc::new(Mutex::new(State {
        health: current_health(),
        down: false,
        list_projects_fails: false,
    }));
    let port = fake_worker(purges.clone(), state.clone());
    fake_wrangler(dir.path(), port);
    Fake { dir, purges, state }
}

fn slurp(fake: &Fake, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .args(args)
        .env("SLURP_HOME", fake.path("home"))
        .env("SLURP_WRANGLER", fake.path("wrangler"))
        .env("SLURP_CLOUD_WAIT_SECS", "2")
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
        who.status.success() && text(&who).contains("\"scope\":\"admin\""),
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
    assert_eq!(status["up_to_date"], true);
    assert_eq!(status["release"], env!("CARGO_PKG_VERSION"));
    assert_eq!(status["api_version"], 2);
    // A Worker still on an older build is reported as not up to date.
    fake.state.lock().expect("lock").health =
        health_body(Some(env!("CARGO_PKG_VERSION")), 2.into(), "oldbuild");
    let status = slurp(&fake, &["cloud", "status", "--json"]);
    let status: Value =
        serde_json::from_str(String::from_utf8_lossy(&status.stdout).trim()).expect("json");
    assert_eq!(status["up_to_date"], false);
    let human = slurp(&fake, &["cloud", "status"]);
    let human = text(&human);
    assert!(
        human.contains("Release")
            && human.contains(env!("CARGO_PKG_VERSION"))
            && human.contains("API"),
        "{human}"
    );
}

/// A damaged receipt is an error that names the file, not a deployment that quietly does not exist.
#[test]
fn a_damaged_receipt_is_reported_with_its_path() {
    let fake = setup();
    let cloud = fake.path("home").join("cloud");
    std::fs::create_dir_all(&cloud).expect("receipts folder");
    std::fs::write(cloud.join("broken.json"), "{ not json").expect("damaged receipt");
    let out = slurp(&fake, &["cloud", "status"]);
    assert!(!out.status.success(), "{}", text(&out));
    let message = text(&out);
    assert!(
        message.contains("broken.json") && message.contains("not a valid deployment receipt"),
        "{message}"
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

fn deployed_fake() -> Fake {
    let fake = setup();
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(fake.deploys(), 1);
    fake
}
fn set_health(fake: &Fake, body: String) {
    fake.state.lock().expect("lock").health = body;
}
/// An upgrade that was refused before it deployed anything.
fn refused(fake: &Fake, args: &[&str]) -> String {
    let before = fake.deploys();
    let out = slurp(fake, args);
    assert!(!out.status.success(), "{}", text(&out));
    assert_eq!(
        fake.deploys(),
        before,
        "wrangler deploy must not run: {:?}",
        fake.calls()
    );
    text(&out)
}

#[test]
fn upgrade_refuses_a_slurp_0_1_worker_without_deploying() {
    let fake = deployed_fake();
    set_health(&fake, health_body(None, 2.into(), "oldbuild"));
    let message = refused(&fake, &["cloud", "upgrade", "--json"]);
    assert!(
        message.contains("has unsupported deployment metadata, which this version cannot upgrade")
            && message.contains("slurp cloud init --worker NEW")
            && message.contains("slurp cloud destroy"),
        "{message}"
    );
    // A non-numeric apiVersion is the same Worker.
    set_health(&fake, health_body(Some("0.1.2"), "two".into(), "oldbuild"));
    assert!(
        refused(&fake, &["cloud", "upgrade", "--json"]).contains("unsupported deployment metadata")
    );
}

#[test]
fn upgrade_refuses_a_downgrade_without_deploying() {
    let fake = deployed_fake();
    set_health(&fake, health_body(Some("99.0.0"), 2.into(), "newerbuild"));
    let message = refused(&fake, &["cloud", "upgrade", "--json"]);
    assert!(
        message.contains(&format!(
            "the deployed Worker (99.0.0) is newer than this CLI's ({}); upgrade the CLI",
            env!("CARGO_PKG_VERSION")
        )),
        "{message}"
    );
}

#[test]
fn upgrade_refuses_a_worker_it_cannot_reach_unless_forced() {
    let fake = deployed_fake();
    fake.state.lock().expect("lock").down = true;
    let message = refused(&fake, &["cloud", "upgrade", "--json"]);
    assert!(message.contains("can't tell what is deployed"), "{message}");
    assert!(message.contains("--force"), "{message}");
    // --force deploys anyway; the Worker comes back once the deploy lands.
    let state = fake.state.clone();
    let log = fake.path("calls.log");
    let waiter = thread::spawn(move || {
        for _ in 0..200 {
            let deploys = std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .filter(|c| c.starts_with("deploy --config"))
                .count();
            if deploys >= 2 {
                state.lock().expect("lock").down = false;
                return;
            }
            thread::sleep(std::time::Duration::from_millis(25));
        }
    });
    let out = slurp(&fake, &["cloud", "upgrade", "--force", "--json"]);
    waiter.join().expect("waiter");
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(fake.deploys(), 2);
}

#[test]
fn upgrade_deploys_waits_for_the_new_build_and_records_it() {
    let fake = deployed_fake();
    // The Worker is on an older build of this release; the receipt agrees.
    let receipt_path = fake.path("home/cloud/slurp.json");
    let mut receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).expect("receipt")).expect("json");
    receipt["build"] = "oldbuild".into();
    std::fs::write(&receipt_path, serde_json::to_vec(&receipt).expect("json")).expect("write");
    set_health(&fake, current_health());
    let out = slurp(&fake, &["cloud", "upgrade", "--json"]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(fake.deploys(), 1);
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).expect("receipt")).expect("json");
    assert_eq!(receipt["build"], bundle_build());
}

#[test]
fn a_deploy_whose_new_build_never_appears_fails_and_keeps_the_old_receipt() {
    let fake = deployed_fake();
    set_health(
        &fake,
        health_body(Some(env!("CARGO_PKG_VERSION")), 2.into(), "stalebuild"),
    );
    let out = slurp(&fake, &["cloud", "upgrade", "--json"]);
    assert!(!out.status.success(), "{}", text(&out));
    let message = text(&out);
    assert!(
        message.contains("did not become ready") && message.contains("stalebuild"),
        "{message}"
    );
    assert_eq!(fake.deploys(), 2, "it did deploy");
    let receipt: Value = serde_json::from_slice(
        &std::fs::read(fake.path("home/cloud/slurp.json")).expect("receipt"),
    )
    .expect("json");
    assert_eq!(
        receipt["build"],
        bundle_build(),
        "init recorded the bundled build and the failed upgrade did not change it"
    );
}

#[test]
fn a_deploy_whose_list_projects_fails_is_reported() {
    let fake = deployed_fake();
    let receipt_path = fake.path("home/cloud/slurp.json");
    let mut receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).expect("receipt")).expect("json");
    receipt["build"] = "oldbuild".into();
    std::fs::write(&receipt_path, serde_json::to_vec(&receipt).expect("json")).expect("write");
    fake.state.lock().expect("lock").list_projects_fails = true;
    let out = slurp(&fake, &["cloud", "upgrade", "--json"]);
    assert!(!out.status.success(), "{}", text(&out));
    let message = text(&out);
    assert!(
        message.contains("could not list its projects") && message.contains("storage is broken"),
        "{message}"
    );
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).expect("receipt")).expect("json");
    assert_eq!(receipt["build"], "oldbuild", "the receipt was not advanced");
}

#[test]
fn init_fails_when_the_new_worker_cannot_list_its_projects() {
    let fake = setup();
    fake.state.lock().expect("lock").list_projects_fails = true;
    let out = slurp(&fake, &["cloud", "init", "--yes", "--json"]);
    assert!(!out.status.success(), "{}", text(&out));
    assert!(
        text(&out).contains("admin token is saved"),
        "{}",
        text(&out)
    );
    assert!(fake.path("home/cloud/slurp.json").exists());
    assert!(fake.path("home/credentials.json").exists());
    assert!(!fake.path("home/config.toml").exists());
    let out = slurp(&fake, &["cloud", "upgrade", "--json"]);
    assert!(!out.status.success(), "storage must still be checked");
    fake.state.lock().expect("lock").list_projects_fails = false;
    let out = slurp(&fake, &["cloud", "upgrade", "--json"]);
    assert!(out.status.success(), "{}", text(&out));
}

#[test]
fn connect_checks_the_api_range() {
    let fake = deployed_fake();
    let url = std::fs::read_to_string(fake.path("url.txt")).expect("url");
    let connect = |fake: &Fake| {
        text(
            &Command::new(env!("CARGO_BIN_EXE_slurp"))
                .args(["connect", &url])
                .env("SLURP_HOME", fake.path("home2"))
                .env("SLURP_TOKEN", "t".repeat(64))
                .env_remove("SLURP_BACKEND")
                .stdin(std::process::Stdio::null())
                .output()
                .expect("run slurp"),
        )
    };
    set_health(&fake, health_body(Some("0.1.2"), 1.into(), "b"));
    let message = connect(&fake);
    assert!(
        message.contains("older Worker") && message.contains("slurp cloud upgrade"),
        "{message}"
    );
    set_health(&fake, health_body(Some("9.0.0"), 3.into(), "b"));
    let message = connect(&fake);
    assert!(
        message.contains("newer Worker") && message.contains("upgrade the CLI"),
        "{message}"
    );
}

#[test]
fn force_cannot_override_a_known_downgrade() {
    let fake = deployed_fake();
    set_health(&fake, health_body(Some("99.0.0"), 2.into(), "future"));
    assert!(refused(&fake, &["cloud", "upgrade", "--force", "--json"]).contains("newer"));
}
#[test]
fn future_receipt_is_refused_before_deploy() {
    let fake = deployed_fake();
    let path = fake.path("home/cloud/slurp.json");
    let mut receipt: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    receipt["version"] = 2.into();
    let bytes = serde_json::to_vec(&receipt).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert!(refused(&fake, &["cloud", "upgrade", "--json"]).contains("newer Slurp"));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn force_cannot_override_an_incompatible_api() {
    let fake = deployed_fake();
    set_health(
        &fake,
        health_body(Some(env!("CARGO_PKG_VERSION")), 99.into(), "other"),
    );
    assert!(
        refused(&fake, &["cloud", "upgrade", "--force", "--json"])
            .contains("incompatible Worker API")
    );
}

#[test]
fn invalid_domain_is_refused_before_cloudflare_is_changed() {
    let fake = setup();
    let before = fake.calls();
    let out = slurp(
        &fake,
        &[
            "cloud",
            "init",
            "--domain",
            "https://events.example.com/path",
            "--yes",
        ],
    );
    assert!(!out.status.success());
    assert_eq!(fake.calls(), before);
}
