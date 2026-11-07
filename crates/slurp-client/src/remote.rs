//! Read-only transports. Authentication is attached only to gateway list requests.
use crate::{Coverage, ListPage, ListedObject, rpc};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    LoginRequired,
    PermissionDenied,
    RetentionGap,
    Expired,
    Transport(String),
    Protocol(String),
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LoginRequired => {
                f.write_str("login_required: session token or read key required")
            }
            Self::PermissionDenied => f.write_str("permission_denied: source read access required"),
            Self::RetentionGap => {
                f.write_str("retention_gap: checkpoint is below the retained floor")
            }
            Self::Expired => f.write_str("expired: object URL expired or object deleted"),
            Self::Transport(s) => write!(f, "transport: {s}"),
            Self::Protocol(s) => write!(f, "protocol: {s}"),
        }
    }
}
impl std::error::Error for RemoteError {}
fn io_error(_: std::io::Error) -> RemoteError {
    RemoteError::Transport("staging or directory I/O failed".into())
}

pub use crate::sync_types::RemoteCounts;
#[derive(Default)]
struct Counts {
    api_calls: AtomicU64,
    object_gets: AtomicU64,
    bytes: AtomicU64,
    retries: AtomicU64,
}
impl Counts {
    fn snapshot(&self) -> RemoteCounts {
        RemoteCounts {
            api_calls: self.api_calls.load(Ordering::Relaxed),
            object_gets: self.object_gets.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
        }
    }
}

#[async_trait::async_trait]
pub trait Remote: Send + Sync {
    async fn list(&self, after: Option<i64>, limit: usize) -> Result<ListPage, RemoteError>;
    async fn get_coverage(&self) -> Result<Option<rpc::Coverage>, RemoteError>;
    async fn download(&self, obj: &ListedObject, dest: &Path)
    -> Result<(String, u64), RemoteError>;
    fn counts(&self) -> RemoteCounts {
        RemoteCounts::default()
    }
}

/// How many times one object is re-listed for a fresh link before giving up.
const LINK_REFRESHES: u32 = 3;

