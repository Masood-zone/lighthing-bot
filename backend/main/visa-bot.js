const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// Optional .env support (won't crash if dotenv isn't installed)
try {
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch {
  // ignore
}

const CONFIG = {
  PLATFORM_URL:
    process.env.VISA_PLATFORM_URL ||
    "https://www.usvisaappt.com/visaapplicantui/login",
  USER_EMAIL: process.env.VISA_USER_EMAIL || "Wilhelmina219.doe@gmail.com",
  USER_PASSWORD: process.env.VISA_USER_PASSWORD || "Cyril1234@claridge",
  // Used to detect that the session is still alive (shown in the dashboard sidebar)
  USER_DISPLAY_NAME: process.env.VISA_USER_DISPLAY_NAME || "Wilhelmina Doe",
  PICKUP_POINT: process.env.VISA_PICKUP_POINT || "Accra",
  SESSION_ID: process.env.VISA_SESSION_ID || "",
  HEADLESS:
    process.env.VISA_HEADLESS === "1" || process.env.VISA_HEADLESS === "true",
  RESCHEDULE:
    process.env.VISA_RESCHEDULE === "1" ||
    process.env.VISA_RESCHEDULE === "true",

  // Business rule: attempt booking checks every 2 seconds for 1 hour.
  // Defaults: 2s cadence, 1h window, 1800 attempts per window.
  ATTEMPTS: {
    INTERVAL_MS: Math.max(
      200,
      Number(process.env.VISA_ATTEMPT_INTERVAL_MS) || 2000,
    ),
    // How long to wait after selecting pickup for the calendar UI to update.
    // We do NOT use the "no appointments" toast anymore.
    TOAST_WAIT_MS: Math.max(
      500,
      Number(process.env.VISA_TOAST_WAIT_MS) || 5500,
    ),
    WINDOW_MS: Math.max(
      60_000,
      Number(process.env.VISA_ATTEMPT_WINDOW_MS) || 60 * 60 * 1000,
    ),
    MAX_PER_WINDOW: Math.max(
      1,
      Number(process.env.VISA_ATTEMPTS_PER_WINDOW) || 1800,
    ),
  },

  PICKUP_TOGGLE: {
    // Limit how often we do a de-select/re-select cycle to refresh availability.
    // This reduces server requests and helps avoid lockouts.
    COOLDOWN_MS: Math.max(
      0,
      Number(process.env.VISA_PICKUP_TOGGLE_COOLDOWN_MS) || 2000,
    ),
    MAX_TOGGLES_PER_ATTEMPT: Math.max(
      0,
      Number(process.env.VISA_PICKUP_TOGGLE_MAX_PER_ATTEMPT) || 1,
    ),
  },

  CALENDAR_SCAN: {
    MAX_MONTHS: 6,
    BACKOFF_MIN: 300_000, // 5min
    BACKOFF_MAX: 900_000, // 15min
    // How long to wait before retrying when the platform explicitly says there are no appointments.
    // Keep this reasonably high to avoid hammering the site.
    NO_APPOINTMENTS_RECHECK_MS: Number(
      process.env.VISA_NO_APPOINTMENTS_RECHECK_MS || 30 * 60 * 1000, // 30min
    ),
    KEEPALIVE_PULSE_MS: 15 * 60 * 1000, // 15min

    // Month window constraints (1-based, inclusive)
    WINDOW_START_MONTH: 1, // January
    WINDOW_END_MONTH: 12, // December
  },
};

function parseIsoDateOnly(value) {
  if (!value || typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function startOfDayUtc(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function endOfDayUtc(date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function addDaysUtc(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function getEffectiveDateWindow() {
  // Priority:
  // 1) Explicit start/end via VISA_DATE_START / VISA_DATE_END
  // 2) Days-from-now window
  // 3) Weeks-from-now window
  const explicitStart = parseIsoDateOnly(process.env.VISA_DATE_START);
  const explicitEnd = parseIsoDateOnly(process.env.VISA_DATE_END);

  const today = startOfDayUtc(new Date());

  const daysMin = Number(process.env.VISA_DAYS_FROM_NOW_MIN);
  const daysMax = Number(process.env.VISA_DAYS_FROM_NOW_MAX);
  const weeksMin = Number(process.env.VISA_WEEKS_FROM_NOW_MIN);
  const weeksMax = Number(process.env.VISA_WEEKS_FROM_NOW_MAX);

  let start = explicitStart ? startOfDayUtc(explicitStart) : null;
  let end = explicitEnd ? endOfDayUtc(explicitEnd) : null;

  if (!start && Number.isFinite(daysMin) && daysMin >= 0) {
    start = startOfDayUtc(addDaysUtc(today, Math.trunc(daysMin)));
  }
  if (!end && Number.isFinite(daysMax) && daysMax >= 0) {
    end = endOfDayUtc(addDaysUtc(today, Math.trunc(daysMax)));
  }

  if (!start && Number.isFinite(weeksMin) && weeksMin >= 0) {
    start = startOfDayUtc(addDaysUtc(today, Math.trunc(weeksMin) * 7));
  }
  if (!end && Number.isFinite(weeksMax) && weeksMax >= 0) {
    end = endOfDayUtc(addDaysUtc(today, Math.trunc(weeksMax) * 7));
  }

  if (start && end && start.getTime() > end.getTime()) {
    // Misconfigured; ignore window rather than blocking entirely.
    return { start: null, end: null };
  }
  return { start, end };
}

function getAllowedDateRange() {
  // Back-compat:
  // - Prefer VISA_MIN_DATE/VISA_MAX_DATE if provided
  // - Else fall back to existing VISA_DATE_START/VISA_DATE_END
  const min =
    parseIsoDateOnly(process.env.VISA_MIN_DATE) ||
    parseIsoDateOnly(process.env.VISA_DATE_START);
  const max =
    parseIsoDateOnly(process.env.VISA_MAX_DATE) ||
    parseIsoDateOnly(process.env.VISA_DATE_END);

  return {
    min: min ? startOfDayUtc(min) : null,
    max: max ? endOfDayUtc(max) : null,
  };
}

function isDateWithinRange(dateObj, minDate, maxDate) {
  if (!dateObj || Number.isNaN(dateObj.getTime())) return false;
  const t = dateObj.getTime();
  if (minDate && t < minDate.getTime()) return false;
  if (maxDate && t > maxDate.getTime()) return false;
  return true;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function dismissAnyOpenOverlays(driver) {
  // Angular Material selects use a cdk overlay pane/backdrop.
  // If we leave it open, future clicks can hang/fail.
  try {
    const backdrops = await driver.findElements(
      By.css(".cdk-overlay-backdrop"),
    );
    for (const el of backdrops) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!(await el.isDisplayed())) continue;
        // eslint-disable-next-line no-await-in-loop
        await jsClick(driver, el);
        break;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // Escape is a reliable fallback to close open selects.
  try {
    await driver.actions().sendKeys(Key.ESCAPE).perform();
  } catch {
    // ignore
  }

  // Briefly wait for overlay pane(s) to go away.
  const start = Date.now();
  while (Date.now() - start < 1500) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const panes = await driver.findElements(By.css(".cdk-overlay-pane"));
      let anyVisible = false;
      for (const p of panes) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await p.isDisplayed()) {
            anyVisible = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!anyVisible) return true;
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  return false;
}

function ipcSend(payload) {
  try {
    if (typeof process.send === "function") process.send(payload);
  } catch {
    // ignore
  }
}

function reportStatus(state, message) {
  ipcSend({ type: "status", sessionId: CONFIG.SESSION_ID, state, message });
}

function reportLog(level, message) {
  ipcSend({ type: "log", sessionId: CONFIG.SESSION_ID, level, message });
}

function getAppBaseUrl() {
  // Example login URL: https://www.usvisaappt.com/visaapplicantui/login
  // We want:            https://www.usvisaappt.com/visaapplicantui
  const u = new URL(CONFIG.PLATFORM_URL);
  const marker = "/visaapplicantui";
  const idx = u.pathname.indexOf(marker);
  const basePath = idx >= 0 ? u.pathname.slice(0, idx + marker.length) : "";
  return `${u.origin}${basePath}`;
}

async function goToDashboard(driver) {
  const url = await driver.getCurrentUrl();
  if (url.includes("/dashboard")) return true;

  const dashboardUrl = `${getAppBaseUrl()}/dashboard`;
  await driver.get(dashboardUrl);
  await waitForLoadingOverlayToClear(driver, 15_000).catch(() => {});
  await driver.wait(async () => {
    const u = await driver.getCurrentUrl();
    return u.includes("/dashboard") || (await isSessionAlive(driver));
  }, 20000);
  return true;
}

async function createDriver() {
  const options = new chrome.Options();
  if (CONFIG.HEADLESS) {
    // new headless mode for modern Chrome
    options.addArguments("--headless=new");
  }

  // Reduce background network chatter (helps with noisy Chrome GCM logs like DEPRECATED_ENDPOINT).
  options.addArguments(
    // Commonly required in containerized Linux runtimes.
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
    "--disable-features=PushMessaging",
  );

  // Optional per-session Chrome profile for persistence (backend can set VISA_PROFILE_DIR later)
  if (process.env.VISA_PROFILE_DIR) {
    options.addArguments(`--user-data-dir=${process.env.VISA_PROFILE_DIR}`);
  }

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
  await driver.get(CONFIG.PLATFORM_URL);
  return driver;
}

function assertConfigured() {
  const missing = [];
  if (!CONFIG.USER_EMAIL) missing.push("VISA_USER_EMAIL");
  if (!CONFIG.USER_PASSWORD) missing.push("VISA_USER_PASSWORD");
  if (!CONFIG.USER_DISPLAY_NAME) missing.push("VISA_USER_DISPLAY_NAME");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Create a .env file or set them in your shell.",
    );
  }
}

function looksLikeClosedWindowError(err) {
  const msg = String(err?.message || "");
  return (
    err?.name === "NoSuchWindowError" ||
    msg.includes("no such window") ||
    msg.includes("target window already closed") ||
    msg.includes("web view not found")
  );
}

async function elementExists(driver, locator) {
  const els = await driver.findElements(locator);
  return els.length > 0;
}

function textLocator(text) {
  return By.xpath(`//*[contains(normalize-space(.), ${JSON.stringify(text)})]`);
}
// Waits for the user to successfully log in, or throws an error if blocked or timed out.
async function waitForLoginOrBlock(driver, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await driver.getCurrentUrl();
    if (url.includes("dashboard")) return true;

    await sleep(500);
  }

  throw new Error("Login wait timed out.");
}

function normalizeRgb(color) {
  const c = String(color || "")
    .trim()
    .toLowerCase();
  const m = c.match(
    /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/,
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function isGreenAvailableColor(color) {
  const rgb = normalizeRgb(color);
  if (!rgb) return false;
  // Target: #14a38b => rgb(20, 163, 139)
  return rgb.r === 20 && rgb.g === 163 && rgb.b === 139 && rgb.a !== 0;
}

async function selectPickupAccra(driver) {
  reportStatus("SELECT_PICKUP", `Selecting pickup: ${CONFIG.PICKUP_POINT}`);
  await triggerPickupCheck(driver);
  reportStatus("SELECT_PICKUP_DONE", `Pickup active: ${CONFIG.PICKUP_POINT}`);
  return true;
}

async function findGreenAvailableDate(driver) {
  // Only select calendar cells that are *visually* green (#14a38b).
  // This is the sole signal of availability.
  const cells = await driver.findElements(
    By.css(
      "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
    ),
  );

  for (const cell of cells) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const button = (await cell.getTagName()) === "button" ? cell : null;
      const target = button || cell;

      // eslint-disable-next-line no-await-in-loop
      const content = await target
        .findElement(By.css(".mat-calendar-body-cell-content"))
        .catch(() => null);

      // eslint-disable-next-line no-await-in-loop
      const bg1 = content ? await content.getCssValue("background-color") : "";
      // eslint-disable-next-line no-await-in-loop
      const bg2 = await target.getCssValue("background-color");

      const isGreen = isGreenAvailableColor(bg1) || isGreenAvailableColor(bg2);
      if (!isGreen) continue;

      // eslint-disable-next-line no-await-in-loop
      await driver.executeScript(
        "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
        target,
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);

      reportStatus("DATE", "Selecting green available date");
      // eslint-disable-next-line no-await-in-loop
      await safeClick(driver, target);
      return true;
    } catch {
      // ignore and continue
    }
  }

  return false;
}

async function findGreenAvailableDateWithinRange(driver) {
  // Scan visible calendar cells, find green (#14a38b), parse their date from
  // (day number + current calendar month/year header) and only click if within
  // allowed MIN_DATE..MAX_DATE.
  const allowed = getAllowedDateRange();
  reportStatus(
    "DATE_SCAN",
    `Scanning for green dates (allowed: ${allowed.min ? allowed.min.toISOString().slice(0, 10) : "(none)"}..${allowed.max ? allowed.max.toISOString().slice(0, 10) : "(none)"})`,
  );

  const header = await getCalendarHeaderText(driver)
    .then(parseMonthYear)
    .catch(() => null);

  if (!header) {
    reportStatus(
      "CALENDAR_HEADER_MISSING",
      "Calendar header not found; cannot parse dates reliably",
    );
    reportLog("warn", "Calendar header not found; cannot parse dates reliably");
    return { clicked: false, outOfRangeFound: false };
  }

  const cells = await driver.findElements(
    By.css(
      "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
    ),
  );

  let outOfRangeFound = false;
  let greenFound = 0;
  let greenInRangeFound = 0;

  reportLog(
    "info",
    `Calendar month context: ${header.year}-${String(header.monthIndex + 1).padStart(2, "0")} (cells: ${cells.length})`,
  );

  for (const cell of cells) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const tag = await cell.getTagName();
      const target = tag === "button" ? cell : cell;

      // Skip already-selected cells (best-effort).
      if (tag === "button") {
        // eslint-disable-next-line no-await-in-loop
        if (await isDateSelected(driver, target)) continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const content = await target
        .findElement(By.css(".mat-calendar-body-cell-content"))
        .catch(() => null);

      // eslint-disable-next-line no-await-in-loop
      const bg1 = content ? await content.getCssValue("background-color") : "";
      // eslint-disable-next-line no-await-in-loop
      const bg2 = await target.getCssValue("background-color");

      const isGreen = isGreenAvailableColor(bg1) || isGreenAvailableColor(bg2);
      if (!isGreen) continue;

      greenFound += 1;

      // Parse the day number from the cell content text.
      // eslint-disable-next-line no-await-in-loop
      const dayText = content ? await content.getText() : "";
      const day = Number(String(dayText || "").trim());
      if (!Number.isFinite(day) || day <= 0 || day > 31) continue;

      const dateObj = new Date(Date.UTC(header.year, header.monthIndex, day));
      const inRange = isDateWithinRange(dateObj, allowed.min, allowed.max);
      if (!inRange) {
        outOfRangeFound = true;
        reportStatus(
          "OUT_OF_RANGE",
          `Green date ${header.year}-${String(header.monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")} outside allowed range`,
        );
        continue;
      }

      greenInRangeFound += 1;

      await driver.executeScript(
        "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
        target,
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);

      reportStatus("DATE", "Selecting green available date (in range)");
      // eslint-disable-next-line no-await-in-loop
      await safeClick(driver, target);
      reportStatus(
        "DATE_SELECTED",
        `Clicked in-range green date ${header.year}-${String(header.monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      );
      return { clicked: true, outOfRangeFound };
    } catch {
      // ignore and continue
    }
  }

  if (greenFound === 0) {
    reportStatus(
      "NO_GREEN_DATE",
      `No green dates found in current calendar view (cells scanned: ${cells.length})`,
    );
  } else if (greenInRangeFound === 0) {
    reportStatus(
      "NO_IN_RANGE_GREEN",
      `Found ${greenFound} green date(s), but none within allowed range; will reset pickup`,
    );
  } else {
    reportStatus(
      "NO_DATE_CLICK",
      `Found ${greenFound} green date(s) (${greenInRangeFound} in-range) but failed to click; will reset pickup`,
    );
  }

  return { clicked: false, outOfRangeFound };
}

async function waitForLoadingOverlay(
  driver,
  { appearMs = 2500, disappearMs = 15_000 } = {},
) {
  // Required behavior: wait for overlay to APPEAR then DISAPPEAR.
  const start = Date.now();
  while (Date.now() - start < appearMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isLoadingOverlayVisible(driver)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }

  if (!(await isLoadingOverlayVisible(driver))) return false;
  return waitForLoadingOverlayToClear(driver, disappearMs);
}

async function checkApplicantCheckbox(driver) {
  await confirmApplicant(driver);
  return true;
}

async function waitForAvailableSlotHeader(driver, timeoutMs = 4000) {
  // Use visible text.
  const header = await driver
    .wait(
      until.elementLocated(
        By.xpath(
          "//*[contains(normalize-space(.), 'Available Slot') or contains(normalize-space(.), 'Available Slots')]",
        ),
      ),
      timeoutMs,
    )
    .catch(() => null);

  if (!header) return false;
  await driver.wait(until.elementIsVisible(header), 1500).catch(() => {});
  return true;
}

async function clickFirstTimeSlot(driver) {
  return clickFirstAvailableTimeSlot(driver, 2500);
}

async function clickProceedButton(driver) {
  return proceedIfAvailableSlotsVisible(driver);
}

async function resetPickup(driver) {
  reportStatus("RESET_PICKUP", "Resetting pickup (previous option -> Accra)");

  let alt = null;
  try {
    const discovered = await getPickupOptionBefore(driver, CONFIG.PICKUP_POINT);
    alt = discovered?.option || null;
  } catch {
    // ignore
  }
  if (!alt) alt = lastAlternatePickupPoint;

  if (alt && !alt.includes(CONFIG.PICKUP_POINT)) {
    await selectPickupPointByName(driver, alt).catch(() => null);
  }

  // Always return to Accra and force reselect to trigger availability.
  await selectPickupPointByName(driver, CONFIG.PICKUP_POINT).catch(() => null);
  await forceReselectPickupPoint(driver, CONFIG.PICKUP_POINT).catch(() => null);
  return true;
}

// Core algorithm (strict):
// SELECT_PICKUP -> DATE -> APPLICANT -> SLOT -> PROCEED -> SUCCESS
// or RESET_PICKUP -> LOOP
async function fastBookingAttempt(driver) {
  try {
    reportStatus("ALGO", "Starting booking attempt (green-date algorithm)");
    await selectPickupAccra(driver);

    const dateScan = await findGreenAvailableDateWithinRange(driver);
    if (!dateScan.clicked) {
      // If we cannot click an in-range green date, we must reset pickup and loop.
      // (This includes: no greens, only out-of-range greens, or click failures.)
      return "RESET_PICKUP";
    }

    reportStatus("OVERLAY", "Waiting for loading overlay transition");
    const overlayOk = await waitForLoadingOverlay(driver, {
      appearMs: 2500,
      disappearMs: 15_000,
    }).catch(() => false);
    if (!overlayOk) {
      reportStatus(
        "OVERLAY_TIMEOUT",
        "Overlay did not appear+disappear as expected; resetting pickup",
      );
      return "RESET_PICKUP";
    }

    reportStatus("APPLICANT", "Checking applicant checkbox");
    await checkApplicantCheckbox(driver).catch(() => null);

    reportStatus("HEADER", "Waiting for Available Slot header");
    const headerOk = await waitForAvailableSlotHeader(driver, 4000);
    if (!headerOk) {
      reportStatus(
        "HEADER_MISSING",
        "Available Slot header not visible; resetting pickup",
      );
      return "RESET_PICKUP";
    }

    reportStatus("SLOT", "Clicking first available time slot");
    const slotOkStage1 = await clickFirstTimeSlot(driver);
    if (!slotOkStage1) {
      reportStatus(
        "SLOT_MISSING_STAGE1",
        "No time slot clickable before proceed; will try proceed and re-scan",
      );
    }

    reportStatus("PROCEED", "Clicking SELECT POST AND PROCEED");
    const proceedOkStage1 = await clickProceedButton(driver).catch(() => false);
    if (!proceedOkStage1) {
      reportStatus(
        "PROCEED_MISSING",
        "Proceed button not clickable/visible; resetting pickup",
      );
      return "RESET_PICKUP";
    }

    // Some flows show the time-slot list only AFTER clicking proceed.
    // User requirement: if a list of time buttons appears after proceed, click one.
    reportStatus("OVERLAY", "Waiting for loading overlay after proceed");
    await waitForLoadingOverlayToClear(driver, 15_000).catch(() => true);
    await dismissAnyOpenOverlays(driver).catch(() => {});

    reportStatus("SLOT_STAGE2", "Scanning for time slot buttons after proceed");
    const slotOkStage2 = await clickFirstAvailableTimeSlot(driver, 6000);
    if (slotOkStage2) {
      reportStatus(
        "SLOT_SELECTED_STAGE2",
        "Selected a time slot after proceed",
      );

      // If the same proceed button is still present, click it again to continue.
      const proceedOkStage2 = await clickProceedButton(driver).catch(
        () => false,
      );
      if (proceedOkStage2) {
        reportStatus("PROCEED_STAGE2", "Clicked proceed after slot selection");
        await waitForLoadingOverlayToClear(driver, 15_000).catch(() => true);
      } else {
        reportStatus(
          "PROCEED_STAGE2_MISSING",
          "Proceed button not found after slot selection; continuing",
        );
      }
    } else {
      reportStatus(
        "SLOT_STAGE2_NONE",
        "No post-proceed time-slot list detected (ok)",
      );
    }

    reportStatus("SUCCESS", "Success");
    return "SUCCESS";
  } catch (err) {
    reportLog("error", String(err?.message || err));
    return "RESET_PICKUP";
  }
}

// Detects if the app is stuck in a "loading" overlay (ngx-spinner).
async function isLoadingOverlayVisible(driver) {
  const overlays = await driver.findElements(By.css(".ngx-spinner-overlay"));
  for (const el of overlays) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await el.isDisplayed()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function waitForLoadingOverlayToClear(driver, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isLoadingOverlayVisible(driver))) return true;
    await sleep(500);
  }
  return false;
}

async function refreshAndRecover(driver, reason, { timeoutMs = 15_000 } = {}) {
  // Hard rule: NEVER refresh automatically (avoids 429 / Too Many Requests).
  // We only attempt to dismiss overlays and wait for the UI to become interactive.
  reportLog("warn", `Stabilizing (no refresh): ${reason}`);
  await dismissAnyOpenOverlays(driver).catch(() => {});
  return waitForLoadingOverlayToClear(driver, timeoutMs).catch(() => true);
}

async function safeClick(driver, element) {
  try {
    await element.click();
    return true;
  } catch (err) {
    const msg = String(err?.message || "");
    const intercepted =
      msg.includes("element click intercepted") ||
      msg.includes("Other element would receive the click");
    if (intercepted) {
      await dismissAnyOpenOverlays(driver).catch(() => {});
      await jsClick(driver, element);
      return true;
    }
    throw err;
  }
}

async function jsClick(driver, element) {
  await driver.executeScript("arguments[0].click();", element);
}
// Helper to get the calendar header text (e.g., "JAN 2026")
async function getCalendarHeaderText(driver) {
  const header = await driver.findElement(
    By.css(".mat-calendar-period-button"),
  );
  const txt = (await header.getText())?.trim();
  return txt || "";
}
// (Parses) Breaks down the month and year from calendar header text.
function parseMonthYear(headerText) {
  // Example: "JAN 2026"
  const parts = String(headerText || "")
    .trim()
    .split(/\s+/);
  if (parts.length < 2) return null;
  const month = parts[0].toUpperCase();
  const year = Number(parts[1]);
  if (!Number.isFinite(year)) return null;
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const monthIndex = months.indexOf(month);
  if (monthIndex === -1) return null;
  return { monthIndex, year };
}

function addMonths({ monthIndex, year }, add) {
  const total = year * 12 + monthIndex + add;
  const nextYear = Math.floor(total / 12);
  const nextMonthIndex = total % 12;
  return { monthIndex: nextMonthIndex, year: nextYear };
}

function monthKey({ monthIndex, year }) {
  return year * 12 + monthIndex;
}

function getDateRangeMonthKeys(window) {
  const min = window?.start
    ? window.start.getUTCFullYear() * 12 + window.start.getUTCMonth()
    : -Infinity;
  const max = window?.end
    ? window.end.getUTCFullYear() * 12 + window.end.getUTCMonth()
    : Infinity;
  return { min, max };
}

async function setCalendarToMonth(driver, target) {
  // Use the period button to jump months when next/prev arrows are disabled.
  // Flow (Angular Material): month-view -> click period -> multi-year (years) -> pick year -> year-view (months) -> pick month
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];

  const wantMonthLabel = months[target.monthIndex];
  const wantYearLabel = String(target.year);

  const currentHeader = parseMonthYear(await getCalendarHeaderText(driver));
  if (
    currentHeader &&
    currentHeader.year === target.year &&
    currentHeader.monthIndex === target.monthIndex
  ) {
    return true;
  }

  const periodBtn = await driver.findElement(
    By.css(".mat-calendar-period-button"),
  );
  await jsClick(driver, periodBtn);

  // Wait for year buttons and click desired year.
  const yearBtn = await driver.wait(
    until.elementLocated(By.css(".mat-calendar-body-cell")),
    10000,
  );
  // Find year cell by label/content.
  const yearCell = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//mat-multi-year-view//td//div[contains(@class,'mat-calendar-body-cell-content') and normalize-space(.)=${JSON.stringify(
          wantYearLabel,
        )}]`,
      ),
    ),
    10000,
  );
  await jsClick(driver, yearCell);

  // Now we should be in year-view (months). Pick desired month label.
  const monthCell = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//mat-year-view//td//div[contains(@class,'mat-calendar-body-cell-content') and contains(normalize-space(.), ${JSON.stringify(
          wantMonthLabel,
        )})]`,
      ),
    ),
    10000,
  );
  await jsClick(driver, monthCell);

  // Verify header updated.
  await driver.wait(async () => {
    const hdr = parseMonthYear(await getCalendarHeaderText(driver));
    return (
      hdr && hdr.year === target.year && hdr.monthIndex === target.monthIndex
    );
  }, 10000);

  // Silence unused variable warning (some drivers need the first wait to stabilize)
  void yearBtn;
  return true;
}
// Checks if a given date button is currently selected.
async function isDateSelected(driver, buttonEl) {
  const ariaPressed = await buttonEl.getAttribute("aria-pressed");
  if (ariaPressed === "true") return true;

  // Sometimes selection is reflected on the inner content.
  try {
    const content = await buttonEl.findElement(
      By.css(".mat-calendar-body-cell-content"),
    );
    const cls = (await content.getAttribute("class")) || "";
    if (cls.includes("mat-calendar-body-selected")) return true;
  } catch {
    // ignore
  }

  return false;
}
// Checks if there are any enabled (selectable) dates in the current calendar view.
async function hasAnyEnabledDateInView(driver) {
  const enabledDates = await driver.findElements(
    By.css("button.mat-calendar-body-cell:not(.mat-calendar-body-disabled)"),
  );
  return enabledDates.length > 0;
}
// Tries to select any available date in the current calendar view.
async function trySelectAnyAvailableDate(
  driver,
  maxAttempts = 10,
  { monthYear = null, dateWindow = null } = {},
) {
  // Prefer clickable non-disabled date buttons.
  const enabledDates = await driver.findElements(
    By.css("button.mat-calendar-body-cell:not(.mat-calendar-body-disabled)"),
  );

  if (enabledDates.length === 0)
    return { selected: false, toastNoAppointments: false };

  async function getCandidateDateUtc(btn) {
    // Best-effort: aria-label often includes a full date.
    try {
      const aria = await btn.getAttribute("aria-label");
      const parsed = aria ? new Date(aria) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        return new Date(
          Date.UTC(
            parsed.getUTCFullYear(),
            parsed.getUTCMonth(),
            parsed.getUTCDate(),
          ),
        );
      }
    } catch {
      // ignore
    }

    // Fallback: day number + current calendar header month/year
    try {
      const txt = await btn
        .findElement(By.css(".mat-calendar-body-cell-content"))
        .getText();
      const day = Number(String(txt || "").trim());
      if (Number.isFinite(day) && monthYear) {
        return new Date(Date.UTC(monthYear.year, monthYear.monthIndex, day));
      }
    } catch {
      // ignore
    }

    return null;
  }

  const dateWithinWindow = async (btn) => {
    if (!dateWindow?.start && !dateWindow?.end) return true;
    const d = await getCandidateDateUtc(btn);
    if (!d) return true; // can't evaluate; don't over-reject
    const t = d.getTime();
    if (dateWindow.start && t < dateWindow.start.getTime()) return false;
    if (dateWindow.end && t > dateWindow.end.getTime()) return false;
    return true;
  };

  const candidates = [];
  for (const btn of enabledDates) {
    // eslint-disable-next-line no-await-in-loop
    if (await dateWithinWindow(btn)) candidates.push(btn);
  }

  if (candidates.length === 0) {
    return { selected: false, toastNoAppointments: false };
  }

  const attempts = Math.min(maxAttempts, candidates.length);
  for (let i = 0; i < attempts; i++) {
    const btn = candidates[i];

    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
      btn,
    );

    // Use JS click (more reliable on overlays/animations).
    await jsClick(driver, btn);

    // Give UI a moment to apply selection.
    await sleep(250);

    // Wait briefly for selection state.
    const selected = await driver
      .wait(async () => isDateSelected(driver, btn), 3000)
      .catch(() => false);

    if (selected) {
      console.log("Available date selected.");
      return { selected: true, toastNoAppointments: false };
    }
  }

  return { selected: false, toastNoAppointments: false };
}

async function trySelectFirstAvailableDateFast(driver) {
  // Optimized for 2-second retry loops: try current view only and pick the first enabled date
  // that falls within the configured date window.
  const effectiveDateWindow = getEffectiveDateWindow();
  const header = await getCalendarHeaderText(driver)
    .then(parseMonthYear)
    .catch(() => null);

  const res = await trySelectAnyAvailableDate(driver, 1, {
    monthYear: header,
    dateWindow: effectiveDateWindow,
  });
  return Boolean(res.selected);
}
//
async function clickFirstAvailableTimeSlot(driver, timeoutMs = 2500) {
  const start = Date.now();

  // User requirement: Do NOT scope to `.ofc-book-slot-block`.
  // Time slots can appear as a list of clickable green buttons/links anywhere on the page.

  const looksLikeTimeText = (txt) => {
    const t = String(txt || "").trim();
    if (!t) return false;
    // Examples: "3:30 PM", "03:30PM", "15:30", "3 PM"
    return (
      /\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i.test(t) ||
      /\b\d{1,2}\s*(AM|PM)\b/i.test(t)
    );
  };

  async function isEnabledClickable(el) {
    try {
      const disabledAttr = await el.getAttribute("disabled");
      const ariaDisabled = await el.getAttribute("aria-disabled");
      if (disabledAttr || ariaDisabled === "true") return false;
    } catch {
      // ignore
    }
    try {
      if (!(await el.isDisplayed())) return false;
    } catch {
      // ignore
    }
    return true;
  }

  async function isGreenButton(el) {
    const colors = [];
    try {
      colors.push(await el.getCssValue("background-color"));
    } catch {
      // ignore
    }

    // Common Angular Material wrappers.
    try {
      const wrapper = await el.findElement(By.css(".mat-button-wrapper"));
      colors.push(await wrapper.getCssValue("background-color"));
    } catch {
      // ignore
    }

    try {
      const span = await el.findElement(By.css("span"));
      colors.push(await span.getCssValue("background-color"));
    } catch {
      // ignore
    }

    return colors.some((c) => isGreenAvailableColor(c));
  }

  async function isSelectedSlot(el) {
    try {
      const cls = String((await el.getAttribute("class")) || "");
      if (cls.includes("selected-slot")) return true;
    } catch {
      // ignore
    }

    // Visual fallback: once selected, the slot turns gray (per user).
    // We accept any non-green, non-transparent background as a selection signal.
    try {
      const bg = await el.getCssValue("background-color");
      const rgb = normalizeRgb(bg);
      if (!rgb) return false;
      if (rgb.a === 0) return false;
      if (isGreenAvailableColor(bg)) return false;
      return true;
    } catch {
      return false;
    }
  }

  while (Date.now() - start < timeoutMs) {
    // Prefer the known slots container when present (real DOM):
    // .ofc-appoinment-sloat-block .booking-time-buttons.slot_calender button.green-button
    // but do not require `.ofc-book-slot-block`.
    // eslint-disable-next-line no-await-in-loop
    const slotButtonsPreferred = await driver
      .findElements(
        By.css(
          ".ofc-appoinment-sloat-block .booking-time-buttons.slot_calender button.green-button, .booking-time-buttons.slot_calender button.green-button",
        ),
      )
      .catch(() => []);

    // Fallback: search broadly for clickable elements with time-ish text.
    // eslint-disable-next-line no-await-in-loop
    const candidates =
      slotButtonsPreferred.length > 0
        ? slotButtonsPreferred
        : await driver
            .findElements(
              By.xpath(
                "//button[contains(normalize-space(.), ':') or contains(translate(normalize-space(.),'amp','AMP'),'AM') or contains(translate(normalize-space(.),'amp','AMP'),'PM')] | //a[contains(normalize-space(.), ':') or contains(translate(normalize-space(.),'amp','AMP'),'AM') or contains(translate(normalize-space(.),'amp','AMP'),'PM')] | //*[@role='button' and (contains(normalize-space(.), ':') or contains(translate(normalize-space(.),'amp','AMP'),'AM') or contains(translate(normalize-space(.),'amp','AMP'),'PM'))]",
              ),
            )
            .catch(() => []);

    const green = [];
    const anyTime = [];

    for (const el of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const txt = ((await el.getText()) || "").trim();
        if (!looksLikeTimeText(txt)) continue;

        // eslint-disable-next-line no-await-in-loop
        if (!(await isEnabledClickable(el))) continue;

        // eslint-disable-next-line no-await-in-loop
        const isGreen = await isGreenButton(el);
        if (isGreen) green.push({ el, txt });
        else anyTime.push({ el, txt });
      } catch {
        // ignore and continue
      }
    }

    const pick =
      green.length > 0 ? green[0] : anyTime.length > 0 ? anyTime[0] : null;
    if (pick) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
          pick.el,
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(150);
        // eslint-disable-next-line no-await-in-loop
        await safeClick(driver, pick.el);

        // Confirm selection: slot becomes gray or receives `selected-slot`.
        // eslint-disable-next-line no-await-in-loop
        const selected = await driver
          .wait(async () => isSelectedSlot(pick.el), 2500)
          .catch(() => false);
        if (!selected) {
          reportStatus(
            "SLOT_CLICK_NO_CONFIRM",
            `Clicked time slot but selection not confirmed yet: ${pick.txt}`,
          );
        }

        reportStatus(
          "SLOT_SELECTED",
          `Time slot selected: ${pick.txt}${green.length > 0 ? " (green)" : ""}`,
        );
        return true;
      } catch {
        // ignore and retry within timeout
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }

  return false;
}

async function proceedIfAvailableSlotsVisible(driver) {
  // When a date is truly available, the UI shows available slots and a proceed button.
  // We don't finalize booking here; we just move forward to prove the flow is working.
  const proceedBtn = await driver
    .wait(
      until.elementLocated(
        By.xpath(
          "//button[(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SELECT POST') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PROCEED')) or (contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'BOOK') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'POST') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'APPOINTMENT'))]",
        ),
      ),
      12_000,
    )
    .catch(() => null);

  if (!proceedBtn) return false;

  await driver.wait(until.elementIsVisible(proceedBtn), 5000).catch(() => {});
  await jsClick(driver, proceedBtn);
  reportStatus("PROCEEDED", "Proceeded to next step (SELECT/BOOK POST)");
  return true;
}
// Login flow to fill in credentials and wait for user to complete CAPTCHA.
async function login(driver) {
  assertConfigured();

  reportStatus("LOGIN", "Waiting for login form");

  const emailInput = await driver.wait(
    until.elementLocated(By.css('input[formcontrolname="username"]')),
    15000,
  );

  await emailInput.clear();
  await emailInput.sendKeys(CONFIG.USER_EMAIL);

  const passwordInput = await driver.wait(
    until.elementLocated(By.css('input[formcontrolname="password"]')),
    15000,
  );

  await passwordInput.clear();
  await passwordInput.sendKeys(CONFIG.USER_PASSWORD);

  console.log("Credentials filled. Solve CAPTCHA and click SIGN IN.");
  reportStatus("WAITING_CAPTCHA", "Credentials filled; waiting for dashboard");

  await waitForLoginOrBlock(driver, 5 * 60 * 1000);
  console.log("Login successful. Dashboard detected.");
  reportStatus("DASHBOARD", "Dashboard detected");
}

async function isSessionAlive(driver) {
  const url = await driver.getCurrentUrl();
  if (url.includes("/login")) return false;

  // Stronger check: verify the logged-in user's display name is present
  // (This remains valid even when we're not on the dashboard page.)
  if (CONFIG.USER_DISPLAY_NAME) {
    const displayNameSignals = await driver.findElements(
      By.xpath(
        `//*[contains(normalize-space(.), ${JSON.stringify(CONFIG.USER_DISPLAY_NAME)})]`,
      ),
    );
    if (displayNameSignals.length > 0) return true;
  }

  // Fallback: if we're not on login page and a logout/profile area exists.
  // Keep this loose to avoid false negatives.
  return !(await elementExists(
    driver,
    By.css(
      'input[formcontrolname="username"], input[formcontrolname="password"]',
    ),
  ));
}

