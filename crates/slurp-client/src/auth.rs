//! Shared, backend-scoped credentials. One OS lock serializes login, refresh and
//! logout across CLI and daemon processes. The credential store owns one atomic
//! JSON value, so access/refresh tokens are always replaced together.
use crate::rpc;
use anyhow::{Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::{fs::File, path::PathBuf, sync::Arc};

pub trait CredentialStore: Send + Sync {
    fn load(&self, backend: &str) -> Result<Option<rpc::AuthCredentials>>;
    fn save(&self, backend: &str, credentials: &rpc::AuthCredentials) -> Result<()>;
    fn delete(&self, backend: &str) -> Result<()>;
}

/// Selected machine credential store; never writes tokens into library or event folders.
#[derive(Debug, Default)]
pub struct SavedCredentials;
impl CredentialStore for SavedCredentials {
    fn load(&self, backend: &str) -> Result<Option<rpc::AuthCredentials>> {
        crate::storage::get(backend)?
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|_| anyhow!("saved credentials are invalid; log in again"))
            })
            .transpose()
    }
    fn save(&self, backend: &str, credentials: &rpc::AuthCredentials) -> Result<()> {
        crate::storage::set(backend, &serde_json::to_string(credentials)?)
    }
    fn delete(&self, backend: &str) -> Result<()> {
        crate::storage::delete(backend)
    }
}

