const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDateWindow,
  monthRangeFor,
  buildMonthScanPlan,
  currentMonthRange,
  selectAvailableDate,
  selectEarliestUsableSlot,
  formatAppointmentTime,
  buildAppointmentPayload,
  buildAvailabilityContext,
  resolveApplicantContext,
  appointmentMatchesSubmission,
  redact,
  decodeJwtExp,
  VisaApiClient,
  VisaApplicationNotFoundError,
  VisaNoDatesAvailableError,
  VisaNoSlotsAvailableError,
  VisaSlotConflictError,
  VisaBookingVerificationError,
  bootstrapAppointmentSurface,
  shouldRunContextBootstrap,
} = require("../src/services/visaApi");

function appointmentRecord(overrides = {}) {
  return {
    applicationId: "application-1",
    applicantId: "applicant-1",
    appointmentId: "appointment-1",
    appointmentLocationType: "POST",
    appointmentStatus: "NEW",
    visaType: "NIV",
    visaClass: "F1",
    ...overrides,
  };
}

test("date selector returns no selection for empty date arrays", () => {
  const result = selectAvailableDate({
    availableDates: [],
    minDate: "2027-06-01",
    maxDate: "2027-06-30",
  });

  assert.equal(result.selectedDate, null);
  assert.equal(result.reason, "no_dates_inside_window");
});

test("date selector chooses earliest acceptable range date", () => {
  const result = selectAvailableDate({
    availableDates: [
      "2027-06-24T00:00:00.000+00:00",
      "2027-06-03T00:00:00.000+00:00",
      "2027-06-10T00:00:00.000+00:00",
    ],
    minDate: "2027-06-05",
    maxDate: "2027-06-30",
  });

  assert.equal(result.selectedDate, "2027-06-10");
});

test("exact date defaults to exact-only behavior", () => {
  const result = selectAvailableDate({
    availableDates: ["2027-06-10T00:00:00.000+00:00"],
    exactDate: "2027-06-03",
    fallbackStrategy: "EXACT_ONLY",
  });

  assert.equal(result.selectedDate, null);
  assert.equal(result.reason, "exact_date_unavailable");
});

test("days-from-now preferences are frozen from a supplied clock", () => {
  const window = computeDateWindow({
    daysFromNowMin: 2,
    daysFromNowMax: 5,
    now: new Date("2026-06-14T18:00:00.000Z"),
  });

  assert.deepEqual(window, {
    minDate: "2026-06-16",
    maxDate: "2026-06-19",
    source: "days",
  });
});

test("slot-time lookup range uses the current month window", () => {
  assert.deepEqual(currentMonthRange(new Date("2026-06-14T12:00:00.000Z")), {
    fromDate: "2026-06-14",
    toDate: "2026-06-30",
  });
});

test("exact-date next-available fallback retains chronological selection", () => {
  const result = selectAvailableDate({
    availableDates: ["2027-06-20", "2027-06-05", "2027-06-12"],
    exactDate: "2027-06-10",
    fallbackStrategy: "NEXT_AVAILABLE",
  });

  assert.equal(result.selectedDate, "2027-06-12");
});

test("reschedule selection filters the current appointment unless allowed", () => {
  const input = {
    availableDates: ["2027-06-10", "2027-06-12"],
    currentAppointmentDate: "2027-06-10",
    mode: "reschedule",
  };

  assert.equal(selectAvailableDate(input).selectedDate, "2027-06-12");
  assert.equal(
    selectAvailableDate({ ...input, allowSameDateReschedule: true }).selectedDate,
    "2027-06-10",
  );
});

test("slot-time lookup range follows a future selected appointment month", () => {
  const systemNow = new Date("2026-09-18T12:00:00.000Z");
  assert.deepEqual(currentMonthRange(systemNow), {
    fromDate: "2026-09-18",
    toDate: "2026-09-30",
  });
  assert.deepEqual(monthRangeFor("2026-11-14"), {
    fromDate: "2026-11-01",
    toDate: "2026-11-30",
  });
});

