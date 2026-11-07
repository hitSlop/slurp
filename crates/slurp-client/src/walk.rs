//! Walk a project's published archives in order, downloading and verifying each one.
//!
//! `slurp sync` (into DuckDB) and `slurp read` (to stdout) both consume archives this way: list a page, check the archive is the
//! one expected, check the sequence has no hole, check the name, then download with size and SHA-256 verification (asking for a
//! fresh link if one expires). What each consumer then does with a verified archive, and what counts as progress, is its own
//! decision: the database commits a receipt, a reader prints.
use crate::{ListedObject, Remote, download_verified, parse_key, protocol};
use anyhow::{Result, bail};
use std::{collections::VecDeque, path::PathBuf};

/// One archive, downloaded and verified, in a directory that is removed when this value is dropped.
pub struct Downloaded {
    pub sequence: i64,
    pub object: ListedObject,
    pub path: PathBuf,
    _directory: tempfile::TempDir,
}

/// A cursor over the archives after `after` up to and including `head`, all in one archive generation (`archive_id`).
pub struct Walk<'a> {
    remote: &'a dyn Remote,
    archive_id: String,
    after: i64,
    head: i64,
    page_size: usize,
    queue: VecDeque<ListedObject>,
}

impl<'a> Walk<'a> {
    pub fn new(
        remote: &'a dyn Remote,
        archive_id: &str,
        after: i64,
        head: i64,
        page_size: usize,
    ) -> Self {
        Self {
            remote,
            archive_id: archive_id.into(),
            after,
            head,
            page_size,
            queue: VecDeque::new(),
        }
    }

    /// The sequence of the last archive returned (the starting `after` before the first).
    pub fn position(&self) -> i64 {
        self.after
    }

