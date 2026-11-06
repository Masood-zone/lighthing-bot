const { createBootstrapBudget, bootstrapError } = require("./bootstrapBudget");
const {
  VisaApiUnauthorizedError,
  VisaApiForbiddenError,
  VisaApiRateLimitedError,
  VisaPlatformUnavailableError,
} = require("./errors");
const {
  chooseAppointment,
  missingAppointmentFields,
} = require("./applicantResolver");

const APPOINTMENT_SEARCH_PATTERN =
  /\/visaappointmentapi\/appointments\/search/i;

function shouldRunContextBootstrap(cache, nowMs, cooldownMs) {
  const lastAttempt = Number(cache?.browserAttemptedAt) || 0;
  return lastAttempt === 0 || nowMs - lastAttempt >= cooldownMs;
}

function noopStatus() {}

async function clickPendingAppointment(page, budget) {
  const candidates = [
    page.getByRole("button", { name: /pending appointment request/i }).first(),
    page.getByRole("link", { name: /pending appointment request/i }).first(),
    page.getByText(/pending appointment request/i).first(),
    page.getByRole("button", { name: /pending appointment/i }).first(),
    page.getByRole("link", { name: /pending appointment/i }).first(),
    page.getByText(/pending appointment/i).first(),
  ];

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await candidate.isVisible().catch(() => false))) continue;
    // eslint-disable-next-line no-await-in-loop
    const clicked = await budget.run(() =>
      candidate
        .click({ timeout: budget.remaining() })
        .then(() => true)
        .catch(() => false),
    );
    if (!clicked) continue;
    return true;
  }
  return false;
}

async function clickRescheduleForCurrentUser({
  page,
  userDisplayName,
  userEmail,
  timeoutMs = 30_000,
  budget = createBootstrapBudget(timeoutMs),
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    budget.remaining();
    const clickedText = await budget.run(() =>
      page
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

            if (searchNeedles.length > 0) {
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
            }

            const fallback = collectRescheduleButtons(document)[0];
            if (fallback) {
              return clickElement(fallback);
            }

            return null;
          },
          {
            displayName: userDisplayName,
            email: userEmail,
          },
        )
        .catch(() => null),
    );

    if (clickedText) {
      return true;
    }

    await budget.run(() =>
      page.waitForTimeout(Math.min(250, budget.remaining())),
    );
  }

  return false;
}

async function clickRescheduleConfirmDialog(
  page,
  dialogLocator,
  status,
  budget,
) {
  const confirmPatterns = [
    "button:has-text('Confirm')",
    "button:has-text('CONFIRM')",
    "button:has-text('Yes')",
    "button:has-text('YES')",
    "button:has-text('Ok')",
    "button:has-text('OK')",
  ];

  const deadline = Math.min(Date.now() + 15_000, budget.deadline);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const visibleDialog = await budget.run(() =>
      dialogLocator.isVisible().catch(() => false),
    );
    if (!visibleDialog) {
      // eslint-disable-next-line no-await-in-loop
      await budget.run(() =>
        page.waitForTimeout(Math.min(200, budget.remaining())),
      );
      continue;
    }

    for (const selector of confirmPatterns) {
      // eslint-disable-next-line no-await-in-loop
      const confirmBtn = dialogLocator.locator(selector).first();
      // eslint-disable-next-line no-await-in-loop
      const confirmVisible = await confirmBtn
        .waitFor({ state: "visible", timeout: budget.remaining(1500) })
        .then(() => true)
        .catch(() => false);

      if (!confirmVisible) continue;

      // eslint-disable-next-line no-await-in-loop
      const clicked = await confirmBtn
        .click({ timeout: budget.remaining(5000), force: true })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        status("RESCHEDULE_CONFIRM", "Confirmed reschedule dialog");
        return true;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await budget.run(() =>
      page.keyboard?.press?.("Enter", { timeout: budget.remaining() }),
    );
    // eslint-disable-next-line no-await-in-loop
    await budget.run(() =>
      page.waitForTimeout(Math.min(200, budget.remaining())),
    );
  }

  return false;
}

function getBookingBlockLocator(page) {
  return page
    .locator(
      ".ofc-book-slot-block, .ofc-appoinment-sloat-block, .ofc-appointment-sloat-block, .ofc-appointment-slot-block",
    )
    .first();
}

