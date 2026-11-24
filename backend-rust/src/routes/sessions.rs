use axum::{
    extract::Path,
    routing::{delete, get, post},
    Json, Router,
};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/sessions", get(list_sessions))
        .route("/sessions", post(create_session))
        .route("/sessions/:id", get(get_session))
        .route("/sessions/:id", delete(delete_session))
}

async fn list_sessions() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("list_sessions".into()))
}

async fn create_session(Json(_body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("create_session".into()))
}

async fn get_session(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_session".into()))
}

async fn delete_session(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("delete_session".into()))
}
