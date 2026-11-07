//! Verified NDJSON export without a persistent download folder or cursor.
use crate::{Remote, protocol, walk::Walk};
use anyhow::{Result, bail};
use std::{
    io::{Read, Write},
    time::Duration,
};

pub async fn read_published(
    remote: &dyn Remote,
    output: &mut dyn Write,
    mut archive: Option<String>,
    mut after: Option<i64>,
    follow: bool,
) -> Result<()> {
    if after.is_some_and(|v| v < 0) || after.is_some() && archive.is_none() {
        bail!("--after requires --archive and a nonnegative object sequence");
    }
    loop {
        let Some(coverage) = remote.get_coverage().await? else {
            if !follow {
                return Ok(());
            };
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        };
        if archive.as_ref().is_some_and(|a| a != &coverage.archive_id) {
            bail!("archive reset; select the current archive explicitly")
        }
        archive = Some(coverage.archive_id.clone());
        let floor = protocol::parse_sequence(&coverage.first_retained)?;
        if after.is_some_and(|v| v < floor - 1) {
            bail!("retention gap; the requested records are no longer retained")
        }
        let cursor = after.unwrap_or(floor - 1);
        let tail = coverage
            .latest_published
            .as_deref()
            .map(protocol::parse_sequence)
            .transpose()?
            .unwrap_or(cursor);
        let mut walk = Walk::new(remote, &coverage.archive_id, cursor, tail, 1000);
        while let Some(downloaded) = walk.next(|| Ok(tempfile::tempdir()?)).await? {
            let mut decoder = crate::archive::open_jsonl(&downloaded.path)?;
            let mut bytes = [0; 64 * 1024];
            loop {
                let size = decoder.read(&mut bytes)?;
                if size == 0 {
                    break;
                };
                output.write_all(&bytes[..size])?;
            }
            output.flush()?;
            after = Some(downloaded.sequence);
        }
        if !follow {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