async function recoverSession(driver) {
  console.log("Session check failed. Attempting recovery...");
  reportLog("warn", "Session check failed; attempting recovery");

  // No refresh: just dismiss overlays and wait briefly for loading to clear.
  await dismissAnyOpenOverlays(driver).catch(() => {});
  await waitForLoadingOverlayToClear(driver, 10_000).catch(() => true);

  if (await isSessionAlive(driver)) {
    console.log("Session recovered.");
    return true;
  }

  // Only attempt login if we really appear to be on the login page.
  const url = await driver.getCurrentUrl();
  if (
    url.includes("/login") ||
    (await elementExists(driver, By.css('input[formcontrolname="username"]')))
  ) {
    console.log("Session lost. Manual login required.");
    reportStatus("WAITING_CAPTCHA", "Session lost; manual login required");
    await login(driver);
  } else {
    console.log("Session unclear, but not on login screen. Continuing.");
  }
  return true;
}

async function goToPendingAppointment(
  driver,
  { forceFromDashboard = false } = {},
) {
  const url = await driver.getCurrentUrl();
  if (!forceFromDashboard && url.includes("/appointment")) {
    console.log("Already on appointment page.");
    reportStatus("APPOINTMENT_PAGE", "Already on appointment page");
    return true;
  }

  // Navigation can end up on /appointment after keepalive/navigation; in that case
  // we still want to reset state by going dashboard -> appointment.
  await goToDashboard(driver);

  // Dashboard can take time to render the tiles. Avoid brittle class selectors;
  // locate the tile/button by its visible text.
  const pendingLabelCandidates = [
    "PENDING APPOINTMENT REQUEST",
    // Some accounts/UIs may omit REQUEST
    "PENDING APPOINTMENT",
  ];

  async function clickPendingAppointmentTile() {
    // Find the label first, then click the closest clickable ancestor.
    // This avoids matching a large container that includes both Cancel + Pending.
    let lastErr = null;

    for (const label of pendingLabelCandidates) {
      const labelEl = await driver
        .wait(
          until.elementLocated(
            By.xpath(`//*[normalize-space(.)=${JSON.stringify(label)}]`),
          ),
          12000,
        )
        .catch(() => null);

      if (!labelEl) continue;

      try {
        await driver
          .wait(until.elementIsVisible(labelEl), 8000)
          .catch(() => {});

        const clickable = await driver.executeScript(
          "const el = arguments[0]; return el.closest(\"button, a, [role='button'], [tabindex], .create-taskbutton\");",
          labelEl,
        );

        const target = clickable || labelEl;
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
          target,
        );
        await sleep(300);
        await jsClick(driver, target);
        return true;
      } catch (err) {
        lastErr = err;
      }
    }

    // Secondary fallback: if the exact label didn't match (e.g., extra spacing),
    // target any *single* element containing the phrase, but exclude the cancel tile.
    try {
      const el = await driver
        .wait(
          until.elementLocated(
            By.xpath(
              "//*[contains(normalize-space(.), 'PENDING APPOINTMENT') and not(contains(normalize-space(.), 'CANCEL APPOINTMENT'))]",
            ),
          ),
          12000,
        )
        .catch(() => null);
      if (el) {
        await driver.wait(until.elementIsVisible(el), 8000).catch(() => {});
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
          el,
        );
        await sleep(300);
        await jsClick(driver, el);
        return true;
      }
    } catch (err) {
      lastErr = err;
    }

    if (lastErr) throw lastErr;
    throw new Error(
      "Pending Appointment Request button not found on dashboard.",
    );
  }

  try {
    await clickPendingAppointmentTile();
  } catch (err) {
    // No refresh: allow a short settle, then retry.
    console.log(
      "Pending Appointment tile not found yet; waiting briefly and retrying...",
    );
    reportLog("warn", "Pending Appointment tile not found; retrying");
    await dismissAnyOpenOverlays(driver).catch(() => {});
    await sleep(1200);
    await goToDashboard(driver);
    await clickPendingAppointmentTile();
  }

  await driver.wait(until.urlContains("/appointment"), 20000);

  console.log("Appointment page reached.");
  reportStatus("APPOINTMENT_PAGE", "Appointment page reached");
  return true;
}

