//! Validate generated wire values at the sync boundary; report sequences remain i64.
use crate::{Coverage, ListPage, RemoteError, rpc};

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

impl TryFrom<&rpc::Coverage> for Coverage {
    type Error = RemoteError;
    fn try_from(c: &rpc::Coverage) -> Result<Self, Self::Error> {
        let coverage = Self {
            first_retained: parse_sequence(&c.first_retained)?,
            latest_published: c
                .latest_published
                .as_deref()
                .map(parse_sequence)
                .transpose()?,
            latest_published_at: c.latest_published_at,
            retention_seconds: c.retention_seconds,
        };
        if c.archive_id.is_empty() || coverage.validate().is_err() {
            return Err(RemoteError::Protocol("invalid archive coverage".into()));
        }
        Ok(coverage)
    }
}

pub fn validate_page(page: &ListPage) -> Result<(), RemoteError> {
    if let Some(c) = &page.coverage {
        Coverage::try_from(c)?;
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
