const crypto = require("node:crypto");

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(plaintext) {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("password_required");
  }

  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plaintext, salt, 64);

  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(plaintext, stored) {
  if (!plaintext || typeof plaintext !== "string") return false;
  if (!stored || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [scheme, saltB64, keyB64] = parts;
  if (scheme !== "scrypt") return false;

  const salt = Buffer.from(saltB64, "base64");
  const expectedKey = Buffer.from(keyB64, "base64");

  const actualKey = crypto.scryptSync(plaintext, salt, expectedKey.length);
  return timingSafeEqual(actualKey, expectedKey);
}

module.exports = {
  hashPassword,
  verifyPassword,
};
