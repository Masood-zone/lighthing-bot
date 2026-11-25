use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn router() -> Router {
    Router::new().route("/health", get(handler))
}

async fn handler() -> Json<Value> {
    Json(json!({ "status": "ok", "runtime": "rust" }))
}
