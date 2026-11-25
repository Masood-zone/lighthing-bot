use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/refresh", post(refresh_token))
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
}

async fn login(Json(body): Json<LoginRequest>) -> Result<Json<LoginResponse>, AppError> {
    // TODO: validate credentials against admin store / bcrypt
    tracing::info!("Login attempt for user: {}", body.username);
    Err(AppError::NotImplemented("login".into()))
}

async fn logout() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("logout".into()))
}

async fn refresh_token() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented("refresh_token".into()))
}
