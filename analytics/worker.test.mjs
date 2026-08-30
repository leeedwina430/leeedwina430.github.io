import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import worker from "./worker.mjs";
import {
  constantTimeEqual,
  deviceType,
  isLikelyBot,
  isValidId,
  normalizeEvent,
  normalizePath,
  normalizeReferrerHost,
  offsetLabel,
  parseAllowedOrigins,
} from "./worker.mjs";

const visitorId = "4a0c7f4f-e4c2-4d3a-9ee0-7062a45c6c55";
const sessionId = "c3458b13-c69b-44e1-8d77-68e39ef5c669";

test("validates version 4 UUIDs", () => {
  assert.equal(isValidId(visitorId), true);
  assert.equal(isValidId("4a0c7f4f-e4c2-1d3a-9ee0-7062a45c6c55"), false);
  assert.equal(isValidId("not-an-id"), false);
});

test("normalizes page paths without queries or control characters", () => {
  assert.equal(normalizePath("/personal-site/?secret=value#part"), "/personal-site/");
  assert.equal(normalizePath("/projects/\u0000causalbind/"), "/projects/causalbind/");
  assert.equal(normalizePath("relative/path"), null);
});

test("accepts only hostname-shaped referrers", () => {
  assert.equal(normalizeReferrerHost("Example.COM"), "example.com");
  assert.equal(normalizeReferrerHost("example.com/private/path"), null);
  assert.equal(normalizeReferrerHost(""), null);
});

test("normalizes a complete analytics event", () => {
  assert.deepEqual(normalizeEvent({
    version: 1,
    siteId: "example-site",
    visitorId,
    sessionId,
    path: "/personal-site/?from=email",
    referrerHost: "github.com",
  }, "example-site"), {
    visitorId,
    sessionId,
    path: "/personal-site/",
    referrerHost: "github.com",
  });
  assert.equal(normalizeEvent({ version: 1 }, "example-site"), null);
});

test("parses the configured origin allow-list exactly", () => {
  const origins = parseAllowedOrigins("https://example.com, http://localhost:8000");
  assert.equal(origins.has("https://example.com"), true);
  assert.equal(origins.has("http://localhost:8000"), true);
  assert.equal(origins.has("https://evil.example.com"), false);
});

test("filters common bots and groups device types", () => {
  assert.equal(isLikelyBot("Mozilla/5.0 Googlebot/2.1"), true);
  assert.equal(isLikelyBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari"), false);
  assert.equal(deviceType("Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile"), "mobile");
  assert.equal(deviceType("Mozilla/5.0 (iPad; CPU OS) Mobile"), "tablet");
  assert.equal(deviceType("Mozilla/5.0 (Macintosh; Intel Mac OS X)"), "desktop");
});

test("compares credentials and formats dashboard offsets", async () => {
  assert.equal(await constantTimeEqual("correct horse", "correct horse"), true);
  assert.equal(await constantTimeEqual("correct horse", "wrong horse"), false);
  assert.equal(offsetLabel(480), "UTC+08:00");
  assert.equal(offsetLabel(-330), "UTC-05:30");
});

test("serves health and CORS preflight without exposing credentials", async () => {
  const env = {
    ALLOWED_ORIGINS: "https://example.github.io",
    DB: {
      prepare() {
        return { first: async () => ({ ok: 1 }) };
      },
    },
  };
  const health = await worker.fetch(new Request("https://analytics.example/health"), env, {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", configured: false });

  const preflight = await worker.fetch(new Request("https://analytics.example/api/event", {
    method: "OPTIONS",
    headers: { Origin: "https://example.github.io" },
  }), env, {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://example.github.io");
});

test("keeps the dashboard closed until valid Basic credentials are supplied", async () => {
  const env = {
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD: "a-strong-dashboard-password",
    DASHBOARD_BRAND: "Personal <Site>",
  };
  const denied = await worker.fetch(new Request("https://analytics.example/admin"), env, {});
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("WWW-Authenticate"), /Basic/);

  const authorization = "Basic " + btoa("owner:a-strong-dashboard-password");
  const allowed = await worker.fetch(new Request("https://analytics.example/admin", {
    headers: { Authorization: authorization },
  }), env, {});
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  const html = await allowed.text();
  assert.match(html, /访客统计/);
  assert.match(html, /设备类型/);
  assert.match(html, /id="devices"/);
  assert.match(html, /Personal &lt;Site&gt;/);
  assert.doesNotMatch(html, /Personal <Site>/);
  const inlineScript = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});

test("reports device breakdown in the dashboard summary", async () => {
  const prepared = [];
  const database = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      const results = statements.map(() => ({ results: [] }));
      results[0].results = [{}];
      results[1].results = [{}];
      results[5].results = [{ label: "mobile", visitors: 2, pageviews: 3 }];
      return results;
    },
  };
  const authorization = "Basic " + btoa("owner:a-strong-dashboard-password");
  const response = await worker.fetch(new Request("https://analytics.example/api/admin/summary?days=30", {
    headers: { Authorization: authorization },
  }), {
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD: "a-strong-dashboard-password",
    DB: database,
  }, {});

  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.deepEqual(summary.devices, [{ label: "mobile", visitors: 2, pageviews: 3 }]);
  assert.match(prepared[5].sql, /GROUP BY device_type/);
});

test("accepts UTF-8 dashboard passwords", async () => {
  const password = "一条足够长的后台密码-2026";
  const authorization = "Basic " + Buffer.from("owner:" + password, "utf8").toString("base64");
  const response = await worker.fetch(new Request("https://analytics.example/admin", {
    headers: { Authorization: authorization },
  }), { ADMIN_USERNAME: "owner", ADMIN_PASSWORD: password }, {});
  assert.equal(response.status, 200);
});

test("collects an event without persisting the raw IP address", async () => {
  class FakeStatement {
    constructor(sql, database) {
      this.sql = sql;
      this.database = database;
      this.values = [];
    }
    bind(...values) {
      this.values = values;
      return this;
    }
    async run() {
      this.database.executed.push(this);
      const insertedIdentity = /INSERT OR IGNORE INTO (visitors|sessions)/.test(this.sql);
      return { meta: { changes: insertedIdentity ? 1 : 0 } };
    }
    async first() {
      this.database.executed.push(this);
      return { request_count: 1 };
    }
  }
  class FakeDatabase {
    constructor() {
      this.executed = [];
    }
    prepare(sql) {
      return new FakeStatement(sql, this);
    }
    async batch(statements) {
      this.executed.push(...statements);
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    }
  }

  const database = new FakeDatabase();
  const request = new Request("https://analytics.example/api/event", {
    method: "POST",
    headers: {
      Origin: "https://example.github.io",
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Safari",
      "CF-Connecting-IP": "203.0.113.8",
    },
    body: JSON.stringify({
      version: 1,
      siteId: "example-site",
      visitorId,
      sessionId,
      path: "/personal-site/",
      referrerHost: "github.com",
    }),
  });
  Object.defineProperty(request, "cf", {
    value: { country: "CN", region: "Shanghai", city: "Shanghai" },
  });

  const response = await worker.fetch(request, {
    DB: database,
    SITE_ID: "example-site",
    ALLOWED_ORIGINS: "https://example.github.io",
    IP_HASH_KEY: "test-only-secret-key",
    RATE_LIMIT_PER_MINUTE: "30",
  }, {});
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://example.github.io");
  const persistedValues = database.executed.flatMap((statement) => statement.values);
  assert.equal(persistedValues.includes("203.0.113.8"), false);
  assert.equal(persistedValues.includes("Shanghai"), true);
});
