const { chromium } = require("playwright");

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
  MAX_MONTHS: Math.max(1, Number(process.env.VISA_CALENDAR_MAX_MONTHS) || 6),
  PROFILE_DIR: process.env.VISA_PROFILE_DIR || "",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status(state, message) {
  console.log(`[${state}] ${message}`);
}

async function launchBrowser() {
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

async function waitForLoginOrDashboard(page, timeoutMs = 5 * 60 * 1000) {
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

async function openAppointmentMode(page) {
  const targetText = CONFIG.RESCHEDULE ? "RESCHEDULE" : "PENDING APPOINTMENT";
  status("MODE", `Opening ${targetText}`);

  const clickable = page.getByText(targetText, { exact: false }).first();
  await clickable.click({ timeout: 8000, force: true }).catch(async () => {
    const fallback = page
      .locator(`button, a, div, span`)
      .filter({ hasText: targetText })
      .first();
    await fallback.click({ timeout: 8000, force: true });
  });
}

async function selectPickupPoint(page) {
  status("PICKUP", `Selecting pickup ${CONFIG.PICKUP_POINT}`);
  const select = page.locator("mat-select").first();
  await select.click({ timeout: 5000, force: true });
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

async function clickFirstGreenDate(page) {
  const clickedText = await page.evaluate(() => {
    const isGreen = (element) => {
      const style = window.getComputedStyle(element);
      return (
        /20,\s*163,\s*139/.test(style.backgroundColor) ||
        /#14a38b/i.test(style.backgroundColor)
      );
    };

    const candidates = Array.from(
      document.querySelectorAll(
        "button.mat-calendar-body-cell:not(.mat-calendar-body-disabled), td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)",
      ),
    );

    const target = candidates.find((cell) => {
      const inner =
        cell.querySelector(".mat-calendar-body-cell-content") || cell;
      return isGreen(inner) || isGreen(cell);
    });

    if (!target) return null;
    const actual = target.closest("button.mat-calendar-body-cell") || target;
    actual.scrollIntoView({ block: "center", inline: "nearest" });
    actual.click();
    return (actual.textContent || "").trim();
  });

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

async function canGoToNextCalendarMonth(page) {
  return page.evaluate(() => {
    const button = document.querySelector("button.mat-calendar-next-button");
    if (!button) return false;
    return !button.disabled && button.getAttribute("aria-disabled") !== "true";
  });
}

async function clickEarliestTimeSlot(page) {
  const result = await page.evaluate(() => {
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
      document.querySelectorAll("button, a, [role='button']"),
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
  const result = await page.evaluate((reschedule) => {
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
      document.querySelectorAll("button, a, [role='button']"),
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
    await selectPickupPoint(page);
    await ensureApplicantChecked(page);
  }

  let dateSelected = await clickFirstGreenDate(page);
  let monthAttempts = 0;

  while (
    !dateSelected &&
    monthAttempts < CONFIG.MAX_MONTHS - 1 &&
    (await canGoToNextCalendarMonth(page))
  ) {
    const moved = await clickNextCalendarMonth(page);
    if (!moved) break;
    monthAttempts += 1;
    dateSelected = await clickFirstGreenDate(page);
  }

  if (monthAttempts > 0) {
    status(
      "CALENDAR",
      `Traversed ${monthAttempts + 1} month(s) in this attempt`,
    );
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

  try {
    await login(page);

    while (true) {
      const result = await attemptBooking(page).catch((error) => {
        status("ERROR", error?.message || String(error));
        return "idle";
      });

      if (result === "done") {
        status("SUCCESS", "Fast attempt completed; continuing monitor loop");
      }

      await sleep(result === "idle" ? CONFIG.INTERVAL_MS : 75);
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
