const crypto = require("node:crypto");

class AuthService {
  /**
   * @param {{ tokenTtlMs?: number }} opts
   */
  constructor({ tokenTtlMs } = {}) {
    this.tokenTtlMs = Number(tokenTtlMs || 1000 * 60 * 60 * 12); // 12h
    this.tokens = new Map(); // token -> { userId, expiresAt }
  }

  issueToken(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.tokenTtlMs;
    this.tokens.set(token, { userId, expiresAt });
    return { token, expiresAt };
  }

  authenticate(token) {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return rec;
  }

  revoke(token) {
    if (!token) return false;
    return this.tokens.delete(token);
  }
}

module.exports = { AuthService };
