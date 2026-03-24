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
  USER_PASSWORD: process.env.VISA_USER_PASSWORD,
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
    // This value is also used to cap how long we wait for the loading overlay
    // after pickup refresh/reselect (keeps refresh fast).
    TOAST_WAIT_MS: Math.max(
      500,
      Number(process.env.VISA_TOAST_WAIT_MS) || 2500,
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

async function detectBookingConfirmed(driver) {
  const url = await driver.getCurrentUrl().catch(() => "");
  if (!url) return { confirmed: false, signal: "no_url" };
  if (url.includes("/login")) return { confirmed: false, signal: "login" };

  // If login inputs are present, treat as session-dead.
  const loginInputs = await driver
    .findElements(
      By.css(
        'input[formcontrolname="username"], input[formcontrolname="password"]',
      ),
    )
    .catch(() => []);
  if (loginInputs.length > 0) {
    return { confirmed: false, signal: "session_dead" };
  }

  // Route-level signals.
  if (url.includes("/dashboard")) {
    return { confirmed: true, signal: "dashboard" };
  }

  if (url.includes("/home/appointment/myappointment")) {
    return { confirmed: true, signal: "myappointment" };
  }

  // Text-level signals: only check dialogs/snackbars/alerts to avoid matching
  // unrelated content on the appointment page.
  const signal = await driver
    .executeScript(() => {
      const selectors = [
        "mat-dialog-container",
        "mat-mdc-dialog-container",
        ".mat-snack-bar-container",
        ".mat-mdc-snack-bar-container",
        "snack-bar-container",
        "[role='alert']",
        ".toast",
        ".toast-container",
      ];

      const nodes = selectors.flatMap((sel) =>
        Array.from(document.querySelectorAll(sel)),
      );

      const combined = nodes
        .map((n) => (n?.innerText || n?.textContent || "").trim())
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      const hasBooked =
        combined.includes("appointment booked") ||
        combined.includes("appointment confirmed") ||
        combined.includes("successfully booked") ||
        combined.includes("appointment successfully") ||
        (combined.includes("success") && combined.includes("appointment"));

      return { hasBooked };
    })
    .catch(() => ({ hasBooked: false }));

  if (signal.hasBooked) return { confirmed: true, signal: "success_toast" };

  return { confirmed: false, signal: "none" };
}

function scoreConfirmActionText(txt) {
  const t = String(txt || "")
    .trim()
    .toUpperCase();
  if (!t) return null;

  const negative = ["CANCEL", "BACK", "NO", "CLOSE"];
  if (negative.some((w) => t.includes(w))) return null;

  const positive = ["CONFIRM", "BOOK", "SUBMIT", "YES", "OK"];
  const idx = positive.findIndex((w) => t.includes(w) || t === w);
  if (idx === -1) return null;
  return idx;
}

async function clickPrimaryConfirmInContainer(driver, containerEl) {
  const containerText = ((await containerEl.getText().catch(() => "")) || "")
    .trim()
    .toUpperCase();

  const looksLikeCancelDialog =
    containerText.includes("CANCEL APPOINTMENT") ||
    (containerText.includes("CANCEL") && containerText.includes("APPOINTMENT"));

  const genericOkAllowed =
    containerText.includes("BOOK") ||
    containerText.includes("RESCHEDULE") ||
    containerText.includes("APPOINTMENT BOOKED") ||
    containerText.includes("APPOINTMENT CONFIRMED") ||
    (containerText.includes("SUCCESS") &&
      containerText.includes("APPOINTMENT"));

  const buttons = await containerEl.findElements(By.css("button, a"));
  let best = null;

  for (const el of buttons) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await el.isDisplayed())) continue;

      // eslint-disable-next-line no-await-in-loop
      const disabledAttr = await el.getAttribute("disabled");
      // eslint-disable-next-line no-await-in-loop
      const ariaDisabled = await el.getAttribute("aria-disabled");
      if (disabledAttr || ariaDisabled === "true") continue;

      // eslint-disable-next-line no-await-in-loop
      const rawText = ((await el.getText().catch(() => "")) || "").trim();
      // eslint-disable-next-line no-await-in-loop
      const ariaLabel = (
        (await el.getAttribute("aria-label").catch(() => "")) || ""
      ).trim();
      const txt = rawText || ariaLabel;
      const score = scoreConfirmActionText(txt);
      if (score === null) continue;

      // Safety: never confirm cancellation dialogs.
      if (looksLikeCancelDialog) continue;

      // Safety: only allow generic YES/OK when context is clearly booking-related.
      if (score >= 3 && !genericOkAllowed) continue;

      // eslint-disable-next-line no-await-in-loop
      const focusInitial = await el
        .getAttribute("cdkfocusinitial")
        .catch(() => null);

      const cand = {
        el,
        score,
        text: txt,
        focusInitial: focusInitial !== null,
      };

      if (!best) {
        best = cand;
        continue;
      }

      if (cand.focusInitial && !best.focusInitial) {
        best = cand;
        continue;
      }
      if (cand.score < best.score) {
        best = cand;
      }
    } catch {
      // ignore
    }
  }

  if (!best) return { clicked: false };

  await driver
    .executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
      best.el,
    )
    .catch(() => {});
  await sleep(120);
  await safeClick(driver, best.el).catch(() => jsClick(driver, best.el));
  return { clicked: true, text: best.text || null };
}

async function clickSnackbarActionIfPresent(driver) {
  const snackbars = await driver
    .findElements(
      By.css(
        ".mat-snack-bar-container, .mat-mdc-snack-bar-container, snack-bar-container",
      ),
    )
    .catch(() => []);

  for (const sb of snackbars) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await sb.isDisplayed())) continue;

      // Snackbars are non-destructive; allow dismiss/ok/close.
      // eslint-disable-next-line no-await-in-loop
      const buttons = await sb.findElements(By.css("button"));
      for (const b of buttons) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await b.isDisplayed().catch(() => false))) continue;
        // eslint-disable-next-line no-await-in-loop
        const disabledAttr = await b.getAttribute("disabled");
        // eslint-disable-next-line no-await-in-loop
        const ariaDisabled = await b.getAttribute("aria-disabled");
        if (disabledAttr || ariaDisabled === "true") continue;

        // eslint-disable-next-line no-await-in-loop
        const txt = ((await b.getText().catch(() => "")) || "").trim();
        // eslint-disable-next-line no-await-in-loop
        await safeClick(driver, b).catch(() => jsClick(driver, b));
        return { clicked: true, kind: "snackbar", text: txt || null };
      }
    } catch {
      // ignore
    }
  }

  return { clicked: false, kind: null, text: null };
}

async function clickFinalConfirmationIfPresent(driver) {
  // Prefer modal/dialog primary actions.
  const dialogs = await driver
    .findElements(
      By.css("mat-dialog-container, mat-mdc-dialog-container, [role='dialog']"),
    )
    .catch(() => []);

  for (const dialog of dialogs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await dialog.isDisplayed())) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await clickPrimaryConfirmInContainer(driver, dialog);
      if (res.clicked) return { clicked: true, kind: "dialog", text: res.text };
    } catch {
      // ignore
    }
  }

  // If a snackbar is visible, dismiss it (may unblock UI).
  const snack = await clickSnackbarActionIfPresent(driver);
  if (snack.clicked) return snack;

  // Page-level confirm/book buttons.
  // Keep this strict to avoid clicking unrelated controls.
  const candidates = await driver
    .findElements(
      By.xpath(
        "//button[not(@disabled) and (contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CONFIRM') or contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'BOOK') or contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SUBMIT')) and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CANCEL')) and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'BACK')) and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CLOSE')) and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'NO'))]",
      ),
    )
    .catch(() => []);

  // Pick the best candidate by text scoring.
  let best = null;
  for (const el of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await el.isDisplayed())) continue;
      // eslint-disable-next-line no-await-in-loop
      const txt = ((await el.getText().catch(() => "")) || "").trim();
      const score = scoreConfirmActionText(txt);
      if (score === null) continue;

      if (!best || score < best.score) {
        best = { el, score, text: txt };
      }
    } catch {
      // ignore
    }
  }

  if (best) {
    await driver
      .executeScript(
        "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
        best.el,
      )
      .catch(() => {});
    await sleep(120);
    await safeClick(driver, best.el).catch(() => jsClick(driver, best.el));
    return { clicked: true, kind: "page", text: best.text || null };
  }

  return { clicked: false, kind: null, text: null };
}

