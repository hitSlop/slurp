//! Verified NDJSON export without a persistent download folder or cursor.
use crate::{
    Remote,
    walk::{Step, Walk},
};
use anyhow::Result;
use std::{
    io::{Read, Write},
    time::Duration,
};

/// Print the envelopes of every published archive after `after` (or from the oldest retained one) to `output`.
///
/// Archives that retention deleted before they were read are reported on `notes` and skipped. With `follow`, the walk
/// repeats every minute for newly published archives.
pub async fn read_published(
    remote: &dyn Remote,
    output: &mut dyn Write,
    notes: &mut dyn Write,
    mut after: Option<u64>,
    follow: bool,
) -> Result<()> {
    loop {
        let mut walk = Walk::new(remote, after, 1000);
        while let Some(step) = walk.next(|| Ok(tempfile::tempdir()?)).await? {
            let downloaded = match step {
                Step::Gap(gap) => {
                    writeln!(
                        notes,
                        "archives {} to {} were deleted by retention before they were read",
                        gap.from, gap.to
                    )?;
                    continue;
                }
                Step::Archive(downloaded) => downloaded,
            };
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
        }
        after = walk.position();
        if !follow {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
