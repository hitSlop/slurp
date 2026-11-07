//! Cloud project creation. Creating is idempotent by name, so there is nothing to resume or checkpoint.
use anyhow::{Result, anyhow};
use slurp_client::rpc;

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

/// Sanitize transport failures so credential-bearing response bodies are never displayed.
pub fn service_error(error: rpc::Error) -> anyhow::Error {
    anyhow!(match error.code() {
        Some(1000) => "not connected; run slurp connect <worker-url> --token-stdin",
        Some(1001) => "this key does not have permission for that project",
        Some(2000) => "invalid project details",
        Some(2001) => "a project with that name already exists; choose another name",
        Some(3000) => "project not found; select an available project or create a new one",
        _ => "Slurp service request failed; retry when the service is available",
    })
}

/// The first active publishable key of a project (the one `slurp init` made, unless it was revoked), made if there is none.
///
/// # Errors
/// Returns an error if the service refuses the request or is unavailable.
pub async fn publishable_key(client: &rpc::ProjectClient, project: &str) -> Result<String> {
    let keys = client
        .list_keys(&rpc::ListKeysRequest {
            project: project.into(),
            scope: Some("publishable".into()),
        })
        .await
        .map_err(service_error)?
        .keys;
    if let Some(key) = keys
        .into_iter()
        .find(|key| key.revoked_at.is_none())
        .and_then(|key| key.key)
    {
        return Ok(key);
    }
    Ok(client
        .create_key(&rpc::CreateKeyRequest {
            project: project.into(),
            scope: "publishable".into(),
            name: Some("default".into()),
        })
        .await
        .map_err(service_error)?
        .key)
}

#[cfg(test)]
mod tests {
    use super::alias;

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