async function finalizeBookingAndConfirm(driver, { timeoutMs = 25_000 } = {}) {
  const start = Date.now();
  let clickedSomething = false;

  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const sig = await detectBookingConfirmed(driver).catch(() => ({
      confirmed: false,
      signal: "detect_failed",
    }));
    if (sig.confirmed) return { confirmed: true, signal: sig.signal };

    // eslint-disable-next-line no-await-in-loop
    const click = await clickFinalConfirmationIfPresent(driver);
    if (click.clicked) {
      clickedSomething = true;
      reportStatus(
        "FINAL_CONFIRM_CLICK",
        `Clicked final confirmation (${click.kind}): ${click.text || "(unknown)"}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await waitForLoadingOverlayToClear(driver, 30_000).catch(() => true);
      // eslint-disable-next-line no-await-in-loop
      await dismissAnyOpenOverlays(driver).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(650);
  }

  const sig = await detectBookingConfirmed(driver).catch(() => ({
    confirmed: false,
    signal: "detect_failed",
  }));
  return {
    confirmed: Boolean(sig.confirmed),
    signal: sig.signal || (clickedSomething ? "pending" : "timeout"),
  };
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

async function findGreenAvailableDateWithinRange(
  driver,
  { excludeKeys = new Set() } = {},
) {
  // Scan visible calendar cells, find green (#14a38b), and only click if within
  // allowed MIN_DATE..MAX_DATE.
  // NOTE: Clicking/confirming selection is done in the browser context to avoid
  // stale-element flakiness when the calendar re-renders.
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
    return {
      clicked: false,
      selected: false,
      outOfRangeFound: false,
      greenFound: 0,
      greenInRangeFound: 0,
    };
  }

  const minMs = allowed.min ? allowed.min.getTime() : null;
  const maxMs = allowed.max ? allowed.max.getTime() : null;

  const excludeArr =
    excludeKeys && typeof excludeKeys.has === "function"
      ? Array.from(excludeKeys)
      : [];

  const scan = await driver
    .executeAsyncScript(
      (
        defaultYear,
        defaultMonthIndex,
        minMsArg,
        maxMsArg,
        excludeArg,
        done,
      ) => {
        try {
          const exclude = new Set(Array.isArray(excludeArg) ? excludeArg : []);

          const toInt = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };

          const parseRgb = (color) => {
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
          };

          const isGreen = (color) => {
            const rgb = parseRgb(color);
            if (!rgb) return false;
            if (rgb.a === 0) return false;
            // Some browsers return slightly different channel values; allow small tolerance.
            const tol = 2;
            return (
              Math.abs(rgb.r - 20) <= tol &&
              Math.abs(rgb.g - 163) <= tol &&
              Math.abs(rgb.b - 139) <= tol
            );
          };

          const monthMap = {
            january: 0,
            february: 1,
            march: 2,
            april: 3,
            may: 4,
            june: 5,
            july: 6,
            august: 7,
            september: 8,
            october: 9,
            november: 10,
            december: 11,
          };

          const parseDateFromAria = (label) => {
            const s = String(label || "").trim();
            if (!s) return null;

            // Example: "March 22, 2026"
            let m = s.match(
              /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/,
            );
            if (m) {
              const monthIndex = monthMap[String(m[1] || "").toLowerCase()];
              const day = toInt(m[2]);
              const year = toInt(m[3]);
              if (Number.isFinite(monthIndex) && day != null && year != null) {
                return { year, monthIndex, day };
              }
            }

            // Example: "22 March 2026"
            m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/);
            if (m) {
              const day = toInt(m[1]);
              const monthIndex = monthMap[String(m[2] || "").toLowerCase()];
              const year = toInt(m[3]);
              if (Number.isFinite(monthIndex) && day != null && year != null) {
                return { year, monthIndex, day };
              }
            }

            return null;
          };

          const pad2 = (n) => String(n).padStart(2, "0");
          const makeKey = (y, mIdx, d) => `${y}-${pad2(mIdx + 1)}-${pad2(d)}`;

          const pickTarget = (el) => {
            if (!el) return null;
            const tag = String(el.tagName || "").toLowerCase();
            if (tag === "button" || el.getAttribute("role") === "button") {
              return el;
            }
            const btn =
              el.querySelector("button.mat-calendar-body-cell") ||
              el.querySelector("button");
            return btn || el;
          };

          const cells = Array.from(
            document.querySelectorAll(
              "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
            ),
          );

          const candidates = [];
          let greenTotal = 0;
          let outOfRangeTotal = 0;

          for (const cell of cells) {
            try {
              const target = pickTarget(cell);
              if (!target) continue;

              const disabledAttr = target.getAttribute("disabled");
              const ariaDisabled = target.getAttribute("aria-disabled");
              if (disabledAttr != null || ariaDisabled === "true") continue;

              const content =
                target.querySelector(".mat-calendar-body-cell-content") ||
                cell.querySelector(".mat-calendar-body-cell-content");
              if (!content) continue;

              const contentClass = String(content.getAttribute("class") || "");
              if (contentClass.includes("mat-calendar-body-selected")) continue;

              const ariaPressed = target.getAttribute("aria-pressed");
              if (ariaPressed === "true") continue;

              const day = toInt(String(content.textContent || "").trim());
              if (day == null || day <= 0 || day > 31) continue;

              const colors = [];
              const pushStyle = (el, prop) => {
                try {
                  colors.push(getComputedStyle(el)[prop]);
                } catch {
                  // ignore
                }
              };

              pushStyle(content, "backgroundColor");
              pushStyle(content, "color");
              pushStyle(content, "borderColor");
              pushStyle(target, "backgroundColor");
              pushStyle(target, "color");
              pushStyle(target, "borderColor");

              if (!colors.some((c) => isGreen(c))) continue;

              greenTotal += 1;

              const ariaLabel =
                target.getAttribute("aria-label") ||
                content.getAttribute("aria-label") ||
                "";
              const parsed = parseDateFromAria(ariaLabel);

              const y = parsed?.year ?? defaultYear;
              const mIdx = parsed?.monthIndex ?? defaultMonthIndex;
              const d = parsed?.day ?? day;

              const dateMs = Date.UTC(y, mIdx, d);
              if (minMsArg != null && dateMs < minMsArg) {
                outOfRangeTotal += 1;
                continue;
              }
              if (maxMsArg != null && dateMs > maxMsArg) {
                outOfRangeTotal += 1;
                continue;
              }

              const dateKey = makeKey(y, mIdx, d);
              candidates.push({ dateKey, dateMs, target });
            } catch {
              // ignore cell errors
            }
          }

          candidates.sort((a, b) => a.dateMs - b.dateMs);

          const selectedMatches = (expectedKey) => {
            try {
              const selBtn =
                document.querySelector(
                  "button.mat-calendar-body-cell[aria-pressed='true']",
                ) || null;
              if (selBtn) {
                const lbl = selBtn.getAttribute("aria-label") || "";
                const parsed = parseDateFromAria(lbl);
                const content = selBtn.querySelector(
                  ".mat-calendar-body-cell-content",
                );
                const day = toInt(String(content?.textContent || "").trim());
                const y = parsed?.year ?? defaultYear;
                const mIdx = parsed?.monthIndex ?? defaultMonthIndex;
                const d = parsed?.day ?? day;
                const key = makeKey(y, mIdx, d);
                return key === expectedKey;
              }

              const selContent =
                document.querySelector(
                  ".mat-calendar-body-cell-content.mat-calendar-body-selected",
                ) || null;
              if (selContent) {
                const btn =
                  selContent.closest("button.mat-calendar-body-cell") ||
                  selContent.closest("td.mat-calendar-body-cell") ||
                  null;
                const lbl = btn?.getAttribute("aria-label") || "";
                const parsed = parseDateFromAria(lbl);
                const day = toInt(String(selContent.textContent || "").trim());
                const y = parsed?.year ?? defaultYear;
                const mIdx = parsed?.monthIndex ?? defaultMonthIndex;
                const d = parsed?.day ?? day;
                const key = makeKey(y, mIdx, d);
                return key === expectedKey;
              }
            } catch {
              // ignore
            }
            return false;
          };

          let clickedAny = false;

          const finish = (payload) => {
            done({
              scanned: cells.length,
              greenTotal,
              outOfRangeTotal,
              greensInRangeTotal: candidates.length,
              outOfRangeFound: outOfRangeTotal > 0,
              clickedAny,
              ...payload,
            });
          };

          const tryIdx = (idx) => {
            if (idx >= candidates.length) {
              finish({ clicked: clickedAny, selected: false, dateKey: null });
              return;
            }

            const cand = candidates[idx];
            if (exclude.has(cand.dateKey)) {
              tryIdx(idx + 1);
              return;
            }

            try {
              cand.target.scrollIntoView({
                block: "center",
                inline: "nearest",
              });
            } catch {
              // ignore
            }

            try {
              cand.target.click();
              clickedAny = true;
            } catch {
              try {
                const content = cand.target.querySelector(
                  ".mat-calendar-body-cell-content",
                );
                if (content) {
                  content.click();
                  clickedAny = true;
                }
              } catch {
                // ignore
              }
            }

            setTimeout(() => {
              const ok =
                selectedMatches(cand.dateKey) ||
                cand.target.getAttribute("aria-pressed") === "true" ||
                (() => {
                  const content = cand.target.querySelector(
                    ".mat-calendar-body-cell-content",
                  );
                  if (!content) return false;
                  const cls = String(content.getAttribute("class") || "");
                  return (
                    cls.includes("mat-calendar-body-selected") ||
                    cls.includes("mat-calendar-body-active")
                  );
                })();

              if (ok) {
                finish({
                  clicked: true,
                  selected: true,
                  dateKey: cand.dateKey,
                  dateIso: cand.dateKey,
                });
              } else {
                tryIdx(idx + 1);
              }
            }, 120);
          };

          if (candidates.length === 0) {
            finish({ clicked: false, selected: false, dateKey: null });
            return;
          }

          tryIdx(0);
        } catch {
          done(null);
        }
      },
      header.year,
      header.monthIndex,
      minMs,
      maxMs,
      excludeArr,
    )
    .catch(() => null);

  if (!scan) {
    reportStatus("DATE_SCAN_FAILED", "Calendar scan failed; will retry");
    reportLog(
      "warn",
      "Calendar scan failed (executeAsyncScript returned null)",
    );
    return {
      clicked: false,
      selected: false,
      outOfRangeFound: false,
      greenFound: 0,
      greenInRangeFound: 0,
    };
  }

  const greenFound = Number(scan.greenTotal) || 0;
  const greenInRangeFound = Number(scan.greensInRangeTotal) || 0;
  const outOfRangeFound = Boolean(scan.outOfRangeFound);

  reportLog(
    "info",
    `Calendar month context: ${header.year}-${String(header.monthIndex + 1).padStart(2, "0")} (cells: ${Number(scan.scanned) || 0}, green: ${greenFound}, in-range: ${greenInRangeFound})`,
  );

  if (scan.selected && scan.dateKey) {
    reportStatus(
      "DATE_SELECTED",
      `Clicked in-range green date ${scan.dateKey}`,
    );
    return {
      clicked: true,
      selected: true,
      outOfRangeFound,
      dateKey: scan.dateKey,
      dateIso: scan.dateIso || scan.dateKey,
      greenFound,
      greenInRangeFound,
    };
  }

  const clickedAny = Boolean(scan.clickedAny);
  if (greenFound === 0) {
    reportStatus(
      "NO_GREEN_DATE",
      `No green dates found in current calendar view (cells scanned: ${Number(scan.scanned) || 0})`,
    );
  } else if (greenInRangeFound === 0) {
    reportStatus(
      "NO_IN_RANGE_GREEN",
      `Found ${greenFound} green date(s), but none within allowed range; will keep scanning (no pickup reset)`,
    );
  } else if (clickedAny) {
    reportStatus(
      "DATE_CLICK_NO_CONFIRM",
      `Clicked green date(s) (${greenInRangeFound} in-range) but selection not confirmed yet; will retry (no pickup reset)`,
    );
  } else {
    reportStatus(
      "NO_DATE_CLICK",
      `Found ${greenFound} green date(s) (${greenInRangeFound} in-range) but failed to select; will retry (no pickup reset)`,
    );
  }

  return {
    clicked: clickedAny,
    selected: false,
    outOfRangeFound,
    greenFound,
    greenInRangeFound,
  };
}

async function waitForLoadingOverlay(
  driver,
  { appearMs = 2500, disappearMs = 15_000 } = {},
) {
  // The platform does not always show the overlay even when it updates.
  // Treat "overlay never appeared" as non-fatal to avoid unnecessary re-scans.
  const start = Date.now();
  while (Date.now() - start < appearMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isLoadingOverlayVisible(driver)) {
      return waitForLoadingOverlayToClear(driver, disappearMs);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }

  if (await isLoadingOverlayVisible(driver)) {
    return waitForLoadingOverlayToClear(driver, disappearMs);
  }

  return true;
}

async function waitForPickupUiUpdate(driver) {
  // Goal: be fast. We only wait briefly for the overlay to appear, then cap
  // the clear wait to the configured pickup update window.
  const maxWaitMs = Math.max(
    500,
    Number(CONFIG.ATTEMPTS.TOAST_WAIT_MS) || 2500,
  );
  const appearMs = Math.min(900, maxWaitMs);
  await waitForLoadingOverlay(driver, {
    appearMs,
    disappearMs: maxWaitMs,
  }).catch(() => true);
  await sleep(120);
}

async function checkApplicantCheckbox(driver) {
  return confirmApplicant(driver);
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

async function ensureCalendarAtOrAfterAllowedMinMonth(driver) {
  const allowed = getAllowedDateRange();
  if (!allowed.min) return true;

  const current = await getCalendarHeaderText(driver)
    .then(parseMonthYear)
    .catch(() => null);
  if (!current) return true;

  const want = {
    year: allowed.min.getUTCFullYear(),
    monthIndex: allowed.min.getUTCMonth(),
  };

  if (monthKey(current) >= monthKey(want)) return true;

  reportStatus(
    "CALENDAR_JUMP",
    `Jumping calendar to allowed min month: ${want.year}-${String(want.monthIndex + 1).padStart(2, "0")}`,
  );
  await setCalendarToMonth(driver, want).catch(() => false);
  return true;
}

async function goToNextCalendarMonthAndWait(driver, beforeHeader) {
  const beforeKey = beforeHeader ? monthKey(beforeHeader) : null;
  const moved = await goToNextCalendarMonth(driver).catch(() => false);
  if (!moved) return { moved: false, header: beforeHeader || null };

  const start = Date.now();
  while (Date.now() - start < 5000) {
    // eslint-disable-next-line no-await-in-loop
    const hdr = await getCalendarHeaderText(driver)
      .then(parseMonthYear)
      .catch(() => null);
    if (hdr && (beforeKey == null || monthKey(hdr) !== beforeKey)) {
      return { moved: true, header: hdr };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }

  const hdr = await getCalendarHeaderText(driver)
    .then(parseMonthYear)
    .catch(() => null);
  return { moved: true, header: hdr || beforeHeader || null };
}

async function pulseApplicantCheckbox(driver) {
  reportStatus(
    "APPLICANT_PULSE",
    "Pulsing applicant checkbox (uncheck/recheck) to lock state",
  );

  const res = await driver
    .executeAsyncScript((done) => {
      try {
        const norm = (s) =>
          String(s || "")
            .trim()
            .toLowerCase();

        const headers = Array.from(
          document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
        );
        const hdr = headers.find((h) =>
          norm(h.textContent).includes("applicant list"),
        );
        const scope = hdr ? hdr.closest("section,div") || document : document;

        const isChecked = () => {
          const checkedInput = scope.querySelector(
            "input[type='checkbox']:checked",
          );
          if (checkedInput) return true;

          const ariaChecked = scope.querySelector("[aria-checked='true']");
          if (ariaChecked) return true;

          const checkedClass = scope.querySelector(
            ".checked, .is-checked, .mat-checkbox-checked, .mat-mdc-checkbox-checked",
          );
          if (checkedClass) return true;

          const spanChecked = scope.querySelector(
            "span.checkbox.checked, span.checkbox.is-checked",
          );
          return Boolean(spanChecked);
        };

        const findTarget = () => {
          const input =
            scope.querySelector(
              "input[type='checkbox'][id^='styled-checkbox-']",
            ) ||
            scope.querySelector(".custom-checkbox input[type='checkbox']") ||
            scope.querySelector("input[type='checkbox']");
          if (input) return input;

          const span =
            scope.querySelector(".custom-checkbox span.checkbox") ||
            scope.querySelector("span.checkbox");
          if (span) return span;

          return scope.querySelector("[role='checkbox']");
        };

        const click = (el) => {
          if (!el) return false;
          try {
            const disabled = el.getAttribute("disabled");
            const ariaDisabled = el.getAttribute("aria-disabled");
            if (disabled != null || ariaDisabled === "true") return false;
          } catch {
            // ignore
          }

          try {
            el.scrollIntoView({ block: "center", inline: "nearest" });
          } catch {
            // ignore
          }

          try {
            el.click();
            return true;
          } catch {
            return false;
          }
        };

        const target = findTarget();
        if (!target) {
          done({ ok: false, reason: "no_checkbox" });
          return;
        }

        const before = isChecked();

        // Toggle twice to force the app to re-evaluate the applicant selection.
        click(target);
        setTimeout(() => {
          click(target);
          setTimeout(() => {
            if (!isChecked()) {
              click(target);
            }
            setTimeout(() => {
              done({ ok: isChecked(), before, after: isChecked() });
            }, 140);
          }, 180);
        }, 180);
      } catch {
        done({ ok: false, reason: "exception" });
      }
    })
    .catch(() => null);

  const ok = Boolean(res?.ok);
  reportStatus(
    "APPLICANT_PULSE_DONE",
    ok ? "Applicant pulse complete" : "Applicant pulse skipped/failed",
  );
  return ok;
}

// Core algorithm (strict):
// (PENDING) APPLICANT -> SELECT_PICKUP -> DATE -> SLOT -> PROCEED -> SUCCESS
// (RESCHEDULE) SELECT_PICKUP -> DATE -> SLOT -> PROCEED -> SUCCESS
// NOTE: We do not do the old "reset pickup" loop anymore; retries happen on the
// next attempt tick without toggling pickup.
async function fastBookingAttempt(driver) {
  try {
    reportStatus("ALGO", "Starting booking attempt (green-date algorithm)");

    // Stabilize first.
    await waitForLoadingOverlayToClear(driver, 8_000).catch(() => true);
    await dismissAnyOpenOverlays(driver).catch(() => {});

    // Requirement: check the Applicant List checkbox ASAP in PENDING mode.
    if (!CONFIG.RESCHEDULE) {
      reportStatus("APPLICANT", "Checking applicant checkbox (early)");
      await checkApplicantCheckbox(driver).catch(() => false);
    }

    // If we're already past calendar selection (slots visible or a date already
    // selected), do not reselect/toggle pickup again.
    const alreadySelectedDate = await driver
      .executeScript(() => {
        return Boolean(
          document.querySelector(
            "button.mat-calendar-body-cell[aria-pressed='true']",
          ) ||
          document.querySelector(
            ".mat-calendar-body-cell-content.mat-calendar-body-selected",
          ) ||
          document.querySelector(
            ".mat-calendar-body-cell-content.mat-calendar-body-active",
          ),
        );
      })
      .catch(() => false);

    const alreadyOnSlots = await waitForAvailableSlotHeader(driver, 350).catch(
      () => false,
    );

    if (!alreadyOnSlots && !alreadySelectedDate) {
      // Refresh pickup availability (but only while we're still in calendar stage).
      await selectPickupAccra(driver);

      // Some UIs may re-render on pickup selection; ensure the checkbox stays selected.
      if (!CONFIG.RESCHEDULE) {
        await checkApplicantCheckbox(driver).catch(() => false);
      }
    }

    // NEW behavior:
    // - If multiple in-range green dates exist, try them in order until we see the
    //   Available Slot header.
    // - If a newly green date appears while we're trying (e.g. 23rd shows up after
    //   26th), the next scan will pick it.
    const triedDateKeys = new Set();
    let headerOk = alreadyOnSlots;

    // If we already have a selected date, wait briefly for slots to appear.
    if (!headerOk && alreadySelectedDate) {
      // Pending-mode fix: sometimes the UI forgets the applicant selection even
      // when the checkbox looks checked. Pulsing the applicant checkbox forces
      // the form to re-evaluate.
      if (!CONFIG.RESCHEDULE) {
        reportStatus(
          "APPLICANT",
          "Re-confirming applicant (date already selected)",
        );
        await confirmApplicant(driver).catch(() => false);
        await pulseApplicantCheckbox(driver).catch(() => false);
        await waitForLoadingOverlayToClear(driver, 2500).catch(() => true);
        await confirmApplicant(driver).catch(() => false);
      }

      reportStatus(
        "HEADER",
        "Date already selected; waiting for Available Slot header",
      );
      headerOk = await waitForAvailableSlotHeader(driver, 2500);
    }

    // Otherwise scan for in-range green dates and click one.
    if (!headerOk) {
      // If the user configured a minimum allowed date, ensure we're not stuck
      // hunting in earlier months.
      await ensureCalendarAtOrAfterAllowedMinMonth(driver).catch(() => {});

      const allowed = getAllowedDateRange();
      const maxMonthKey = allowed.max
        ? allowed.max.getUTCFullYear() * 12 + allowed.max.getUTCMonth()
        : Infinity;

      const maxMonths = Math.max(
        1,
        Number(CONFIG.CALENDAR_SCAN.MAX_MONTHS) || 6,
      );
      const maxDatesPerMonth = 31;

      let anyGreenSeen = false;
      let currentHeader = await getCalendarHeaderText(driver)
        .then(parseMonthYear)
        .catch(() => null);

      for (let monthTry = 0; monthTry < maxMonths && !headerOk; monthTry += 1) {
        if (currentHeader) {
          reportStatus(
            "CALENDAR_MONTH",
            `Hunting green dates in ${currentHeader.year}-${String(currentHeader.monthIndex + 1).padStart(2, "0")}`,
          );
        }

        // Important: rescan the current month a few times before traversing.
        // Green dates can appear with a slight delay after UI updates.
        const maxScansPerMonth = 2;
        let scanTries = 0;
        let dateTries = 0;

        while (
          !headerOk &&
          scanTries < maxScansPerMonth &&
          dateTries < maxDatesPerMonth
        ) {
          scanTries += 1;

          const dateScan = await findGreenAvailableDateWithinRange(driver, {
            excludeKeys: triedDateKeys,
          });

          if (dateScan.greenFound > 0) anyGreenSeen = true;

          if (!dateScan.selected) {
            // If we clicked but selection didn't confirm, retry quickly in this month.
            if (dateScan.clicked) {
              await dismissAnyOpenOverlays(driver).catch(() => {});
              // eslint-disable-next-line no-await-in-loop
              await sleep(80);
              continue;
            }

            // No in-range selection yet; wait briefly and rescan this same month.
            reportStatus(
              "CALENDAR_RESCAN",
              "No selectable in-range green date yet; rescanning current month",
            );
            await waitForLoadingOverlayToClear(driver, 1200).catch(() => true);
            await dismissAnyOpenOverlays(driver).catch(() => {});
            // eslint-disable-next-line no-await-in-loop
            await sleep(180);
            continue;
          }

          dateTries += 1;
          if (dateScan.dateKey) triedDateKeys.add(dateScan.dateKey);

          reportStatus(
            "OVERLAY",
            `Waiting for booking UI after date selection: ${dateScan.dateIso || dateScan.dateKey || "(unknown)"}`,
          );
          const cleared = await waitForLoadingOverlayToClear(
            driver,
            8_000,
          ).catch(() => true);
          if (!cleared) {
            reportStatus(
              "OVERLAY_TIMEOUT",
              "Loading overlay stuck after date selection; stabilizing",
            );
            await refreshAndRecover(
              driver,
              "loading overlay stuck after date",
              {
                timeoutMs: 20_000,
              },
            ).catch(() => {});
          }

          await dismissAnyOpenOverlays(driver).catch(() => {});

          // Pending-mode fix: after selecting a date, the platform can still
          // complain that no applicant is selected. Force a quick date reselect
          // and re-confirm the checkbox.
          if (!CONFIG.RESCHEDULE) {
            reportStatus(
              "APPLICANT",
              "Re-confirming applicant after date selection",
            );
            await confirmApplicant(driver).catch(() => false);
            await pulseApplicantCheckbox(driver).catch(() => false);
            await waitForLoadingOverlayToClear(driver, 2500).catch(() => true);
            await confirmApplicant(driver).catch(() => false);
          }

          reportStatus(
            "HEADER",
            `Waiting for Available Slot header (date ${dateScan.dateIso || dateScan.dateKey || "?"})`,
          );
          headerOk = await waitForAvailableSlotHeader(driver, 2500);
          if (headerOk) break;

          reportStatus(
            "HEADER_MISSING_DATE",
            `No Available Slot header for ${dateScan.dateIso || dateScan.dateKey || "(unknown)"}; trying next green date`,
          );
          // eslint-disable-next-line no-await-in-loop
          await sleep(80);
        }

        if (headerOk) break;

        // Do not traverse beyond the configured max date month.
        if (currentHeader && monthKey(currentHeader) >= maxMonthKey) {
          reportStatus(
            "CALENDAR_MAX_MONTH",
            "Reached maximum allowed month; cannot traverse further",
          );
          break;
        }

        const nav = await goToNextCalendarMonthAndWait(driver, currentHeader);
        if (!nav.moved) {
          reportStatus(
            "CALENDAR_NEXT_DISABLED",
            "Next month button disabled; cannot traverse further",
          );
          break;
        }
        currentHeader = nav.header;
        await dismissAnyOpenOverlays(driver).catch(() => {});
        await sleep(120);
      }

      if (!headerOk && !anyGreenSeen) {
        return "NO_GREEN_DATE";
      }
    }

    if (!headerOk) {
      reportStatus(
        "HEADER_MISSING",
        "Available Slot header not visible yet; will retry (no pickup reset)",
      );
      return "NO_AVAILABLE_SLOT_HEADER";
    }

    reportStatus(
      "SLOT",
      CONFIG.RESCHEDULE
        ? "Selecting earliest available time slot (reschedule: no traversal)"
        : "Clicking first available time slot",
    );

    let slotStage1 = CONFIG.RESCHEDULE
      ? await clickEarliestTimeSlotOnly(driver, 6000)
      : await clickFirstTimeSlot(driver);

    if (!CONFIG.RESCHEDULE && !slotStage1.confirmed && slotStage1.foundAny) {
      reportStatus(
        "SLOT_RETRY_STAGE1",
        "Time slots detected but selection not confirmed; retrying",
      );
      slotStage1 = await clickFirstAvailableTimeSlot(driver, 6000);
    }

    if (!slotStage1.confirmed) {
      if (slotStage1.foundAny) {
        reportStatus(
          "SLOT_SELECT_FAILED_STAGE1",
          "Time slots were visible but none could be selected; will retry (no pickup reset)",
        );
        return "SLOT_SELECT_FAILED_STAGE1";
      }
      reportStatus(
        "SLOT_MISSING_STAGE1",
        "No time slot clickable before proceed; will try proceed and re-scan",
      );
    }

    reportStatus(
      "PROCEED",
      CONFIG.RESCHEDULE
        ? "Clicking SELECT"
        : "Clicking SELECT POST AND PROCEED",
    );
    const beforeProceedUrl = await driver.getCurrentUrl().catch(() => "");
    const beforeProceedHandles = await driver
      .getAllWindowHandles()
      .catch(() => []);
    const proceedStage1 = await clickProceedButton(driver).catch(() => ({
      clicked: false,
      kind: null,
      text: null,
    }));
    if (!proceedStage1.clicked) {
      reportStatus(
        "PROCEED_MISSING",
        "Proceed button not clickable/visible; will retry (no pickup reset)",
      );
      return "PROCEED_MISSING";
    }

    // Some flows show the time-slot list only AFTER clicking proceed.
    // User requirement: if a list of time buttons appears after proceed, click one.
    reportStatus("OVERLAY", "Waiting for loading overlay after proceed");
    const overlayClearedAfterProceed = await waitForLoadingOverlayToClear(
      driver,
      30_000,
    ).catch(() => true);
    if (!overlayClearedAfterProceed) {
      reportStatus(
        "OVERLAY_STUCK_AFTER_PROCEED",
        "Loading overlay stuck after proceed; stabilizing",
      );
      await refreshAndRecover(driver, "loading overlay stuck after proceed", {
        timeoutMs: 20_000,
      }).catch(() => {});
    }

    await switchToNewWindowIfOpened(driver, beforeProceedHandles).catch(() => ({
      switched: false,
      handles: beforeProceedHandles,
    }));
    await dismissAnyOpenOverlays(driver).catch(() => {});

    const afterProceedUrl = await driver.getCurrentUrl().catch(() => "");
    const blankAfterProceed = await isProbablyBlankPage(driver).catch(
      () => false,
    );
    if (blankAfterProceed) {
      reportStatus(
        "PROCEED_WHITE_SCREEN",
        "Proceed led to a blank/white page; recovering to appointment page",
      );
      reportLog(
        "error",
        `Blank page after proceed (kind=${proceedStage1.kind || "unknown"}) url: ${afterProceedUrl || "(unknown)"} (from ${beforeProceedUrl || "(unknown)"})`,
      );
      await goToAppointmentPage(driver, { forceFromDashboard: true }).catch(
        () => {},
      );
      return "PROCEED_WHITE_SCREEN";
    }

    reportStatus(
      "SLOT_STAGE2",
      CONFIG.RESCHEDULE
        ? "Selecting earliest time slot after proceed (reschedule: no traversal)"
        : "Scanning for time slot buttons after proceed",
    );
    const slotStage2 = CONFIG.RESCHEDULE
      ? await clickEarliestTimeSlotOnly(driver, 6000)
      : await clickFirstAvailableTimeSlot(driver, 6000);
    if (slotStage2.confirmed) {
      reportStatus(
        "SLOT_SELECTED_STAGE2",
        "Selected a time slot after proceed",
      );

      // If the same proceed button is still present, click it again to continue.
      const beforeProceed2Url = await driver.getCurrentUrl().catch(() => "");
      const beforeProceed2Handles = await driver
        .getAllWindowHandles()
        .catch(() => []);
      const proceedStage2 = await clickProceedButton(driver).catch(() => ({
        clicked: false,
        kind: null,
        text: null,
      }));
      if (proceedStage2.clicked) {
        reportStatus("PROCEED_STAGE2", "Clicked proceed after slot selection");
        const overlayClearedAfterProceed2 = await waitForLoadingOverlayToClear(
          driver,
          30_000,
        ).catch(() => true);
        if (!overlayClearedAfterProceed2) {
          reportStatus(
            "OVERLAY_STUCK_AFTER_PROCEED2",
            "Loading overlay stuck after second proceed; stabilizing",
          );
          await refreshAndRecover(
            driver,
            "loading overlay stuck after second proceed",
            { timeoutMs: 20_000 },
          ).catch(() => {});
        }

        await switchToNewWindowIfOpened(driver, beforeProceed2Handles).catch(
          () => ({ switched: false, handles: beforeProceed2Handles }),
        );
        await dismissAnyOpenOverlays(driver).catch(() => {});

        const afterProceed2Url = await driver.getCurrentUrl().catch(() => "");
        const blankAfterProceed2 = await isProbablyBlankPage(driver).catch(
          () => false,
        );
        if (blankAfterProceed2) {
          reportStatus(
            "PROCEED2_WHITE_SCREEN",
            "Second proceed led to a blank/white page; recovering",
          );
          reportLog(
            "error",
            `Blank page after second proceed (kind=${proceedStage2.kind || "unknown"}) url: ${afterProceed2Url || "(unknown)"} (from ${beforeProceed2Url || "(unknown)"})`,
          );
          await goToAppointmentPage(driver, { forceFromDashboard: true }).catch(
            () => {},
          );
          return "PROCEED2_WHITE_SCREEN";
        }
      } else {
        reportStatus(
          "PROCEED_STAGE2_MISSING",
          "Proceed button not found after slot selection; continuing",
        );
      }
    } else {
      if (slotStage2.foundAny) {
        reportStatus(
          "SLOT_STAGE2_SELECT_FAILED",
          "Time slots were visible after proceed but none could be selected; will retry (no pickup reset)",
        );
        return "SLOT_STAGE2_SELECT_FAILED";
      }

      reportStatus(
        "SLOT_STAGE2_NONE",
        "No post-proceed time-slot list detected (ok)",
      );
    }

    // Final guard: never report SUCCESS if the app is on a blank/white screen.
    if (await isProbablyBlankPage(driver)) {
      reportStatus(
        "WHITE_SCREEN_GUARD",
        "Detected blank/white page; recovering and retrying",
      );
      await goToAppointmentPage(driver, { forceFromDashboard: true }).catch(
        () => {},
      );
      return "WHITE_SCREEN_GUARD";
    }

    // Finalize: only report SUCCESS after a real confirm/success signal.
    reportStatus("FINALIZE", "Finalizing booking (confirm + success check)");
    const final = await finalizeBookingAndConfirm(driver, {
      timeoutMs: 25_000,
    });
    if (!final.confirmed) {
      reportStatus(
        "FINALIZE_PENDING",
        `Booking not confirmed yet (${final.signal}); will retry (no pickup reselect)`,
      );
      return "FINAL_NOT_CONFIRMED";
    }

    reportStatus("SUCCESS", `Booking confirmed (${final.signal})`);
    return "SUCCESS";
  } catch (err) {
    reportLog("error", String(err?.message || err));
    return "ERROR";
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
    await sleep(200);
  }
  return false;
}

async function switchToNewWindowIfOpened(driver, beforeHandles) {
  const before = Array.isArray(beforeHandles) ? beforeHandles : [];
  const after = await driver.getAllWindowHandles().catch(() => before);
  if (after.length <= before.length) return { switched: false, handles: after };

  const newOnes = after.filter((h) => !before.includes(h));
  const target = newOnes[newOnes.length - 1] || after[after.length - 1];
  await driver
    .switchTo()
    .window(target)
    .catch(() => {});
  return { switched: true, handles: after };
}

async function isProbablyBlankPage(driver) {
  const url = await driver.getCurrentUrl().catch(() => "");
  if (!url) return false;
  if (url === "about:blank") return true;
  if (url.startsWith("chrome-error://")) return true;

  try {
    const stats = await driver.executeScript(() => {
      const body = document.body;
      const txt = body ? (body.innerText || "").trim() : "";
      const childCount = body ? body.children.length : 0;
      const hasBooking = Boolean(
        document.querySelector(".ofc-book-slot-block"),
      );
      const hasLogin = Boolean(
        document.querySelector("input[formcontrolname='username']") ||
        document.querySelector("input[formcontrolname='password']"),
      );
      const hasSpinner = Boolean(
        document.querySelector(".ngx-spinner-overlay"),
      );
      return {
        textLen: txt.length,
        childCount,
        hasBooking,
        hasLogin,
        hasSpinner,
        readyState: document.readyState,
      };
    });

    if (stats.hasSpinner) return false;
    if (stats.hasBooking || stats.hasLogin) return false;

    // White-screen symptom: app root exists but nothing rendered.
    return stats.textLen < 20 && stats.childCount <= 1;
  } catch {
    return false;
  }
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

  let foundAny = false;
  let clickedAny = false;
  let lastPickedText = null;

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

    if (green.length > 0 || anyTime.length > 0) foundAny = true;

    const pick =
      green.length > 0 ? green[0] : anyTime.length > 0 ? anyTime[0] : null;
    if (pick) {
      clickedAny = true;
      lastPickedText = pick.txt;
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
          // Keep trying within timeout; do not claim success yet.
          // eslint-disable-next-line no-await-in-loop
          await sleep(250);
          continue;
        }

        reportStatus(
          "SLOT_SELECTED",
          `Time slot selected: ${pick.txt}${green.length > 0 ? " (green)" : ""}`,
        );
        return {
          foundAny: true,
          clicked: true,
          confirmed: true,
          text: pick.txt,
        };
      } catch {
        // ignore and retry within timeout
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }

  return {
    foundAny,
    clicked: clickedAny,
    confirmed: false,
    text: lastPickedText,
  };
}

function parseTimeTextToMinutes(value) {
  const t = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (!t) return null;

  // Matches:
  // - 10:30 AM
  // - 03:15PM
  // - 15:30
  // - 3 PM
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\b/);
  if (!m) return null;

  let hh = Number(m[1]);
  const mm = m[2] != null ? Number(m[2]) : 0;
  const ap = m[3] || null;

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (mm < 0 || mm > 59) return null;

  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === "AM") {
      if (hh === 12) hh = 0;
    } else if (ap === "PM") {
      if (hh !== 12) hh += 12;
    }
  } else {
    // No AM/PM; treat as 24h clock when possible.
    if (hh < 0 || hh > 23) return null;
  }

  return hh * 60 + mm;
}

async function clickEarliestTimeSlotOnly(driver, timeoutMs = 6000) {
  const start = Date.now();

  const looksLikeTimeText = (txt) => {
    const t = String(txt || "").trim();
    if (!t) return false;
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

  let foundAny = false;
  let clickedAny = false;
  let lastPickedText = null;
  let desiredMinutes = null;

  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const slotButtonsPreferred = await driver
      .findElements(
        By.css(
          ".ofc-appoinment-sloat-block .booking-time-buttons.slot_calender button.green-button, .booking-time-buttons.slot_calender button.green-button",
        ),
      )
      .catch(() => []);

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

        const minutes = parseTimeTextToMinutes(txt);
        // eslint-disable-next-line no-await-in-loop
        const isGreen = await isGreenButton(el);
        if (isGreen) green.push({ el, txt, minutes });
        else anyTime.push({ el, txt, minutes });
      } catch {
        // ignore
      }
    }

    if (green.length > 0 || anyTime.length > 0) foundAny = true;

    const sortByMinutes = (a, b) => {
      const am = Number.isFinite(a.minutes)
        ? a.minutes
        : Number.POSITIVE_INFINITY;
      const bm = Number.isFinite(b.minutes)
        ? b.minutes
        : Number.POSITIVE_INFINITY;
      if (am !== bm) return am - bm;
      return String(a.txt).localeCompare(String(b.txt));
    };

    green.sort(sortByMinutes);
    anyTime.sort(sortByMinutes);

    const pick =
      green.length > 0 ? green[0] : anyTime.length > 0 ? anyTime[0] : null;
    if (!pick) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
      continue;
    }

    // Once we decide the earliest slot, keep retrying ONLY that slot.
    if (desiredMinutes == null && Number.isFinite(pick.minutes)) {
      desiredMinutes = pick.minutes;
    }
    clickedAny = true;
    lastPickedText = pick.txt;

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

      // eslint-disable-next-line no-await-in-loop
      const selected = await driver
        .wait(async () => isSelectedSlot(pick.el), 2500)
        .catch(() => false);

      if (!selected) {
        reportStatus(
          "SLOT_CLICK_NO_CONFIRM",
          `Clicked earliest time slot but selection not confirmed yet: ${pick.txt}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(250);
        continue;
      }

      reportStatus(
        "SLOT_SELECTED",
        `Time slot selected (earliest): ${pick.txt}${green.length > 0 ? " (green)" : ""}`,
      );
      return {
        foundAny: true,
        clicked: true,
        confirmed: true,
        text: pick.txt,
      };
    } catch {
      // ignore and retry within timeout (same earliest slot)
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }

  return {
    foundAny,
    clicked: clickedAny,
    confirmed: false,
    text: lastPickedText,
    desiredMinutes,
  };
}

