import assert from "node:assert/strict";

import worker from "../src/index.js";

const ADMIN_TOKEN = "admin-stats-test-token";
const NOW_MS = Date.UTC(2026, 7, 1, 18, 42, 0);
const NOW = Math.floor(NOW_MS / 1000);
const CURRENT_HOUR = Math.floor(NOW / 3600) * 3600;

function makeEnv() {
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      assert.equal(statements[0].args[0], NOW - 24 * 3600);
      assert.equal(statements[1].args[0], CURRENT_HOUR - 47 * 3600);
      return [
        {
          results: [{
            installations_seen: 311,
            new_installations_24h: 284,
            feed_active_24h: 279,
            scanning_users_24h: 162,
            auto_request_users_24h: 121,
            accepted_users_24h: 1,
            feedback_events_24h: 15171,
            observations_24h: 0,
            observed_asins_24h: 0,
            feed_requests_24h: 0,
          }],
        },
        { results: [{ hour: CURRENT_HOUR - 3600, new_installations: 57 }] },
        {
          results: [{
            hour: CURRENT_HOUR - 3600,
            scanning_users: 104,
            feedback_events: 3367,
            auto_request_users: 72,
            accepted_users: 1,
          }],
        },
      ];
    },
  };
  return { DB: db, ADMIN_TOKEN };
}

const originalNow = Date.now;
Date.now = () => NOW_MS;

try {
  const unauthorized = await worker.fetch(
    new Request("https://api.test/api/admin/stats"),
    makeEnv(),
    {},
  );
  assert.equal(unauthorized.status, 401);

  const response = await worker.fetch(
    new Request("https://api.test/api/admin/stats", {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    }),
    makeEnv(),
    {},
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") || "", /max-age=300/);
  assert.equal(response.headers.get("X-Amzinvite-Cache"), "MISS");

  const payload = await response.json();
  assert.equal(payload.generated_at, NOW);
  assert.equal(payload.window_hours, 48);
  assert.equal(payload.summary.installations_seen, 311);
  assert.equal(payload.summary.auto_request_users_24h, 121);
  assert.equal(payload.hourly.length, 48);
  assert.equal(payload.hourly[0].hour, CURRENT_HOUR - 47 * 3600);
  assert.deepEqual(payload.hourly.at(-2), {
    hour: CURRENT_HOUR - 3600,
    new_installations: 57,
    scanning_users: 104,
    feedback_events: 3367,
    auto_request_users: 72,
    accepted_users: 1,
    observations: 0,
    distinct_asins: 0,
    feed_requests: 0,
  });
  assert.equal(payload.hourly.at(-1).new_installations, 0);

  console.log("admin stats: 2 passés, 0 échoué");
} finally {
  Date.now = originalNow;
}
