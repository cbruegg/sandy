import { test } from "bun:test";
import assert from "node:assert/strict";
import { calculateExponentialBackoffMs } from "./exponential-backoff.js";

test("exponential backoff grows and caps", () => {
  assert.equal(calculateExponentialBackoffMs(1, 250, 5_000), 250);
  assert.equal(calculateExponentialBackoffMs(2, 250, 5_000), 500);
  assert.equal(calculateExponentialBackoffMs(3, 250, 5_000), 1_000);
  assert.equal(calculateExponentialBackoffMs(10, 250, 5_000), 5_000);
});

test("exponential backoff normalizes invalid values", () => {
  assert.equal(calculateExponentialBackoffMs(0, 250, 5_000), 250);
  assert.equal(calculateExponentialBackoffMs(Number.NaN, 250, 5_000), 250);
  assert.equal(calculateExponentialBackoffMs(2, Number.NaN, 5_000), 2_000);
  assert.equal(calculateExponentialBackoffMs(2, 250, Number.NaN), 250);
});
