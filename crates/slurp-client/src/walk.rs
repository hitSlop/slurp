//! Walk a project's published archives in order, downloading and verifying each one.
//!
//! `slurp sync` (into DuckDB) and `slurp read` (to stdout) both consume archives this way: list a page, check the sequence has
//! no hole, then download with size and SHA-256 verification. What each consumer then does with a verified archive, and what
//! counts as progress, is its own decision: the database commits a receipt, a reader prints.
//!
//! Archives that retention deleted before they were read come back as [`Step::Gap`] (the Worker reports them with the listing),
//! and the walk goes on after them. Anything else that is missing is an error.
use crate::{Remote, api, download_verified};
use anyhow::{Result, bail};
use std::{collections::VecDeque, path::PathBuf};

/// The archive envelope format this version reads (`ArchiveInfo.format`). A format only ever gains fields, so a different
/// number means an incompatible change, and the archive is refused before it is downloaded.
const ARCHIVE_FORMAT: u32 = 1;

/// One archive, downloaded and verified, in a directory that is removed when this value is dropped.
pub struct Downloaded {
    pub sequence: u64,
    pub archive: api::ArchiveInfo,
    pub path: PathBuf,
    _directory: tempfile::TempDir,
}

/// What a walk produces next.
pub enum Step {
    /// Archives `from..=to` were deleted by retention before they were read.
    Gap(api::Gap),
    Archive(Downloaded),
}

enum Queued {
    Gap(api::Gap),
    Archive(api::ArchiveInfo),
}

/// A cursor over the archives after `after`, up to the newest one published when the walk first listed.
///
/// The head is captured once, from the first listing. Archives published while the walk runs are left for the next walk, even
/// when a later page lists them.
pub struct Walk<'a> {
    remote: &'a dyn Remote,
    after: Option<u64>,
    head: Option<u64>,
    page_size: u32,
    queue: VecDeque<Queued>,
    coverage: Option<api::Coverage>,
}

impl<'a> Walk<'a> {
    /// `after` is the last sequence already taken; `None` starts at the oldest retained archive (and reports no gap).
    pub fn new(remote: &'a dyn Remote, after: Option<u64>, page_size: u32) -> Self {
        Self {
            remote,
            after,
            head: None,
            page_size,
            queue: VecDeque::new(),
            coverage: None,
        }
    }

    /// The last sequence this walk has gone past (an archive, or the end of a gap); the starting `after` before the first.
    pub fn position(&self) -> Option<u64> {
        self.after
    }

    /// The coverage of the most recent listing (known after the first call to [`Walk::next`]).
    pub fn coverage(&self) -> Option<&api::Coverage> {
        self.coverage.as_ref()
    }

    /// The next gap or archive, downloaded into a directory made by `scratch`, or `None` after the head.
    ///
    /// # Errors
    /// Returns an error for a hole in the sequence, an unreadable listing, a download that fails verification, or a
    /// transport failure.
    pub async fn next(
        &mut self,
        mut scratch: impl FnMut() -> Result<tempfile::TempDir>,
    ) -> Result<Option<Step>> {
        loop {
            if self
                .head
                .zip(self.after)
                .is_some_and(|(head, after)| after >= head)
            {
                return Ok(None);
            }
            let Some(item) = self.queue.pop_front() else {
                self.list_page().await?;
                continue;
            };
            let archive = match item {
                Queued::Gap(gap) => {
                    self.after = Some(gap.to);
                    return Ok(Some(Step::Gap(gap)));
                }
                Queued::Archive(archive) => archive,
            };
            let expected = self.after.map_or(1, |after| after + 1);
            if archive.seq != expected {
                bail!(
                    "publication gap; expected archive {expected}, the Worker listed {}",
                    archive.seq
                );
            }
            if archive.format != ARCHIVE_FORMAT {
                bail!(
                    "archive {} uses format {}, which this version of Slurp can't read; upgrade slurp",
                    archive.seq,
                    archive.format
                );
            }
            let directory = scratch()?;
            let path = directory.path().join("events.jsonl.gz");
            download_verified(self.remote, &archive, &path).await?;
            self.after = Some(archive.seq);
            return Ok(Some(Step::Archive(Downloaded {
                sequence: archive.seq,
                archive,
                path,
                _directory: directory,
            })));
        }
    }

