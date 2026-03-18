const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isTransientFsError(err) {
  const code = String(err?.code || "");
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

class AdminRecipientStore {
  /**
   * @param {{ dataDir: string, seedFilePath?: string }} opts
   */
  constructor({ dataDir, seedFilePath } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(this.dataDir, "admins.json");
    this.seedFilePath =
      seedFilePath && typeof seedFilePath === "string" ? seedFilePath : "";
    this.state = { admins: {} };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this._seedFromFile();
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = safeJsonParse(raw, { admins: {} });
      if (parsed && typeof parsed === "object" && parsed.admins) {
        this.state = parsed;
      }
    } catch {
      // ignore
    }
  }

  _seedFromFile() {
    if (!this.seedFilePath) return false;

    try {
      if (!fs.existsSync(this.seedFilePath)) return false;
      const raw = fs.readFileSync(this.seedFilePath, "utf8");
      const parsed = safeJsonParse(raw, null);

      if (!parsed || typeof parsed !== "object") return false;
      if (!parsed.admins || typeof parsed.admins !== "object") return false;

      this.state = { admins: parsed.admins };
      this._save();
      return true;
    } catch {
      return false;
    }
  }

  _save() {
    const payload = JSON.stringify(this.state, null, 2);

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {
      // ignore
    }

    const maxAttempts = 6;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      try {
        fs.writeFileSync(tmp, payload, "utf8");

        try {
          fs.renameSync(tmp, this.filePath);
          return;
        } catch (err) {
          lastErr = err;

          if (isTransientFsError(err)) {
            try {
              fs.copyFileSync(tmp, this.filePath);
              try {
                fs.unlinkSync(tmp);
              } catch {
                // ignore
              }
              return;
            } catch (err2) {
              lastErr = err2;
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        lastErr = err;
      } finally {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }

      if (!isTransientFsError(lastErr)) break;
      sleepSync(50 * attempt);
    }

    try {
      fs.writeFileSync(this.filePath, payload, "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[AdminRecipientStore] Failed to persist admins.json (will retry later):",
        String(err?.message || err),
      );
    }
  }

  listAdmins() {
    return Object.values(this.state.admins).sort((a, b) => {
      const ta = Date.parse(a.createdAt || "") || 0;
      const tb = Date.parse(b.createdAt || "") || 0;
      return tb - ta;
    });
  }

  getAdmin(id) {
    return this.state.admins[id] || null;
  }

  getByEmail(email) {
    const needle = normalizeEmail(email);
    if (!needle) return null;

    return (
      Object.values(this.state.admins).find(
        (a) => normalizeEmail(a.email) === needle,
      ) || null
    );
  }

  upsertAdmin(admin) {
    this.state.admins[admin.id] = admin;
    this._save();
    return admin;
  }

  createAdmin({ email, name = "", active = true }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      const err = new Error("email_required");
      err.code = "EMAIL_REQUIRED";
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

    const admin = {
      id,
      email: normalizedEmail,
      name: typeof name === "string" ? name.trim() : "",
      active: active !== false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    return this.upsertAdmin(admin);
  }

  deleteAdmin(id) {
    if (!this.state.admins[id]) return false;
    delete this.state.admins[id];
    this._save();
    return true;
  }
}

module.exports = { AdminRecipientStore };
