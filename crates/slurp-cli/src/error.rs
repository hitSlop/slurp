//! Serializable failures shared by command and future desktop adapters.
use serde::Serialize;
/// Stable machine-readable failure categories.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    Io,
    QueryFailed,
    QueryTimeout,
    Cancelled,
    DeliveryConflict,
    ConflictingEventId,
    RetentionGap,
    Busy,
    WorkspaceUnavailable,
    StorageUnavailable,
    BindingMismatch,
    SetupRequired,
}
/// An actionable failure, optionally wrapped with application context.
#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
}
impl Failure {
    /// Construct an application boundary failure.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    /// Preserve typed codes through anyhow context; classify untyped input/I/O errors.
    pub fn from_error(error: &anyhow::Error) -> Self {
        Self {
            code: error
                .downcast_ref::<Self>()
                .map(|e| e.code)
                .unwrap_or_else(|| {
                    if error.downcast_ref::<std::io::Error>().is_some() {
                        ErrorCode::Io
                    } else {
                        ErrorCode::InvalidInput
                    }
                }),
            message: error.to_string(),
        }
    }
}
