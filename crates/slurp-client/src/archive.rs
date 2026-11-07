use anyhow::{Result, bail};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub use crate::sync_types::Coverage;

/// Open an archive file for reading. Archives are gzip NDJSON (`.jsonl.gz`): Workers compress gzip natively.
///
/// # Errors
/// Returns an error if the file cannot be opened or is not gzip.
pub fn open_jsonl(path: &Path) -> Result<Box<dyn Read>> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 2];
    let read = file.read(&mut magic)?;
    file.seek(SeekFrom::Start(0))?;
    if read < 2 || magic != [0x1f, 0x8b] {
        bail!("unsupported archive format: archives are gzip (.jsonl.gz)");
    }
    Ok(Box::new(flate2::read::MultiGzDecoder::new(file)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub sequence: i64,
    pub sha256: String,
    pub name: String,
}

pub fn parse_key(name: &str) -> Option<Key> {
    let (seq, rest) = name.split_once('-')?;
    let (sha, ext) = rest.split_once('.')?;
    if ext != "jsonl.gz" {
        return None;
    }
    let valid_sha = sha.len() == 64 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if seq.len() != 20 || !seq.bytes().all(|b| b.is_ascii_digit()) || !valid_sha {
        return None;
    }
    let sequence = seq.parse().ok()?;
    if sequence < 1 {
        return None;
    }
    Some(Key {
        sequence,
        sha256: sha.into(),
        name: name.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn open_jsonl_reads_gzip_by_its_bytes_and_refuses_anything_else() {
        let dir = tempfile::tempdir().unwrap();
        let text = b"{\"id\":\"a\"}\n{\"id\":\"b\"}\n";
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text).unwrap();
        let gz = encoder.finish().unwrap();
        // The format comes from the bytes, not the name (downloads are staged under temporary names).
        for name in ["object.jsonl.gz", ".tmpAbC123", "events"] {
            let path = dir.path().join(name);
            std::fs::write(&path, &gz).unwrap();
            let mut out = Vec::new();
            open_jsonl(&path).unwrap().read_to_end(&mut out).unwrap();
            assert_eq!(out, text, "{name}");
        }
        let other = dir.path().join("object.jsonl.zst");
        std::fs::write(&other, b"\x28\xb5\x2f\xfdnot gzip").unwrap();
        assert!(open_jsonl(&other).is_err());
        let empty = dir.path().join("empty");
        std::fs::write(&empty, b"").unwrap();
        assert!(open_jsonl(&empty).is_err());
    }

    #[test]
    fn parse_key_accepts_only_gzip_archive_names() {
        let sha = "a".repeat(64);
        let key = parse_key(&format!("{:020}-{sha}.jsonl.gz", 7)).unwrap();
        assert_eq!(key.sequence, 7);
        for other in ["jsonl.zst", "parquet", "jsonl"] {
            assert!(
                parse_key(&format!("{:020}-{sha}.{other}", 7)).is_none(),
                "{other}"
            );
        }
        assert!(parse_key(&format!("{:020}-{sha}.jsonl.gz", 0)).is_none());
    }
}
