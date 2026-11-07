use std::time::Duration;

/// Shared gateway transport, including TLS roots, timeouts and redirect policy.
pub fn http_client() -> anyhow::Result<reqwest::Client> {
    // Reuse the workspace's WebPKI DER bundle instead of adding another roots crate.
    let mut roots = rustls::RootCertStore::empty();
    for root in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
        roots
            .add(root.clone())
            .map_err(|_| anyhow::anyhow!("invalid bundled TLS root"))?;
    }
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| anyhow::anyhow!("TLS initialization failed"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| anyhow::anyhow!("HTTP client initialization failed"))
}
