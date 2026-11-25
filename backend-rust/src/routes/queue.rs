use axum::{
    extract::Path,
    routing::{delete, get, post},
    Json, Router,
};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/queue", get(get_queue))
        .route("/queue", post(enqueue))
        .route("/queue/:id", delete(dequeue))
}

async fn get_queue() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_queue".into()))
}

async fn enqueue(Json(_body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("enqueue".into()))
}

async fn dequeue(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("dequeue".into()))
}
