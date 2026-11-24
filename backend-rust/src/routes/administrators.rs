use axum::{
    extract::Path,
    routing::{delete, get, post, put},
    Json, Router,
};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/administrators", get(list_admins))
        .route("/administrators", post(create_admin))
        .route("/administrators/:id", get(get_admin))
        .route("/administrators/:id", put(update_admin))
        .route("/administrators/:id", delete(delete_admin))
}

async fn list_admins() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("list_admins".into()))
}

async fn create_admin(Json(_body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("create_admin".into()))
}

async fn get_admin(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("get_admin".into()))
}

async fn update_admin(
    Path(_id): Path<String>,
    Json(_body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("update_admin".into()))
}

async fn delete_admin(Path(_id): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("delete_admin".into()))
}
