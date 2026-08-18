import assert from "node:assert/strict";
import worker, { canonicalWaveSlots } from "../src/index.js";

const originalCaches = globalThis.caches;
const originalDateNow = Date.now;

function makeEnv() {
  return {
    DATA_RETENTION_DAYS: "14",
    DB: {
      prepare(sql) {
        if (sql.includes("FROM public_wave_snapshots")) {
          return { bind() { return this; }, async first() { return null; } };
        }
        if (sql.includes("INSERT INTO public_wave_snapshots")) {
          return { bind() { return this; }, async run() { return { success: true }; } };
        }
        if (sql.includes("FROM invitation_waves")) {
          return {
            async all() {
              return { results: [{
                id: "1785000000", started_at: 1785000000, detected_at: 1785000123, ended_at: 1785086400,
                selected_users: 12, validations: 14, products: 1,
                active_users: 200, installations: 1100, selection_rate: 0.06,
                marketplace: "amazon.fr", asin: "B0ARCHIVE1",
                name: "Produit archivé", product_selected_users: 4,
                product_validations: 4, eligible_users: 100,
                product_selection_rate: 0.04, image_url: null,
              }] };
            },
          };
        }
        assert.match(sql, /configured_bounds/);
        assert.doesNotMatch(sql, /accepted_runs/);
        assert.match(sql, /state IN \('available', 'accepted'\)/);
        assert.match(sql, /s\.signal_at >= b\.started_at - 900/);
        assert.match(sql, /s\.signal_at < b\.ended_at \+ 10800/);
        assert.match(sql, /b\.ended_at/);
        assert.match(sql, /MIN\(s\.signal_at\) AS detected_at/);
        assert.match(sql, /HAVING COUNT\(DISTINCT s\.instance_id\) >= 2/);
        assert.match(sql, /LEFT JOIN acceptance_events/);
        assert.doesNotMatch(sql, /selected_product_summary/);
        assert.match(sql, /CASE WHEN a\.instance_id IS NOT NULL/);
        assert.match(sql, /a\.marketplace = p\.marketplace AND a\.asin = p\.asin/);
        assert.doesNotMatch(sql, /COUNT\(DISTINCT p\.asin\) AS products/);
        assert.match(sql, /c\.last_used_at - c\.created_at > 3600/);
        return {
          bind(cutoff, slots) {
            assert.ok(Number.isFinite(cutoff));
            const parsedSlots = JSON.parse(slots);
            assert.equal(parsedSlots.length, 1, "seule la vague active doit être calculée");
            assert.equal(cutoff, parsedSlots[0].started_at - 86400,
              "le scan doit commencer à J-1 pour le calcul d'éligibilité");
            return this;
          },
          async all() {
            return { results: [
              {
                wave_id: 1, started_at: 1785790156, detected_at: 1785790716, ended_at: 1785876556,
                selected_users: 43, validations: 48, products: 2,
                active_users: 396, installations: 1267,
                marketplace: "amazon.fr", asin: "B0GZLFCR67",
                name: "Tripack Nuit Noire", product_selected_users: 10,
                product_validations: 10, eligible_users: 120,
                image_url: "https://m.media-amazon.com/images/I/tripack.jpg",
              },
              {
                wave_id: 1, started_at: 1785790156, detected_at: 1785790716, ended_at: 1785876556,
                selected_users: 43, validations: 48, products: 2,
                active_users: 396, installations: 1267,
                marketplace: "amazon.fr", asin: "B0H294B5WK",
                name: "Méga-Amphinobi-ex", product_selected_users: 19,
                product_validations: 19, eligible_users: 180,
                image_url: "https://tracker.example/image.jpg",
              },
            ] };
          },
        };
      },
    },
  };
}

try {
  Date.now = () => Date.parse("2026-08-07T10:00:00Z");
  const fridaySlots = canonicalWaveSlots(
    Date.parse("2026-08-07T10:00:00Z") / 1000,
    Date.parse("2026-07-24T10:00:00Z") / 1000,
  );
  assert.ok(fridaySlots.some((slot) => slot.started_at === Date.parse("2026-08-07T08:00:00Z") / 1000));
  assert.ok(fridaySlots.some((slot) => slot.started_at === Date.parse("2026-08-03T20:00:00Z") / 1000));

  const extendedWave = canonicalWaveSlots(
    Date.parse("2026-08-15T10:00:00Z") / 1000,
    Date.parse("2026-08-14T00:00:00Z") / 1000,
  ).find((slot) => slot.started_at === Date.parse("2026-08-14T08:00:00Z") / 1000);
  assert.equal(extendedWave.ended_at, Date.parse("2026-08-15T16:00:00Z") / 1000);

  globalThis.caches = undefined;
  const response = await worker.fetch(new Request("https://api.test/api/public/waves"), makeEnv(), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /s-maxage=60/);
  const payload = await response.json();
  assert.equal(payload.waves.length, 2);
  assert.equal(payload.waves[0].active_users, 396);
  assert.equal(payload.waves[0].finalized, false, "une vague calculée en direct ne doit pas déclencher la notification");
  assert.equal(payload.waves[0].detected_at, 1785790716);
  assert.match(payload.methodology, /installation durable/);
  assert.equal(payload.waves[0].items.length, 2);
  assert.equal(payload.waves[0].items[0].selection_rate, 10 / 120);
  assert.equal(payload.waves[0].items[0].image_url, "https://m.media-amazon.com/images/I/tripack.jpg");
  assert.equal(payload.waves[0].items[1].image_url, null);
  assert.equal(payload.waves[1].items[0].name, "Produit archivé");
  assert.equal(payload.waves[1].finalized, true, "seule une vague archivée est figée");

  let reads = 0;
  globalThis.caches = {
    default: {
      async match() {
        return new Response(JSON.stringify({ generated_at: 1, waves: [] }));
      },
      async put() {},
    },
  };
  const cached = await worker.fetch(new Request("https://api.test/api/public/waves"), {
    DB: { prepare() { reads += 1; } },
  }, {});
  assert.equal(cached.headers.get("X-Amzinvite-Cache"), "HIT");
  assert.match(cached.headers.get("Cache-Control"), /s-maxage=300/);
  assert.equal(reads, 0);

  globalThis.caches = undefined;
  let snapshotReads = 0;
  const snapshotPayload = { generated_at: 123, waves: [] };
  const snapshotted = await worker.fetch(new Request("https://api.test/api/public/waves"), {
    DB: {
      prepare(sql) {
        snapshotReads += 1;
        assert.match(sql, /FROM public_wave_snapshots/);
        return {
          bind() { return this; },
          async first() { return { payload: JSON.stringify(snapshotPayload) }; },
        };
      },
    },
  }, {});
  assert.equal(snapshotted.headers.get("X-Amzinvite-Cache"), "D1-SNAPSHOT");
  assert.deepEqual(await snapshotted.json(), snapshotPayload);
  assert.equal(snapshotReads, 1, "un cache miss régional ne doit lire qu'une ligne D1");

  console.log("public waves: 3 passés, 0 échoué");
} finally {
  globalThis.caches = originalCaches;
  Date.now = originalDateNow;
}
