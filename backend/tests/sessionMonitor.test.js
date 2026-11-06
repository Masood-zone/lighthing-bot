const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SessionMonitor,
  createLineReader,
  phaseFor,
} = require("../src/queue/sessionMonitor");

function fixture() {
  let time = 0;
  let callback;
  let starts = 0;
  let stops = 0;
  const rows = [];
  const monitor = new SessionMonitor({
    now: () => time,
    emit: (id, record) => rows.push({ id, ...record }),
    schedule: (fn, ms) => {
      assert.equal(ms, 10000);
      callback = fn;
      starts++;
      return { unref() {} };
    },
    cancel: () => stops++,
  });
  return {
    monitor,
    rows,
    setTime: (value) => {
      time = value;
    },
    tick: () => callback(),
    counts: () => ({ starts, stops }),
  };
}
test("quiet API initialization and noisy DOM scanning both receive periodic summaries", () => {
  const f = fixture();
  f.monitor.update("api", "CONTEXT_BOOTSTRAP");
  f.monitor.update("dom", "DATE");
  f.setTime(9000);
  f.monitor.update("dom", "PICKUP_REFRESH");
  f.setTime(10000);
  f.tick();
  assert.equal(f.rows.length, 2);
  assert.deepEqual(f.rows[0], {
    id: "api",
    phase: "initializing",
    state: "CONTEXT_BOOTSTRAP",
    phaseSeconds: 10,
    activitySeconds: 10,
  });
  assert.equal(f.rows[1].phase, "scanning");
  assert.equal(f.rows[1].phaseSeconds, 10);
  assert.equal(f.rows[1].activitySeconds, 1);
  assert.deepEqual(f.counts(), { starts: 1, stops: 0 });
  f.monitor.close();
});
test("summary phase distinguishes queue, login, hourly pause, backoff, completion and errors", () => {
  for (const [state, phase] of [
    ["QUEUED", "queued"],
    ["WAITING_FOR_LOGIN", "login_wait"],
    ["WAITING_FOR_HOURLY_SIGN_IN", "hourly_pause"],
    ["PLATFORM_UNAVAILABLE", "backoff"],
    ["COMPLETED", "completed"],
    ["ERROR", "error"],
  ])
    assert.equal(phaseFor(state), phase);
});
test("last session removal and shutdown cancel the timer without emitting more rows", () => {
  const f = fixture();
  f.monitor.update("first", "START");
  f.monitor.update("second", "START");
  f.monitor.remove("first");
  assert.equal(f.counts().stops, 0);
  f.monitor.remove("second");
  assert.equal(f.counts().stops, 1);
  f.tick();
  assert.equal(f.rows.length, 0);
  f.monitor.update("new", "QUEUED");
  f.monitor.close();
  assert.equal(f.counts().stops, 2);
  f.tick();
  assert.equal(f.rows.length, 0);
});
test("stdout framing preserves split UTF-8, multiple lines and trailing diagnostics", () => {
  const lines = [];
  const reader = createLineReader((line) => lines.push(line));
  const bytes = Buffer.from("first\r\nAccrá\nlast");
  const accent = bytes.indexOf(Buffer.from("á"));
  reader.write(bytes.subarray(0, accent + 1));
  reader.write(bytes.subarray(accent + 1));
  reader.end();
  reader.end();
  assert.deepEqual(lines, ["first", "Accrá", "last"]);
});
test("forked API worker statuses use IPC only, while diagnostic exceptions remain available", async (t) => {
  const originalSend = process.send;
  const originalConnected = process.connected;
  const sent = [];
  const logs = [];
  process.send = (message) => sent.push(message);
  process.connected = true;
  t.after(() => {
    if (originalSend === undefined) delete process.send;
    else process.send = originalSend;
    if (originalConnected === undefined) delete process.connected;
    else process.connected = originalConnected;
  });
  t.mock.method(console, "log", (line) => logs.push(line));
  const { establishApiSession } = require("../main/api-worker");
  await assert.rejects(
    establishApiSession({
      page: {
        goto: async () => {
          throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
        },
        isClosed: () => false,
      },
      context: {},
      networkState: {},
    }),
    { code: "VISA_TLS_CERTIFICATE_ERROR" },
  );
  assert.equal(
    sent.filter((message) => message.state === "WAITING_FOR_LOGIN").length,
    1,
  );
  assert.deepEqual(logs, []);
});
