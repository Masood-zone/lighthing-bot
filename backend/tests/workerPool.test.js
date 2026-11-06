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

const { EventEmitter } = require('node:events');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.connected = true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.sent = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    if (message.type === 'worker_stop') child.emit('exit', 0, null);
    callback?.();
  };
  child.kill = (signal) => { child.emit('exit', null, signal); };
  return child;
}

function poolFixture(t, {maxConcurrent = 1, monitorOptions = {}} = {}) {
  const dataDir = makeTempDir();
  const store = new SessionStore({ dataDir });
  const children = [];
  const pool = new WorkerPool({ store, maxConcurrent, monitorOptions, workerEntry: 'fake-worker', baseDir: dataDir,
    forkWorker: () => { const child = fakeChild(); children.push(child); return child; },
  });
  pool.proxy11Rotator.acquire = async () => null;
  pool.proxy11Rotator.getStatus = () => ({ configured: false });
  pool.proxyPool = [];
  pool.proxyFallback = '';
  const create = (email) => store.createSession({ loginUrl: 'https://portal.test/login', email, password: 'secret', displayName: email, executionMode: 'api' });
  const originalTick = pool._tick.bind(pool);
  pool._tick = () => {};
  t.after(() => {
    pool.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { pool, store, children, create, tick: originalTick };
}

test('hourly pause frees capacity, keeps account lock, and resumes the same worker in FIFO order', async (t) => {
  const { pool, store, children, create, tick } = poolFixture(t);
  const first = create('first@example.com');
  const second = create('second@example.com');
  const duplicate = create('first@example.com');
  pool.enqueue(first.id);
  pool.dequeue(first.id);
  await pool._startSession(first.id);
  const firstChild = children[0];
  pool.enqueue(second.id);
  firstChild.emit('message', { type: 'hunt_slot_released', requestId: 1 });
  assert.equal(pool.getSnapshot().activeCount, 0);
  assert.equal(pool.active.get(first.id), firstChild);
  assert.equal(pool.enqueue(duplicate.id).duplicateAccount, true);
  assert.match(store.getSession(first.id).lastMessage, /paused after one hour/);
  firstChild.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
  firstChild.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
  assert.deepEqual(pool.queue, [second.id, first.id]);
  assert.equal(store.getSession(first.id).status, 'QUEUED');
  pool._tick = tick;
  tick();
  await new Promise(setImmediate);
  assert.equal(children.length, 2);
  assert.deepEqual(pool.getSnapshot().active, [second.id]);
  assert.equal(firstChild.sent.length, 0);
  children[1].emit('exit', 1, null);
  assert.equal(children.length, 2);
  assert.deepEqual(firstChild.sent, [{ type: 'hunt_resume_granted', requestId: 1 }]);
  assert.deepEqual(pool.getSnapshot().active, [first.id]);
  // Delayed duplicates from the old cycle cannot release a new hunting slot.
  firstChild.emit('message', { type: 'hunt_slot_released', requestId: 1 });
  firstChild.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
  assert.equal(pool.getSnapshot().activeCount, 1);
  firstChild.emit('message', { type: 'hunt_slot_released', requestId: 2 });
  assert.equal(pool.getSnapshot().activeCount, 0);
});

for (const queued of [false, true]) {
  test(`Stop cleans up a ${queued ? 'requeued' : 'waiting'} live worker and rejects late controls`, async (t) => {
    const { pool, store, children, create } = poolFixture(t);
    const first = create('first@example.com');
    pool.enqueue(first.id);
    pool.dequeue(first.id);
    await pool._startSession(first.id);
    const child = children[0];
    child.emit('message', { type: 'hunt_slot_released', requestId: 1 });
    if (queued) child.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
    pool.stop(first.id);
    assert.equal(child.sent.at(-1).type, 'worker_stop');
    child.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
    assert.equal(store.getSession(first.id).status, 'STOPPED');
    assert.equal(pool.queue.length, 0);
    assert.equal(pool.active.size, 0);
    assert.equal(pool.hunting.size, 0);
    assert.equal(pool.renewals.size, 0);
    assert.equal(pool.accountLocks.size, 0);
    assert.equal(pool.proxyAssignments.size, 0);
  });
}

test('browser/worker failure removes a queued renewal and allows another account session', async (t) => {
  const { pool, store, children, create } = poolFixture(t);
  const first = create('first@example.com');
  pool.enqueue(first.id);
  pool.dequeue(first.id);
  await pool._startSession(first.id);
  const child = children[0];
  child.emit('message', { type: 'hunt_slot_released', requestId: 1 });
  child.emit('message', { type: 'hunt_resume_requested', requestId: 1 });
  child.emit('exit', 1, null);
  assert.equal(store.getSession(first.id).status, 'ERROR');
  assert.equal(pool.queue.length, 0);
  assert.equal(pool.accountLocks.size, 0);
  assert.equal(pool.enqueue(create('first@example.com').id).queued, true);
});

test('completed booking status survives its browser verification pause', async (t) => {
  const { pool, store, children, create } = poolFixture(t);
  const first = create('first@example.com');
  pool.enqueue(first.id);
  pool.dequeue(first.id);
  await pool._startSession(first.id);
  children[0].emit('message', { type: 'status', state: 'COMPLETED', message: 'Verified' });
  children[0].emit('message', { type: 'status', state: 'PAUSED', message: 'Browser retained' });
  assert.equal(store.getSession(first.id).status, 'COMPLETED');
});

test('server shutdown kills waiting browsers and removes queued renewals', async (t) => {
  const { pool, store, children, create } = poolFixture(t);
  const first = create('first@example.com');
  pool.enqueue(first.id);
  pool.dequeue(first.id);
  await pool._startSession(first.id);
  children[0].emit('message', { type: 'hunt_slot_released', requestId: 1 });
  children[0].emit('message', { type: 'hunt_resume_requested', requestId: 1 });
  pool.shutdown();
  assert.equal(store.getSession(first.id).status, 'STOPPED');
  assert.equal(pool.active.size, 0);
  assert.equal(pool.queue.length, 0);
  assert.equal(pool.accountLocks.size, 0);
});

test('two execution modes run concurrently and both appear in summaries without store writes', async(t)=>{
 let time=0;let callback;let cancelled=0;const lines=[];
 const fixture=poolFixture(t,{maxConcurrent:2,monitorOptions:{now:()=>time,schedule:(fn,ms)=>{assert.equal(ms,10000);callback=fn;return{unref(){}}},cancel:()=>cancelled++}});
 const {pool,store,children,create,tick}=fixture;
 t.mock.method(console,'log',line=>lines.push(line));
 const api=create('api@example.com');const dom=create('dom@example.com');
 store.updateSession(dom.id,{executionMode:'dom'});
 pool.enqueue(api.id);pool.enqueue(dom.id);pool._tick=tick;tick();
 await new Promise(setImmediate);
 assert.equal(children.length,2);assert.equal(pool.active.size,2);assert.equal(pool.getSnapshot().activeCount,2);
 children[0].emit('message',{type:'status',state:'CONTEXT_BOOTSTRAP',message:'Resolving context'});
 children[1].emit('message',{type:'status',state:'DATE',message:'No dates found'});
 const before=JSON.stringify(store.state);
 time=10000;callback();
 const summaries=lines.filter(line=>line.includes('SESSION_SUMMARY'));
 assert.equal(summaries.length,2);
 assert.ok(summaries.some(line=>line.includes(api.id)&&line.includes('mode=api')&&line.includes('phase=initializing')));
 assert.ok(summaries.some(line=>line.includes(dom.id)&&line.includes('mode=dom')&&line.includes('phase=scanning')));
 assert.equal(JSON.stringify(store.state),before);
 children[0].emit('message',{type:'hunt_slot_released',requestId:1});
 callback();assert.ok(lines.at(-2).includes('phase=hourly_pause'));
 children[0].emit('exit',1,null);assert.equal(pool.monitor.records.size,1);assert.equal(cancelled,0);
 pool.stop(dom.id);assert.equal(pool.monitor.records.size,0);assert.equal(cancelled,1);
});

test('queued session Stop removes its summary entry without launching a worker',async(t)=>{
 const {pool,create}=poolFixture(t);
 const user=create('queued@example.com');pool.enqueue(user.id);
 assert.equal(pool.monitor.records.get(user.id).phase,'queued');
 pool.stop(user.id);assert.equal(pool.monitor.records.size,0);assert.equal(pool.monitor.timer,null);
});
