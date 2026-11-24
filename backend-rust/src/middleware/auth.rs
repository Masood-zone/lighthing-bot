// JWT auth middleware — to be wired into protected routes
// Uses jsonwebtoken crate for verification

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};

pub async fn require_auth(request: Request, next: Next) -> Result<Response, StatusCode> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    match token {
        Some(_token) => {
            // TODO: verify JWT signature and expiry
            Ok(next.run(request).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}
