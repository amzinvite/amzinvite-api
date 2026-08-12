import assert from "node:assert/strict";

import worker, { persistFinalizedWaves } from "../src/index.js";

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

  const archiveStatements = [];
  const archivedIds = new Set();
  const archiveEnv = {
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...args) { this.args = args; return this; },
          async first() { return archivedIds.has(String(this.args[0])) ? { exists: 1 } : null; },
        };
      },
      async batch(batch) {
        archiveStatements.push(...batch);
        archivedIds.add(String(batch[0].args[0]));
        return batch.map(() => ({ success: true }));
      },
    },
  };
  const endedWave = {
    id: "wave-ended", ended_at: Math.floor(NOW_MS / 1000) - 60,
    started_at: Math.floor(NOW_MS / 1000) - 86460, detected_at: Math.floor(NOW_MS / 1000) - 86400,
    finalized: false, installations: 990, active_users: 529, selected_users: 141,
    validations: 174, products: 1, selection_rate: 141 / 529,
    items: [{ marketplace: "amazon.fr", asin: "B0TESTWAVE", name: "Produit test", image_url: null,
      selected_users: 1, validations: 1, eligible_users: 10, selection_rate: 0.1 }],
  };
  assert.equal(await persistFinalizedWaves(archiveEnv, [endedWave]), 1,
    "le cron doit archiver une vague terminée même si elle n'est pas encore finalisée publiquement");
  assert.match(archiveStatements[0].sql, /INSERT INTO invitation_waves/);
  assert.equal(await persistFinalizedWaves(archiveEnv, [endedWave]), 0,
    "une vague déjà figée ne doit pas être réécrite");

  let disabledCalled = false;
  await worker.scheduled({}, { DATA_RETENTION_ENABLED: "false", WAVE_ARCHIVE_ENABLED: "false" }, {
    waitUntil() { disabledCalled = true; },
  });
  assert.equal(disabledCalled, true);

  console.log("retention : purge 14 jours et kill switch validés");
} finally {
  Date.now = originalNow;
}
