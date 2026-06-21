const APPOINTMENT_SEARCH_PATTERN =
  /\/visaappointmentapi\/appointments\/search/i;

function shouldRunContextBootstrap(cache, nowMs, cooldownMs) {
  const lastAttempt = Number(cache?.browserAttemptedAt) || 0;
  return lastAttempt === 0 || nowMs - lastAttempt >= cooldownMs;
}

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

async function bootstrapAppointmentSurface({
  page,
  appBaseUrl,
  mode,
  timeoutMs = 10_000,
}) {
  const responsePromise = page
    .waitForResponse(
      (response) => APPOINTMENT_SEARCH_PATTERN.test(response.url()),
      { timeout: timeoutMs },
    )
    .catch(() => null);

  if (mode === "reschedule") {
    await page
      .goto(`${appBaseUrl}/home/appointment/myappointment`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      })
      .catch(() => {});
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
};
