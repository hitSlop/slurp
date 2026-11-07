//! Service protocol client. No library, daemon or analysis engine is required.
//! The saved Worker connection (`connection`) builds on this transport boundary.
#[path = "slurp.gen.rs"]
pub mod rpc;

pub mod connection;

mod http;
pub use http::http_client;

mod archive;
pub use archive::{Coverage, Key, open_jsonl, parse_key};
pub mod protocol;
pub mod remote;
pub use rpc::{ArchiveObject as ListedObject, ListObjectsResponse as ListPage};

pub use remote::{HttpRemote, Remote, RemoteError, download_verified};

pub use reqwest;

pub mod config;
pub mod files;
pub mod storage;

pub mod reader;
pub mod walk;

pub mod publication;
mod sync_types;
