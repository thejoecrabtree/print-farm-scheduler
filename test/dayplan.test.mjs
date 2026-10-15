import { test } from "node:test";
import assert from "node:assert/strict";
import { dayPlan } from "../src/dayplan.mjs";

const tray = (ams, slot, color, name, remain = 80) => ({ ams, slot, type: "PLA", color, name, remain });
const live = {
  "p2s-1": { connected: true, amsSlots: 4, trays: [tray(0, 0, "#FF0000", "Red"), tray(0, 1, "#0000FF", "Blue"), tray(0, 2, "#FFFFFF", "White", 10)] },
  "p2s-2": { connected: true, amsSlots: 4, trays: [tray(0, 0, "#00FF00", "Green")] },
};
const state = {
  printers: { "p2s-1": { key: "p2s-1", name: "Printer 4", model: "Bambu Lab P2S", active: true, number: 4 }, "p2s-2": { key: "p2s-2", name: "Printer 5", model: "Bambu Lab P2S", active: true, number: 5 } },
  order: ["a", "b", "c", "d"],
  plates: {
    a: { id: "a", title: "red+blue dragon", status: "waiting", minutes: 200, filaments: [{ type: "PLA", color: "#FF0000", grams: 30 }, { type: "PLA", color: "#0000FF", grams: 20 }] },
    b: { id: "b", title: "green frog", status: "waiting", minutes: 100, filaments: [{ type: "PLA", color: "#00FF00", grams: 40 }] },
    c: { id: "c", title: "black cat", status: "waiting", minutes: 300, filaments: [{ type: "PLA", color: "#111111", grams: 50 }] },
    d: { id: "d", title: "red-ish car", status: "waiting", minutes: 50, filaments: [{ type: "PLA", color: "#F51010", grams: 10 }] },   // close to Red: same spool
  },
};

test("day plan: plates go to the printer whose set covers them; a new colour joins the emptier set; near colours share a spool", () => {
  const plan = dayPlan(state, live);
  assert.equal(plan.printerOf.a, "p2s-1");      // red + blue already loaded there
  assert.equal(plan.printerOf.b, "p2s-2");      // green
  assert.equal(plan.printerOf.d, "p2s-1");      // #F51010 counts as red
  assert.equal(plan.printerOf.c, "p2s-2", "black is on nobody: it goes to the printer with the least planned minutes (100 vs 250)");
  const p5 = plan.printers.find((p) => p.key === "p2s-2"), p4 = plan.printers.find((p) => p.key === "p2s-1");
  assert.equal(p5.loads.length, 1); assert.equal(p5.loads[0].color, "#111111"); assert.equal(p5.loads[0].empty, true); assert.equal(p5.loads[0].slot, 1);
  assert.equal(p5.swaps, 0); assert.equal(p5.plates, 2);
  assert.deepEqual(p4.loads, []); assert.equal(p4.keep.length, 2, "white is loaded but nobody needs it today");
  assert.equal(p4.plates, 2);
});

test("day plan: a full AMS swaps out the least-needed spool; a plate with more colours than slots is left to the per-plate list", () => {
  const l = { "p2s-1": { connected: true, amsSlots: 4, trays: [tray(0, 0, "#FF0000", "Red"), tray(0, 1, "#0000FF", "Blue"), tray(0, 2, "#FFFFFF", "White", 10), tray(0, 3, "#00FF00", "Green", 60)] } };
  const st = { printers: { "p2s-1": state.printers["p2s-1"] }, order: ["x", "y"], plates: {
    x: { id: "x", title: "purple", status: "waiting", minutes: 60, filaments: [{ type: "PLA", color: "#800080", grams: 20 }] },
    y: { id: "y", title: "rainbow", status: "waiting", minutes: 60, filaments: ["#111111", "#FF00FF", "#00FFFF", "#FFFF00", "#FF8800"].map((c) => ({ type: "PLA", color: c, grams: 5 })) },
  } };
  const plan = dayPlan(st, l);
  const p4 = plan.printers[0];
  assert.equal(plan.printerOf.x, "p2s-1");
  assert.equal(p4.loads.length, 1); assert.equal(p4.loads[0].empty, false); assert.equal(p4.loads[0].replaces, "White", "least left, not needed");
  assert.equal(plan.printerOf.y, undefined); assert.equal(p4.unplanned, 1);
});

test("day plan: `include` limits the plan to today's plates", () => {
  const plan = dayPlan(state, live, { include: (pid) => pid === "a" || pid === "b" });
  assert.deepEqual(Object.keys(plan.printerOf).sort(), ["a", "b"]);
  assert.ok(plan.printers.every((p) => !p.loads.length), "today's plates are covered by what is loaded");
});
