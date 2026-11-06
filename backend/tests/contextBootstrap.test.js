const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  bootstrapAppointmentSurface,
} = require("../src/services/visaApi/contextBootstrap");
const {
  createBootstrapBudget,
} = require("../src/services/visaApi/bootstrapBudget");
const {
  VisaPlatformUnavailableError,
} = require("../src/services/visaApi/errors");

const record = {
  applicationId: "app",
  applicantId: "person",
  appointmentId: "appointment",
  visaType: "NIV",
  visaClass: "F1",
  appointmentLocationType: "POST",
  appointmentStatus: "NEW",
};
function fixture({
  visible = true,
  clickError = false,
  responseStatus = 200,
  text = async () => JSON.stringify([record]),
  respond = true,
  beforeClick = () => {},
} = {}) {
  const page = new EventEmitter();
  const events = [];
  let clicks = 0;
  const response = {
    url: () => "https://portal.test/visaappointmentapi/appointments/search",
    status: () => responseStatus,
    text,
  };
  const candidate = {
    first() {
      return this;
    },
    isVisible: async () => visible,
    click: async () => {
      clicks++;
      beforeClick();
      if (clickError) throw new Error("not actionable");
      if (respond) page.emit("response", response);
    },
  };
  page.getByRole = () => candidate;
  page.getByText = () => candidate;
  page.url = () => "https://portal.test/visaapplicantui/dashboard";
  return {
    page,
    events,
    run: (options = {}) =>
      bootstrapAppointmentSurface({
        page,
        mode: "pending",
        appBaseUrl: "https://portal.test/visaapplicantui",
        timeoutMs: 2000,
        status: (state, message) => events.push({ state, message }),
        ...options,
      }),
    clicks: () => clicks,
  };
}

test("missing pending control fails before waiting for a response and detaches its listener", async () => {
  const f = fixture({ visible: false });
  await assert.rejects(
    f.run(),
    (error) => error.bootstrapOutcome === "CONTROL_MISSING",
  );
  assert.equal(f.clicks(), 0);
  assert.equal(f.page.listenerCount("response"), 0);
  assert.equal(f.events.at(-1).state, "CONTEXT_BOOTSTRAP_CONTROL_MISSING");
});
test("a failed pending click is not reported as a successful navigation", async () => {
  const f = fixture({ clickError: true });
  await assert.rejects(
    f.run(),
    (error) => error.bootstrapOutcome === "CONTROL_MISSING",
  );
  assert.equal(f.page.listenerCount("response"), 0);
});
test("bootstrap awaits the body instead of assuming capture finishes in 150ms", async () => {
  let release;
  let complete = false;
  const body = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ text: () => body });
  const pending = f.run().then((result) => {
    complete = true;
    return result;
  });
  await new Promise(setImmediate);
  assert.equal(complete, false);
  release(JSON.stringify([record]));
  const result = await pending;
  assert.equal(result.outcome, "READY");
  assert.deepEqual(result.body, [record]);
  assert.equal(f.page.listenerCount("response"), 0);
});
test("HTTP 500 bootstrap responses preserve platform failure classification for backoff", async () => {
  const f = fixture({ responseStatus: 500 });
  await assert.rejects(
    f.run(),
    (error) =>
      error instanceof VisaPlatformUnavailableError &&
      error.status === 500 &&
      error.bootstrapOutcome === "HTTP_FAILURE",
  );
  assert.equal(f.events.at(-1).state, "CONTEXT_BOOTSTRAP_HTTP_FAILURE");
});
for (const body of ["not json", "{}", "[null]"]) {
  test(`invalid response ${body} is distinguished from a timeout`, async () => {
    const f = fixture({ text: async () => body });
    await assert.rejects(
      f.run(),
      (error) => error.bootstrapOutcome === "INVALID_RESPONSE",
    );
    assert.equal(f.events.at(-1).state, "CONTEXT_BOOTSTRAP_INVALID_RESPONSE");
  });
}
test("incomplete records never become ready context", async () => {
  const f = fixture({
    text: async () => JSON.stringify([{ applicationId: "app" }]),
  });
  const result = await f.run();
  assert.equal(result.outcome, "INCOMPLETE_CONTEXT");
  assert.ok(result.missingFields.includes("appointmentId"));
});
test("navigation consumes the same budget as the response wait", async () => {
  let now = 0;
  const f = fixture({
    respond: false,
    beforeClick: () => {
      now = 1001;
    },
  });
  await assert.rejects(
    f.run({ timeoutMs: 1000, now: () => now }),
    (error) => error.bootstrapOutcome === "TIMEOUT",
  );
  assert.equal(f.page.listenerCount("response"), 0);
});
test("response body parsing is bounded by the attempt deadline", async () => {
  const f = fixture({ text: () => new Promise(() => {}) });
  await assert.rejects(
    f.run({ timeoutMs: 25 }),
    (error) => error.bootstrapOutcome === "TIMEOUT",
  );
  assert.equal(f.page.listenerCount("response"), 0);
});
test("deadline budget prevents later browser work after it is closed", async () => {
  let now = 0;
  const budget = createBootstrapBudget(1000, () => now);
  now = 600;
  assert.equal(budget.remaining(), 400);
  budget.close();
  let called = false;
  await assert.rejects(
    budget.run(() => {
      called = true;
    }),
    (error) => error.bootstrapOutcome === "TIMEOUT",
  );
  assert.equal(called, false);
});
test("parsed browser records resolve API context before the asynchronous network listener finishes", async () => {
  const { resolveContext } = require("../main/api-worker");
  const f = fixture();
  const client = {
    getAuthenticatedUser: async () => ({
      applicationId: "app",
      applicantId: "person",
    }),
    getUserHistoryApplicantPaymentStatus: async () => null,
    searchCurrentAppointments: async () =>
      assert.fail("No extra search is needed for a complete browser response"),
  };
  const result = await resolveContext({
    client,
    page: f.page,
    networkState: { requests: [], responses: [] },
    bootstrapCache: {
      user: null,
      history: null,
      historyAttempted: false,
      browserAttemptedAt: 0,
    },
  });
  assert.equal(result.appointment.appointmentId, "appointment");
  assert.equal(result.source, "captured_appointments_search");
});
