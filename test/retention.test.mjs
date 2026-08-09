import assert from "node:assert/strict";

import worker from "../src/index.js";

const NOW_MS = Date.UTC(2026, 7, 3, 12, 0, 0);
const originalNow = Date.now;
Date.now = () => NOW_MS;

try {
  const statements = [];
  let scheduledPromise = null;
  const env = {
    DATA_RETENTION_ENABLED: "true",
    DATA_RETENTION_DAYS: "14",
    WAVE_ARCHIVE_ENABLED: "false",
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...args) { this.args = args; return this; },
        };
      },
      async batch(batch) {
        statements.push(...batch);
        return batch.map(() => ({ success: true }));
      },
    },
  };

  await worker.scheduled({ cron: "17 3 * * *" }, env, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  await scheduledPromise;

  assert.equal(statements.length, 4);
  assert.match(statements[0].sql, /DELETE FROM extension_feedback/);
  assert.match(statements[1].sql, /DELETE FROM feedback_hourly/);
  assert.match(statements[2].sql, /DELETE FROM observations/);
  assert.match(statements[3].sql, /DELETE FROM observations_hourly/);
  assert.equal(statements[0].args[0], Math.floor(NOW_MS / 1000) - 14 * 86400);

  statements.length = 0;
  await worker.scheduled({ cron: "*/15 * * * *" }, env, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  await scheduledPromise;
  assert.equal(statements.length, 0, "le cron d'archivage ne doit pas lancer la purge quotidienne");

  let disabledCalled = false;
  await worker.scheduled({}, { DATA_RETENTION_ENABLED: "false", WAVE_ARCHIVE_ENABLED: "false" }, {
    waitUntil() { disabledCalled = true; },
  });
  assert.equal(disabledCalled, true);

  console.log("retention : purge 14 jours et kill switch validés");
} finally {
  Date.now = originalNow;
}
