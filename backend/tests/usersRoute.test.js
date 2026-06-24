const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

process.env.VISA_SECRET_KEY = "test-secret-for-users-route";

const { createUsersRouter } = require("../src/routes/users");
const { SessionStore } = require("../src/store/sessionStore");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lightingbot-users-test-"));
}

async function withUsersServer(fn) {
  const dataDir = makeTempDir();
  const store = new SessionStore({ dataDir });
  const app = express();
  const pool = {
    enqueue() {},
    stop() {},
  };

  app.use(express.json());
  app.use(
    "/api/users",
    createUsersRouter({
      store,
      pool,
      baseDir: dataDir,
      profilesDir: path.join(dataDir, "profiles"),
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createBody(overrides = {}) {
  return {
    loginUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    email: "route@example.com",
    password: "secret",
    displayName: "Route User",
    pickupPoint: "Accra",
    ...overrides,
  };
}

test("users route accepts execution mode and rejects invalid values", async () => {
  await withUsersServer(async ({ baseUrl }) => {
    const createResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody({ executionMode: "api" })),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.user.config.executionMode, "api");

    const updateResponse = await fetch(
      `${baseUrl}/api/users/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionMode: "dom", headless: true }),
      },
    );
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();
    assert.equal(updated.user.config.executionMode, "dom");
    assert.equal(updated.user.config.headless, true);

    const invalidResponse = await fetch(
      `${baseUrl}/api/users/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionMode: "browser" }),
      },
    );
    assert.equal(invalidResponse.status, 400);
    assert.deepEqual(await invalidResponse.json(), {
      error: "executionMode_invalid",
    });
  });
});

test("users route defaults execution mode to dom", async () => {
  await withUsersServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody({ email: "default@example.com" })),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.user.config.executionMode, "dom");
  });
});