async function goToRescheduleAppointment(
  driver,
  { forceFromDashboard = false } = {},
) {
  const url = await driver.getCurrentUrl();
  if (!forceFromDashboard && url.includes("/appointment")) {
    console.log("Already on appointment page.");
    reportStatus("APPOINTMENT_PAGE", "Already on appointment page");
    return true;
  }

  reportStatus(
    "RESCHEDULE_NAV",
    "Navigating: My Appointments -> RESCHEDULE -> Confirm",
  );

  const MY_APPTS_URL =
    "https://www.usvisaappt.com/visaapplicantui/home/appointment/myappointment";

  // User requirement: do NOT rely on sidebar clicks for this step.
  // Always navigate directly to the My Appointments URL.
  await goToDashboard(driver);
  await dismissAnyOpenOverlays(driver).catch(() => {});
  await waitForLoadingOverlayToClear(driver, 10_000).catch(() => true);

  reportStatus(
    "MY_APPOINTMENTS",
    `Opening My Appointments URL: ${MY_APPTS_URL}`,
  );
  await driver.get(MY_APPTS_URL);
  await driver.wait(
    until.urlContains("/home/appointment/myappointment"),
    25_000,
  );
  reportStatus("MY_APPOINTMENTS_PAGE", "My Appointments page detected");

  await dismissAnyOpenOverlays(driver).catch(() => {});
  await waitForLoadingOverlayToClear(driver, 15_000).catch(() => true);

  // Click the RESCHEDULE control.
  // Real DOM (per user): <a class="... my-app-button-popup-resch ...">RESCHEDULE</a>
  // Keep a fallback for button-based variants.
  const rescheduleBtn = await driver
    .wait(
      until.elementLocated(
        By.xpath(
          "//a[normalize-space(.)='RESCHEDULE' and contains(@class,'my-app-button-popup-resch')] | //a[normalize-space(.)='RESCHEDULE'] | //button[normalize-space(.)='RESCHEDULE' or .//span[normalize-space(.)='RESCHEDULE']]",
        ),
      ),
      15_000,
    )
    .catch(() => null);

  if (!rescheduleBtn) {
    reportStatus("RESCHEDULE_NAV_FAILED", "RESCHEDULE button not found");
    throw new Error("RESCHEDULE button not found on My Appointments page.");
  }

  await driver
    .wait(until.elementIsVisible(rescheduleBtn), 8000)
    .catch(() => {});
  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
    rescheduleBtn,
  );
  await sleep(250);
  await jsClick(driver, rescheduleBtn);
  reportStatus("RESCHEDULE_CLICK", "Clicked RESCHEDULE");

  // Modal: wait for the Angular Material dialog, then click Confirm within it.
  const dialog = await driver
    .wait(
      until.elementLocated(By.css("mat-dialog-container.mat-dialog-container")),
      15_000,
    )
    .catch(() => null);

  if (!dialog) {
    reportStatus("RESCHEDULE_NAV_FAILED", "Confirmation modal not found");
    throw new Error("Reschedule confirmation modal did not appear.");
  }

  await driver.wait(until.elementIsVisible(dialog), 8000).catch(() => {});

  const confirmBtn = await dialog
    .findElement(
      By.xpath(
        ".//button[@cdkfocusinitial or .//span[normalize-space(.)='Confirm' or normalize-space(.)='CONFIRM'] or normalize-space(.)='Confirm' or normalize-space(.)='CONFIRM']",
      ),
    )
    .catch(() => null);

  if (!confirmBtn) {
    reportStatus("RESCHEDULE_NAV_FAILED", "Confirm button not found");
    throw new Error(
      "Confirm button not found in reschedule confirmation modal.",
    );
  }

  await driver.wait(until.elementIsVisible(confirmBtn), 8000).catch(() => {});
  await sleep(200);
  await jsClick(driver, confirmBtn);
  reportStatus("RESCHEDULE_CONFIRM", "Clicked Confirm");

  // Best-effort: wait for modal to close before proceeding.
  await driver.wait(until.stalenessOf(dialog), 15_000).catch(() => {});

  // After confirm, the app should navigate to the appointment booking page.
  // Wait for either URL change away from /myappointment, or the booking block.
  await waitForLoadingOverlayToClear(driver, 20_000).catch(() => true);
  await driver
    .wait(async () => {
      const u = await driver.getCurrentUrl().catch(() => "");
      if (u.includes("/appointment") && !u.includes("/myappointment"))
        return true;
      const bookingBlock = await driver
        .findElements(By.css(".ofc-book-slot-block"))
        .catch(() => []);
      return bookingBlock.length > 0;
    }, 30_000)
    .catch(() => {});

  await dismissAnyOpenOverlays(driver).catch(() => {});
  await waitForLoadingOverlayToClear(driver, 15_000).catch(() => true);

  console.log("Appointment booking page reached.");
  reportStatus("APPOINTMENT_PAGE", "Appointment booking page reached");
  return true;
}

