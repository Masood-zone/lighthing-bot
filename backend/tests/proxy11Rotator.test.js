const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProxyUrlFromEntry,
} = require("../src/queue/proxy11Rotator");

test("Proxy11 HTTPS-capable entries remain plain HTTP proxy endpoints", () => {
  assert.equal(
    buildProxyUrlFromEntry({ ip: "203.0.113.10", port: "80", type: 1 }),
    "http://203.0.113.10:80",
  );
});

test("Proxy11 HTTP entries and fallback ports produce usable proxy URLs", () => {
  assert.equal(
    buildProxyUrlFromEntry({ ip: "203.0.113.11", port: "8080", type: 0 }),
    "http://203.0.113.11:8080",
  );
  assert.equal(
    buildProxyUrlFromEntry({ ip: "203.0.113.12", type: 1 }, "3128"),
    "http://203.0.113.12:3128",
  );
});

test("Proxy11 entries without an IP are ignored", () => {
  assert.equal(buildProxyUrlFromEntry({ port: "8080", type: 1 }), "");
});
