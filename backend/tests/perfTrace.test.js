const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPerfTracer,
  isPerfTraceEnabled,
} = require("../src/perfTrace");

test("performance tracing is enabled only by VISA_PERF_TRACE=1", () => {
  assert.equal(isPerfTraceEnabled({ VISA_PERF_TRACE: "1" }), true);
  assert.equal(isPerfTraceEnabled({ VISA_PERF_TRACE: "true" }), false);
  assert.equal(isPerfTraceEnabled({}), false);
});

test("disabled performance tracer does not call its writer or clock", async () => {
  let calls = 0;
  const tracer = createPerfTracer({
    mode: "api",
    enabled: false,
    write: () => {
      calls += 1;
    },
    clock: () => {
      calls += 1;
      return 0;
    },
  });

  assert.equal(await tracer.measure("hunt", async () => "ok"), "ok");
  tracer.start("scan")();
  assert.equal(calls, 0);
});

test("enabled performance tracer writes structured duration records", async () => {
  const entries = [];
  const ticks = [100, 145];
  const tracer = createPerfTracer({
    mode: "dom",
    enabled: true,
    write: (entry) => entries.push(entry),
    clock: () => ticks.shift(),
  });

  await tracer.measure("visible_month_green_date_scan", async () => true, {
    month: "2026-11",
  });

  assert.deepEqual(entries, [
    {
      event: "visa_perf",
      mode: "dom",
      operation: "visible_month_green_date_scan",
      durationMs: 45,
      month: "2026-11",
      outcome: "success",
    },
  ]);
});