async function proceedIfAvailableSlotsVisible(driver) {
  // When a date is truly available, the UI shows available slots and a proceed button.
  // We don't finalize booking here; we just move forward to prove the flow is working.
  const xpathSelectProceed =
    "//button[(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SELECT POST') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PROCEED'))]";
  const xpathBookPost =
    "//button[(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'BOOK') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'POST') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'APPOINTMENT'))]";
  const xpathSelectOnlyNearSlots =
    "(//*[contains(normalize-space(.), 'Available Slot') or contains(normalize-space(.), 'Available Slots')])[1]/following::button[not(@disabled) and (normalize-space(.)='SELECT' or contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SELECT'))][1]";

  const selectProceedBtn = await driver
    .wait(until.elementLocated(By.xpath(xpathSelectProceed)), 12_000)
    .catch(() => null);

  const bookPostBtn = selectProceedBtn
    ? null
    : await driver
        .wait(until.elementLocated(By.xpath(xpathBookPost)), 2500)
        .catch(() => null);

  const selectOnlyBtn =
    selectProceedBtn || bookPostBtn
      ? null
      : await driver
          .wait(until.elementLocated(By.xpath(xpathSelectOnlyNearSlots)), 1500)
          .catch(() => null);

  const proceedBtn = selectProceedBtn || bookPostBtn || selectOnlyBtn;

  const kind = selectProceedBtn
    ? "SELECT_POST_AND_PROCEED"
    : bookPostBtn
      ? "BOOK_POST_APPOINTMENT"
      : selectOnlyBtn
        ? "SELECT"
        : null;

  if (!proceedBtn) return { clicked: false, kind: null, text: null };

  await driver.wait(until.elementIsVisible(proceedBtn), 5000).catch(() => {});

  const btnText = ((await proceedBtn.getText().catch(() => "")) || "").trim();
  await driver
    .executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
      proceedBtn,
    )
    .catch(() => {});
  await sleep(150);

  // Wait for enabled state (best-effort; aria-disabled is common on Angular buttons)
  const enabled = await driver
    .wait(async () => {
      try {
        const disabledAttr = await proceedBtn.getAttribute("disabled");
        const ariaDisabled = await proceedBtn.getAttribute("aria-disabled");
        return !disabledAttr && ariaDisabled !== "true";
      } catch {
        return true;
      }
    }, 8000)
    .catch(() => true);

  if (!enabled) {
    reportStatus(
      "PROCEED_DISABLED",
      `Proceed button stayed disabled (${btnText || kind || "unknown"})`,
    );
    return { clicked: false, kind, text: btnText || null };
  }

  await safeClick(driver, proceedBtn);
  reportStatus(
    "PROCEEDED",
    `Clicked proceed: ${btnText || kind || "(unknown)"}`,
  );
  return { clicked: true, kind, text: btnText || null };
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
  const url = await driver.getCurrentUrl().catch(() => "");

  // If we already have the booking block in DOM, we're ready to hunt.
  const bookingBlocksNow = await driver
    .findElements(By.css(".ofc-book-slot-block"))
    .catch(() => []);
  if (bookingBlocksNow.length > 0) {
    console.log("Already on appointment booking page.");
    reportStatus("APPOINTMENT_PAGE", "Already on appointment booking page");
    return true;
  }

  // If we're already on an appointment route (but the booking UI is still loading),
  // do NOT restart navigation (this causes repeated reload loops). Just wait.
  if (url.includes("/appointment") && !url.includes("/myappointment")) {
    reportStatus(
      "BOOKING_WAIT",
      "On appointment route; waiting for booking page to fully load",
    );
    const ready = await waitForAppointmentBookingPageReady(driver, {
      timeoutMs: 120_000,
    });
    if (ready) {
      console.log("Appointment booking page reached.");
      reportStatus("APPOINTMENT_PAGE", "Appointment booking page reached");
      return true;
    }

    // Fall through to full navigation if it still didn't load.
    reportLog(
      "warn",
      "Booking UI did not load on appointment route; restarting navigation",
    );
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

  // Ensure the booking UI exists before returning. Without this, the watcher
  // may see no booking block and re-navigate repeatedly.
  reportStatus(
    "BOOKING_WAIT",
    "Appointment route reached; waiting for booking page UI",
  );
  const readyAfterNav = await waitForAppointmentBookingPageReady(driver, {
    timeoutMs: 120_000,
  });
  if (!readyAfterNav) {
    reportStatus(
      "NAV_FAILED",
      "Booking page did not fully load after Pending Appointment navigation",
    );
    throw new Error(
      "Appointment booking page did not fully load after Pending Appointment navigation.",
    );
  }

  console.log("Appointment booking page reached.");
  reportStatus("APPOINTMENT_PAGE", "Appointment booking page reached");
  return true;
}