async function waitForAppointmentBookingPageReady(page, budget) {
  const bookingBlock = getBookingBlockLocator(page);
  const visible = await bookingBlock
    .waitFor({ state: "visible", timeout: budget.remaining() })
    .then(() => true)
    .catch(() => false);

  if (!visible) return false;

  await page
    .locator(".ngx-spinner-overlay")
    .first()
    .waitFor({ state: "hidden", timeout: budget.remaining() })
    .catch(() => {});

  return true;
}

async function openRescheduleSurface({
  page,
  appBaseUrl,
  timeoutMs,
  userDisplayName,
  userEmail,
  status,
  budget,
  registerDialog,
}) {
  const myAppointmentsUrl = `${appBaseUrl}/home/appointment/myappointment`;
  status("MY_APPOINTMENTS", `Opening ${myAppointmentsUrl}`);
  await page.goto(myAppointmentsUrl, {
    waitUntil: "domcontentloaded",
    timeout: budget.remaining(),
  });
  await page
    .waitForURL?.(/\/home\/appointment\/myappointment/i, {
      timeout: budget.remaining(25_000),
    })
    .catch(() => {});

  const rescheduleBtn = page
    .locator(
      "a.my-app-button-popup-resch, a:has-text('RESCHEDULE'), button:has-text('RESCHEDULE'), [role='button']:has-text('RESCHEDULE')",
    )
    .first();

  let rescheduleVisible = await rescheduleBtn
    .waitFor({ state: "visible", timeout: budget.remaining(30_000) })
    .then(() => true)
    .catch(() => false);

  if (!rescheduleVisible) {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: budget.remaining() })
      .catch(() => {});
    await budget.run(() =>
      page.waitForTimeout(Math.min(800, budget.remaining())),
    );
    rescheduleVisible = await rescheduleBtn
      .waitFor({ state: "visible", timeout: budget.remaining(30_000) })
      .then(() => true)
      .catch(() => false);
  }

  if (!rescheduleVisible) {
    budget.remaining();
    throw bootstrapError(
      "CONTROL_MISSING",
      "Reschedule button not found on My Appointments",
    );
  }

  const onNativeDialog = async (dialog) => {
    try {
      budget.remaining();
      status("RESCHEDULE_CONFIRM", "Accepting browser dialog");
      await dialog.accept();
    } catch {
      // ignore
    }
  };
  registerDialog(onNativeDialog);

  let clicked = await clickRescheduleForCurrentUser({
    page,
    userDisplayName,
    userEmail,
    timeoutMs: budget.remaining(30_000),
    budget,
  }).catch(() => false);

  if (!clicked) {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: budget.remaining() })
      .catch(() => {});
    await budget.run(() =>
      page.waitForTimeout(Math.min(800, budget.remaining())),
    );
    clicked = await clickRescheduleForCurrentUser({
      page,
      userDisplayName,
      userEmail,
      timeoutMs: budget.remaining(30_000),
      budget,
    }).catch(() => false);
  }

  if (!clicked) {
    budget.remaining();
    throw bootstrapError(
      "CONTROL_MISSING",
      "Reschedule button not found on My Appointments",
    );
  }

  status("RESCHEDULE_CLICK", "Clicked RESCHEDULE");

  const bookingBlockAfterClick = getBookingBlockLocator(page);
  const angularDialog = page
    .locator("mat-dialog-container, [role='dialog']")
    .first();

  const dialogOpened = await angularDialog
    .waitFor({ state: "visible", timeout: budget.remaining(15_000) })
    .then(() => true)
    .catch(() => false);

  if (dialogOpened) {
    const confirmed = await clickRescheduleConfirmDialog(
      page,
      angularDialog,
      status,
      budget,
    );
    if (!confirmed) {
      throw new Error(
        "Reschedule confirmation dialog did not become actionable.",
      );
    }

    await angularDialog
      .waitFor({ state: "detached", timeout: budget.remaining(30_000) })
      .catch(() => {});
    await bookingBlockAfterClick
      .waitFor({ state: "visible", timeout: budget.remaining() })
      .catch(() => {});
  } else if (
    await bookingBlockAfterClick
      .waitFor({ state: "visible", timeout: budget.remaining(15_000) })
      .then(() => true)
      .catch(() => false)
  ) {
    status("RESCHEDULE_CONFIRM", "Reschedule opened booking UI");
  } else {
    status("RESCHEDULE_CONFIRM", "No dialog/booking detected yet; continuing");
  }

  status("BOOKING_WAIT", "Waiting for appointment booking UI");
  const ready = await waitForAppointmentBookingPageReady(page, budget);
  if (!ready) {
    throw new Error("Appointment booking page did not fully load.");
  }
}

