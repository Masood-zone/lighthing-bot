const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.VISA_SECRET_KEY = process.env.VISA_SECRET_KEY || "test-secret-key";

const {
  SESSION_FILE_NAME,
  savePortalSession,
  loadPortalSession,
  clearPortalSession,
  seedPortalSessionStorage,
  createLoginAutoSubmitter,
} = require("../src/services/visaApi");

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function fakePage(entries = { authToken: "jwt-value", other: "x" }) {
  return {
    async evaluate() {
      return { origin: "https://www.usvisaappt.com", entries };
    },
  };
}

function auth(expiresInMs) {
  return {
    platformAuthToken: "jwt-value",
    authorizationHeader: "Bearer jwt-value",
    refreshToken: "refresh",
    cookies: [{ name: "SESSION", value: "abc" }],
    tokenExpiresAt: new Date(NOW + expiresInMs).toISOString(),
  };
}

async function tempProfile() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lb-profile-"));
}

test("saved portal session round-trips and is encrypted on disk", async () => {
  const profileDir = await tempProfile();
  const saved = await savePortalSession({
    profileDir,
    page: fakePage(),
    auth: auth(30 * 60_000),
    now: () => NOW,
  });
  assert.equal(saved, true);

  const raw = await fs.readFile(path.join(profileDir, SESSION_FILE_NAME), "utf8");
  assert.ok(!raw.includes("jwt-value"), "token must not be stored in plain text");

  const loaded = await loadPortalSession({ profileDir, now: () => NOW });
  assert.equal(loaded.auth.authorizationHeader, "Bearer jwt-value");
  assert.equal(loaded.auth.cookies, undefined, "cookies stay in the Chrome profile");
  assert.deepEqual(loaded.sessionStorage, { authToken: "jwt-value", other: "x" });
  assert.equal(loaded.origin, "https://www.usvisaappt.com");
});

test("a token that is expired or about to expire is not restored", async () => {
  const profileDir = await tempProfile();
  await savePortalSession({
    profileDir,
    page: fakePage(),
    auth: auth(60_000),
    now: () => NOW,
  });
  assert.equal(
    await loadPortalSession({ profileDir, minRemainingMs: 120_000, now: () => NOW }),
    null,
  );
});

test("a missing, tampered or cleared session file loads as null", async () => {
  const profileDir = await tempProfile();
  assert.equal(await loadPortalSession({ profileDir, now: () => NOW }), null);

  await savePortalSession({
    profileDir,
    page: fakePage(),
    auth: auth(30 * 60_000),
    now: () => NOW,
  });
  const file = path.join(profileDir, SESSION_FILE_NAME);
  const sealed = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...sealed, enc: Buffer.from("junk").toString("base64") }));
  assert.equal(await loadPortalSession({ profileDir, now: () => NOW }), null);

  await clearPortalSession(profileDir);
  await assert.rejects(fs.access(file));
});

test("nothing is saved without a profile directory or a bearer token", async () => {
  assert.equal(
    await savePortalSession({ profileDir: "", page: fakePage(), auth: auth(60_000) }),
    false,
  );
  const profileDir = await tempProfile();
  assert.equal(
    await savePortalSession({ profileDir, page: fakePage(), auth: {} }),
    false,
  );
});

test("seeded sessionStorage is applied once per tab and never overwrites", async () => {
  let script;
  let args;
  const context = {
    async addInitScript(fn, scriptArgs) {
      script = fn;
      args = scriptArgs;
    },
  };
  await seedPortalSessionStorage(context, {
    origin: "https://www.usvisaappt.com",
    sessionStorage: { authToken: "saved", languageId: "1" },
  });

  const store = new Map([["languageId", "2"]]);
  global.window = {
    location: { origin: "https://www.usvisaappt.com" },
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  };
  try {
    script(args);
    assert.equal(store.get("authToken"), "saved");
    assert.equal(store.get("languageId"), "2", "existing values are kept");

    store.set("authToken", "refreshed-by-portal");
    script(args);
    assert.equal(store.get("authToken"), "refreshed-by-portal", "reloads do not reseed");

    const other = new Map();
    global.window.location.origin = "https://example.test";
    global.window.sessionStorage.getItem = (key) => other.get(key) ?? null;
    global.window.sessionStorage.setItem = (key, value) => other.set(key, value);
    script(args);
    assert.equal(other.size, 0, "other origins are never seeded");
  } finally {
    delete global.window;
  }
});

test("with no CAPTCHA on the form Sign In is clicked once, straight away", async () => {
  let clicks = 0;
  const submit = createLoginAutoSubmitter(
    {},
    {
      readToken: async () => "none",
      click: async () => {
        clicks += 1;
        return true;
      },
    },
  );
  assert.equal(await submit(), true);
  assert.equal(await submit(), false, "a failed login is not resubmitted");
  assert.equal(clicks, 1);
});

test("Sign In is clicked once per solved CAPTCHA token", async () => {
  let token = "pending";
  let clicks = 0;
  const submit = createLoginAutoSubmitter(
    {},
    {
      readToken: async () => token,
      click: async () => {
        clicks += 1;
        return true;
      },
    },
  );

  assert.equal(await submit(), false, "no click before the CAPTCHA is solved");
  token = "solved-token-aaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(await submit(), true);
  assert.equal(await submit(), false, "the same token is never submitted twice");
  token = "re-solved-token-bbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(await submit(), true, "a re-solved CAPTCHA allows one more click");
  assert.equal(clicks, 2);
});

test("a Sign In button that is not ready is retried on the next tick", async () => {
  let ready = false;
  const submit = createLoginAutoSubmitter(
    {},
    {
      readToken: async () => "solved-token-aaaaaaaaaaaaaaaaaaaaaaaa",
      click: async () => ready,
    },
  );
  assert.equal(await submit(), false);
  ready = true;
  assert.equal(await submit(), true);
});
