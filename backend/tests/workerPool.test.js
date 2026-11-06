const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.VISA_SECRET_KEY = "test-secret-for-worker-pool";

const { SessionStore } = require("../src/store/sessionStore");
const { WorkerPool, resolveSessionExecutionMode } = require("../src/queue/workerPool");

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

test("session store persists execution mode and defaults missing mode to dom", () => {
  const dataDir = makeTempDir();
  const store = new SessionStore({ dataDir });

  const apiUser = store.createSession({
    loginUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    email: "api@example.com",
    password: "secret",
    displayName: "API User",
    pickupPoint: "Accra",
    headless: true,
    reschedule: true,
    executionMode: "api",
  });

  assert.equal(apiUser.config.executionMode, "api");

  const domUser = store.createSession({
    loginUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    email: "dom@example.com",
    password: "secret",
    displayName: "DOM User",
    pickupPoint: "Accra",
    headless: true,
    reschedule: false,
  });

  assert.equal(domUser.config.executionMode, "dom");

  const updated = store.updateSession(apiUser.id, { executionMode: "dom" });
  assert.equal(updated.config.executionMode, "dom");
});

test("worker pool resolves per-user execution mode with dom as fallback", () => {
  assert.equal(
    resolveSessionExecutionMode({ config: { executionMode: "api" } }),
    "api",
  );
  assert.equal(
    resolveSessionExecutionMode({ config: { executionMode: "dom" } }),
    "dom",
  );
  assert.equal(resolveSessionExecutionMode({ config: {} }), "dom");
});

test("worker pool can update desktop booking alerts without a restart", () => {
  const dataDir = makeTempDir();
  const desktopNotificationService = { enabled: false };
  const pool = new WorkerPool({
    store: new SessionStore({ dataDir }),
    maxConcurrent: 0,
    workerEntry: path.join(dataDir, "noop-worker.js"),
    baseDir: dataDir,
    desktopNotificationService,
    desktopNotificationsEnabled: false,
  });

  assert.equal(pool.setDesktopNotificationsEnabled(true), true);
  assert.equal(desktopNotificationService.enabled, true);
  assert.equal(pool.setDesktopNotificationsEnabled(false), false);
  assert.equal(desktopNotificationService.enabled, false);
});

const { once } = require('node:events');

async function launchProxyFixture(t, { mode = 'auto', results = [] } = {}) {
  const dataDir = makeTempDir();
  const workerEntry = path.join(dataDir, 'probe-worker.js');
  fs.writeFileSync(workerEntry, `process.send({ type: 'probe', proxy: process.env.VISA_PROXY_URL || '', legacy: process.env.VISA_PROXY_SERVER || '', bypass: process.env.VISA_PROXY_BYPASS || '' });`);
  const store = new SessionStore({ dataDir });
  const checked = [];
  const pool = new WorkerPool({ store, maxConcurrent: 1, workerEntry, baseDir: dataDir,
    proxyMode: mode,
    proxyHealthCheck: async (url) => {
      checked.push(url);
      return results.shift() || { ok: false, reason: 'TLS certificate validation failed' };
    },
  });
  pool._tick = () => {};
  pool.proxyPool = ['http://static.test:8080'];
  pool.proxyFallback = 'http://fallback.test:8080';
  let selections = 0;
  pool.proxy11Rotator.acquire = async () => {
    selections++;
    return { proxyUrl: `http://rotator${selections}.test:8080`, proxySource: 'proxy11', poolSize: 5 };
  };
  pool.proxy11Rotator.getStatus = () => ({ configured: true });
  const user = store.createSession({ loginUrl: 'https://portal.test/login', email: 'probe@example.com', password: 'test-password', displayName: 'Probe', executionMode: 'api', proxyUrl: 'http://session.test:8080' });
  t.after(() => { pool.shutdown(); fs.rmSync(dataDir, {recursive:true,force:true}); });
  await pool._startSession(user.id);
  const child = pool.active.get(user.id);
  const exited = once(child, 'exit');
  const [message] = await once(child, 'message');
  await exited;
  return { message, checked, pool, store, user, selections };
}

test('direct mode bypasses Proxy11, per-session, static, and fallback proxies', async (t) => {
  const {message,checked,selections,store,user} = await launchProxyFixture(t, {mode:'direct'});
  assert.deepEqual(message, {type:'probe',proxy:'',legacy:'',bypass:''});
  assert.equal(selections, 0);
  assert.deepEqual(checked, []);
  assert.ok(store.getSession(user.id).logs.some((entry) => entry.message.includes('VISA_PROXY_MODE=direct')));
});

test('a certificate failure is quarantined and the next verified proxy is used', async (t) => {
  const {message,checked,pool} = await launchProxyFixture(t, { results: [
    {ok:false,reason:'TLS certificate validation failed (ERR_CERT_AUTHORITY_INVALID)'}, {ok:true},
  ]});
  assert.deepEqual(checked, ['http://rotator1.test:8080','http://rotator2.test:8080']);
  assert.equal(message.proxy, 'http://rotator2.test:8080');
  assert.equal(pool.failedProxyUrls.has('http://rotator1.test:8080'), true);
});

test('all failing proxies retain the existing clean direct fallback', async (t) => {
  const {message,checked} = await launchProxyFixture(t);
  assert.equal(checked.length, 3);
  assert.equal(message.proxy, '');
  assert.equal(message.legacy, '');
});