async function goToAppointmentPage(
  driver,
  { forceFromDashboard = false } = {},
) {
  if (CONFIG.RESCHEDULE) {
    return goToRescheduleAppointment(driver, { forceFromDashboard });
  }
  return goToPendingAppointment(driver, { forceFromDashboard });
}

async function selectPickupPoint(driver) {
  // If the app is stuck in the loading overlay, wait/stabilize until it clears (no refresh).
  const preCleared = await waitForLoadingOverlayToClear(driver, 10_000).catch(
    () => true,
  );
  if (!preCleared) {
    await refreshAndRecover(
      driver,
      "loading overlay stuck before pickup select",
    );
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Scope the selector to the booking appointment block so we don't accidentally
      // open a sidebar mat-select.
      // eslint-disable-next-line no-await-in-loop
      const bookingBlock = await driver.wait(
        until.elementLocated(By.css(".ofc-book-slot-block")),
        15000,
      );

      // eslint-disable-next-line no-await-in-loop
      const select = await driver.wait(
        until.elementLocated(
          By.css(
            ".ofc-book-slot-block mat-select[panelclass*='drop-down-panelcls'], .ofc-book-slot-block mat-select",
          ),
        ),
        15000,
      );

      // eslint-disable-next-line no-await-in-loop
      await driver.executeScript(
        "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
        select,
      );

      // If already selected, don't reopen.
      try {
        // eslint-disable-next-line no-await-in-loop
        const valueText = await bookingBlock
          .findElement(By.css(".mat-select-value-text"))
          .getText();
        if (
          valueText &&
          !valueText.includes("Select") &&
          valueText.includes(CONFIG.PICKUP_POINT)
        ) {
          console.log("Pickup point already selected:", CONFIG.PICKUP_POINT);
          await dismissAnyOpenOverlays(driver).catch(() => {});
          return;
        }
      } catch {
        // ignore
      }

      // eslint-disable-next-line no-await-in-loop
      await safeClick(driver, select);

      // Step 2: wait for Angular overlay panel to exist
      // eslint-disable-next-line no-await-in-loop
      await driver.wait(
        until.elementLocated(
          By.css(".cdk-overlay-pane .drop-down-panelcls, .cdk-overlay-pane"),
        ),
        15000,
      );

      // Step 3: wait for desired option inside overlay.
      // If we can't find the option (e.g., Accra), dismiss overlays and retry.
      // eslint-disable-next-line no-await-in-loop
      const option = await driver
        .wait(
          until.elementLocated(
            By.xpath(
              `//div[contains(@class,'cdk-overlay-pane')]//mat-option//span[contains(normalize-space(.), ${JSON.stringify(CONFIG.PICKUP_POINT)})]`,
            ),
          ),
          8000,
        )
        .catch(() => null);

      if (!option) {
        console.log(
          `Pickup option '${CONFIG.PICKUP_POINT}' not found (attempt ${attempt}/3). Retrying...`,
        );
        // Ensure dropdown overlay isn't left open.
        // eslint-disable-next-line no-await-in-loop
        await dismissAnyOpenOverlays(driver).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await sleep(1200);
        continue;
      }

      // Step 4: ensure visibility before clicking
      // eslint-disable-next-line no-await-in-loop
      await driver.wait(until.elementIsVisible(option), 10000).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await safeClick(driver, option);

      // Ensure dropdown is closed (prevents subsequent hangs).
      // eslint-disable-next-line no-await-in-loop
      await dismissAnyOpenOverlays(driver).catch(() => {});

      console.log("Pickup point selected:", CONFIG.PICKUP_POINT);
      reportStatus(
        "PICKUP_SELECTED",
        `Pickup selected: ${CONFIG.PICKUP_POINT}`,
      );
      return;
    } catch (err) {
      console.log(
        `Pickup selection failed (attempt ${attempt}/3): ${err?.message || err}. Retrying...`,
      );
      // eslint-disable-next-line no-await-in-loop
      await dismissAnyOpenOverlays(driver).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
    }
  }

  throw new Error(`Failed to select pickup point: ${CONFIG.PICKUP_POINT}`);
}

