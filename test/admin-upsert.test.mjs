import assert from "node:assert/strict";

import worker from "../src/index.js";

let batchStatements = [];
const env = {
  ADMIN_TOKEN: "upsert-test-token",
  DB: {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
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
    }],
  }),
}), env, {});

assert.equal(response.status, 200);
assert.equal(batchStatements.length, 1);
assert.match(batchStatements[0].sql, /WHERE invitations\.first_seen IS NOT excluded\.first_seen/);
assert.equal(batchStatements[0].args[0], "B0TEST0001");
assert.equal(batchStatements[0].args[4], null);

console.log("admin upsert : les lignes identiques ne sont plus réécrites");
