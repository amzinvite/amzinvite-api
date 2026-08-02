// Tests de non-régression : le feed public exige désormais une requête signée.
// Mocke env.DB (D1), importe le worker et appelle worker.fetch.
//
// Lancer : node test/feed-auth.test.mjs

import assert from "node:assert/strict";
import worker from "../src/index.js";

const FEED_URL = "https://api.test/api/public/invitations";
const FEED_PATH = "/api/public/invitations";
const INSTANCE = "0123456789abcdef0123456789abcdef";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const V2_SECRET = "random-install-secret-for-tests";

// ─── Mock D1 : route selon le SQL ──────────────────────────────────────────
function makeEnv({
  feedRows = [{ asin: "B0TEST00001", url: "https://www.amazon.fr/dp/B0TEST00001" }],
  enforce = true,
  legacy = true,
  credential = {
    secret: V2_SECRET,
    scope: "instance",
    instance_id: INSTANCE,
    expires_at: null,
    revoked: 0,
  },
} = {}) {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async run() { return {}; },
        async first() {
          if (/FROM extension_credentials/.test(sql)) return credential;
          return null;
        },
        async all() {
          if (/FROM invitations/.test(sql)) return { results: feedRows };
          return { results: [] };
        },
      };
    },
  };
  return {
    DB: db,
    FEED_AUTH_ENFORCE: enforce ? "true" : "false",
    EXTENSION_LEGACY_AUTH_ENABLED: legacy ? "true" : "false",
    FEED_RATE_LIMITER: { async limit() { return { success: true }; } },
  };
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

async function signedHeaders({ ts = Math.floor(Date.now() / 1000).toString(), secret = "legacy-secret", instance = INSTANCE } = {}) {
  const sig = await hmacHex(secret, FEED_PATH + ts);
  return { "X-Instance-Id": instance, "X-Ts": ts, "X-Sig": sig };
}

async function v2SignedHeaders({
  ts = Math.floor(Date.now() / 1000).toString(),
  secret = V2_SECRET,
  instance = INSTANCE,
  credentialId = CREDENTIAL_ID,
} = {}) {
  const sig = await hmacHex(secret, FEED_PATH + ts);
  return {
    "X-Instance-Id": instance,
    "X-Auth-Version": "2",
    "X-Credential-Id": credentialId,
    "X-Ts": ts,
    "X-Sig": sig,
  };
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
  const headers = await v2SignedHeaders({ secret: "mauvais-secret" });
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "bad_signature");
});

await test("refuse un timestamp expiré → 401", async () => {
  const oldTs = (Math.floor(Date.now() / 1000) - 10000).toString();
  const headers = await v2SignedHeaders({ ts: oldTs });
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "expired_timestamp");
});

await test("accepte une requête v2 correctement signée → 200 + données", async () => {
  const headers = await v2SignedHeaders();
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body) && body.length === 1);
  assert.equal(body[0].asin, "B0TEST00001");
});

await test("accepte un credential aléatoire v2 correctement signé", async () => {
  const headers = await v2SignedHeaders();
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.equal(res.status, 200);
});

await test("refuse un credential v2 d'un autre scope", async () => {
  const headers = await v2SignedHeaders();
  const res = await worker.fetch(
    feedRequest(headers),
    makeEnv({ credential: {
      secret: V2_SECRET,
      scope: "observations",
      instance_id: null,
      expires_at: Math.floor(Date.now() / 1000) + 1000,
      revoked: 0,
    } }),
    {},
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "credential_scope_mismatch");
});

await test("refuse toujours le secret legacy sans bloquer v2", async () => {
  const legacyRes = await worker.fetch(feedRequest(await signedHeaders()), makeEnv({ legacy: true }), {});
  assert.equal(legacyRes.status, 401);
  assert.equal((await legacyRes.json()).error, "legacy_auth_disabled");

  const v2Res = await worker.fetch(feedRequest(await v2SignedHeaders()), makeEnv({ legacy: false }), {});
  assert.equal(v2Res.status, 200);
});

await test("période de grâce (enforce=false) : requête non signée → 200", async () => {
  const res = await worker.fetch(feedRequest(), makeEnv({ enforce: false }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body) && body.length === 1);
});

await test("réponse signée → pas de cache CDN partagé (no-store)", async () => {
  const headers = await v2SignedHeaders();
  const res = await worker.fetch(feedRequest(headers), makeEnv(), {});
  assert.match(res.headers.get("Cache-Control") || "", /no-store/);
});

console.log(`\n${passed} passés, ${failed} échoués`);
process.exit(failed ? 1 : 0);
