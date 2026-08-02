import assert from "node:assert/strict";

import worker from "../src/index.js";

let batchStatements = [];
let runStatements = [];
const env = {
  ADMIN_TOKEN: "upsert-test-token",
  DB: {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { runStatements.push(this); return { success: true }; },
      };
    },
    async batch(statements) {
      batchStatements = statements;
      return statements.map(() => ({ success: true }));
    },
  },
};

const response = await worker.fetch(new Request("https://api.test/api/admin/upsert", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Admin-Token": "upsert-test-token",
  },
  body: JSON.stringify({
    invitations: [{
      asin: "b0test0001",
      url: "https://www.amazon.fr/dp/B0TEST0001",
      name: "Test",
      active: true,
    }, {
      asin: "b0test0001",
      marketplace: "amazon.com.be",
      url: "https://www.amazon.com.be/dp/B0TEST0001",
      name: "Test BE",
      active: true,
      is_mirror: true,
    }],
    marketplaces: ["amazon.fr", "amazon.com.be"],
  }),
}), env, {});

assert.equal(response.status, 200);
assert.equal(batchStatements.length, 2);
assert.match(batchStatements[0].sql, /WHERE invitations\.first_seen IS NOT excluded\.first_seen/);
assert.equal(batchStatements[0].args[0], "B0TEST0001");
assert.equal(batchStatements[0].args[4], null);
assert.equal(batchStatements[0].args[3], "amazon.fr");
assert.equal(batchStatements[1].args[3], "amazon.com.be");
assert.equal(batchStatements[1].args[10], 1);

const emptyBelgianSnapshot = await worker.fetch(new Request("https://api.test/api/admin/upsert", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Admin-Token": "upsert-test-token",
  },
  body: JSON.stringify({ invitations: [], marketplaces: ["amazon.com.be"] }),
}), env, {});
assert.equal(emptyBelgianSnapshot.status, 200);
assert.match(runStatements.at(-1).sql, /WHERE marketplace = \? AND active = 1/);
assert.deepEqual(runStatements.at(-1).args.slice(1), ["amazon.com.be"]);

const invalidDomain = await worker.fetch(new Request("https://api.test/api/admin/upsert", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Admin-Token": "upsert-test-token",
  },
  body: JSON.stringify({
    invitations: [{
      asin: "B0TEST0002",
      marketplace: "amazon.com.be",
      url: "https://www.amazon.fr/dp/B0TEST0002",
    }],
  }),
}), env, {});
assert.equal(invalidDomain.status, 400);

console.log("admin upsert : coexistence FR/BE, snapshot isolé et domaine strict");
