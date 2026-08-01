import assert from "node:assert/strict";
import worker from "../src/index.js";

const inserted = [];
let cleanupRuns = 0;
const db = {
  prepare(sql) {
    return {
      bind(...args) { this.args = args; return this; },
      async run() {
        if (/DELETE FROM extension_credentials/.test(sql)) cleanupRuns++;
        if (/INSERT INTO extension_credentials/.test(sql)) inserted.push(this.args);
        return {};
      },
      async first() { return null; },
      async all() { return { results: [] }; },
    };
  },
};

const env = {
  DB: db,
  REGISTRATION_RATE_LIMITER: { async limit() { return { success: true }; } },
};

async function register(payload) {
  return worker.fetch(new Request("https://api.test/api/extension/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.1",
    },
    body: JSON.stringify(payload),
  }), env, {});
}

const instanceId = "01234567-89ab-4def-8123-456789abcdef";
const instanceResponse = await register({ scope: "instance", instanceId });
assert.equal(instanceResponse.status, 201);
assert.match(instanceResponse.headers.get("Cache-Control") || "", /no-store/);
const instanceCredential = await instanceResponse.json();
assert.equal(instanceCredential.scope, "instance");
assert.match(instanceCredential.credentialId, /^[0-9a-f-]{36}$/i);
assert.match(instanceCredential.secret, /^[A-Za-z0-9_-]{43}$/);
assert.equal(instanceCredential.expiresAt, null);
assert.equal(inserted[0][2], "instance");
assert.equal(inserted[0][3], instanceId);

const observationResponse = await register({ scope: "observations" });
assert.equal(observationResponse.status, 201);
const observationCredential = await observationResponse.json();
assert.equal(observationCredential.scope, "observations");
assert.ok(observationCredential.expiresAt > Date.now());
assert.equal(inserted[1][2], "observations");
assert.equal(inserted[1][3], null);
assert.equal(cleanupRuns, 2);

const badResponse = await register({ scope: "instance", instanceId: "nope" });
assert.equal(badResponse.status, 400);
assert.equal((await badResponse.json()).error, "bad_instance_id");

console.log("credential registration: 3 passés, 0 échoué");
