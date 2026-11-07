use anyhow::{Result, bail};
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    time::{Duration, Instant},
};

pub(crate) async fn acquire(path: PathBuf) -> Result<File> {
    tokio::task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let started = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(error) if error.kind() == fs2::lock_contended_error().kind() => {
                    if started.elapsed() > Duration::from_secs(30) {
                        bail!("another process is updating this resource");
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error.into()),
            }
        }
    })
    .await?
}
