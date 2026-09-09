const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findDateAndSlot,
  isPerfTraceEnabled,
  submitAndVerify,
} = require("../main/api-worker");
const {
  buildMonthScanPlan,
  VisaNoDatesAvailableError,
  VisaNoSlotsAvailableError,
  VisaBookingVerificationError,
  VisaSlotConflictError,
} = require("../src/services/visaApi");

const context = {
  availability: { applicationId: "app-1" },
  appointment: { appointmentDt: "2026-11-04T00:00:00.000Z" },
};

function usableSlot(date, id = "slot-1") {
  return {
    slotId: id,
    slotStatus: "UNBOOKED",
    status: "A",
    startTime: `${date}T09:30:00.000Z`,
  };
}

test("performance tracing is enabled only by VISA_PERF_TRACE=1", () => {
  assert.equal(isPerfTraceEnabled("1"), true);
  assert.equal(isPerfTraceEnabled("true"), false);
  assert.equal(isPerfTraceEnabled(undefined), false);
});

test("month scan plan is chronological and clipped to the configured window", () => {
  assert.deepEqual(
    buildMonthScanPlan({
      firstAvailableDate: "2026-09-10",
      minDate: "2026-10-12",
      maxDate: "2026-12-08",
    }),
    [
      { fromDate: "2026-10-12", toDate: "2026-10-31" },
      { fromDate: "2026-11-01", toDate: "2026-11-30" },
      { fromDate: "2026-12-01", toDate: "2026-12-08" },
    ],
  );
});

test("month scan plan treats the platform date as a month boundary", () => {
  assert.deepEqual(
    buildMonthScanPlan({
      firstAvailableDate: "2026-10-15",
      maxDate: "2026-10-31",
    }),
    [{ fromDate: "2026-10-01", toDate: "2026-10-31" }],
  );
});

test("API hunt checks months and dates sequentially until a later month succeeds", async () => {
  const calls = [];
  const client = {
    async getFirstAvailableMonth() {
      calls.push("first");
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates(_context, range) {
      calls.push(`dates:${range.fromDate}`);
      if (range.fromDate.startsWith("2026-10")) return [];
      if (range.fromDate.startsWith("2026-11")) return ["2026-11-04", "2026-11-08"];
      return ["2026-12-02"];
    },
    async getAvailableTimeSlots(_context, request) {
      calls.push(
        `slots:${request.slotDate}:${request.fromDate}:${request.toDate}`,
      );
      return request.slotDate === "2026-12-02"
        ? [usableSlot(request.slotDate)]
        : [];
    },
  };

  const result = await findDateAndSlot({
    client,
    context,
    preferences: {
      window: { minDate: "2026-10-01", maxDate: "2026-12-31" },
      mode: "pending",
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

test("API hunt preserves exact-date next-available fallback", async () => {
  const client = {
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableDates() {
      return ["2026-10-10", "2026-10-15"];
    },
    async getAvailableTimeSlots(_context, request) {
      return [usableSlot(request.slotDate)];
    },
  };

  const result = await findDateAndSlot({
    client,
    context,
    preferences: {
      window: { minDate: "2026-10-01", maxDate: "2026-10-31" },
      exactDate: "2026-10-12",
      exactDateFallback: "NEXT_AVAILABLE",
      mode: "pending",
    },
  });
  assert.equal(result.selectedDate, "2026-10-15");
});

test("API hunt excludes the current appointment during reschedule", async () => {
  const client = {
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-11-01" };
    },
    async getAvailableDates() {
      return ["2026-11-04", "2026-11-08"];
    },
    async getAvailableTimeSlots(_context, request) {
      return [usableSlot(request.slotDate)];
    },
  };
  const result = await findDateAndSlot({
    client,
    context,
    preferences: {
      window: { minDate: "2026-11-01", maxDate: "2026-11-30" },
      mode: "reschedule",
      allowSameDateReschedule: false,
    },
  });
  assert.equal(result.selectedDate, "2026-11-08");
});

test("API hunt distinguishes no dates from dates without usable slots", async () => {
  const baseClient = {
    async getFirstAvailableMonth() {
      return { present: true, date: "2026-10-01" };
    },
    async getAvailableTimeSlots() {
      return [];
    },
  };
  const preferences = {
    window: { minDate: "2026-10-01", maxDate: "2026-10-31" },
    mode: "pending",
  };

  await assert.rejects(
    findDateAndSlot({
      client: { ...baseClient, async getAvailableDates() { return []; } },
      context,
      preferences,
    }),
    VisaNoDatesAvailableError,
  );
  await assert.rejects(
    findDateAndSlot({
      client: {
        ...baseClient,
        async getAvailableDates() { return ["2026-10-12"]; },
      },
      context,
      preferences,
    }),
    VisaNoSlotsAvailableError,
  );
});

test("ambiguous final mutation is not replayed after read-only verification", async () => {
  let mutationCalls = 0;
  let verificationCalls = 0;
  const client = {
    async submitPendingAppointment() {
      mutationCalls += 1;
      throw new Error("socket closed after request write");
    },
    async searchCurrentAppointments() {
      verificationCalls += 1;
      return [];
    },
  };
  const submissionContext = {
    appointment: {
      applicantId: "applicant-1",
      applicationId: "application-1",
      appointmentId: "appointment-1",
      appointmentLocationType: "POST",
      postUserId: "483",
    },
  };

  await assert.rejects(
    submitAndVerify({
      client,
      context: submissionContext,
      selectedDate: "2026-12-02",
      selectedSlot: usableSlot("2026-12-02"),
    }),
    VisaBookingVerificationError,
  );
  assert.equal(mutationCalls, 1);
  assert.equal(verificationCalls, 1);
});

test("a confirmed slot conflict is returned for a fresh availability scan", async () => {
  let verificationCalls = 0;
  const client = {
    async submitPendingAppointment() {
      throw new VisaSlotConflictError("slot conflict", { status: 409 });
    },
    async searchCurrentAppointments() {
      verificationCalls += 1;
      return [];
    },
  };
  const submissionContext = {
    appointment: {
      applicantId: "applicant-1",
      applicationId: "application-1",
      appointmentId: "appointment-1",
      appointmentLocationType: "POST",
      postUserId: "483",
    },
  };

  await assert.rejects(
    submitAndVerify({
      client,
      context: submissionContext,
      selectedDate: "2026-12-02",
      selectedSlot: usableSlot("2026-12-02"),
    }),
    VisaSlotConflictError,
  );
  assert.equal(verificationCalls, 0);
});
