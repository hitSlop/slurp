//! Verified NDJSON export without a persistent download folder or cursor.
use crate::{Remote, RemoteError, protocol};
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
    let mut expired = 0;
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
        let mut cursor = after.unwrap_or(floor - 1);
        let tail = coverage
            .latest_published
            .as_deref()
            .map(protocol::parse_sequence)
            .transpose()?
            .unwrap_or(cursor);
        while cursor < tail {
            let page = remote.list(Some(cursor), 1000).await?;
            if page
                .coverage
                .as_ref()
                .is_none_or(|c| Some(&c.archive_id) != archive.as_ref())
            {
                bail!("archive reset during read")
            }
            if page.objects.is_empty() {
                bail!("publication gap before the advertised tail")
            }
            let mut progressed = false;
            for object in page
                .objects
                .iter()
                .take_while(|o| o.seq.parse::<i64>().is_ok_and(|v| v <= tail))
            {
                let sequence = protocol::parse_sequence(&object.seq)?;
                if sequence != cursor + 1 {
                    bail!("publication gap; expected object {}", cursor + 1)
                }
                let temporary = tempfile::tempdir()?;
                crate::parse_key(&object.name)
                    .ok_or_else(|| anyhow::anyhow!("unsupported archive object name"))?;
                let path = temporary.path().join("object.jsonl.gz");
                match remote.download(object, &path).await {
                    Ok((sha, size)) if sha == object.sha256 && size == object.size => {}
                    Ok(_) => bail!("object size/checksum mismatch"),
                    Err(RemoteError::Expired) if expired < 3 => {
                        expired += 1;
                        break;
                    }
                    Err(e) => return Err(e.into()),
                }
                let mut decoder = crate::archive::open_jsonl(&path)?;
                let mut bytes = [0; 64 * 1024];
                loop {
                    let size = decoder.read(&mut bytes)?;
                    if size == 0 {
                        break;
                    };
                    output.write_all(&bytes[..size])?;
                }
                output.flush()?;
                cursor = sequence;
                after = Some(cursor);
                progressed = true;
                expired = 0;
            }
            if !progressed && expired == 0 {
                bail!("publication gap before the advertised tail")
            }
        }
        if !follow {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
