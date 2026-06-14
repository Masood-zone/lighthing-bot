const { redactString } = require("./redaction");

function nowIso() {
  return new Date().toISOString();
}

function decodeJwtExp(token) {
  const raw = String(token || "").replace(/^Bearer\s+/i, "");
  const [, payload] = raw.split(".");
  if (!payload) return null;

  try {
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return Number.isFinite(Number(parsed.exp))
      ? new Date(Number(parsed.exp) * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function normalizeBearer(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function createNetworkCapture() {
  const state = {
    authorizationHeader: "",
    refreshToken: "",
    csrfToken: "",
    correlationKey: "",
    referer: "",
    requests: [],
    responses: [],
  };

  const rememberRequest = (request) => {
    try {
      const headers = request.headers();
      const url = request.url();
      const method = request.method();
      const postData = request.postData();
      const correlation =
        headers["x-correlation-key"] || headers["X-Correlation-Key"] || "";
      if (correlation) state.correlationKey = correlation;
      if (headers.referer) state.referer = headers.referer;
      state.requests.push({
        url,
        method,
        postData: redactString(postData || ""),
        capturedAt: nowIso(),
      });
      if (state.requests.length > 200) state.requests.shift();
    } catch {
      // Capture must not interfere with the browser.
    }
  };

  const rememberResponse = async (response) => {
    try {
      const headers = response.headers();
      const auth = headers.authorization || headers.Authorization || "";
      const refresh =
        headers.refreshtoken || headers.Refreshtoken || headers.refreshToken || "";
      const csrf = headers.csrftoken || headers.csrfToken || headers.CsrfToken || "";
      if (auth) state.authorizationHeader = normalizeBearer(auth);
      if (refresh) state.refreshToken = refresh;
      if (csrf) state.csrfToken = csrf;
      state.responses.push({
        url: response.url(),
        status: response.status(),
        capturedAt: nowIso(),
      });
      if (state.responses.length > 200) state.responses.shift();
    } catch {
      // Capture must not interfere with the browser.
    }
  };

  return { state, rememberRequest, rememberResponse };
}

async function captureVisaSession({ page, context, networkState, bookingUserId }) {
  const platformAuthToken = await page
    .evaluate(() => window.sessionStorage.getItem("authToken"))
    .catch(() => "");

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
  const languageId = await page
    .evaluate(() => window.localStorage.getItem("LanguageId") || "1")
    .catch(() => "1");
  const storageUrl = await page.url().catch?.(() => "") || page.url();
  const cookies = await context.cookies().catch(() => []);

  const bearer =
    normalizeBearer(platformAuthToken) ||
    normalizeBearer(networkState?.authorizationHeader);

  return {
    sessionId:
      globalThis.crypto?.randomUUID?.() || require("node:crypto").randomUUID(),
    bookingUserId,
    platformAuthToken: String(platformAuthToken || "").trim(),
    authorizationHeader: bearer,
    refreshToken: networkState?.refreshToken || "",
    csrfToken: networkState?.csrfToken || "",
    correlationKey: networkState?.correlationKey || "",
    referer:
      networkState?.referer ||
      "https://www.usvisaappt.com/visaapplicantui/home/appointment/myappointment",
    cookies,
    userAgent,
    languageId: String(languageId || "1"),
    tokenExpiresAt: decodeJwtExp(platformAuthToken || bearer),
    authenticatedAt: nowIso(),
    lastValidatedAt: null,
    storageUrl,
  };
}

async function restoreBrowserAuthToken(page, auth) {
  const token = String(auth?.platformAuthToken || "").trim();
  if (!token) return;
  await page
    .evaluate((nextToken) => {
      window.sessionStorage.setItem("authToken", nextToken);
    }, token)
    .catch(() => {});
}

function tokenExpiresSoon(auth, leewayMs = 60_000) {
  if (!auth?.tokenExpiresAt) return false;
  const expiry = Date.parse(auth.tokenExpiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - Date.now() <= leewayMs;
}

module.exports = {
  createNetworkCapture,
  captureVisaSession,
  restoreBrowserAuthToken,
  tokenExpiresSoon,
  normalizeBearer,
  decodeJwtExp,
};