let lastAlternatePickupPoint = null;
let lastPickupToggleAtMs = 0;

async function getCurrentPickupValueText(driver) {
  const bookingBlock = await driver.wait(
    until.elementLocated(By.css(".ofc-book-slot-block")),
    12000,
  );
  const valueText = await bookingBlock
    .findElement(By.css(".mat-select-value-text"))
    .getText()
    .catch(() => "");
  return (valueText || "").trim();
}

async function selectPickupPointByName(driver, pickupName) {
  // Quick path: already selected.
  const current = await getCurrentPickupValueText(driver).catch(() => "");
  if (
    current &&
    !current.includes("Select") &&
    current.includes(String(pickupName))
  ) {
    return { selected: true, currentValue: current };
  }

  // Remember a previous non-target selection (for toggling).
  if (
    current &&
    !current.includes(String(pickupName)) &&
    !current.includes("Select")
  ) {
    lastAlternatePickupPoint = current;
  }

  // Reuse the existing robust picker by temporarily overriding the target.
  // (Keep changes localized.)
  const original = CONFIG.PICKUP_POINT;
  CONFIG.PICKUP_POINT = pickupName;
  try {
    await selectPickupPoint(driver);
    return { selected: true, currentValue: pickupName };
  } finally {
    CONFIG.PICKUP_POINT = original;
  }
}

