const {
  VisaAuthenticationExpiredError,
  VisaApiUnauthorizedError,
  VisaApiForbiddenError,
  VisaApiRateLimitedError,
  VisaSlotConflictError,
  VisaApiContractError,
  VisaPlatformUnavailableError,
  VisaBookingRejectedError,
  isRetryableReadError,
} = require("./errors");
const {
  captureVisaSession,
  decodeJwtExp,
  normalizeBearer,
  restoreBrowserAuthToken,
} = require("./sessionExtractor");
const { safeJson } = require("./redaction");

const DEFAULT_BASE_URL = "https://www.usvisaappt.com";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  const spread = Math.max(50, Math.floor(ms * 0.2));
  return ms + Math.floor(Math.random() * spread);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const SAME_SITE = { strict: "Strict", lax: "Lax", none: "None" };

// Minimal Set-Cookie parser for mirroring cookies set on direct (non-browser)
// read responses back into the Playwright context, so the browser session and
// the API session never drift apart.
function parseSetCookie(header, url) {
  const [pair, ...attributes] = String(header || "").split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: new URL(url).hostname,
    path: "/",
    secure: false,
    httpOnly: false,
  };
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    const key = (index === -1 ? attribute : attribute.slice(0, index))
      .trim()
      .toLowerCase();
    const value = index === -1 ? "" : attribute.slice(index + 1).trim();
    if (key === "domain" && value) cookie.domain = value;
    else if (key === "path" && value) cookie.path = value;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite" && SAME_SITE[value.toLowerCase()]) {
      cookie.sameSite = SAME_SITE[value.toLowerCase()];
    } else if (key === "max-age" && Number.isFinite(Number(value))) {
      cookie.expires = Math.floor(Date.now() / 1000) + Number(value);
    } else if (key === "expires" && cookie.expires === undefined) {
      const expires = Date.parse(value);
      if (Number.isFinite(expires)) cookie.expires = Math.floor(expires / 1000);
    }
  }
  return cookie;
}

function providerDiagnostics(body) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const responseMessage = String(value.responseMessage || "");
  return {
    providerStatus: value.status ?? null,
    providerHttpStatus: value.httpStatus ?? null,
    providerRequestUrl: value.requestURL ?? null,
    providerMessageCategory: /appointment booking failed/i.test(responseMessage)
      ? "appointment_booking_failed"
      : responseMessage
        ? "provider_message_present"
        : "none",
  };
}

