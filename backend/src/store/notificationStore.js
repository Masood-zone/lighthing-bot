const fs = require("node:fs");
const path = require("node:path");

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

class NotificationStore {
  /**
   * @param {{ dataDir: string, seedFilePath?: string }} opts
   */
  constructor({ dataDir, seedFilePath } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(this.dataDir, "notification-email.json");
    this.seedFilePath =
      seedFilePath && typeof seedFilePath === "string" ? seedFilePath : "";
    this.state = {
      recipient: null,
    };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this._seedFromFile();
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = safeJsonParse(raw, null);
      if (parsed && typeof parsed === "object") {
        this.state = {
          recipient: parsed.recipient || null,
        };
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

      if (parsed.recipient && typeof parsed.recipient === "object") {
        this.state = { recipient: parsed.recipient };
        this._save();
        return true;
      }

      if (typeof parsed.email === "string") {
        this.setRecipient({ email: parsed.email, name: parsed.name || "" });
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  _save() {
    const payload = JSON.stringify(this.state, null, 2);

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.filePath, payload, "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[NotificationStore] Failed to persist notification-email.json:",
        String(err?.message || err),
      );
    }
  }

  getRecipient() {
    return this.state.recipient;
  }

  setRecipient({ email, name = "", active = true } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      const err = new Error("email_required");
      err.code = "EMAIL_REQUIRED";
      throw err;
    }

    const recipient = {
      email: normalizedEmail,
      name: typeof name === "string" ? name.trim() : "",
      active: active !== false,
      createdAt: this.state.recipient?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    this.state = { recipient };
    this._save();
    return recipient;
  }

  clearRecipient() {
    const hadRecipient = Boolean(this.state.recipient);
    this.state = { recipient: null };
    this._save();
    return hadRecipient;
  }
}

module.exports = { NotificationStore };