async function goToRescheduleAppointment(
  driver,
  { forceFromDashboard = false } = {},
) {
  const url = await driver.getCurrentUrl().catch(() => "");

  // If we already have the booking block in DOM, we're ready to hunt.
  const bookingBlocksNow = await driver
    .findElements(By.css(".ofc-book-slot-block"))
    .catch(() => []);
  if (bookingBlocksNow.length > 0) {
    console.log("Already on appointment booking page.");
    reportStatus("APPOINTMENT_PAGE", "Already on appointment booking page");
    return true;
  }

  // If we're already on an appointment route (but the booking UI is still loading),
  // do NOT restart navigation (this causes repeated reloads). Just wait.
  if (url.includes("/appointment") && !url.includes("/myappointment")) {
    reportStatus(
      "BOOKING_WAIT",
      "On appointment route; waiting for booking page to fully load",
    );
    const ready = await waitForAppointmentBookingPageReady(driver, {
      timeoutMs: 120_000,
    });
    if (ready) {
      console.log("Appointment booking page reached.");
      reportStatus("APPOINTMENT_PAGE", "Appointment booking page reached");
      return true;
    }

    // Fall through to full navigation if it still didn't load.
    reportLog(
      "warn",
      "Booking UI did not load on appointment route; restarting navigation",
    );
  }

  reportStatus(
    "RESCHEDULE_NAV",
    "Navigating: My Appointments -> RESCHEDULE -> Confirm",
  );

  const MY_APPTS_URL = `${getAppBaseUrl()}/home/appointment/myappointment`;

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

  // After confirm, wait for the actual booking UI to exist (no reload loops).
  reportStatus(
    "BOOKING_WAIT",
    "Confirm clicked; waiting for booking page UI to fully load",
  );
  const readyAfterConfirm = await waitForAppointmentBookingPageReady(driver, {
    timeoutMs: 120_000,
  });
  if (!readyAfterConfirm) {
    reportStatus(
      "RESCHEDULE_NAV_FAILED",
      "Booking page did not fully load after Confirm",
    );
    throw new Error(
      "Appointment booking page did not fully load after RESCHEDULE Confirm.",
    );
  }

  console.log("Appointment booking page reached.");
  reportStatus("APPOINTMENT_PAGE", "Appointment booking page reached");
  return true;
}

