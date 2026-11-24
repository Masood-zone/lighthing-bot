pub mod administrators;
pub mod analytics;
pub mod auth;
pub mod health;
pub mod notifications;
pub mod queue;
pub mod sessions;
pub mod users;

use axum::Router;

/// Combines all route modules under /api
pub fn all_routes() -> Router {
    Router::new()
        .merge(health::router())
        .merge(auth::router())
        .merge(users::router())
        .merge(administrators::router())
        .merge(analytics::router())
        .merge(notifications::router())
        .merge(queue::router())
        .merge(sessions::router())
}
