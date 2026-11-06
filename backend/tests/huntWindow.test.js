const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createHuntWindow,
  HUNT_WINDOW_MS,
  HuntWindowExpiredError,
  createResumeGate,
} = require("../src/services/visaApi/huntWindow");
const {
  VisaApiClient,
  VisaBookingVerificationError,
  mapInBatches,
} = require("../src/services/visaApi");
const { submitAndVerify } = require("../main/api-worker");

function clock() {
  let now = 100;
  const waits = [];
  const window = createHuntWindow({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  window.start();
  return {
    window,
    waits,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("one hour includes retry waits and does not renew until explicitly started", async () => {
  const { window, waits, advance } = clock();
  advance(HUNT_WINDOW_MS - 20);
  await window.wait(60000);
  assert.deepEqual(waits, [20]);
  assert.throws(() => window.assertOpen(), HuntWindowExpiredError);
  advance(15 * 60 * 1000);
  assert.equal(window.remaining(), 0);
  window.start();
  assert.equal(window.remaining(), HUNT_WINDOW_MS);
});

test("availability retries stop at the deadline and verification reads remain allowed", async () => {
  const { window, waits, advance } = clock();
  advance(HUNT_WINDOW_MS - 10);
  let calls = 0;
  const client = new VisaApiClient({ huntWindow: window });
  client._send = async () => {
    calls++;
    return { status: 503, headers: () => ({}), text: async () => "{}" };
  };
  await assert.rejects(
    client.getFirstAvailableMonth({}),
    HuntWindowExpiredError,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, [10]);
  client._send = async () => ({
    status: 200,
    headers: () => ({}),
    text: async () => "[]",
  });
  assert.deepEqual(await client.searchCurrentAppointments("application"), []);
});

test("expiry during cookie retrieval blocks the direct availability request", async () => {
  const { window, advance } = clock();
  const client = new VisaApiClient({
    huntWindow: window,
    readTransport: "fetch",
    context: {
      cookies: async () => {
        advance(HUNT_WINDOW_MS);
        return [];
      },
    },
    fetchImpl: async () =>
      assert.fail("No request may be dispatched after expiry"),
  });
  await assert.rejects(
    client.getFirstAvailableMonth({}),
    HuntWindowExpiredError,
  );
});

test("expiry during final auth refresh blocks page mutation before dispatch", async () => {
  const { window, advance } = clock();
  const client = new VisaApiClient({
    huntWindow: window,
    finalMutationInPage: true,
    page: { evaluate: () => assert.fail("Must not submit") },
  });
  client.refreshAuthFromPage = async () => advance(HUNT_WINDOW_MS);
  await assert.rejects(
    client.submitPendingAppointment({}),
    HuntWindowExpiredError,
  );
});

const submission = {
  context: {
    appointment: {
      applicantId: "a",
      applicationId: "app",
      appointmentId: "appt",
      appointmentLocationType: "POST",
      postUserId: "483",
    },
  },
  selectedDate: "2026-12-02",
  selectedSlot: {
    slotId: "slot",
    slotStatus: "UNBOOKED",
    status: "A",
    startTime: "2026-12-02T09:30:00.000Z",
  },
};

test("expiry before submission sends neither mutation nor verification", async () => {
  const { window, advance } = clock();
  advance(HUNT_WINDOW_MS);
  await assert.rejects(
    submitAndVerify({
      ...submission,
      client: {
        huntWindow: window,
        submitPendingAppointment: () => assert.fail("Must not submit"),
        searchCurrentAppointments: () =>
          assert.fail("Must not verify an unsent request"),
      },
    }),
    HuntWindowExpiredError,
  );
});

test("an in-flight ambiguous submission finishes verification after expiry without replay", async () => {
  const { window, advance } = clock();
  let writes = 0;
  let reads = 0;
  await assert.rejects(
    submitAndVerify({
      ...submission,
      client: {
        huntWindow: window,
        submitPendingAppointment: async () => {
          writes++;
          advance(HUNT_WINDOW_MS);
          throw new Error("socket closed");
        },
        searchCurrentAppointments: async () => {
          reads++;
          return [];
        },
      },
    }),
    VisaBookingVerificationError,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test("parallel lookups drain siblings before a window-expiry error propagates", async () => {
  let finish;
  let rejected = false;
  const sibling = new Promise((resolve) => {
    finish = resolve;
  });
  const lookup = mapInBatches([1, 2], 2, async (id) => {
    if (id === 1) throw new HuntWindowExpiredError();
    await sibling;
  }).catch((error) => {
    rejected = true;
    throw error;
  });
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  finish();
  await assert.rejects(lookup, HuntWindowExpiredError);
});

test("resume gate waits for its matching grant and ignores duplicates and stale grants", async () => {
  const channel = new EventEmitter();
  channel.send = (message) =>
    channel.emit("message", {
      type: "hunt_resume_granted",
      requestId: message.requestId,
    });
  const page = new EventEmitter();
  const gate = createResumeGate(channel);
  await gate.request(page);
  let sent;
  channel.send = (message) => {
    sent = message;
  };
  let admitted = false;
  const pending = gate.request(page).then(() => {
    admitted = true;
  });
  channel.emit("message", { type: "hunt_resume_granted", requestId: 1 });
  await new Promise(setImmediate);
  assert.equal(admitted, false);
  channel.emit("message", {
    type: "hunt_resume_granted",
    requestId: sent.requestId,
  });
  await pending;
  assert.equal(page.listenerCount("close"), 0);
  assert.equal(channel.listenerCount("message"), 0);
});

for (const event of ["close", "disconnect"]) {
  test(`resume wait cleans up on ${event}`, async () => {
    const channel = new EventEmitter();
    channel.send = () => {};
    const page = new EventEmitter();
    const pending = createResumeGate(channel).request(page);
    const rejected = assert.rejects(pending, /closed|disconnected/);
    (event === "close" ? page : channel).emit(event);
    await rejected;
    assert.equal(channel.listenerCount("message"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });
}

test("a confirmed in-flight booking remains successful when the hour ends during submission", async () => {
  const { window, advance } = clock();
  let writes = 0;
  const result = await submitAndVerify({
    ...submission,
    client: {
      huntWindow: window,
      submitPendingAppointment: async (payload) => {
        writes++;
        advance(HUNT_WINDOW_MS);
        return { ...payload, appointmentStatus: "SCHEDULED" };
      },
      searchCurrentAppointments: () =>
        assert.fail("Confirmed response needs no fallback"),
    },
  });
  assert.ok(result.appointment);
  assert.equal(writes, 1);
  assert.equal(window.expired(), true);
});

test("stale authentication at queue admission returns to login without hunting", async () => {
  const { validateQueuedAuthentication } = require("../main/api-worker");
  const { VisaApiUnauthorizedError } = require("../src/services/visaApi");
  let probes = 0;
  const client = {
    auth: {},
    getAuthenticatedUser: async () => {
      probes++;
    },
  };
  assert.equal(await validateQueuedAuthentication(client, () => true), false);
  assert.equal(probes, 0);
  client.getAuthenticatedUser = async () => {
    throw new VisaApiUnauthorizedError("expired");
  };
  assert.equal(await validateQueuedAuthentication(client, () => false), false);
  client.getAuthenticatedUser = async () => {
    probes++;
  };
  assert.equal(await validateQueuedAuthentication(client, () => false), true);
  let checks = 0;
  assert.equal(
    await validateQueuedAuthentication(client, () => ++checks > 1),
    false,
  );
});

test("hourly manual login waits past fifteen minutes without clicking Sign In", async (t) => {
  const { waitForLoginOrDashboard } = require("../main/api-worker");
  let time = 0;
  let waits = 0;
  let url = "https://portal.test/login";
  const intent = { submitted: false };
  t.mock.method(Date, "now", () => time);
  const page = {
    isClosed: () => false,
    url: () => url,
    locator: () => assert.fail("Hourly renewal must not auto-submit login"),
    getByText: () => ({ isVisible: async () => false }),
    waitForTimeout: async () => {
      time += 16 * 60 * 1000;
      if (++waits === 2) {
        intent.submitted = true;
        url = "https://portal.test/dashboard";
      }
    },
  };
  await waitForLoginOrDashboard(page, Infinity, { manual: true, intent });
  assert.equal(waits, 2);
  assert.equal(time, 32 * 60 * 1000);
});

test("resume gate rejects an already closed browser without queueing it", async () => {
  const channel = new EventEmitter();
  channel.send = () => assert.fail("Closed browsers cannot enter the queue");
  const page = new EventEmitter();
  page.isClosed = () => true;
  await assert.rejects(createResumeGate(channel).request(page), /closed/);
  assert.equal(channel.listenerCount("message"), 0);
});
