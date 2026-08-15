import assert from "node:assert/strict";

import worker from "../src/index.js";

const SECRET = "feedback-v2-secret";
const INSTANCE_ID = "01234567-89ab-4def-8123-456789abcdef";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

async function signedRequest(state, source = "bg_check") {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    asin: "B0TEST0001",
    marketplace: "amazon.fr",
    state,
    source,
    observedAt: timestamp - 10,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body + timestamp),
  );
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request("https://api.test/api/extension/feedback", {
    method: "POST",
    headers: {
      "X-Instance-Id": INSTANCE_ID,
      "X-Auth-Version": "2",
      "X-Credential-Id": CREDENTIAL_ID,
      "X-Ts": String(timestamp),
      "X-Sig": signatureHex,
    },
    body,
  });
}

async function signedBatchRequest(items, scanSummary = undefined) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ items, ...(scanSummary ? { scanSummary } : {}) });
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + timestamp));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://api.test/api/extension/feedback/batch", {
    method: "POST",
    headers: {
      "X-Instance-Id": INSTANCE_ID,
      "X-Auth-Version": "2",
      "X-Credential-Id": CREDENTIAL_ID,
      "X-Ts": String(timestamp),
      "X-Sig": signatureHex,
    },
    body,
  });
}

function makeEnv() {
  const batches = [];
  const env = {
    EXTENSION_LEGACY_AUTH_ENABLED: "false",
    FEEDBACK_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...args) { this.args = args; return this; },
          async first() {
            if (/FROM extension_credentials/.test(sql)) {
              return {
                secret: SECRET,
                scope: "instance",
                instance_id: INSTANCE_ID,
                expires_at: null,
                revoked: 0,
              };
            }
            return null;
          },
          async run() { return {}; },
        };
      },
      async batch(statements) {
        batches.push(statements);
        return statements.map(() => ({ success: true }));
      },
    },
  };
  return { env, batches };
}

const noisy = makeEnv();
const noisyResponse = await worker.fetch(
  await signedRequest("not_invitation"),
  noisy.env,
  {},
);
assert.equal(noisyResponse.status, 200);
assert.equal(noisy.batches[0].length, 1);
assert.match(noisy.batches[0][0].sql, /INSERT OR IGNORE INTO feedback_hourly/);
assert.equal(noisy.batches[0][0].args[4], "not_invitation");

const important = makeEnv();
const importantResponse = await worker.fetch(
  await signedRequest("available"),
  important.env,
  {},
);
assert.equal(importantResponse.status, 200);
assert.equal(important.batches[0].length, 2);
assert.match(important.batches[0][1].sql, /INSERT INTO extension_feedback/);

const autoRequest = makeEnv();
await worker.fetch(await signedRequest("already_requested", "auto_request"), autoRequest.env, {});
assert.equal(autoRequest.batches[0].length, 2);

const grouped = makeEnv();
const groupedResponse = await worker.fetch(await signedBatchRequest([
  { asin: "B0TEST0001", marketplace: "amazon.fr", state: "not_invitation", source: "bg_check" },
  { asin: "B0TEST0002", marketplace: "amazon.fr", state: "accepted", source: "bg_check" },
]), grouped.env, {});
assert.equal(groupedResponse.status, 200);
assert.equal((await groupedResponse.json()).accepted, 2);
assert.equal(grouped.batches[0].length, 3, "deux agrégats horaires et un événement accepté brut");

const completed = makeEnv();
const completedResponse = await worker.fetch(await signedBatchRequest([], {
  runKind: "full",
  outcome: "completed",
  extensionVersion: "0.1.20",
  checked: 51,
  expected: 51,
  errors: 0,
  startedAt: 1786780800,
  completedAt: 1786782600,
  durationMs: 1800000,
}), completed.env, {});
assert.equal(completedResponse.status, 200);
assert.deepEqual(await completedResponse.json(), { ok: true, accepted: 0, scan_summary: true });
assert.equal(completed.batches[0].length, 1, "un résumé sans produit reste une seule écriture");
assert.match(completed.batches[0][0].sql, /INSERT INTO scan_completions_hourly/);
assert.equal(completed.batches[0][0].args[4], 1, "le succès complet est calculé côté Worker");

const invalidSummary = makeEnv();
const invalidResponse = await worker.fetch(await signedBatchRequest([], {
  runKind: "full",
  outcome: "completed",
  extensionVersion: "0.1.20",
  checked: 50,
  expected: 51,
  errors: 0,
  startedAt: 1786780800,
  completedAt: 1786782600,
  durationMs: 1800000,
}), invalidSummary.env, {});
assert.equal(invalidResponse.status, 200);
assert.equal(invalidSummary.batches[0][0].args[4], 0, "un cycle incomplet n'est jamais marqué réussi");

const failedBeforeWatchlist = makeEnv();
const failedBeforeWatchlistResponse = await worker.fetch(await signedBatchRequest([], {
  runKind: "full",
  outcome: "failed",
  extensionVersion: "0.1.37",
  checked: 0,
  expected: 0,
  errors: 1,
  startedAt: 1786780800,
  completedAt: 1786780801,
  durationMs: 1000,
}), failedBeforeWatchlist.env, {});
assert.equal(failedBeforeWatchlistResponse.status, 200);
assert.equal(failedBeforeWatchlist.batches[0][0].args[4], 0);

console.log("feedback: déduplication horaire et brut sélectif validés");
