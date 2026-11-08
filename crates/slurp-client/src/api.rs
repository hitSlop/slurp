//! The Worker's control API, defined once here (`docs/contracts.md`, "Control API").
//!
//! Every method is `POST /v1/rpc/<Name>` with a JSON body. The types below are the wire format and are exported to
//! `backend/src/api.gen.ts` with ts-rs: `cargo test -p slurp-client api_bindings` checks the file is current, and
//! `SLURP_UPDATE_BINDINGS=1` rewrites it. Optional fields are omitted when absent, never `null`.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use ts_rs::TS;

// ---- Errors ----------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidArgument,
    Unauthenticated,
    Forbidden,
    NotFound,
    AlreadyExists,
    Unavailable,
}

impl ErrorCode {
    /// The HTTP status that carries this code.
    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidArgument => 400,
            Self::Unauthenticated => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::AlreadyExists => 409,
            Self::Unavailable => 503,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

/// The body of every failed call: `{"error":{"code":"…","message":"…"}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApiErrorBody {
    pub error: ApiError,
}

// ---- Shared records --------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum KeyScope {
    Publishable,
    Secret,
}

/// What a token can do, as `Whoami` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum TokenScope {
    Admin,
    Secret,
    Publishable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ApiKey {
    pub key_id: String,
    pub project: String,
    pub scope: KeyScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
    // The key itself: always for a publishable key; for a secret key only in the CreateKey answer that made it (it is stored as a hash).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub provider: String,
    pub url: String,
    pub secret: String,
    pub sender: String,
    // Setup instructions to show the user, from the Worker's provider registry.
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Coverage {
    // The oldest retained sequence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<String>,
    // True while accepted events are not yet in an archive.
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub seq: u64,
    // Compressed bytes.
    pub size: u64,
    pub sha256: String,
    pub events: u64,
    pub created_at: String,
}

/// Archives that retention deleted before they were read: `from..=to`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub from: u64,
    pub to: u64,
}

