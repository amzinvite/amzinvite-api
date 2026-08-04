import assert from "node:assert/strict";
import worker, { canonicalWaveStart } from "../src/index.js";

const originalCaches = globalThis.caches;

function makeEnv() {
  return {
    DATA_RETENTION_DAYS: "14",
    DB: {
      prepare(sql) {
        if (sql.includes("FROM invitation_waves")) {
          return {
            async all() {
              return { results: [{
                id: "1785000000", started_at: 1785000000, ended_at: 1785086400,
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
        assert.match(sql, /accepted_runs/);
        return {
          bind(cutoff) {
            assert.ok(Number.isFinite(cutoff));
            return this;
          },
          async all() {
            return { results: [
              {
                wave_id: 1, started_at: 1785790156, ended_at: 1785876556,
                selected_users: 43, validations: 48, products: 2,
                active_users: 396, installations: 1267,
                marketplace: "amazon.fr", asin: "B0GZLFCR67",
                name: "Tripack Nuit Noire", product_selected_users: 10,
                product_validations: 10, eligible_users: 120,
                image_url: "https://m.media-amazon.com/images/I/tripack.jpg",
              },
              {
                wave_id: 1, started_at: 1785790156, ended_at: 1785876556,
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
  assert.equal(
    canonicalWaveStart(Date.parse("2026-08-03T18:09:16Z") / 1000),
    Date.parse("2026-08-03T20:00:00Z") / 1000,
  );
  assert.equal(
    canonicalWaveStart(Date.parse("2026-07-17T10:04:13Z") / 1000),
    Date.parse("2026-07-17T09:30:00Z") / 1000,
  );
  globalThis.caches = undefined;
  const response = await worker.fetch(new Request("https://api.test/api/public/waves"), makeEnv(), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /s-maxage=3600/);
  const payload = await response.json();
  assert.equal(payload.waves.length, 2);
  assert.equal(payload.waves[0].active_users, 396);
  assert.equal(payload.waves[0].items.length, 2);
  assert.equal(payload.waves[0].items[0].selection_rate, 10 / 120);
  assert.equal(payload.waves[0].items[0].image_url, "https://m.media-amazon.com/images/I/tripack.jpg");
  assert.equal(payload.waves[0].items[1].image_url, null);
  assert.equal(payload.waves[1].items[0].name, "Produit archivé");

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
  assert.equal(reads, 0);

  console.log("public waves: 2 passés, 0 échoué");
} finally {
  globalThis.caches = originalCaches;
}
