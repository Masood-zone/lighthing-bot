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

async function ensureCalendarAtOrAfterAllowedMinMonth(page) {
  const allowed = getAllowedDateRange();
  if (!allowed.min) return true;

  const target = {
    year: allowed.min.getUTCFullYear(),
    monthIndex: allowed.min.getUTCMonth(),
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await getCalendarMonthYear(page).catch(() => null);
    if (!current) return false;
    if (monthKey(current) >= monthKey(target)) return true;

    const beforeHeader = await getCalendarHeaderText(page).catch(() => "");
    const moved = await clickNextCalendarMonth(page).catch(() => false);
    if (!moved) return false;
    await waitForCalendarMonthChange(page, beforeHeader, 1200).catch(() => {});
  }

  return true;
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
  PROFILE_DIR: process.env.VISA_PROFILE_DIR || "",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return {
      browser: null,
      context,
      page: context.pages()[0] || (await context.newPage()),
    };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  return { browser, context, page };
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
  status("LOGIN", "Waiting for login form");
  await page.goto(CONFIG.PLATFORM_URL, { waitUntil: "domcontentloaded" });

  await page
    .locator('input[formcontrolname="username"]')
    .fill(CONFIG.USER_EMAIL, { timeout: 15000 });
  await page
    .locator('input[formcontrolname="password"]')
    .fill(CONFIG.USER_PASSWORD, { timeout: 15000 });

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
  await page.waitForTimeout(250);
  await target.click({ timeout: timeoutMs, force: true });
  await handle.dispose().catch(() => {});
}

async function clickPendingAppointmentTile(page) {
  const exactLabels = ["PENDING APPOINTMENT REQUEST", "PENDING APPOINTMENT"];

  for (const label of exactLabels) {
    const exactLocator = page.locator(
      `xpath=//*[normalize-space(.)=${JSON.stringify(label)}]`,
    );

    if ((await exactLocator.count().catch(() => 0)) > 0) {
      await clickLabelWithClosestClickableAncestor(page, exactLocator);
      return true;
    }
  }

  const fallback = page.locator(
    "xpath=//*[contains(normalize-space(.), 'PENDING APPOINTMENT') and not(contains(normalize-space(.), 'CANCEL APPOINTMENT'))]",
  );
  if ((await fallback.count().catch(() => 0)) > 0) {
    await clickLabelWithClosestClickableAncestor(page, fallback);
    return true;
  }

  throw new Error("Pending Appointment Request button not found on dashboard.");
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
    .waitFor({ state: "detached", timeout: timeoutMs })
    .catch(() => {});

  return true;
}

async function openAppointmentMode(page) {
  const targetText = CONFIG.RESCHEDULE ? "RESCHEDULE" : "PENDING APPOINTMENT";
  status("MODE", `Opening ${targetText}`);

  const bookingBlock = page.locator(".ofc-book-slot-block").first();
  if (await bookingBlock.count().catch(() => 0)) {
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
        "a.my-app-button-popup-resch, a:has-text('RESCHEDULE'), button:has-text('RESCHEDULE')",
      )
      .first();
    await rescheduleBtn.waitFor({ state: "visible", timeout: 15000 });
    await rescheduleBtn.click({ timeout: 15000, force: true });
    status("RESCHEDULE_CLICK", "Clicked RESCHEDULE");

    const dialog = page
      .locator("mat-dialog-container, [role='dialog']")
      .first();
    await dialog.waitFor({ state: "visible", timeout: 15000 });

    const confirmBtn = dialog
      .locator("button:has-text('Confirm'), button:has-text('CONFIRM')")
      .first();
    await confirmBtn.waitFor({ state: "visible", timeout: 15000 });
    await confirmBtn.click({ timeout: 15000, force: true });
    status("RESCHEDULE_CONFIRM", "Clicked Confirm");

    await dialog.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
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

async function ensureApplicantChecked(page) {
  const checkbox = page.locator("input[type='checkbox']").first();
  if (await checkbox.count().catch(() => 0)) {
    const checked = await checkbox.isChecked().catch(() => true);
    if (!checked) {
      status("APPLICANT", "Checking applicant checkbox");
      await checkbox.check({ timeout: 3000, force: true }).catch(async () => {
        await checkbox.click({ timeout: 3000, force: true });
      });
    }
  }
}

function getBookingBlockLocator(page) {
  return page.locator(".ofc-book-slot-block").first();
}

async function clickFirstGreenDate(page) {
  const allowed = getAllowedDateRange();
  const minIso = allowed.min ? allowed.min.toISOString().slice(0, 10) : null;
  const maxIso = allowed.max ? allowed.max.toISOString().slice(0, 10) : null;

  const clickedText = await page.evaluate(
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
      return (actual.textContent || "").trim();
    },
    {
      minIsoArg: minIso,
      maxIsoArg: maxIso,
    },
  );

  if (clickedText === "__OUT_OF_RANGE__") {
    status(
      "DATE",
      `Green date(s) found but out of allowed range (${minIso || "(none)"}..${maxIso || "(none)"})`,
    );
    return "OUT_OF_RANGE";
  }

  if (clickedText) {
    status("DATE", `Selected green date ${clickedText}`);
    return true;
  }

  return false;
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
    await sleep(80);
  }

  // Fallback: even if header didn't change, give the DOM a tiny settle.
  await sleep(200);
}