class VisaApiClient {
  constructor({
    context,
    page,
    auth,
    baseUrl = DEFAULT_BASE_URL,
    logger,
    finalMutationInPage = false,
    networkState,
    bookingUserId,
    readTransport = "playwright",
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.context = context;
    this.page = page;
    this.auth = auth || {};
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.logger = logger || (() => {});
    this.finalMutationInPage = Boolean(finalMutationInPage);
    this.networkState = networkState;
    this.bookingUserId = bookingUserId || this.auth.bookingUserId;
    // "fetch" sends read-only calls through Node's keep-alive HTTP client using
    // the browser's cookies; "playwright" uses context.request. Mutations are
    // unaffected by this setting.
    this.readTransport =
      readTransport === "fetch" && typeof fetchImpl === "function"
        ? "fetch"
        : "playwright";
    this.fetchImpl = fetchImpl;
  }

  // Opens the keep-alive connection before the first scan so it does not pay
  // for the TCP and TLS handshake.
  async warmUp() {
    if (this.readTransport !== "fetch") return;
    const startedAt = Date.now();
    try {
      await this.fetchImpl(`${this.baseUrl}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      this.logger("info", {
        event: "connection_warmed",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger("warn", {
        event: "connection_warm_failed",
        error: String(error?.message || error),
      });
    }
  }

  async _send(url, { method, headers, body, timeoutMs }) {
    if (this.readTransport !== "fetch") {
      const response = await this.context.request.fetch(url, {
        method,
        headers,
        data: body,
        timeout: timeoutMs,
      });
      return {
        status: response.status(),
        headers: () => response.headers(),
        text: () => response.text(),
      };
    }

    const cookies = this.context
      ? await this.context.cookies(url).catch(() => [])
      : [];
    const requestHeaders = { ...headers };
    if (cookies.length) {
      requestHeaders.Cookie = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: requestHeaders,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    if (setCookies.length && this.context) {
      const parsed = setCookies
        .map((header) => parseSetCookie(header, url))
        .filter(Boolean);
      if (parsed.length) await this.context.addCookies(parsed).catch(() => {});
    }

    const responseHeaders = Object.fromEntries(response.headers.entries());
    return {
      status: response.status,
      headers: () => responseHeaders,
      text: () => response.text(),
    };
  }

  async refreshAuthFromPage() {
    if (!this.page || !this.context) {
      throw new VisaPlatformUnavailableError(
        "Browser context is unavailable for final booking authentication refresh",
      );
    }

    const freshAuth = await captureVisaSession({
      page: this.page,
      context: this.context,
      networkState: this.networkState,
      bookingUserId: this.bookingUserId,
    });
    const authorization = normalizeBearer(
      freshAuth.platformAuthToken || freshAuth.authorizationHeader,
    );
    if (!authorization) {
      throw new VisaApiUnauthorizedError(
        "Browser authentication is unavailable for final booking submission",
      );
    }

    this.auth = {
      ...this.auth,
      ...freshAuth,
      authorizationHeader: authorization,
      refreshToken: freshAuth.refreshToken || this.auth.refreshToken,
      csrfToken: freshAuth.csrfToken || this.auth.csrfToken,
      correlationKey: freshAuth.correlationKey || this.auth.correlationKey,
      referer: freshAuth.referer || this.auth.referer,
    };
    this.logger("info", {
      event: "final_auth_refreshed",
      transport: "browser-page",
    });
  }

  _headers({ json = true, referer } = {}) {
    const headers = {
      Accept: "application/json, text/plain, */*",
      LanguageId: this.auth.languageId || "1",
      Referer: referer || this.auth.referer || `${this.baseUrl}/visaapplicantui/`,
    };

    const authorization = normalizeBearer(
      this.auth.platformAuthToken || this.auth.authorizationHeader,
    );
    if (authorization) headers.Authorization = authorization;
    if (this.auth.refreshToken) headers.Refreshtoken = this.auth.refreshToken;
    if (this.auth.csrfToken) headers.csrfToken = this.auth.csrfToken;
    if (this.auth.correlationKey) {
      headers["X-Correlation-Key"] = this.auth.correlationKey;
    }
    if (this.auth.userAgent) headers["User-Agent"] = this.auth.userAgent;
    if (json) headers["Content-Type"] = "application/json";

    return headers;
  }

  async _updateAuthFromResponse(response) {
    const headers = response.headers();
    const authHeader = headers.authorization || headers.Authorization || "";
    const refresh =
      headers.refreshtoken || headers.Refreshtoken || headers.refreshToken || "";
    const csrf = headers.csrftoken || headers.csrfToken || headers.CsrfToken || "";

    if (authHeader) {
      const bearer = normalizeBearer(authHeader);
      const rawToken = bearer.replace(/^Bearer\s+/i, "");
      if (bearer !== this.auth.authorizationHeader) {
        this.auth.authorizationHeader = bearer;
        this.auth.platformAuthToken = rawToken;
        this.auth.tokenExpiresAt = decodeJwtExp(rawToken);
        await restoreBrowserAuthToken(this.page, this.auth);
      }
    }
    if (refresh) this.auth.refreshToken = refresh;
    if (csrf) this.auth.csrfToken = csrf;
  }

  _classifyHttpError({ status, operation, body, retryAfterMs }) {
    if (status === 401) {
      return new VisaApiUnauthorizedError("Visa API returned 401", {
        status,
        operation,
        responseBody: body,
      });
    }
    if (status === 403) {
      return new VisaApiForbiddenError("Visa API returned 403", {
        status,
        operation,
        responseBody: body,
      });
    }
    if (status === 409) {
      return new VisaSlotConflictError("Visa API reported a slot conflict", {
        status,
        operation,
        responseBody: body,
      });
    }
    if (status === 429) {
      return new VisaApiRateLimitedError("Visa API rate limited the request", {
        status,
        operation,
        responseBody: body,
        retryAfterMs,
      });
    }
    if ([500, 502, 503, 504].includes(status)) {
      return new VisaPlatformUnavailableError(
        `Visa platform returned HTTP ${status}`,
        { status, operation, responseBody: body },
      );
    }
    return new VisaBookingRejectedError(`Visa API returned HTTP ${status}`, {
      status,
      operation,
      responseBody: body,
    });
  }

  async request(
    method,
    path,
    {
      data,
      operation,
      readOnly = true,
      maxAttempts,
      timeoutMs = 30_000,
      retryDelaysMs,
    } = {},
  ) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const delays =
      Array.isArray(retryDelaysMs) && retryDelaysMs.length
        ? retryDelaysMs
        : [500, 1500, 3000];
    const configuredAttempts = Number(maxAttempts);
    const attempts = Number.isFinite(configuredAttempts)
      ? Math.max(1, Math.trunc(configuredAttempts))
      : readOnly
        ? 3
        : 1;
    const op = operation || `${method} ${path}`;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      this.logger("debug", {
        operation: op,
        event: "request_start",
        attempt,
      });

      try {
        const response = await this._send(url, {
          method,
          headers: this._headers({ json: data !== undefined }),
          body: data === undefined ? undefined : JSON.stringify(data),
          timeoutMs: Math.max(250, Number(timeoutMs) || 30_000),
        });

        await this._updateAuthFromResponse(response);
        const text = await response.text();
        const body = parseJsonMaybe(text);
        const { status } = response;
        const retryAfterMs = parseRetryAfter(response.headers()["retry-after"]);

        this.logger("debug", {
          operation: op,
          event: "request_finish",
          status,
          durationMs: Date.now() - startedAt,
          transport: this.readTransport,
        });

        if (status < 200 || status >= 300) {
          const error = this._classifyHttpError({
            status,
            operation: op,
            body,
            retryAfterMs,
          });
          if (readOnly && attempt < attempts && isRetryableReadError(error)) {
            const nextDelayMs = jitter(retryAfterMs || delays[attempt - 1]);
            this.logger("warn", {
              operation: op,
              event: "request_retry",
              status,
              attempt,
              nextDelayMs,
            });
            await sleep(nextDelayMs);
            continue;
          }
          this.logger("warn", {
            operation: op,
            event: "request_failed",
            status,
            attempt,
          });
          throw error;
        }

        return body;
      } catch (error) {
        if (
          error instanceof VisaApiUnauthorizedError ||
          error instanceof VisaApiForbiddenError ||
          error instanceof VisaBookingRejectedError
        ) {
          throw error;
        }

        if (error instanceof VisaApiRateLimitedError && readOnly && attempt < attempts) {
          const nextDelayMs = jitter(error.retryAfterMs || delays[attempt - 1]);
          this.logger("warn", {
            operation: op,
            event: "request_retry",
            status: error.status,
            attempt,
            nextDelayMs,
          });
          await sleep(nextDelayMs);
          continue;
        }

        if (error instanceof VisaPlatformUnavailableError && readOnly && attempt < attempts) {
          const nextDelayMs = jitter(delays[attempt - 1]);
          this.logger("warn", {
            operation: op,
            event: "request_retry",
            status: error.status,
            attempt,
            nextDelayMs,
          });
          await sleep(nextDelayMs);
          continue;
        }

        const message = String(error?.message || error);
        const transient =
          /timeout|abort|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(
            message,
          );
        if (readOnly && transient && attempt < attempts) {
          const nextDelayMs = jitter(delays[attempt - 1]);
          this.logger("warn", {
            operation: op,
            event: "request_retry",
            attempt,
            error: message,
            nextDelayMs,
          });
          await sleep(nextDelayMs);
          continue;
        }

        if (transient) {
          this.logger("warn", {
            operation: op,
            event: "request_failed",
            attempt,
            error: message,
          });
          throw new VisaPlatformUnavailableError(message, { operation: op });
        }

        this.logger("warn", {
          operation: op,
          event: "request_failed",
          attempt,
          error: message,
        });
        throw error;
      }
    }

    throw new VisaAuthenticationExpiredError(`Request failed: ${op}`);
  }

  async requestInPage(method, path, { data, operation, timeoutMs = 30_000 } = {}) {
    if (!this.page) {
      throw new VisaPlatformUnavailableError(
        "Browser page is unavailable for the final booking request",
        { operation },
      );
    }
    // Refresh immediately before the single final mutation. This keeps the
    // worker's explicit API headers aligned with the active browser session.
    await this.refreshAuthFromPage();

    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const op = operation || `${method} ${path}`;
    const startedAt = Date.now();
    const headers = this._headers({ json: data !== undefined });

    this.logger("info", {
      operation: op,
      event: "final_request_contract",
      method,
      bodyShape: Array.isArray(data) ? "array" : typeof data,
      itemCount: Array.isArray(data) ? data.length : null,
      itemKeys:
        Array.isArray(data) && data[0] && typeof data[0] === "object"
          ? Object.keys(data[0]).sort()
          : [],
      transport: "browser-page",
    });

    // The browser owns these context-sensitive headers. Supplying them through
    // Playwright's page fetch would either be ignored or mask the native values.
    delete headers.Referer;
    delete headers["User-Agent"];

    this.logger("debug", { operation: op, event: "request_start", attempt: 1 });

    let result;
    try {
      result = await this.page.evaluate(
        async ({ requestUrl, requestMethod, requestHeaders, requestData, requestTimeoutMs }) => {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            const response = await fetch(requestUrl, {
              method: requestMethod,
              headers: requestHeaders,
              body: requestData === undefined ? undefined : JSON.stringify(requestData),
              credentials: "include",
              signal: controller.signal,
            });
            return {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              text: await response.text(),
            };
          } finally {
            window.clearTimeout(timeout);
          }
        },
        {
          requestUrl: url,
          requestMethod: method,
          requestHeaders: headers,
          requestData: data,
          requestTimeoutMs: Math.max(250, Number(timeoutMs) || 30_000),
        },
      );
    } catch (error) {
      const message = String(error?.message || error);
      this.logger("warn", {
        operation: op,
        event: "request_failed",
        attempt: 1,
        error: message,
      });
      throw new VisaPlatformUnavailableError(message, { operation: op });
    }

    const body = parseJsonMaybe(result.text);
    const status = Number(result.status);
    const retryAfterMs = parseRetryAfter(result.headers?.["retry-after"]);
    this.logger("debug", {
      operation: op,
      event: "request_finish",
      status,
      durationMs: Date.now() - startedAt,
      transport: "browser-page",
    });

    if (status < 200 || status >= 300) {
      this.logger("warn", {
        operation: op,
        event: "final_response_diagnostics",
        status,
        ...providerDiagnostics(body),
        transport: "browser-page",
      });
      this.logger("warn", {
        operation: op,
        event: "request_failed",
        status,
        attempt: 1,
        transport: "browser-page",
      });
      throw this._classifyHttpError({
        status,
        operation: op,
        body,
        retryAfterMs,
      });
    }

    const responseHeaders = result.headers || {};
    await this._updateAuthFromResponse({ headers: () => responseHeaders });
    return body;
  }

  async getAuthenticatedUser() {
    return this.request("GET", "/visauserapi/portal/getuser", {
      operation: "getAuthenticatedUser",
    });
  }

  async getUserHistoryApplicantPaymentStatus(options = {}) {
    return this.request(
      "GET",
      "/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus",
      { operation: "getUserHistoryApplicantPaymentStatus", ...options },
    );
  }

  async searchCurrentAppointments(applicationId, options = {}) {
    const body = {
      operation: "AND",
      searchObjects: [
        {
          key: "applicationId",
          value: String(applicationId),
          fieldType: "STRING",
          operation: "EQUAL",
        },
      ],
    };
    const response = await this.request(
      "POST",
      "/visaappointmentapi/appointments/search",
      {
        data: body,
        operation: "searchCurrentAppointments",
        ...options,
      },
    );
    if (!Array.isArray(response)) {
      throw new VisaApiContractError("appointments/search did not return an array", {
        operation: "searchCurrentAppointments",
        responseBody: safeJson(response),
      });
    }
    return response;
  }

  async getFirstAvailableMonth(context, options = {}) {
    const body = {
      applicantId: context.applicantId,
      applicationId: context.applicationId,
      locationType: context.locationType,
      postUserId: context.postUserId,
      visaClass: context.visaClass,
      visaType: context.visaType,
    };
    return this.request(
      "POST",
      "/visaadministrationapi/v1/modifyslot/getFirstAvailableMonth",
      { data: body, operation: "getFirstAvailableMonth", ...options },
    );
  }

  async getAvailableDates(context, { fromDate, toDate }, options = {}) {
    const body = {
      fromDate,
      toDate,
      postUserId: context.postUserId,
      applicantId: context.applicantId,
      applicationId: context.applicationId,
      locationType: context.locationType,
      visaClass: context.visaClass,
      visaType: context.visaType,
    };
    const response = await this.request(
      "POST",
      "/visaadministrationapi/v1/modifyslot/getSlotDates",
      { data: body, operation: "getAvailableDates", ...options },
    );
    if (!Array.isArray(response)) {
      throw new VisaApiContractError("getSlotDates did not return an array", {
        operation: "getAvailableDates",
        responseBody: safeJson(response),
      });
    }
    return response;
  }

  async getAvailableTimeSlots(
    context,
    { slotDate, fromDate, toDate },
    options = {},
  ) {
    const body = {
      fromDate,
      toDate,
      postUserId: context.postUserId,
      applicantId: context.applicantId,
      applicationId: context.applicationId,
      slotDate,
      visaClass: context.visaClass,
      visaType: context.visaType,
    };
    const response = await this.request(
      "POST",
      "/visaadministrationapi/v1/modifyslot/getSlotTime",
      { data: body, operation: "getAvailableTimeSlots", ...options },
    );
    if (!Array.isArray(response)) {
      throw new VisaApiContractError("getSlotTime did not return an array", {
        operation: "getAvailableTimeSlots",
        responseBody: safeJson(response),
      });
    }
    return response;
  }

  async submitPendingAppointment(payload) {
    const mutationBody = [payload];
    if (this.finalMutationInPage) {
      return this.requestInPage(
        "PUT",
        "/visaappointmentapi/appointments/schedule/group",
        { data: mutationBody, operation: "submitPendingAppointment" },
      );
    }
    return this.request(
      "PUT",
      "/visaappointmentapi/appointments/schedule/group",
      {
        data: mutationBody,
        operation: "submitPendingAppointment",
        readOnly: false,
      },
    );
  }

  async submitRescheduleAppointment(payload) {
    const mutationBody = [payload];
    if (this.finalMutationInPage) {
      return this.requestInPage(
        "PUT",
        "/visaappointmentapi/appointments/reschedule",
        { data: mutationBody, operation: "submitRescheduleAppointment" },
      );
    }
    return this.request(
      "PUT",
      "/visaappointmentapi/appointments/reschedule",
      {
        data: mutationBody,
        operation: "submitRescheduleAppointment",
        readOnly: false,
      },
    );
  }
}

module.exports = { VisaApiClient, parseSetCookie };
