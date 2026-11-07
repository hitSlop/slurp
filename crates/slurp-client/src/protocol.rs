//! Validate generated wire values at the sync boundary; report sequences remain i64.
use crate::{ListPage, RemoteError, rpc};

pub fn parse_sequence(value: &str) -> Result<i64, RemoteError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(RemoteError::Protocol(
            "expected a decimal sequence string".into(),
        ));
    }
    value
        .parse()
        .map_err(|_| RemoteError::Protocol("sequence exceeds i64".into()))
}

/// Check a coverage read from the wire: a nonempty archive id and sequences that are decimal strings of at least 1.
///
/// # Errors
/// Returns a protocol error naming what is wrong.
pub fn validate_coverage(coverage: &rpc::Coverage) -> Result<(), RemoteError> {
    let first = parse_sequence(&coverage.first_retained)?;
    let latest = coverage
        .latest_published
        .as_deref()
        .map(parse_sequence)
        .transpose()?;
    if coverage.archive_id.is_empty() || first < 1 || latest.is_some_and(|n| n < 1) {
        return Err(RemoteError::Protocol("invalid archive coverage".into()));
    }
    Ok(())
}

pub fn validate_page(page: &ListPage) -> Result<(), RemoteError> {
    if let Some(c) = &page.coverage {
        validate_coverage(c)?;
    } else if !page.objects.is_empty() || page.next_after.is_some() {
        return Err(RemoteError::Protocol(
            "objects or cursor without coverage".into(),
        ));
    }
    for obj in &page.objects {
        if parse_sequence(&obj.seq)? < 1 {
            return Err(RemoteError::Protocol(
                "object sequence must be positive".into(),
            ));
        }
    }
    if let Some(after) = &page.next_after {
        parse_sequence(after)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coverage(archive: &str, first: &str, latest: Option<&str>) -> rpc::Coverage {
        rpc::Coverage {
            archive_id: archive.into(),
            first_retained: first.into(),
            latest_published: latest.map(Into::into),
            latest_published_at: None,
            retention_seconds: 0,
        }
    }

    #[test]
    fn coverage_needs_an_archive_and_positive_decimal_sequences() {
        assert!(validate_coverage(&coverage("a", "1", Some("7"))).is_ok());
        assert!(validate_coverage(&coverage("a", "1", None)).is_ok());
        for bad in [
            coverage("", "1", Some("7")),
            coverage("a", "0", Some("7")),
            coverage("a", "1", Some("0")),
            coverage("a", "one", None),
            coverage("a", "1", Some("-3")),
            coverage("a", "99999999999999999999", None),
        ] {
            assert!(validate_coverage(&bad).is_err(), "{bad:?}");
        }
    }
}
