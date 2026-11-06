const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkProxyHealth,
  isCertificateError,
  certificateFailure,
} = require("../src/queue/proxyHealth");
function browserFixture(error) {
  const calls = { targets: [], closed: 0 };
  const browserType = {
    launch: async (options) => {
      calls.launch = options;
      return {
        newContext: async (options) => {
          calls.context = options;
          return {
            newPage: async () => ({
              goto: async (url, options) => {
                calls.targets.push({ url, options });
                if (error) throw error;
              },
            }),
          };
        },
        close: async () => {
          calls.closed++;
        },
      };
    },
  };
  return { calls, browserType };
}
test("preflight validates Chrome HTTPS through the proxy for the portal and CAPTCHA", async () => {
  const { calls, browserType } = browserFixture();
  assert.deepEqual(
    await checkProxyHealth(
      "http://name:p%40ss@proxy.test:8080",
      "portal.test",
      { browserType },
    ),
    { ok: true },
  );
  assert.equal(calls.launch.headless, true);
  assert.equal(calls.launch.channel, "chrome");
  assert.deepEqual(calls.launch.proxy, {
    server: "http://proxy.test:8080",
    username: "name",
    password: "p@ss",
  });
  assert.equal(calls.context.ignoreHTTPSErrors, false);
  assert.deepEqual(
    calls.targets.map(({ url }) => url),
    ["https://portal.test/", "https://www.google.com/"],
  );
  assert.equal(calls.closed, 1);
});
test("an untrusted certificate is rejected and its probe browser is closed", async () => {
  const { calls, browserType } = browserFixture(
    new Error("page.goto: net::ERR_CERT_AUTHORITY_INVALID"),
  );
  const result = await checkProxyHealth(
    "http://proxy.test:8080",
    "portal.test",
    { browserType },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /TLS certificate validation failed/);
  assert.equal(calls.targets.length, 1);
  assert.equal(calls.closed, 1);
});
test("raw Playwright call logs cannot leak proxy credentials into diagnostics", async () => {
  const { browserType } = browserFixture(
    new Error(
      "launch failed for http://secret-name:secret-password@proxy.test",
    ),
  );
  const result = await checkProxyHealth(
    "http://proxy.test:8080",
    "portal.test",
    { browserType },
  );
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /secret-name|secret-password/);
});
test("certificate failures stop login; ordinary timeouts retain normal retry handling", () => {
  assert.equal(
    isCertificateError(new Error("net::ERR_CERT_AUTHORITY_INVALID")),
    true,
  );
  assert.equal(
    isCertificateError(new Error("net::ERR_CERT_DATE_INVALID")),
    true,
  );
  assert.equal(isCertificateError(new Error("Timeout 3000ms exceeded")), false);
  const error = certificateFailure();
  assert.equal(error.code, "VISA_TLS_CERTIFICATE_ERROR");
  assert.match(error.message, /VISA_PROXY_MODE=direct/);
});

test("API login terminates on a certificate error rather than waiting or retrying", async () => {
  const { establishApiSession } = require("../main/api-worker");
  let navigations = 0;
  const page = {
    goto: async () => {
      navigations++;
      throw new Error("page.goto: net::ERR_CERT_AUTHORITY_INVALID");
    },
    isClosed: () => false,
    locator: () =>
      assert.fail("Must not wait for a login form on the privacy error page"),
  };
  await assert.rejects(
    establishApiSession({ page, context: {}, networkState: {} }),
    { code: "VISA_TLS_CERTIFICATE_ERROR" },
  );
  assert.equal(navigations, 1);
});
