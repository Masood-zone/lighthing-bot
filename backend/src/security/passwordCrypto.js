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

function encryptSecret(plaintext) {
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
    enc: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptSecret({ enc, iv, tag, missingMessage }) {
  const secret = assertSecretConfigured();
  const key = deriveKeyFromSecret(secret);

  if (!enc || !iv || !tag) {
    const err = new Error(missingMessage || "Encrypted fields are missing.");
    err.code = "PASSWORD_ENC_MISSING";
    throw err;
  }

  const ivBuf = Buffer.from(String(iv), "base64");
  const tagBuf = Buffer.from(String(tag), "base64");
  const ciphertext = Buffer.from(String(enc), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tagBuf);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function encryptPassword(plaintext) {
  const secret = encryptSecret(plaintext);
  return {
    passwordEnc: secret.enc,
    passwordIv: secret.iv,
    passwordTag: secret.tag,
  };
}

function decryptPassword(config) {
  return decryptSecret({
    enc: config?.passwordEnc,
    iv: config?.passwordIv,
    tag: config?.passwordTag,
    missingMessage: "Encrypted password fields are missing.",
  });
}

function encryptProxyUrl(plaintext) {
  const secret = encryptSecret(plaintext);
  return {
    proxyUrlEnc: secret.enc,
    proxyUrlIv: secret.iv,
    proxyUrlTag: secret.tag,
  };
}

function decryptProxyUrl(config) {
  return decryptSecret({
    enc: config?.proxyUrlEnc,
    iv: config?.proxyUrlIv,
    tag: config?.proxyUrlTag,
    missingMessage: "Encrypted proxy fields are missing.",
  });
}

function isSecretConfigured() {
  return Boolean(getSecretKey());
}

module.exports = {
  encryptPassword,
  decryptPassword,
  encryptProxyUrl,
  decryptProxyUrl,
  isSecretConfigured,
};
