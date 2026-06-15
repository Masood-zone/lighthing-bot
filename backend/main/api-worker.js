const { chromium } = require("playwright");

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
  currentMonthRange,
  laterDate,
  earlierDate,
  formatAppointmentTime,
  selectEarliestUsableSlot,
  buildAppointmentPayload,
  fingerprintAttempt,
  appointmentMatchesSubmission,
  resolveApplicantContext,
  buildAvailabilityContext,
  collectValuesDeep,
  parseIsoDateOnly,
  redact,
} = require("../src/services/visaApi");

const CONFIG = {
  SESSION_ID: process.env.VISA_SESSION_ID || "",
  PLATFORM_URL:
    process.env.VISA_PLATFORM_URL ||
    "https://www.usvisaappt.com/visaapplicantui/login",
  USER_EMAIL: process.env.VISA_USER_EMAIL || "",
  USER_PASSWORD: process.env.VISA_USER_PASSWORD || "",
  USER_DISPLAY_NAME: process.env.VISA_USER_DISPLAY_NAME || "",
  HEADLESS:
    process.env.VISA_HEADLESS === "1" || process.env.VISA_HEADLESS === "true",
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
    1000,
    Number(process.env.VISA_ATTEMPT_INTERVAL_MS) || 30_000,
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
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  console.log(`[${state}] ${message}`);
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
    `${CONFIG.HEADLESS ? "Headless" : "Headed"} Chrome for API session bridge`,
  );

  const launchOptions = {
    headless: CONFIG.HEADLESS,
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
    displayNameWait,
  ]);
}

async function waitForLoginOrDashboard(page, timeoutMs = CONFIG.LOGIN_WAIT_TIMEOUT_MS) {
  const dashboardWait = page
    .waitForURL(/dashboard/i, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  const displayNameWait = CONFIG.USER_DISPLAY_NAME
    ? page
        .getByText(CONFIG.USER_DISPLAY_NAME, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs })
        .then(() => true)
        .catch(() => false)
    : Promise.resolve(false);

  const ok = await Promise.race([dashboardWait, displayNameWait]);
  if (!ok) throw new Error("Login wait timed out.");
}

async function login(page) {
  status("WAITING_FOR_LOGIN", "Opening visa login page");

  try {
    await page.goto(CONFIG.PLATFORM_URL, {
      waitUntil: "commit",
      timeout: CONFIG.LOGIN_NAV_TIMEOUT_MS,
    });
  } catch (error) {
    status(
      "WAITING_FOR_LOGIN",
      `Login page is loading slowly; waiting for a usable surface (${String(
        error?.message || error,
      )})`,
    );
  }

  const surface = await waitForLoginSurface(page);
  if (surface === "dashboard") {
    status("SESSION_CAPTURED", "Dashboard already authenticated");
    return;
  }

  if (surface !== "login") {
    throw new Error("Login page did not become ready.");
  }

  if (CONFIG.USER_EMAIL) {
    await page
      .locator('input[formcontrolname="username"]')
      .fill(CONFIG.USER_EMAIL, { timeout: 30000 });
  }

  if (CONFIG.USER_PASSWORD) {
    await page
      .locator('input[formcontrolname="password"]')
      .fill(CONFIG.USER_PASSWORD, { timeout: 30000 });
  }

  status("WAITING_FOR_CAPTCHA", "Credentials filled; complete CAPTCHA and sign in");
  await waitForLoginOrDashboard(page);
  status("SESSION_CAPTURED", "Dashboard authenticated");
}

