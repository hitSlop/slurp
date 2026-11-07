//! `slurp notify`: post a message, and optionally a report image, to Slack or Discord.
//!
//! Credentials come from the environment, never from command-line arguments (which show up in process lists and shell history):
//!   Slack, bot token (can attach a file): `SLACK_BOT_TOKEN` (scopes `chat:write`, `files:write`) and a channel
//!   Slack, incoming webhook (text only):   `SLACK_WEBHOOK_URL`
//!   Discord webhook (text and a file):     `DISCORD_WEBHOOK_URL`
//! Slack's bot flow uses the current external upload API (`files.getUploadURLExternal`, then `files.completeUploadExternal`); the
//! old `files.upload` method was retired in November 2025.
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use slurp_client::reqwest;
use std::path::Path;

const SLACK_API: &str = "https://slack.com/api";
/// Largest file this will upload; reports are a few hundred KB to a few MB.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const DISCORD_CONTENT_LIMIT: usize = 2000;

/// Where to send, read from the environment by [`Config::from_env`].
#[derive(Clone, Debug, Default)]
pub struct Config {
    pub slack_bot_token: Option<String>,
    pub slack_webhook_url: Option<String>,
    pub discord_webhook_url: Option<String>,
    /// Slack Web API base, `https://slack.com/api` unless a test or gateway overrides it.
    pub slack_api: Option<String>,
    /// Accept webhook URLs on any host. Only tests set this; the command line never does.
    pub allow_any_host: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        Self {
            slack_bot_token: get("SLACK_BOT_TOKEN"),
            slack_webhook_url: get("SLACK_WEBHOOK_URL"),
            discord_webhook_url: get("DISCORD_WEBHOOK_URL"),
            slack_api: None,
            allow_any_host: false,
        }
    }
}

/// A file to attach.
pub struct Attachment {
    pub name: String,
    pub bytes: Vec<u8>,
}

impl Attachment {
    pub fn read(path: &Path) -> Result<Self> {
        let size = std::fs::metadata(path)
            .with_context(|| format!("cannot read {}", path.display()))?
            .len();
        if size > MAX_FILE_BYTES {
            bail!(
                "{} is {size} bytes; the limit is {MAX_FILE_BYTES}",
                path.display()
            );
        }
        Ok(Self {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("report")
                .to_owned(),
            bytes: std::fs::read(path)?,
        })
    }
    fn content_type(&self) -> &'static str {
        match self
            .name
            .rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("pdf") => "application/pdf",
            Some("html") => "text/html",
            Some("json") => "application/json",
            Some("md" | "txt") => "text/plain",
            _ => "application/octet-stream",
        }
    }
}

fn client() -> Result<reqwest::Client> {
    slurp_client::http_client()
}

fn require_host(url: &str, prefixes: &[&str], allow_any: bool, what: &str) -> Result<()> {
    if allow_any || prefixes.iter().any(|p| url.starts_with(p)) {
        return Ok(());
    }
    bail!(
        "{what} must start with {}; refusing to send to another host",
        prefixes.join(" or ")
    )
}

