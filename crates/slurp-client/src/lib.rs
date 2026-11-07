//! Service protocol client. No library, daemon or analysis engine is required.
//! Authentication and durable folder synchronization build on this transport boundary.
#[path = "slurp.gen.rs"]
pub mod rpc;

pub mod auth;

mod http;
pub use http::http_client;

mod archive;
pub use archive::{Coverage, Key, is_jsonl, open_jsonl, parse_key};
pub mod protocol;
pub mod remote;
pub use rpc::{ArchiveObject as ListedObject, ListObjectsResponse as ListPage};

pub use remote::{DirRemote, HttpRemote, Remote, RemoteCounts, RemoteError, download_verified};

pub mod folder;
mod locking;

pub use reqwest;

pub mod config;
pub mod storage;

pub mod reader;
pub mod source;

pub mod publication;
mod sync_types;