    /// The next archive, downloaded into a directory made by `scratch`, or `None` after `head`.
    ///
    /// # Errors
    /// Returns an error for an archive reset, a hole in the sequence, an unreadable listing or name, a download that fails
    /// verification, or a transport failure.
    pub async fn next(
        &mut self,
        mut scratch: impl FnMut() -> Result<tempfile::TempDir>,
    ) -> Result<Option<Downloaded>> {
        loop {
            if self.after >= self.head {
                return Ok(None);
            }
            let Some(object) = self.queue.pop_front() else {
                let page = self.remote.list(Some(self.after), self.page_size).await?;
                if page
                    .coverage
                    .as_ref()
                    .is_none_or(|coverage| coverage.archive_id != self.archive_id)
                {
                    bail!("archive reset while downloading");
                }
                if page.objects.is_empty() {
                    bail!(
                        "publication gap: nothing listed after object {}",
                        self.after
                    );
                }
                self.queue = page.objects.into();
                continue;
            };
            let sequence = protocol::parse_sequence(&object.seq)?;
            if sequence > self.head {
                return Ok(None);
            }
            if sequence != self.after + 1 {
                bail!("publication gap; expected object {}", self.after + 1);
            }
            parse_key(&object.name)
                .ok_or_else(|| anyhow::anyhow!("unsupported archive object name"))?;
            let directory = scratch()?;
            let path = directory.path().join("events.jsonl.gz");
            download_verified(self.remote, &object, &path).await?;
            self.after = sequence;
            return Ok(Some(Downloaded {
                sequence,
                object,
                path,
                _directory: directory,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ListPage, RemoteError, rpc};
    use sha2::{Digest, Sha256};
    use std::{path::Path, sync::Mutex};

    const ARCHIVE: &str = "archive-a";

    struct Fake {
        archive_id: String,
        objects: Vec<ListedObject>,
        bodies: Vec<Vec<u8>>,
        expire_first_download: Mutex<bool>,
        corrupt: bool,
    }
    fn object(seq: i64, body: &[u8]) -> ListedObject {
        let sha = hex::encode(Sha256::digest(body));
        ListedObject {
            seq: seq.to_string(),
            name: format!("{seq:020}-{sha}.jsonl.gz"),
            size: body.len() as u64,
            sha256: sha,
            url: format!("https://example.test/{seq}"),
        }
    }
    fn fake(count: i64) -> Fake {
        let bodies: Vec<Vec<u8>> = (1..=count)
            .map(|n| format!("body {n}").into_bytes())
            .collect();
        Fake {
            archive_id: ARCHIVE.into(),
            objects: bodies.iter().zip(1..).map(|(b, n)| object(n, b)).collect(),
            bodies,
            expire_first_download: Mutex::new(false),
            corrupt: false,
        }
    }
    #[async_trait::async_trait]
    impl Remote for Fake {
        async fn list(&self, after: Option<i64>, limit: usize) -> Result<ListPage, RemoteError> {
            let after = after.unwrap_or(0);
            Ok(ListPage {
                coverage: Some(rpc::Coverage {
                    archive_id: self.archive_id.clone(),
                    first_retained: "1".into(),
                    latest_published: Some(self.objects.len().to_string()),
                    latest_published_at: None,
                    retention_seconds: 0,
                }),
                objects: self
                    .objects
                    .iter()
                    .filter(|o| o.seq.parse::<i64>().map_or(true, |s| s > after))
                    .take(limit)
                    .cloned()
                    .collect(),
                next_after: None,
                expires_at: None,
            })
        }
        async fn get_coverage(&self) -> Result<Option<rpc::Coverage>, RemoteError> {
            Ok(None)
        }
        async fn download(
            &self,
            object: &ListedObject,
            dest: &Path,
        ) -> Result<(String, u64), RemoteError> {
            if std::mem::take(&mut *self.expire_first_download.lock().unwrap()) {
                return Err(RemoteError::Expired);
            }
            let index = self
                .objects
                .iter()
                .position(|o| o.name == object.name)
                .ok_or(RemoteError::Expired)?;
            let mut body = self.bodies[index].clone();
            if self.corrupt {
                body.push(b'!');
            }
            std::fs::write(dest, &body).unwrap();
            Ok((hex::encode(Sha256::digest(&body)), body.len() as u64))
        }
    }
    fn scratch() -> Result<tempfile::TempDir> {
        Ok(tempfile::tempdir()?)
    }
    async fn drain(walk: &mut Walk<'_>) -> Result<Vec<i64>> {
        let mut seen = vec![];
        while let Some(archive) = walk.next(scratch).await? {
            assert_eq!(
                std::fs::read(&archive.path)?,
                format!("body {}", archive.sequence).into_bytes()
            );
            seen.push(archive.sequence);
        }
        Ok(seen)
    }
    fn message(result: Result<Vec<i64>>) -> String {
        result.expect_err("expected a failure").to_string()
    }

    #[tokio::test]
    async fn archives_come_in_order_across_pages_and_stop_at_the_head() {
        let remote = fake(5);
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 5, 2);
        assert_eq!(drain(&mut walk).await.unwrap(), vec![1, 2, 3, 4, 5]);
        assert_eq!(walk.position(), 5);
        // Starting later, and a head below the end of the listing, both bound the walk.
        let mut walk = Walk::new(&remote, ARCHIVE, 2, 4, 100);
        assert_eq!(drain(&mut walk).await.unwrap(), vec![3, 4]);
    }

    #[tokio::test]
    async fn a_hole_in_the_sequence_is_a_publication_gap() {
        let mut remote = fake(4);
        remote.objects.remove(1); // 1, 3, 4
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 4, 10);
        assert!(message(drain(&mut walk).await).contains("publication gap; expected object 2"));
    }

    #[tokio::test]
    async fn an_empty_listing_before_the_head_is_a_publication_gap() {
        let remote = fake(0);
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 3, 10);
        assert!(message(drain(&mut walk).await).contains("publication gap"));
    }

    #[tokio::test]
    async fn a_different_archive_generation_is_a_reset() {
        let remote = fake(3);
        let mut walk = Walk::new(&remote, "another-archive", 0, 3, 10);
        assert!(message(drain(&mut walk).await).contains("archive reset"));
    }

    #[tokio::test]
    async fn malformed_listings_are_refused() {
        let mut remote = fake(2);
        remote.objects[0].seq = "one".into();
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 2, 10);
        assert!(message(drain(&mut walk).await).contains("decimal sequence"));

        let mut remote = fake(2);
        remote.objects[0].name = "not-an-archive.jsonl.gz".into();
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 2, 10);
        assert!(message(drain(&mut walk).await).contains("unsupported archive object name"));
    }

    #[tokio::test]
    async fn a_link_that_expires_is_replaced_and_the_walk_continues() {
        let remote = fake(2);
        *remote.expire_first_download.lock().unwrap() = true;
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 2, 10);
        assert_eq!(drain(&mut walk).await.unwrap(), vec![1, 2]);
    }

    #[tokio::test]
    async fn a_download_that_does_not_match_its_listing_is_refused() {
        let mut remote = fake(1);
        remote.corrupt = true;
        let mut walk = Walk::new(&remote, ARCHIVE, 0, 1, 10);
        assert!(message(drain(&mut walk).await).contains("verification"));
    }
}
