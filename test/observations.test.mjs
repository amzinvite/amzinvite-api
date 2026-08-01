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

const SECRET = "observation-secret";
const now = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({
  dayBucket: "2026-08-01",
  items: [
    { asin: "B0TEST0001", price: 11.99, in_stock: true },
    { asin: "B0TEST0001", price: 12.49, in_stock: false },
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
  HMAC_SECRET: SECRET,
  EXTENSION_LEGACY_AUTH_ENABLED: "true",
  OBSERVATION_RATE_LIMITER: { async limit() { return { success: true }; } },
  DB: {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() { return null; },
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
  headers: { "X-Ts": String(now), "X-Sig": signatureHex },
  body: payload,
}), env, {});
assert.equal(response.status, 200);
assert.equal((await response.json()).inserted, 1);
assert.equal(inserted.length, 1);
assert.equal(inserted[0].args[2], 1249);

console.log("  ✓ observations : normalisation tri-state et dédoublonnage avant écriture");
