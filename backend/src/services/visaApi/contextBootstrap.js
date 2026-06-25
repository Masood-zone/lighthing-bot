const APPOINTMENT_SEARCH_PATTERN =
  /\/visaappointmentapi\/appointments\/search/i;

function shouldRunContextBootstrap(cache, nowMs, cooldownMs) {
  const lastAttempt = Number(cache?.browserAttemptedAt) || 0;
  return lastAttempt === 0 || nowMs - lastAttempt >= cooldownMs;
}

function noopStatus() {}

async function clickPendingAppointment(page) {
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
    await candidate
      .evaluate((element) => {
        const clickable = element.closest(
          "button, a, [role='button'], [tabindex]",
        );
        (clickable || element).click();
      })
      .catch(() => {});
    return true;
  }
  return false;
}

async function clickRescheduleForCurrentUser({
  page,
  userDisplayName,
  userEmail,
  timeoutMs = 30_000,
}) {
  const deadline = Date.now() + timeoutMs;

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
      .catch(() => null);

    if (clickedText) {
      return true;
    }

    await page.waitForTimeout(250).catch(() => {});
  }

  return false;
}

async function clickRescheduleConfirmDialog(page, dialogLocator, status) {
  const confirmPatterns = [
    "button:has-text('Confirm')",
    "button:has-text('CONFIRM')",
    "button:has-text('Yes')",
    "button:has-text('YES')",
    "button:has-text('Ok')",
    "button:has-text('OK')",
  ];

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const visibleDialog = await dialogLocator.isVisible().catch(() => false);
    if (!visibleDialog) {
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(200).catch(() => {});
      continue;
    }

    for (const selector of confirmPatterns) {
      // eslint-disable-next-line no-await-in-loop
      const confirmBtn = dialogLocator.locator(selector).first();
      // eslint-disable-next-line no-await-in-loop
      const confirmVisible = await confirmBtn
        .waitFor({ state: "visible", timeout: 1500 })
        .then(() => true)
        .catch(() => false);

      if (!confirmVisible) continue;

      // eslint-disable-next-line no-await-in-loop
      const clicked = await confirmBtn
        .click({ timeout: 5000, force: true })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        status("RESCHEDULE_CONFIRM", "Confirmed reschedule dialog");
        return true;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await page.keyboard?.press?.("Enter")?.catch?.(() => {});
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(200).catch(() => {});
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

async function waitForAppointmentBookingPageReady(page, timeoutMs) {
  const bookingBlock = getBookingBlockLocator(page);
  const visible = await bookingBlock
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!visible) return false;

  await page
    .locator(".ngx-spinner-overlay")
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
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
}) {
  const myAppointmentsUrl = `${appBaseUrl}/home/appointment/myappointment`;
  status("MY_APPOINTMENTS", `Opening ${myAppointmentsUrl}`);
  await page.goto(myAppointmentsUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page
    .waitForURL?.(/\/home\/appointment\/myappointment/i, {
      timeout: Math.min(timeoutMs, 25_000),
    })
    .catch(() => {});

  const rescheduleBtn = page
    .locator(
      "a.my-app-button-popup-resch, a:has-text('RESCHEDULE'), button:has-text('RESCHEDULE'), [role='button']:has-text('RESCHEDULE')",
    )
    .first();

  let rescheduleVisible = await rescheduleBtn
    .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 30_000) })
    .then(() => true)
    .catch(() => false);

  if (!rescheduleVisible) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(800).catch(() => {});
    rescheduleVisible = await rescheduleBtn
      .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 30_000) })
      .then(() => true)
      .catch(() => false);
  }

  if (!rescheduleVisible) {
    throw new Error("Reschedule button not found on My Appointments.");
  }

  const onNativeDialog = async (dialog) => {
    try {
      status("RESCHEDULE_CONFIRM", "Accepting browser dialog");
      await dialog.accept();
    } catch {
      // ignore
    }
  };
  page.once?.("dialog", onNativeDialog);

  let clicked = await clickRescheduleForCurrentUser({
    page,
    userDisplayName,
    userEmail,
    timeoutMs: Math.min(timeoutMs, 30_000),
  }).catch(() => false);

  if (!clicked) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(800).catch(() => {});
    clicked = await clickRescheduleForCurrentUser({
      page,
      userDisplayName,
      userEmail,
      timeoutMs: Math.min(timeoutMs, 30_000),
    }).catch(() => false);
  }

  if (!clicked) {
    throw new Error("Reschedule button not found on My Appointments.");
  }

  status("RESCHEDULE_CLICK", "Clicked RESCHEDULE");

  const bookingBlockAfterClick = getBookingBlockLocator(page);
  const angularDialog = page
    .locator("mat-dialog-container, [role='dialog']")
    .first();

  const dialogOpened = await angularDialog
    .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) })
    .then(() => true)
    .catch(() => false);

  if (dialogOpened) {
    const confirmed = await clickRescheduleConfirmDialog(
      page,
      angularDialog,
      status,
    );
    if (!confirmed) {
      throw new Error(
        "Reschedule confirmation dialog did not become actionable.",
      );
    }

    await angularDialog
      .waitFor({ state: "detached", timeout: Math.min(timeoutMs, 30_000) })
      .catch(() => {});
    await bookingBlockAfterClick
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => {});
  } else if (
    await bookingBlockAfterClick
      .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) })
      .then(() => true)
      .catch(() => false)
  ) {
    status("RESCHEDULE_CONFIRM", "Reschedule opened booking UI");
  } else {
    status("RESCHEDULE_CONFIRM", "No dialog/booking detected yet; continuing");
  }

  status("BOOKING_WAIT", "Waiting for appointment booking UI");
  const ready = await waitForAppointmentBookingPageReady(page, timeoutMs);
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
}) {
  const responsePromise = page
    .waitForResponse(
      (response) => APPOINTMENT_SEARCH_PATTERN.test(response.url()),
      { timeout: timeoutMs },
    )
    .catch(() => null);

  if (mode === "reschedule") {
    await openRescheduleSurface({
      page,
      appBaseUrl,
      timeoutMs,
      userDisplayName,
      userEmail,
      status,
    });
  } else {
    if (!/\/dashboard/i.test(page.url())) {
      await page
        .goto(`${appBaseUrl}/dashboard`, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        })
        .catch(() => {});
    }
    await clickPendingAppointment(page);
  }

  const response = await responsePromise;
  if (!response) return { captured: false, status: null };

  // Let the async DevTools capture listener finish reading the response body.
  await page.waitForTimeout(150).catch(() => {});
  return { captured: true, status: response.status() };
}

module.exports = {
  APPOINTMENT_SEARCH_PATTERN,
  shouldRunContextBootstrap,
  bootstrapAppointmentSurface,
  clickRescheduleForCurrentUser,
};
