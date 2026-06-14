const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

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

// Preflight proxy health checks
const net = require("node:net");

const PREFLIGHT_TCP_TIMEOUT_MS = Math.max(
  1500,
  Number(process.env.PROXY_PREFLIGHT_TCP_TIMEOUT_MS) || 3000,
);
const PREFLIGHT_CONNECT_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.PROXY_PREFLIGHT_CONNECT_TIMEOUT_MS) || 4000,
);
const PREFLIGHT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.PROXY_PREFLIGHT_MAX_ATTEMPTS) || 3,
);

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", (err) => {
      try {
        sock.destroy();
      } catch {}
      reject(err);
    });
    sock.setTimeout(timeoutMs, () => {
      try {
        sock.destroy();
      } catch {}
      reject(new Error("tcp timeout"));
    });
  });
}

function httpConnectThroughProxy(proxyParsed, targetHost, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyHost = proxyParsed.hostname;
    const proxyPort = Number(
      proxyParsed.port || (proxyParsed.protocol === "https:" ? 443 : 80),
    );

    const sock = net.connect({ host: proxyHost, port: proxyPort }, () => {
      // Send a CONNECT request for TLS tunnel test
      const connectReq = `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\nConnection: close\r\n\r\n`;
      sock.write(connectReq);
    });

    let acc = "";
    const onData = (chunk) => {
      acc += String(chunk || "");
      // Stop after headers received
      if (acc.includes("\r\n\r\n")) {
        const statusLine = acc.split(/\r\n/)[0] || "";
        const m = statusLine.match(/HTTP\/\d\.\d\s+(\d{3})/);
        const code = m ? Number(m[1]) : 0;
        try {
          sock.destroy();
        } catch {}
        if (code >= 200 && code < 300) {
          resolve(true);
        } else {
          reject(new Error(`CONNECT failed ${code || statusLine}`));
        }
      }
    };

    const onError = (err) => {
      try {
        sock.destroy();
      } catch {}
      reject(err);
    };

    sock.on("data", onData);
    sock.on("error", onError);
    sock.setTimeout(timeoutMs, () => {
      try {
        sock.destroy();
      } catch {}
      reject(new Error("connect timeout"));
    });
  });
}

async function checkProxyHealth(proxyUrl, platformHost) {
  if (!proxyUrl) return { ok: false, reason: "no-proxy" };
  try {
    const parsed = new URL(proxyUrl);
    const proxyHost = parsed.hostname;
    const proxyPort = Number(
      parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    );

    // Basic TCP reachability
    await tcpConnect(proxyHost, proxyPort, PREFLIGHT_TCP_TIMEOUT_MS);

    // Try CONNECT to platform host and to Google (recaptcha) as a probe.
    const targets = [platformHost || "www.google.com", "www.google.com"];
    for (const t of targets) {
      // if CONNECT fails, throw
      // eslint-disable-next-line no-await-in-loop
      await httpConnectThroughProxy(parsed, t, PREFLIGHT_CONNECT_TIMEOUT_MS);
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
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

    /** @type {Map<string, {dateKey?: string, timeSlot?: string}>} */
    this.bookingContext = new Map();

    /** @type {Set<string>} */
    this.notifiedSuccess = new Set();

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
      this.store.appendLog(sessionId, "warn", "Stopping worker (SIGTERM)");
      logSessionLifecycle(sessionId, session, "Stopping session");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      return true;
    }

    this._releaseAccountLock(sessionId);
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

  _releaseProxyAssignment(sessionId) {
    this.proxyAssignments.delete(sessionId);
  }

  _tick() {
    if (this.active.size + this.starting.size >= this.maxConcurrent) {
      return;
    }

    if (this.starting.size > 0) {
      return;
    }

    const nextId = this.queue.shift();
    if (!nextId) return;

    this.starting.add(nextId);
    void this._startSession(nextId)
      .catch((err) => {
        this.store.appendLog(
          nextId,
          "error",
          `Worker start failed: ${String(err?.message || err)}`,
        );
        this._releaseAccountLock(nextId);
      })
      .finally(() => {
        this.starting.delete(nextId);
        this._tick();
      });
  }

  async _startSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      this._releaseAccountLock(sessionId);
      return;
    }
    if (session.status === "STOPPED" || session.status === "BLOCKED") {
      this._releaseAccountLock(sessionId);
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
      VISA_EXECUTION_MODE:
        process.env.VISA_EXECUTION_MODE || process.env.VISA_WORKER_MODE || "dom",

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
    let proxySelection = await this.proxy11Rotator
      .acquire({ sessionId, activeProxyUrls: reservedProxyUrls })
      .catch(() => null);

    const currentSession = this.store.getSession(sessionId);
    if (!currentSession || currentSession.status === "STOPPED") {
      this._releaseAccountLock(sessionId);
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

      proxySelection = sessionProxyUrl
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
          const result = await checkProxyHealth(
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
        "No proxy configured for this session; it will use the local IP",
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
      return;
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
      child.pid
        ? `${describeProxySelection(proxySelection)}; pid ${child.pid}`
        : describeProxySelection(proxySelection),
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
      this._releaseProxyAssignment(sessionId);
      this._releaseAccountLock(sessionId);
      this.bookingContext.delete(sessionId);
      this.notifiedSuccess.delete(sessionId);
      this.notifiedClick.delete(sessionId);
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
