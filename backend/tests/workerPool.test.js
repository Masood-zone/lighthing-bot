const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.VISA_SECRET_KEY = "test-secret-for-worker-pool";

const { SessionStore } = require("../src/store/sessionStore");
const { WorkerPool } = require("../src/queue/workerPool");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lightingbot-test-"));
}

test("worker pool rejects a second queued session for the same booking account", () => {
  const dataDir = makeTempDir();
  const store = new SessionStore({ dataDir });
  const pool = new WorkerPool({
    store,
    maxConcurrent: 1,
    workerEntry: path.join(dataDir, "noop-worker.js"),
    baseDir: dataDir,
    profilesDir: path.join(dataDir, "profiles"),
  });
  pool._tick = () => {};

  const first = store.createSession({
    loginUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    email: "same@example.com",
    password: "secret",
    displayName: "Same User",
    pickupPoint: "Accra",
    headless: true,
    reschedule: false,
  });

  const second = store.createSession({
    loginUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    email: "same@example.com",
    password: "secret",
    displayName: "Same User 2",
    pickupPoint: "Accra",
    headless: true,
    reschedule: true,
  });

  assert.deepEqual(pool.enqueue(first.id), { queued: true, id: first.id });

  const duplicate = pool.enqueue(second.id);
  assert.equal(duplicate.duplicateAccount, true);
  assert.equal(duplicate.existingSessionId, first.id);

  pool.stop(first.id);
  assert.deepEqual(pool.enqueue(second.id), { queued: true, id: second.id });
});
