import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../assets/js/visitor-analytics.js", import.meta.url), "utf8");

function runClient({ endpoint = "", globalPrivacyControl = false, privacyPage = false, embedded = false } = {}) {
  const values = new Map();
  const beacons = [];
  const selectors = [];
  const ids = [
    "4a0c7f4f-e4c2-4d3a-9ee0-7062a45c6c55",
    "c3458b13-c69b-44e1-8d77-68e39ef5c669",
  ];
  const window = {
    VISITOR_ANALYTICS_CONFIG: { endpoint, siteId: "example-site" },
    crypto: { randomUUID: () => ids.shift() },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    location: { hostname: "example.github.io", pathname: "/personal-site/" },
    setTimeout: (callback) => callback(),
    fetch: () => Promise.resolve(),
  };
  window.self = window;
  window.top = embedded ? {} : window;
  const context = {
    window,
    navigator: {
      globalPrivacyControl,
      doNotTrack: "0",
      sendBeacon: (url, body) => {
        beacons.push({ url, body });
        return true;
      },
    },
    document: {
      referrer: "https://github.com/example/example?private=value",
      querySelector: (selector) => {
        selectors.push(selector);
        return privacyPage ? {} : null;
      },
    },
    URL,
    Blob,
    Uint8Array,
    Array,
    JSON,
    Math,
    Number,
    Object,
  };
  vm.runInNewContext(source, context);
  return { window, values, beacons, selectors };
}

test("does nothing until a Worker endpoint is configured", () => {
  const result = runClient();
  assert.equal(result.beacons.length, 0);
  assert.equal(typeof result.window.VisitorAnalytics.optOut, "function");
});

test("sends a minimized page-view payload to the configured endpoint", async () => {
  const endpoint = "https://analytics.example.workers.dev/api/event";
  const result = runClient({ endpoint });
  assert.equal(result.beacons.length, 1);
  assert.equal(result.beacons[0].url, endpoint);
  const payload = JSON.parse(await result.beacons[0].body.text());
  assert.deepEqual(payload, {
    version: 1,
    siteId: "example-site",
    visitorId: "4a0c7f4f-e4c2-4d3a-9ee0-7062a45c6c55",
    sessionId: "c3458b13-c69b-44e1-8d77-68e39ef5c669",
    path: "/personal-site/",
    referrerHost: "github.com",
  });
  assert.equal(JSON.stringify(payload).includes("private=value"), false);
});

test("honors browser privacy signals, embedded documents, the privacy-page exclusion, and opt-out", () => {
  assert.equal(runClient({ endpoint: "https://analytics.example.workers.dev/api/event", globalPrivacyControl: true }).beacons.length, 0);
  assert.equal(runClient({ endpoint: "https://analytics.example.workers.dev/api/event", embedded: true }).beacons.length, 0);
  const privacyPage = runClient({ endpoint: "https://analytics.example.workers.dev/api/event", privacyPage: true });
  assert.equal(privacyPage.beacons.length, 0);
  assert.deepEqual(privacyPage.selectors, ['meta[name="visitor-analytics"][content="disabled"]']);

  const result = runClient();
  result.window.VisitorAnalytics.optOut();
  assert.equal(result.window.VisitorAnalytics.isOptedOut(), true);
  assert.equal(Array.from(result.values.keys()).some((key) => key.endsWith(":visitor")), false);
});
