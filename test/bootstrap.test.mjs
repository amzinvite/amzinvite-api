import assert from "node:assert/strict";
import worker, { initialWaveScanOffset } from "../src/index.js";

const INSTANCE_ID = "01234567-89ab-4def-8123-456789abcdef";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "bootstrap-v2-secret";
const PATH = "/api/extension/bootstrap?marketplaces=amazon.fr";

const sampleOffsets = Array.from({ length: 1000 }, (_, index) =>
  initialWaveScanOffset(`installation-${String(index).padStart(4, "0")}`));
assert.ok(sampleOffsets.every((offset) => offset >= 0 && offset <= 28));
const canaryShare = sampleOffsets.filter((offset) => offset <= 1).length / sampleOffsets.length;
assert.ok(canaryShare >= 0.07 && canaryShare <= 0.13);

async function signedRequest() {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(PATH + timestamp),
  );
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`https://api.test${PATH}`, {
    headers: {
      "X-Instance-Id": INSTANCE_ID,
      "X-Auth-Version": "2",
      "X-Credential-Id": CREDENTIAL_ID,
      "X-Ts": String(timestamp),
      "X-Sig": signatureHex,
    },
  });
}

const originalCaches = globalThis.caches;
try {
  globalThis.caches = {
    default: {
      async match() {
        return new Response(JSON.stringify({
          waves: [{ id: "wave-final", finalized: true, ended_at: 1, selected_users: 12, products: 2 }],
        }));
      },
      async put() {},
    },
  };
  const env = {
    FEED_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: {
      prepare(sql) {
        return {
          bind(...args) { this.args = args; return this; },
          async first() {
            if (/FROM extension_credentials/.test(sql)) {
              return { secret: SECRET, scope: "instance", instance_id: INSTANCE_ID, expires_at: null, revoked: 0 };
            }
            return null;
          },
          async run() { return {}; },
          async all() {
            if (/FROM invitations/.test(sql)) {
              return { results: [{ asin: "B0TEST0001", marketplace: "amazon.fr", url: "https://www.amazon.fr/dp/B0TEST0001", first_seen: 1 }] };
            }
            return { results: [] };
          },
        };
      },
    },
  };
  const response = await worker.fetch(await signedRequest(), env, {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.invitations.length, 1);
  assert.equal(payload.latest_finalized_wave.id, "wave-final");
  assert.deepEqual(payload.schedule.scan_offsets_minutes, [
    initialWaveScanOffset(INSTANCE_ID), 60, 180, 360, 720, 1380,
  ]);
  assert.ok(payload.schedule.scan_offsets_minutes[0] >= 0);
  assert.ok(payload.schedule.scan_offsets_minutes[0] <= 28);
  assert.equal(payload.schedule.jitter_minutes, 1);
  assert.equal(payload.schedule.version, "2026-08-14.1");
  assert.ok(payload.schedule.waves.length >= 2);
  console.log("bootstrap : feed, calendrier intelligent et dernière vague finalisée");
} finally {
  globalThis.caches = originalCaches;
}
