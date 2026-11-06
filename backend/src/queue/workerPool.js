const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { SessionMonitor, createLineReader } = require("./sessionMonitor");

const {
  decryptProxyUrl,
  decryptPassword,
  encryptPassword,
  isSecretConfigured,
} = require("../security/passwordCrypto");
const { Proxy11Rotator } = require("./proxy11Rotator");

function nowIso() {
  return new Date().toISOString();
}

function readBoolEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || String(v).toLowerCase() === "true";
}

function resolveSessionExecutionMode(session) {
  return session?.config?.executionMode === "api" ? "api" : "dom";
}

function normalizeProxyUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function parseProxyPool(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"))
    .map(normalizeProxyUrl)
    .filter(Boolean);
}

function readProxyPoolFile(filePath) {
  if (!filePath) return [];

  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return parseProxyPool(raw);
  } catch {
    return [];
  }
}

function resolveProxyPool(baseDir) {
  const envPool = parseProxyPool(
    process.env.VISA_PROXY_POOL || process.env.VISA_PROXY_URLS || "",
  );
  if (envPool.length > 0) {
    return envPool;
  }

  const explicitFile = String(
    process.env.VISA_PROXY_POOL_FILE || process.env.VISA_PROXY_URLS_FILE || "",
  ).trim();

  const candidateFiles = [];
  if (explicitFile) {
    candidateFiles.push(
      path.isAbsolute(explicitFile)
        ? explicitFile
        : path.resolve(baseDir, explicitFile),
    );
  }

  candidateFiles.push(path.join(baseDir, "data", "proxy-pool.txt"));

  for (const filePath of candidateFiles) {
    const pool = readProxyPoolFile(filePath);
    if (pool.length > 0) {
      return pool;
    }
  }

  return [];
}

function hashToIndex(value, modulo) {
  // Guard against empty pools.
  if (!modulo) return 0;
  // FNV-1a-inspired (JS 32-bit variant) hash for deterministic session-to-proxy mapping.
  let hash = 0x811c9dc5;
  const str = String(value || "");
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % modulo;
}

function hashString(value) {
  let hash = 0x811c9dc5;
  const str = String(value || "");
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function describeProxyUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  const fingerprint = hashString(value).toString(16).padStart(8, "0");

  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}#${fingerprint}`;
  } catch {
    return `proxy#${fingerprint}`;
  }
}

function selectProxySelection(
  sessionId,
  pool,
  fallback,
  reservedProxyUrls = new Set(),
  preferredProxyUrl = "",
) {
  const sessionProxyUrl = normalizeProxyUrl(preferredProxyUrl);
  if (sessionProxyUrl) {
    return {
      proxyIndex: null,
      proxySource: "session",
      proxyUrl: sessionProxyUrl,
    };
  }

  if (Array.isArray(pool) && pool.length > 0) {
    const candidates = selectLeastUsedProxy(pool, reservedProxyUrls);
    const index = hashToIndex(sessionId, candidates.length);
    const proxyUrl = candidates[index];
    return {
      proxyIndex: pool.indexOf(proxyUrl),
      proxySource: candidates.length === pool.length ? "pool" : "pool-free",
      proxyUrl,
    };
  }
  return {
    proxyIndex: null,
    proxySource: fallback ? "fallback" : "none",
    proxyUrl: normalizeProxyUrl(fallback) || "",
  };
}

function selectProxyUrl(sessionId, pool, fallback, preferredProxyUrl = "") {
  return selectProxySelection(
    sessionId,
    pool,
    fallback,
    new Set(),
    preferredProxyUrl,
  ).proxyUrl;
}

