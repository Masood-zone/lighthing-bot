const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { hashPassword } = require("../security/passwordHash");

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

class UserStore {
  /**
   * @param {{ dataDir: string }} opts
   */
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(this.dataDir, "users.json");
    this.state = { users: {} };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = safeJsonParse(raw, { users: {} });
      if (parsed && typeof parsed === "object" && parsed.users) {
        this.state = parsed;
      }
    } catch {
      // ignore
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  listUsers() {
    return Object.values(this.state.users).sort((a, b) => {
      const ta = Date.parse(a.createdAt || "") || 0;
      const tb = Date.parse(b.createdAt || "") || 0;
      return tb - ta;
    });
  }

  getUser(id) {
    return this.state.users[id] || null;
  }

  getByEmail(email) {
    const needle = normalizeEmail(email);
    if (!needle) return null;
    return (
      Object.values(this.state.users).find(
        (u) => normalizeEmail(u.email) === needle,
      ) || null
    );
  }

  upsertUser(user) {
    this.state.users[user.id] = user;
    this._save();
    return user;
  }

  createUser({ email, password, role = "ADMIN" }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      const err = new Error("email_required");
      err.code = "EMAIL_REQUIRED";
      throw err;
    }
    if (!password || typeof password !== "string") {
      const err = new Error("password_required");
      err.code = "PASSWORD_REQUIRED";
      throw err;
    }
    if (this.getByEmail(normalizedEmail)) {
      const err = new Error("email_taken");
      err.code = "EMAIL_TAKEN";
      throw err;
    }

    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : crypto.randomUUID();

    const user = {
      id,
      email: normalizedEmail,
      role,
      passwordHash: hashPassword(password),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    return this.upsertUser(user);
  }

  hasAdmin() {
    return this.listUsers().some((u) => u.role === "ADMIN");
  }

  ensureAdminFromEnv() {
    if (this.hasAdmin()) return { created: false };

    const envEmail = process.env.ADMIN_EMAIL;
    const envPassword = process.env.ADMIN_PASSWORD;

    if (envEmail && envPassword) {
      const user = this.createUser({
        email: envEmail,
        password: envPassword,
        role: "ADMIN",
      });
      return { created: true, user, via: "env" };
    }

    // Dev-friendly fallback: create a local admin and print the password once.
    if ((process.env.NODE_ENV || "development") !== "production") {
      const password = crypto.randomBytes(18).toString("base64url");
      const user = this.createUser({
        email: "admin@local",
        password,
        role: "ADMIN",
      });
      return {
        created: true,
        user,
        via: "generated",
        generatedPassword: password,
      };
    }

    return { created: false, warning: "ADMIN_EMAIL/ADMIN_PASSWORD not set" };
  }
}

module.exports = { UserStore };
