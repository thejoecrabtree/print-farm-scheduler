// The simulator is an example, but it exercises every piece together, so a short run is a useful end-to-end test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../examples/simulate.mjs";

test("simulate: three days on ten printers - plates print, the goals change mid-run, hand-placed and started plates survive Apply", async () => {
  const lines = [];
  const out = await simulate({ days: 3, goalAt: { day: 1, time: "09:00" }, orderAt: { day: 0, time: "10:00" }, goalText: "more dragons, half the minis, 2 sea serpents by Wednesday", print: (s) => lines.push(s) });
  assert.equal(out.autoPlan.applied, true, "Monday's plan applied itself (no warnings)");
  assert.ok(out.okPlates > 60, `plates printed (${out.okPlates})`);
  assert.equal(out.goals.untouched, true);
  assert.ok(out.goals.ms < 2000);
  assert.ok(out.loads < out.naiveLoads, `fewer spool loads than the naive baseline (${out.loads} vs ${out.naiveLoads})`);
  assert.ok(lines.some((l) => /the board/.test(l)) && lines.some((l) => /spool loads/.test(l)));
  // same seed, same week
  const again = await simulate({ days: 3, goalAt: { day: 1, time: "09:00" }, orderAt: { day: 0, time: "10:00" }, goalText: "more dragons, half the minis, 2 sea serpents by Wednesday", print: () => {} });
  assert.deepEqual([again.okPlates, again.loads, again.failures], [out.okPlates, out.loads, out.failures]);
});
