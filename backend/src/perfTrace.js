function isPerfTraceEnabled(env = process.env) {
  return env?.VISA_PERF_TRACE === "1";
}

function createPerfTracer({
  mode,
  enabled = isPerfTraceEnabled(),
  write = (entry) => console.log(`[VISA_PERF] ${JSON.stringify(entry)}`),
  clock = () => Date.now(),
} = {}) {
  if (!enabled) {
    return {
      enabled: false,
      start: () => () => {},
      measure: async (_operation, fn) => fn(),
    };
  }

  const emit = (operation, startedAt, context = {}) => {
    write({
      event: "visa_perf",
      mode,
      operation,
      durationMs: Math.max(0, clock() - startedAt),
      ...context,
    });
  };

  return {
    enabled: true,
    start(operation, context = {}) {
      const startedAt = clock();
      return (finalContext = {}) =>
        emit(operation, startedAt, { ...context, ...finalContext });
    },
    async measure(operation, fn, context = {}) {
      const finish = this.start(operation, context);
      try {
        const result = await fn();
        finish({ outcome: "success" });
        return result;
      } catch (error) {
        finish({ outcome: "error", errorName: error?.name || "Error" });
        throw error;
      }
    },
  };
}

module.exports = { createPerfTracer, isPerfTraceEnabled };