async function waitForAppointmentBookingPageReady(
  driver,
  { timeoutMs = 60_000 } = {},
) {
  const bookingBlock = await driver
    .wait(
      until.elementLocated(By.css(".ofc-book-slot-block")),
      Math.max(1, timeoutMs),
    )
    .catch(() => null);

  if (!bookingBlock) return false;

  await driver
    .wait(until.elementIsVisible(bookingBlock), 15_000)
    .catch(() => {});

  // Clear any spinners/overlays; the booking UI can exist but still be unusable.
  await waitForLoadingOverlayToClear(driver, 60_000).catch(() => true);
  await dismissAnyOpenOverlays(driver).catch(() => {});

  // Ensure the pickup select is present before returning; this prevents early returns
  // during partial renders.
  await driver
    .wait(
      until.elementLocated(
        By.css(
          ".ofc-book-slot-block mat-select[panelclass*='drop-down-panelcls'], .ofc-book-slot-block mat-select",
        ),
      ),
      30_000,
    )
    .catch(() => null);

  if (await isProbablyBlankPage(driver).catch(() => false)) return false;
  return true;
}

async function goToAppointmentPage(
  driver,
  { forceFromDashboard = false } = {},
) {
  const preferredMode = CONFIG.RESCHEDULE ? "RESCHEDULE" : "PENDING";
  reportStatus("MODE", `Appointment mode: ${preferredMode}`);

  try {
    if (CONFIG.RESCHEDULE) {
      return await goToRescheduleAppointment(driver, { forceFromDashboard });
    }
    return await goToPendingAppointment(driver, { forceFromDashboard });
  } catch (err) {
    const msg = String(err?.message || err);
    const msgLower = msg.toLowerCase();

    // Safe fallback only when the configured mode is clearly unavailable.
    const modeUnavailable = CONFIG.RESCHEDULE
      ? msgLower.includes("reschedule button not found")
      : msgLower.includes("pending appointment") &&
        msgLower.includes("not found");

    if (!modeUnavailable) throw err;

    const fallbackMode = CONFIG.RESCHEDULE ? "PENDING" : "RESCHEDULE";
    reportLog(
      "warn",
      `Appointment navigation (${preferredMode}) unavailable (${msg}); trying ${fallbackMode}`,
    );
    reportStatus(
      "MODE_FALLBACK",
      `Trying fallback appointment mode: ${fallbackMode}`,
    );

    try {
      if (CONFIG.RESCHEDULE) {
        return await goToPendingAppointment(driver, { forceFromDashboard });
      }
      return await goToRescheduleAppointment(driver, { forceFromDashboard });
    } catch (fallbackErr) {
      reportLog(
        "error",
        `Fallback appointment navigation (${fallbackMode}) failed: ${String(
          fallbackErr?.message || fallbackErr,
        )}`,
      );
      throw err;
    }
  }
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
        await sleep(300);
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
      await sleep(300);
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
  await waitForPickupUiUpdate(driver).catch(() => {});

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
  await waitForPickupUiUpdate(driver).catch(() => {});
  await selectPickupPointByName(driver, CONFIG.PICKUP_POINT).catch(() => null);
  await waitForPickupUiUpdate(driver).catch(() => {});

  lastAlternatePickupPoint = alt;
  lastPickupToggleAtMs = Date.now();
  return { toggled: true, reason: "ok" };
}

