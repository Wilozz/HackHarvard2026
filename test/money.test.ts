import assert from "node:assert/strict";
import { test } from "node:test";
import { nightsBetween, roomsNeeded, splitShares, stayTotalUsd } from "../src/trip/money";

test("counts nights and rejects bad or backwards dates", () => {
  assert.equal(nightsBetween("2026-12-19", "2026-12-22"), 3);
  assert.equal(nightsBetween("2026-12-31", "2027-01-02"), 2);
  assert.equal(nightsBetween("2026-12-22", "2026-12-19"), undefined);
  assert.equal(nightsBetween("2026-12-19", "2026-12-19"), undefined);
  assert.equal(nightsBetween("2026-02-30", "2026-03-02"), undefined);
  assert.equal(nightsBetween("Dec 19", "2026-12-22"), undefined);
});

test("rooms and totals", () => {
  assert.equal(roomsNeeded(4, 2), 2);
  assert.equal(roomsNeeded(5, 2), 3);
  assert.equal(roomsNeeded(3, 4), 1);
  assert.equal(stayTotalUsd(165, 3, 2), 990);
});

test("whole-dollar shares never exceed the bill and skip the payer", () => {
  const shares = splitShares(990, ["Matias", "Harsh", "Hetarth", "wiloz"], "Matias");
  assert.deepEqual([...shares], [
    ["Harsh", 247],
    ["Hetarth", 247],
    ["wiloz", 247],
  ]);
  const owed = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.ok(owed <= 990 * (3 / 4));
});

test("payer must be on the trip", () => {
  assert.throws(() => splitShares(100, ["A", "B"], "C"));
});
