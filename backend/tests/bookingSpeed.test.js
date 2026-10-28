const test = require("node:test");
const assert = require("node:assert/strict");

const { findDateAndSlot, runApiHuntCycle } = require("../main/api-worker");
const {
  createScanScheduler,
  createScanStats,
  mapInBatches,
  parseSetCookie,
  VisaApiClient,
  VisaNoDatesAvailableError,
  VisaSlotConflictError,
} = require("../src/services/visaApi");

const context = {
  availability: { applicationId: "app-1" },
  appointment: {
    applicantId: "applicant-1",
    applicationId: "application-1",
    appointmentId: "appointment-1",
    appointmentLocationType: "POST",
    appointmentDt: "2026-11-04T00:00:00.000Z",
    postUserId: "483",
  },
};

function usableSlot(date, time = "09:30", id = `slot-${date}-${time}`) {
  return {
    slotId: id,
    slotStatus: "UNBOOKED",
    status: "A",
    startTime: `${date}T${time}:00.000Z`,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("scheduler paces scans start-to-start and never waits after a slow scan", () => {
  let clock = 10_000;
  const scheduler = createScanScheduler({
    pollMs: 750,
    jitterMs: 0,
    now: () => clock,
  });

  clock = 10_700; // a 700 ms response
  assert.equal(scheduler.delayUntilNextScan(10_000), 50);
  clock = 11_200; // a 1200 ms response
  assert.equal(scheduler.delayUntilNextScan(10_000), 0);
});

test("scheduler backs off on failures and 429s, and success clears penalties", () => {
  const scheduler = createScanScheduler({ jitterMs: 0 });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(() => scheduler.onFailure()),
    [1000, 2000, 4000, 8000, 15000, 15000],
  );
  assert.equal(scheduler.throttleState, "backoff:6");
  scheduler.onSuccess();
  assert.equal(scheduler.throttleState, "normal");
  assert.equal(scheduler.onFailure(), 1000);

  scheduler.onSuccess();
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(() => scheduler.onRateLimited(null)),
    [5000, 10000, 20000, 40000, 60000, 60000],
  );
  assert.equal(scheduler.onRateLimited(7000), 7000, "Retry-After wins");
  scheduler.onSuccess();
  assert.equal(scheduler.onRateLimited(undefined), 5000);
});

test("mapInBatches keeps input order and stops after a matching batch", async () => {
  const started = [];
  const results = await mapInBatches(
    [30, 5, 10, 1, 1],
    2,
    async (ms) => {
      started.push(ms);
      await delay(ms);
      return ms;
    },
    { stopWhen: (batch) => batch.includes(10) },
  );
  assert.deepEqual(results, [30, 5, 10, 1]);
  assert.deepEqual(started, [30, 5, 10, 1]);
});

test("scan stats produce one heartbeat per interval and then reset", () => {
  let clock = 0;
  const stats = createScanStats({ now: () => clock });
  stats.recordScan({ latencyMs: 600, firstAvailableDate: "2026-12-01" });
  stats.recordScan({ latencyMs: 800, firstAvailableDate: "2026-12-01" });
  assert.equal(stats.takeHeartbeat(10_000), null);
  clock = 10_000;
  const summary = stats.takeHeartbeat(10_000);
  assert.equal(summary.scans, 2);
  assert.equal(summary.averageLatencyMs, 700);
  assert.equal(summary.lastFirstAvailableDate, "2026-12-01");
  assert.equal(stats.stats.scans, 0);
});

test("parallel slot lookups still pick the earliest date even if it answers last", async () => {
  const client = {
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates() {
      return ["2026-10-10", "2026-10-12"];
    },
    async getAvailableTimeSlots(_context, request) {
      // The earlier date responds slower than the later one.
      await delay(request.slotDate === "2026-10-10" ? 30 : 1);
      return [usableSlot(request.slotDate, "11:00"), usableSlot(request.slotDate, "08:00")];
    },
  };

  const result = await findDateAndSlot({
    client,
    context,
    preferences: {
      window: { minDate: "2026-10-01", maxDate: "2026-10-31" },
      mode: "pending",
    },
  });
  assert.equal(result.selectedDate, "2026-10-10");
  assert.equal(result.selectedSlot.startTime, "2026-10-10T08:00:00.000Z");
  assert.deepEqual(
    result.fallbacks.map((option) => option.selectedSlot.startTime),
    ["2026-10-10T11:00:00.000Z", "2026-10-12T08:00:00.000Z"],
  );
});

test("a first month after the window makes no date or slot calls", async () => {
  const calls = [];
  const client = {
    async getFirstAvailableMonth() {
      calls.push("first");
      return { present: true, date: "2027-03-01" };
    },
    async getAvailableDates() {
      calls.push("dates");
      return [];
    },
    async getAvailableTimeSlots() {
      calls.push("slots");
      return [];
    },
  };
  await assert.rejects(
    findDateAndSlot({
      client,
      context,
      preferences: {
        window: { minDate: "2026-10-01", maxDate: "2026-12-31" },
        mode: "pending",
      },
    }),
    VisaNoDatesAvailableError,
  );
  assert.deepEqual(calls, ["first"]);
});