// ---- Method requests and responses -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "Record<string, never>")]
pub struct WhoamiRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct WhoamiResponse {
    pub scope: TokenScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Idempotent by `name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct CreateProjectRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectResponse {
    pub project: ProjectInfo,
    pub created: bool,
    // A publishable key for source `default`.
    pub publishable_key: String,
    pub ingest_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetProjectRequest {
    // Id or name.
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetProjectResponse {
    pub project: ProjectInfo,
    pub ingest_url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "Record<string, never>")]
pub struct ListProjectsRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResponse {
    pub projects: Vec<ProjectInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceKeyRequest {
    pub project: String,
    pub source: String,
}

/// The source's oldest live publishable key, created if there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceKeyResponse {
    pub key: ApiKey,
}

/// A publishable key needs `source`; a secret key takes `name` (default `default`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct CreateKeyRequest {
    pub project: String,
    pub scope: KeyScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateKeyResponse {
    pub key: ApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ListKeysRequest {
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<KeyScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ListKeysResponse {
    pub keys: Vec<ApiKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevokeKeyRequest {
    pub project: String,
    pub key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevokeKeyResponse {
    pub key: ApiKey,
}

/// Idempotent. Stripe issues its own secret, so it is passed as `secret`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConnectWebhookRequest {
    pub project: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

/// Without `after`, the listing starts at `coverage.first`. `limit` is 1..=5000 (default 1000).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ListArchivesRequest {
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ListArchivesResponse {
    pub coverage: Coverage,
    pub archives: Vec<ArchiveInfo>,
    // Pass as `after` to continue; absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<Gap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublishResponse {
    pub coverage: Coverage,
}

// ---- Methods ---------------------------------------------------------------------------------------------------------

/// One control API method: its wire name and its request and response types.
pub trait Method {
    const NAME: &'static str;
    type Req: Serialize + TS + 'static;
    type Res: DeserializeOwned + TS + 'static;
}

/// Declares every method once. Generates the `Method` marker structs, `METHODS`, and the TypeScript `Api` map.
macro_rules! api {
    ($($name:ident($req:ty) -> $res:ty;)*) => {
        $(
            #[derive(Debug, Clone, Copy)]
            pub struct $name;
            impl Method for $name {
                const NAME: &'static str = stringify!($name);
                type Req = $req;
                type Res = $res;
            }
        )*

        /// Every method name, in declaration order.
        pub const METHODS: &[&str] = &[$(stringify!($name)),*];

        /// Visits every request and response type, so the bindings carry exactly what the methods use.
        fn visit_method_types(v: &mut impl ts_rs::TypeVisitor) {
            $( v.visit::<$req>(); v.visit::<$res>(); )*
        }

        /// The TypeScript method map: `Api[M]['req']` and `Api[M]['res']`.
        fn ts_method_map(cfg: &ts_rs::Config) -> String {
            let mut out = String::from("export type Api = {\n");
            $(
                out.push_str(&format!(
                    "  {}: {{ req: {}; res: {} }};\n",
                    stringify!($name),
                    <$req as TS>::name(cfg),
                    <$res as TS>::name(cfg),
                ));
            )*
            out.push_str("};\n");
            out
        }
    };
}

api! {
    Whoami(WhoamiRequest) -> WhoamiResponse;
    CreateProject(CreateProjectRequest) -> CreateProjectResponse;
    GetProject(GetProjectRequest) -> GetProjectResponse;
    ListProjects(ListProjectsRequest) -> ListProjectsResponse;
    SourceKey(SourceKeyRequest) -> SourceKeyResponse;
    CreateKey(CreateKeyRequest) -> CreateKeyResponse;
    ListKeys(ListKeysRequest) -> ListKeysResponse;
    RevokeKey(RevokeKeyRequest) -> RevokeKeyResponse;
    ConnectWebhook(ConnectWebhookRequest) -> Webhook;
    ListArchives(ListArchivesRequest) -> ListArchivesResponse;
    Publish(PublishRequest) -> PublishResponse;
}

// ---- Client ----------------------------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    // The Worker answered with a failure status. `code` is `None` when the body was not an API error.
    #[error("{} (HTTP {status})", message)]
    Api {
        status: u16,
        code: Option<ErrorCode>,
        message: String,
    },
    #[error("transport: {0}")]
    Transport(#[source] reqwest::Error),
    #[error("could not decode the response: {0}")]
    Decode(#[source] serde_json::Error),
}

/// Calls one control API method: `POST {base}/v1/rpc/{NAME}` with a bearer token.
///
/// # Errors
/// [`CallError::Api`] for a non-2xx answer, [`CallError::Transport`] when the request fails or the body cannot be read,
/// [`CallError::Decode`] when a 2xx body is not the method's response.
pub async fn call<M: Method>(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    req: &M::Req,
) -> Result<M::Res, CallError> {
    let url = format!("{}/v1/rpc/{}", base.trim_end_matches('/'), M::NAME);
    let response = http
        .post(url)
        .bearer_auth(token)
        .json(req)
        .send()
        .await
        .map_err(CallError::Transport)?;
    let status = response.status();
    let body = response.bytes().await.map_err(CallError::Transport)?;
    if status.is_success() {
        return serde_json::from_slice(&body).map_err(CallError::Decode);
    }
    Err(match serde_json::from_slice::<ApiErrorBody>(&body) {
        Ok(ApiErrorBody { error }) => CallError::Api {
            status: status.as_u16(),
            code: Some(error.code),
            message: error.message,
        },
        Err(_) => CallError::Api {
            status: status.as_u16(),
            code: None,
            message: String::from_utf8_lossy(&body).chars().take(200).collect(),
        },
    })
}

/// The path of one archive download (`GET` or `HEAD`, same bearer token as the RPC calls).
pub fn archive_path(project: &str, seq: u64) -> String {
    format!("/v1/projects/{project}/archives/{seq}")
}

// ---- TypeScript bindings ---------------------------------------------------------------------------------------------

const BINDINGS_HEADER: &str = "// Generated by `cargo test -p slurp-client api_bindings`; do not edit.\n\
// Source of truth: crates/slurp-client/src/api.rs. Regenerate with SLURP_UPDATE_BINDINGS=1.\n";

/// The text of `backend/src/api.gen.ts`: every type reachable from a method (and the error body), sorted by name, then `Api`.
pub fn typescript_bindings() -> String {
    use std::collections::BTreeMap;
    use ts_rs::{Config, TS, TypeVisitor};

    // Sequences, sizes and counts stay below 2^53, so they are plain JSON numbers.
    let cfg = Config::default().with_large_int("number");

    struct Collect<'a> {
        cfg: &'a Config,
        decls: BTreeMap<String, String>,
    }
    impl TypeVisitor for Collect<'_> {
        fn visit<T: TS + 'static + ?Sized>(&mut self) {
            if T::output_path().is_none() {
                return; // a primitive or a container: its parts are visited separately
            }
            if self
                .decls
                .insert(T::ident(self.cfg), T::decl(self.cfg))
                .is_none()
            {
                T::visit_dependencies(self);
            }
        }
    }

    let mut collect = Collect {
        cfg: &cfg,
        decls: BTreeMap::new(),
    };
    collect.visit::<ApiErrorBody>();
    visit_method_types(&mut collect);

    let mut out = String::from(BINDINGS_HEADER);
    for decl in collect.decls.values() {
        out.push_str("\nexport ");
        out.push_str(decl);
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&ts_method_map(&cfg));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn api_bindings() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/src/api.gen.ts");
        let generated = typescript_bindings();
        if std::env::var_os("SLURP_UPDATE_BINDINGS").is_some_and(|v| v == "1") {
            std::fs::write(&path, &generated).expect("write api.gen.ts");
            return;
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            on_disk == generated,
            "backend/src/api.gen.ts is stale: run `SLURP_UPDATE_BINDINGS=1 cargo test -p slurp-client api_bindings`"
        );
    }

    #[test]
    fn wire_shape() {
        let key = ApiKey {
            key_id: "k1".into(),
            project: "prj_0123456789abcdef".into(),
            scope: KeyScope::Secret,
            source: None,
            name: Some("ci".into()),
            created_at: "2026-11-07T12:00:00.000Z".into(),
            revoked_at: None,
            key: None,
        };
        assert_eq!(
            serde_json::to_string(&key).unwrap(),
            r#"{"keyId":"k1","project":"prj_0123456789abcdef","scope":"secret","name":"ci","createdAt":"2026-11-07T12:00:00.000Z"}"#
        );
        assert_eq!(serde_json::to_string(&WhoamiRequest {}).unwrap(), "{}");
        let body: ApiErrorBody =
            serde_json::from_str(r#"{"error":{"code":"already_exists","message":"x"}}"#).unwrap();
        assert_eq!(body.error.code, ErrorCode::AlreadyExists);
        assert_eq!(body.error.code.status(), 409);
        assert_eq!(METHODS.len(), 11);
        assert_eq!(archive_path("prj_a", 7), "/v1/projects/prj_a/archives/7");
    }
}