test("month scan plan is chronological and clipped to the configured window", () => {
  assert.deepEqual(
    buildMonthScanPlan({
      firstAvailableDate: "2026-10-12",
      minDate: "2026-10-15",
      maxDate: "2026-12-20",
    }),
    [
      { fromDate: "2026-10-15", toDate: "2026-10-31" },
      { fromDate: "2026-11-01", toDate: "2026-11-30" },
      { fromDate: "2026-12-01", toDate: "2026-12-20" },
    ],
  );
});

test("first available date is treated as a month marker", () => {
  assert.deepEqual(
    buildMonthScanPlan({ firstAvailableDate: "2026-10-15" }),
    [{ fromDate: "2026-10-01", toDate: "2026-10-31" }],
  );
  assert.deepEqual(
    buildMonthScanPlan({
      firstAvailableDate: "2026-10-15",
      minDate: "2026-10-20",
      maxDate: "2026-10-25",
    }),
    [{ fromDate: "2026-10-20", toDate: "2026-10-25" }],
  );
});

test("API hunt scans months and dates sequentially until a later month succeeds", async () => {
  const calls = [];
  const { findDateAndSlot } = require("../main/api-worker");
  const client = {
    async getFirstAvailableMonth() {
      calls.push("first");
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates(_context, range) {
      calls.push(`dates:${range.fromDate}`);
      if (range.fromDate.startsWith("2026-10")) return [];
      if (range.fromDate.startsWith("2026-11")) {
        return ["2026-11-08T00:00:00Z", "2026-11-04T00:00:00Z"];
      }
      return ["2026-12-02T00:00:00Z"];
    },
    async getAvailableTimeSlots(_context, { slotDate, fromDate, toDate }) {
      calls.push(`slots:${slotDate}:${fromDate}:${toDate}`);
      if (slotDate !== "2026-12-02") return [];
      return [{
        slotId: "slot-1",
        slotStatus: "UNBOOKED",
        status: "A",
        startTime: "2026-12-02T09:30:00.000Z",
      }];
    },
  };
  const result = await findDateAndSlot({
    client,
    context: { availability: {}, appointment: {} },
    preferences: {
      window: {
        minDate: "2026-10-01",
        maxDate: "2026-12-31",
        source: "absolute",
      },
    },
  });

  assert.equal(result.selectedDate, "2026-12-02");
  assert.deepEqual(calls, [
    "first",
    "dates:2026-10-01",
    "dates:2026-11-01",
    "slots:2026-11-04:2026-11-01:2026-11-30",
    "slots:2026-11-08:2026-11-01:2026-11-30",
    "dates:2026-12-01",
    "slots:2026-12-02:2026-12-01:2026-12-31",
  ]);
});

test("API hunt distinguishes no acceptable dates from dates without slots", async () => {
  const { findDateAndSlot } = require("../main/api-worker");
  const context = { availability: {}, appointment: {} };
  const dateWindow = {
    minDate: "2026-10-01",
    maxDate: "2026-10-31",
    source: "absolute",
  };
  const baseClient = {
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableTimeSlots() {
      return [];
    },
  };

  await assert.rejects(
    findDateAndSlot({
      client: { ...baseClient, async getAvailableDates() { return []; } },
      context,
    preferences: { window: dateWindow },
    }),
    VisaNoDatesAvailableError,
  );
  await assert.rejects(
    findDateAndSlot({
      client: {
        ...baseClient,
        async getAvailableDates() { return ["2026-10-04"]; },
      },
      context,
    preferences: { window: dateWindow },
    }),
    VisaNoSlotsAvailableError,
  );
});

test("API hunt ignores dates returned outside the active month range", async () => {
  const calls = [];
  const { findDateAndSlot } = require("../main/api-worker");
  const result = await findDateAndSlot({
    client: {
      async getFirstAvailableMonth() {
        return { present: true, date: "2026-10-01" };
      },
      async getAvailableDates(_context, range) {
        calls.push(`dates:${range.fromDate}`);
        return range.fromDate.startsWith("2026-10")
          ? ["2026-12-01"]
          : ["2026-11-03"];
      },
      async getAvailableTimeSlots(_context, { slotDate }) {
        calls.push(`slots:${slotDate}`);
        return [{
          slotId: "slot-3",
          slotStatus: "UNBOOKED",
          status: "A",
          startTime: `${slotDate}T08:00:00.000Z`,
        }];
      },
    },
    context: { availability: {}, appointment: {} },
    preferences: {
      window: {
        minDate: "2026-10-01",
        maxDate: "2026-11-30",
        source: "absolute",
      },
    },
  });

  assert.equal(result.selectedDate, "2026-11-03");
  assert.deepEqual(calls, [
    "dates:2026-10-01",
    "dates:2026-11-01",
    "slots:2026-11-03",
  ]);
});

test("ambiguous final mutation is attempted once before read-only verification", async () => {
  const { submitAndVerify } = require("../main/api-worker");
  let mutationCalls = 0;
  let verificationCalls = 0;
  const selectedSlot = {
    slotId: "slot-1",
    slotStatus: "UNBOOKED",
    status: "A",
    startTime: "2027-06-10T10:00:00.000Z",
  };

  await assert.rejects(
    submitAndVerify({
      client: {
        async submitPendingAppointment() {
          mutationCalls += 1;
          throw new Error("network outcome unknown");
        },
        async searchCurrentAppointments() {
          verificationCalls += 1;
          return [];
        },
      },
      context: {
        appointment: {
          applicantId: "applicant-1",
          applicationId: "application-1",
          appointmentId: "appointment-1",
          appointmentLocationType: "POST",
          postUserId: "483",
        },
      },
      selectedDate: "2027-06-10",
      selectedSlot,
    }),
    VisaBookingVerificationError,
  );

  assert.equal(mutationCalls, 1);
  assert.equal(verificationCalls, 1);
});

test("slot selector skips unusable slots and chooses earliest usable slot", () => {
  const { selectedSlot } = selectEarliestUsableSlot([
    {
      slotId: "later",
      slotStatus: "UNBOOKED",
      status: "A",
      startTime: "2027-06-10T11:00:00.000+00:00",
    },
    {
      slotId: "booked",
      slotStatus: "BOOKED",
      status: "A",
      startTime: "2027-06-10T09:00:00.000+00:00",
    },
    {
      slotId: "earliest",
      slotStatus: "UNBOOKED",
      status: "A",
      startTime: "2027-06-10T10:00:00.000+00:00",
    },
  ]);

  assert.equal(selectedSlot.slotId, "earliest");
  assert.equal(formatAppointmentTime(selectedSlot.startTime), "10:00 AM");
});

test("booking payload is built from appointment and slot fields", () => {
  const payload = buildAppointmentPayload({
    selectedDate: "2027-06-10",
    selectedSlot: {
      slotId: "slot-1",
      startTime: "2027-06-10T10:00:00.000+00:00",
    },
    appointment: {
      applicantId: "applicant-1",
      applicantUUID: null,
      applicationId: "application-1",
      appointmentId: "appointment-1",
      appointmentLocationType: "POST",
      postUserId: "post-user-1",
    },
  });

  assert.deepEqual(payload, {
    applicantId: "applicant-1",
    applicantUUID: null,
    applicationId: "application-1",
    appointmentDt: "2027-06-10T00:00:00.000+00:00",
    appointmentId: "appointment-1",
    appointmentLocationType: "POST",
    appointmentStatus: "SCHEDULED",
    appointmentTime: "10:00 AM",
    postUserId: "post-user-1",
    slotId: "slot-1",
  });
});

test("availability context can force the selected Accra post user id", () => {
  const context = buildAvailabilityContext(
    {
      postUserId: "old-post",
      applicantId: "applicant-1",
      applicationId: "application-1",
      appointmentLocationType: "POST",
      visaClass: "F1",
      visaType: "NIV",
    },
    { postUserIdOverride: "483" },
  );

  assert.equal(context.postUserId, "483");
});

test("applicant context resolves from bootstrap without appointment search", async () => {
  const context = await resolveApplicantContext({
    mode: "reschedule",
    networkState: {},
    bootstrapData: [
      {
        applicationId: "application-1",
        applicantId: "applicant-1",
        appointmentId: "appointment-1",
        postUserId: 483,
        visaType: "NIV",
        visaClass: "F1",
        appointmentLocationType: "POST",
      },
    ],
  });

  assert.equal(context.source, "synthetic_context_from_bootstrap");
  assert.equal(context.applicationId, "application-1");
  assert.equal(context.applicantId, "applicant-1");
  assert.equal(context.appointment.appointmentId, "appointment-1");
  assert.equal(context.appointment.appointmentStatus, "SCHEDULED");
});

test("pending context resolves from a captured NEW appointment", async () => {
  const context = await resolveApplicantContext({
    mode: "pending",
    networkState: {
      responses: [
        {
          url: "https://www.usvisaappt.com/visaappointmentapi/appointments/search",
          body: [appointmentRecord()],
        },
      ],
    },
    bootstrapData: [],
  });

  assert.equal(context.source, "captured_appointments_search");
  assert.equal(context.appointment.appointmentStatus, "NEW");
});

test("reschedule context resolves from a captured SCHEDULED appointment", async () => {
  const context = await resolveApplicantContext({
    mode: "reschedule",
    networkState: {
      responses: [
        {
          url: "https://www.usvisaappt.com/visaappointmentapi/appointments/search",
          body: [appointmentRecord({ appointmentStatus: "SCHEDULED" })],
        },
      ],
    },
    bootstrapData: [],
  });

  assert.equal(context.appointment.appointmentStatus, "SCHEDULED");
});

test("resolver uses direct appointment search when only applicationId is known", async () => {
  let searchedApplicationId = null;
  const context = await resolveApplicantContext({
    client: {
      async searchCurrentAppointments(applicationId) {
        searchedApplicationId = applicationId;
        return [appointmentRecord()];
      },
    },
    mode: "pending",
    networkState: {},
    bootstrapData: [{ applicationId: "application-1" }],
    allowDirectSearch: true,
  });

  assert.equal(searchedApplicationId, "application-1");
  assert.equal(context.source, "direct_appointments_search");
});

test("resolver rejects incomplete and wrong-status appointment records", async () => {
  await assert.rejects(
    resolveApplicantContext({
      mode: "pending",
      networkState: {
        responses: [
          {
            url: "https://www.usvisaappt.com/visaappointmentapi/appointments/search",
            body: [
              appointmentRecord({
                appointmentId: null,
                appointmentStatus: "SCHEDULED",
              }),
            ],
          },
        ],
      },
      bootstrapData: [],
    }),
    VisaApplicationNotFoundError,
  );
});

test("browser bootstrap opens pending appointment and awaits appointment search", async () => {
  let clicked = false;
  const visibleCandidate = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async evaluate() {
      clicked = true;
    },
  };
  const page = {
    url: () => "https://www.usvisaappt.com/visaapplicantui/dashboard",
    getByRole: () => visibleCandidate,
    getByText: () => visibleCandidate,
    async waitForResponse(predicate) {
      const response = {
        url: () =>
          "https://www.usvisaappt.com/visaappointmentapi/appointments/search",
        status: () => 200,
      };
      assert.equal(predicate(response), true);
      return response;
    },
    async waitForTimeout() {},
  };

  const result = await bootstrapAppointmentSurface({
    page,
    appBaseUrl: "https://www.usvisaappt.com/visaapplicantui",
    mode: "pending",
  });
  assert.equal(clicked, true);
  assert.deepEqual(result, { captured: true, status: 200 });
});

