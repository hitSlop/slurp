//! `slurp notify` against a fake Slack and Discord: the exact requests it makes, and how failures read.
use serde_json::{Value, json};
use slurp_app::notify::{Attachment, Config, discord, slack};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: String,
    body: Vec<u8>,
}

/// A tiny HTTP server that records every request and answers by path.
fn fake(seen: Arc<Mutex<Vec<Seen>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 8192];
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
            let head = String::from_utf8_lossy(&buffer[..head_end.saturating_sub(4)]).into_owned();
            let path = head
                .lines()
                .next()
                .unwrap_or_default()
                .split(' ')
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            let body = buffer[head_end..].to_vec();
            let text = String::from_utf8_lossy(&body).into_owned();
            let reply = if path.ends_with("/files.getUploadURLExternal") {
                format!(
                    r#"{{"ok":true,"upload_url":"http://127.0.0.1:{port}/upload/F123","file_id":"F123"}}"#
                )
            } else if path.ends_with("/chat.postMessage") && text.contains("\"nowhere\"") {
                r#"{"ok":false,"error":"channel_not_found"}"#.to_owned()
            } else if path.starts_with("/upload/")
                || path.starts_with("/hook")
                || path.starts_with("/discord")
            {
                "ok".to_owned()
            } else {
                r#"{"ok":true}"#.to_owned()
            };
            seen.lock().unwrap().push(Seen {
                path,
                headers: head,
                body,
            });
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    port
}

fn setup() -> (Arc<Mutex<Vec<Seen>>>, u16) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let port = fake(seen.clone());
    (seen, port)
}

fn bot(port: u16) -> Config {
    Config {
        slack_bot_token: Some("xoxb-test-token".into()),
        slack_api: Some(format!("http://127.0.0.1:{port}/api")),
        allow_any_host: true,
        ..Config::default()
    }
}

fn png() -> Attachment {
    Attachment {
        name: "report.png".into(),
        bytes: vec![0x89, b'P', b'N', b'G', 0, 1, 2, 255, 254],
    }
}

#[tokio::test]
async fn slack_bot_posts_text_with_the_token_and_reports_slack_errors() {
    let (seen, port) = setup();
    let result = slack(
        &bot(port),
        "Signups are up 12%",
        Some("C0123ABCD"),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({"ok": true, "target": "slack", "mode": "bot", "file": false})
    );
    let request = seen.lock().unwrap()[0].clone();
    assert!(request.path.ends_with("/api/chat.postMessage"));
    assert!(
        request
            .headers
            .to_ascii_lowercase()
            .contains("authorization: bearer xoxb-test-token")
    );
    let body: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body,
        json!({"channel": "C0123ABCD", "text": "Signups are up 12%"})
    );
    let error = slack(&bot(port), "x", Some("nowhere"), None, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("channel_not_found") && error.contains("invite the bot"),
        "{error}"
    );
    let error = slack(&bot(port), "x", None, None, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("--channel"), "{error}");
}

#[tokio::test]
async fn slack_bot_uploads_a_file_with_the_current_three_step_api() {
    let (seen, port) = setup();
    let file = png();
    let bytes = file.bytes.clone();
    let result = slack(
        &bot(port),
        "Weekly report",
        Some("C0123ABCD"),
        Some(file),
        Some("Weekly"),
    )
    .await
    .unwrap();
    assert_eq!(result["file"], true);
    let requests = seen.lock().unwrap().clone();
    let paths: Vec<&str> = requests.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/api/files.getUploadURLExternal",
            "/upload/F123",
            "/api/files.completeUploadExternal"
        ]
    );
    let started = String::from_utf8_lossy(&requests[0].body).into_owned();
    assert!(
        started.contains("filename=report.png")
            && started.contains(&format!("length={}", bytes.len())),
        "{started}"
    );
    assert!(
        requests[0]
            .headers
            .to_ascii_lowercase()
            .contains("content-type: application/x-www-form-urlencoded")
    );
    assert_eq!(
        requests[1].body, bytes,
        "the file bytes are uploaded unchanged"
    );
    assert!(
        requests[1]
            .headers
            .to_ascii_lowercase()
            .contains("content-type: image/png")
    );
    let completed: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert_eq!(
        completed,
        json!({"files": [{"id": "F123", "title": "Weekly"}], "channel_id": "C0123ABCD", "initial_comment": "Weekly report"})
    );
}

