//! Cloud project creation. Creating is idempotent by name, so there is nothing to resume or checkpoint.
use anyhow::{Result, anyhow};
use slurp_client::api::{self, CallError, ErrorCode};

/// Convert a friendly display name into a valid project alias.
pub fn alias(title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('_') {
            slug.push('_');
        }
        if slug.len() >= 59 {
            break;
        }
    }
    let slug = slug.trim_matches('_');
    format!("app_{}", if slug.is_empty() { "project" } else { slug })
}

/// A source name: `^[a-z][a-z0-9_]{0,31}$` (`docs/contracts.md`, "Credentials").
pub fn valid_source(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && name.len() <= 32
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The control API of one Worker with one token: `api::call` with the connection details held once.
pub struct Api {
    http: slurp_client::reqwest::Client,
    base: String,
    token: String,
}

impl Api {
    /// # Errors
    /// Returns an error if the HTTP client cannot be built.
    pub fn new(backend: &str, token: &str) -> Result<Self> {
        Ok(Self {
            http: slurp_client::http_client()?,
            base: backend.to_owned(),
            token: token.to_owned(),
        })
    }

    pub async fn call<M: api::Method>(&self, req: &M::Req) -> Result<M::Res, CallError> {
        api::call::<M>(&self.http, &self.base, &self.token, req).await
    }
}

/// Whether the Worker refused the token itself (`unauthenticated`, or `forbidden`): "rejected", as opposed to "unreachable".
pub fn is_rejected(error: &CallError) -> bool {
    matches!(
        error,
        CallError::Api {
            code: Some(ErrorCode::Unauthenticated | ErrorCode::Forbidden),
            ..
        }
    )
}

/// Explain a failed call. A refusal the Worker describes (`invalid_argument`, `not_found`, ...) shows its message, which
/// is written for people; anything else is generic so a response body that was never an API error is not displayed.
pub fn service_error(error: CallError) -> anyhow::Error {
    let CallError::Api {
        code: Some(code),
        message,
        ..
    } = error
    else {
        return anyhow!("Slurp service request failed; retry when the service is available");
    };
    anyhow!(match code {
        ErrorCode::Unauthenticated => {
            "not connected; run slurp connect <worker-url> --token-stdin".to_owned()
        }
        ErrorCode::Forbidden => "this key does not have permission for that request".to_owned(),
        ErrorCode::InvalidArgument => format!("invalid request: {message}"),
        ErrorCode::AlreadyExists => {
            format!("already exists: {message}; choose another name")
        }
        ErrorCode::NotFound => {
            format!("not found: {message}; select an available project or create a new one")
        }
        ErrorCode::Unavailable => {
            "the Worker is unavailable (is ADMIN_TOKEN set, and R2 reachable?); retry shortly"
                .to_owned()
        }
    })
}

/// The publishable key for one source of a project: the source's oldest live key, which the Worker creates when there is none.
///
/// # Errors
/// Returns an error if the Worker refuses the request or is unavailable.
pub async fn source_key(api: &Api, project: &str, source: &str) -> Result<String> {
    api.call::<api::SourceKey>(&api::SourceKeyRequest {
        project: project.into(),
        source: source.into(),
    })
    .await
    .map_err(service_error)?
    .key
    .key
    .ok_or_else(|| anyhow!("the Worker returned a key without its value"))
}

#[cfg(test)]
mod tests {
    use super::{alias, valid_source};

    #[test]
    fn sources_are_short_lowercase_names() {
        for good in ["default", "web", "ios", "cli", "mcp", "github", "a", "a_1"] {
            assert!(valid_source(good), "{good}");
        }
        for bad in ["", "Web", "1a", "_a", "a-b", "a b", &"x".repeat(33)] {
            assert!(!valid_source(bad), "{bad}");
        }
        assert!(valid_source(&"x".repeat(32)));
    }

    #[test]
    fn display_names_produce_bounded_valid_internal_aliases() {
        assert_eq!(alias("My SaaS"), "app_my_saas");
        assert_eq!(alias("7-day app"), "app_7_day_app");
        for title in [
            "select",
            "prj_events",
            "hello___world",
            "🌊",
            &"x".repeat(200),
        ] {
            let name = alias(title);
            assert!(
                name.starts_with("app_") && name.len() <= 63 && !name.contains("__"),
                "invalid alias {name}"
            );
            assert!(
                name.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            );
        }
    }
}
