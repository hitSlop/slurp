use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use slurp_client::{
    auth::{CredentialStore, Session},
    rpc,
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

#[derive(Default)]
struct Store(Mutex<Option<rpc::AuthCredentials>>);
impl CredentialStore for Store {
    fn load(&self, _: &str) -> Result<Option<rpc::AuthCredentials>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, _: &str, value: &rpc::AuthCredentials) -> Result<()> {
        *self.0.lock().unwrap() = Some(value.clone());
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
fn credentials(generation: usize, expires: i64) -> rpc::AuthCredentials {
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"exp":expires})).unwrap());
    rpc::AuthCredentials {
        user: rpc::AuthUser {
            id: "user_fixture".into(),
            email: "test@example.test".into(),
            first_name: None,
            last_name: None,
        },
        access_token: format!("header.{payload}.generation{generation}"),
        refresh_token: format!("refresh{generation}"),
    }
}
struct Provider {
    url: String,
    stop: Arc<AtomicBool>,
    status: Arc<AtomicUsize>,
    refreshes: Arc<AtomicUsize>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Provider {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let status = Arc::new(AtomicUsize::new(200));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let (done, code, count) = (stop.clone(), status.clone(), refreshes.clone());
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                if done.load(Ordering::SeqCst) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':')
                        && key.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let status = code.load(Ordering::SeqCst);
                let response = if status == 401 {
                    serde_json::json!({"code":1000,"error":"Unauthenticated","msg":"login required","status":401})
                } else if status == 503 {
                    // The shared client must not expose raw response bodies in errors.
                    serde_json::json!({"error":"Unavailable","code":5000,"msg":"private_provider_detail","status":503})
                } else if first.contains("/Refresh ") {
                    let generation = count.fetch_add(1, Ordering::SeqCst) + 1;
                    assert_eq!(body["refreshToken"], format!("refresh{}", generation - 1));
                    serde_json::json!({"credentials":credentials(generation, chrono::Utc::now().timestamp()+3600)})
                } else if first.contains("/PollLogin ") {
                    serde_json::json!({"status":"complete","credentials":credentials(0, 1)})
                } else if first.contains("/Logout ") {
                    serde_json::json!({"ok":true})
                } else {
                    panic!("unexpected request {first}");
                };
                let body = response.to_string();
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            url,
            stop,
            status,
            refreshes,
            worker: Some(worker),
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_refresh_rotation_restart_and_terminal_failure() {
    let provider = Provider::new();
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::default());
    let http = slurp_client::http_client().unwrap();
    let new_session = || {
        Session::new(
            &provider.url,
            http.clone(),
            directory.path().into(),
            store.clone(),
        )
        .unwrap()
    };
    let one = new_session();
    one.poll_login("device_code").await.unwrap();
    // Separate instances take independent file descriptors, as CLI and daemon do.
    let two = new_session();
    let (first, second) = tokio::join!(one.access_token(), two.access_token());
    let first = first.unwrap();
    assert_eq!(first, second.unwrap());
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.load(&provider.url).unwrap().unwrap().refresh_token,
        "refresh1"
    );
    let (first, second) = tokio::join!(
        one.refresh_after_unauthenticated(&first),
        two.refresh_after_unauthenticated(&first)
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 2);
    drop(one);
    drop(two);
    let restarted = new_session();
    let saved = store.load(&provider.url).unwrap().unwrap();
    assert_eq!(restarted.access_token().await.unwrap(), saved.access_token);
    provider.status.store(503, Ordering::SeqCst);
    let error = restarted
        .refresh_after_unauthenticated(&saved.access_token)
        .await
        .unwrap_err()
        .to_string();
    assert!(!error.contains("private_provider_detail"));
    assert_eq!(store.load(&provider.url).unwrap(), Some(saved.clone()));
    provider.status.store(401, Ordering::SeqCst);
    assert!(
        restarted
            .refresh_after_unauthenticated(&saved.access_token)
            .await
            .unwrap_err()
            .to_string()
            .contains("login required")
    );
    assert!(store.load(&provider.url).unwrap().is_none());
    provider.status.store(200, Ordering::SeqCst);
    restarted.poll_login("device_code").await.unwrap();
    provider.status.store(503, Ordering::SeqCst);
    assert!(restarted.logout().await.is_err());
    assert!(store.load(&provider.url).unwrap().is_none());
    // A late refresh cannot restore a logged-out credential.
    assert!(new_session().access_token().await.is_err());
}

// This fixture isolates refresh races across processes without global settings. It lets
// separate child processes share one atomic credential value during this test.
struct FixtureStore(std::path::PathBuf);
impl CredentialStore for FixtureStore {
    fn load(&self, _: &str) -> Result<Option<rpc::AuthCredentials>> {
        Ok(Some(serde_json::from_slice(&std::fs::read(&self.0)?)?))
    }
    fn save(&self, _: &str, value: &rpc::AuthCredentials) -> Result<()> {
        let temporary = self.0.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(value)?)?;
        std::fs::rename(temporary, &self.0)?;
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<()> {
        std::fs::remove_file(&self.0)?;
        Ok(())
    }
}

#[test]
fn credential_refresh_child() {
    let Ok(backend) = std::env::var("SLURP_AUTH_FIXTURE_BACKEND") else {
        return;
    };
    let root = std::path::PathBuf::from(std::env::var_os("SLURP_AUTH_FIXTURE_ROOT").unwrap());
    let session = Session::new(
        &backend,
        slurp_client::http_client().unwrap(),
        root.join("locks"),
        Arc::new(FixtureStore(root.join("credentials.json"))),
    )
    .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(session.access_token()).unwrap();
}

#[test]
fn refresh_is_serialized_across_processes() {
    let provider = Provider::new();
    let directory = tempfile::tempdir().unwrap();
    let store = FixtureStore(directory.path().join("credentials.json"));
    store.save(&provider.url, &credentials(0, 1)).unwrap();
    let mut children = (0..2)
        .map(|_| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "credential_refresh_child"])
                .env("SLURP_AUTH_FIXTURE_BACKEND", &provider.url)
                .env("SLURP_AUTH_FIXTURE_ROOT", directory.path())
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect::<Vec<_>>();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.load(&provider.url).unwrap().unwrap().refresh_token,
        "refresh1"
    );
    // A fresh process reads the saved replacement without another exchange.
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "credential_refresh_child"])
        .env("SLURP_AUTH_FIXTURE_BACKEND", &provider.url)
        .env("SLURP_AUTH_FIXTURE_ROOT", directory.path())
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
}