async function forceReselectPickupPoint(driver, pickupName) {
  // Make sure we aren't stuck behind an overlay.
  await waitForLoadingOverlayToClear(driver, 4_000).catch(() => {});
  await dismissAnyOpenOverlays(driver).catch(() => {});

  // Explicitly re-select the same pickup option to retrigger the app's
  // backend call even if the UI already shows it selected.
  const select = await driver.wait(
    until.elementLocated(
      By.css(
        ".ofc-book-slot-block mat-select[panelclass*='drop-down-panelcls'], .ofc-book-slot-block mat-select",
      ),
    ),
    12000,
  );

  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
    select,
  );
  await safeClick(driver, select);
  await driver.wait(until.elementLocated(By.css(".cdk-overlay-pane")), 12000);

  const option = await driver
    .wait(
      until.elementLocated(
        By.xpath(
          `//div[contains(@class,'cdk-overlay-pane')]//mat-option//span[contains(normalize-space(.), ${JSON.stringify(
            String(pickupName),
          )})]`,
        ),
      ),
      12000,
    )
    .catch(() => null);

  if (!option) {
    throw new Error(`Pickup option '${pickupName}' not found for reselect`);
  }

  await driver.wait(until.elementIsVisible(option), 8000).catch(() => {});
  await safeClick(driver, option);

  // Close dropdown reliably.
  await dismissAnyOpenOverlays(driver).catch(() => {});
  await waitForLoadingOverlayToClear(driver, 10_000).catch(() => {});

  lastPickupToggleAtMs = Date.now();
  return true;
}

