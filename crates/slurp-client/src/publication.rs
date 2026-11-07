//! Optional source-level scheduling hints, independent of archive correctness.
use crate::rpc::PublicationStatus;

/// Discard unsupported or incomplete hints without making an accepted write or sync fail.
#[must_use]
pub fn validated(status: Option<PublicationStatus>) -> Option<PublicationStatus> {
    let mut status = status?;
    match status.state.as_str() {
        "pending" | "retrying" if status.estimated_at.is_some() => {}
        "idle" | "publishing" | "blocked" => status.estimated_at = None,
        _ => return None,
    }
    Some(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_hints_do_not_affect_archive_reads() {
        let status = PublicationStatus {
            state: "future-state".into(),
            observed_at: chrono::Utc::now(),
            interval_seconds: 3600,
            estimated_at: None,
        };
        assert!(validated(Some(status.clone())).is_none());
        assert!(
            validated(Some(PublicationStatus {
                state: "pending".into(),
                ..status.clone()
            }))
            .is_none()
        );
        assert!(
            validated(Some(PublicationStatus {
                state: "idle".into(),
                ..status
            }))
            .is_some()
        );
        assert!(validated(None).is_none());
        // Older gateways omit the entire field.
        let old: crate::rpc::GetCoverageResponse =
            serde_json::from_str(r#"{"coverage":null}"#).expect("old response");
        assert!(old.publication.is_none());
    }
}