function describeProxySelection(selection) {
  if (!selection?.proxyUrl) return "no proxy";

  const proxyLabel = describeProxyUrl(selection.proxyUrl);
  if (
    selection.proxySource === "proxy11" ||
    selection.proxySource === "proxy11-reuse"
  ) {
    if (Number.isInteger(selection.proxyIndex)) {
      return `proxy11[${selection.proxyIndex}] ${proxyLabel}`;
    }

    return `proxy11 ${proxyLabel}`;
  }

  if (
    selection.proxySource === "pool" &&
    Number.isInteger(selection.proxyIndex)
  ) {
    return `pool[${selection.proxyIndex}] ${proxyLabel}`;
  }

  if (
    selection.proxySource === "pool-free" &&
    Number.isInteger(selection.proxyIndex)
  ) {
    return `pool-free[${selection.proxyIndex}] ${proxyLabel}`;
  }

  if (selection.proxySource === "session") {
    return `session ${proxyLabel}`;
  }

  if (selection.proxySource === "fallback") {
    return `fallback ${proxyLabel}`;
  }

  return proxyLabel;
}

function getActiveProxyUrls(activeSessions, proxyAssignments) {
  const used = new Set();

  for (const sessionId of activeSessions.keys()) {
    const selection = proxyAssignments.get(sessionId);
    if (selection?.proxyUrl) {
      used.add(selection.proxyUrl);
    }
  }

  return used;
}

function selectLeastUsedProxy(pool, activeProxyUrls) {
  const free = pool.filter((proxyUrl) => !activeProxyUrls.has(proxyUrl));
  if (free.length > 0) {
    return free;
  }

  return pool;
}

function safeOneLine(value) {
  return String(value ?? "")
    .replace(/([\r\n]+)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Bound the number of proxies tested before the existing direct fallback.
const { checkProxyHealth } = require("./proxyHealth");
const PREFLIGHT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.PROXY_PREFLIGHT_MAX_ATTEMPTS) || 3,
);

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

function getWorkerConsoleLabel(sessionId, session) {
  const displayName = safeOneLine(session?.config?.displayName);
  if (!displayName) return sessionId;

  return `${displayName} id:${sessionId}`;
}