test("browser bootstrap opens reschedule surface before awaiting appointment search", async () => {
  const events = [];
  const calls = {
    goto: [],
    clickedReschedule: false,
    clickedConfirm: false,
  };

  const makeWaitable = (handler = async () => {}) => ({
    first() {
      return this;
    },
    async waitFor(options) {
      return handler(options);
    },
    async isVisible() {
      return true;
    },
    locator() {
      return confirmButton;
    },
  });

  const confirmButton = makeWaitable();
  confirmButton.click = async () => {
    calls.clickedConfirm = true;
    return true;
  };

  const rescheduleButton = makeWaitable();
  const bookingBlock = makeWaitable();
  const dialog = makeWaitable();
  dialog.locator = () => confirmButton;

  const page = {
    async waitForResponse(predicate) {
      const response = {
        url: () =>
          "https://www.usvisaappt.com/visaappointmentapi/appointments/search",
        status: () => 200,
      };
      assert.equal(predicate(response), true);
      return response;
    },
    async goto(url) {
      calls.goto.push(url);
    },
    async waitForURL() {},
    async reload() {},
    async waitForTimeout() {},
    once() {},
    keyboard: { async press() {} },
    locator(selector) {
      if (selector.includes("my-app-button-popup-resch")) {
        return rescheduleButton;
      }
      if (selector.includes("mat-dialog-container")) {
        return dialog;
      }
      return bookingBlock;
    },
    async evaluate() {
      calls.clickedReschedule = true;
      return "RESCHEDULE";
    },
  };

  const result = await bootstrapAppointmentSurface({
    page,
    appBaseUrl: "https://www.usvisaappt.com/visaapplicantui",
    mode: "reschedule",
    userDisplayName: "Route User",
    userEmail: "route@example.com",
    status: (code, message) => events.push({ code, message }),
  });

  assert.deepEqual(result, { captured: true, status: 200 });
  assert.equal(
    calls.goto[0],
    "https://www.usvisaappt.com/visaapplicantui/home/appointment/myappointment",
  );
  assert.equal(calls.clickedReschedule, true);
  assert.equal(calls.clickedConfirm, true);
  assert.deepEqual(
    events.map((event) => event.code),
    ["MY_APPOINTMENTS", "RESCHEDULE_CLICK", "RESCHEDULE_CONFIRM", "BOOKING_WAIT"],
  );
});

