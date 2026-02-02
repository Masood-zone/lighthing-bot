const path = require("node:path");
const { fork } = require("node:child_process");

const {
  decryptPassword,
  encryptPassword,
  isSecretConfigured,
} = require("../security/passwordCrypto");

function nowIso() {
  return new Date().toISOString();
}

function safeOneLine(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function logWorkerToBackendConsole(sessionId, level, message) {
  const ts = nowIso();
  const msg = safeOneLine(message);
  if (!msg) return;

  const prefix = `[${ts}] [worker:${sessionId}]`;
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console[level](`${prefix} ${msg}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${prefix} ${msg}`);
}

class WorkerPool {
  /**
   * @param {{ store: import('../store/sessionStore').SessionStore, maxConcurrent: number, workerEntry: string, baseDir: string }} opts
   */
  constructor({ store, maxConcurrent, workerEntry, baseDir }) {
    this.store = store;
    this.maxConcurrent = Math.max(1, Number(maxConcurrent || 1));
    this.workerEntry = workerEntry;
    this.baseDir = baseDir;

    /** @type {string[]} */
    this.queue = [];
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.active = new Map();

    // best-effort cleanup
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  getSnapshot() {
    return {
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.slice(),
      active: Array.from(this.active.keys()),
      activeCount: this.active.size,
      queuedCount: this.queue.length,
      ts: nowIso(),
    };
  }

  enqueue(sessionId) {
    if (this.queue.includes(sessionId) || this.active.has(sessionId)) return;
    this.queue.push(sessionId);
    this.store.setStatus(sessionId, "QUEUED", "Queued for execution");
    this.store.setQueueTimes(sessionId, { enqueuedAt: nowIso() });
    this._tick();
  }

  dequeue(sessionId) {
    this.queue = this.queue.filter((id) => id !== sessionId);
  }

  stop(sessionId) {
    this.dequeue(sessionId);

    const child = this.active.get(sessionId);
    if (child) {
      this.store.appendLog(sessionId, "warn", "Stopping worker (SIGTERM)");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      return true;
    }

    this.store.setStatus(sessionId, "STOPPED", "Stopped");
    this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
    return false;
  }

  shutdown() {
    for (const [id, child] of this.active.entries()) {
      try {
        this.store.appendLog(
          id,
          "warn",
          "Server shutting down; terminating worker",
        );
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  _tick() {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift();
      if (!nextId) break;
      this._startSession(nextId);
    }
  }

  _startSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    this.store.setStatus(sessionId, "RUNNING", "Starting worker");
    this.store.setQueueTimes(sessionId, { startedAt: nowIso() });

    const profileDir = path.join(this.baseDir, "profiles", sessionId);

    let passwordPlain = "";
    try {
      if (session.config?.passwordEnc) {
        passwordPlain = decryptPassword(session.config);
      } else if (session.config?.password) {
        // Legacy plaintext support; migrate to encrypted-at-rest if key configured.
        passwordPlain = String(session.config.password);
        if (isSecretConfigured()) {
          const enc = encryptPassword(passwordPlain);
          delete session.config.password;
          session.config.passwordEnc = enc.passwordEnc;
          session.config.passwordIv = enc.passwordIv;
          session.config.passwordTag = enc.passwordTag;
          session.updatedAt = nowIso();
          this.store.upsertSession(session);
        }
      } else {
        throw new Error("Session password is missing.");
      }
    } catch (err) {
      this.store.appendLog(
        sessionId,
        "error",
        `Failed to prepare password for worker: ${String(err?.message || err)}`,
      );
      this.store.setStatus(
        sessionId,
        "ERROR",
        "Password encryption/decryption failed",
      );
      this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
      this._tick();
      return;
    }

    const env = {
      ...process.env,
      VISA_SESSION_ID: sessionId,
      VISA_PLATFORM_URL: session.config.loginUrl,
      VISA_USER_EMAIL: session.config.email,
      VISA_USER_PASSWORD: passwordPlain,
      VISA_USER_DISPLAY_NAME: session.config.displayName,
      VISA_PICKUP_POINT: session.config.pickupPoint,
      VISA_HEADLESS: session.config.headless ? "1" : "0",
      VISA_PROFILE_DIR: profileDir,

      // Optional appointment date preferences (all optional)
      VISA_DATE_START: session.config.dateStart || "",
      VISA_DATE_END: session.config.dateEnd || "",
      VISA_DAYS_FROM_NOW_MIN:
        session.config.daysFromNowMin === null ||
        session.config.daysFromNowMin === undefined
          ? ""
          : String(session.config.daysFromNowMin),
      VISA_DAYS_FROM_NOW_MAX:
        session.config.daysFromNowMax === null ||
        session.config.daysFromNowMax === undefined
          ? ""
          : String(session.config.daysFromNowMax),
      VISA_WEEKS_FROM_NOW_MIN:
        session.config.weeksFromNowMin === null ||
        session.config.weeksFromNowMin === undefined
          ? ""
          : String(session.config.weeksFromNowMin),
      VISA_WEEKS_FROM_NOW_MAX:
        session.config.weeksFromNowMax === null ||
        session.config.weeksFromNowMax === undefined
          ? ""
          : String(session.config.weeksFromNowMax),
    };

    const child = fork(this.workerEntry, [], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    this.active.set(sessionId, child);
    this.store.setRuntime(sessionId, {
      pid: child.pid,
      exitCode: null,
      signal: null,
    });

    child.stdout?.on("data", (buf) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.store.appendLog(sessionId, "info", line);
        logWorkerToBackendConsole(sessionId, "info", line);
      }
    });

    child.stderr?.on("data", (buf) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.store.appendLog(sessionId, "error", line);
        logWorkerToBackendConsole(sessionId, "error", line);
      }
    });

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "status") {
        const { state, message } = msg;

        logWorkerToBackendConsole(
          sessionId,
          "info",
          `STATUS ${safeOneLine(state)}${message ? ` - ${safeOneLine(message)}` : ""}`,
        );

        // Map worker state to session status
        if (state === "BLOCKED") {
          this.store.setStatus(sessionId, "BLOCKED", message || "Blocked");
        } else if (state === "COMPLETED") {
          this.store.setStatus(sessionId, "COMPLETED", message || "Completed");
        } else {
          this.store.setStatus(
            sessionId,
            "RUNNING",
            message || String(state || "RUNNING"),
          );
        }
      }
      if (msg.type === "log") {
        this.store.appendLog(sessionId, msg.level || "info", msg.message || "");

        logWorkerToBackendConsole(
          sessionId,
          msg.level || "info",
          `LOG ${safeOneLine(msg.level || "info")} - ${safeOneLine(msg.message || "")}`,
        );
      }
    });

    child.on("exit", (code, signal) => {
      this.active.delete(sessionId);
      this.store.setRuntime(sessionId, { exitCode: code, signal });
      this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });

      const current = this.store.getSession(sessionId);
      if (current?.status === "BLOCKED") {
        this.store.appendLog(
          sessionId,
          "warn",
          "Worker exited due to access restriction",
        );
      } else if (code === 0) {
        // If worker didn't already mark itself completed, mark completed.
        if (current?.status === "RUNNING") {
          this.store.setStatus(
            sessionId,
            "COMPLETED",
            "Worker exited successfully",
          );
        }
      } else if (signal) {
        this.store.setStatus(
          sessionId,
          "STOPPED",
          `Stopped by signal ${signal}`,
        );
      } else {
        this.store.setStatus(
          sessionId,
          "ERROR",
          `Worker exited with code ${code}`,
        );
      }

      this._tick();
    });
  }
}

module.exports = { WorkerPool };
