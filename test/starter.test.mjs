import { test } from "node:test";
import assert from "node:assert/strict";
import * as lines from "../src/lines.mjs";
import * as starter from "../src/starter.mjs";
import { atLab } from "../src/labtime.mjs";

const TZ = "America/Chicago";
const t = atLab("2026-09-23", "08:00", TZ);
const printer = (key, extra = {}) => ({ key, name: key, number: Number(key.slice(-1)), model: "P2S", active: true, autoStart: true, driverId: 1, plateOn: true, ...extra });
const idle = (trays = [{ ams: 0, slot: 0, type: "PLA", color: "#161616" }]) => ({ connected: true, state: "IDLE", remainingMin: 0, trays, amsSlots: 4 });
const plate = (id, extra = {}) => ({ id, title: `Toy ${id}`, status: "waiting", file: { id: 1, model: "P2S" }, minutes: 60, source: { type: "stock" }, colours: "loaded", createdAt: "2026-09-20T00:00:00Z", filaments: [{ type: "PLA", color: "#161616" }], ...extra });
const stateOf = (printers, plates) => ({ printers: Object.fromEntries(printers.map((p) => [p.key, p])), plates: Object.fromEntries(plates.map((p) => [p.id, p])), order: plates.map((p) => p.id), settings: { tz: TZ } });

test("starter: each line's head once its time has come, the longest-waiting line first; every gate says why", () => {
  const s = stateOf([printer("p1"), printer("p2"), printer("p3", { plateOn: false }), printer("p4", { autoStart: false })],
    [plate("A", { printer: "p1" }), plate("B", { printer: "p2", at: new Date(t + 3600_000).toISOString() }), plate("C", { printer: "p3" }), plate("D", { printer: "p4" })]);
  const live = { p1: idle(), p2: idle(), p3: idle(), p4: idle() };
  const { picks, why } = starter.linePicks(lines.build(s, live, { t }), s, live, { t });
  assert.deepEqual(picks.map((p) => p.plate), ["A"]);
  assert.match(why.p2, /not before/); assert.match(why.p3, /build plate/); assert.match(why.p4, /auto-start is off/);
});

test("starter: a Recommended job waits for its colour unless someone said go ahead; an Automatic one prints in what is loaded", () => {
  const s = stateOf([printer("p1")], [plate("R", { printer: "p1", colours: "match", filaments: [{ type: "PLA", color: "#FF6A13" }] })]);
  const live = { p1: idle() };
  const built = lines.build(s, live, { t });
  assert.equal(starter.linePicks(built, s, live, { t }).why.p1, "waiting for a colour");
  assert.equal(starter.linePicks(built, s, live, { t, colourOk: () => true }).picks[0]?.plate, "R");
  s.plates.R.colours = "loaded";
  assert.equal(starter.linePicks(lines.build(s, live, { t }), s, live, { t }).picks[0]?.plate, "R");
});

test("starter: lineDue answers from time and holds only (for waking a sleeping printer)", () => {
  const s = stateOf([printer("p1"), printer("p2", { stopped: { by: "operator" } })], [plate("A", { printer: "p1" }), plate("B", { printer: "p2" })]);
  const built = lines.build(s, {}, { t });
  assert.equal(starter.lineDue(built, "p1", t), true);
  assert.equal(starter.lineDue(built, "p2", t), false, "a stopped printer is never due");
});