test("browser context bootstrap is throttled during unresolved retries", () => {
  const cache = { browserAttemptedAt: 1000 };
  assert.equal(shouldRunContextBootstrap(cache, 2000, 30_000), false);
  assert.equal(shouldRunContextBootstrap(cache, 31_000, 30_000), true);
});

test("read-only search retries a transient 500 but final mutation is single-shot", async () => {
  let searchCalls = 0;
  const makeResponse = (status, body) => ({
    status: () => status,
    headers: () => ({}),
    text: async () => JSON.stringify(body),
  });
  const client = new VisaApiClient({
    context: {
      request: {
        async fetch(url) {
          if (url.includes("/appointments/search")) {
            searchCalls += 1;
            return searchCalls === 1
              ? makeResponse(500, { error: "temporary" })
              : makeResponse(200, [appointmentRecord()]);
          }
          return makeResponse(500, { error: "temporary" });
        },
      },
    },
    page: { evaluate: async () => {} },
    auth: {},
  });

  const records = await client.searchCurrentAppointments("application-1", {
    maxAttempts: 2,
  });
  assert.equal(searchCalls, 2);
  assert.equal(records.length, 1);

  let mutationCalls = 0;
  client.context.request.fetch = async () => {
    mutationCalls += 1;
    return makeResponse(500, { error: "unknown outcome" });
  };
  await assert.rejects(client.submitPendingAppointment({ appointmentId: "1" }));
  assert.equal(mutationCalls, 1);
});

