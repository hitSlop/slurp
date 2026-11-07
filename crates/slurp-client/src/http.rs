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

/// How long a server asked us to wait before trying again: the `Retry-After` header as a number of seconds or as an HTTP date.
/// A date in the past means "now" (zero). A missing or unreadable header is `None`, so each caller keeps its own default backoff
/// and its own ceiling.
pub fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::retry_after;
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
    use std::time::Duration;

    fn headers(value: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(RETRY_AFTER, HeaderValue::from_str(value).unwrap());
        map
    }

    #[test]
    fn seconds_dates_and_nonsense() {
        assert_eq!(retry_after(&headers("7")), Some(Duration::from_secs(7)));
        assert_eq!(retry_after(&headers(" 12 ")), Some(Duration::from_secs(12)));
        assert_eq!(retry_after(&headers("0")), Some(Duration::ZERO));
        assert_eq!(
            retry_after(&HeaderMap::new()),
            None,
            "no header: the caller's own backoff applies"
        );
        for bad in ["soon", "-5", "1.5", "", "Mon, 99 Foo 2026"] {
            assert_eq!(retry_after(&headers(bad)), None, "{bad:?}");
        }
        let future = (chrono::Utc::now() + chrono::Duration::seconds(90)).to_rfc2822();
        let wait = retry_after(&headers(&future)).expect("an HTTP date");
        assert!((85..=90).contains(&wait.as_secs()), "{wait:?}");
        let past = (chrono::Utc::now() - chrono::Duration::seconds(90)).to_rfc2822();
        assert_eq!(
            retry_after(&headers(&past)),
            Some(Duration::ZERO),
            "a date in the past is now"
        );
        // The standard form servers send: IMF-fixdate with GMT.
        assert!(retry_after(&headers("Sun, 06 Nov 1994 08:49:37 GMT")).is_some());
    }
}
