const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

process.env.VISA_PLATFORM_URL = "https://portal.test/visaapplicantui/login";
process.env.VISA_USER_EMAIL = "fixture@example.com";
process.env.VISA_USER_PASSWORD = "fixture-password";
process.env.VISA_USER_DISPLAY_NAME = "";
process.env.VISA_AUTO_SUBMIT_LOGIN = "1";
process.env.VISA_SECRET_KEY = "fixture-only-secret";
process.env.VISA_HEADLESS = "true";
process.env.VISA_PROFILE_DIR = "";
process.env.VISA_PROXY_MODE = "direct";
const { login, resetPortalAuthentication } = require("../main/api-worker");
const {
  savePortalSession,
  loadPortalSession,
  seedPortalSessionStorage,
} = require("../src/services/visaApi/portalSession");

const loginHtml = `<!doctype html><html><body>
<label>Email <input formcontrolname="username"></label>
<label>Password <input type="password" formcontrolname="password"></label>
<label><input id="captcha" type="checkbox">Complete CAPTCHA</label>
<button onclick="if(document.querySelector('#captcha').checked) { sessionStorage.setItem('authToken','new-token'); location.href='/visaapplicantui/dashboard'; }">Sign In</button>
</body></html>`;

async function fixture(context) {
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().endsWith("/dashboard")
        ? "<h1>Dashboard</h1>"
        : loginHtml,
    }),
  );
}

test(
  "controlled portal: hourly login prefills credentials and waits for a trusted Sign In, including failed CAPTCHA",
  { timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await fixture(context);
    const page = await context.newPage();
    let authenticated = false;
    const pending = login(page, { manual: true }).then(() => {
      authenticated = true;
    });
    await page.waitForFunction(
      () =>
        document.querySelector('input[formcontrolname="password"]')?.value ===
        "fixture-password",
    );
    assert.equal(
      await page.locator('input[formcontrolname="username"]').inputValue(),
      "fixture@example.com",
    );
    await page.getByRole("button", { name: "Sign In" }).click();
    assert.equal(authenticated, false);
    await page.locator("#captcha").check();
    // The regular auto-submit helper is enabled globally; hourly mode must not invoke it.
    await page.waitForTimeout(250);
    assert.equal(authenticated, false);
    assert.match(page.url(), /login$/);
    await page.getByRole("button", { name: "Sign In" }).click();
    await pending;
    assert.equal(authenticated, true);
  },
);

test(
  "controlled portal: a dashboard reached without pressing Sign In does not resume",
  { timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await fixture(context);
    const page = await context.newPage();
    let authenticated = false;
    const pending = login(page, { manual: true }).then(() => {
      authenticated = true;
    });
    const rejected = assert.rejects(pending, /closed/);
    await page.waitForFunction(
      () =>
        document.querySelector('input[formcontrolname="password"]')?.value ===
        "fixture-password",
    );
    await page.goto("https://portal.test/visaapplicantui/dashboard");
    await page.waitForTimeout(250);
    assert.equal(authenticated, false);
    await page.close();
    await rejected;
  },
);

test(
  "controlled portal: hourly reset clears saved auth, cookies, storage, and restore init scripts",
  { timeout: 30000 },
  async (t) => {
    const profileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "lightingbot-hourly-browser-"),
    );
    let context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: true,
    });
    t.after(async () => {
      await context.close();
      await fs.rm(profileDir, { recursive: true, force: true });
    });
    await fixture(context);
    const page = context.pages()[0];
    const saved = {
      origin: "https://portal.test",
      sessionStorage: { authToken: "old-token" },
    };
    await seedPortalSessionStorage(context, saved);
    await page.goto("https://portal.test/visaapplicantui/dashboard");
    await page.evaluate(() =>
      localStorage.setItem("refreshToken", "old-refresh"),
    );
    await context.addCookies([
      { name: "auth", value: "old-cookie", url: "https://portal.test" },
    ]);
    await savePortalSession({
      profileDir,
      page,
      auth: {
        authorizationHeader: "Bearer old-token",
        tokenExpiresAt: new Date(Date.now() + 7200000).toISOString(),
      },
    });
    assert.ok(await loadPortalSession({ profileDir }));
    await resetPortalAuthentication({ page, context, profileDir });
    assert.equal(await loadPortalSession({ profileDir }), null);
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: true,
    });
    await fixture(context);
    const fresh = context.pages()[0];
    await fresh.goto("https://portal.test/visaapplicantui/login");
    assert.equal(
      await fresh.evaluate(() => sessionStorage.getItem("authToken")),
      null,
    );
    assert.equal(
      await fresh.evaluate(() => localStorage.getItem("refreshToken")),
      null,
    );
    assert.deepEqual(await context.cookies(), []);
  },
);

test("API browser stays visible when a profile requests headless mode", async (t) => {
  const { launchBrowser } = require("../main/api-worker");
  let options;
  const page = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {} };
  const context = { newPage: async () => page };
  const browser = { newContext: async () => context };
  t.mock.method(chromium, "launch", async (launchOptions) => {
    options = launchOptions;
    return browser;
  });
  const result = await launchBrowser();
  assert.equal(options.headless, false);
  assert.equal(result.page, page);
  assert.equal(options.args.includes("--ignore-certificate-errors"), false);
});

test("controlled portal: API initialization consumes a parsed browser search response without waiting for the capture listener", { timeout: 30000 }, async (t) => {
  const { resolveContext } = require("../main/api-worker");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const appointment = {
    applicationId: "fixture-app", applicantId: "fixture-person", appointmentId: "fixture-appointment",
    visaType: "NIV", visaClass: "F1", appointmentLocationType: "POST", appointmentStatus: "NEW",
  };
  await context.route("**/*", async (route) => {
    if (route.request().url().includes("/appointments/search")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([appointment]) });
    } else {
      await route.fulfill({ contentType: "text/html", body: `<button onclick="fetch('/visaappointmentapi/appointments/search',{method:'POST'})">Pending Appointment Request</button>` });
    }
  });
  const page = await context.newPage();
  await page.goto("https://portal.test/visaapplicantui/dashboard");
  const networkState = { requests: [], responses: [] };
  const result = await resolveContext({
    client: {
      getAuthenticatedUser: async () => ({ applicationId: "fixture-app", applicantId: "fixture-person" }),
      getUserHistoryApplicantPaymentStatus: async () => null,
      searchCurrentAppointments: async () => assert.fail("Browser context already contains the verified response"),
    },
    page, networkState,
    bootstrapCache: { user: null, history: null, historyAttempted: false, browserAttemptedAt: 0 },
  });
  assert.equal(result.appointment.appointmentId, "fixture-appointment");
  assert.equal(result.source, "captured_appointments_search");
  assert.deepEqual(networkState.responses, []);
});
