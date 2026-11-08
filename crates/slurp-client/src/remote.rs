//! Read-only access to a project's archives: `ListArchives` over the control API and the authenticated archive download.
use crate::api::{self, ArchiveInfo, CallError, ErrorCode, ListArchivesResponse};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    #[error("unauthenticated: a valid read key or admin token is required (slurp connect)")]
    Unauthenticated,
    #[error("permission_denied: project read access required")]
    PermissionDenied,
    #[error("not_found: {0}")]
    NotFound(String),
    /// A listed archive answered 404 on download: it is gone, so the listing and the bucket disagree. Fatal for a sync.
    #[error(
        "archive {0} is listed but the Worker answered 404 for it; it may have been deleted by retention meanwhile"
    )]
    ArchiveMissing(u64),
    #[error("transport: {0}")]
    Transport(String),
    #[error("protocol: {0}")]
    Protocol(String),
}
fn io_error(_: std::io::Error) -> RemoteError {
    RemoteError::Transport("staging or directory I/O failed".into())
}

#[async_trait::async_trait]
pub trait Remote: Send + Sync {
    /// One page of `ListArchives`: without `after` it starts at the oldest retained archive.
    async fn list(
        &self,
        after: Option<u64>,
        limit: u32,
    ) -> Result<ListArchivesResponse, RemoteError>;
    /// Download one archive into `dest`; returns the SHA-256 (lowercase hex) and the byte count of what arrived.
    async fn download(
        &self,
        archive: &ArchiveInfo,
        dest: &Path,
    ) -> Result<(String, u64), RemoteError>;
}

/// Download one listed archive and verify its size and SHA-256 against the listing. Both `slurp sync` and `slurp read`
/// download through this one function.
///
/// # Errors
/// Returns the transport error, [`RemoteError::ArchiveMissing`] when the archive is gone, or a protocol error when the bytes
/// do not match the listed identity (the partial file is left for the caller to discard).
pub async fn download_verified(
    remote: &dyn Remote,
    archive: &ArchiveInfo,
    dest: &Path,
) -> Result<(), RemoteError> {
    let (sha, size) = remote.download(archive, dest).await?;
    if sha == archive.sha256 && size == archive.size {
        Ok(())
    } else {
        Err(RemoteError::Protocol(format!(
            "archive {} failed size/SHA256 verification",
            archive.seq
        )))
    }
}

/// Shared gateway transport, independent of the lake adapter.
pub fn http_client() -> Result<reqwest::Client, RemoteError> {
    crate::http_client().map_err(|error| RemoteError::Transport(error.to_string()))
}

pub struct HttpRemote {
    client: reqwest::Client,
    base: String,
    token: String,
    project: String,
}
impl HttpRemote {
    pub fn new(backend: &str, project: &str, token: &str) -> Result<Self, RemoteError> {
        let mut endpoint = reqwest::Url::parse(backend)
            .map_err(|_| RemoteError::Protocol("invalid backend URL".into()))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err(RemoteError::Protocol(
                "backend must be an HTTP(S) URL without credentials".into(),
            ));
        }
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        Ok(Self {
            client: http_client()?,
            base: endpoint.as_str().trim_end_matches('/').to_owned(),
            token: token.into(),
            project: project.into(),
        })
    }
    async fn backoff(attempt: u32, retry_after: Option<Duration>) {
        tokio::time::sleep(
            retry_after.unwrap_or_else(|| Duration::from_millis(100 * (1 << attempt))),
        )
        .await;
    }
    /// What a failed HTTP status on the download route means. 429 and 5xx are worth retrying.
    fn download_status(status: reqwest::StatusCode, seq: u64) -> RemoteError {
        match status.as_u16() {
            401 => RemoteError::Unauthenticated,
            403 => RemoteError::PermissionDenied,
            404 => RemoteError::ArchiveMissing(seq),
            429 | 500..=599 => RemoteError::Transport(format!("HTTP {}", status.as_u16())),
            _ => RemoteError::Protocol(format!("unexpected HTTP {}", status.as_u16())),
        }
    }
}

/// Map a control API failure to the transports' error type. `Unavailable` and transport failures are retried by the caller.
fn map_call_error(error: CallError) -> RemoteError {
    match error {
        CallError::Api {
            code: Some(ErrorCode::Unauthenticated),
            ..
        } => RemoteError::Unauthenticated,
        CallError::Api {
            code: Some(ErrorCode::Forbidden),
            ..
        } => RemoteError::PermissionDenied,
        CallError::Api {
            code: Some(ErrorCode::NotFound),
            message,
            ..
        } => RemoteError::NotFound(message),
        CallError::Decode(_) => RemoteError::Protocol(error.to_string()),
        _ => RemoteError::Transport(error.to_string()),
    }
}

