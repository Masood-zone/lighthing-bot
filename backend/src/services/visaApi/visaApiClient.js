const {
  VisaAuthenticationExpiredError,
  VisaApiUnauthorizedError,
  VisaApiForbiddenError,
  VisaApiRateLimitedError,
  VisaApiContractError,
  VisaPlatformUnavailableError,
  VisaBookingRejectedError,
  isRetryableReadError,
} = require("./errors");
const {
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

class VisaApiClient {
  constructor({ context, page, auth, baseUrl = DEFAULT_BASE_URL, logger } = {}) {
    this.context = context;
    this.page = page;
    this.auth = auth || {};
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.logger = logger || (() => {});
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

  async request(method, path, { data, operation, readOnly = true } = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const delays = [2000, 5000, 10000];
    const attempts = readOnly ? 3 : 1;
    const op = operation || `${method} ${path}`;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      this.logger("debug", {
        operation: op,
        event: "request_start",
        attempt,
      });

      try {
        const response = await this.context.request.fetch(url, {
          method,
          headers: this._headers({ json: data !== undefined }),
          data: data === undefined ? undefined : JSON.stringify(data),
          timeout: 30_000,
        });

        await this._updateAuthFromResponse(response);
        const text = await response.text();
        const body = parseJsonMaybe(text);
        const status = response.status();
        const retryAfterMs = parseRetryAfter(response.headers()["retry-after"]);

        this.logger("debug", {
          operation: op,
          event: "request_finish",
          status,
          durationMs: Date.now() - startedAt,
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
          /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message);
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

  async getAuthenticatedUser() {
    return this.request("GET", "/visauserapi/portal/getuser", {
      operation: "getAuthenticatedUser",
    });
  }

  async getUserHistoryApplicantPaymentStatus() {
    return this.request(
      "GET",
      "/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus",
      { operation: "getUserHistoryApplicantPaymentStatus" },
    );
  }

  async getPostConfiguration(postUserId) {
    const response = await this.request(
      "GET",
      `/visaadministrationapi/v1/postconfiguration/get/${encodeURIComponent(
        postUserId,
      )}`,
      { operation: "getPostConfiguration" },
    );
    if (!Array.isArray(response)) {
      throw new VisaApiContractError("postconfiguration/get did not return an array", {
        operation: "getPostConfiguration",
        responseBody: safeJson(response),
      });
    }
    return response;
  }

  async getWorkflowData(applicationId) {
    return this.request(
      "GET",
      `/visaworkflowprocessor/workflow/getTransformData/${encodeURIComponent(
        applicationId,
      )}`,
      { operation: "getWorkflowData" },
    );
  }

  async getFirstAvailableMonth(context) {
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
      { data: body, operation: "getFirstAvailableMonth" },
    );
  }

  async getAvailableDates(context, { fromDate, toDate }) {
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
      { data: body, operation: "getAvailableDates" },
    );
    if (!Array.isArray(response)) {
      throw new VisaApiContractError("getSlotDates did not return an array", {
        operation: "getAvailableDates",
        responseBody: safeJson(response),
      });
    }
    return response;
  }

  async getAvailableTimeSlots(context, { slotDate, fromDate, toDate }) {
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
      { data: body, operation: "getAvailableTimeSlots" },
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
    return this.request(
      "POST",
      "/visaappointmentapi/appointments/schedule/group",
      {
        data: payload,
        operation: "submitPendingAppointment",
        readOnly: false,
      },
    );
  }

  async submitRescheduleAppointment(payload) {
    return this.request(
      "PUT",
      "/visaappointmentapi/appointments/schedule/group",
      {
        data: payload,
        operation: "submitRescheduleAppointment",
        readOnly: false,
      },
    );
  }
}

module.exports = { VisaApiClient };
