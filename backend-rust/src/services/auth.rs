// Auth service — JWT creation/verification, bcrypt password checks

use anyhow::Result;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,   // admin id
    pub role: String,
    pub exp: usize,    // expiry (Unix timestamp)
}

pub fn create_token(admin_id: &str, role: &str, secret: &str) -> Result<String> {
    let expiry = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::hours(8))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: admin_id.to_owned(),
        role: role.to_owned(),
        exp: expiry,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;

    Ok(token)
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
}

pub fn hash_password(password: &str) -> Result<String> {
    Ok(bcrypt::hash(password, bcrypt::DEFAULT_COST)?)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    Ok(bcrypt::verify(password, hash)?)
}