test("scan requests fail fast and lookups get one quick retry", async () => {
  const seen = {};
  const client = {
    async getFirstAvailableMonth(_context, options) {
      seen.first = options;
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates(_context, _range, options) {
      seen.dates = options;
      return ["2026-10-10"];
    },
    async getAvailableTimeSlots(_context, _request, options) {
      seen.slots = options;
      return [usableSlot("2026-10-10")];
    },
  };
  const scanStats = createScanStats();
  await findDateAndSlot({
    client,
    context,
    scanStats,
    preferences: {
      window: { minDate: "2026-10-01", maxDate: "2026-10-31" },
      mode: "pending",
    },
  });
  assert.equal(seen.first.maxAttempts, 1);
  assert.equal(seen.dates.maxAttempts, 2);
  assert.deepEqual(seen.dates.retryDelaysMs, [150]);
  assert.deepEqual(seen.slots.retryDelaysMs, [150]);
  assert.equal(scanStats.stats.scans, 1);
  assert.equal(scanStats.stats.lastFirstAvailableDate, "2026-10-01");
});

function huntClient({ conflictSlotIds }) {
  const submitted = [];
  return {
    submitted,
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates() {
      return ["2026-10-10", "2026-10-12"];
    },
    async getAvailableTimeSlots(_context, request) {
      return [usableSlot(request.slotDate, "08:00")];
    },
    async submitPendingAppointment(payload) {
      submitted.push(payload.slotId);
      if (conflictSlotIds.includes(payload.slotId)) {
        throw new VisaSlotConflictError("slot conflict", { status: 409 });
      }
      return [{ ...payload, appointmentStatus: "SCHEDULED" }];
    },
    async searchCurrentAppointments() {
      return [];
    },
  };
}

test("a 409 immediately books the next different slot without rescanning", async () => {
  const client = huntClient({ conflictSlotIds: ["slot-2026-10-10-08:00"] });
  const scanStats = createScanStats();
  await runApiHuntCycle({ client, context, scanStats });
  assert.deepEqual(client.submitted, [
    "slot-2026-10-10-08:00",
    "slot-2026-10-12-08:00",
  ]);
  assert.equal(scanStats.stats.conflicts, 1);
  assert.equal(scanStats.stats.fallbackAttempts, 1);
});

test("when every candidate conflicts the conflict is raised and no slot is sent twice", async () => {
  const client = huntClient({
    conflictSlotIds: ["slot-2026-10-10-08:00", "slot-2026-10-12-08:00"],
  });
  await assert.rejects(
    runApiHuntCycle({ client, context, scanStats: createScanStats() }),
    VisaSlotConflictError,
  );
  assert.equal(new Set(client.submitted).size, client.submitted.length);
  assert.equal(client.submitted.length, 2);
});

test("fetch transport sends browser cookies and mirrors Set-Cookie back", async () => {
  const added = [];
  const browserContext = {
    async cookies() {
      return [
        { name: "SESSION", value: "abc" },
        { name: "XSRF", value: "def" },
      ];
    },
    async addCookies(cookies) {
      added.push(...cookies);
    },
  };
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ present: true, date: "2026-10-01" }), {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "SESSION=xyz; Path=/; Secure; HttpOnly; SameSite=Lax"],
      ],
    });
  };
  const client = new VisaApiClient({
    context: browserContext,
    auth: { authorizationHeader: "Bearer token" },
    readTransport: "fetch",
    fetchImpl,
  });

  const body = await client.getFirstAvailableMonth({ applicationId: "app-1" });
  assert.deepEqual(body, { present: true, date: "2026-10-01" });
  assert.equal(sent.init.headers.Cookie, "SESSION=abc; XSRF=def");
  assert.equal(sent.init.headers.Authorization, "Bearer token");
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "SESSION");
  assert.equal(added[0].value, "xyz");
  assert.equal(added[0].sameSite, "Lax");
});

test("a fetch timeout is reported as a retryable platform failure", async () => {
  const client = new VisaApiClient({
    context: { async cookies() { return []; }, async addCookies() {} },
    auth: {},
    readTransport: "fetch",
    fetchImpl: async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  });
  await assert.rejects(
    client.getFirstAvailableMonth({}, { maxAttempts: 1, timeoutMs: 250 }),
    (error) => error.name === "VisaPlatformUnavailableError",
  );
});

test("parseSetCookie reads domain, path, expiry and flags", () => {
  const cookie = parseSetCookie(
    "token=v1; Domain=.usvisaappt.com; Path=/api; Max-Age=60; Secure",
    "https://www.usvisaappt.com/x",
  );
  assert.equal(cookie.domain, ".usvisaappt.com");
  assert.equal(cookie.path, "/api");
  assert.equal(cookie.secure, true);
  assert.ok(cookie.expires > Date.now() / 1000);
  assert.equal(parseSetCookie("invalid", "https://a.test/"), null);
});