async function getPickupOptionBefore(driver, pickupName) {
  // Opens the dropdown, reads options in DOM order, and returns the option
  // immediately preceding the target (e.g., the option before "Accra").
  const select = await driver.wait(
    until.elementLocated(
      By.css(
        ".ofc-book-slot-block mat-select[panelclass*='drop-down-panelcls'], .ofc-book-slot-block mat-select",
      ),
    ),
    10000,
  );
  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
    select,
  );
  await select.click();
  await driver.wait(until.elementLocated(By.css(".cdk-overlay-pane")), 10000);

  try {
    const optionEls = await driver.findElements(
      By.css(".cdk-overlay-pane mat-option"),
    );
    const options = [];
    for (const opt of optionEls) {
      // eslint-disable-next-line no-await-in-loop
      const txt = ((await opt.getText()) || "").trim();
      if (!txt) continue;
      options.push(txt);
    }

    const idx = options.findIndex((t) => t.includes(String(pickupName)));
    if (idx > 0) {
      return { found: true, option: options[idx - 1] };
    }

    // Fallback: if target is first or not found, pick any other option.
    const fallback = options.find((t) => !t.includes(String(pickupName)));
    return fallback ? { found: true, option: fallback } : { found: false };
  } finally {
    // Ensure dropdown overlay is closed.
    await dismissAnyOpenOverlays(driver).catch(() => {});
  }
}

async function togglePickupToRefreshAvailability(
  driver,
  { force = false } = {},
) {
  const now = Date.now();
  if (!force && now - lastPickupToggleAtMs < CONFIG.PICKUP_TOGGLE.COOLDOWN_MS) {
    return { toggled: false, reason: "cooldown" };
  }

  // If we don't know a previous option, try to discover one from the dropdown.
  let alt = null;
  try {
    const discovered = await getPickupOptionBefore(driver, CONFIG.PICKUP_POINT);
    alt = discovered?.option || null;
  } catch {
    // ignore discovery errors
  }

  // If discovery failed, fall back to last known alternate.
  if (!alt) alt = lastAlternatePickupPoint;

  if (!alt || alt.includes(CONFIG.PICKUP_POINT)) {
    lastPickupToggleAtMs = Date.now();
    return { toggled: false, reason: "no_alternate" };
  }

  // Toggle: switch away -> switch back to Accra.
  reportLog(
    "info",
    `Toggling pickup to refresh availability: '${alt}' -> '${CONFIG.PICKUP_POINT}'`,
  );

  await selectPickupPointByName(driver, alt).catch(() => null);
  await waitForLoadingOverlayToClear(driver, 10_000).catch(() => {});
  await selectPickupPointByName(driver, CONFIG.PICKUP_POINT).catch(() => null);
  await waitForLoadingOverlayToClear(driver, 10_000).catch(() => {});

  lastAlternatePickupPoint = alt;
  lastPickupToggleAtMs = Date.now();
  return { toggled: true, reason: "ok" };
}