async function refreshPickupAvailabilityViaSelectThenTarget(
  driver,
  pickupName,
  { force = false } = {},
) {
  const now = Date.now();
  if (!force && now - lastPickupToggleAtMs < CONFIG.PICKUP_TOGGLE.COOLDOWN_MS) {
    return { refreshed: false, reason: "cooldown" };
  }

  reportStatus(
    "PICKUP_REFRESH",
    `Refreshing pickup: Select -> ${String(pickupName)}`,
  );

  try {
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

    // 1) Open and pick the placeholder "Select" option.
    await safeClick(driver, select);
    await driver.wait(until.elementLocated(By.css(".cdk-overlay-pane")), 12000);

    const selectOption = await driver
      .wait(
        until.elementLocated(
          By.xpath(
            "//div[contains(@class,'cdk-overlay-pane')]//mat-option//span[contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SELECT') and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ACCRA'))]",
          ),
        ),
        6000,
      )
      .catch(() => null);

    if (selectOption) {
      await driver
        .wait(until.elementIsVisible(selectOption), 8000)
        .catch(() => {});
      await safeClick(driver, selectOption).catch(() =>
        jsClick(driver, selectOption),
      );
      await dismissAnyOpenOverlays(driver).catch(() => {});
      await waitForPickupUiUpdate(driver).catch(() => true);
    } else {
      // If the placeholder option isn't present, fall back to a forced reselect.
      await dismissAnyOpenOverlays(driver).catch(() => {});
    }

    // 2) Open again and pick the target pickup.
    await safeClick(driver, select);
    await driver.wait(until.elementLocated(By.css(".cdk-overlay-pane")), 12000);

    const targetOption = await driver
      .wait(
        until.elementLocated(
          By.xpath(
            `//div[contains(@class,'cdk-overlay-pane')]//mat-option//span[contains(normalize-space(.), ${JSON.stringify(
              String(pickupName),
            )})]`,
          ),
        ),
        8000,
      )
      .catch(() => null);

    if (!targetOption) {
      throw new Error(
        `Pickup option '${String(pickupName)}' not found during refresh`,
      );
    }

    await driver
      .wait(until.elementIsVisible(targetOption), 8000)
      .catch(() => {});
    await safeClick(driver, targetOption).catch(() =>
      jsClick(driver, targetOption),
    );
    await dismissAnyOpenOverlays(driver).catch(() => {});
    await waitForPickupUiUpdate(driver).catch(() => true);

    lastPickupToggleAtMs = Date.now();
    reportStatus("PICKUP_REFRESHED", `Pickup refreshed: ${String(pickupName)}`);
    return { refreshed: true, reason: "ok" };
  } catch (err) {
    reportLog(
      "warn",
      `Pickup refresh failed; falling back to force reselect: ${String(
        err?.message || err,
      )}`,
    );
    await forceReselectPickupPoint(driver, pickupName).catch(() => {});
    lastPickupToggleAtMs = Date.now();
    return { refreshed: true, reason: "fallback_force_reselect" };
  }
}