async function openDashboard(page) {
  const dashboardUrl = `${getAppBaseUrl()}/dashboard`;
  if (/\/dashboard/i.test(page.url())) return;
  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForURL(/dashboard/i, { timeout: 20000 }).catch(() => {});
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

async function resolveContext({ client, networkState }) {
  status("RESOLVING_APPLICATION", "Resolving user and appointment context");

  const user = await client.getAuthenticatedUser();
  const bootstrapPieces = [user];

  const postConfiguration = await client.getPostConfiguration(
    CONFIG.SELECTED_POST_USER_ID,
  );
  status(
    "POST_CONFIGURATION_READY",
    `Loaded Accra post configuration for postUserId ${CONFIG.SELECTED_POST_USER_ID}`,
  );

  const history = await client
    .getUserHistoryApplicantPaymentStatus()
    .catch((error) => {
      log("warn", `Could not load user history bootstrap: ${error.message}`);
      return null;
    });
  if (history) bootstrapPieces.push(history);

  const resolved = await resolveApplicantContext({
    client,
    mode: CONFIG.RESCHEDULE ? "reschedule" : "pending",
    networkState,
    bootstrapData: bootstrapPieces,
  });

  const workflowData = await client
    .getWorkflowData(resolved.applicationId)
    .catch((error) => {
      log("warn", `Could not load workflow transform data: ${error.message}`);
      return null;
    });

  if (workflowData) bootstrapPieces.push(workflowData);

  const selectedAppointment = {
    ...resolved.appointment,
    postUserId: CONFIG.SELECTED_POST_USER_ID,
  };
  const availability = buildAvailabilityContext(selectedAppointment, {
    postUserIdOverride: CONFIG.SELECTED_POST_USER_ID,
  });

  return {
    user,
    bootstrapData: bootstrapPieces,
    workflowData,
    postConfiguration,
    ...resolved,
    appointment: selectedAppointment,
    availability,
  };
}

function makeSearchRange({ firstAvailableDate, window }) {
  const firstDate = parseIsoDateOnly(firstAvailableDate);
  const minDate = laterDate(firstDate, window.minDate);
  const base = minDate || firstDate || window.minDate || parseIsoDateOnly(new Date().toISOString());
  const monthRange = monthRangeFor(base);
  if (!monthRange) return null;

  return {
    fromDate: laterDate(monthRange.fromDate, window.minDate),
    toDate: earlierDate(monthRange.toDate, window.maxDate),
  };
}

function chooseNextDateCandidate({ dates, window, currentAppointmentDate }) {
  const exactDate = parseIsoDateOnly(CONFIG.EXACT_DATE);
  const fallbackStrategy = exactDate
    ? CONFIG.EXACT_DATE_FALLBACK
    : "EARLIEST_ACCEPTABLE";
  return selectAvailableDate({
    availableDates: dates,
    minDate: window.minDate,
    maxDate: window.maxDate,
    exactDate,
    fallbackStrategy,
    mode: CONFIG.RESCHEDULE ? "reschedule" : "pending",
    currentAppointmentDate,
    allowSameDateReschedule: CONFIG.ALLOW_SAME_DATE_RESCHEDULE,
  });
}

async function findDateAndSlot({ client, context }) {
  status("SCANNING_DATES", "Checking first available appointment month");
  const firstMonth = await client.getFirstAvailableMonth(context.availability);
  if (!firstMonth?.present || !firstMonth?.date) {
    throw new VisaNoDatesAvailableError("No first available month returned");
  }

  const window = getDatePreferencesSnapshot();
  const range = makeSearchRange({
    firstAvailableDate: firstMonth.date,
    window,
  });

  if (!range?.fromDate || !range?.toDate || range.fromDate > range.toDate) {
    throw new VisaNoDatesAvailableError("First available month is outside the configured date window");
  }

  const rawDates = await client.getAvailableDates(context.availability, range);
  const availableDates = normalizeAvailableDates(rawDates);
  if (!availableDates.length) {
    throw new VisaNoDatesAvailableError("No dates available in selected month");
  }

  let remainingDates = availableDates;
  const tried = new Set();
  const currentAppointmentDate = parseIsoDateOnly(context.appointment.appointmentDt);

  while (tried.size < remainingDates.length) {
    const selection = chooseNextDateCandidate({
      dates: remainingDates.filter((date) => !tried.has(date)),
      window,
      currentAppointmentDate,
    });

    if (!selection.selectedDate) {
      throw new VisaNoDatesAvailableError(selection.reason);
    }

    const selectedDate = selection.selectedDate;
    tried.add(selectedDate);
    status("DATE_SELECTED", selectedDate);
    status("FETCHING_SLOTS", `Fetching slots for ${selectedDate}`);

    const slotLookupRange = currentMonthRange();
    const slots = await client.getAvailableTimeSlots(context.availability, {
      slotDate: selectedDate,
      fromDate: slotLookupRange.fromDate,
      toDate: slotLookupRange.toDate,
    });

    const slotSelection = selectEarliestUsableSlot(slots);
    if (!slotSelection.selectedSlot) {
      status("NO_SLOTS_AVAILABLE", `No usable slots for ${selectedDate}`);
      continue;
    }

    status(
      "SLOT_SELECTED",
      `Time slot selected: ${formatAppointmentTime(
        slotSelection.selectedSlot.startTime,
      )}`,
    );
    return {
      selectedDate,
      selectedSlot: slotSelection.selectedSlot,
      searchRange: range,
    };
  }

  throw new VisaNoSlotsAvailableError("No usable slots for returned dates");
}

async function submitAndVerify({ client, context, selectedDate, selectedSlot }) {
  const payload = buildAppointmentPayload({
    appointment: context.appointment,
    selectedDate,
    selectedSlot,
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
      appointmentMatchesSubmission(appointment, payload),
    ) || null;
  if (finalVerified) {
    status(
      "VERIFYING_BOOKING",
      "Final booking response matched the selected appointment",
    );
    return { payload, appointment: finalVerified, finalResponse };
  }

  if (finalError) throw finalError;

  status(
    "VERIFYING_BOOKING",
    "Final booking response did not match the selected appointment",
  );
  throw new VisaBookingVerificationError(
    "Final response did not match selected appointment",
    { responseBody: finalResponse },
  );
}

async function runApiHuntCycle({ client, context }) {
  const { selectedDate, selectedSlot } = await findDateAndSlot({
    client,
    context,
  });
  const verified = await submitAndVerify({
    client,
    context,
    selectedDate,
    selectedSlot,
  });

  status("COMPLETED", "API booking verified successfully");
  return verified;
}

function isTerminalContractError(error) {
  return (
    error instanceof VisaApiContractError ||
    error instanceof VisaApplicationNotFoundError
  );
}

async function main() {
  status("START", "Launching API booking worker");

  const { browser, context, page } = await launchBrowser();
  const capture = createNetworkCapture();
  page.on("request", capture.rememberRequest);
  page.on("response", capture.rememberResponse);

  let client = null;
  let completionReported = false;
  let terminalError = false;
  let resolvedContext = null;

  try {
    await login(page);
    await openDashboard(page);

    let auth = await captureVisaSession({
      page,
      context,
      networkState: capture.state,
      bookingUserId: CONFIG.SESSION_ID,
    });

    if (!auth.authorizationHeader) {
      status("REAUTHENTICATION_REQUIRED", "Authenticated token was not captured");
      throw new Error("Platform auth token was not captured from sessionStorage or headers.");
    }

    client = new VisaApiClient({
      context,
      page,
      auth,
      baseUrl: getBaseUrl(),
      logger: (level, payload) => {
        const event = payload?.event || "";
        if (level === "debug" && event === "request_start") return;
        log(level === "debug" ? "info" : level, JSON.stringify(redact(payload)));
      },
    });

    status("SESSION_READY", "Authenticated API session ready");

    while (!completionReported) {
      try {
        if (tokenExpiresSoon(client.auth)) {
          status("SESSION_EXPIRED", "Platform token is near expiration");
          throw new VisaApiUnauthorizedError("Token is near expiration");
        }

        if (!resolvedContext) {
          resolvedContext = await resolveContext({
            client,
            networkState: capture.state,
          });
        }

        await runApiHuntCycle({
          client,
          context: resolvedContext,
        });
        completionReported = true;
      } catch (error) {
        if (error instanceof VisaNoDatesAvailableError) {
          status("NO_DATES_AVAILABLE", error.message);
          status("WAITING_NEXT_SCAN", "Waiting before the next API date scan");
          await sleep(CONFIG.ATTEMPT_INTERVAL_MS);
          continue;
        }

        if (error instanceof VisaNoSlotsAvailableError) {
          status("NO_SLOTS_AVAILABLE", error.message);
          status("WAITING_NEXT_SCAN", "Waiting before refreshing availability");
          await sleep(CONFIG.ATTEMPT_INTERVAL_MS);
          continue;
        }

        if (error instanceof VisaApiRateLimitedError) {
          const waitMs = error.retryAfterMs || CONFIG.ATTEMPT_INTERVAL_MS;
          status(
            "RATE_LIMITED",
            `${formatApiError(error)}; waiting ${Math.ceil(waitMs / 1000)}s`,
          );
          await sleep(waitMs);
          continue;
        }

        if (error instanceof VisaPlatformUnavailableError) {
          status("PLATFORM_UNAVAILABLE", formatApiError(error));
          await sleep(CONFIG.ATTEMPT_INTERVAL_MS);
          continue;
        }

        if (error instanceof VisaApiUnauthorizedError) {
          status("REAUTHENTICATION_REQUIRED", "Manual reauthentication required");
          await login(page);
          auth = await captureVisaSession({
            page,
            context,
            networkState: capture.state,
            bookingUserId: CONFIG.SESSION_ID,
          });
          client.auth = auth;
          resolvedContext = null;
          status("SESSION_READY", "API session refreshed after reauthentication");
          continue;
        }

        if (error instanceof VisaApiForbiddenError) {
          status("BLOCKED", "Visa API returned forbidden; manual review required");
          break;
        }

        if (isTerminalContractError(error)) {
          status("INVALID_API_CONTRACT", formatApiError(error));
          terminalError = true;
          break;
        }

        status("ERROR", formatApiError(error));
        await sleep(CONFIG.ATTEMPT_INTERVAL_MS);
      }
    }

    if (completionReported) {
      await openDashboard(page).catch(() => {});
      status("PAUSED", "API booking session left open for manual verification");
      await new Promise(() => {});
    }

    if (terminalError) {
      process.exitCode = 1;
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  status("ERROR", error?.message || String(error));
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
