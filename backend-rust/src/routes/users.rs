use axum::{
    extract::Path,
    routing::{delete, get, post, put},
    Json, Router,
};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/users", get(list_users))
        .route("/users", post(create_user))
        .route("/users/:id", get(get_user))
        .route("/users/:id", put(update_user))
        .route("/users/:id", delete(delete_user))
}

async fn list_users() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("list_users".into()))
}

async fn create_user(Json(_body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("create_user".into()))
}

async fn get_user(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_user".into()))
}

async fn update_user(
    Path(_id): Path<String>,
    Json(_body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("update_user".into()))
}

async fn delete_user(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("delete_user".into()))
}
