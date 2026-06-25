class VisaApiError extends Error {
  constructor(message, { status, operation, responseBody, retryAfterMs } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.operation = operation;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }
}

class VisaAuthenticationExpiredError extends VisaApiError {}
class VisaSessionInvalidError extends VisaApiError {}
class VisaApiUnauthorizedError extends VisaApiError {}
class VisaApiForbiddenError extends VisaApiError {}
class VisaApiRateLimitedError extends VisaApiError {}
class VisaNoDatesAvailableError extends VisaApiError {}
class VisaNoSlotsAvailableError extends VisaApiError {}
class VisaSlotConflictError extends VisaApiError {}
class VisaBookingRejectedError extends VisaApiError {}
class VisaBookingVerificationError extends VisaApiError {}
class VisaApiContractError extends VisaApiError {}
class VisaPlatformUnavailableError extends VisaApiError {}
class VisaApplicationNotFoundError extends VisaApiError {}
class VisaManualInterventionRequiredError extends VisaApiError {}

function isRetryableReadError(error) {
  if (!error) return false;
  if (error instanceof VisaApiRateLimitedError) return true;
  if (error instanceof VisaPlatformUnavailableError) return true;
  const status = Number(error.status);
  return status === 500 || status === 502 || status === 503 || status === 504;
}

module.exports = {
  VisaApiError,
  VisaAuthenticationExpiredError,
  VisaSessionInvalidError,
  VisaApiUnauthorizedError,
  VisaApiForbiddenError,
  VisaApiRateLimitedError,
  VisaNoDatesAvailableError,
  VisaNoSlotsAvailableError,
  VisaSlotConflictError,
  VisaBookingRejectedError,
  VisaBookingVerificationError,
  VisaApiContractError,
  VisaPlatformUnavailableError,
  VisaApplicationNotFoundError,
  VisaManualInterventionRequiredError,
  isRetryableReadError,
};