test("fresh pending booking uses the observed PUT contract with page-refreshed auth", async () => {
  const pageRequests = [];
  let evaluateCall = 0;
  const page = {
    async evaluate(_fn, argument) {
      evaluateCall += 1;
      if (evaluateCall === 1) return "fresh-browser-token";
      if (evaluateCall === 2) return "test-agent";
      if (evaluateCall === 3) return "1";
      pageRequests.push(argument);
      return { status: 200, headers: {}, text: "{}" };
    },
    async url() {
      return "https://www.usvisaappt.com/visaapplicantui/home/appointment";
    },
  };
  const client = new VisaApiClient({
    context: { cookies: async () => [] },
    page,
    auth: { platformAuthToken: "stale-token" },
    networkState: {},
    finalMutationInPage: true,
  });

  const payload = { appointmentId: "appointment-1" };
  await client.submitPendingAppointment(payload);

  assert.equal(pageRequests.length, 1);
  assert.equal(pageRequests[0].requestMethod, "PUT");
  assert.equal(pageRequests[0].requestHeaders.Authorization, "Bearer fresh-browser-token");
  assert.deepEqual(pageRequests[0].requestData, [payload]);
});

test("pending and reschedule mutations both send one-item arrays", async () => {
  const requests = [];
  const response = {
    status: () => 200,
    headers: () => ({}),
    text: async () => "{}",
  };
  const client = new VisaApiClient({
    context: {
      request: {
        async fetch(_url, options) {
          requests.push(options);
          return response;
        },
      },
    },
    auth: {},
  });

  await client.submitPendingAppointment({ appointmentId: "pending-1" });
  await client.submitRescheduleAppointment({ appointmentId: "scheduled-1" });

  assert.deepEqual(requests.map(({ method }) => method), ["PUT", "PUT"]);
  assert.deepEqual(requests.map(({ data }) => JSON.parse(data)), [
    [{ appointmentId: "pending-1" }],
    [{ appointmentId: "scheduled-1" }],
  ]);
});

