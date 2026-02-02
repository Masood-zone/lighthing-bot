const crypto = require("node:crypto");

function deriveKeyFromSecret(secret) {
  // Deterministic 32-byte key; keep simple and dependency-free.
  // Operators should supply a high-entropy VISA_SECRET_KEY.
  return crypto.createHash("sha256").update(String(secret), "utf8").digest();
}

function getSecretKey() {
  return process.env.VISA_SECRET_KEY || "";
}

function assertSecretConfigured() {
  const secret = getSecretKey();
  if (!secret) {
    const err = new Error(
      "VISA_SECRET_KEY is not configured. Set a strong secret in env to enable password encryption.",
    );
    err.code = "SECRET_KEY_MISSING";
    throw err;
  }
  return secret;
}

function encryptPassword(plaintext) {
  const secret = assertSecretConfigured();
  const key = deriveKeyFromSecret(secret);

  const iv = crypto.randomBytes(12); // recommended size for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    passwordEnc: ciphertext.toString("base64"),
    passwordIv: iv.toString("base64"),
    passwordTag: tag.toString("base64"),
  };
}

function decryptPassword(config) {
  const secret = assertSecretConfigured();
  const key = deriveKeyFromSecret(secret);

  const enc = config?.passwordEnc;
  const ivB64 = config?.passwordIv;
  const tagB64 = config?.passwordTag;
  if (!enc || !ivB64 || !tagB64) {
    const err = new Error("Encrypted password fields are missing.");
    err.code = "PASSWORD_ENC_MISSING";
    throw err;
  }

  const iv = Buffer.from(String(ivB64), "base64");
  const tag = Buffer.from(String(tagB64), "base64");
  const ciphertext = Buffer.from(String(enc), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function isSecretConfigured() {
  return Boolean(getSecretKey());
}

module.exports = {
  encryptPassword,
  decryptPassword,
  isSecretConfigured,
};
