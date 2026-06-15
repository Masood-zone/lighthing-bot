const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDateWindow,
  currentMonthRange,
  selectAvailableDate,
  selectEarliestUsableSlot,
  formatAppointmentTime,
  buildAppointmentPayload,
  buildAvailabilityContext,
  appointmentMatchesSubmission,
  redact,
  decodeJwtExp,
} = require("../src/services/visaApi");

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

test("verification requires scheduled status and selected slot fields", () => {
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