pub struct Session {
    backend: String,
    http: reqwest::Client,
    store: Arc<dyn CredentialStore>,
    lock_path: PathBuf,
}
impl Session {
    pub fn new(
        backend: &str,
        http: reqwest::Client,
        lock_directory: PathBuf,
        store: Arc<dyn CredentialStore>,
    ) -> Result<Self> {
        let url = reqwest::Url::parse(backend)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("expected an HTTP(S) backend URL without credentials, query or fragment");
        }
        let backend = url.to_string().trim_end_matches('/').to_owned();
        std::fs::create_dir_all(&lock_directory)?;
        let lock_path =
            lock_directory.join(format!("{}.lock", hex::encode(Sha256::digest(&backend))));
        Ok(Self {
            backend,
            http,
            store,
            lock_path,
        })
    }

    pub fn backend_url(&self) -> &str {
        &self.backend
    }

    fn client(&self, token: Option<String>) -> rpc::AuthClient {
        rpc::AuthClient::new(&self.backend, self.http.clone(), token)
    }

    async fn lock(&self) -> Result<File> {
        crate::locking::acquire(self.lock_path.clone()).await
    }

    pub async fn begin_login(&self) -> Result<rpc::BeginLoginResponse> {
        self.client(None)
            .begin_login(&rpc::BeginLoginRequest {})
            .await
            .map_err(|_| anyhow!("could not begin login; retry when the service is available"))
    }

    /// The caller waits the advertised interval. On slow_down add five seconds;
    /// cancellation simply stops polling. Provider codes expire without cleanup.
    pub fn saved_user(&self) -> Result<Option<rpc::AuthUser>> {
        Ok(self
            .store
            .load(&self.backend)?
            .map(|credentials| credentials.user))
    }
    pub async fn poll_authorization(&self, device_code: &str) -> Result<rpc::PollLoginResponse> {
        self.client(None)
            .poll_login(&rpc::PollLoginRequest {
                device_code: device_code.into(),
            })
            .await
            .map_err(|_| anyhow!("login service unavailable; retry polling"))
    }
    pub async fn save_login(&self, credentials: &rpc::AuthCredentials) -> Result<()> {
        let _lock = self.lock().await?;
        self.store.save(&self.backend, credentials)
    }
    pub async fn poll_login(&self, device_code: &str) -> Result<rpc::PollLoginResponse> {
        let response = self.poll_authorization(device_code).await?;
        if let Some(credentials) = &response.credentials {
            if response.status != "complete" {
                bail!("invalid login response");
            }
            let _lock = self.lock().await?;
            self.store.save(&self.backend, credentials)?;
        } else if response.status == "complete" {
            bail!("login completed without credentials");
        }
        Ok(response)
    }

    pub async fn access_token(&self) -> Result<String> {
        self.token(None).await
    }

    /// Complete a device login, respecting the provider's polling interval and expiry.
    ///
    /// # Errors
    /// Returns an error for denied, expired, unavailable, or invalid authorization responses.
    pub async fn wait_for_login(&self, device: &rpc::BeginLoginResponse) -> Result<rpc::AuthUser> {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(device.expires_in_seconds.into());
        let mut interval = u64::from(device.interval_seconds.max(1));
        loop {
            if Instant::now() + Duration::from_secs(interval) >= deadline {
                bail!("login expired");
            }
            tokio::time::sleep(Duration::from_secs(interval)).await;
            let result = self.poll_login(&device.device_code).await?;
            match result.status.as_str() {
                "pending" => {}
                "slow_down" => interval = interval.saturating_add(5),
                "complete" => {
                    return result
                        .credentials
                        .map(|credentials| credentials.user)
                        .ok_or_else(|| anyhow!("missing login credentials"));
                }
                "denied" => bail!("login denied"),
                "expired" => bail!("login expired"),
                _ => bail!("invalid login response"),
            }
        }
    }

    /// Retry a rejected session once. A concurrent process's fresh token wins;
    /// API keys/environment tokens should be handled directly by the caller.
    pub async fn refresh_after_unauthenticated(&self, rejected_token: &str) -> Result<String> {
        self.token(Some(rejected_token)).await
    }

    async fn token(&self, rejected: Option<&str>) -> Result<String> {
        let _lock = self.lock().await?;
        let credentials = self
            .store
            .load(&self.backend)?
            .ok_or_else(|| anyhow!("login required"))?;
        if is_static(&credentials) {
            // A self-hosted admin token: it does not expire and has nothing to refresh.
            if rejected.is_some_and(|token| token == credentials.access_token) {
                bail!("the saved admin token was rejected; run slurp connect again");
            }
            return Ok(credentials.access_token);
        }
        if fresh(&credentials.access_token)
            && rejected.is_none_or(|token| token != credentials.access_token)
        {
            return Ok(credentials.access_token);
        }
        let response = self
            .client(None)
            .refresh(&rpc::RefreshRequest {
                refresh_token: credentials.refresh_token,
            })
            .await;
        match response {
            Ok(response) => {
                // Save the entire replacement before returning its access token.
                self.store.save(&self.backend, &response.credentials)?;
                Ok(response.credentials.access_token)
            }
            Err(error) if error.code() == Some(1000) => {
                self.store.delete(&self.backend)?;
                bail!("login required");
            }
            Err(_) => bail!("session refresh unavailable; saved credentials retained"),
        }
    }

    /// Local logout always clears credentials, even if remote revocation fails.
    /// Report that failure so the caller can distinguish local/remote outcomes.
    pub async fn logout(&self) -> Result<()> {
        let _lock = self.lock().await?;
        let credentials = match self.store.load(&self.backend) {
            Ok(credentials) => credentials,
            Err(_) => {
                self.store.delete(&self.backend)?;
                bail!(
                    "local credentials cleared; saved credentials could not be read for remote logout"
                );
            }
        };
        let result = async {
            let Some(credentials) = credentials else {
                return Ok(());
            };
            if is_static(&credentials) {
                return Ok(());
            }
            let token = if fresh(&credentials.access_token) {
                credentials.access_token
            } else {
                match self
                    .client(None)
                    .refresh(&rpc::RefreshRequest {
                        refresh_token: credentials.refresh_token,
                    })
                    .await
                {
                    Ok(response) => response.credentials.access_token,
                    Err(error) if error.code() == Some(1000) => return Ok(()),
                    Err(_) => {
                        bail!("local credentials cleared; remote session revocation unavailable")
                    }
                }
            };
            self.client(Some(token))
                .logout(&rpc::LogoutRequest {})
                .await
                .map(|_| ())
                .map_err(|_| {
                    anyhow!("local credentials cleared; remote session revocation unavailable")
                })
        }
        .await;
        self.store.delete(&self.backend)?;
        result
    }
}

/// A self-hosted deployment is operated with one long-lived admin token, saved with itself as its refresh token.
fn is_static(credentials: &rpc::AuthCredentials) -> bool {
    !credentials.access_token.is_empty() && credentials.access_token == credentials.refresh_token
}

// Expiry is a client refresh hint. The backend remains the token verifier.
fn fresh(token: &str) -> bool {
    let Some(payload) = token
        .split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
    else {
        return false;
    };
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&payload) else {
        return false;
    };
    payload
        .get("exp")
        .and_then(|v| v.as_i64())
        .is_some_and(|exp| exp > chrono::Utc::now().timestamp() + 60)
}
