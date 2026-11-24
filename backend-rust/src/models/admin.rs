use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Admin {
    pub id: String,
    pub username: String,
    pub email: String,
    pub role: AdminRole,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AdminRole {
    SuperAdmin,
    Admin,
    Viewer,
}
