use axum::{routing::{get, post}, Json, Router};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/notifications", get(list_notifications))
        .route("/notifications/send", post(send_notification))
}

async fn list_notifications() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("list_notifications".into()))
}

async fn send_notification(Json(_body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("send_notification".into()))
}
