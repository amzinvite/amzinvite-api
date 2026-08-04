import assert from "node:assert/strict";

import {
  normalizeObservationPrice,
  normalizeObservationStock,
} from "../src/index.js";
import worker from "../src/index.js";

assert.equal(normalizeObservationPrice(11.99), 1199);
assert.equal(normalizeObservationPrice("14.90"), 1490);
assert.equal(normalizeObservationPrice(null), null);
assert.equal(normalizeObservationPrice("prix invalide"), null);
assert.equal(normalizeObservationPrice(-1), null);

assert.equal(normalizeObservationStock(true), 1);
assert.equal(normalizeObservationStock(1), 1);
assert.equal(normalizeObservationStock(false), 0);
assert.equal(normalizeObservationStock(0), 0);
assert.equal(normalizeObservationStock(null), null);
assert.equal(normalizeObservationStock(undefined), null);

const SECRET = "observation-v2-secret";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const now = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({
  dayBucket: "2026-08-01",
  items: [
    { asin: "B0TEST0001", marketplace: "amazon.fr", price: 11.99, in_stock: true },
    { asin: "B0TEST0001", marketplace: "amazon.fr", price: 12.49, in_stock: false },
    { asin: "B0TEST0001", marketplace: "amazon.com.be", price: 13.99, in_stock: true },
  ],
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
  new TextEncoder().encode(payload + now),
);
const signatureHex = Array.from(new Uint8Array(signature))
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

let inserted = [];
const env = {
  EXTENSION_LEGACY_AUTH_ENABLED: "false",
  OBSERVATION_RATE_LIMITER: { async limit() { return { success: true }; } },
  DB: {
    prepare(sql) {
      return {
        sql,
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM extension_credentials/.test(sql)) {
            return {
              secret: SECRET,
              scope: "observations",
              instance_id: null,
              expires_at: now + 1000,
              revoked: 0,
            };
          }
          return null;
        },
        async run() { return {}; },
      };
    },
    async batch(statements) {
      inserted = statements;
      return statements.map(() => ({ success: true }));
    },
  },
};
const response = await worker.fetch(new Request("https://api.test/api/extension/observations", {
  method: "POST",
  headers: {
    "X-Auth-Version": "2",
    "X-Credential-Id": CREDENTIAL_ID,
    "X-Ts": String(now),
    "X-Sig": signatureHex,
  },
  body: payload,
}), env, {});
assert.equal(response.status, 200);
assert.equal((await response.json()).inserted, 2);
assert.equal(inserted.length, 2);
assert.match(inserted[0].sql, /ON CONFLICT\(hour, marketplace, asin\) DO UPDATE/);
assert.equal(inserted[0].args[1], "amazon.fr");
assert.equal(inserted[0].args[4], 1249);
assert.equal(inserted[1].args[1], "amazon.com.be");

console.log("  ✓ observations : normalisation et dédoublonnage indépendant par marketplace + ASIN");
