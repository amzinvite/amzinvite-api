import assert from "node:assert/strict";

import worker from "../src/index.js";

const INSTANCE = "0123456789abcdef0123456789abcdef";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "monitoring-feed-secret-for-tests";
const PATH = "/api/extension/monitoring?marketplaces=amazon.fr&limit=2";
const URL = `https://api.test${PATH}`;

async function hmacHex(secret, data) {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bytes.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function makeEnv() {
  return {
    FEED_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: {
      prepare(sql) {
        return {
          bind(...args) { this.args = args; return this; },
          async run() { return { success: true }; },
          async first() {
            if (/FROM extension_credentials/.test(sql)) {
              return {
                secret: SECRET,
                scope: "instance",
                instance_id: INSTANCE,
                expires_at: null,
                revoked: 0,
              };
            }
            return null;
          },
          async all() {
            if (/FROM monitoring_products/.test(sql)) {
              return {
                results: [
                  { asin: "B000000001", marketplace: "amazon.fr", url: "https://www.amazon.fr/dp/B000000001", name: "Un" },
                  { asin: "B000000002", marketplace: "amazon.fr", url: "https://www.amazon.fr/dp/B000000002", name: "Deux" },
                  { asin: "B000000003", marketplace: "amazon.fr", url: "https://www.amazon.fr/dp/B000000003", name: "Trois" },
                ],
              };
            }
            return { results: [] };
          },
        };
      },
    },
  };
}

async function signedRequest() {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(SECRET, PATH + timestamp);
  return new Request(URL, {
    headers: {
      "X-Instance-Id": INSTANCE,
      "X-Auth-Version": "2",
      "X-Credential-Id": CREDENTIAL_ID,
      "X-Ts": timestamp,
      "X-Sig": signature,
    },
  });
}

const unauthorized = await worker.fetch(new Request(URL), makeEnv(), {});
assert.equal(unauthorized.status, 401);

const first = await worker.fetch(await signedRequest(), makeEnv(), {});
assert.equal(first.status, 200);
const firstItems = await first.json();
assert.equal(firstItems.length, 2);
assert.ok(firstItems.every((item) => item.monitor_only === true));

const second = await worker.fetch(await signedRequest(), makeEnv(), {});
assert.deepEqual(await second.json(), firstItems);

console.log("monitoring feed : shard signé, borné et stable");
