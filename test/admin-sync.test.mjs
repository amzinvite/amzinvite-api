import assert from "node:assert/strict";

import worker from "../src/index.js";

const prepared = [];
const env = {
  ADMIN_TOKEN: "sync-test-token",
  DB: {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async all() {
          return { results: [{ asin: "B0TEST0001", last_seen: 1785609600 }] };
        },
      };
      prepared.push(statement);
      return statement;
    },
  },
};

const response = await worker.fetch(new Request(
  "https://api.test/api/admin/sync?since=1785600000",
  { headers: { "X-Admin-Token": "sync-test-token" } },
), env, {});

assert.equal(response.status, 200);
assert.equal(prepared.length, 1);
assert.deepEqual(prepared[0].args, [1785600000]);
assert.match(prepared[0].sql, /o\.received_at > \?/);
assert.doesNotMatch(prepared[0].sql, /FROM observations priced/);
assert.deepEqual((await response.json()).observations, [
  { asin: "B0TEST0001", last_seen: 1785609600 },
]);

console.log("admin sync : lecture incrémentale unique, sans recherche corrélée par ASIN");
