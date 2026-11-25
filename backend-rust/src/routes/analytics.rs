use axum::{routing::get, Json, Router};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/analytics", get(get_analytics))
        .route("/analytics/summary", get(get_summary))
}

async fn get_analytics() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_analytics".into()))
}

async fn get_summary() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_summary".into()))
}
