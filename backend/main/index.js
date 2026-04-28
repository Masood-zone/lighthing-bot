const { chromium } = require("playwright");

try {
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch {
  // ignore
}

function monthKey({ monthIndex, year }) {
  return year * 12 + monthIndex;
}

async function getCalendarMonthYear(page) {
  const headerText = await getCalendarHeaderText(page).catch(() => "");
  const parts = String(headerText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .split(" ");
  if (parts.length < 2) return null;

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
  const monthIndex = months.indexOf(parts[0]);
  const year = Number(parts[1]);
  if (monthIndex < 0 || !Number.isFinite(year)) return null;
  return { monthIndex, year };
}

const CONFIG = {
  PLATFORM_URL:
    process.env.VISA_PLATFORM_URL ||
    "https://www.usvisaappt.com/visaapplicantui/login",
  USER_EMAIL: process.env.VISA_USER_EMAIL || "Wilhelmina219.doe@gmail.com",
  USER_PASSWORD: process.env.VISA_USER_PASSWORD || "",
  USER_DISPLAY_NAME: process.env.VISA_USER_DISPLAY_NAME || "Wilhelmina Doe",
  PICKUP_POINT: process.env.VISA_PICKUP_POINT || "Accra",
  HEADLESS:
    process.env.VISA_HEADLESS === "1" || process.env.VISA_HEADLESS === "true",
  RESCHEDULE:
    process.env.VISA_RESCHEDULE === "1" ||
    process.env.VISA_RESCHEDULE === "true",
  INTERVAL_MS: Math.max(
    200,
    Number(process.env.VISA_ATTEMPT_INTERVAL_MS) || 300,
  ),
  BURST_INTERVAL_MS: Math.max(
    200,
    Number(process.env.VISA_ATTEMPT_BURST_INTERVAL_MS) || 250,
  ),
  MAX_MONTHS: Math.max(1, Number(process.env.VISA_CALENDAR_MAX_MONTHS) || 6),
  LOGIN_WAIT_TIMEOUT_MS: Math.max(
    60_000,
    Number(process.env.VISA_LOGIN_WAIT_TIMEOUT_MS) || 15 * 60 * 1000,
  ),
  LOGIN_NAV_TIMEOUT_MS: Math.max(
    120_000,
    Number(process.env.VISA_LOGIN_NAV_TIMEOUT_MS) || 3 * 60 * 1000,
  ),
  PROFILE_DIR: process.env.VISA_PROFILE_DIR || "",
  HOT_SCAN_SETTLE_MS: Math.max(
    25,
    Number(process.env.VISA_HOT_SCAN_SETTLE_MS) || 80,
  ),
  HOT_MONTH_CHANGE_WAIT_MS: Math.max(
    300,
    Number(process.env.VISA_HOT_MONTH_CHANGE_WAIT_MS) || 800,
  ),
  HOT_MONTH_READY_WAIT_MS: Math.max(
    300,
    Number(process.env.VISA_HOT_MONTH_READY_WAIT_MS) || 1000,
  ),
  HOT_SLOT_READY_TIMEOUT_MS: Math.max(
    500,
    Number(process.env.VISA_HOT_SLOT_READY_TIMEOUT_MS) || 1200,
  ),
  HOT_SLOT_CLICK_TIMEOUT_MS: Math.max(
    500,
    Number(process.env.VISA_HOT_SLOT_CLICK_TIMEOUT_MS) || 1000,
  ),
  HOT_SLOT_RETRY_LIMIT: Math.max(
    1,
    Number(process.env.VISA_HOT_SLOT_RETRY_LIMIT) || 4,
  ),
  HOT_FINAL_OUTCOME_TIMEOUT_MS: Math.max(
    300,
    Number(process.env.VISA_HOT_FINAL_OUTCOME_TIMEOUT_MS) || 1000,
  ),
  HOT_BURST_OUTCOME_TIMEOUT_MS: Math.max(
    250,
    Number(process.env.VISA_HOT_BURST_OUTCOME_TIMEOUT_MS) || 700,
  ),
  HOT_FINAL_OUTCOME_POLL_MS: Math.max(
    25,
    Number(process.env.VISA_HOT_FINAL_OUTCOME_POLL_MS) || 50,
  ),
  HOT_FINAL_BURST_DELAY_MS: Math.max(
    0,
    Number(process.env.VISA_HOT_FINAL_BURST_DELAY_MS) || 10,
  ),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runtime throttles (per worker process)
let lastPickupRefreshAt = 0;
let consecutiveNoDateAttempts = 0;
let calendarResumeTarget = null;
const PICKUP_REFRESH_COOLDOWN_MS = Math.max(
  3000,
  Number(process.env.VISA_PICKUP_REFRESH_COOLDOWN_MS) || 15000,
);
const PICKUP_REFRESH_AFTER_MISSES = Math.max(
  1,
  Number(process.env.VISA_PICKUP_REFRESH_AFTER_MISSES) || 2,
);

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

function addMonthsToMonthYear(monthYear, months) {
  if (!monthYear) return null;
  const totalMonths = monthYear.year * 12 + monthYear.monthIndex + months;
  return {
    year: Math.floor(totalMonths / 12),
    monthIndex: ((totalMonths % 12) + 12) % 12,
  };
}

function clampMonthYearToAllowedRange(monthYear, allowed) {
  if (!monthYear) return null;

  const minTarget = allowed.min
    ? {
        year: allowed.min.getUTCFullYear(),
        monthIndex: allowed.min.getUTCMonth(),
      }
    : null;
  const maxTarget = allowed.max
    ? {
        year: allowed.max.getUTCFullYear(),
        monthIndex: allowed.max.getUTCMonth(),
      }
    : null;

  if (minTarget && monthKey(monthYear) < monthKey(minTarget)) {
    return minTarget;
  }

  if (maxTarget && monthKey(monthYear) > monthKey(maxTarget)) {
    return maxTarget;
  }

  return monthYear;
}

function getNextTraversalMonthTarget(page) {
  const allowed = getAllowedDateRange();

  if (calendarResumeTarget) {
    return Promise.resolve(
      clampMonthYearToAllowedRange(calendarResumeTarget, allowed),
    );
  }

  return getCalendarMonthYear(page)
    .then((currentMonth) =>
      clampMonthYearToAllowedRange(
        currentMonth ? addMonthsToMonthYear(currentMonth, 1) : null,
        allowed,
      ),
    )
    .catch(() => null);
}

function formatMonthYear(monthYear) {
  if (!monthYear) return "(unknown)";
  return `${monthYear.year}-${String(monthYear.monthIndex + 1).padStart(2, "0")}`;
}

function getMonthShortLabel(monthIndex) {
  return [
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
  ][monthIndex];
}

async function restoreCalendarMonthView(page) {
  const monthViewVisible = await page
    .locator("mat-month-view")
    .first()
    .isVisible()
    .catch(() => false);

  if (!monthViewVisible) {
    await page
      .locator(".mat-calendar-period-button")
      .first()
      .click()
      .catch(() => {});
    await page
      .locator("mat-month-view")
      .first()
      .waitFor({ state: "visible", timeout: 1500 })
      .catch(() => {});
  }
}

async function jumpCalendarDirectlyToMonth(page, target, timeoutMs = 6000) {
  if (!target) return false;

  const current = await getCalendarMonthYear(page).catch(() => null);
  if (
    current &&
    current.year === target.year &&
    current.monthIndex === target.monthIndex
  ) {
    return true;
  }

  const monthLabel = getMonthShortLabel(target.monthIndex);
  const monthLabelPattern = new RegExp(`^\\s*${monthLabel}\\s*$`, "i");
  const yearLabelPattern = new RegExp(`^\\s*${String(target.year)}\\s*$`);

  try {
    await page.locator(".mat-calendar-period-button").first().click({
      timeout: timeoutMs,
    });

    const yearCell = page
      .locator(
        "mat-multi-year-view button.mat-calendar-body-cell, mat-multi-year-view td.mat-calendar-body-cell, mat-multi-year-view .mat-calendar-body-cell-content",
      )
      .filter({ hasText: yearLabelPattern })
      .first();

    await yearCell.waitFor({ state: "visible", timeout: timeoutMs });
    await yearCell.click({ timeout: timeoutMs });

    const monthCell = page
      .locator(
        "mat-year-view button.mat-calendar-body-cell, mat-year-view td.mat-calendar-body-cell, mat-year-view .mat-calendar-body-cell-content",
      )
      .filter({ hasText: monthLabelPattern })
      .first();

    await monthCell.waitFor({ state: "visible", timeout: timeoutMs });
    await monthCell.click({ timeout: timeoutMs });

    await page
      .locator("mat-month-view")
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });

    const targetHeader = `${monthLabel} ${target.year}`;
    await page.waitForFunction(
      ({ expectedHeader }) => {
        const header = document.querySelector(".mat-calendar-period-button");
        const text = String(header?.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();
        return text === expectedHeader;
      },
      { expectedHeader: targetHeader },
      { timeout: timeoutMs },
    );

    return true;
  } catch {
    await restoreCalendarMonthView(page);
    return false;
  }
}

function getAllowedDateRange() {
  // Back-compat with Selenium worker envs:
  // - Prefer VISA_MIN_DATE/VISA_MAX_DATE
  // - Else fall back to VISA_DATE_START/VISA_DATE_END
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

function getAppBaseUrl() {
  const u = new URL(CONFIG.PLATFORM_URL);
  const marker = "/visaapplicantui";
  const idx = u.pathname.indexOf(marker);
  const basePath = idx >= 0 ? u.pathname.slice(0, idx + marker.length) : "";
  return `${u.origin}${basePath}`;
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
  console.log(`[${state}] ${message}`);
  sendWorkerMessage({
    type: "status",
    sessionId: CONFIG.SESSION_ID,
    state,
    message,
  });
}

async function launchBrowser() {
  status(
    "BROWSER",
    `${CONFIG.HEADLESS ? "Headless" : "Headed"} Chrome${CONFIG.PROFILE_DIR ? " with persistent profile" : ""}`,
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

  if (CONFIG.PROFILE_DIR) {
    const context = await chromium.launchPersistentContext(
      CONFIG.PROFILE_DIR,
      launchOptions,
    );
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(CONFIG.LOGIN_NAV_TIMEOUT_MS);
    return {
      browser: null,
      context,
      page,
    };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(CONFIG.LOGIN_NAV_TIMEOUT_MS);
  return { browser, context, page };
}

async function waitForLoginSurface(
  page,
  timeoutMs = CONFIG.LOGIN_WAIT_TIMEOUT_MS,
) {
  if (/dashboard/i.test(page.url())) {
    return "dashboard";
  }

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

  const displayNameWait = page
    .getByText(CONFIG.USER_DISPLAY_NAME, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => "dashboard")
    .catch(() => null);

  return Promise.race([
    usernameWait,
    passwordWait,
    dashboardWait,
    displayNameWait,
  ]);
}

async function waitForLoginOrDashboard(
  page,
  timeoutMs = CONFIG.LOGIN_WAIT_TIMEOUT_MS,
) {
  const dashboardWait = page
    .waitForURL(/dashboard/i, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  const displayNameWait = page
    .getByText(CONFIG.USER_DISPLAY_NAME, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  const ok = await Promise.race([dashboardWait, displayNameWait]);
  if (!ok) {
    throw new Error("Login wait timed out.");
  }

  return true;
}

async function login(page) {
  status(
    "LOGIN",
    `Opening login page with a relaxed timeout (${Math.round(CONFIG.LOGIN_NAV_TIMEOUT_MS / 1000)}s)`,
  );

  try {
    await page.goto(CONFIG.PLATFORM_URL, {
      waitUntil: "commit",
      timeout: CONFIG.LOGIN_NAV_TIMEOUT_MS,
    });
  } catch (error) {
    status(
      "LOGIN",
      `Login page is loading slowly; keeping the worker alive and waiting (${String(error?.message || error)})`,
    );
  }

  const surface = await waitForLoginSurface(page);
  if (surface === "dashboard") {
    status("DASHBOARD", "Dashboard detected");
    return;
  }

  if (surface !== "login") {
    throw new Error("Login page did not become ready.");
  }

  await page
    .locator('input[formcontrolname="username"]')
    .fill(CONFIG.USER_EMAIL, { timeout: 30000 });
  await page
    .locator('input[formcontrolname="password"]')
    .fill(CONFIG.USER_PASSWORD, { timeout: 30000 });

  status("WAITING_CAPTCHA", "Credentials filled; complete CAPTCHA and sign in");
  await waitForLoginOrDashboard(page);
  status("DASHBOARD", "Dashboard detected");
}

async function goToDashboard(page) {
  if (/\/dashboard/i.test(page.url())) {
    return true;
  }

  status("NAV", "Opening dashboard");
  await page.goto(`${getAppBaseUrl()}/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL(/dashboard/i, { timeout: 20000 }).catch(() => {});
  return true;
}

async function clickLabelWithClosestClickableAncestor(
  page,
  labelLocator,
  timeoutMs = 15000,
) {
  const label = labelLocator.first();
  await label.waitFor({ state: "visible", timeout: timeoutMs });

  const handle = await label.evaluateHandle((element) => {
    const clickable = element.closest(
      "button, a, [role='button'], [tabindex], .create-taskbutton",
    );
    return clickable || element;
  });

  const target = handle.asElement();
  if (!target) {
    throw new Error("Clickable dashboard target not found.");
  }

  await target.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await page.waitForTimeout(75);
  await target.click({ timeout: timeoutMs, force: true });
  await handle.dispose().catch(() => {});
}

async function clickPendingAppointmentTile(page) {
  const deadline = Date.now() + 15000;
  const candidateLocators = [
    page.getByRole("button", { name: /pending appointment request/i }).first(),
    page.getByRole("link", { name: /pending appointment request/i }).first(),
    page.getByText(/pending appointment request/i).first(),
    page.getByRole("button", { name: /pending appointment/i }).first(),
    page.getByRole("link", { name: /pending appointment/i }).first(),
    page.getByText(/pending appointment/i).first(),
    page
      .locator(
        "xpath=//*[contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PENDING') and contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'APPOINTMENT') and not(contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CANCEL APPOINTMENT'))]",
      )
      .first(),
  ];

  while (Date.now() < deadline) {
    for (const locator of candidateLocators) {
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      await clickLabelWithClosestClickableAncestor(page, locator);
      return true;
    }

    await page.waitForTimeout(250).catch(() => {});
  }

  throw new Error("Pending Appointment Request button not found on dashboard.");
}

async function clickRescheduleForCurrentUser(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const clickedText = await page
      .evaluate(
        ({ displayName, email }) => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
              .toUpperCase();

          const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };

          const isActionable = (element) =>
            element &&
            element.getAttribute("aria-disabled") !== "true" &&
            !element.disabled;

          const elementText = (element) =>
            normalize(
              element?.textContent ||
                element?.getAttribute?.("aria-label") ||
                element?.getAttribute?.("title") ||
                "",
            );

          const clickElement = (element) => {
            if (!element || !isVisible(element) || !isActionable(element)) {
              return null;
            }

            try {
              element.scrollIntoView({ block: "center", inline: "nearest" });
            } catch {
              // ignore
            }

            try {
              element.click();
              return elementText(element);
            } catch {
              return null;
            }
          };

          const collectRescheduleButtons = (root) =>
            Array.from(
              root.querySelectorAll(
                "a.my-app-button-popup-resch, a, button, [role='button'], [tabindex]",
              ),
            ).filter(
              (element) =>
                isVisible(element) &&
                isActionable(element) &&
                /RESCHEDULE/i.test(elementText(element)),
            );

          const searchNeedles = [displayName, email]
            .map(normalize)
            .filter(Boolean);

          const matchingElements = Array.from(
            document.querySelectorAll("body *"),
          )
            .map((element) => ({
              element,
              text: elementText(element),
              area: (() => {
                const rect = element.getBoundingClientRect();
                return rect.width * rect.height;
              })(),
            }))
            .filter(
              ({ element, text }) =>
                isVisible(element) &&
                text &&
                searchNeedles.some((needle) => text.includes(needle)),
            )
            .sort((left, right) => left.area - right.area);

          const visited = new Set();

          for (const { element } of matchingElements) {
            let current = element;

            for (let depth = 0; depth < 6 && current; depth += 1) {
              if (visited.has(current)) {
                current = current.parentElement;
                continue;
              }

              visited.add(current);

              const buttons = collectRescheduleButtons(current);
              if (buttons.length > 0) {
                return clickElement(buttons[0]);
              }

              current = current.parentElement;
            }
          }

          const fallback = collectRescheduleButtons(document)[0];
          if (fallback) {
            return clickElement(fallback);
          }

          return null;
        },
        {
          displayName: CONFIG.USER_DISPLAY_NAME,
          email: CONFIG.USER_EMAIL,
        },
      )
      .catch(() => null);

    if (clickedText) {
      return true;
    }

    await page.waitForTimeout(250).catch(() => {});
  }

  return false;
}

async function waitForAppointmentBookingPageReady(page, timeoutMs = 60000) {
  const bookingBlock = page.locator(".ofc-book-slot-block").first();
  try {
    await bookingBlock.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await page
    .locator(
      ".ofc-book-slot-block mat-select[panelclass*='drop-down-panelcls'], .ofc-book-slot-block mat-select",
    )
    .first()
    .waitFor({ state: "visible", timeout: 30000 })
    .catch(() => {});

  await page
    .locator(".ngx-spinner-overlay")
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => {});

  return true;
}

async function waitForCalendarUiReady(page, timeoutMs = 45000) {
  const bookingBlock = getBookingBlockLocator(page);
  try {
    await bookingBlock.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  // Wait for any common loading overlays to clear.
  await page
    .locator(".ngx-spinner-overlay")
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => {});

  // Ensure the calendar header and day grid exist before scanning.
  // If these aren't present yet, the date hunt can incorrectly conclude "no dates".
  await page
    .locator(".mat-calendar-period-button")
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => {});

  try {
    await page
      .locator(
        "button.mat-calendar-body-cell, td.mat-calendar-body-cell, .mat-calendar-body-cell-content",
      )
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  // Tiny settle so computed styles are stable (used by the green-date detector).
  await page.waitForTimeout(CONFIG.HOT_SCAN_SETTLE_MS);
  return true;
}

async function waitForCalendarMonthDatesReady(page, timeoutMs = 2000) {
  const bookingBlock = getBookingBlockLocator(page);
  try {
    await bookingBlock.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  try {
    await page
      .locator(
        "button.mat-calendar-body-cell, td.mat-calendar-body-cell, .mat-calendar-body-cell-content",
      )
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await page.waitForTimeout(CONFIG.HOT_SCAN_SETTLE_MS).catch(() => {});
  return true;
}

async function waitForTimeSlotsUiReady(page, timeoutMs = 20000) {
  const bookingBlock = getBookingBlockLocator(page);
  try {
    await bookingBlock.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  // Slots can appear while a spinner overlay still exists (but hidden), and
  // sometimes the time text is not directly on the clickable element.
  // So we poll for *any visible time-like text* in the booking block.
  const timeText = /\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i;
  const start = Date.now();

  const spinner = page.locator(".ngx-spinner-overlay").first();

  while (Date.now() - start < timeoutMs) {
    // Prefer "slots exist" over "spinner gone".
    // eslint-disable-next-line no-await-in-loop
    const anyVisibleTime = await bookingBlock
      .getByText(timeText, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (anyVisibleTime) return true;

    // Some builds render the slot list outside `.ofc-book-slot-block`.
    // Fall back to a global check before timing out.
    // eslint-disable-next-line no-await-in-loop
    const anyVisibleTimeGlobal = await page
      .getByText(timeText, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (anyVisibleTimeGlobal) return true;

    // eslint-disable-next-line no-await-in-loop
    const spinnerVisible = await spinner.isVisible().catch(() => false);
    if (!spinnerVisible) {
      // If spinner is not visible, do one extra quick check for clickable slots.
      // eslint-disable-next-line no-await-in-loop
      const clickableVisible = await bookingBlock
        .locator("button, a, [role='button']")
        .filter({ hasText: timeText })
        .first()
        .isVisible()
        .catch(() => false);
      if (clickableVisible) return true;
    }

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(CONFIG.HOT_SCAN_SETTLE_MS);
  }

  return false;
}

async function waitForProceedActionable(page, timeoutMs = 20000) {
  const bookingBlock = getBookingBlockLocator(page);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await bookingBlock
      .evaluate((root, reschedule) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const buttons = Array.from(
          root.querySelectorAll("button, a, [role='button']"),
        )
          .map((element) => ({
            element,
            text: String(element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .toUpperCase(),
          }))
          .filter(
            ({ element, text }) =>
              isVisible(element) &&
              text &&
              element.getAttribute("aria-disabled") !== "true" &&
              !element.disabled,
          );

        const pick = buttons.find(({ text }) => {
          if (reschedule) {
            return /\bSELECT\b/i.test(text) || /\bPROCEED\b/i.test(text);
          }
          return (
            /SELECT POST/i.test(text) ||
            /PROCEED/i.test(text) ||
            /BOOK/i.test(text)
          );
        });

        return Boolean(pick);
      }, CONFIG.RESCHEDULE)
      .catch(() => false);

    if (ok) return true;

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
  }

  return false;
}

async function openAppointmentMode(page) {
  const targetText = CONFIG.RESCHEDULE ? "RESCHEDULE" : "PENDING APPOINTMENT";
  status("MODE", `Opening ${targetText}`);

  const bookingBlock = page.locator(".ofc-book-slot-block").first();
  if (
    (await bookingBlock.isVisible().catch(() => false)) ||
    /\/home\/appointment\/slot(?:[/?#]|$)/i.test(page.url())
  ) {
    return true;
  }

  await goToDashboard(page);

  if (CONFIG.RESCHEDULE) {
    const myAppointmentsUrl = `${getAppBaseUrl()}/home/appointment/myappointment`;
    status("MY_APPOINTMENTS", `Opening ${myAppointmentsUrl}`);
    await page.goto(myAppointmentsUrl, { waitUntil: "domcontentloaded" });
    await page
      .waitForURL(/\/home\/appointment\/myappointment/i, { timeout: 25000 })
      .catch(() => {});

    const rescheduleBtn = page
      .locator(
        "a.my-app-button-popup-resch, a:has-text('RESCHEDULE'), button:has-text('RESCHEDULE'), [role='button']:has-text('RESCHEDULE')",
      )
      .first();

    let rescheduleVisible = await rescheduleBtn
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    if (!rescheduleVisible) {
      // Sometimes the my-appointments page needs one reload to fully hydrate.
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      rescheduleVisible = await rescheduleBtn
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!rescheduleVisible) {
      throw new Error("Reschedule button not found on My Appointments.");
    }

    // Some flows show a native browser confirm dialog, others show an Angular
    // mat-dialog, and sometimes it navigates directly to the booking UI.
    const onNativeDialog = async (dialog) => {
      try {
        status("RESCHEDULE_CONFIRM", "Accepting browser dialog");
        await dialog.accept();
      } catch {
        // ignore
      }
    };
    page.once("dialog", onNativeDialog);

    let clicked = await clickRescheduleForCurrentUser(page).catch(() => false);
    if (!clicked) {
      // Sometimes the my-appointments page needs one reload to fully hydrate.
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      clicked = await clickRescheduleForCurrentUser(page).catch(() => false);
    }

    if (!clicked) {
      throw new Error("Reschedule button not found on My Appointments.");
    }

    status("RESCHEDULE_CLICK", "Clicked RESCHEDULE");

    const bookingBlockAfterClick = getBookingBlockLocator(page);
    const angularDialog = page
      .locator("mat-dialog-container, [role='dialog']")
      .first();

    const reachedBooking = bookingBlockAfterClick
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => "BOOKING")
      .catch(() => null);

    const reachedDialog = angularDialog
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => "DIALOG")
      .catch(() => null);

    const next = await Promise.race([reachedBooking, reachedDialog]).catch(
      () => null,
    );

    if (next === "DIALOG") {
      const confirmBtn = angularDialog
        .locator(
          "button:has-text('Confirm'), button:has-text('CONFIRM'), button:has-text('Yes'), button:has-text('YES'), button:has-text('Ok'), button:has-text('OK')",
        )
        .first();
      const confirmVisible = await confirmBtn
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => false);

      if (confirmVisible) {
        await confirmBtn.click({ timeout: 15000, force: true });
        status("RESCHEDULE_CONFIRM", "Confirmed reschedule dialog");
      }

      await angularDialog
        .waitFor({ state: "detached", timeout: 30000 })
        .catch(() => {});

      await bookingBlockAfterClick
        .waitFor({ state: "visible", timeout: 60000 })
        .catch(() => {});
    } else if (next === "BOOKING") {
      // No dialog; we reached the booking UI directly.
      status("RESCHEDULE_CONFIRM", "Reschedule opened booking UI");
    } else {
      // If neither appeared, continue; the global booking wait below will decide.
      status(
        "RESCHEDULE_CONFIRM",
        "No dialog/booking detected yet; continuing",
      );
    }
  } else {
    // Match Selenium: exact dashboard label first, then click the nearest
    // actionable ancestor rather than a broad text match.
    await clickPendingAppointmentTile(page);
  }

  status("BOOKING_WAIT", "Waiting for appointment booking UI");
  const ready = await waitForAppointmentBookingPageReady(page, 120000);
  if (!ready) {
    throw new Error("Appointment booking page did not fully load.");
  }

  status("APPOINTMENT_PAGE", "Appointment booking page reached");
}

async function selectPickupPoint(page) {
  status("PICKUP", `Selecting pickup ${CONFIG.PICKUP_POINT}`);
  // Critical: scope to the booking block so we do NOT hit the sidebar Language mat-select.
  const bookingBlock = getBookingBlockLocator(page);
  const select = bookingBlock
    .locator("mat-select[panelclass*='drop-down-panelcls'], mat-select")
    .first();
  await select.click({ timeout: 5000, force: true });
  // mat-option renders in the global overlay; keep it global but ensure we click the right label.
  await page
    .locator("mat-option")
    .filter({ hasText: CONFIG.PICKUP_POINT })
    .first()
    .click({ timeout: 5000, force: true });
}

async function setApplicantCheckboxState(page, desiredChecked) {
  return page.evaluate((desiredState) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const applicantHeading = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p,th,td,label"),
    ).find((element) =>
      normalize(element.textContent).includes("applicant list"),
    );

    const scope =
      applicantHeading?.closest(
        "section,div,table,tbody,tr,.group-data-holder,.right-ofc-slot",
      ) ||
      applicantHeading?.parentElement ||
      document;

    const isChecked = () => {
      if (scope.querySelector("input[type='checkbox']:checked")) return true;
      if (scope.querySelector("[aria-checked='true']")) return true;
      if (
        scope.querySelector(
          ".checked, .is-checked, .mat-checkbox-checked, .mat-mdc-checkbox-checked",
        )
      ) {
        return true;
      }
      return Boolean(
        scope.querySelector("span.checkbox.checked, span.checkbox.is-checked"),
      );
    };

    const clickElement = (element) => {
      if (!element) return false;

      try {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {
        // ignore
      }

      try {
        element.click();
        return true;
      } catch {
        return false;
      }
    };

    const forceInputState = (input, checked) => {
      if (!input || input.tagName !== "INPUT") return false;
      try {
        if (input.checked !== checked) {
          input.click();
        }

        if (input.checked === checked) {
          return true;
        }

        input.checked = checked;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.checked === checked;
      } catch {
        return false;
      }
    };

    const clickAssociatedLabel = (input) => {
      const id = input?.getAttribute?.("id");
      if (!id) return false;

      const label = Array.from(document.querySelectorAll("label")).find(
        (element) => element.getAttribute("for") === id,
      );
      return clickElement(label);
    };

    const candidates = Array.from(
      scope.querySelectorAll(
        "input[type='checkbox'][id^='styled-checkbox-'], .custom-checkbox input[type='checkbox'], .custom-checkbox span.checkbox, span.checkbox, [role='checkbox'], input[type='checkbox']",
      ),
    );

    if (isChecked() === desiredState) {
      return true;
    }

    for (const candidate of candidates) {
      if (candidate.tagName !== "INPUT" && !isVisible(candidate)) {
        continue;
      }

      if (candidate.tagName === "INPUT") {
        if (
          forceInputState(candidate, desiredState) &&
          isChecked() === desiredState
        ) {
          return true;
        }

        if (clickAssociatedLabel(candidate) && isChecked() === desiredState) {
          return true;
        }

        const parentLabel = candidate.closest("label");
        if (clickElement(parentLabel) && isChecked() === desiredState) {
          return true;
        }
      }

      if (clickElement(candidate) && isChecked() === desiredState) {
        return true;
      }

      const clickableAncestor = candidate.closest(
        "label, .custom-checkbox, span.checkbox, [role='checkbox'], td, tr, div, .group-data-holder, .right-ofc-slot",
      );
      if (clickableAncestor && clickableAncestor !== candidate) {
        if (clickElement(clickableAncestor) && isChecked() === desiredState) {
          return true;
        }

        const descendantInput = clickableAncestor.querySelector(
          "input[type='checkbox']",
        );
        if (
          forceInputState(descendantInput, desiredState) &&
          isChecked() === desiredState
        ) {
          return true;
        }
      }
    }

    return isChecked() === desiredState;
  }, Boolean(desiredChecked));
}

async function ensureApplicantChecked(
  page,
  { attempts = 2, delayMs = 200 } = {},
) {
  const trySelect = async () => setApplicantCheckboxState(page, true);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const selected = await trySelect().catch(() => false);
    if (selected) {
      return true;
    }

    if (attempt < attempts - 1 && delayMs > 0) {
      await page.waitForTimeout(delayMs);
    }
  }

  status("APPLICANT", "Applicant checkbox not yet confirmed; continuing");
  return false;
}

async function resetApplicantCheckbox(page) {
  await setApplicantCheckboxState(page, false).catch(() => false);
  await page.waitForTimeout(150).catch(() => {});
  return setApplicantCheckboxState(page, true).catch(() => false);
}

async function pulseApplicantCheckbox(page) {
  await setApplicantCheckboxState(page, false).catch(() => false);
  return setApplicantCheckboxState(page, true).catch(() => false);
}

async function hasSelectApplicantToast(page) {
  const toast = page
    .getByText(/Select\s+(?:a|an)\s+applicant/i, { exact: false })
    .first();
  return toast.isVisible().catch(() => false);
}

function getBookingBlockLocator(page) {
  return page.locator(".ofc-book-slot-block").first();
}

async function clickFirstGreenDate(page) {
  const allowed = getAllowedDateRange();
  const minIso = allowed.min ? allowed.min.toISOString().slice(0, 10) : null;
  const maxIso = allowed.max ? allowed.max.toISOString().slice(0, 10) : null;

  const clicked = await page.evaluate(
    ({ minIsoArg, maxIsoArg }) => {
      const isGreen = (element) => {
        const style = window.getComputedStyle(element);
        return (
          /20,\s*163,\s*139/.test(style.backgroundColor) ||
          /#14a38b/i.test(style.backgroundColor)
        );
      };

      const parseHeaderMonthYear = () => {
        const btn = document.querySelector(".mat-calendar-period-button");
        const headerText = String(btn ? btn.textContent || "" : "")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();
        // Typical: "JAN 2026"
        const m = headerText.match(
          /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\s+(\d{4})/,
        );
        if (!m) return null;
        const months = {
          JAN: 0,
          FEB: 1,
          MAR: 2,
          APR: 3,
          MAY: 4,
          JUN: 5,
          JUL: 6,
          AUG: 7,
          SEP: 8,
          OCT: 9,
          NOV: 10,
          DEC: 11,
        };
        const monthIndex = months[m[1]];
        const year = Number(m[2]);
        if (!Number.isFinite(year) || monthIndex == null) return null;
        return { year, monthIndex };
      };

      const isWithinIsoRange = (iso) => {
        if (!iso) return false;
        if (minIsoArg && iso < minIsoArg) return false;
        if (maxIsoArg && iso > maxIsoArg) return false;
        return true;
      };

      const candidates = Array.from(
        document.querySelectorAll(
          "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
        ),
      );

      const header = parseHeaderMonthYear();
      const baseYear = header ? header.year : null;
      const baseMonthIndex = header ? header.monthIndex : null;

      let outOfRangeFound = false;
      const target = candidates.find((cell) => {
        const inner =
          cell.querySelector(".mat-calendar-body-cell-content") || cell;

        if (!(isGreen(inner) || isGreen(cell))) return false;

        const content = cell.querySelector(".mat-calendar-body-cell-content");
        const dayText = String(
          (content ? content.textContent : cell.textContent) || "",
        )
          .replace(/\s+/g, " ")
          .trim();
        const dayNum = Number(dayText);
        if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) {
          // If we can't parse the day, treat as not selectable in-range.
          outOfRangeFound = true;
          return false;
        }

        if (baseYear == null || baseMonthIndex == null) {
          // Can't compute the full date; to be safe, do not click.
          outOfRangeFound = true;
          return false;
        }

        const iso = new Date(Date.UTC(baseYear, baseMonthIndex, dayNum))
          .toISOString()
          .slice(0, 10);

        if (!isWithinIsoRange(iso)) {
          outOfRangeFound = true;
          return false;
        }

        return true;
      });

      if (!target) {
        return outOfRangeFound ? "__OUT_OF_RANGE__" : null;
      }
      const actual = target.closest("button.mat-calendar-body-cell") || target;
      actual.scrollIntoView({ block: "center", inline: "nearest" });
      actual.click();
      const content = actual.querySelector(".mat-calendar-body-cell-content");
      const dayText = String(
        (content ? content.textContent : actual.textContent) || "",
      )
        .replace(/\s+/g, " ")
        .trim();
      const dayNum = Number(dayText);
      if (!Number.isFinite(dayNum)) {
        return { text: dayText || null, iso: null };
      }

      const iso = new Date(Date.UTC(baseYear, baseMonthIndex, dayNum))
        .toISOString()
        .slice(0, 10);
      return { text: dayText || null, iso };
    },
    {
      minIsoArg: minIso,
      maxIsoArg: maxIso,
    },
  );

  if (clicked === "__OUT_OF_RANGE__") {
    status(
      "DATE",
      `Green date(s) found but out of allowed range (${minIso || "(none)"}..${maxIso || "(none)"})`,
    );
    return "OUT_OF_RANGE";
  }

  if (clicked?.text) {
    if (clicked.iso) {
      status("DATE_SELECTED", clicked.iso);
    }
    status("DATE", `Selected green date ${clicked.text}`);
    return clicked.text;
  }

  return false;
}

async function scanVisibleMonthForGreenDate(page, maxScans = 2) {
  let outOfRangeFound = false;

  for (let scan = 0; scan < maxScans; scan += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clickedText = await clickFirstGreenDate(page);
    if (clickedText && clickedText !== "OUT_OF_RANGE") {
      return { dateSelected: clickedText, outOfRangeFound };
    }

    if (clickedText === "OUT_OF_RANGE") {
      outOfRangeFound = true;
    }

    if (scan < maxScans - 1) {
      // Keep the scan fast, but give the calendar a moment to finish repainting.
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(180).catch(() => {});
    }
  }

  return { dateSelected: null, outOfRangeFound };
}

async function clickNextAvailableDateAfter(page, afterDateText) {
  const afterDay = Number(String(afterDateText || "").match(/\d{1,2}/)?.[0]);
  if (!Number.isFinite(afterDay)) return null;

  const allowed = getAllowedDateRange();
  const minIso = allowed.min ? allowed.min.toISOString().slice(0, 10) : null;
  const maxIso = allowed.max ? allowed.max.toISOString().slice(0, 10) : null;

  const outcome = await page.evaluate(
    ({ afterDayArg, minIsoArg, maxIsoArg }) => {
      const isGreen = (element) => {
        const style = window.getComputedStyle(element);
        return (
          /20,\s*163,\s*139/.test(style.backgroundColor) ||
          /#14a38b/i.test(style.backgroundColor)
        );
      };

      const parseHeaderMonthYear = () => {
        const btn = document.querySelector(".mat-calendar-period-button");
        const headerText = String(btn ? btn.textContent || "" : "")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();
        const m = headerText.match(
          /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\s+(\d{4})/,
        );
        if (!m) return null;
        const months = {
          JAN: 0,
          FEB: 1,
          MAR: 2,
          APR: 3,
          MAY: 4,
          JUN: 5,
          JUL: 6,
          AUG: 7,
          SEP: 8,
          OCT: 9,
          NOV: 10,
          DEC: 11,
        };
        const monthIndex = months[m[1]];
        const year = Number(m[2]);
        if (!Number.isFinite(year) || monthIndex == null) return null;
        return { year, monthIndex };
      };

      const isWithinIsoRange = (iso) => {
        if (!iso) return false;
        if (minIsoArg && iso < minIsoArg) return false;
        if (maxIsoArg && iso > maxIsoArg) return false;
        return true;
      };

      const candidates = Array.from(
        document.querySelectorAll(
          "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
        ),
      );

      const header = parseHeaderMonthYear();
      if (!header) return { mode: "NONE" };

      const later = candidates
        .map((cell) => {
          const inner =
            cell.querySelector(".mat-calendar-body-cell-content") || cell;
          if (!(isGreen(inner) || isGreen(cell))) return null;

          const content = cell.querySelector(".mat-calendar-body-cell-content");
          const dayText = String(
            (content ? content.textContent : cell.textContent) || "",
          )
            .replace(/\s+/g, " ")
            .trim();
          const dayNum = Number(dayText);
          if (
            !Number.isFinite(dayNum) ||
            dayNum <= afterDayArg ||
            dayNum > 31
          ) {
            return null;
          }

          const iso = new Date(Date.UTC(header.year, header.monthIndex, dayNum))
            .toISOString()
            .slice(0, 10);
          if (!isWithinIsoRange(iso)) return null;

          return { cell, dayNum, text: dayText };
        })
        .filter(Boolean)
        .sort((left, right) => left.dayNum - right.dayNum)[0];

      if (later) {
        const actual =
          later.cell.closest("button.mat-calendar-body-cell") || later.cell;
        actual.scrollIntoView({ block: "center", inline: "nearest" });
        actual.click();
        return { mode: "CLICKED", text: later.text, iso: later.iso };
      }

      const nextButton = document.querySelector(
        "button.mat-calendar-next-button:not([disabled])",
      );
      if (nextButton) {
        nextButton.click();
        return { mode: "NEXT_MONTH" };
      }

      return { mode: "NONE" };
    },
    { afterDayArg: afterDay, minIsoArg: minIso, maxIsoArg: maxIso },
  );

  if (!outcome || outcome.mode === "NONE") return null;

  if (outcome.mode === "CLICKED") {
    if (outcome.iso) {
      status("DATE_SELECTED", outcome.iso);
    }
    status("DATE", `Advanced to next date ${outcome.text}`);
    return outcome.text || null;
  }

  if (outcome.mode === "NEXT_MONTH") {
    const beforeHeader = await getCalendarHeaderText(page).catch(() => "");
    await waitForCalendarMonthChange(
      page,
      beforeHeader,
      CONFIG.HOT_MONTH_CHANGE_WAIT_MS,
    ).catch(() => {});
    const clickedText = await clickFirstGreenDate(page);
    if (clickedText && clickedText !== "OUT_OF_RANGE") {
      status("DATE", `Advanced to next month date ${clickedText}`);
      return clickedText;
    }
  }

  return null;
}

async function clickNextCalendarMonth(page) {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector(
      "button.mat-calendar-next-button:not([disabled])",
    );
    if (!button) return false;
    button.click();
    return true;
  });

  return clicked;
}

async function clickPrevCalendarMonth(page) {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector(
      "button.mat-calendar-previous-button:not([disabled])",
    );
    if (!button) return false;
    button.click();
    return true;
  });

  return clicked;
}

async function getCalendarHeaderText(page) {
  const header = page.locator(".mat-calendar-period-button").first();
  const txt = await header.textContent().catch(() => "");
  return String(txt || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForCalendarMonthChange(
  page,
  beforeHeader,
  timeoutMs = 1500,
) {
  const before = String(beforeHeader || "").trim();
  if (!before) {
    await sleep(200);
    return;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const after = await getCalendarHeaderText(page).catch(() => "");
    if (after && after !== before) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }

  // Fallback: even if header didn't change, give the DOM a tiny settle.
  await sleep(100);
}

async function canGoToNextCalendarMonth(page) {
  return page.evaluate(() => {
    const button = document.querySelector("button.mat-calendar-next-button");
    if (!button) return false;
    return !button.disabled && button.getAttribute("aria-disabled") !== "true";
  });
}

async function canGoToPrevCalendarMonth(page) {
  return page.evaluate(() => {
    const button = document.querySelector(
      "button.mat-calendar-previous-button",
    );
    if (!button) return false;
    return !button.disabled && button.getAttribute("aria-disabled") !== "true";
  });
}

async function navigateCalendarToMonth(page, target, maxSteps = 24) {
  if (!target) return true;

  for (let steps = 0; steps < maxSteps; steps += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await getCalendarMonthYear(page).catch(() => null);
    if (!current) break;

    const currentKey = monthKey(current);
    const targetKey = monthKey(target);
    if (currentKey === targetKey) return true;

    const beforeHeader = await getCalendarHeaderText(page).catch(() => "");

    if (currentKey < targetKey) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await canGoToNextCalendarMonth(page))) return false;
      // eslint-disable-next-line no-await-in-loop
      const moved = await clickNextCalendarMonth(page);
      if (!moved) return false;
      // eslint-disable-next-line no-await-in-loop
      await waitForCalendarMonthChange(page, beforeHeader, 1600);
    } else {
      // eslint-disable-next-line no-await-in-loop
      if (!(await canGoToPrevCalendarMonth(page))) return false;
      // eslint-disable-next-line no-await-in-loop
      const moved = await clickPrevCalendarMonth(page);
      if (!moved) return false;
      // eslint-disable-next-line no-await-in-loop
      await waitForCalendarMonthChange(page, beforeHeader, 1600);
    }
  }

  return jumpCalendarDirectlyToMonth(page, target).catch(() => false);
}

async function huntGreenDate(
  page,
  { startTarget: explicitStartTarget = null } = {},
) {
  const allowed = getAllowedDateRange();
  const maxMonthKey = allowed.max
    ? allowed.max.getUTCFullYear() * 12 + allowed.max.getUTCMonth()
    : Infinity;

  // Always start scanning from the earliest allowed month (or current month if
  // no min is set). Without this, repeated scans can drift forward and miss
  // newly-available earlier dates.
  const allowedMinTarget = allowed.min
    ? {
        year: allowed.min.getUTCFullYear(),
        monthIndex: allowed.min.getUTCMonth(),
      }
    : null;
  const startTarget = clampMonthYearToAllowedRange(
    explicitStartTarget || calendarResumeTarget || allowedMinTarget,
    allowed,
  );
  await navigateCalendarToMonth(page, startTarget, 24).catch(() => false);
  await waitForCalendarMonthDatesReady(page, 2000).catch(() => {});

  let dateSelected = null;
  let outOfRangeFound = false;
  let monthAttempts = 0;
  let monthScans = 0;
  const maxScansPerMonth = 2;
  let currentHeader = null;

  while (monthScans < CONFIG.MAX_MONTHS) {
    monthScans += 1;
    currentHeader = await getCalendarMonthYear(page).catch(() => null);
    if (currentHeader && monthKey(currentHeader) > maxMonthKey) {
      break;
    }

    const {
      dateSelected: monthDateSelected,
      outOfRangeFound: monthOutOfRange,
    } = await scanVisibleMonthForGreenDate(page, maxScansPerMonth);
    if (monthOutOfRange) {
      outOfRangeFound = true;
    }
    if (monthDateSelected) {
      dateSelected = monthDateSelected;
      break;
    }

    if (currentHeader && monthKey(currentHeader) >= maxMonthKey) {
      break;
    }

    if (!(await canGoToNextCalendarMonth(page))) {
      break;
    }

    const beforeHeader = await getCalendarHeaderText(page).catch(() => "");
    const moved = await clickNextCalendarMonth(page);
    if (!moved) break;
    monthAttempts += 1;
    await waitForCalendarMonthChange(
      page,
      beforeHeader,
      CONFIG.HOT_MONTH_CHANGE_WAIT_MS,
    );
    await waitForCalendarMonthDatesReady(
      page,
      CONFIG.HOT_MONTH_READY_WAIT_MS,
    ).catch(() => {});
  }

  return {
    dateSelected: dateSelected || (outOfRangeFound ? "OUT_OF_RANGE" : null),
    monthAttempts,
    outOfRangeFound,
    resumeTarget: clampMonthYearToAllowedRange(
      currentHeader ? addMonthsToMonthYear(currentHeader, 1) : startTarget,
      allowed,
    ),
  };
}

async function refreshPickupByToggle(page) {
  status(
    "PICKUP_REFRESH",
    `Refreshing pickup: Select -> ${CONFIG.PICKUP_POINT}`,
  );

  const selectedName = CONFIG.PICKUP_POINT;
  const normalize = (text) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  const escapeRegExp = (value) =>
    String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Critical: scope to booking block; never interact with sidebar Language select.
  // The platform refreshes availability only when we re-open the pickup select,
  // choose the placeholder "Select", then choose Accra again.
  const bookingBlock = page.locator(".ofc-book-slot-block").first();
  const pickupSelect = bookingBlock
    .locator("mat-select[panelclass*='drop-down-panelcls'], mat-select")
    .first();

  // New refresh behavior: select the option immediately BEFORE the current
  // pickup point (e.g. before "Accra"), then select the pickup point again.
  // This forces the platform to refresh availability.
  await pickupSelect.click({ timeout: 5000, force: true });

  const options = page.locator("mat-option");
  await options.first().waitFor({ state: "visible", timeout: 5000 });

  const optionTexts = await options.allTextContents().catch(() => []);
  const normTarget = normalize(selectedName);
  let targetIndex = optionTexts.findIndex((t) => normalize(t) === normTarget);
  if (targetIndex < 0) {
    targetIndex = optionTexts.findIndex((t) =>
      normalize(t).includes(normTarget),
    );
  }

  const selectIndex = optionTexts.findIndex((t) =>
    /^SELECT$/i.test(normalize(t)),
  );

  let priorIndex = targetIndex - 1;
  while (
    priorIndex >= 0 &&
    (!normalize(optionTexts[priorIndex]) ||
      normalize(optionTexts[priorIndex]) === normTarget)
  ) {
    priorIndex -= 1;
  }

  const canToggleToPrior = targetIndex > 0 && priorIndex >= 0;

  if (canToggleToPrior) {
    const priorLabel = optionTexts[priorIndex];
    status(
      "PICKUP_REFRESH",
      `Refreshing pickup: ${priorLabel.trim()} -> ${selectedName}`,
    );
    await options.nth(priorIndex).click({ timeout: 5000, force: true });
    await page.waitForTimeout(200);
  } else if (selectIndex >= 0) {
    status("PICKUP_REFRESH", `Refreshing pickup: Select -> ${selectedName}`);
    await options.nth(selectIndex).click({ timeout: 5000, force: true });
    await page.waitForTimeout(200);
  } else {
    // Could not find either a prior option or the "Select" placeholder.
    // Bail out rather than repeatedly re-selecting the same pickup.
    return false;
  }

  await pickupSelect.click({ timeout: 5000, force: true });

  const reopenedOptions = page.locator("mat-option");
  await reopenedOptions.first().waitFor({ state: "visible", timeout: 5000 });

  // Always select by label text after reopening to avoid stale indices.
  const exactTarget = reopenedOptions
    .filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(selectedName)}\\s*$`, "i"),
    })
    .first();
  if (await exactTarget.count().catch(() => 0)) {
    await exactTarget.click({ timeout: 5000, force: true });
    return true;
  }

  const fuzzyTarget = reopenedOptions.filter({ hasText: selectedName }).first();
  if (!(await fuzzyTarget.count().catch(() => 0))) return false;
  await fuzzyTarget.click({ timeout: 5000, force: true });

  // Stamp refresh time only after we successfully toggled the pickup.
  lastPickupRefreshAt = Date.now();
  return true;
}

async function refreshPickupAndRetryDateHunt(page, reason) {
  status(
    "PICKUP_REFRESH",
    reason === "OUT_OF_RANGE"
      ? "Only out-of-range green dates; refreshing pickup and retrying"
      : "No usable date after traversal; refreshing pickup and retrying",
  );

  // If the calendar is still booting, do not refresh pickup yet.
  await waitForCalendarUiReady(page, 45000).catch(() => false);

  const refreshed = await refreshPickupByToggle(page).catch(() => false);
  if (!refreshed) {
    return { refreshed: false, dateSelected: null, monthAttempts: 0 };
  }

  // After changing pickup, wait for the calendar to refresh before scanning again.
  await waitForCalendarUiReady(page, 45000).catch(() => false);
  await page.waitForTimeout(180).catch(() => {});

  status("PICKUP_REFRESH", "Pickup refreshed; running a second fast date hunt");
  const { dateSelected, monthAttempts, resumeTarget } =
    await huntGreenDate(page);
  calendarResumeTarget = resumeTarget;
  if (monthAttempts > 0) {
    status(
      "CALENDAR",
      `Traversed ${monthAttempts + 1} month(s) after pickup refresh`,
    );
  }

  return { refreshed: true, dateSelected, monthAttempts };
}

async function clickEarliestTimeSlot(page, timeoutMs = 4000) {
  // Do a short wait for slots to populate so we don't prematurely return "No time slot".
  await waitForTimeSlotsUiReady(page, timeoutMs).catch(() => false);

  const bookingBlock = getBookingBlockLocator(page);
  let result = await bookingBlock.evaluate((root) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const timeRe = /\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i;

    const parseToMinutes = (text) => {
      const m = String(text || "").match(timeRe);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const ampm = (m[3] || "").toUpperCase();
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

      if (ampm === "AM" || ampm === "PM") {
        let h = hh % 12;
        if (ampm === "PM") h += 12;
        return h * 60 + mm;
      }

      // If AM/PM isn't present, treat as 24h.
      return hh * 60 + mm;
    };

    const all = Array.from(root.querySelectorAll("*"));

    const candidates = all
      .map((node) => {
        const text = String(node.innerText || node.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return null;
        if (!timeRe.test(text)) return null;
        if (!isVisible(node)) return null;

        const clickable = node.closest("button, a, [role='button']") || node;
        const clickableText = String(
          clickable.innerText || clickable.textContent || text,
        )
          .replace(/\s+/g, " ")
          .trim();

        const minutes = parseToMinutes(clickableText) ?? parseToMinutes(text);
        if (minutes == null) return null;

        const disabled =
          clickable.getAttribute("aria-disabled") === "true" ||
          clickable.disabled === true;
        if (disabled) return null;
        if (!isVisible(clickable)) return null;

        return { clickable, label: clickableText || text, minutes };
      })
      .filter(Boolean);

    if (!candidates.length) return null;

    // Pick the earliest time (minutes since midnight).
    candidates.sort((a, b) => a.minutes - b.minutes);
    const pick = candidates[0];
    pick.clickable.scrollIntoView({ block: "center", inline: "nearest" });
    pick.clickable.click();
    return pick.label;
  });

  if (!result) {
    // Fallback: click a time slot even if the slot list is outside the booking block.
    result = await page
      .evaluate(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const timeRe = /\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i;
        const parseToMinutes = (text) => {
          const m = String(text || "").match(timeRe);
          if (!m) return null;
          const hh = Number(m[1]);
          const mm = Number(m[2]);
          const ampm = (m[3] || "").toUpperCase();
          if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
          if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

          if (ampm === "AM" || ampm === "PM") {
            let h = hh % 12;
            if (ampm === "PM") h += 12;
            return h * 60 + mm;
          }

          return hh * 60 + mm;
        };

        const clickables = Array.from(
          document.querySelectorAll("button, a, [role='button']"),
        )
          .map((element) => {
            const text = String(element.innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            const minutes = parseToMinutes(text);
            if (!text || minutes == null) return null;
            if (!isVisible(element)) return null;
            if (
              element.getAttribute("aria-disabled") === "true" ||
              element.disabled === true
            )
              return null;
            return { element, text, minutes };
          })
          .filter(Boolean);

        if (!clickables.length) return null;
        clickables.sort((a, b) => a.minutes - b.minutes);
        const pick = clickables[0];
        pick.element.scrollIntoView({ block: "center", inline: "nearest" });
        pick.element.click();
        return pick.text;
      })
      .catch(() => null);
  }

  if (result) {
    status("SLOT_SELECTED", `Time slot selected: ${result}`);
    status("SLOT", `Selected earliest time slot ${result}`);
    return true;
  }

  return false;
}

async function clickBookPostAppointmentButton(page) {
  const result = await clickExactActionButton(page, "BOOK POST APPOINTMENT", {
    timeoutMs: 15000,
  });

  if (!result) return false;

  status("BOOK", `Clicked ${result}`);
  return true;
}

async function clickProceedButton(page) {
  const targetText = "SELECT POST AND PROCEED";
  const start = Date.now();
  const timeoutMs = 20000;
  const beforeUrl = page.url();
  const proceedSelectors = [
    ".ofc-book-slot-block button:has-text('SELECT POST AND PROCEED'), .ofc-book-slot-block a:has-text('SELECT POST AND PROCEED'), .ofc-book-slot-block [role='button']:has-text('SELECT POST AND PROCEED')",
    "button:has-text('SELECT POST AND PROCEED'), a:has-text('SELECT POST AND PROCEED'), [role='button']:has-text('SELECT POST AND PROCEED')",
  ];

  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);

    await waitForProceedActionable(page, Math.min(2500, remainingMs)).catch(
      () => false,
    );

    let clicked = false;
    for (const selector of proceedSelectors) {
      // eslint-disable-next-line no-await-in-loop
      const button = page.locator(selector).first();
      // eslint-disable-next-line no-await-in-loop
      clicked = await button
        .click({ timeout: Math.min(2500, remainingMs), force: true })
        .then(() => true)
        .catch(() => false);
      if (clicked) break;
    }

    if (clicked) {
      const outcome = await waitForFinalActionOutcome(
        page,
        beforeUrl,
        Math.min(6000, Math.max(1000, remainingMs)),
        CONFIG.HOT_FINAL_OUTCOME_POLL_MS,
      ).catch(() => null);

      if (outcome === "redirect") {
        status("PROCEED", `Clicked ${targetText}`);
        return true;
      }
    }

    const fallbackClicked = await clickExactActionButton(page, targetText, {
      timeoutMs: Math.min(3000, remainingMs),
    }).catch(() => null);

    if (fallbackClicked) {
      status("PROCEED", `Clicked ${fallbackClicked}`);
      return true;
    }

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(50).catch(() => {});
  }

  return false;
}

async function clickExactActionButton(
  page,
  expectedText,
  { timeoutMs = 15000 } = {},
) {
  const targetText = String(expectedText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!targetText) return null;

  const start = Date.now();
  const beforeUrl = page.url();
  const isPendingProceedAction =
    !CONFIG.RESCHEDULE && targetText === "SELECT POST AND PROCEED";
  const effectiveTimeoutMs = isPendingProceedAction
    ? Math.max(timeoutMs, 45000)
    : timeoutMs;
  const outcomeTimeoutMs = isPendingProceedAction
    ? CONFIG.HOT_FINAL_OUTCOME_TIMEOUT_MS
    : 4000;
  const burstOutcomeTimeoutMs = isPendingProceedAction
    ? CONFIG.HOT_BURST_OUTCOME_TIMEOUT_MS
    : 1200;

  const clickTargetOnce = async () =>
    page
      .evaluate((target) => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();

        const isVisible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const roots = [];
        const bookingBlock = document.querySelector(".ofc-book-slot-block");
        if (bookingBlock) {
          roots.push(bookingBlock);
        }
        roots.push(document);

        const clickCandidate = (element) => {
          if (!element) return null;
          if (!isVisible(element)) return null;
          if (
            element.getAttribute("aria-disabled") === "true" ||
            element.disabled
          ) {
            return null;
          }

          const text = normalize(element.textContent || "");
          if (text !== target) return null;

          try {
            element.scrollIntoView({ block: "center", inline: "nearest" });
          } catch {
            // ignore
          }

          try {
            element.click();
            return text;
          } catch {
            return null;
          }
        };

        for (const root of roots) {
          const candidates = Array.from(
            root.querySelectorAll("button, a, [role='button']"),
          );

          for (const candidate of candidates) {
            const clicked = clickCandidate(candidate);
            if (clicked) return clicked;
          }
        }

        return null;
      }, targetText)
      .catch(() => null);

  const burstPendingProceedAction = async (remainingTimeoutMs) => {
    const burstStart = Date.now();
    const burstTimeoutMs = Math.max(1000, remainingTimeoutMs);

    while (Date.now() - burstStart < burstTimeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await pulseApplicantCheckbox(page).catch(() => false);

      // eslint-disable-next-line no-await-in-loop
      const clickedText = await clickTargetOnce();
      if (clickedText) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await waitForFinalActionOutcome(
          page,
          beforeUrl,
          Math.min(
            burstOutcomeTimeoutMs,
            Math.max(250, burstTimeoutMs - (Date.now() - burstStart)),
          ),
          CONFIG.HOT_FINAL_OUTCOME_POLL_MS,
        ).catch(() => null);

        if (outcome === "redirect") {
          return clickedText;
        }
      }

      // Keep the loop aggressive; do not wait for the toast to clear.
      // eslint-disable-next-line no-await-in-loop
      await page
        .waitForTimeout(CONFIG.HOT_FINAL_BURST_DELAY_MS)
        .catch(() => {});
    }

    return null;
  };

  while (Date.now() - start < effectiveTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const clickedText = await clickTargetOnce();

    if (clickedText) {
      const outcome = await waitForFinalActionOutcome(
        page,
        beforeUrl,
        Math.min(
          outcomeTimeoutMs,
          Math.max(1000, effectiveTimeoutMs - (Date.now() - start)),
        ),
        CONFIG.HOT_FINAL_OUTCOME_POLL_MS,
      ).catch(() => null);

      if (outcome === "redirect") {
        return clickedText;
      }

      if (outcome === "toast" && isPendingProceedAction) {
        status(
          "APPLICANT",
          "Applicant toast detected; bursting applicant checkbox rechecks and final button retries",
        );
        const burstResult = await burstPendingProceedAction(
          Math.max(1000, effectiveTimeoutMs - (Date.now() - start)),
        );
        if (burstResult) {
          return burstResult;
        }
        continue;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(CONFIG.HOT_FINAL_OUTCOME_POLL_MS);
  }

  return null;
}

async function waitForFinalActionOutcome(
  page,
  beforeUrl,
  timeoutMs = 10000,
  pollIntervalMs = 100,
) {
  const previousUrl = String(beforeUrl || "");
  if (!previousUrl) return false;

  const slotPagePattern = /\/home\/appointment\/slot(?:[/?#]|$)/i;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    if (
      currentUrl &&
      currentUrl !== previousUrl &&
      !slotPagePattern.test(currentUrl)
    ) {
      return "redirect";
    }

    if (await hasSelectApplicantToast(page).catch(() => false)) {
      return "toast";
    }

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(pollIntervalMs);
  }

  return null;
}

async function attemptBooking(page) {
  await openAppointmentMode(page);

  const calendarReady = await waitForCalendarUiReady(page, 60000).catch(
    () => false,
  );
  if (!calendarReady) {
    status("CALENDAR", "Calendar not ready yet; skipping scan this loop");
    return "idle";
  }

  await page.waitForTimeout(120).catch(() => {});

  if (!CONFIG.RESCHEDULE) {
    await selectPickupPoint(page);
  }

  let { dateSelected, monthAttempts, resumeTarget } = await huntGreenDate(page);
  calendarResumeTarget = resumeTarget;

  if (monthAttempts > 0) {
    status(
      "CALENDAR",
      `Traversed ${monthAttempts + 1} month(s) in this attempt`,
    );
  }

  // If we find only out-of-range greens, or no usable green at all, we MAY refresh pickup and re-scan. This is throttled to avoid hammering the UI.
  if (dateSelected === "OUT_OF_RANGE" || !dateSelected) {
    consecutiveNoDateAttempts += 1;

    const now = Date.now();
    const sinceRefreshMs = now - lastPickupRefreshAt;
    const cooldownOk = sinceRefreshMs >= PICKUP_REFRESH_COOLDOWN_MS;

    const reason = dateSelected === "OUT_OF_RANGE" ? "OUT_OF_RANGE" : "NO_DATE";
    const missesOk =
      reason === "OUT_OF_RANGE" ||
      consecutiveNoDateAttempts >= PICKUP_REFRESH_AFTER_MISSES;

    if (cooldownOk && missesOk) {
      ({ dateSelected, monthAttempts } = await refreshPickupAndRetryDateHunt(
        page,
        reason,
      ));
      consecutiveNoDateAttempts = 0;
    } else {
      status(
        "PICKUP_REFRESH",
        `Skipping pickup refresh (misses=${consecutiveNoDateAttempts}/${PICKUP_REFRESH_AFTER_MISSES}, cooldown=${Math.max(0, PICKUP_REFRESH_COOLDOWN_MS - sinceRefreshMs)}ms)`,
      );
    }
  } else {
    consecutiveNoDateAttempts = 0;
  }

  if (!dateSelected) {
    status("DATE", "No green date found in scanned months");
    return "idle";
  }

  // We have a date; reset miss counter.
  consecutiveNoDateAttempts = 0;

  let activeDate = dateSelected;
  let slotSelected = false;
  const slotRetryLimit = CONFIG.HOT_SLOT_RETRY_LIMIT;

  for (let retry = 0; retry < slotRetryLimit; retry += 1) {
    status("SLOT", `Waiting for time slots to load for date ${activeDate}`);
    const slotsReady = await waitForTimeSlotsUiReady(
      page,
      CONFIG.HOT_SLOT_READY_TIMEOUT_MS,
    ).catch(() => false);
    if (!slotsReady) {
      status(
        "SLOT",
        `No slot appeared for date ${activeDate}; moving to next date`,
      );
    } else {
      // Keep the time selection fast: choose the earliest visible slot only.
      slotSelected = await clickEarliestTimeSlot(
        page,
        CONFIG.HOT_SLOT_CLICK_TIMEOUT_MS,
      );
      if (slotSelected) {
        break;
      }

      status(
        "SLOT",
        `No time slot found for date ${activeDate}; moving to next date`,
      );
    }

    const nextMonthTarget = await getNextTraversalMonthTarget(page);

    if (!nextMonthTarget) {
      status("DATE", "No later month available to continue hunting");
      return "idle";
    }

    calendarResumeTarget = nextMonthTarget;
    status(
      "DATE",
      `No slot for ${activeDate}; advancing to next month ${formatMonthYear(nextMonthTarget)}`,
    );

    const nextMonthScan = await huntGreenDate(page, {
      startTarget: nextMonthTarget,
    }).catch(() => ({
      dateSelected: null,
      monthAttempts: 0,
      resumeTarget: nextMonthTarget,
    }));

    calendarResumeTarget = nextMonthScan.resumeTarget;

    if (!nextMonthScan.dateSelected) {
      status("DATE", "No usable date found in later months");
      return "idle";
    }

    activeDate = nextMonthScan.dateSelected;
  }

  if (!slotSelected) {
    status("SLOT", "No time slot found after advancing dates");
    calendarResumeTarget = calendarResumeTarget || null;
    return "date";
  }

  status("APPLICANT", "Rechecking applicant checkbox before final action");
  await ensureApplicantChecked(
    page,
    CONFIG.RESCHEDULE
      ? { attempts: 2, delayMs: 200 }
      : { attempts: 1, delayMs: 0 },
  ).catch(() => false);

  // Reschedule flow: immediately click BOOK POST APPOINTMENT.
  if (CONFIG.RESCHEDULE) {
    status("BOOK", "Clicking BOOK POST APPOINTMENT");
    const booked = await clickBookPostAppointmentButton(page).catch(
      () => false,
    );
    if (!booked) {
      status("BOOK", "BOOK POST APPOINTMENT button not found/ready");
      return "slot";
    }
    calendarResumeTarget = null;
    return "done";
  }

  status("PROCEED", "Clicking SELECT POST AND PROCEED");
  const proceeded = await clickProceedButton(page);
  if (!proceeded) {
    status("PROCEED", "SELECT POST AND PROCEED button not found/ready");
    return "slot";
  }

  calendarResumeTarget = null;
  return "done";
}

async function main() {
  status("START", "Launching fast Playwright worker");
  const { browser, context, page } = await launchBrowser();
  let completionReported = false;

  try {
    await login(page);

    while (true) {
      const result = await attemptBooking(page).catch((error) => {
        status("ERROR", error?.message || String(error));
        return "idle";
      });

      if (result === "done") {
        status("SUCCESS", "Final action completed; exiting worker");
        if (!completionReported) {
          completionReported = true;
          status("COMPLETED", "Booking flow completed successfully");
        }
        break;
      }

      await sleep(
        result === "idle" ? CONFIG.INTERVAL_MS : CONFIG.BURST_INTERVAL_MS,
      );
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