async function bootstrapAppointmentSurface({
  page,
  appBaseUrl,
  mode,
  timeoutMs = 10_000,
  userDisplayName,
  userEmail,
  status = noopStatus,
  now = Date.now,
}) {
  const budget = createBootstrapBudget(timeoutMs, now);
  let onResponse;
  let onDialog;
  let finishResponse;
  const responsePromise = new Promise((resolve) => {
    finishResponse = resolve;
  });
  onResponse = (response) => {
    if (APPOINTMENT_SEARCH_PATTERN.test(response.url()))
      finishResponse(response);
  };
  page.on("response", onResponse);
  try {
    if (mode === "reschedule") {
      await budget.run(() =>
        openRescheduleSurface({
          page,
          appBaseUrl,
          timeoutMs,
          userDisplayName,
          userEmail,
          status,
          budget,
          registerDialog: (handler) => {
            onDialog = handler;
            page.once("dialog", handler);
          },
        }),
      );
    } else {
      if (!/\/dashboard/i.test(page.url())) {
        await budget.run(() =>
          page.goto(`${appBaseUrl}/dashboard`, {
            waitUntil: "domcontentloaded",
            timeout: budget.remaining(),
          }),
        );
      }
      if (!(await clickPendingAppointment(page, budget))) {
        budget.remaining();
        throw bootstrapError(
          "CONTROL_MISSING",
          "Pending Appointment control was not found or could not be clicked",
        );
      }
    }
    const response = await budget.run(() => responsePromise);
    const httpStatus = response.status();
    if (httpStatus < 200 || httpStatus >= 300) {
      const ErrorType =
        httpStatus === 401
          ? VisaApiUnauthorizedError
          : httpStatus === 403
            ? VisaApiForbiddenError
            : httpStatus === 429
              ? VisaApiRateLimitedError
              : httpStatus >= 500
                ? VisaPlatformUnavailableError
                : null;
      const error = ErrorType
        ? new ErrorType(
            `Appointment bootstrap search returned HTTP ${httpStatus}`,
            { status: httpStatus, operation: "bootstrapAppointmentSurface" },
          )
        : bootstrapError(
            "HTTP_FAILURE",
            `Appointment bootstrap search returned HTTP ${httpStatus}`,
          );
      error.bootstrapOutcome = "HTTP_FAILURE";
      throw error;
    }
    let body;
    try {
      const text = await budget.run(() => response.text());
      body = JSON.parse(text);
    } catch (error) {
      if (error.bootstrapOutcome) throw error;
      throw bootstrapError(
        "INVALID_RESPONSE",
        "Appointment search response could not be parsed as JSON",
      );
    }
    if (
      !Array.isArray(body) ||
      body.some(
        (item) => !item || typeof item !== "object" || Array.isArray(item),
      )
    ) {
      throw bootstrapError(
        "INVALID_RESPONSE",
        "Appointment search response must be an array of records",
      );
    }
    const appointment = chooseAppointment(body, { mode });
    const outcome = appointment ? "READY" : "INCOMPLETE_CONTEXT";
    const missingFields = appointment ? [] : missingAppointmentFields(body[0]);
    status(
      `CONTEXT_BOOTSTRAP_${outcome}`,
      appointment
        ? "Parsed complete appointment context from the browser response"
        : `Appointment response has no complete ${mode} record; missing=${missingFields.join(",") || "matching appointment status"}`,
    );
    return { captured: true, status: httpStatus, body, outcome, missingFields };
  } catch (error) {
    if (!error.bootstrapOutcome) {
      error = bootstrapError(
        /timeout/i.test(error.message) ? "TIMEOUT" : "NAVIGATION_FAILURE",
        "Appointment bootstrap navigation failed or timed out",
      );
    }
    status(`CONTEXT_BOOTSTRAP_${error.bootstrapOutcome}`, error.message);
    throw error;
  } finally {
    budget.close();
    page.removeListener("response", onResponse);
    if (onDialog) page.removeListener("dialog", onDialog);
    finishResponse(null);
  }
}

module.exports = {
  APPOINTMENT_SEARCH_PATTERN,
  shouldRunContextBootstrap,
  bootstrapAppointmentSurface,
  clickRescheduleForCurrentUser,
};
