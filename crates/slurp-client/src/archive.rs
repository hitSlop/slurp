use anyhow::{Result, bail};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub use crate::sync_types::Coverage;

/// Archive formats this client can read. Hosted archives are `jsonl.zst`; self-hosted Cloudflare archives are `jsonl.gz`
/// (Workers have native gzip but no zstd).
pub fn is_jsonl(ext: &str) -> bool {
    matches!(ext, "jsonl.zst" | "jsonl.gz")
}

/// Open an archive file for reading, decompressing by its format.
///
/// The format is read from the file's magic bytes (gzip `1f 8b`, zstd `28 b5 2f fd`), so it does not depend on the
/// file name; the name is only a fallback for an empty or unrecognized file.
///
/// # Errors
/// Returns an error if the file cannot be opened or is not a supported archive format.
pub fn open_jsonl(path: &Path) -> Result<Box<dyn Read>> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut file = File::open(path)?;
    let mut magic = [0u8; 4];
    let read = file.read(&mut magic)?;
    file.seek(SeekFrom::Start(0))?;
    let is_gzip = read >= 2 && magic[..2] == [0x1f, 0x8b];
    let is_zstd = read >= 4 && magic == [0x28, 0xb5, 0x2f, 0xfd];
    if is_gzip || (!is_zstd && name.ends_with(".jsonl.gz")) {
        Ok(Box::new(flate2::read::MultiGzDecoder::new(file)))
    } else if is_zstd || name.ends_with(".jsonl.zst") {
        Ok(Box::new(zstd::stream::read::Decoder::new(file)?))
    } else {
        bail!("unsupported archive format: {name}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub sequence: i64,
    pub sha256: String,
    pub ext: &'static str,
    pub name: String,
}

pub fn parse_key(name: &str) -> Option<Key> {
    let (seq, rest) = name.split_once('-')?;
    let (sha, ext) = rest.split_once('.')?;
    let ext = match ext {
        "jsonl.zst" => "jsonl.zst",
        "jsonl.gz" => "jsonl.gz",
        "parquet" => "parquet",
        _ => return None,
    };
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
        ext,
        name: name.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn open_jsonl_reads_zstd_and_gzip_by_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let text = b"{\"id\":\"a\"}\n{\"id\":\"b\"}\n";
        let zst = dir.path().join("object.jsonl.zst");
        std::fs::write(&zst, zstd::encode_all(&text[..], 3).unwrap()).unwrap();
        let gz = dir.path().join("object.jsonl.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text).unwrap();
        std::fs::write(&gz, encoder.finish().unwrap()).unwrap();
        for path in [zst, gz] {
            let mut out = Vec::new();
            open_jsonl(&path).unwrap().read_to_end(&mut out).unwrap();
            assert_eq!(out, text, "{}", path.display());
        }
        // The format comes from the bytes, not the name.
        for (name, bytes) in [
            (
                ".tmpAbC123",
                std::fs::read(dir.path().join("object.jsonl.zst")).unwrap(),
            ),
            (
                "events",
                std::fs::read(dir.path().join("object.jsonl.gz")).unwrap(),
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let mut out = Vec::new();
            open_jsonl(&path).unwrap().read_to_end(&mut out).unwrap();
            assert_eq!(out, text, "{name}");
        }
        let other = dir.path().join("object.parquet");
        std::fs::write(&other, b"x").unwrap();
        assert!(open_jsonl(&other).is_err());
        assert!(is_jsonl("jsonl.gz") && is_jsonl("jsonl.zst") && !is_jsonl("parquet"));
    }

    #[test]
    fn parse_key_accepts_gzip_archive_names() {
        let sha = "a".repeat(64);
        let key = parse_key(&format!("{:020}-{sha}.jsonl.gz", 7)).unwrap();
        assert_eq!((key.sequence, key.ext), (7, "jsonl.gz"));
    }
}