async function triggerPickupCheck(driver) {
  // Requirement update: refresh availability by re-selecting pickup.
  // If it's already set to the configured pickup point, explicitly
  // select the placeholder "Select" option and then pick the pickup again.
  const current = await getCurrentPickupValueText(driver).catch(() => "");
  if (
    current &&
    !current.includes("Select") &&
    current.includes(String(CONFIG.PICKUP_POINT))
  ) {
    await refreshPickupAvailabilityViaSelectThenTarget(
      driver,
      CONFIG.PICKUP_POINT,
    ).catch(() => {});
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
    await sleep(350);
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
  // Applicant list checkbox (per user DOM): input#styled-checkbox-1, etc.
  // Some UIs hide the <input> and expect clicking the styled <span>.
  const locators = [
    By.css("input[type='checkbox'][id^='styled-checkbox-']"),
    By.css(".custom-checkbox input[type='checkbox']"),
    By.css(".custom-checkbox span.checkbox"),
    By.xpath(
      "//input[@type='checkbox' and starts-with(@id,'styled-checkbox-')]",
    ),
    By.xpath(
      "//h3[contains(normalize-space(.),'Applicant List')]/following::input[@type='checkbox'][1]",
    ),
    By.xpath(
      "//h3[contains(normalize-space(.),'Applicant List')]/following::span[contains(@class,'checkbox')][1]",
    ),
    By.xpath(
      "//h3[contains(normalize-space(.),'Applicant List')]/ancestor::*[contains(@class,'group-data-holder')][1]//input[@type='checkbox']",
    ),
  ];

  async function isApplicantChecked() {
    return driver
      .executeScript(() => {
        const norm = (s) =>
          String(s || "")
            .trim()
            .toLowerCase();

        const headers = Array.from(
          document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
        );
        const hdr = headers.find((h) =>
          norm(h.textContent).includes("applicant list"),
        );
        const scope = hdr ? hdr.closest("section,div") || document : document;

        const checkedInput = scope.querySelector(
          "input[type='checkbox']:checked",
        );
        if (checkedInput) return true;

        const ariaChecked = scope.querySelector("[aria-checked='true']");
        if (ariaChecked) return true;

        const checkedClass = scope.querySelector(
          ".checked, .is-checked, .mat-checkbox-checked, .mat-mdc-checkbox-checked",
        );
        if (checkedClass) return true;

        // Last resort: some custom checkboxes toggle a class on the span itself.
        const spanChecked = scope.querySelector(
          "span.checkbox.checked, span.checkbox.is-checked",
        );
        return Boolean(spanChecked);
      })
      .then(Boolean)
      .catch(() => false);
  }

  let checkbox = null;
  for (const locator of locators) {
    // eslint-disable-next-line no-await-in-loop
    const els = await driver.findElements(locator).catch(() => []);
    for (const el of els) {
      try {
        // Accept hidden <input> elements (JS click still works).
        // For non-input elements, require visible.
        // eslint-disable-next-line no-await-in-loop
        const tag = await el.getTagName().catch(() => "");
        if (String(tag).toLowerCase() === "input") {
          checkbox = el;
          break;
        }

        // eslint-disable-next-line no-await-in-loop
        if (await el.isDisplayed().catch(() => false)) {
          checkbox = el;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (checkbox) break;
  }

  if (!checkbox) {
    reportStatus("APPLICANT_CHECKBOX_MISSING", "Applicant checkbox not found");
    reportLog("warn", "Applicant checkbox not found");
    return false;
  }

  const tag = await checkbox.getTagName().catch(() => "");
  const isInput = String(tag).toLowerCase() === "input";

  if (isInput) {
    const selectedBefore =
      (await checkbox.isSelected().catch(() => false)) ||
      (await isApplicantChecked());
    if (selectedBefore) {
      reportStatus("APPLICANT_SELECTED", "Applicant checkbox already selected");
      return true;
    }
  } else {
    const selectedBefore = await isApplicantChecked();
    if (selectedBefore) {
      reportStatus("APPLICANT_SELECTED", "Applicant checkbox already selected");
      return true;
    }
  }

  // Click the primary candidate.
  await driver
    .executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
      checkbox,
    )
    .catch(() => {});

  await jsClick(driver, checkbox).catch(async () => {
    await safeClick(driver, checkbox);
  });

  let selected = false;
  if (isInput) {
    selected = await driver
      .wait(async () => {
        const v = await checkbox.isSelected().catch(() => false);
        if (v) return true;
        return isApplicantChecked();
      }, 2000)
      .catch(async () => {
        const v = await checkbox.isSelected().catch(() => false);
        return v || isApplicantChecked();
      });
  } else {
    selected = await driver
      .wait(async () => isApplicantChecked(), 2000)
      .catch(() => isApplicantChecked());
  }

  if (!selected) {
    // Fallback: click a nearby styled span.
    const span = await checkbox
      .findElement(
        By.xpath("following-sibling::*[contains(@class,'checkbox')][1]"),
      )
      .catch(async () => {
        // Try ancestor label/container.
        const parentSpan = await driver
          .executeScript(
            "const el = arguments[0]; const root = el.closest('label,.custom-checkbox,td,tr,div') || el.parentElement; if (!root) return null; return root.querySelector('span.checkbox');",
            checkbox,
          )
          .catch(() => null);
        return parentSpan || null;
      });

    if (span) {
      await safeClick(driver, span)
        .catch(() => jsClick(driver, span))
        .catch(() => {});

      if (isInput) {
        selected = await driver
          .wait(async () => {
            const v = await checkbox.isSelected().catch(() => false);
            if (v) return true;
            return isApplicantChecked();
          }, 2000)
          .catch(async () => {
            const v = await checkbox.isSelected().catch(() => false);
            return v || isApplicantChecked();
          });
      } else {
        selected = await driver
          .wait(async () => isApplicantChecked(), 2000)
          .catch(() => isApplicantChecked());
      }
    }
  }

  if (selected) {
    reportStatus("APPLICANT_SELECTED", "Applicant checkbox selected");
    return true;
  }

  reportStatus(
    "APPLICANT_NOT_SELECTED",
    "Applicant checkbox click did not stick",
  );
  reportLog("warn", "Applicant checkbox click did not stick");
  return false;
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
        console.log("Booking confirmed.");
        reportStatus("COMPLETED", "Booking confirmed");
        return;
      }

      reportStatus("LOOP", `Retrying (${result})`);
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
