const { VisaApiContractError } = require("./errors");

function bootstrapError(outcome, message) {
  const error = new VisaApiContractError(message, {
    operation: "bootstrapAppointmentSurface",
  });
  error.bootstrapOutcome = outcome;
  return error;
}

function createBootstrapBudget(timeoutMs, now = Date.now) {
  const deadline = now() + timeoutMs;
  let closed = false;
  return {
    deadline,
    remaining(cap = Infinity) {
      const remaining = deadline - now();
      if (closed || remaining <= 0)
        throw bootstrapError(
          "TIMEOUT",
          "Appointment bootstrap deadline expired",
        );
      return Math.max(1, Math.min(cap, remaining));
    },
    async run(work) {
      const remaining = this.remaining();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            this.remaining();
            return work();
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  bootstrapError(
                    "TIMEOUT",
                    "Appointment bootstrap deadline expired",
                  ),
                ),
              remaining,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      closed = true;
    },
  };
}

module.exports = { createBootstrapBudget, bootstrapError };
