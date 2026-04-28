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

function readBoolEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || String(v).toLowerCase() === "true";
}

function parseProxyPool(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hashToIndex(value, modulo) {
  if (!modulo) return 0;
  let hash = 0x811c9dc5;
  const str = String(value || "");
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % modulo;
}

function selectProxyUrl(sessionId, pool, fallback) {
  if (Array.isArray(pool) && pool.length > 0) {
    const index = hashToIndex(sessionId, pool.length);
    return pool[index] || "";
  }
  return fallback || "";
}

function safeOneLine(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractIsoDateFromText(text) {
  const m = String(text || "").match(/\b\d{4}-\d{2}-\d{2}\b/);
  return m ? m[0] : "";
}

function extractTimeSlotFromText(text) {
  const raw = String(text || "");
  const m = raw.match(/time\s+slot\s+selected\s*:\s*(.+)$/i);
  if (!m) return "";
  let slot = String(m[1] || "").trim();
  // Drop trailing annotations like "(green)".
  slot = slot.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return slot;
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

function getSessionUserLabel(session) {
  const displayName = safeOneLine(session?.config?.displayName);
  const email = safeOneLine(session?.config?.email);

  if (displayName && email) {
    return `${displayName} <${email}>`;
  }

  return displayName || email || "unknown user";
}

function logSessionLifecycle(sessionId, session, action, detail = "") {
  const prefix = `[${nowIso()}] [session:${sessionId}]`;
  const userLabel = getSessionUserLabel(session);
  const message = safeOneLine(detail);

  // eslint-disable-next-line no-console
  console.log(
    `${prefix} ${action} for ${userLabel}${message ? ` - ${message}` : ""}`,
  );
}

class WorkerPool {
  /**
   * @param {{ store: import('../store/sessionStore').SessionStore, maxConcurrent: number, workerEntry: string, baseDir: string, profilesDir?: string, notificationService?: any }} opts
   */
  constructor({
    store,
    maxConcurrent,
    workerEntry,
    baseDir,
    profilesDir,
    notificationService,
  }) {
    this.store = store;
    // Allow disabling worker execution entirely by setting MAX_CONCURRENT=0.
    this.maxConcurrent = Math.max(0, Number(maxConcurrent ?? 1));
    this.workerEntry = workerEntry;
    this.baseDir = baseDir;
    this.profilesDir = profilesDir || path.join(this.baseDir, "profiles");

    const proxyPoolRaw =
      process.env.VISA_PROXY_POOL || process.env.VISA_PROXY_URLS || "";
    this.proxyPool = parseProxyPool(proxyPoolRaw);
    this.proxyFallback = String(
      process.env.VISA_PROXY_URL || process.env.VISA_PROXY_SERVER || "",
    ).trim();

    this.notificationService = notificationService || null;

    /** @type {Map<string, {dateKey?: string, timeSlot?: string}>} */
    this.bookingContext = new Map();

    /** @type {Set<string>} */
    this.notifiedSuccess = new Set();

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
      workersEnabled: this.maxConcurrent > 0,
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.slice(),
      active: Array.from(this.active.keys()),
      activeCount: this.active.size,
      queuedCount: this.queue.length,
      ts: nowIso(),
    };
  }

  enqueue(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    if (this.maxConcurrent === 0) {
      this.store.setStatus(
        sessionId,
        "BLOCKED",
        "Workers are disabled on this service (MAX_CONCURRENT=0)",
      );
      this.store.appendLog(
        sessionId,
        "warn",
        "Attempted to start worker but workers are disabled (MAX_CONCURRENT=0)",
      );
      this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
      logSessionLifecycle(
        sessionId,
        session,
        "Blocked session start",
        "Workers are disabled (MAX_CONCURRENT=0)",
      );
      return;
    }
    if (this.queue.includes(sessionId) || this.active.has(sessionId)) return;
    this.queue.push(sessionId);
    this.store.setStatus(sessionId, "QUEUED", "Queued for execution");
    this.store.setQueueTimes(sessionId, { enqueuedAt: nowIso() });
    logSessionLifecycle(sessionId, session, "Queued session start");
    this._tick();
  }

  dequeue(sessionId) {
    this.queue = this.queue.filter((id) => id !== sessionId);
  }

  stop(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return false;

    this.dequeue(sessionId);

    const child = this.active.get(sessionId);
    if (child) {
      this.store.appendLog(sessionId, "warn", "Stopping worker (SIGTERM)");
      logSessionLifecycle(sessionId, session, "Stopping session");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      return true;
    }

    this.store.setStatus(sessionId, "STOPPED", "Stopped");
    this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
    logSessionLifecycle(sessionId, session, "Stopped session");
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

    this.bookingContext.delete(sessionId);
    this.notifiedSuccess.delete(sessionId);

    this.store.setStatus(sessionId, "RUNNING", "Starting worker");
    this.store.setQueueTimes(sessionId, { startedAt: nowIso() });

    const profileDir = path.join(this.profilesDir, sessionId);

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

    const forceVisibleBrowser = readBoolEnv("FORCE_VISIBLE_BROWSER") ?? false;

    const env = {
      ...process.env,
      VISA_SESSION_ID: sessionId,
      VISA_PLATFORM_URL: session.config.loginUrl,
      VISA_USER_EMAIL: session.config.email,
      VISA_USER_PASSWORD: passwordPlain,
      VISA_USER_DISPLAY_NAME: session.config.displayName,
      VISA_PICKUP_POINT: session.config.pickupPoint,
      VISA_HEADLESS: forceVisibleBrowser
        ? "0"
        : session.config.headless
          ? "1"
          : "0",
      VISA_PROFILE_DIR: profileDir,
      VISA_RESCHEDULE: session.config.reschedule ? "1" : "0",

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

    const proxyUrl = selectProxyUrl(
      sessionId,
      this.proxyPool,
      this.proxyFallback,
    );
    if (proxyUrl) {
      env.VISA_PROXY_URL = proxyUrl;
    }

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
    logSessionLifecycle(
      sessionId,
      session,
      "Started session",
      child.pid ? `pid ${child.pid}` : "",
    );

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

        // Capture booking context from worker messages (best-effort).
        if (typeof state === "string") {
          const prev = this.bookingContext.get(sessionId) || {};
          const ctx = { ...prev };

          if (state === "DATE_SELECTED" && typeof message === "string") {
            const dateKey = extractIsoDateFromText(message);
            if (dateKey) ctx.dateKey = dateKey;
          }

          if (state === "SLOT_SELECTED" && typeof message === "string") {
            const timeSlot = extractTimeSlotFromText(message);
            if (timeSlot) ctx.timeSlot = timeSlot;
          }

          this.bookingContext.set(sessionId, ctx);
        }

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

          // Non-blocking notification: enqueue email for admins ASAP.
          if (!this.notifiedSuccess.has(sessionId)) {
            this.notifiedSuccess.add(sessionId);

            const svc = this.notificationService;
            if (svc && typeof svc.enqueueBookingSuccess === "function") {
              const ctx = this.bookingContext.get(sessionId) || {};
              const queued = svc.enqueueBookingSuccess({
                sessionId,
                session,
                booking: { ...ctx },
              });

              if (queued) {
                this.store.appendLog(
                  sessionId,
                  "info",
                  "Queued email notification to administrators",
                );
              } else {
                this.store.appendLog(
                  sessionId,
                  "warn",
                  "Failed to queue administrator email notification (queue full)",
                );
              }
            } else {
              this.store.appendLog(
                sessionId,
                "warn",
                "Email notifications not configured on server",
              );
            }
          }
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
      this.bookingContext.delete(sessionId);
      this.notifiedSuccess.delete(sessionId);
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
        logSessionLifecycle(sessionId, session, "Stopped session", signal);
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
