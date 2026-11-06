const { chromium } = require("playwright");
const { isCertificateError, certificateFailure } = require("../src/queue/proxyHealth");
const {
  createHuntWindow,
  HuntWindowExpiredError,
  createResumeGate,
} = require("../src/services/visaApi/huntWindow");

function isPerfTraceEnabled(value) {
  return value === "1";
}

try {
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch {
  // ignore
}

const {
  VisaApiClient,
  VisaApiUnauthorizedError,
  VisaApiForbiddenError,
  VisaApiRateLimitedError,
  VisaSlotConflictError,
  VisaPlatformUnavailableError,
  VisaNoDatesAvailableError,
  VisaNoSlotsAvailableError,
  VisaBookingVerificationError,
  VisaApiContractError,
  VisaApplicationNotFoundError,
  createNetworkCapture,
  captureVisaSession,
  tokenExpiresSoon,
  computeDateWindow,
  normalizeAvailableDates,
  selectAvailableDate,
  monthRangeFor,
  buildMonthScanPlan,
  formatAppointmentTime,
  listUsableSlots,
  createScanScheduler,
  createScanStats,
  mapInBatches,
  buildAppointmentPayload,
  fingerprintAttempt,
  appointmentMatchesSubmission,
  resolveApplicantContext,
  buildAvailabilityContext,
  contextDiagnostics,
  bootstrapAppointmentSurface,
  shouldRunContextBootstrap,
  parseIsoDateOnly,
  redact,
  savePortalSession,
  loadPortalSession,
  clearPortalSession,
  seedPortalSessionStorage,
  createLoginAutoSubmitter,
} = require("../src/services/visaApi");

const CONFIG = {
  SESSION_ID: process.env.VISA_SESSION_ID || "",
  PLATFORM_URL:
    process.env.VISA_PLATFORM_URL ||
    "https://www.usvisaappt.com/visaapplicantui/login",
  USER_EMAIL: process.env.VISA_USER_EMAIL || "",
  USER_PASSWORD: process.env.VISA_USER_PASSWORD || "",
  USER_DISPLAY_NAME: process.env.VISA_USER_DISPLAY_NAME || "",
  RESCHEDULE:
    process.env.VISA_RESCHEDULE === "1" ||
    process.env.VISA_RESCHEDULE === "true",
  PROFILE_DIR: process.env.VISA_PROFILE_DIR || "",
  PROXY_URL: process.env.VISA_PROXY_URL || process.env.VISA_PROXY_SERVER || "",
  PROXY_BYPASS: process.env.VISA_PROXY_BYPASS || "",
  LOGIN_WAIT_TIMEOUT_MS: Math.max(
    60_000,
    Number(process.env.VISA_LOGIN_WAIT_TIMEOUT_MS) || 15 * 60 * 1000,
  ),
  LOGIN_NAV_TIMEOUT_MS: Math.max(
    120_000,
    Number(process.env.VISA_LOGIN_NAV_TIMEOUT_MS) || 3 * 60 * 1000,
  ),
  ATTEMPT_INTERVAL_MS: Math.max(
    500,
    Number(process.env.VISA_ATTEMPT_INTERVAL_MS) || 2000,
  ),
  CONTEXT_RETRY_MS: Math.max(
    5000,
    Number(process.env.VISA_CONTEXT_RETRY_MS) || 30_000,
  ),
  CONTEXT_BOOTSTRAP_TIMEOUT_MS: Math.max(
    3000,
    Number(process.env.VISA_CONTEXT_BOOTSTRAP_TIMEOUT_MS) || 60_000,
  ),
  DATE_START: process.env.VISA_MIN_DATE || process.env.VISA_DATE_START || "",
  DATE_END: process.env.VISA_MAX_DATE || process.env.VISA_DATE_END || "",
  DAYS_FROM_NOW_MIN: process.env.VISA_DAYS_FROM_NOW_MIN || "",
  DAYS_FROM_NOW_MAX: process.env.VISA_DAYS_FROM_NOW_MAX || "",
  WEEKS_FROM_NOW_MIN: process.env.VISA_WEEKS_FROM_NOW_MIN || "",
  WEEKS_FROM_NOW_MAX: process.env.VISA_WEEKS_FROM_NOW_MAX || "",
  EXACT_DATE: process.env.VISA_EXACT_DATE || "",
  EXACT_DATE_FALLBACK:
    process.env.VISA_EXACT_DATE_FALLBACK ||
    process.env.VISA_DATE_FALLBACK_STRATEGY ||
    "EXACT_ONLY",
  ALLOW_SAME_DATE_RESCHEDULE:
    process.env.VISA_ALLOW_SAME_DATE_RESCHEDULE === "1" ||
    process.env.VISA_ALLOW_SAME_DATE_RESCHEDULE === "true",
  SELECTED_POST_USER_ID: String(
    process.env.VISA_SELECTED_POST_USER_ID || process.env.VISA_POST_USER_ID || "483",
  ),
  PERF_TRACE: isPerfTraceEnabled(process.env.VISA_PERF_TRACE),
  FIRST_MONTH_POLL_MS: Math.max(
    250,
    Number(process.env.VISA_FIRST_MONTH_POLL_MS) || 750,
  ),
  SCAN_JITTER_MS: Math.max(0, Number(process.env.VISA_SCAN_JITTER_MS) || 100),
  SCAN_TIMEOUT_MS: Math.max(
    1000,
    Number(process.env.VISA_SCAN_TIMEOUT_MS) || 4000,
  ),
  HEARTBEAT_MS: Math.max(
    1000,
    Number(process.env.VISA_HEARTBEAT_MS) || 10_000,
  ),
  DATE_LOOKUP_CONCURRENCY: Math.max(
    1,
    Number(process.env.VISA_DATE_LOOKUP_CONCURRENCY) || 3,
  ),
  API_MAX_MONTHS: Math.max(1, Number(process.env.VISA_API_MAX_MONTHS) || 12),
  SLOT_LOOKUP_CONCURRENCY: Math.max(
    1,
    Number(process.env.VISA_SLOT_LOOKUP_CONCURRENCY) || 2,
  ),
  CONFLICT_FALLBACK_LIMIT: Math.max(
    0,
    Number(process.env.VISA_CONFLICT_FALLBACK_LIMIT ?? 2) || 0,
  ),
  // auto = direct keep-alive HTTP for reads when no proxy is configured,
  // otherwise Playwright so reads keep using the browser's proxy.
  READ_TRANSPORT: String(process.env.VISA_READ_TRANSPORT || "auto").toLowerCase(),
  TOKEN_REFRESH_LEAD_MS: Math.max(
    60_000,
    Number(process.env.VISA_TOKEN_REFRESH_LEAD_MS) || 120_000,
  ),
  SLOW_CONNECTION_MS: Math.max(
    200,
    Number(process.env.VISA_SLOW_CONNECTION_MS) || 1200,
  ),
  // Click Sign In as soon as the person has solved the CAPTCHA.
  AUTO_SUBMIT_LOGIN: process.env.VISA_AUTO_SUBMIT_LOGIN !== "0",
  // Reuse a still-valid portal session saved by an earlier run.
  RESTORE_SESSION: process.env.VISA_RESTORE_SESSION !== "0",
  RESTORE_CHECK_MS: 5000,
};

// Hot-path reads fail fast: the next scheduled scan is the retry.
const SCAN_REQUEST_OPTIONS = {
  maxAttempts: 1,
  timeoutMs: CONFIG.SCAN_TIMEOUT_MS,
};
const LOOKUP_REQUEST_OPTIONS = {
  maxAttempts: 2,
  retryDelaysMs: [150],
  timeoutMs: CONFIG.SCAN_TIMEOUT_MS,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startPerfTrace() {
  return CONFIG.PERF_TRACE ? Date.now() : null;
}

function perfTrace(operation, startedAt, context = {}) {
  if (!CONFIG.PERF_TRACE || startedAt == null) return;
  console.log(
    JSON.stringify({
      type: "visa_perf",
      mode: "api",
      operation,
      durationMs: Date.now() - startedAt,
      ...context,
    }),
  );
}

function sendWorkerMessage(message) {
  try {
    if (typeof process.send === "function") {
      process.send(message);
    }
  } catch {
    // Never let IPC block the worker.
  }
}

function status(state, message) {
  // eslint-disable-next-line no-console
  if (typeof process.send !== "function" || process.connected === false) {
    console.log(`[${state}] ${message}`);
  }
  sendWorkerMessage({
    type: "status",
    sessionId: CONFIG.SESSION_ID,
    executionMode: "api",
    state,
    message,
  });
}

function log(level, message) {
  sendWorkerMessage({
    type: "log",
    sessionId: CONFIG.SESSION_ID,
    executionMode: "api",
    level,
    message,
  });
}

function formatApiError(error) {
  const operation = error?.operation ? `${error.operation}: ` : "";
  const statusCode = error?.status ? `HTTP ${error.status} - ` : "";
  return `${operation}${statusCode}${error?.message || String(error)}`;
}

function normalizeProxyUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function buildProxyConfig() {
  if (String(process.env.VISA_PROXY_MODE || "").trim().toLowerCase() === "direct") return null;
  const normalized = normalizeProxyUrl(CONFIG.PROXY_URL);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const proxy = { server: `${parsed.protocol}//${parsed.host}` };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    if (CONFIG.PROXY_BYPASS) proxy.bypass = CONFIG.PROXY_BYPASS;
    return proxy;
  } catch (error) {
    log("warn", `Invalid proxy URL ignored: ${String(error?.message || error)}`);
    return null;
  }
}

function getBaseUrl() {
  const url = new URL(CONFIG.PLATFORM_URL);
  return url.origin;
}

function getAppBaseUrl() {
  const u = new URL(CONFIG.PLATFORM_URL);
  const marker = "/visaapplicantui";
  const idx = u.pathname.indexOf(marker);
  const basePath = idx >= 0 ? u.pathname.slice(0, idx + marker.length) : "";
  return `${u.origin}${basePath}`;
}

async function launchBrowser() {
  status(
    "LOGIN_BROWSER_STARTING",
    "Visible Chrome for API session bridge",
  );

  const launchOptions = {
    headless: false,
    channel: "chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-notifications",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  };

  const proxyConfig = buildProxyConfig();
  if (proxyConfig) {
    launchOptions.proxy = proxyConfig;
    status("LOGIN_BROWSER_STARTING", "Proxy configured for API session");
  }

  if (CONFIG.PROFILE_DIR) {
    const context = await chromium.launchPersistentContext(
      CONFIG.PROFILE_DIR,
      launchOptions,
    );
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(CONFIG.LOGIN_NAV_TIMEOUT_MS);
    return { browser: null, context, page };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(CONFIG.LOGIN_NAV_TIMEOUT_MS);
  return { browser, context, page };
}

async function waitForLoginSurface(page, timeoutMs = CONFIG.LOGIN_WAIT_TIMEOUT_MS) {
  if (/dashboard/i.test(page.url())) return "dashboard";

  const usernameWait = page
    .locator('input[formcontrolname="username"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => "login")
    .catch(() => null);

  const passwordWait = page
    .locator('input[formcontrolname="password"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => "login")
    .catch(() => null);

  const dashboardWait = page
    .waitForURL(/dashboard/i, { timeout: timeoutMs })
    .then(() => "dashboard")
    .catch(() => null);

  const displayNameWait = CONFIG.USER_DISPLAY_NAME
    ? page
        .getByText(CONFIG.USER_DISPLAY_NAME, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs })
        .then(() => "dashboard")
        .catch(() => null)
    : Promise.resolve(null);

  return Promise.race([
    usernameWait,
    passwordWait,
    dashboardWait,
    ...(CONFIG.USER_DISPLAY_NAME ? [displayNameWait] : []),
  ]);
}

const manualSignIns = new WeakMap();

async function trackManualSignIn(page) {
  if (manualSignIns.has(page)) return manualSignIns.get(page);
  const intent = { submitted: false };
  await page.exposeBinding("__lightingBotHourlySignIn", ({ frame }) => {
    if (frame === page.mainFrame()) intent.submitted = true;
  });
  const install = () => {
    if (window.__lightingBotHourlyListener) return;
    window.__lightingBotHourlyListener = true;
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('button, input[type="submit"]')
        : null;
      if (
        event.isTrusted && button &&
        /^sign\s*in$/i.test((button.textContent || button.value || "").trim())
      ) {
        window.__lightingBotHourlySignIn();
      }
    }, true);
  };
  await page.addInitScript(install);
  await page.evaluate(install);
  manualSignIns.set(page, intent);
  return intent;
}

async function waitForLoginOrDashboard(
  page,
  timeoutMs = CONFIG.LOGIN_WAIT_TIMEOUT_MS,
  { manual = false, huntWindow = null, intent = null } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const autoSubmit = !manual && CONFIG.AUTO_SUBMIT_LOGIN
    ? createLoginAutoSubmitter(page)
    : null;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Login browser was closed");
    huntWindow?.assertOpen();
    if ((!manual || intent?.submitted) && /dashboard/i.test(page.url())) return;

    // eslint-disable-next-line no-await-in-loop
    if (autoSubmit && (await autoSubmit())) {
      status("LOGIN_SUBMITTED", "Sign In clicked automatically");
    }

    if ((!manual || intent?.submitted) && CONFIG.USER_DISPLAY_NAME) {
      // eslint-disable-next-line no-await-in-loop
      const visible = await page
        .getByText(CONFIG.USER_DISPLAY_NAME, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return;
    }

    // Start the API handoff on the first authenticated browser tick.
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(100).catch(() => {});
  }
  throw new Error("Login wait timed out.");
}

async function login(page, { manual = false, huntWindow = null } = {}) {
  huntWindow?.assertOpen();
  const intent = manual ? await trackManualSignIn(page) : null;
  const timeout = (limit) => huntWindow
    ? Math.max(1, Math.min(limit, huntWindow.remaining()))
    : limit;
  status("WAITING_FOR_LOGIN", "Opening visa login page");

  try {
    await page.goto(CONFIG.PLATFORM_URL, {
      waitUntil: "commit",
      timeout: timeout(CONFIG.LOGIN_NAV_TIMEOUT_MS),
    });
  } catch (error) {
    if (isCertificateError(error)) throw certificateFailure();
    status(
      "WAITING_FOR_LOGIN",
      `Login page is loading slowly; waiting for a usable surface (${String(
        error?.message || error,
      )})`,
    );
  }

  huntWindow?.assertOpen();
  const surface = await waitForLoginSurface(page, timeout(CONFIG.LOGIN_WAIT_TIMEOUT_MS));
  huntWindow?.assertOpen();
  if (surface === "dashboard" && !manual) {
    status("SESSION_CAPTURED", "Dashboard already authenticated");
    return;
  }

  if (surface !== "login" && !manual) {
    throw new Error("Login page did not become ready.");
  }

  if (surface === "login" && CONFIG.USER_EMAIL) {
    await page
      .locator('input[formcontrolname="username"]')
      .fill(CONFIG.USER_EMAIL, { timeout: timeout(30000) });
  }

  if (surface === "login" && CONFIG.USER_PASSWORD) {
    await page
      .locator('input[formcontrolname="password"]')
      .fill(CONFIG.USER_PASSWORD, { timeout: timeout(30000) });
  }

  status(
    "WAITING_FOR_CAPTCHA",
    manual
      ? "Hunting paused after one hour. Complete CAPTCHA and press Sign In to continue"
      : CONFIG.AUTO_SUBMIT_LOGIN
        ? "Credentials filled; signing in automatically"
        : "Credentials filled; complete CAPTCHA and sign in",
  );
  await waitForLoginOrDashboard(
    page,
    manual ? Infinity : CONFIG.LOGIN_WAIT_TIMEOUT_MS,
    { manual, huntWindow, intent },
  );
  status("SESSION_CAPTURED", "Dashboard authenticated");
}

async function openDashboard(page) {
  const dashboardUrl = `${getAppBaseUrl()}/dashboard`;
  if (/\/dashboard/i.test(page.url())) return;
  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForURL(/dashboard/i, { timeout: 20000 }).catch(() => {});
}

// Waits for the dashboard to settle: navigating straight to /dashboard puts it
// in the URL even when the portal is about to redirect back to login.
async function dashboardStaysAuthenticated(page, timeoutMs) {
  const loginShown = await page
    .locator('input[formcontrolname="username"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  return !loginShown && /dashboard/i.test(page.url());
}

async function tryRestoreSavedSession({ page, context, networkState }) {
  if (!CONFIG.RESTORE_SESSION || !CONFIG.PROFILE_DIR) return null;
  const saved = await loadPortalSession({
    profileDir: CONFIG.PROFILE_DIR,
    minRemainingMs: CONFIG.TOKEN_REFRESH_LEAD_MS,
  });
  if (!saved) return null;

  status("SESSION_RESTORING", "Checking saved portal session");
  const probe = new VisaApiClient({
    context,
    auth: saved.auth,
    baseUrl: getBaseUrl(),
    readTransport: "playwright",
  });
  try {
    await probe.getAuthenticatedUser({
      maxAttempts: 1,
      timeoutMs: CONFIG.RESTORE_CHECK_MS,
    });
  } catch (error) {
    log("info", `Saved portal session not accepted; signing in: ${formatApiError(error)}`);
    await clearPortalSession(CONFIG.PROFILE_DIR);
    return null;
  }

  await seedPortalSessionStorage(context, saved);
  const navStartedAt = Date.now();
  await page
    .goto(`${getAppBaseUrl()}/dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.LOGIN_NAV_TIMEOUT_MS,
    })
    .catch(() => {});
  const navMs = Date.now() - navStartedAt;
  if (!(await dashboardStaysAuthenticated(page, CONFIG.RESTORE_CHECK_MS))) {
    log(
      "info",
      `Portal did not accept the saved session in the browser; signing in (navMs=${navMs} url=${page.url().split("?")[0]})`,
    );
    await clearPortalSession(CONFIG.PROFILE_DIR);
    return null;
  }

  const auth = await captureVisaSession({
    page,
    context,
    networkState,
    bookingUserId: CONFIG.SESSION_ID,
  });
  if (!auth.authorizationHeader) return null;
  status("SESSION_CAPTURED", "Saved portal session restored; login skipped");
  return auth;
}

let pendingSessionSave = Promise.resolve();
function persistPortalSession(page, auth) {
  if (!CONFIG.RESTORE_SESSION || !CONFIG.PROFILE_DIR) return;
  pendingSessionSave = pendingSessionSave
    .then(() => savePortalSession({ profileDir: CONFIG.PROFILE_DIR, page, auth }))
    .catch((error) => {
      log("warn", `Could not save portal session: ${error.message}`);
    });
}

async function establishApiSession({
  page, context, networkState,
  allowRestore = false, manual = false, huntWindow = null,
}) {
  if (allowRestore) {
    const restored = await tryRestoreSavedSession({ page, context, networkState }).catch(
      (error) => {
        log("warn", `Saved session restore failed: ${error.message}`);
        return null;
      },
    );
    if (restored) return restored;
  }

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      huntWindow?.assertOpen();
      await login(page, { manual, huntWindow });
      await openDashboard(page);

      const auth = await captureVisaSession({
        page,
        context,
        networkState,
        bookingUserId: CONFIG.SESSION_ID,
      });
      if (!auth.authorizationHeader) {
        throw new VisaApiUnauthorizedError(
          "Platform auth token was not captured from sessionStorage or headers",
        );
      }
      if (manual) {
        // A dashboard URL/token alone is insufficient to join the queue.
        const probe = new VisaApiClient({ context, page, auth, baseUrl: getBaseUrl() });
        await probe.getAuthenticatedUser({ maxAttempts: 1, timeoutMs: 5000 });
      }
      log("info", `Authenticated page: ${String(auth.storageUrl || "").split("?")[0]}`);
      return auth;
    } catch (error) {
      if (page.isClosed() || error instanceof HuntWindowExpiredError || error?.code === "VISA_TLS_CERTIFICATE_ERROR") throw error;
      if (manual && error instanceof VisaApiUnauthorizedError) {
        // A rejected token must not leave renewal stuck on a dashboard whose
        // browser state would immediately bypass the prefilled login form.
        await page.evaluate(() => {
          window.sessionStorage.clear();
          window.localStorage.clear();
        });
        await context.clearCookies();
        Object.assign(networkState, createNetworkCapture().state);
        manualSignIns.get(page).submitted = false;
      }
      status(
        "SESSION_BRIDGE_RETRY",
        `Authenticated API handoff attempt ${attempt} was not ready; retaining Chrome and retrying`,
      );
      log("warn", formatApiError(error));
      // eslint-disable-next-line no-await-in-loop
      await (huntWindow ? huntWindow.wait(CONFIG.ATTEMPT_INTERVAL_MS) : sleep(CONFIG.ATTEMPT_INTERVAL_MS));
    }
  }
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getDatePreferencesSnapshot() {
  return computeDateWindow({
    dateStart: CONFIG.DATE_START,
    dateEnd: CONFIG.DATE_END,
    daysFromNowMin: numberOrNull(CONFIG.DAYS_FROM_NOW_MIN),
    daysFromNowMax: numberOrNull(CONFIG.DAYS_FROM_NOW_MAX),
    weeksFromNowMin: numberOrNull(CONFIG.WEEKS_FROM_NOW_MIN),
    weeksFromNowMax: numberOrNull(CONFIG.WEEKS_FROM_NOW_MAX),
    now: new Date(),
  });
}

async function resolveContext({ client, networkState, page, bootstrapCache }) {
  status("RESOLVING_APPLICATION", "Resolving user and appointment context");

  if (!bootstrapCache.user) {
    bootstrapCache.user = await client.getAuthenticatedUser();
  }
  const bootstrapPieces = [bootstrapCache.user];
  if (bootstrapCache.history) bootstrapPieces.push(bootstrapCache.history);
  const resolverInput = {
    client,
    mode: CONFIG.RESCHEDULE ? "reschedule" : "pending",
    networkState,
    appointmentRecords: bootstrapCache.appointments || [],
  };

  let resolved;
  try {
    resolved = await resolveApplicantContext({
      ...resolverInput,
      bootstrapData: bootstrapPieces,
    });
  } catch (initialError) {
    if (!bootstrapCache.historyAttempted) {
      bootstrapCache.historyAttempted = true;
      bootstrapCache.history = await client
        .getUserHistoryApplicantPaymentStatus({
          maxAttempts: 1,
          timeoutMs: 3000,
        })
        .catch((error) => {
          log("warn", `Optional context fallback unavailable: ${error.message}`);
          return null;
        });
      if (bootstrapCache.history) bootstrapPieces.push(bootstrapCache.history);
    }

    try {
      resolved = await resolveApplicantContext({
        ...resolverInput,
        bootstrapData: bootstrapPieces,
      });
    } catch {
      if (
        shouldRunContextBootstrap(
          bootstrapCache,
          Date.now(),
          CONFIG.CONTEXT_RETRY_MS,
        )
      ) {
        bootstrapCache.browserAttemptedAt = Date.now();
        const before = contextDiagnostics({
          ...resolverInput,
          bootstrapData: bootstrapPieces,
        });
        status(
          "CONTEXT_BOOTSTRAP",
          `Opening ${resolverInput.mode} appointment surface; missing=${before.missingFields.join(",") || "appointment record"}`,
        );
        const browserBootstrap = await bootstrapAppointmentSurface({
          page,
          appBaseUrl: getAppBaseUrl(),
          mode: resolverInput.mode,
          timeoutMs: CONFIG.CONTEXT_BOOTSTRAP_TIMEOUT_MS,
          userDisplayName: CONFIG.USER_DISPLAY_NAME,
          userEmail: CONFIG.USER_EMAIL,
          status,
        }).catch((error) => {
          error.contextDiagnostics = contextDiagnostics({ ...resolverInput, bootstrapData: bootstrapPieces });
          throw error;
        });
        bootstrapCache.appointments = browserBootstrap.body;
        resolverInput.appointmentRecords = browserBootstrap.body;
        bootstrapPieces.push(browserBootstrap.body);
        log(
          "info",
          `Context browser bootstrap captured=${browserBootstrap.captured} status=${browserBootstrap.status ?? "none"}`,
        );
      }

      resolved = await resolveApplicantContext({
        ...resolverInput,
        bootstrapData: bootstrapPieces,
        allowDirectSearch: true,
      }).catch((error) => {
        const diagnostics = contextDiagnostics({
          ...resolverInput,
          bootstrapData: bootstrapPieces,
        });
        error.contextDiagnostics = diagnostics;
        throw error;
      });
    }
  }

  const selectedAppointment = {
    ...resolved.appointment,
    postUserId: CONFIG.SELECTED_POST_USER_ID,
  };
  const availability = buildAvailabilityContext(selectedAppointment, {
    postUserIdOverride: CONFIG.SELECTED_POST_USER_ID,
  });

  status(
    "CONTEXT_SOURCE_SELECTED",
    `Appointment context ready from ${resolved.source || "resolved_api_record"}; mode=${resolverInput.mode}`,
  );

  return {
    user: bootstrapCache.user,
    bootstrapData: bootstrapPieces,
    ...resolved,
    appointment: selectedAppointment,
    availability,
  };
}

function chooseNextDateCandidate({
  dates,
  window,
  currentAppointmentDate,
  preferences,
}) {
  const exactDate = parseIsoDateOnly(preferences.exactDate);
  const fallbackStrategy = exactDate
    ? preferences.exactDateFallback
    : "EARLIEST_ACCEPTABLE";
  return selectAvailableDate({
    availableDates: dates,
    minDate: window.minDate,
    maxDate: window.maxDate,
    exactDate,
    fallbackStrategy,
    mode: preferences.mode,
    currentAppointmentDate,
    allowSameDateReschedule: preferences.allowSameDateReschedule,
  });
}

// Every acceptable date in a month, in the order the date rules prefer them.
function orderDateCandidates({
  dates,
  window,
  currentAppointmentDate,
  preferences,
}) {
  const ordered = [];
  const tried = new Set();
  while (tried.size < dates.length) {
    const selection = chooseNextDateCandidate({
      dates: dates.filter((date) => !tried.has(date)),
      window,
      currentAppointmentDate,
      preferences,
    });
    if (!selection.selectedDate) break;
    tried.add(selection.selectedDate);
    ordered.push(selection.selectedDate);
  }
  return ordered;
}

// Fetches slot times for candidate dates in parallel batches and picks the
// most preferred date's earliest slot, regardless of which response arrived
// first. Other usable slots from the fetched dates become conflict fallbacks.
async function findSlotForCandidates({ client, context, candidates }) {
  const lookups = await mapInBatches(
    candidates,
    CONFIG.SLOT_LOOKUP_CONCURRENCY,
    async (selectedDate) => {
      const slotLookupRange = monthRangeFor(selectedDate);
      const slotsStartedAt = startPerfTrace();
      const slots = await client.getAvailableTimeSlots(
        context.availability,
        {
          slotDate: selectedDate,
          fromDate: slotLookupRange.fromDate,
          toDate: slotLookupRange.toDate,
        },
        LOOKUP_REQUEST_OPTIONS,
      );
      perfTrace("getAvailableTimeSlots", slotsStartedAt, {
        slotDate: selectedDate,
      });
      return { selectedDate, usableSlots: listUsableSlots(slots) };
    },
    { stopWhen: (batch) => batch.some((lookup) => lookup.usableSlots.length) },
  );

  const options = [];
  for (const { selectedDate, usableSlots } of lookups) {
    for (const selectedSlot of usableSlots) {
      options.push({ selectedDate, selectedSlot });
    }
  }
  if (!options.length) return null;

  const [best, ...rest] = options;
  status("DATE_SELECTED", best.selectedDate);
  status(
    "SLOT_SELECTED",
    `Time slot selected: ${formatAppointmentTime(best.selectedSlot.startTime)}`,
  );
  return {
    ...best,
    fallbacks: rest.slice(0, CONFIG.CONFLICT_FALLBACK_LIMIT),
  };
}

async function findDateAndSlot({
  client,
  context,
  preferences: overrides,
  scanStats,
}) {
  const perfStartedAt = startPerfTrace();
  try {
    const window = overrides?.window || getDatePreferencesSnapshot();
    const preferences = {
      exactDate: overrides?.exactDate ?? CONFIG.EXACT_DATE,
      exactDateFallback:
        overrides?.exactDateFallback ?? CONFIG.EXACT_DATE_FALLBACK,
      mode: overrides?.mode || (CONFIG.RESCHEDULE ? "reschedule" : "pending"),
      allowSameDateReschedule:
        overrides?.allowSameDateReschedule ?? CONFIG.ALLOW_SAME_DATE_RESCHEDULE,
    };
    const currentAppointmentDate = parseIsoDateOnly(
      context.appointment.appointmentDt,
    );

    const firstMonthStartedAt = Date.now();
    const firstMonth = await client.getFirstAvailableMonth(
      context.availability,
      SCAN_REQUEST_OPTIONS,
    );
    perfTrace("getFirstAvailableMonth", firstMonthStartedAt);
    scanStats?.recordScan({
      latencyMs: Date.now() - firstMonthStartedAt,
      firstAvailableDate: firstMonth?.date || null,
    });
    if (!firstMonth?.present || !firstMonth?.date) {
      throw new VisaNoDatesAvailableError("No first available month returned");
    }
    const availabilitySeenAt = Date.now();

    // Months outside the window produce an empty plan, so no date calls are
    // made for them.
    const ranges = buildMonthScanPlan({
      firstAvailableDate: firstMonth.date,
      minDate: window.minDate,
      maxDate: window.maxDate,
    }).slice(0, CONFIG.API_MAX_MONTHS);
    if (!ranges.length) {
      throw new VisaNoDatesAvailableError(
        "First available month is outside the configured date window",
      );
    }

    let acceptableDateFound = false;
    const fetchDates = async (range) => {
      const availableDatesStartedAt = startPerfTrace();
      const rawDates = await client.getAvailableDates(
        context.availability,
        range,
        LOOKUP_REQUEST_OPTIONS,
      );
      perfTrace("getAvailableDates", availableDatesStartedAt, { range });
      return {
        range,
        availableDates: normalizeAvailableDates(rawDates).filter(
          (date) => date >= range.fromDate && date <= range.toDate,
        ),
      };
    };

    // Month lookups run in parallel batches, but each batch is evaluated in
    // chronological order so the earliest acceptable month always wins.
    for (
      let index = 0;
      index < ranges.length;
      index += CONFIG.DATE_LOOKUP_CONCURRENCY
    ) {
      // eslint-disable-next-line no-await-in-loop
      const months = await Promise.all(
        ranges
          .slice(index, index + CONFIG.DATE_LOOKUP_CONCURRENCY)
          .map(fetchDates),
      );

      for (const { range, availableDates } of months) {
        const candidates = orderDateCandidates({
          dates: availableDates,
          window,
          currentAppointmentDate,
          preferences,
        });
        if (!candidates.length) continue;
        acceptableDateFound = true;

        // eslint-disable-next-line no-await-in-loop
        const found = await findSlotForCandidates({
          client,
          context,
          candidates,
        });
        if (found) {
          perfTrace("availability_seen_to_slot_selected", availabilitySeenAt);
          return { ...found, searchRange: range, availabilitySeenAt };
        }
      }
    }

    if (!acceptableDateFound) {
      throw new VisaNoDatesAvailableError(
        "No acceptable dates available in configured date window",
      );
    }
    throw new VisaNoSlotsAvailableError(
      "Acceptable dates were found but none had usable slots",
    );
  } finally {
    perfTrace("findDateAndSlot", perfStartedAt);
  }
}

async function submitAndVerify({ client, context, selectedDate, selectedSlot }) {
  client.huntWindow?.assertOpen();
  const submissionMode = CONFIG.RESCHEDULE ? "reschedule" : "pending";
  const payload = buildAppointmentPayload({
    appointment: context.appointment,
    selectedDate,
    selectedSlot,
    mode: submissionMode,
  });
  const attempt = fingerprintAttempt({
    accountId: CONFIG.USER_EMAIL || CONFIG.SESSION_ID,
    payload,
  });

  status("SUBMITTING_BOOKING", "Submitting appointment through API");
  log("info", `Final API attempt prepared: ${JSON.stringify(redact(attempt))}`);

  let finalResponse = null;
  let finalError = null;

  try {
    finalResponse = CONFIG.RESCHEDULE
      ? await client.submitRescheduleAppointment(payload)
      : await client.submitPendingAppointment(payload);
  } catch (error) {
    if (error instanceof VisaSlotConflictError || error instanceof HuntWindowExpiredError) {
      throw error;
    }
    finalError = error;
    status(
      "BOOKING_OUTCOME_UNKNOWN",
      `Final request outcome requires verification: ${error.name || "Error"}`,
    );
  }

  const finalRecords = Array.isArray(finalResponse)
    ? finalResponse
    : finalResponse
      ? [finalResponse]
      : [];
  const finalVerified =
    finalRecords.find((appointment) =>
      appointmentMatchesSubmission(appointment, payload, { mode: submissionMode }),
    ) || null;
  if (finalVerified) {
    status(
      "VERIFYING_BOOKING",
      "Final booking response matched the selected appointment",
    );
    return { payload, appointment: finalVerified, finalResponse };
  }

  status(
    "VERIFYING_BOOKING",
    "Checking appointment search after an unconfirmed final response",
  );
  const appointments = await client
    .searchCurrentAppointments(payload.applicationId)
    .catch((error) => {
      log("warn", `Read-only booking verification failed: ${formatApiError(error)}`);
      return [];
    });
  const searchedMatch = appointments.find((appointment) =>
    appointmentMatchesSubmission(appointment, payload, { mode: submissionMode }),
  );
  if (searchedMatch) {
    return { payload, appointment: searchedMatch, finalResponse };
  }

  if (finalError) {
    throw new VisaBookingVerificationError(
      `Final mutation was not confirmed after read-only verification: ${formatApiError(finalError)}`,
      { responseBody: finalError.responseBody },
    );
  }

  status(
    "VERIFYING_BOOKING",
    "Final booking response did not match the selected appointment",
  );
  throw new VisaBookingVerificationError(
    "Final response did not match selected appointment",
    { responseBody: finalResponse },
  );
}

async function runApiHuntCycle({ client, context, scanStats }) {
  const perfStartedAt = startPerfTrace();
  const selection = await findDateAndSlot({
    client,
    context,
    scanStats,
  });
  perfTrace("api_hunt_before_final_submission", perfStartedAt, {
    result: "selection_ready",
  });

  // A 409 means another client took that slot. Each fallback is a different
  // slot from the same lookup, so no booking request is ever repeated.
  const candidates = [selection, ...(selection.fallbacks || [])];
  let lastConflict = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const { selectedDate, selectedSlot } = candidates.at(index);
    if (index > 0) {
      if (scanStats) scanStats.stats.fallbackAttempts += 1;
      status(
        "SLOT_FALLBACK",
        `Trying fallback ${index} of ${candidates.length - 1}: ${selectedDate} ${formatAppointmentTime(selectedSlot.startTime)}`,
      );
    }
    perfTrace("availability_seen_to_booking_sent", selection.availabilitySeenAt, {
      attempt: index + 1,
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      const verified = await submitAndVerify({
        client,
        context,
        selectedDate,
        selectedSlot,
      });
      status("COMPLETED", "API booking verified successfully");
      return verified;
    } catch (error) {
      if (!(error instanceof VisaSlotConflictError)) throw error;
      if (scanStats) scanStats.stats.conflicts += 1;
      lastConflict = error;
    }
  }
  throw lastConflict;
}

function emitScanHeartbeat(scanStats, scheduler) {
  const summary = scanStats.takeHeartbeat(CONFIG.HEARTBEAT_MS);
  if (!summary) return;
  const slow =
    summary.scans && summary.averageLatencyMs > CONFIG.SLOW_CONNECTION_MS
      ? `; slow connection (over ${CONFIG.SLOW_CONNECTION_MS} ms), check Wi-Fi, VPN or proxy`
      : "";
  status(
    "AVAILABILITY_SCAN_HEARTBEAT",
    `scans=${summary.scans} avgLatencyMs=${summary.averageLatencyMs} firstAvailable=${summary.lastFirstAvailableDate || "none"} throttle=${scheduler.throttleState} rateLimited=${summary.rateLimited} failures=${summary.failures} conflicts=${summary.conflicts} fallbacks=${summary.fallbackAttempts}${slow}`,
  );
}

// Re-reads the token from the page shortly before it expires, without pausing
// the scan loop. The page's own app refreshes its token, and the API worker
// also picks up rotated tokens from response headers.
function createBackgroundTokenRefresher(client) {
  let inFlight = null;
  let lastAttemptAt = 0;
  const refresh = () => {
    if (inFlight) return;
    if (!tokenExpiresSoon(client.auth, CONFIG.TOKEN_REFRESH_LEAD_MS)) return;
    if (Date.now() - lastAttemptAt < 15_000) return;
    lastAttemptAt = Date.now();
    const previousExpiry = client.auth.tokenExpiresAt;
    inFlight = client
      .refreshAuthFromPage()
      .then(() => {
        if (client.auth.tokenExpiresAt !== previousExpiry) {
          status("SESSION_REFRESHED", "Platform token refreshed in background");
          persistPortalSession(client.page, client.auth);
        }
      })
      .catch((error) => {
        log("warn", `Background token refresh failed: ${formatApiError(error)}`);
      })
      .finally(() => {
        inFlight = null;
      });
  };
  refresh.drain = () => inFlight || Promise.resolve();
  return refresh;
}

function resolveReadTransport() {
  if (CONFIG.READ_TRANSPORT === "fetch" || CONFIG.READ_TRANSPORT === "undici") {
    return "fetch";
  }
  if (CONFIG.READ_TRANSPORT === "playwright") return "playwright";
  return CONFIG.PROXY_URL ? "playwright" : "fetch";
}

function isRecoverableContextError(error) {
  return (
    error instanceof VisaApiContractError ||
    error instanceof VisaApplicationNotFoundError
  );
}

async function resetPortalAuthentication({ page, context, profileDir }) {
  await clearPortalSession(profileDir);
  const origin = new URL(CONFIG.PLATFORM_URL).origin;
  // Clear sessionStorage while still on the portal origin, then leave it so
  // its background scripts cannot repopulate local storage during cleanup.
  for (const tab of context.pages()) {
    if (new URL(tab.url()).origin === origin) {
      await tab.evaluate(() => { window.sessionStorage.clear(); window.localStorage.clear(); });
    }
    await tab.goto("about:blank");
  }
  await context.clearCookies();
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  } finally {
    await cdp.detach();
  }
  await context.close();
}

async function validateQueuedAuthentication(client, isExpired = tokenExpiresSoon) {
  if (isExpired(client.auth)) return false;
  try {
    await client.getAuthenticatedUser({ maxAttempts: 1, timeoutMs: 5000 });
    return !isExpired(client.auth);
  } catch (error) {
    if (error instanceof VisaApiUnauthorizedError) return false;
    throw error;
  }
}

async function main() {
  status("START", "Launching API booking worker");

  let { browser, context, page } = await launchBrowser();
  let capture = createNetworkCapture();
  const huntWindow = createHuntWindow();
  const resumeGate = createResumeGate();
  let renewalId = 0;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void (async () => {
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      process.exit(0);
    })();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("disconnect", shutdown);
  const onControl = (message) => {
    if (message?.type === "worker_stop") shutdown();
  };
  process.on("message", onControl);
  page.on("request", capture.rememberRequest);
  page.on("response", capture.rememberResponse);

  let client = null;
  let completionReported = false;
  let resolvedContext = null;
  let bootstrapCache = {
    user: null,
    history: null,
    historyAttempted: false,
    browserAttemptedAt: 0,
  };

  try {
    let auth = await establishApiSession({
      page,
      context,
      networkState: capture.state,
      allowRestore: true,
    });
    persistPortalSession(page, auth);

    client = new VisaApiClient({
      context,
      page,
      auth,
      baseUrl: getBaseUrl(),
      // Submit only through the authenticated page so the browser supplies its
      // own same-origin cookie, Origin, Referer, and fetch metadata context.
      finalMutationInPage: true,
      networkState: capture.state,
      bookingUserId: CONFIG.SESSION_ID,
      readTransport: resolveReadTransport(),
      huntWindow,
      logger: (level, payload) => {
        const event = payload?.event || "";
        if (level === "debug" && event === "request_start") return;
        log(level === "debug" ? "info" : level, JSON.stringify(redact(payload)));
      },
    });

    status(
      "SESSION_READY",
      `Authenticated API session ready; readTransport=${client.readTransport}; pollMs=${CONFIG.FIRST_MONTH_POLL_MS}`,
    );
    await client.warmUp();

    huntWindow.start();
    let scheduler = createScanScheduler({
      pollMs: CONFIG.FIRST_MONTH_POLL_MS,
      jitterMs: CONFIG.SCAN_JITTER_MS,
    });
    const scanStats = createScanStats();
    let refreshTokenInBackground = createBackgroundTokenRefresher(client);
    let lastScanOutcome = "";

    while (!completionReported) {
      if (page.isClosed()) throw new Error("API browser was closed");
      if (huntWindow.expired()) {
        // Drain the old scan/refresh/save before clearing authentication. No
        // final mutation is ever interrupted by this transition.
        sendWorkerMessage({ type: "hunt_slot_released", requestId: ++renewalId });
        status("WAITING_FOR_HOURLY_SIGN_IN", "Hunting paused after one hour. Complete CAPTCHA and press Sign In to continue");
        await refreshTokenInBackground.drain();
        await pendingSessionSave;
        auth = null;
        client.auth = {};
        resolvedContext = null;
        bootstrapCache = { user: null, history: null, historyAttempted: false, browserAttemptedAt: 0 };
        await resetPortalAuthentication({ page, context, profileDir: CONFIG.PROFILE_DIR });
        if (browser) await browser.close();
        ({ browser, context, page } = await launchBrowser());
        capture = createNetworkCapture();
        page.on("request", capture.rememberRequest);
        page.on("response", capture.rememberResponse);
        client.context = context;
        client.page = page;
        client.networkState = capture.state;
        auth = await establishApiSession({ page, context, networkState: capture.state, manual: true });
        client.auth = auth;
        // Authentication alone does not authorize hunting: the parent must
        // grant FIFO admission to this same worker.
        await resumeGate.request(page);
        if (!(await validateQueuedAuthentication(client))) continue;
        persistPortalSession(page, auth);
        scheduler = createScanScheduler({ pollMs: CONFIG.FIRST_MONTH_POLL_MS, jitterMs: CONFIG.SCAN_JITTER_MS });
        refreshTokenInBackground = createBackgroundTokenRefresher(client);
        lastScanOutcome = "";
        huntWindow.start();
        status("SESSION_READY", "Signed in; new one-hour hunting window started");
      }
      const cycleStartedAt = Date.now();
      try {
        refreshTokenInBackground();
        if (tokenExpiresSoon(client.auth)) {
          status("SESSION_EXPIRED", "Platform token is near expiration");
          throw new VisaApiUnauthorizedError("Token is near expiration");
        }

        if (!resolvedContext) {
          resolvedContext = await resolveContext({
            client,
            networkState: capture.state,
            page,
            bootstrapCache,
          });
          status("HUNTING", "Appointment context ready; scanning availability");
        }

        await runApiHuntCycle({
          client,
          context: resolvedContext,
          scanStats,
        });
        completionReported = true;
      } catch (error) {
        if (error instanceof HuntWindowExpiredError) continue;
        if (
          error instanceof VisaNoDatesAvailableError ||
          error instanceof VisaNoSlotsAvailableError
        ) {
          // Statuses are written only when the outcome changes; the heartbeat
          // summarizes the rest so fast scans do not flood the worker pool.
          const outcome =
            error instanceof VisaNoDatesAvailableError
              ? "NO_DATES_AVAILABLE"
              : "NO_SLOTS_AVAILABLE";
          if (`${outcome}:${error.message}` !== lastScanOutcome) {
            status(outcome, error.message);
            lastScanOutcome = `${outcome}:${error.message}`;
          }
          scheduler.onSuccess();
          emitScanHeartbeat(scanStats, scheduler);
          await huntWindow.wait(scheduler.delayUntilNextScan(cycleStartedAt));
          continue;
        }

        if (error instanceof VisaSlotConflictError) {
          status(
            "SLOT_CONFLICT",
            "Selected slots were taken; rescanning availability immediately",
          );
          lastScanOutcome = "";
          scheduler.onSuccess();
          continue;
        }

        if (error instanceof VisaBookingVerificationError) {
          status(
            "MANUAL_VERIFICATION_REQUIRED",
            `${formatApiError(error)}; final mutation will not be replayed`,
          );
          status(
            "PAUSED",
            "Session retained for manual appointment verification",
          );
          if (!page.isClosed()) await page.waitForEvent("close", { timeout: 0 });
          throw new Error("Browser closed during manual appointment verification");
        }

        if (error instanceof VisaApiRateLimitedError) {
          scanStats.stats.rateLimited += 1;
          const waitMs = scheduler.onRateLimited(error.retryAfterMs);
          status(
            "RATE_LIMITED",
            `${formatApiError(error)}; waiting ${Math.ceil(waitMs / 1000)}s`,
          );
          lastScanOutcome = "";
          await huntWindow.wait(waitMs);
          continue;
        }

        if (error instanceof VisaPlatformUnavailableError) {
          scanStats.stats.failures += 1;
          const waitMs = scheduler.onFailure();
          status(
            "PLATFORM_UNAVAILABLE",
            `${formatApiError(error)}; retrying in ${(waitMs / 1000).toFixed(1)}s`,
          );
          lastScanOutcome = "";
          await huntWindow.wait(waitMs);
          continue;
        }

        if (error instanceof VisaApiUnauthorizedError) {
          status("REAUTHENTICATION_REQUIRED", "Manual reauthentication required");
          auth = await establishApiSession({
            page,
            context,
            networkState: capture.state,
            huntWindow,
          }).catch((loginError) => {
            if (loginError instanceof HuntWindowExpiredError) return null;
            throw loginError;
          });
          if (!auth) continue;
          client.auth = auth;
          persistPortalSession(page, auth);
          resolvedContext = null;
          bootstrapCache = {
            user: null,
            history: null,
            historyAttempted: false,
            browserAttemptedAt: 0,
          };
          status("SESSION_READY", "API session refreshed after reauthentication");
          continue;
        }

        if (error instanceof VisaApiForbiddenError) {
          status("BLOCKED", "Visa API returned forbidden; manual review required");
          break;
        }

        if (isRecoverableContextError(error)) {
          const diagnostics = error.contextDiagnostics || {};
          status(
            "CONTEXT_ACQUISITION_WAIT",
            `${formatApiError(error)}; missing=${(diagnostics.missingFields || []).join(",") || "complete appointment record"}; capturedResponses=${diagnostics.capturedResponses || 0}; appointmentRecords=${diagnostics.appointmentSearchResponses || 0}; retrying in ${Math.ceil(CONFIG.CONTEXT_RETRY_MS / 1000)}s`,
          );
          resolvedContext = null;
          await huntWindow.wait(CONFIG.CONTEXT_RETRY_MS);
          continue;
        }

        status("ERROR", formatApiError(error));
        await huntWindow.wait(CONFIG.ATTEMPT_INTERVAL_MS);
      }
    }

    if (completionReported) {
      await openDashboard(page).catch(() => {});
      status("PAUSED", "API booking session left open for manual verification");
      if (!page.isClosed()) await page.waitForEvent("close", { timeout: 0 });
    }

  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    process.removeListener("disconnect", shutdown);
    process.removeListener("message", onControl);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function start() {
  return main().catch((error) => {
    status("ERROR", error?.message || String(error));
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  establishApiSession,
  resolveContext,
  launchBrowser,
  findDateAndSlot,
  login,
  waitForLoginOrDashboard,
  resetPortalAuthentication,
  validateQueuedAuthentication,
  isPerfTraceEnabled,
  runApiHuntCycle,
  start,
  submitAndVerify,
};
