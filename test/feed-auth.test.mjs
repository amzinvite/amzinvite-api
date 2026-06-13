// Tests de non-régression : le feed public exige désormais une requête signée.
// Mocke env.DB (D1) + HMAC_SECRET, importe le worker et appelle worker.fetch.
//
// Lancer : node test/feed-auth.test.mjs

import assert from "node:assert/strict";
import worker from "../src/index.js";

const SECRET = "test-secret-123";
const FEED_URL = "https://api.test/api/public/invitations";
const FEED_PATH = "/api/public/invitations";
const INSTANCE = "0123456789abcdef0123456789abcdef";

// ─── Mock D1 : route selon le SQL ──────────────────────────────────────────
function makeEnv({ feedRows = [{ asin: "B0TEST00001", url: "https://www.amazon.fr/dp/B0TEST00001" }] } = {}) {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() { return {}; },
        async first() {
          if (/SELECT count FROM rate_events/.test(sql)) return { count: 1 };
          return null;
        },
        async all() {
          if (/FROM invitations/.test(sql)) return { results: feedRows };
          return { results: [] };
        },
      };
    },
  };
  return { DB: db, HMAC_SECRET: SECRET };
}

async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function feedRequest(headers = {}) {
  return new Request(FEED_URL, { method: "GET", headers });
}

async function signedHeaders({ ts = Math.floor(Date.now() / 1000).toString(), secret = SECRET, instance = INSTANCE } = {}) {
  const sig = await hmacHex(secret, FEED_PATH + ts);
  return { "X-Instance-Id": instance, "X-Ts": ts, "X-Sig": sig };
}

// ─── Runner ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log("feed public — protection HMAC :");

await test("refuse une requête sans en-têtes (curl nu) → 401", async () => {
  const res = await worker.fetch(feedRequest(), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "bad_instance_id");
});

await test("refuse un instanceId mal formé → 401", async () => {
  const res = await worker.fetch(feedRequest({ "X-Instance-Id": "nope", "X-Ts": "1", "X-Sig": "x" }), makeEnv(), {});
  assert.equal(res.status, 401);
});

await test("refuse une signature invalide → 401", async () => {
  const headers = await signedHeaders({ secret: "mauvais-secret" });
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "bad_signature");
});

await test("refuse un timestamp expiré → 401", async () => {
  const oldTs = (Math.floor(Date.now() / 1000) - 10000).toString();
  const headers = await signedHeaders({ ts: oldTs });
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "expired_timestamp");
});

await test("accepte une requête correctement signée → 200 + données", async () => {
  const headers = await signedHeaders();
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body) && body.length === 1);
  assert.equal(body[0].asin, "B0TEST00001");
});

await test("réponse signée → pas de cache CDN partagé (no-store)", async () => {
  const headers = await signedHeaders();
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.match(res.headers.get("Cache-Control") || "", /no-store/);
});

console.log(`\n${passed} passés, ${failed} échoués`);
process.exit(failed ? 1 : 0);