/// Whether the same request may work later: the Worker or the network was unavailable, not the request refused.
fn retryable(error: &CallError) -> bool {
    match error {
        CallError::Transport(_) => true,
        CallError::Api {
            code: Some(ErrorCode::Unavailable),
            ..
        } => true,
        // A gateway or Cloudflare answered with something that is not an API error.
        CallError::Api {
            code: None, status, ..
        } => matches!(status, 429 | 500..=599),
        _ => false,
    }
}

#[async_trait::async_trait]
impl Remote for HttpRemote {
    async fn list(
        &self,
        after: Option<u64>,
        limit: u32,
    ) -> Result<ListArchivesResponse, RemoteError> {
        let req = api::ListArchivesRequest {
            project: self.project.clone(),
            after,
            limit: Some(limit),
        };
        for attempt in 0..=3 {
            match api::call::<api::ListArchives>(&self.client, &self.base, &self.token, &req).await
            {
                Ok(page) => {
                    crate::protocol::validate_listing(&page)?;
                    return Ok(page);
                }
                Err(error) if retryable(&error) && attempt < 3 => {
                    Self::backoff(attempt, None).await;
                }
                Err(error) => return Err(map_call_error(error)),
            }
        }
        unreachable!()
    }

    async fn download(
        &self,
        archive: &ArchiveInfo,
        dest: &Path,
    ) -> Result<(String, u64), RemoteError> {
        let url = format!(
            "{}{}",
            self.base,
            api::archive_path(&self.project, archive.seq)
        );
        for attempt in 0..=3 {
            let response = self.client.get(&url).bearer_auth(&self.token).send().await;
            let mut delay = None;
            let result = match response {
                Ok(response) if response.status().is_success() => {
                    let mut file = tokio::fs::File::create(dest).await.map_err(io_error)?;
                    let mut stream = response.bytes_stream();
                    let mut hash = Sha256::new();
                    let mut bytes = 0u64;
                    let mut interrupted = false;
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(chunk) => {
                                bytes += chunk.len() as u64;
                                if bytes > archive.size {
                                    return Err(RemoteError::Protocol(format!(
                                        "archive {} is larger than its listing says",
                                        archive.seq
                                    )));
                                }
                                file.write_all(&chunk).await.map_err(io_error)?;
                                hash.update(&chunk);
                            }
                            Err(_) => {
                                interrupted = true;
                                break;
                            }
                        }
                    }
                    if !interrupted {
                        file.flush().await.map_err(io_error)?;
                        return Ok((hex::encode(hash.finalize()), bytes));
                    }
                    RemoteError::Transport("archive body interrupted".into())
                }
                Ok(response) => {
                    delay = crate::http::retry_after(response.headers());
                    Self::download_status(response.status(), archive.seq)
                }
                Err(_) => RemoteError::Transport("archive request failed".into()),
            };
            if !matches!(result, RemoteError::Transport(_)) || attempt == 3 {
                return Err(result);
            }
            Self::backoff(attempt, delay).await;
        }
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_read_the_same_everywhere() {
        let cases = [
            (
                RemoteError::Unauthenticated,
                "unauthenticated: a valid read key or admin token is required (slurp connect)",
            ),
            (
                RemoteError::PermissionDenied,
                "permission_denied: project read access required",
            ),
            (
                RemoteError::NotFound("no such project".into()),
                "not_found: no such project",
            ),
            (
                RemoteError::Transport("HTTP 503".into()),
                "transport: HTTP 503",
            ),
            (
                RemoteError::Protocol("bad page".into()),
                "protocol: bad page",
            ),
        ];
        for (error, text) in cases {
            assert_eq!(error.to_string(), text);
        }
        assert!(
            RemoteError::ArchiveMissing(7)
                .to_string()
                .starts_with("archive 7 is listed")
        );
    }

    #[test]
    fn only_unavailability_is_retried() {
        let api = |status, code| CallError::Api {
            status,
            code,
            message: String::new(),
        };
        assert!(retryable(&api(503, Some(ErrorCode::Unavailable))));
        assert!(retryable(&api(502, None)));
        assert!(retryable(&api(429, None)));
        assert!(!retryable(&api(400, Some(ErrorCode::InvalidArgument))));
        assert!(!retryable(&api(401, Some(ErrorCode::Unauthenticated))));
        assert!(!retryable(&api(404, None)));
    }
}