async function triggerPickupCheck(driver) {
  // Ensure each attempt actually triggers the site's availability check.
  // If the UI already shows Accra selected, a plain `selectPickupPoint()` will no-op,
  // which looks like the bot is hanging.
  const current = await getCurrentPickupValueText(driver).catch(() => "");
  if (
    current &&
    !current.includes("Select") &&
    current.includes(String(CONFIG.PICKUP_POINT))
  ) {
    await forceReselectPickupPoint(driver, CONFIG.PICKUP_POINT);
    return;
  }
  await selectPickupPoint(driver);
}

async function isCalendarNavEnabled(driver, cssSelector) {
  const btn = await driver.findElement(By.css(cssSelector));
  const disabledAttr = await btn.getAttribute("disabled");
  const ariaDisabled = await btn.getAttribute("aria-disabled");
  return !disabledAttr && ariaDisabled !== "true";
}

async function goToNextCalendarMonth(driver) {
  const nextSelector = "button.mat-calendar-next-button";
  const nextExists = await elementExists(driver, By.css(nextSelector));
  if (!nextExists) return false;

  if (await isCalendarNavEnabled(driver, nextSelector)) {
    const nextBtn = await driver.findElement(By.css(nextSelector));
    await nextBtn.click();
    await sleep(1200);
    return true;
  }

  // Don't try to click disabled buttons. If navigation is disabled, the site is
  // likely restricting the selectable date range.
  return false;
}

async function sleepWithKeepAlive(driver, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const remaining = totalMs - (Date.now() - start);
    const chunk = Math.min(CONFIG.CALENDAR_SCAN.KEEPALIVE_PULSE_MS, remaining);
    await sleep(chunk);

    try {
      if (!(await isSessionAlive(driver))) {
        await recoverSession(driver);
      } else {
        // No refresh keep-alive (avoids 429). Just dismiss overlays and continue waiting.
        await dismissAnyOpenOverlays(driver).catch(() => {});
      }
    } catch {
      // ignore keep-alive errors; main loop will recover
    }
  }
}
// Final confirmation of applicant checkbox before proceeding to time slot selection.
async function confirmApplicant(driver) {
  // Prefer the applicant-list checkbox (more precise than any checkbox on page).
  const locator = By.xpath(
    "//h3[contains(normalize-space(.),'Applicant List')]/ancestor::*[contains(@class,'group-data-holder')][1]//input[@type='checkbox']",
  );
  const checkbox = await driver.wait(until.elementLocated(locator), 3000);

  const selected = await checkbox.isSelected().catch(() => false);
  if (!selected) {
    await jsClick(driver, checkbox).catch(async () => {
      await checkbox.click();
    });
  }

  reportStatus("APPLICANT_SELECTED", "Applicant checkbox selected");
}
// Main appointment monitoring loop.
async function appointmentWatcher(driver) {
  const intervalMs = CONFIG.ATTEMPTS.INTERVAL_MS;
  const windowMs = CONFIG.ATTEMPTS.WINDOW_MS;
  const maxPerWindow = CONFIG.ATTEMPTS.MAX_PER_WINDOW;

  let windowStartMs = Date.now();
  let attemptsInWindow = 0;
  let nextAttemptAtMs = Date.now();

  async function isOnAppointmentBookingPage() {
    const u = await driver.getCurrentUrl().catch(() => "");
    if (u.includes("/appointment") && !u.includes("/myappointment"))
      return true;
    const bookingBlock = await driver
      .findElements(By.css(".ofc-book-slot-block"))
      .catch(() => []);
    return bookingBlock.length > 0;
  }

  while (true) {
    try {
      // Reset attempt window every WINDOW_MS.
      const nowMs = Date.now();
      if (nowMs - windowStartMs >= windowMs) {
        windowStartMs = nowMs;
        attemptsInWindow = 0;
        reportLog(
          "info",
          `Attempt window reset (every ${Math.round(windowMs / 60_000)}min).`,
        );
      }

      // Enforce attempt budget per window.
      if (attemptsInWindow >= maxPerWindow) {
        const sleepMs = Math.max(0, windowStartMs + windowMs - Date.now());
        reportStatus(
          "RATE_LIMIT",
          `Attempt budget reached (${attemptsInWindow}/${maxPerWindow}); waiting ${Math.round(
            sleepMs / 1000,
          )}s`,
        );

        // This can be a long wait; keep session alive.
        await sleepWithKeepAlive(driver, sleepMs);
        continue;
      }

      // Ensure we're on the appointment booking page BEFORE pacing/counting an attempt.
      // This keeps the 2-second cadence limited to the actions on the appointment page.
      if (!(await isOnAppointmentBookingPage())) {
        reportStatus(
          "NAV",
          "Not on appointment page; navigating (not counted as an attempt)",
        );

        if (!(await isSessionAlive(driver))) {
          await recoverSession(driver);
        }

        await goToAppointmentPage(driver, { forceFromDashboard: true });
        // Give the UI a moment and restart the cadence after navigation.
        nextAttemptAtMs = Date.now() + intervalMs;
        continue;
      }

      // Pace attempts: start an attempt every INTERVAL_MS.
      const waitMs = nextAttemptAtMs - Date.now();
      if (waitMs > 0) {
        // Short waits don't need keep-alive; avoid spamming actions.
        await sleep(waitMs);
      }

      const attemptStartedAtMs = Date.now();
      attemptsInWindow += 1;
      nextAttemptAtMs = attemptStartedAtMs + intervalMs;

      // Avoid persisting status on every 2s tick (helps reduce store.json churn).
      // Still emit periodic status updates so the UI doesn't look dead.
      if (attemptsInWindow === 1 || attemptsInWindow % 10 === 0) {
        reportStatus(
          "ATTEMPT",
          `Attempt ${attemptsInWindow}/${maxPerWindow} (every ${Math.round(
            intervalMs,
          )}ms)`,
        );
      } else {
        reportLog(
          "info",
          `Attempt ${attemptsInWindow}/${maxPerWindow} (every ${Math.round(
            intervalMs,
          )}ms)`,
        );
      }

      // If the page looks stuck in loading, stabilize (no refresh).
      const ready = await waitForLoadingOverlayToClear(driver, 8000).catch(
        () => true,
      );
      if (!ready) {
        await refreshAndRecover(
          driver,
          "loading overlay stuck at attempt start",
        );
      }

      if (!(await isSessionAlive(driver))) {
        await recoverSession(driver);
      }

      // We should already be on the appointment page; avoid doing navigation inside the attempt cadence.

      const result = await fastBookingAttempt(driver);
      if (result === "SUCCESS") {
        console.log("Appointment booking flow progressed.");
        reportStatus("COMPLETED", "Appointment booking flow progressed");
        return;
      }

      reportStatus("LOOP", `Reset pickup and retry (${result})`);
      await resetPickup(driver).catch(() => {});
      nextAttemptAtMs = Date.now() + intervalMs;
      continue;
    } catch (err) {
      if (looksLikeClosedWindowError(err)) {
        console.error(
          "Browser window was closed/crashed. Restarting driver...",
        );
        try {
          await driver.quit();
        } catch {
          // ignore
        }
        // eslint-disable-next-line no-param-reassign
        driver = await createDriver();
        await login(driver);
        continue;
      }
      console.error("Watcher error:", err.message);
      reportLog("error", err.message);
      console.log("Stabilizing and retrying...");
      await sleep(10_000);
    }
  }
}
// Main entry point.
async function main() {
  assertConfigured();
  const driver = await createDriver();
  globalThis.__activeDriver = driver;

  try {
    await login(driver);

    console.log("Bot entering monitoring mode.");
    reportStatus("RUNNING", "Entering monitoring mode");
    await appointmentWatcher(driver);

    // After success, stay idle on the dashboard.
    await goToDashboard(driver).catch(() => {});
    reportStatus("IDLE", "Success; idling on dashboard");
    console.log("Bot idle on dashboard. Browser remains open.");
    await driver.wait(() => false, Infinity);
  } catch (err) {
    // Unknown error: rethrow after cleanup.
    try {
      await driver.quit();
    } catch {
      // ignore
    }
    throw err;
  }
}

let shuttingDown = false;

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  reportStatus("STOPPED", "Received SIGTERM; shutting down");
  const d = globalThis.__activeDriver;
  if (d) {
    Promise.resolve()
      .then(() => d.quit())
      .catch(() => {})
      .finally(() => process.exit(0));
    return;
  }
  process.exit(0);
});

main();