/// Post to Slack. With `SLACK_BOT_TOKEN`, use the channel (an id such as C0123ABCD is needed to attach a file) and attach `file`;
/// with only `SLACK_WEBHOOK_URL`, post text (a webhook cannot upload files).
pub async fn slack(
    config: &Config,
    text: &str,
    channel: Option<&str>,
    file: Option<Attachment>,
    title: Option<&str>,
) -> Result<Value> {
    let http = client()?;
    if let Some(token) = &config.slack_bot_token {
        let channel = channel.ok_or_else(|| {
            anyhow!(
                "--channel is required with SLACK_BOT_TOKEN (use the channel id for file uploads)"
            )
        })?;
        let api = config
            .slack_api
            .as_deref()
            .unwrap_or(SLACK_API)
            .trim_end_matches('/');
        let Some(file) = file else {
            slack_call(
                &http,
                token,
                &format!("{api}/chat.postMessage"),
                json!({"channel": channel, "text": text}),
            )
            .await?;
            return Ok(json!({"ok": true, "target": "slack", "mode": "bot", "file": false}));
        };
        let started = http
            .post(format!("{api}/files.getUploadURLExternal"))
            .bearer_auth(token)
            .form(&[
                ("filename", file.name.as_str()),
                ("length", &file.bytes.len().to_string()),
            ])
            .send()
            .await?;
        let started = slack_check(started.json::<Value>().await?)?;
        let upload_url = started["upload_url"]
            .as_str()
            .context("Slack gave no upload_url")?;
        let file_id = started["file_id"]
            .as_str()
            .context("Slack gave no file_id")?
            .to_owned();
        let uploaded = http
            .post(upload_url)
            .header("Content-Type", file.content_type())
            .body(file.bytes)
            .send()
            .await?;
        if !uploaded.status().is_success() {
            bail!(
                "Slack rejected the file upload (HTTP {})",
                uploaded.status()
            );
        }
        let completed = json!({"files": [{"id": file_id, "title": title.unwrap_or(&file.name)}], "channel_id": channel, "initial_comment": text});
        slack_call(
            &http,
            token,
            &format!("{api}/files.completeUploadExternal"),
            completed,
        )
        .await?;
        return Ok(json!({"ok": true, "target": "slack", "mode": "bot", "file": true}));
    }
    let Some(url) = &config.slack_webhook_url else {
        bail!("set SLACK_BOT_TOKEN (to attach a file) or SLACK_WEBHOOK_URL (text only)");
    };
    require_host(
        url,
        &["https://hooks.slack.com/"],
        config.allow_any_host,
        "SLACK_WEBHOOK_URL",
    )?;
    if file.is_some() {
        bail!(
            "a Slack incoming webhook cannot upload files; set SLACK_BOT_TOKEN and --channel, or post text only"
        );
    }
    let response = http.post(url).json(&json!({"text": text})).send().await?;
    if !response.status().is_success() {
        bail!(
            "Slack rejected the message (HTTP {}): {}",
            response.status(),
            response.text().await.unwrap_or_default()
        );
    }
    Ok(json!({"ok": true, "target": "slack", "mode": "webhook", "file": false}))
}

async fn slack_call(http: &reqwest::Client, token: &str, url: &str, body: Value) -> Result<Value> {
    let response = http.post(url).bearer_auth(token).json(&body).send().await?;
    slack_check(response.json::<Value>().await?)
}

/// Slack answers HTTP 200 with `{"ok": false, "error": "..."}`; surface that as an error.
fn slack_check(body: Value) -> Result<Value> {
    if body["ok"] == true {
        return Ok(body);
    }
    let error = body["error"].as_str().unwrap_or("unknown_error");
    let hint = match error {
        "not_in_channel" | "channel_not_found" => {
            " (invite the bot to the channel, and use the channel id)"
        }
        "missing_scope" => " (the bot needs chat:write and files:write)",
        "invalid_auth" | "not_authed" | "token_revoked" => " (check SLACK_BOT_TOKEN)",
        _ => "",
    };
    Err(anyhow!("Slack: {error}{hint}"))
}

/// Post to a Discord webhook, with an optional file.
pub async fn discord(config: &Config, text: &str, file: Option<Attachment>) -> Result<Value> {
    let Some(url) = &config.discord_webhook_url else {
        bail!("set DISCORD_WEBHOOK_URL");
    };
    require_host(
        url,
        &[
            "https://discord.com/api/webhooks/",
            "https://discordapp.com/api/webhooks/",
        ],
        config.allow_any_host,
        "DISCORD_WEBHOOK_URL",
    )?;
    if text.chars().count() > DISCORD_CONTENT_LIMIT {
        bail!(
            "Discord messages are limited to {DISCORD_CONTENT_LIMIT} characters; shorten the text and attach a report instead"
        );
    }
    let http = client()?;
    let request = http.post(url);
    let has_file = file.is_some();
    let response = match file {
        None => request.json(&json!({"content": text})).send().await?,
        Some(file) => {
            // reqwest writes the multipart framing and each part's headers; the name is cleaned first so it cannot break out of its header.
            let name = file.name.replace(['"', '\r', '\n'], "_");
            let mime = file.content_type();
            let form = reqwest::multipart::Form::new()
                .percent_encode_noop()
                .part(
                    "payload_json",
                    reqwest::multipart::Part::text(json!({"content": text}).to_string())
                        .mime_str("application/json")?,
                )
                .part(
                    "files[0]",
                    reqwest::multipart::Part::bytes(file.bytes)
                        .file_name(name)
                        .mime_str(mime)?,
                );
            request.multipart(form).send().await?
        }
    };
    if !response.status().is_success() {
        bail!(
            "Discord rejected the message (HTTP {}): {}",
            response.status(),
            response.text().await.unwrap_or_default()
        );
    }
    Ok(json!({"ok": true, "target": "discord", "file": has_file}))
}
