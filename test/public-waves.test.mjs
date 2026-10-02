import assert from "node:assert/strict";
import worker, {
  canonicalWaveSlots,
  configuredWaveSlots,
  withConfiguredEmptyWaves,
  withPreopenedWave,
} from "../src/index.js";

const originalCaches = globalThis.caches;
const originalDateNow = Date.now;

function makeEnv() {
  return {
    DATA_RETENTION_DAYS: "14",
    DB: {
      prepare(sql) {
        if (sql.includes("FROM manual_wave_schedule")) {
          return { bind() { return this; }, async all() { return { results: [] }; } };
        }
        if (sql.includes("FROM public_wave_snapshots")) {
          return { bind() { return this; }, async first() { return null; } };
        }
        if (sql.includes("INSERT INTO public_wave_snapshots")) {
          return { bind() { return this; }, async run() { return { success: true }; } };
        }
        if (sql.includes("FROM wave_materialization_state")) {
          return { bind() { return this; }, async first() { return null; } };
        }
        if (/INSERT (?:OR IGNORE )?INTO wave_(?:product|active|eligible|materialization)/.test(sql)) {
          return { sql, bind() { return this; } };
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
                product_selection_rate: 0.04,
                image_url: "https://prixtcg.fr/images/p1018.png?v=2664-media13",
              }] };
            },
          };
        }
        assert.match(sql, /configured_bounds/);
        assert.match(sql, /JOIN wave_product_instances/);
        assert.match(sql, /JOIN wave_active_instances/);
        assert.match(sql, /FROM wave_eligible_instances/);
        assert.doesNotMatch(sql, /FROM feedback_hourly/);
        assert.match(sql, /c\.last_used_at - c\.created_at > 3600/);
        assert.match(sql, /FROM invitation_wave_products archived_product/);
        assert.match(sql, /i\.image_url AS catalog_image_url/);
        assert.match(sql, /COALESCE\(\s*x\.image_url,\s*p\.catalog_image_url,/);
        assert.match(sql, /archived_product\.marketplace = p\.marketplace/);
        assert.match(sql, /archived_product\.asin = p\.asin/);
        assert.match(sql, /ORDER BY archived_wave\.started_at DESC/);
        return {
          bind(slots, cutoff) {
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
                image_url: "https://m.media-amazon.com/images/I/amphinobi-archive.jpg",
              },
            ] };
          },
        };
      },
      async batch(statements) {
        assert.equal(statements.length, 4);
        assert.match(statements[0].sql, /INSERT INTO wave_product_instances/);
        assert.match(statements[1].sql, /INSERT OR IGNORE INTO wave_active_instances/);
        assert.match(statements[2].sql, /INSERT OR IGNORE INTO wave_eligible_instances/);
        assert.match(statements[3].sql, /INSERT INTO wave_materialization_state/);
        return statements.map(() => ({ success: true }));
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

  const wednesdaySlots = canonicalWaveSlots(
    Date.parse("2026-09-16T10:00:00Z") / 1000,
    Date.parse("2026-09-15T00:00:00Z") / 1000,
  );
  assert.ok(wednesdaySlots.some((slot) => slot.started_at === Date.parse("2026-09-16T08:00:00Z") / 1000));

  const extendedWave = canonicalWaveSlots(
    Date.parse("2026-08-15T10:00:00Z") / 1000,
    Date.parse("2026-08-14T00:00:00Z") / 1000,
  ).find((slot) => slot.started_at === Date.parse("2026-08-14T08:00:00Z") / 1000);
  assert.equal(extendedWave.ended_at, Date.parse("2026-08-15T16:00:00Z") / 1000);

  const overlapStart = Date.parse("2026-09-30T08:00:00Z") / 1000;
  const overlapEnd = Date.parse("2026-10-01T08:00:00Z") / 1000;
  const overlappingSlots = await configuredWaveSlots({
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM manual_wave_schedule/);
        return {
          bind() { return this; },
          async all() {
            return { results: [{
              id: "manual-20260930-amazon",
              starts_at: overlapStart,
              ends_at: overlapEnd,
              label: "Vague Amazon du 30 septembre 2026",
            }] };
          },
        };
      },
    },
  }, Date.parse("2026-10-01T08:01:00Z") / 1000, Date.parse("2026-09-29T00:00:00Z") / 1000);
  const exactWindow = overlappingSlots.filter(
    (slot) => slot.started_at === overlapStart && slot.ended_at === overlapEnd,
  );
  assert.equal(exactWindow.length, 1, "un créneau manuel ne doit pas doubler une vague canonique");
  assert.equal(exactWindow[0].id, String(overlapStart), "le créneau canonique reste la référence");

  const beforePreopen = withPreopenedWave(
    { generated_at: 1, waves: [] },
    Date.parse("2026-08-07T07:54:59Z") / 1000,
  );
  assert.equal(beforePreopen.waves.length, 0);
  const preopened = withPreopenedWave(
    { generated_at: 1, waves: [] },
    Date.parse("2026-08-07T07:55:00Z") / 1000,
  );
  assert.equal(preopened.waves.length, 1);
  assert.equal(preopened.waves[0].started_at, Date.parse("2026-08-07T08:00:00Z") / 1000);
  assert.equal(preopened.waves[0].products, 0);
  assert.deepEqual(preopened.waves[0].items, []);

  const manualEmpty = withConfiguredEmptyWaves(
    { generated_at: 1, waves: [] },
    [{
      id: "manual-pokemon-30",
      started_at: Date.parse("2026-09-18T08:00:00Z") / 1000,
      ended_at: Date.parse("2026-09-19T08:00:00Z") / 1000,
      source: "manual",
    }],
    Date.parse("2026-09-18T08:00:01Z") / 1000,
  );
  assert.equal(manualEmpty.waves.length, 1);
  assert.equal(manualEmpty.waves[0].id, "manual-pokemon-30");
  assert.equal(manualEmpty.waves[0].products, 0);
  assert.deepEqual(manualEmpty.waves[0].items, []);

  globalThis.caches = undefined;
  const response = await worker.fetch(new Request("https://api.test/api/public/waves"), makeEnv(), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /s-maxage=60/);
  const payload = await response.json();
  assert.equal(payload.waves.length, 3);
  const liveWave = payload.waves.find((wave) => wave.id === "1785790156");
  assert.equal(liveWave.active_users, 396);
  assert.equal(liveWave.finalized, false, "une vague calculée en direct ne doit pas déclencher la notification");
  assert.equal(liveWave.detected_at, 1785790716);
  assert.match(payload.methodology, /installation durable/);
  assert.equal(liveWave.items.length, 2);
  assert.equal(liveWave.items[0].selection_rate, 10 / 120);
  assert.equal(liveWave.items[0].image_url, "https://m.media-amazon.com/images/I/tripack.jpg");
  assert.equal(
    liveWave.items[1].image_url,
    "https://m.media-amazon.com/images/I/amphinobi-archive.jpg",
    "une vague live sans image récente doit reprendre la dernière image archivée",
  );
  const archivedWave = payload.waves.find((wave) => wave.id === "1785000000");
  assert.equal(archivedWave.items[0].name, "Produit archivé");
  assert.equal(
    archivedWave.items[0].image_url,
    "https://prixtcg.fr/images/p1018.png?v=2664-media13",
    "une image produit PrixTCG explicitement servie sous /images doit rester publique",
  );
  assert.equal(archivedWave.finalized, true, "seule une vague archivée est figée");

  let reads = 0;
  globalThis.caches = {
    default: {
      async match() {
        return new Response(JSON.stringify({ generated_at: 1, next_refresh_at: 9_999_999_999, waves: [] }));
      },
      async put() {},
    },
  };
  const cached = await worker.fetch(new Request("https://api.test/api/public/waves"), {
    DB: { prepare() { reads += 1; } },
  }, {});
  assert.equal(cached.headers.get("X-Amzinvite-Cache"), "HIT");
  assert.match(cached.headers.get("Cache-Control"), /s-maxage=60/);
  assert.equal((await cached.json()).waves.length, 1);
  assert.equal(reads, 0);

  globalThis.caches = {
    default: {
      async match() {
        return new Response(JSON.stringify({
          generated_at: 1,
          next_refresh_at: Math.floor(Date.now() / 1000) - 1,
          waves: [{ id: "stale-live", finalized: false, items: [] }],
        }));
      },
      async put() {},
    },
  };
  const recovered = await worker.fetch(new Request("https://api.test/api/public/waves"), makeEnv(), {});
  assert.equal(recovered.headers.get("X-Amzinvite-Cache"), "MISS");
  const recoveredPayload = await recovered.json();
  assert.equal(recoveredPayload.generated_at, Math.floor(Date.now() / 1000));
  assert.ok(recoveredPayload.next_refresh_at > recoveredPayload.generated_at,
    "une échéance dépassée doit forcer le recalcul au lieu de figer le snapshot live");

  globalThis.caches = undefined;
  let snapshotReads = 0;
  const snapshotPayload = { generated_at: 123, next_refresh_at: 9_999_999_999, waves: [] };
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
  const snapshotResponse = await snapshotted.json();
  assert.equal(snapshotResponse.generated_at, snapshotPayload.generated_at);
  assert.equal(snapshotResponse.waves.length, 1);
  assert.deepEqual(snapshotResponse.waves[0].items, []);
  assert.equal(snapshotReads, 1, "un cache miss régional ne doit lire qu'une ligne D1");

  console.log("public waves: 3 passés, 0 échoué");
} finally {
  globalThis.caches = originalCaches;
  Date.now = originalDateNow;
}