test("HTTP 409 is classified as a slot conflict", async () => {
  const client = new VisaApiClient({
    context: {
      request: {
        async fetch() {
          return {
            status: () => 409,
            headers: () => ({}),
            text: async () => JSON.stringify({
              status: 409,
              httpStatus: "CONFLICT",
              responseMessage: "Appointment booking failed",
            }),
          };
        },
      },
    },
    auth: {},
  });

  await assert.rejects(
    client.submitPendingAppointment({ appointmentId: "appointment-1" }),
    VisaSlotConflictError,
  );
});

test("verification requires scheduled status, identity, date, and time", () => {
  const payload = {
    applicantId: "applicant-1",
    applicationId: "application-1",
    appointmentId: "appointment-1",
    appointmentDt: "2027-06-10T00:00:00.000+00:00",
    appointmentTime: "10:00 AM",
    slotId: "slot-1",
  };

  assert.equal(
    appointmentMatchesSubmission(
      {
        ...payload,
        appointmentStatus: "SCHEDULED",
      },
      payload,
    ),
    true,
  );

  assert.equal(
    appointmentMatchesSubmission(
      {
        ...payload,
        appointmentStatus: "NEW",
      },
      payload,
    ),
    false,
  );

  assert.equal(
    appointmentMatchesSubmission(
      {
        ...payload,
        appointmentStatus: "SCHEDULED",
        slotId: "server-assigned-slot",
      },
      payload,
    ),
    true,
  );
});

test("redaction removes token-like secrets recursively", () => {
  const redacted = redact({
    Authorization: "Bearer eyJabc.def.ghi",
    nested: {
      authToken: "eyJabc.def.ghi",
      safe: "visible",
    },
  });

  assert.equal(redacted.Authorization, "<redacted>");
  assert.equal(redacted.nested.authToken, "<redacted>");
  assert.equal(redacted.nested.safe, "visible");
});

test("JWT exp can be decoded without verifying or logging the token", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1800000000 }))
    .toString("base64url");
  const token = `header.${payload}.signature`;

  assert.equal(decodeJwtExp(token), "2027-01-15T08:00:00.000Z");
});