function logWorkerToBackendConsole(sessionId, session, level, message) {
  const ts = nowIso();
  const msg = safeOneLine(message);
  if (!msg) return;

  const prefix = `[${ts}] [worker:${getWorkerConsoleLabel(sessionId, session)}]`;
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

function getSessionAccountKey(session) {
  const email = safeOneLine(session?.config?.email).toLowerCase();
  let host = "";
  try {
    host = new URL(session?.config?.loginUrl || "").host.toLowerCase();
  } catch {
    host = "";
  }

  return `${host || "unknown-host"}:${email || session?.id || "unknown-account"}`;
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
   * @param {{ store: import('../store/sessionStore').SessionStore, maxConcurrent: number, workerEntry: string, baseDir: string, profilesDir?: string, notificationService?: any, desktopNotificationService?: any }} opts
   */
  constructor({
    store,
    maxConcurrent,
    workerEntry,
    baseDir,
    profilesDir,
    notificationService,
    desktopNotificationService,
    desktopNotificationsEnabled,
    proxyMode = process.env.VISA_PROXY_MODE || "auto",
    proxyHealthCheck = checkProxyHealth,
    forkWorker = fork,
    monitorOptions = {},
  }) {
    this.store = store;
    this.proxyMode = String(proxyMode).trim().toLowerCase();
    if (!["auto", "direct"].includes(this.proxyMode)) {
      throw new Error("VISA_PROXY_MODE must be auto or direct");
    }
    this.proxyHealthCheck = proxyHealthCheck;
    this.forkWorker = forkWorker;
    // Allow disabling worker execution entirely by setting MAX_CONCURRENT=0.
    this.maxConcurrent = Math.max(0, Number(maxConcurrent ?? 1));
    this.workerEntry = workerEntry;
    this.baseDir = baseDir;
    this.profilesDir = profilesDir || path.join(this.baseDir, "profiles");

    this.starting = new Set();
    this.proxy11PoolLogged = false;
    this.proxy11Rotator = new Proxy11Rotator({
      baseUrl: process.env.PROXY_HOST || process.env.PROXY_API_URL || "",
      apiKey: process.env.PROXY_API_KEY || process.env.PROXY11_API_KEY || "",
      fallbackPort: process.env.PROXY_PORT || process.env.PROXY11_PORT || "",
      maxEntries: 50,
      refreshMs: Math.max(
        60_000,
        Number(process.env.PROXY_REFRESH_MS) || 10 * 60 * 1000,
      ),
      requestTimeoutMs: Math.max(
        3000,
        Number(process.env.PROXY_REQUEST_TIMEOUT_MS) || 15000,
      ),
    });

    this.proxyPool = resolveProxyPool(this.baseDir);
    this.proxyFallback = normalizeProxyUrl(
      process.env.VISA_PROXY_URL || process.env.VISA_PROXY_SERVER || "",
    );

    this.notificationsEnabled =
      readBoolEnv("VISA_ENABLE_BOOKING_NOTIFICATIONS") === true;

    /** @type {Set<string>} */
    this.failedProxyUrls = new Set();

    this.notificationService = notificationService || null;
    this.desktopNotificationService = desktopNotificationService || null;
    this.desktopNotificationsEnabled =
      typeof desktopNotificationsEnabled === "boolean"
        ? desktopNotificationsEnabled
        : readBoolEnv("VISA_ENABLE_DESKTOP_NOTIFICATIONS") === true;

    /** @type {Map<string, {dateKey?: string, timeSlot?: string}>} */
    this.bookingContext = new Map();

    /** @type {Set<string>} */
    this.notifiedSuccess = new Set();

    /** @type {Set<string>} */
    this.notifiedDesktopSuccess = new Set();

    /** @type {Set<string>} */
    this.notifiedClick = new Set();

    /** @type {Map<string, {proxyIndex: number|null, proxySource: string, proxyUrl: string}>} */
    this.proxyAssignments = new Map();

    /** @type {Map<string, string>} accountKey -> sessionId */
    this.accountLocks = new Map();

    /** @type {string[]} */
    this.queue = [];
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.active = new Map();
    // Live browsers may wait for sign-in without occupying hunting capacity.
    this.hunting = new Set();
    this.renewals = new Map();
    this.stopping = new Set();
    this.shuttingDown = false;
    this.monitor = new SessionMonitor({
      ...monitorOptions,
      emit: (id, record) => {
        const session = this.store.getSession(id);
        if (!session) return;
        const pid = this.active.get(id)?.pid || "none";
        logWorkerToBackendConsole(id, session, "info",
          `SESSION_SUMMARY mode=${resolveSessionExecutionMode(session)} pid=${pid} status=${session.status} phase=${record.phase} state=${record.state} phaseAge=${record.phaseSeconds}s lastActivity=${record.activitySeconds}s slots=${this.hunting.size}/${this.maxConcurrent}`);
      },
    });

    // best-effort cleanup
    this.handleShutdown = () => this.shutdown();
    process.on("SIGINT", this.handleShutdown);
    process.on("SIGTERM", this.handleShutdown);
  }

  getSnapshot() {
    return {
      workersEnabled: this.maxConcurrent > 0,
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.slice(),
      active: Array.from(this.hunting),
      activeCount: this.hunting.size,
      queuedCount: this.queue.length,
      ts: nowIso(),
    };
  }

  setDesktopNotificationsEnabled(enabled) {
    this.desktopNotificationsEnabled = Boolean(enabled);
    if (this.desktopNotificationService) {
      this.desktopNotificationService.enabled = this.desktopNotificationsEnabled;
    }
    return this.desktopNotificationsEnabled;
  }

  enqueue(sessionId) {
    if (this.shuttingDown) return { queued: false, reason: "shutting_down" };
    const session = this.store.getSession(sessionId);
    if (!session) return { queued: false, reason: "not_found" };

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
      return { queued: false, reason: "workers_disabled" };
    }

    if (this.queue.includes(sessionId) || this.active.has(sessionId)) {
      return { queued: false, alreadyQueued: true, existingSessionId: sessionId };
    }

    const accountKey = getSessionAccountKey(session);
    const lockedBy = this.accountLocks.get(accountKey);
    if (lockedBy && lockedBy !== sessionId) {
      this.store.appendLog(
        sessionId,
        "warn",
        `Start rejected: account is already locked by active/queued session ${lockedBy}`,
      );
      logSessionLifecycle(
        sessionId,
        session,
        "Rejected duplicate account session",
        `locked by ${lockedBy}`,
      );
      return {
        queued: false,
        duplicateAccount: true,
        existingSessionId: lockedBy,
      };
    }

    this.accountLocks.set(accountKey, sessionId);
    this.queue.push(sessionId);
    this.monitor.update(sessionId, "QUEUED");
    this.store.setStatus(sessionId, "QUEUED", "Queued for execution");
    this.store.setQueueTimes(sessionId, { enqueuedAt: nowIso() });
    logSessionLifecycle(sessionId, session, "Queued session start");
    this._tick();
    return { queued: true, id: sessionId };
  }

  dequeue(sessionId) {
    this.queue = this.queue.filter((id) => id !== sessionId);
  }

  _releaseAccountLock(sessionId) {
    const session = this.store.getSession(sessionId);
    const accountKey = getSessionAccountKey(session || { id: sessionId });
    if (this.accountLocks.get(accountKey) === sessionId) {
      this.accountLocks.delete(accountKey);
      return;
    }

    for (const [key, lockedSessionId] of this.accountLocks.entries()) {
      if (lockedSessionId === sessionId) {
        this.accountLocks.delete(key);
      }
    }
  }

  stop(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return false;

    this.dequeue(sessionId);

    const child = this.active.get(sessionId);
    if (child) {
      this.stopping.add(sessionId);
      this.monitor.update(sessionId, "STOPPING");
      this.store.appendLog(sessionId, "warn", "Stopping worker (SIGTERM)");
      logSessionLifecycle(sessionId, session, "Stopping session");
      this._terminateWorker(sessionId, child);
      return true;
    }

    this._releaseAccountLock(sessionId);
    this.monitor.remove(sessionId);
    this.store.setStatus(sessionId, "STOPPED", "Stopped");
    this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
    logSessionLifecycle(sessionId, session, "Stopped session");
    return false;
  }

  shutdown() {
    this.monitor.close();
    process.removeListener("SIGINT", this.handleShutdown);
    process.removeListener("SIGTERM", this.handleShutdown);
    this.shuttingDown = true;
    for (const id of this.queue) {
      if (this.active.has(id)) continue;
      this._releaseAccountLock(id);
      this.store.setStatus(id, "STOPPED", "Server shutting down");
      this.store.setQueueTimes(id, { finishedAt: nowIso() });
    }
    this.queue = [];
    for (const [id, child] of this.active.entries()) {
      this.stopping.add(id);
      try {
        this.store.appendLog(
          id,
          "warn",
          "Server shutting down; terminating worker",
        );
        this._terminateWorker(id, child);
      } catch {
        // ignore
      }
    }
  }

  _terminateWorker(sessionId, child) {
    const kill = () => {
      try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
    };
    if (resolveSessionExecutionMode(this.store.getSession(sessionId)) !== "api" || !child.connected) {
      kill();
      return;
    }
    // Windows SIGTERM terminates Node immediately. Give API workers a chance
    // to close Chrome first, retaining a bounded fallback for an unresponsive worker.
    const fallback = setTimeout(kill, 5000);
    fallback.unref();
    child.once("exit", () => clearTimeout(fallback));
    try {
      child.send({ type: "worker_stop" }, (error) => { if (error) kill(); });
    } catch {
      kill();
    }
  }

  _releaseProxyAssignment(sessionId) {
    this.proxyAssignments.delete(sessionId);
  }

  _tick() {
    if (this.shuttingDown) return;
    if (this.hunting.size + this.starting.size >= this.maxConcurrent) {
      return;
    }

    if (this.starting.size > 0) {
      return;
    }

    const nextId = this.queue.shift();
    if (!nextId) return;

    const child = this.active.get(nextId);
    if (child) {
      const renewal = this.renewals.get(nextId);
      if (renewal?.phase !== "queued" || this.stopping.has(nextId)) {
        this._tick();
        return;
      }
      renewal.phase = "hunting";
      this.monitor.update(nextId, "SESSION_READY");
      this.hunting.add(nextId);
      this.store.setStatus(nextId, "RUNNING", "Hunting slot granted after sign-in");
      this.store.setQueueTimes(nextId, { startedAt: nowIso() });
      try {
        child.send({ type: "hunt_resume_granted", requestId: renewal.requestId }, (error) => {
          if (error) this.stop(nextId);
        });
      } catch {
        this.stop(nextId);
      }
      this._tick();
      return;
    }

    this.starting.add(nextId);
    void this._startSession(nextId)
      .catch((err) => {
        this.store.appendLog(
          nextId,
          "error",
          `Worker start failed: ${String(err?.message || err)}`,
        );
        this._releaseAccountLock(nextId);
        this.store.setStatus(nextId, "ERROR", "Worker failed to start");
        this.monitor.remove(nextId);
      })
      .finally(() => {
        this.starting.delete(nextId);
        this._tick();
      });
  }

  _handleHuntControl(sessionId, child, msg) {
    if (this.active.get(sessionId) !== child || this.stopping.has(sessionId)) return;
    if (resolveSessionExecutionMode(this.store.getSession(sessionId)) !== "api") return;
    if (!Number.isSafeInteger(msg.requestId) || msg.requestId < 1) return;
    const renewal = this.renewals.get(sessionId);
    if (msg.type === "hunt_slot_released") {
      if (!this.hunting.has(sessionId) || msg.requestId !== (renewal?.requestId || 0) + 1) return;
      this.hunting.delete(sessionId);
      this.monitor.update(sessionId, "WAITING_FOR_HOURLY_SIGN_IN");
      this.renewals.set(sessionId, { requestId: msg.requestId, phase: "login" });
      this.store.setStatus(sessionId, "RUNNING", "Hunting paused after one hour. Complete CAPTCHA and press Sign In to continue");
      this._tick();
    } else if (msg.type === "hunt_resume_requested") {
      if (renewal?.phase !== "login" || renewal.requestId !== msg.requestId) return;
      renewal.phase = "queued";
      this.monitor.update(sessionId, "QUEUED");
      this.queue.push(sessionId);
      this.store.setStatus(sessionId, "QUEUED", "Signed in; queued for a hunting slot");
      this.store.setQueueTimes(sessionId, { enqueuedAt: nowIso() });
      this._tick();
    }
  }

  async _startSession(sessionId) {
    this.monitor.update(sessionId, "STARTING");
    const session = this.store.getSession(sessionId);
    if (!session) {
      this._releaseAccountLock(sessionId);
      this.monitor.remove(sessionId);
      return;
    }
    if (session.status === "STOPPED" || session.status === "BLOCKED") {
      this._releaseAccountLock(sessionId);
      this.monitor.remove(sessionId);
      return;
    }

    this.bookingContext.delete(sessionId);
    this.notifiedSuccess.delete(sessionId);

    this.store.setStatus(sessionId, "RUNNING", "Starting worker");
    this.store.setQueueTimes(sessionId, { startedAt: nowIso() });

    const profileDir = path.join(this.profilesDir, sessionId);

    let passwordPlain = "";
    let sessionProxyUrl = "";
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

      if (session.config?.proxyUrlEnc) {
        sessionProxyUrl = decryptProxyUrl(session.config);
      } else if (session.config?.proxyUrl) {
        sessionProxyUrl = String(session.config.proxyUrl);
      }
    } catch (err) {
      this.store.appendLog(
        sessionId,
        "error",
        `Failed to prepare credentials for worker: ${String(err?.message || err)}`,
      );
      this.store.setStatus(sessionId, "ERROR", "Credential preparation failed");
      this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });
      this._releaseAccountLock(sessionId);
      this.monitor.remove(sessionId);
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
      VISA_EXECUTION_MODE: resolveSessionExecutionMode(session),

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

    const reservedProxyUrls = getActiveProxyUrls(
      this.active,
      this.proxyAssignments,
    );
    let proxySelection = this.proxyMode === "direct" ? null : await this.proxy11Rotator
      .acquire({ sessionId, activeProxyUrls: reservedProxyUrls })
      .catch(() => null);

    const currentSession = this.store.getSession(sessionId);
    if (!currentSession || currentSession.status === "STOPPED") {
      this._releaseAccountLock(sessionId);
      this.monitor.remove(sessionId);
      return;
    }

    if (proxySelection?.proxyUrl) {
      if (!this.proxy11PoolLogged) {
        const summary =
          proxySelection.poolSize >= this.maxConcurrent
            ? `Proxy11 loaded ${proxySelection.poolSize} proxies for ${this.maxConcurrent} worker slot(s)`
            : `Proxy11 loaded ${proxySelection.poolSize} proxy endpoint(s) for ${this.maxConcurrent} worker slot(s); some reuse may be required`;

        this.store.appendLog(
          sessionId,
          proxySelection.poolSize >= this.maxConcurrent ? "info" : "warn",
          summary,
        );
        this.proxy11PoolLogged = true;
      }

      if (proxySelection.proxySource === "proxy11-reuse") {
        this.store.appendLog(
          sessionId,
          "warn",
          `Proxy11 pool exhausted; reusing ${describeProxySelection(proxySelection)}`,
        );
      } else {
        this.store.appendLog(
          sessionId,
          "info",
          `Assigned ${describeProxySelection(proxySelection)}`,
        );
      }
    } else {
      const proxy11Status = this.proxy11Rotator.getStatus();
      if (proxy11Status.configured && proxy11Status.lastError) {
        this.store.appendLog(
          sessionId,
          "warn",
          `Proxy11 rotator unavailable: ${proxy11Status.lastError}`,
        );
      }

      proxySelection = this.proxyMode === "direct"
        ? { proxyUrl: "", proxyIndex: null, proxySource: "direct" }
        : sessionProxyUrl
        ? {
            proxyUrl: sessionProxyUrl,
            proxyIndex: null,
            proxySource: "session",
          }
        : selectProxySelection(
            sessionId,
            this.proxyPool,
            this.proxyFallback,
            reservedProxyUrls,
            sessionProxyUrl,
          );

      if (proxySelection?.proxyUrl) {
        this.store.appendLog(
          sessionId,
          "info",
          `Assigned ${describeProxySelection(proxySelection)}`,
        );
      }
    }

    // Preflight selected proxy(s) to avoid launching workers with broken tunnels.
    if (proxySelection?.proxyUrl) {
      let attempts = 0;
      let healthy = false;
      let currentSelection = proxySelection;
      const platformHost = (() => {
        try {
          return new URL(session.config.loginUrl).hostname;
        } catch {
          return "www.google.com";
        }
      })();

      while (attempts < PREFLIGHT_MAX_ATTEMPTS && currentSelection?.proxyUrl) {
        // Skip proxies we've already marked failed.
        if (this.failedProxyUrls.has(currentSelection.proxyUrl)) {
          // Try to pick another candidate
        } else {
          // eslint-disable-next-line no-await-in-loop
          const result = await this.proxyHealthCheck(
            currentSelection.proxyUrl,
            platformHost,
          ).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
          if (result.ok) {
            healthy = true;
            proxySelection = currentSelection;
            break;
          }

          // Mark failed and log
          this.failedProxyUrls.add(currentSelection.proxyUrl);
          this.store.appendLog(
            sessionId,
            "warn",
            `Proxy preflight failed for ${describeProxyUrl(currentSelection.proxyUrl)}: ${result.reason}`,
          );
        }

        attempts += 1;

        // Try to get another candidate: prefer Proxy11 rotator if configured
        if (
          currentSelection?.proxySource &&
          currentSelection.proxySource.startsWith("proxy11") &&
          typeof this.proxy11Rotator?.acquire === "function"
        ) {
          // Acquire next from rotator (rotator advances nextIndex on each acquire)
          // eslint-disable-next-line no-await-in-loop
          currentSelection = await this.proxy11Rotator
            .acquire({
              sessionId,
              activeProxyUrls: getActiveProxyUrls(
                this.active,
                this.proxyAssignments,
              ),
            })
            .catch(() => null);
        } else {
          // Select from our static pool but avoid failed proxies
          const reserved = getActiveProxyUrls(
            this.active,
            this.proxyAssignments,
          );
          const avoid = new Set([...reserved, ...this.failedProxyUrls]);
          currentSelection = selectProxySelection(
            sessionId,
            this.proxyPool,
            this.proxyFallback,
            avoid,
            sessionProxyUrl,
          );
        }

        if (!currentSelection || !currentSelection.proxyUrl) break;
      }

      if (!healthy) {
        this.store.appendLog(
          sessionId,
          "warn",
          "No healthy proxy found after preflight; launching without proxy for this session",
        );
        proxySelection = {
          proxyUrl: "",
          proxyIndex: null,
          proxySource: "none",
        };
      }
    }

    this.proxyAssignments.set(sessionId, proxySelection);
    const finalProxyUrl = proxySelection?.proxyUrl || "";
    if (finalProxyUrl) {
      env.VISA_PROXY_URL = finalProxyUrl;
      delete env.VISA_PROXY_SERVER;
    } else {
      delete env.VISA_PROXY_URL;
      delete env.VISA_PROXY_SERVER;
      delete env.VISA_PROXY_BYPASS;
      this.store.appendLog(
        sessionId,
        "warn",
        this.proxyMode === "direct"
        ? "Direct connection requested (VISA_PROXY_MODE=direct); all configured proxies are bypassed"
        : "No proxy configured for this session; it will use the local IP",
      );
    }

    this.store.appendLog(
      sessionId,
      "info",
      `Final proxy decision: ${describeProxySelection(proxySelection)}`,
    );

    const launchSession = this.store.getSession(sessionId);
    if (!launchSession || launchSession.status === "STOPPED") {
      this._releaseAccountLock(sessionId);
      this.monitor.remove(sessionId);
      return;
    }

    if (this.shuttingDown || this.store.getSession(sessionId)?.status === "STOPPED") {
      this._releaseAccountLock(sessionId);
      this._releaseProxyAssignment(sessionId);
      this.monitor.remove(sessionId);
      return;
    }
    const child = this.forkWorker(this.workerEntry, [], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    this.active.set(sessionId, child);
    this.hunting.add(sessionId);
    this.store.setRuntime(sessionId, {
      pid: child.pid,
      exitCode: null,
      signal: null,
    });
    logSessionLifecycle(
      sessionId,
      session,
      "Started session",
      child.pid
        ? `${describeProxySelection(proxySelection)}; pid ${child.pid}`
        : describeProxySelection(proxySelection),
    );

    const reader = (level) => createLineReader((line) => {
      if (!this.shuttingDown && this.active.get(sessionId) === child) this.monitor.update(sessionId);
      this.store.appendLog(sessionId, level, line);
      logWorkerToBackendConsole(sessionId, session, level, line);
    });
    const stdout = reader("info");
    const stderr = reader("error");
    child.stdout?.on("data", (buf) => stdout.write(buf));
    child.stderr?.on("data", (buf) => stderr.write(buf));
    child.stdout?.once("end", () => stdout.end());
    child.stderr?.once("end", () => stderr.end());
    child.once("close", () => { stdout.end(); stderr.end(); });

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hunt_slot_released" || msg.type === "hunt_resume_requested") {
        this._handleHuntControl(sessionId, child, msg);
        return;
      }
      if (this.stopping.has(sessionId)) return;
      if (msg.type === "status" && msg.state === "PAUSED" && this.store.getSession(sessionId)?.status === "COMPLETED") return;
      if (msg.type === "status") {
        const { state, message } = msg;
        this.monitor.update(sessionId, state);

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
          session,
          "info",
          `STATUS ${safeOneLine(state)}${message ? ` - ${safeOneLine(message)}` : ""}`,
        );

        // Map worker state to session status
        if (state === "BLOCKED") {
          this.store.setStatus(sessionId, "BLOCKED", message || "Blocked");
        } else if (state === "COMPLETED") {
          this.store.setStatus(sessionId, "COMPLETED", message || "Completed");

          if (
            this.desktopNotificationsEnabled &&
            !this.notifiedDesktopSuccess.has(sessionId)
          ) {
            this.notifiedDesktopSuccess.add(sessionId);
            const desktop = this.desktopNotificationService;
            if (desktop && typeof desktop.notifyBookingSuccess === "function") {
              const ctx = this.bookingContext.get(sessionId) || {};
              desktop
                .notifyBookingSuccess({ session, booking: { ...ctx } })
                .then((result) => {
                  this.store.appendLog(
                    sessionId,
                    result?.sent ? "info" : "warn",
                    result?.sent
                      ? "Desktop booking notification sent"
                      : `Desktop booking notification not sent: ${safeOneLine(result?.reason || "unknown error")}`,
                  );
                })
                .catch((error) => {
                  this.store.appendLog(
                    sessionId,
                    "warn",
                    `Desktop booking notification failed: ${safeOneLine(error?.message || error)}`,
                  );
                });
            }
          }

          // Notifications are paused for now; keep the completion state but do
          // not send success emails until the feature is re-enabled.
          if (
            this.notificationsEnabled &&
            !this.notifiedSuccess.has(sessionId)
          ) {
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
        } else if (state === "FINAL_ACTION_CLICKED") {
          // Keep session as RUNNING but optionally emit a lightweight click
          // notification to administrators (confirmation pending).
          this.store.setStatus(
            sessionId,
            "RUNNING",
            message || String(state || "RUNNING"),
          );

          if (this.notificationsEnabled && !this.notifiedClick.has(sessionId)) {
            this.notifiedClick.add(sessionId);
            const svc = this.notificationService;
            if (svc && typeof svc.enqueueBookingClick === "function") {
              const ctx = this.bookingContext.get(sessionId) || {};
              const queued = svc.enqueueBookingClick({
                sessionId,
                session,
                booking: { ...ctx },
              });

              if (queued) {
                this.store.appendLog(
                  sessionId,
                  "info",
                  "Queued click notification to administrators",
                );
              } else {
                this.store.appendLog(
                  sessionId,
                  "warn",
                  "Failed to queue click notification (queue full)",
                );
              }
            } else {
              this.store.appendLog(
                sessionId,
                "warn",
                "Email notifications not configured on server (click)",
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
        this.monitor.update(sessionId);
        this.store.appendLog(sessionId, msg.level || "info", msg.message || "");

        logWorkerToBackendConsole(
          sessionId,
          session,
          msg.level || "info",
          `LOG ${safeOneLine(msg.level || "info")} - ${safeOneLine(msg.message || "")}`,
        );
      }
    });

    child.on("exit", (code, signal) => {
      const wasStopped = this.stopping.has(sessionId);
      this.monitor.remove(sessionId);
      this.active.delete(sessionId);
      this.hunting.delete(sessionId);
      this.renewals.delete(sessionId);
      this.stopping.delete(sessionId);
      this.dequeue(sessionId);
      this._releaseProxyAssignment(sessionId);
      this._releaseAccountLock(sessionId);
      this.bookingContext.delete(sessionId);
      this.notifiedSuccess.delete(sessionId);
      this.notifiedClick.delete(sessionId);
      this.store.setRuntime(sessionId, { exitCode: code, signal });
      this.store.setQueueTimes(sessionId, { finishedAt: nowIso() });

      const current = this.store.getSession(sessionId);
      if (wasStopped) {
        this.store.setStatus(sessionId, "STOPPED", "Stopped");
      } else if (current?.status === "BLOCKED") {
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

module.exports = { WorkerPool, resolveSessionExecutionMode };
