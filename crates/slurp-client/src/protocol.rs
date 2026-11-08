//! Check wire values at the sync boundary, before anything is downloaded or recorded.
use crate::{RemoteError, api};

/// Check one page of `ListArchives`: sequences of at least 1 and strictly increasing, a SHA-256 that is 64 lowercase hex
/// digits, a coverage that agrees with `first`/`last`, and a gap that is a real range.
///
/// # Errors
/// Returns a protocol error naming what is wrong.
pub fn validate_listing(page: &api::ListArchivesResponse) -> Result<(), RemoteError> {
    let bad = |what: &str| Err(RemoteError::Protocol(format!("invalid listing: {what}")));
    let coverage = &page.coverage;
    if coverage.first.is_some_and(|n| n < 1)
        || coverage.last.is_some_and(|n| n < 1)
        || coverage.first.is_some() != coverage.last.is_some()
        || coverage.first > coverage.last
    {
        return bad("coverage");
    }
    let mut previous = 0;
    for archive in &page.archives {
        let valid_sha = archive.sha256.len() == 64
            && archive
                .sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if archive.seq < 1 || archive.seq <= previous || !valid_sha {
            return bad("an archive's sequence or sha256");
        }
        previous = archive.seq;
    }
    if !page.archives.is_empty() && coverage.last.is_none() {
        return bad("archives without coverage");
    }
    if page
        .gap
        .is_some_and(|gap| gap.from < 1 || gap.to < gap.from)
    {
        return bad("gap");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(seq: u64, sha: &str) -> api::ArchiveInfo {
        api::ArchiveInfo {
            seq,
            size: 10,
            sha256: sha.into(),
            events: 1,
            created_at: "2026-11-07T12:00:00.000Z".into(),
            format: 1,
        }
    }
    fn page(
        first: Option<u64>,
        last: Option<u64>,
        archives: Vec<api::ArchiveInfo>,
    ) -> api::ListArchivesResponse {
        api::ListArchivesResponse {
            coverage: api::Coverage {
                first,
                last,
                last_at: None,
                pending: false,
            },
            archives,
            next: None,
            gap: None,
        }
    }

    #[test]
    fn a_listing_needs_positive_increasing_sequences_and_real_digests() {
        let sha = "a".repeat(64);
        assert!(validate_listing(&page(None, None, vec![])).is_ok());
        assert!(
            validate_listing(&page(
                Some(1),
                Some(2),
                vec![archive(1, &sha), archive(2, &sha)]
            ))
            .is_ok()
        );
        for bad in [
            page(Some(0), Some(1), vec![]),
            page(Some(2), Some(1), vec![]),
            page(Some(1), None, vec![]),
            page(None, None, vec![archive(1, &sha)]),
            page(Some(1), Some(2), vec![archive(2, &sha), archive(1, &sha)]),
            page(Some(1), Some(2), vec![archive(1, &sha), archive(1, &sha)]),
            page(Some(1), Some(1), vec![archive(1, "not-a-digest")]),
            page(Some(1), Some(1), vec![archive(1, &"A".repeat(64))]),
        ] {
            assert!(validate_listing(&bad).is_err(), "{bad:?}");
        }
        let mut gap = page(Some(5), Some(5), vec![archive(5, &sha)]);
        gap.gap = Some(api::Gap { from: 3, to: 2 });
        assert!(validate_listing(&gap).is_err());
    }
}