async function canGoToNextCalendarMonth(page) {
  return page.evaluate(() => {
    const button = document.querySelector("button.mat-calendar-next-button");
    if (!button) return false;
    return !button.disabled && button.getAttribute("aria-disabled") !== "true";
  });
}

async function huntGreenDate(page) {
  const allowed = getAllowedDateRange();
  const maxMonthKey = allowed.max
    ? allowed.max.getUTCFullYear() * 12 + allowed.max.getUTCMonth()
    : Infinity;

  await ensureCalendarAtOrAfterAllowedMinMonth(page).catch(() => {});

  let dateSelected = await clickFirstGreenDate(page);
  let monthAttempts = 0;

  while (
    !dateSelected &&
    monthAttempts < CONFIG.MAX_MONTHS - 1 &&
    (await canGoToNextCalendarMonth(page))
  ) {
    const currentHeader = await getCalendarMonthYear(page).catch(() => null);
    if (currentHeader && monthKey(currentHeader) >= maxMonthKey) {
      break;
    }

    const beforeHeader = await getCalendarHeaderText(page).catch(() => "");
    const moved = await clickNextCalendarMonth(page);
    if (!moved) break;
    monthAttempts += 1;
    await waitForCalendarMonthChange(page, beforeHeader, 1600);
    dateSelected = await clickFirstGreenDate(page);
  }

  return { dateSelected, monthAttempts };
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
  return true;
}

async function refreshPickupAndRetryDateHunt(page, reason) {
  status(
    "PICKUP_REFRESH",
    reason === "OUT_OF_RANGE"
      ? "Only out-of-range green dates; refreshing pickup and retrying"
      : "No usable date after traversal; refreshing pickup and retrying",
  );

  const refreshed = await refreshPickupByToggle(page).catch(() => false);
  if (!refreshed) {
    return { refreshed: false, dateSelected: null, monthAttempts: 0 };
  }

  status("PICKUP_REFRESH", "Pickup refreshed; running a second fast date hunt");
  const { dateSelected, monthAttempts } = await huntGreenDate(page);
  if (monthAttempts > 0) {
    status(
      "CALENDAR",
      `Traversed ${monthAttempts + 1} month(s) after pickup refresh`,
    );
  }

  return { refreshed: true, dateSelected, monthAttempts };
}

async function clickEarliestTimeSlot(page) {
  const bookingBlock = getBookingBlockLocator(page);
  const result = await bookingBlock.evaluate((root) => {
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

    const slots = Array.from(
      root.querySelectorAll("button, a, [role='button']"),
    );

    const pick = slots.find((element) => {
      const text = String(element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      return (
        text &&
        /\b\d{1,2}:\d{2}\b/.test(text) &&
        isVisible(element) &&
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true"
      );
    });

    if (!pick) return null;

    pick.scrollIntoView({ block: "center", inline: "nearest" });
    pick.click();
    return String(pick.innerText || pick.textContent || "").trim();
  });

  if (result) {
    status("SLOT", `Selected earliest time slot ${result}`);
    return true;
  }

  return false;
}

async function clickProceedButton(page) {
  const bookingBlock = getBookingBlockLocator(page);
  const result = await bookingBlock.evaluate((root, reschedule) => {
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
        /SELECT POST/i.test(text) || /PROCEED/i.test(text) || /BOOK/i.test(text)
      );
    });

    if (!pick) return null;

    pick.element.scrollIntoView({ block: "center", inline: "nearest" });
    pick.element.click();
    return pick.text;
  }, CONFIG.RESCHEDULE);

  if (result) {
    status("PROCEED", `Clicked ${result}`);
    return true;
  }

  return false;
}

async function attemptBooking(page) {
  await openAppointmentMode(page);

  if (!CONFIG.RESCHEDULE) {
    await ensureApplicantChecked(page);
    await selectPickupPoint(page);
    await ensureApplicantChecked(page);
  }

  let { dateSelected, monthAttempts } = await huntGreenDate(page);

  if (monthAttempts > 0) {
    status(
      "CALENDAR",
      `Traversed ${monthAttempts + 1} month(s) in this attempt`,
    );
  }

  // If we find only out-of-range greens, or no usable green at all, refresh
  // pickup and re-scan in both Pending and Reschedule modes.
  if (dateSelected === "OUT_OF_RANGE" || !dateSelected) {
    ({ dateSelected, monthAttempts } = await refreshPickupAndRetryDateHunt(
      page,
      dateSelected === "OUT_OF_RANGE" ? "OUT_OF_RANGE" : "NO_DATE",
    ));
  }

  if (!dateSelected) {
    status("DATE", "No green date found in scanned months");
    return "idle";
  }

  // Keep the time selection fast: choose the earliest visible slot only.
  const slotSelected = await clickEarliestTimeSlot(page);
  if (!slotSelected) {
    status("SLOT", "No time slot found");
    return "date";
  }

  const proceeded = await clickProceedButton(page);
  if (!proceeded) {
    status("PROCEED", "No actionable proceed/select button found");
    return "slot";
  }

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
        status("SUCCESS", "Fast attempt completed; continuing monitor loop");
        if (!completionReported) {
          completionReported = true;
          status("COMPLETED", "Booking flow completed successfully");
        }
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
