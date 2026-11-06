const { chromium } = require("playwright");

function isCertificateError(error) {
  return /ERR_CERT_|CERT_AUTHORITY_INVALID|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED/i.test(
    String(error?.message || error),
  );
}

function certificateFailure() {
  const error = new Error(
    "The visa portal certificate is not trusted on this connection. " +
      "Use a different proxy or set VISA_PROXY_MODE=direct, then restart the backend. " +
      "Certificate validation has not been disabled.",
  );
  error.code = "VISA_TLS_CERTIFICATE_ERROR";
  return error;
}

function proxyOptions(proxyUrl) {
  const parsed = new URL(proxyUrl);
  if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Unsupported proxy protocol");
  }
  const proxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

// Use the same Chrome certificate verifier as the worker. A successful CONNECT
// alone says nothing about the certificate presented inside the proxy tunnel.
async function checkProxyHealth(
  proxyUrl,
  platformHost,
  {
    browserType = chromium,
    timeoutMs = Math.max(
      2000,
      Number(process.env.PROXY_PREFLIGHT_CONNECT_TIMEOUT_MS) || 4000,
    ),
  } = {},
) {
  if (!proxyUrl) return { ok: false, reason: "no-proxy" };
  let browser;
  try {
    browser = await browserType.launch({
      channel: "chrome",
      headless: true,
      proxy: proxyOptions(proxyUrl),
      timeout: 30000,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const targets = new Set([
      platformHost || "www.google.com",
      "www.google.com",
    ]);
    for (const host of targets) {
      // No applicant credentials, saved cookies, or persistent profiles enter this check.
      await page.goto(`https://${host}/`, {
        waitUntil: "commit",
        timeout: timeoutMs,
      });
    }
    return { ok: true };
  } catch (error) {
    // Avoid logging raw Playwright call logs, which may contain proxy credentials.
    const code = String(error?.message || error).match(/\bERR_[A-Z_]+\b/)?.[0];
    return {
      ok: false,
      reason: isCertificateError(error)
        ? `TLS certificate validation failed (${code || "untrusted certificate"})`
        : code ||
          "Proxy HTTPS check failed (connection, timeout, or browser launch)",
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { checkProxyHealth, isCertificateError, certificateFailure };