/// Download one listed object, verify its size and SHA-256 against the listing, and survive expired links.
///
/// Signed download links last a limited time, and a long catch-up (many or large archives, a slow connection) can outlive
/// them. When a download answers [`RemoteError::Expired`], the object is listed again for a fresh link and retried, up to
/// three times. Both the portable folder sync and the DuckDB sync download through this one function.
///
/// # Errors
/// Returns the transport error, [`RemoteError::Expired`] when the object is gone or links keep expiring,
/// [`RemoteError::RetentionGap`] when the archive was removed meanwhile, or a protocol error when the bytes do not match
/// the listed identity (the partial file is left for the caller to discard).
pub async fn download_verified(
    remote: &dyn Remote,
    obj: &ListedObject,
    dest: &Path,
) -> Result<(), RemoteError> {
    let mut current = obj.clone();
    for refresh in 0..=LINK_REFRESHES {
        match remote.download(&current, dest).await {
            Ok((sha, size)) if sha == obj.sha256 && size == obj.size => return Ok(()),
            Ok(_) => {
                return Err(RemoteError::Protocol(
                    "download failed size/SHA256 verification".into(),
                ));
            }
            Err(RemoteError::Expired) if refresh < LINK_REFRESHES => {
                let seq = crate::protocol::parse_sequence(&obj.seq)?;
                let page = remote.list(Some(seq - 1), 1).await?;
                current = page
                    .objects
                    .into_iter()
                    .find(|fresh| fresh.seq == obj.seq && fresh.sha256 == obj.sha256)
                    .ok_or(RemoteError::Expired)?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(RemoteError::Expired)
}

/// Shared gateway transport, independent of the lake adapter.
pub fn http_client() -> Result<reqwest::Client, RemoteError> {
    crate::http_client().map_err(|error| RemoteError::Transport(error.to_string()))
}

pub struct HttpRemote {
    client: reqwest::Client,
    archive: rpc::ArchiveClient,
    project: String,
    counts: Counts,
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
        let client = http_client()?;
        Ok(Self {
            archive: rpc::ArchiveClient::new(endpoint.as_str(), client.clone(), Some(token.into())),
            client,
            project: project.into(),
            counts: Counts::default(),
        })
    }
    /// Read archive coverage and optional scheduling hints in one authenticated request.
    ///
    /// # Errors
    /// Returns an error for authorization, transport, or invalid archive coverage.
    pub async fn get_status(&self) -> Result<rpc::GetCoverageResponse, RemoteError> {
        let req = rpc::GetCoverageRequest {
            source: self.project.clone(),
        };
        let mut response = self.rpc_retry(|| self.archive.get_coverage(&req)).await?;
        if let Some(c) = &response.coverage {
            Coverage::try_from(c)?;
        }
        response.publication = crate::publication::validated(response.publication);
        Ok(response)
    }
    async fn backoff(&self, attempt: u32, retry_after: Option<Duration>) {
        self.counts.retries.fetch_add(1, Ordering::Relaxed);
        tokio::time::sleep(
            retry_after.unwrap_or_else(|| Duration::from_millis(100 * (1 << attempt))),
        )
        .await;
    }
    async fn rpc_retry<T, F, Fut>(&self, request: F) -> Result<T, RemoteError>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, rpc::Error>>,
    {
        for attempt in 0..=3 {
            self.counts.api_calls.fetch_add(1, Ordering::Relaxed);
            match request().await {
                Ok(value) => return Ok(value),
                Err(e) => {
                    let retry =
                        matches!(e, rpc::Error::Unavailable { .. } | rpc::Error::Transport(_));
                    if !retry || attempt == 3 {
                        return Err(map_rpc_error(e));
                    }
                    self.backoff(attempt, None).await;
                }
            }
        }
        unreachable!()
    }
    fn status(status: reqwest::StatusCode, object: bool) -> RemoteError {
        match status.as_u16() {
            401 if !object => RemoteError::LoginRequired,
            403 if !object => RemoteError::PermissionDenied,
            403 | 404 if object => RemoteError::Expired,
            429 | 500..=599 => RemoteError::Transport(format!("HTTP {}", status.as_u16())),
            _ => RemoteError::Protocol(format!("unexpected HTTP {}", status.as_u16())),
        }
    }
}
fn map_rpc_error(error: rpc::Error) -> RemoteError {
    match error {
        rpc::Error::Unauthenticated { .. } => RemoteError::LoginRequired,
        rpc::Error::Forbidden { .. } => RemoteError::PermissionDenied,
        rpc::Error::RetentionGap { .. } => RemoteError::RetentionGap,
        rpc::Error::Decode { .. } => RemoteError::Protocol(error.to_string()),
        _ => RemoteError::Transport(error.to_string()),
    }
}
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

#[async_trait::async_trait]
impl Remote for HttpRemote {
    async fn list(&self, after: Option<i64>, limit: usize) -> Result<ListPage, RemoteError> {
        let req = rpc::ListObjectsRequest {
            source: self.project.clone(),
            after: after.map(|n| n.to_string()),
            limit: Some(
                u32::try_from(limit)
                    .map_err(|_| RemoteError::Protocol("invalid page limit".into()))?,
            ),
        };
        let page = self.rpc_retry(|| self.archive.list_objects(&req)).await?;
        crate::protocol::validate_page(&page)?;
        Ok(page)
    }
    async fn get_coverage(&self) -> Result<Option<rpc::Coverage>, RemoteError> {
        Ok(self.get_status().await?.coverage)
    }
    async fn download(
        &self,
        obj: &ListedObject,
        dest: &Path,
    ) -> Result<(String, u64), RemoteError> {
        let url = reqwest::Url::parse(&obj.url)
            .map_err(|_| RemoteError::Protocol("invalid object URL".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(RemoteError::Protocol(
                "object URL must use HTTP(S) without credentials".into(),
            ));
        }
        for attempt in 0..=3 {
            self.counts.object_gets.fetch_add(1, Ordering::Relaxed);
            let response = self.client.get(url.clone()).send().await;
            let mut delay = None;
            let result = match response {
                Ok(response) if response.status().is_success() => {
                    let mut file = tokio::fs::File::create(dest).await.map_err(io_error)?;
                    let mut stream = response.bytes_stream();
                    let mut hash = Sha256::new();
                    let mut bytes = 0;
                    let mut interrupted = false;
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(chunk) => {
                                self.counts
                                    .bytes
                                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                                file.write_all(&chunk).await.map_err(io_error)?;
                                hash.update(&chunk);
                                bytes += chunk.len() as u64;
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
                    RemoteError::Transport("object body interrupted".into())
                }
                Ok(response) => {
                    delay = retry_after(response.headers());
                    Self::status(response.status(), true)
                }
                Err(_) => RemoteError::Transport("object request failed".into()),
            };
            if !matches!(result, RemoteError::Transport(_)) || attempt == 3 {
                return Err(result);
            }
            self.backoff(attempt, delay).await;
        }
        unreachable!()
    }
    fn counts(&self) -> RemoteCounts {
        self.counts.snapshot()
    }
}

/// A bucket-shaped source directory, used without any credentials by integration tests.
pub struct DirRemote {
    root: PathBuf,
    expire_once: Mutex<HashSet<String>>,
    counts: Counts,
}
impl DirRemote {
    pub fn new(root: PathBuf, _project: impl Into<String>) -> Self {
        Self {
            root,
            expire_once: Mutex::default(),
            counts: Counts::default(),
        }
    }
    async fn read_coverage(&self) -> Result<Option<rpc::Coverage>, RemoteError> {
        let directory = match tokio::fs::read(self.root.join("coverage.json")).await {
            Ok(bytes) => serde_json::from_slice::<DirectoryCoverage>(&bytes)
                .map_err(|_| RemoteError::Protocol("invalid directory coverage".into()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error(e)),
        };
        let c = directory.coverage;
        let coverage = rpc::Coverage {
            archive_id: directory.archive_id,
            first_retained: c.first_retained.to_string(),
            latest_published: c.latest_published.map(|n| n.to_string()),
            latest_published_at: c.latest_published_at,
            retention_seconds: c.retention_seconds,
        };
        Coverage::try_from(&coverage)?;
        Ok(Some(coverage))
    }
    pub fn expire_once(&self, name: &str) {
        self.expire_once.lock().unwrap().insert(name.into());
    }
}
#[derive(serde::Deserialize)]
struct DirectoryCoverage {
    archive_id: String,
    #[serde(flatten)]
    coverage: Coverage,
}
#[async_trait::async_trait]
impl Remote for DirRemote {
    async fn list(&self, after: Option<i64>, limit: usize) -> Result<ListPage, RemoteError> {
        self.counts.api_calls.fetch_add(1, Ordering::Relaxed);
        if limit == 0 {
            return Err(RemoteError::Protocol("zero page limit".into()));
        }
        let coverage = self.read_coverage().await?;
        let mut page = ListPage {
            coverage,
            objects: vec![],
            next_after: None,
            expires_at: None,
        };
        let Some(coverage) = &page.coverage else {
            return Ok(page);
        };
        let floor: i64 = coverage.first_retained.parse().unwrap();
        if after.is_some_and(|after| after.saturating_add(1) < floor) {
            return Err(RemoteError::RetentionGap);
        }
        let after = after.unwrap_or(floor - 1);
        let dir = self
            .root
            .join("archives")
            .join(&coverage.archive_id)
            .join("events");
        if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
            while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
                let name = entry.file_name().to_string_lossy().into_owned();
                let key = crate::parse_key(&name)
                    .ok_or_else(|| RemoteError::Protocol("malformed archive key".into()))?;
                if key.sequence > after {
                    page.objects.push(ListedObject {
                        seq: key.sequence.to_string(),
                        name,
                        size: entry.metadata().await.map_err(io_error)?.len(),
                        sha256: key.sha256,
                        url: entry.path().to_string_lossy().into_owned(),
                    });
                }
            }
        }
        page.objects.sort_by(|a, b| a.name.cmp(&b.name));
        if page.objects.len() > limit {
            // A sequence cannot be split across pages without concealing a conflicting identity.
            let boundary = page.objects[limit - 1].seq.clone();
            let end = page
                .objects
                .iter()
                .take_while(|o| o.seq.parse::<i64>().unwrap() <= boundary.parse::<i64>().unwrap())
                .count();
            if end < page.objects.len() {
                page.next_after = Some(boundary);
            }
            page.objects.truncate(end);
        }
        crate::protocol::validate_page(&page)?;
        Ok(page)
    }
    async fn get_coverage(&self) -> Result<Option<rpc::Coverage>, RemoteError> {
        self.counts.api_calls.fetch_add(1, Ordering::Relaxed);
        self.read_coverage().await
    }
    async fn download(
        &self,
        obj: &ListedObject,
        dest: &Path,
    ) -> Result<(String, u64), RemoteError> {
        self.counts.object_gets.fetch_add(1, Ordering::Relaxed);
        if self.expire_once.lock().unwrap().remove(&obj.name) {
            return Err(RemoteError::Expired);
        }
        let mut input = tokio::fs::File::open(&obj.url).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RemoteError::Expired
            } else {
                io_error(e)
            }
        })?;
        let mut output = tokio::fs::File::create(dest).await.map_err(io_error)?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buf = vec![0; 256 * 1024];
        loop {
            let n = input.read(&mut buf).await.map_err(io_error)?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).await.map_err(io_error)?;
            hash.update(&buf[..n]);
            bytes += n as u64;
            self.counts.bytes.fetch_add(n as u64, Ordering::Relaxed);
        }
        output.flush().await.map_err(io_error)?;
        Ok((hex::encode(hash.finalize()), bytes))
    }
    fn counts(&self) -> RemoteCounts {
        self.counts.snapshot()
    }
}
