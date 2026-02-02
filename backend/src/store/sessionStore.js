const fs = require("node:fs");
const path = require("node:path");

const { encryptPassword } = require("../security/passwordCrypto");

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

function sleepSync(ms) {
  // Minimal synchronous sleep to support retrying file operations on Windows.
  // Atomics.wait is available in Node and avoids busy-spinning.
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isTransientFsError(err) {
  const code = String(err?.code || "");
  // Windows/OneDrive/AV commonly hold short-lived locks.
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

class SessionStore {
  /**
   * @param {{ dataDir: string }} opts
   */
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(this.dataDir, "store.json");
    this.state = {
      sessions: {},
    };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = safeJsonParse(raw, { sessions: {} });
      if (parsed && typeof parsed === "object" && parsed.sessions) {
        this.state = parsed;
      }
    } catch {
      // ignore
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

          // If atomic rename is blocked, fall back to copy-overwrite.
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
            // Non-transient rename failures: bail out.
            throw err;
          }
        }
      } catch (err) {
        lastErr = err;
      } finally {
        // Best-effort cleanup of temp file.
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }

      if (!isTransientFsError(lastErr)) break;

      // Backoff and retry.
      sleepSync(50 * attempt);
    }

    // Final fallback: best-effort direct overwrite.
    try {
      fs.writeFileSync(this.filePath, payload, "utf8");
      return;
    } catch (err) {
      lastErr = err;
    }

    // Never crash the server because the file is temporarily locked.
    // The in-memory state remains correct; persistence will retry on the next mutation.
    // eslint-disable-next-line no-console
    console.error(
      "[SessionStore] Failed to persist store.json (will retry later):",
      String(lastErr?.message || lastErr),
    );
  }

  listSessions() {
    return Object.values(this.state.sessions).sort((a, b) => {
      const ta = Date.parse(a.createdAt || "") || 0;
      const tb = Date.parse(b.createdAt || "") || 0;
      return tb - ta;
    });
  }

  getSession(id) {
    return this.state.sessions[id] || null;
  }

  upsertSession(session) {
    this.state.sessions[session.id] = session;
    this._save();
    return session;
  }

  createSession(input) {
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : require("node:crypto").randomUUID();

    const session = {
      id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "CREATED", // CREATED | QUEUED | RUNNING | STOPPED | COMPLETED | ERROR | BLOCKED
      lastMessage: "",
      queue: {
        enqueuedAt: null,
        startedAt: null,
        finishedAt: null,
      },
      config: {
        loginUrl: input.loginUrl,
        email: input.email,
        displayName: input.displayName,
        pickupPoint: input.pickupPoint,
        headless: Boolean(input.headless),
        // Optional appointment date preferences
        // - dateStart/dateEnd: YYYY-MM-DD (inclusive)
        // - daysFromNowMin/daysFromNowMax: inclusive window relative to today
        // - weeksFromNowMin/weeksFromNowMax: inclusive window relative to today
        dateStart: input.dateStart || null,
        dateEnd: input.dateEnd || null,
        daysFromNowMin:
          input.daysFromNowMin === undefined ? null : input.daysFromNowMin,
        daysFromNowMax:
          input.daysFromNowMax === undefined ? null : input.daysFromNowMax,
        weeksFromNowMin:
          input.weeksFromNowMin === undefined ? null : input.weeksFromNowMin,
        weeksFromNowMax:
          input.weeksFromNowMax === undefined ? null : input.weeksFromNowMax,
        ...encryptPassword(input.password),
      },
      runtime: {
        pid: null,
        exitCode: null,
        signal: null,
      },
      logs: [],
    };

    this.upsertSession(session);
    return session;
  }

  updateSession(id, patch) {
    const s = this.getSession(id);
    if (!s) return null;

    const cfg = { ...(s.config || {}) };
    if (Object.prototype.hasOwnProperty.call(patch, "loginUrl")) {
      cfg.loginUrl = patch.loginUrl;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "email")) {
      cfg.email = patch.email;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
      cfg.displayName = patch.displayName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "pickupPoint")) {
      cfg.pickupPoint = patch.pickupPoint;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "headless")) {
      cfg.headless = Boolean(patch.headless);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "dateStart")) {
      cfg.dateStart = patch.dateStart || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "dateEnd")) {
      cfg.dateEnd = patch.dateEnd || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "daysFromNowMin")) {
      cfg.daysFromNowMin =
        patch.daysFromNowMin === undefined || patch.daysFromNowMin === null
          ? null
          : patch.daysFromNowMin;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "daysFromNowMax")) {
      cfg.daysFromNowMax =
        patch.daysFromNowMax === undefined || patch.daysFromNowMax === null
          ? null
          : patch.daysFromNowMax;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "weeksFromNowMin")) {
      cfg.weeksFromNowMin =
        patch.weeksFromNowMin === undefined || patch.weeksFromNowMin === null
          ? null
          : patch.weeksFromNowMin;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "weeksFromNowMax")) {
      cfg.weeksFromNowMax =
        patch.weeksFromNowMax === undefined || patch.weeksFromNowMax === null
          ? null
          : patch.weeksFromNowMax;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "password")) {
      // store encrypted; never persist plaintext
      const enc = encryptPassword(patch.password);
      delete cfg.password;
      cfg.passwordEnc = enc.passwordEnc;
      cfg.passwordIv = enc.passwordIv;
      cfg.passwordTag = enc.passwordTag;
    }

    s.config = cfg;
    s.updatedAt = nowIso();
    return this.upsertSession(s);
  }

  deleteSession(id) {
    if (!this.state.sessions[id]) return false;
    delete this.state.sessions[id];
    this._save();
    return true;
  }

  appendLog(id, level, message) {
    const s = this.getSession(id);
    if (!s) return;

    s.logs = Array.isArray(s.logs) ? s.logs : [];
    s.logs.push({ ts: nowIso(), level, message: String(message) });
    // keep last N logs
    const MAX = 500;
    if (s.logs.length > MAX) s.logs = s.logs.slice(s.logs.length - MAX);

    s.updatedAt = nowIso();
    this.upsertSession(s);
  }

  setStatus(id, status, lastMessage = "") {
    const s = this.getSession(id);
    if (!s) return;
    s.status = status;
    s.lastMessage = String(lastMessage || "");
    s.updatedAt = nowIso();
    this.upsertSession(s);
  }

  setRuntime(id, patch) {
    const s = this.getSession(id);
    if (!s) return;
    s.runtime = { ...(s.runtime || {}), ...patch };
    s.updatedAt = nowIso();
    this.upsertSession(s);
  }

  setQueueTimes(id, patch) {
    const s = this.getSession(id);
    if (!s) return;
    s.queue = { ...(s.queue || {}), ...patch };
    s.updatedAt = nowIso();
    this.upsertSession(s);
  }
}

module.exports = { SessionStore };
