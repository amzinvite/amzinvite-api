import assert from "node:assert/strict";

import {
  normalizeObservationPrice,
  normalizeObservationStock,
} from "../src/index.js";

assert.equal(normalizeObservationPrice(11.99), 1199);
assert.equal(normalizeObservationPrice("14.90"), 1490);
assert.equal(normalizeObservationPrice(null), null);
assert.equal(normalizeObservationPrice("prix invalide"), null);
assert.equal(normalizeObservationPrice(-1), null);

assert.equal(normalizeObservationStock(true), 1);
assert.equal(normalizeObservationStock(1), 1);
assert.equal(normalizeObservationStock(false), 0);
assert.equal(normalizeObservationStock(0), 0);
assert.equal(normalizeObservationStock(null), null);
assert.equal(normalizeObservationStock(undefined), null);

console.log("  ✓ observations : prix validés et stock tri-state préservé");