#[tokio::test]
async fn slack_webhook_posts_text_only_and_only_to_slack() {
    let (seen, port) = setup();
    let config = Config {
        slack_webhook_url: Some(format!("http://127.0.0.1:{port}/hook")),
        allow_any_host: true,
        ..Config::default()
    };
    assert_eq!(
        slack(&config, "hello", None, None, None).await.unwrap()["mode"],
        "webhook"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap()[0].body).unwrap(),
        json!({"text": "hello"})
    );
    let error = slack(&config, "hello", None, Some(png()), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("cannot upload files") && error.contains("SLACK_BOT_TOKEN"),
        "{error}"
    );
    // Without the test override, a webhook pointing anywhere but Slack is refused before anything is sent.
    let strict = Config {
        slack_webhook_url: Some("https://evil.example/hook".into()),
        ..Config::default()
    };
    let error = slack(&strict, "secret numbers", None, None, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("https://hooks.slack.com/"), "{error}");
    let neither = slack(&Config::default(), "x", None, None, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        neither.contains("SLACK_BOT_TOKEN") && neither.contains("SLACK_WEBHOOK_URL"),
        "{neither}"
    );
}

#[tokio::test]
async fn discord_sends_json_or_a_multipart_file_and_refuses_other_hosts() {
    let (seen, port) = setup();
    let config = Config {
        discord_webhook_url: Some(format!("http://127.0.0.1:{port}/discord")),
        allow_any_host: true,
        ..Config::default()
    };
    assert_eq!(
        discord(&config, "plain", None).await.unwrap(),
        json!({"ok": true, "target": "discord", "file": false})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap()[0].body).unwrap(),
        json!({"content": "plain"})
    );
    let file = png();
    let bytes = file.bytes.clone();
    assert_eq!(
        discord(&config, "with image", Some(file)).await.unwrap()["file"],
        true
    );
    let request = seen.lock().unwrap()[1].clone();
    let content_type = request
        .headers
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-type:"))
        .unwrap()
        .to_owned();
    assert!(
        content_type.contains("multipart/form-data; boundary=slurp-"),
        "{content_type}"
    );
    let text = String::from_utf8_lossy(&request.body).into_owned();
    assert!(
        text.contains("name=\"payload_json\"") && text.contains("{\"content\":\"with image\"}")
    );
    assert!(
        text.contains("name=\"files[0]\"; filename=\"report.png\"")
            && text.contains("Content-Type: image/png")
    );
    assert!(
        request
            .body
            .windows(bytes.len())
            .any(|w| w == bytes.as_slice()),
        "the file bytes are in the body"
    );
    let long = "x".repeat(2001);
    assert!(
        discord(&config, &long, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("2000")
    );
    let strict = Config {
        discord_webhook_url: Some("https://evil.example/api/webhooks/1".into()),
        ..Config::default()
    };
    assert!(
        discord(&strict, "x", None)
            .await
            .unwrap_err()
            .to_string()
            .contains("refusing")
    );
    assert!(
        discord(&Config::default(), "x", None)
            .await
            .unwrap_err()
            .to_string()
            .contains("DISCORD_WEBHOOK_URL")
    );
}

#[test]
fn attachments_are_read_with_a_size_limit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("r.png");
    std::fs::write(&path, b"abc").unwrap();
    let a = Attachment::read(&path).unwrap();
    assert_eq!(
        (a.name.as_str(), a.bytes.as_slice()),
        ("r.png", b"abc".as_slice())
    );
    assert!(Attachment::read(&temp.path().join("missing.png")).is_err());
}
