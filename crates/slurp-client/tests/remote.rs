//! `HttpRemote` against a tiny HTTP server: the listing call, the authenticated archive download and its failures.
use sha2::{Digest, Sha256};
use slurp_client::{HttpRemote, Remote, RemoteError, api, download_verified};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};

type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// Serves `respond(request_line)` -> (status, body) for every request, and records (request line, authorization header).
fn serve(respond: impl Fn(&str) -> (u16, Vec<u8>) + Send + 'static) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen: Seen = Arc::default();
    let record = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buffer = vec![0; 16 * 1024];
            let size = stream.read(&mut buffer).unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..size]).into_owned();
            let line = head.lines().next().unwrap_or_default().to_owned();
            let auth = head
                .lines()
                .find_map(|l| {
                    l.strip_prefix("authorization: ")
                        .or_else(|| l.strip_prefix("Authorization: "))
                })
                .unwrap_or_default()
                .to_owned();
            record.lock().unwrap().push((line.clone(), auth));
            let (status, body) = respond(&line);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(&body);
        }
    });
    (url, seen)
}

fn info(seq: u64, body: &[u8]) -> api::ArchiveInfo {
    api::ArchiveInfo {
        seq,
        size: body.len() as u64,
        sha256: hex::encode(Sha256::digest(body)),
        events: 1,
        created_at: "2026-11-07T12:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn an_archive_is_fetched_with_the_bearer_token_and_verified() {
    let body = b"gzip bytes".to_vec();
    let served = body.clone();
    let (url, seen) = serve(move |_| (200, served.clone()));
    let remote = HttpRemote::new(&url, "prj_0123456789abcdef", "secret-token").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.gz");
    download_verified(&remote, &info(7, &body), &dest)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0].0,
        "GET /v1/projects/prj_0123456789abcdef/archives/7 HTTP/1.1"
    );
    assert_eq!(seen[0].1, "Bearer secret-token");

    // The same bytes under a different digest, or a different size, are refused.
    drop(seen);
    let mut wrong = info(7, &body);
    wrong.sha256 = "0".repeat(64);
    let error = download_verified(&remote, &wrong, &dest).await.unwrap_err();
    assert!(
        error.to_string().contains("archive 7 failed size/SHA256"),
        "{error}"
    );
    let mut short = info(7, &body);
    short.size = 3;
    assert!(download_verified(&remote, &short, &dest).await.is_err());
}

#[tokio::test]
async fn a_404_on_a_listed_archive_names_its_sequence_and_401_403_are_not_retried() {
    for (status, expected) in [
        (404, RemoteError::ArchiveMissing(9)),
        (401, RemoteError::Unauthenticated),
        (403, RemoteError::PermissionDenied),
    ] {
        let (url, seen) = serve(move |_| (status, b"{}".to_vec()));
        let remote = HttpRemote::new(&url, "prj_0123456789abcdef", "t").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let error = remote
            .download(&info(9, b"x"), &dir.path().join("a.gz"))
            .await
            .unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(seen.lock().unwrap().len(), 1, "status {status} is final");
    }
}

#[tokio::test]
async fn a_busy_worker_is_retried_and_listing_goes_through_the_control_api() {
    let calls = Arc::new(Mutex::new(0));
    let counted = calls.clone();
    let (url, seen) = serve(move |_| {
        let mut calls = counted.lock().unwrap();
        *calls += 1;
        if *calls == 1 {
            return (
                503,
                br#"{"error":{"code":"unavailable","message":"storage unavailable"}}"#.to_vec(),
            );
        }
        let body = b"one";
        let page = serde_json::json!({
            "coverage": {"first": 1, "last": 1, "pending": false},
            "archives": [info(1, body)],
        });
        (200, page.to_string().into_bytes())
    });
    let remote = HttpRemote::new(&url, "prj_0123456789abcdef", "t").unwrap();
    let page = remote.list(None, 10).await.unwrap();
    assert_eq!(page.archives.len(), 1);
    assert_eq!(page.coverage.last, Some(1));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "the 503 was retried once");
    assert!(
        seen.iter()
            .all(|(line, _)| line == "POST /v1/rpc/ListArchives HTTP/1.1")
    );
}
