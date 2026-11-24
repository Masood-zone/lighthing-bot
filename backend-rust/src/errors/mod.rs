use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Not implemented: {0}")]
    NotImplemented(String),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Forbidden")]
    Forbidden,

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotImplemented(name) => (
                StatusCode::NOT_IMPLEMENTED,
                format!("Not yet implemented: {name}"),
            ),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".into()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".into()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Internal(e) => {
                tracing::error!("Internal error: {e:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
        };

        (status, Json(json!({ "error": message }))).into_response()
    }
}