    /// List the next page and queue what it holds.
    async fn list_page(&mut self) -> Result<()> {
        let page = self.remote.list(self.after, self.page_size).await?;
        // The head is fixed by the first listing. Later pages never raise it, so a busy stream cannot keep a sync running.
        let head = *self.head.get_or_insert(page.coverage.last.unwrap_or(0));
        // A fresh walk starts at the oldest retained archive: nothing before it was ever expected.
        let after = *self
            .after
            .get_or_insert_with(|| page.coverage.first.map_or(0, |first| first - 1));
        self.coverage = Some(page.coverage);
        if page.gap.is_none() && page.archives.is_empty() {
            if after >= head {
                return Ok(());
            }
            bail!("publication gap: nothing listed after archive {after}");
        }
        if let Some(gap) = page.gap {
            self.queue.push_back(Queued::Gap(gap));
        }
        self.queue
            .extend(page.archives.into_iter().map(Queued::Archive));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RemoteError;
    use sha2::{Digest, Sha256};
    use std::path::Path;

    struct Fake {
        /// When set, `coverage.last` is this on the first call to `list` and one higher on every later call, as if archives
        /// were published meanwhile (the archives themselves are all listed).
        growing_head: Option<(u64, std::sync::atomic::AtomicU64)>,
        /// (info, body) for every archive still on the Worker, in order.
        archives: Vec<(api::ArchiveInfo, Vec<u8>)>,
        corrupt: bool,
        missing_on_download: Option<u64>,
        downloads: std::sync::atomic::AtomicUsize,
    }
    fn archive(seq: u64) -> (api::ArchiveInfo, Vec<u8>) {
        let body = format!("body {seq}").into_bytes();
        (
            api::ArchiveInfo {
                seq,
                size: body.len() as u64,
                sha256: hex::encode(Sha256::digest(&body)),
                events: 1,
                created_at: "2026-11-07T12:00:00.000Z".into(),
                format: 1,
            },
            body,
        )
    }
    /// Archives `first..=last` are retained.
    fn fake(first: u64, last: u64) -> Fake {
        Fake {
            growing_head: None,
            archives: (first..=last).map(archive).collect(),
            corrupt: false,
            missing_on_download: None,
            downloads: std::sync::atomic::AtomicUsize::new(0),
        }
    }
    #[async_trait::async_trait]
    impl Remote for Fake {
        async fn list(
            &self,
            after: Option<u64>,
            limit: u32,
        ) -> Result<api::ListArchivesResponse, RemoteError> {
            let first = self.archives.first().map(|(a, _)| a.seq);
            let last = self.archives.last().map(|(a, _)| a.seq);
            let last = match &self.growing_head {
                Some((head, calls)) => {
                    Some(head + calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
                }
                None => last,
            };
            let start = after.unwrap_or(first.unwrap_or(1).saturating_sub(1));
            let gap = first
                .filter(|first| after.is_some_and(|after| after + 1 < *first))
                .map(|first| api::Gap {
                    from: after.unwrap() + 1,
                    to: first - 1,
                });
            let page: Vec<_> = self
                .archives
                .iter()
                .filter(|(a, _)| a.seq > start)
                .take(limit as usize)
                .map(|(a, _)| a.clone())
                .collect();
            Ok(api::ListArchivesResponse {
                coverage: api::Coverage {
                    first,
                    last,
                    last_at: None,
                    pending: false,
                },
                next: page.last().map(|a| a.seq).filter(|seq| Some(*seq) != last),
                archives: page,
                gap,
            })
        }
        async fn download(
            &self,
            archive: &api::ArchiveInfo,
            dest: &Path,
        ) -> Result<(String, u64), RemoteError> {
            self.downloads
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.missing_on_download == Some(archive.seq) {
                return Err(RemoteError::ArchiveMissing(archive.seq));
            }
            let (_, body) = self
                .archives
                .iter()
                .find(|(a, _)| a.seq == archive.seq)
                .ok_or(RemoteError::ArchiveMissing(archive.seq))?;
            let mut body = body.clone();
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
    /// Every step as text: `gap 1-3` or `archive 5`.
    async fn drain(walk: &mut Walk<'_>) -> Result<Vec<String>> {
        let mut seen = vec![];
        while let Some(step) = walk.next(scratch).await? {
            match step {
                Step::Gap(gap) => seen.push(format!("gap {}-{}", gap.from, gap.to)),
                Step::Archive(archive) => {
                    assert_eq!(
                        std::fs::read(&archive.path)?,
                        format!("body {}", archive.sequence).into_bytes()
                    );
                    seen.push(format!("archive {}", archive.sequence));
                }
            }
        }
        Ok(seen)
    }
    fn message(result: Result<Vec<String>>) -> String {
        result.expect_err("expected a failure").to_string()
    }

    #[tokio::test]
    async fn archives_come_in_order_across_pages_and_stop_at_the_head() {
        let remote = fake(1, 5);
        let mut walk = Walk::new(&remote, None, 2);
        assert_eq!(
            drain(&mut walk).await.unwrap(),
            [
                "archive 1",
                "archive 2",
                "archive 3",
                "archive 4",
                "archive 5"
            ]
        );
        assert_eq!(walk.position(), Some(5));
        assert_eq!(walk.coverage().and_then(|c| c.last), Some(5));
        // Starting later bounds the walk from below; a caught-up walk lists once and ends.
        let mut walk = Walk::new(&remote, Some(2), 100);
        assert_eq!(
            drain(&mut walk).await.unwrap(),
            ["archive 3", "archive 4", "archive 5"]
        );
        let mut walk = Walk::new(&remote, Some(5), 100);
        assert!(drain(&mut walk).await.unwrap().is_empty());
        assert!(walk.coverage().is_some());
    }

    #[tokio::test]
    async fn nothing_published_ends_the_walk() {
        let remote = fake(1, 0);
        let mut walk = Walk::new(&remote, None, 10);
        assert!(drain(&mut walk).await.unwrap().is_empty());
        assert_eq!(walk.coverage().and_then(|c| c.last), None);
    }

    #[tokio::test]
    async fn a_fresh_walk_starts_at_the_oldest_retained_archive_without_a_gap() {
        let remote = fake(4, 6);
        let mut walk = Walk::new(&remote, None, 10);
        assert_eq!(
            drain(&mut walk).await.unwrap(),
            ["archive 4", "archive 5", "archive 6"]
        );
    }

    #[tokio::test]
    async fn archives_deleted_by_retention_are_a_gap_and_the_walk_continues() {
        let remote = fake(4, 6);
        let mut walk = Walk::new(&remote, Some(1), 10);
        assert_eq!(
            drain(&mut walk).await.unwrap(),
            ["gap 2-3", "archive 4", "archive 5", "archive 6"]
        );
        assert_eq!(walk.position(), Some(6));
    }

    #[tokio::test]
    async fn a_hole_in_the_sequence_is_a_publication_gap() {
        let mut remote = fake(1, 4);
        remote.archives.remove(1); // 1, 3, 4
        let mut walk = Walk::new(&remote, None, 10);
        assert!(message(drain(&mut walk).await).contains("publication gap; expected archive 2"));
    }

    #[tokio::test]
    async fn a_missing_archive_is_fatal_and_names_its_sequence() {
        let mut remote = fake(1, 3);
        remote.missing_on_download = Some(2);
        let mut walk = Walk::new(&remote, None, 10);
        assert!(message(drain(&mut walk).await).contains("archive 2 is listed"));
    }

    #[tokio::test]
    async fn a_download_that_does_not_match_its_listing_is_refused() {
        let mut remote = fake(1, 1);
        remote.corrupt = true;
        let mut walk = Walk::new(&remote, None, 10);
        assert!(message(drain(&mut walk).await).contains("verification"));
    }

    #[tokio::test]
    async fn the_walk_ends_at_the_head_it_first_saw_even_as_newer_archives_are_published() {
        let mut remote = fake(1, 10);
        remote.growing_head = Some((3, std::sync::atomic::AtomicU64::new(0)));
        let mut walk = Walk::new(&remote, None, 2);
        assert_eq!(
            drain(&mut walk).await.unwrap(),
            ["archive 1", "archive 2", "archive 3"]
        );
        assert_eq!(walk.position(), Some(3));
    }

    #[tokio::test]
    async fn an_archive_in_an_unknown_format_is_refused_before_any_download() {
        let mut remote = fake(1, 1);
        remote.archives[0].0.format = 2;
        let mut walk = Walk::new(&remote, None, 10);
        let error = message(drain(&mut walk).await);
        assert!(
            error.contains("archive 1 uses format 2")
                && error.contains("can't read")
                && error.contains("upgrade slurp"),
            "{error}"
        );
        assert_eq!(
            remote.downloads.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "nothing was downloaded"
        );
    }
}
