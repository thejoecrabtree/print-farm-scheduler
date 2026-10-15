// Fill tops up the printer lines: 3 days ahead by default; Apply of new goals may replace unpinned, not-started stock plates; a
// periodic fill only adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as filler from "../src/filler.mjs";
import * as lines from "../src/lines.mjs";
import * as W from "../src/week.mjs";
import { atLab } from "../src/labtime.mjs";

const TZ = "America/Chicago";
const at = (day, hhmm) => atLab(day, hhmm, TZ);
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const WED = "2026-09-23";
const T0 = at(WED, "08:00");
const printer = (key, extra = {}) => ({ key, name: key.toUpperCase(), number: { a: 1, b: 2, c: 3 }[key] ?? 9, model: "P2S", active: true, autoStart: true, driverId: 1, plateOn: true, ...extra });
const tray = (color, type = "PLA") => ({ ams: 0, type, color });
const idle = (colours = [], slots = 4) => ({ connected: true, state: "IDLE", remainingMin: 0, trays: colours.map((c) => tray(c)), amsSlots: slots });
// a library file: a toy (category) sliced for the P2S, `minutes` long, in `colours`
const file = (id, { minutes = 240, colours = ["#000000"], category = "minis", model = "P2S", name = `Toy ${id} · ${model}` } = {}) => ({ id, name: `${name}.gcode.3mf`, model, sliced: true, category, minutes, grams: 40, filaments: colours.map((c) => ({ type: "PLA", color: c })), plates: [] });
const plate = (id, extra = {}) => ({ id, title: `Plate ${id}`, status: "waiting", file: { id: 900, model: "P2S" }, minutes: 60, source: { type: "stock" }, createdAt: "2026-09-20T00:00:00Z", ...extra });
const stateOf = (printers, plates = [], settings = {}) => ({ printers: Object.fromEntries(printers.map((p) => [p.key, p])), plates: Object.fromEntries(plates.map((p) => [p.id, p])), order: plates.map((p) => p.id), settings: { tz: TZ, swapMinutes: 15, mix: { minis: 100 }, ...settings } });
const run = (state, files, live, opts = {}) => filler.plan(state, files, { build: (s) => lines.build(s, live, { t: opts.t ?? T0, settings: s.settings }), t: T0, live, settings: state.settings, maxChanges: 1, ...opts });
const applied = (state, files, out) => { const s = structuredClone(state); filler.applyPlan(s, out, files, { by: "test", t: T0 }); return s; };

test("filler: fillDays defaults to 3", () => {
  assert.equal(filler.fillDaysOf({}), 3); assert.equal(filler.fillDaysOf({ fillDays: 2 }), 2); assert.equal(filler.fillDaysOf({ fillDays: -1 }), 3);
});

test("filler: tops a line up to ~3 days ahead and stops; a second fill adds nothing; new plates are pinned stock 'filled'", () => {
  const files = [file(1), file(2), file(3)];
  const state = stateOf([printer("a")]);
  const live = { a: idle(["#000000"]) };
  const out = run(state, files, live);
  assert.ok(out.add.length >= 8, `a 3-day line of 4-hour plates takes about a dozen (${out.add.length})`);
  const horizon = T0 + 3 * DAY;
  assert.equal(out.horizon, horizon);
  assert.ok(out.add.every((a) => a.start < horizon), "nothing starts past the horizon");
  const lastEnd = Math.max(...out.add.map((a) => a.end));
  assert.ok(lastEnd >= horizon - 12 * HOUR, "the line's work reaches the horizon (a swap after 22:00 waits for 06:30)");
  assert.ok(lastEnd <= horizon + 4 * HOUR + 15 * MIN, "and stops there - at most one plate over");
  for (let i = 1; i < out.add.length; i++) assert.ok(out.add[i].start >= out.add[i - 1].end + 15 * MIN, "each after the one ahead + the changeover");
  const s2 = applied(state, files, out);
  const made = Object.values(s2.plates);
  assert.equal(made.length, out.add.length);
  for (const p of made) { assert.equal(p.status, "waiting"); assert.equal(p.printer, "a"); assert.equal(p.pinnedPrinter, "a"); assert.equal(p.source.type, "stock"); assert.equal(p.source.note, "filled"); }
  const ws = lines.build(s2, live, { t: T0, settings: s2.settings }).lines.a.blocks.filter((b) => b.kind === "waiting");
  assert.equal(ws.length, out.add.length); assert.equal(ws[0].start, out.add[0].start); assert.equal(ws.at(-1).end, out.add.at(-1).end, "the lines draw them where the filler planned them");
  const again = run(s2, files, live);
  assert.equal(again.add.length, 0); assert.equal(again.remove.length, 0); assert.equal(again.lines.a.full, true);
  const one = run(stateOf([printer("a")], [], { fillDays: 1 }), files, live);
  assert.ok(one.add.length < out.add.length && one.add.every((a) => a.start < T0 + DAY), "fillDays = 1 fills a day");
});

test("filler: staffed hours - a plate swap after 22:00 waits for 06:30; a printer with no confirmed plate starts only when someone is there", () => {
  const files = [file(1, { minutes: 600 }), file(2, { minutes: 600 })];
  const live = { a: idle(["#000000"]) };
  const out = run(stateOf([printer("a")]), files, live, { t: at(WED, "20:00") });
  assert.equal(out.add[0].start, at(WED, "20:00"), "plate confirmed on: the first starts now, unattended");
  assert.equal(out.add[1].start, at("2026-09-24", "06:30"), "the swap waits for someone");
  const noPlate = run(stateOf([printer("a", { plateOn: false })]), files, live, { t: at(WED, "23:00") });
  assert.equal(noPlate.add[0].start, at("2026-09-24", "06:30"), "nobody confirmed the plate: the first start waits too");
});

test("filler: keeps the colours loaded - each toy goes to the printer holding its colours; a swap only inside the budget", () => {
  const red = "#FF0000", blue = "#0000FF";
  const files = [file(1, { colours: [red] }), file(2, { colours: [blue] })];
  const live = { a: idle([red], 1), b: idle([blue], 1) };   // one-slot AMS: a toy in the other colour is a whole colour change
  const out = run(stateOf([printer("a"), printer("b")]), files, live, { maxChanges: 0 });
  assert.ok(out.add.length > 4);
  for (const a of out.add) assert.equal(a.printer, a.fileId === 1 ? "a" : "b", `${a.name} on ${a.printer}`);
  assert.ok(out.add.every((a) => !a.swap), "no colour change");
  const solo = stateOf([printer("a")]);
  const none = run(solo, [file(2, { colours: [blue] })], { a: idle([red], 1) }, { maxChanges: 0 });
  assert.equal(none.add.length, 0); assert.match(none.unplaced[0].why, /colour-change budget/);
  const once = run(solo, [file(2, { colours: [blue] })], { a: idle([red], 1) }, { maxChanges: 1 });
  assert.ok(once.add.length > 1); assert.equal(once.add.filter((a) => a.swap).length, 1, "one swap, then blue stays loaded");
  assert.equal(once.lines.a.changes, 1);
  // the window: with a toy in the loaded colour close behind, a line takes it before paying for a swap
  const order = W.select([file(1, { colours: [blue] }), file(2, { colours: [red] })], stateOf([printer("a")]), { mode: "demand", slotsByModel: { P2S: 10 }, t: T0 }).jobs;
  assert.equal(order[0].fileId, 1, "select offers the blue toy first");
  const mixed = run(stateOf([printer("a")]), [file(1, { colours: [blue] }), file(2, { colours: [red] })], { a: idle([red], 1) }, { maxChanges: 1 });
  assert.equal(mixed.add[0].fileId, 2, "the red toy first on the red printer");
});

test("variety: the same toy is not put on two printers at once, nor twice in a row on one - unless told otherwise", () => {
  const files = [file(7, { minutes: 300 }), file(8, { minutes: 300 })];
  const demand = [{ sku: "toy-7", name: "Toy 7", plates: 4, file: { id: 7 } }];   // what sells asks for four of toy 7 first
  const live = { a: idle(["#000000"]), b: idle(["#000000"]) };
  const out = run(stateOf([printer("a"), printer("b")]), files, live, { demand });
  assert.ok(out.add.filter((a) => a.fileId === 7).length >= 4, "all four still planned (costs, not bans)");
  for (const x of out.add) for (const y of out.add) {
    if (x === y || x.fileId !== y.fileId) continue;
    assert.ok(!(x.printer !== y.printer && x.start < y.end && y.start < x.end), `toy ${x.fileId} on two printers at the same time`);
  }
  for (const k of ["a", "b"]) { const on = out.add.filter((x) => x.printer === k); for (let i = 1; i < on.length; i++) assert.notEqual(on[i].fileId, on[i - 1].fileId, `toy ${on[i].fileId} twice in a row on ${k}`); }
  const off = run(stateOf([printer("a"), printer("b")], [], { variety: false }), files, live, { demand });
  const first = off.add.slice(0, 2);
  assert.deepEqual(first.map((x) => x.fileId), [7, 7]); assert.notEqual(first[0].printer, first[1].printer); assert.equal(first[0].start, first[1].start, "variety off: both printers print toy 7 at once");
  const busy = stateOf([printer("a"), printer("b")], [plate("RUN", { status: "printing", printer: "b", file: { id: 8, model: "P2S" }, title: "Toy 8 · P2S", startedAt: new Date(T0 - HOUR).toISOString(), minutes: 300 })]);
  const o2 = run(busy, files, { a: idle(["#000000"]), b: { connected: true, state: "RUNNING", remainingMin: 240 } });
  assert.equal(o2.add.find((x) => x.printer === "a").fileId, 7, "what is already printing counts too: not the toy b is printing now");
});

test("variety per model: a printer with few toys of its model alternates them when its colours allow (the window is per model)", () => {
  const cols = (i) => ["#1", "#2", "#3", "#4"].map((c) => `${c}${String(i).padStart(5, "0")}`);
  const p2s = Array.from({ length: 12 }, (_, i) => file(10 + i, { minutes: 300, colours: cols(i) }));
  const files = [...p2s, file(30, { minutes: 300, model: "H2S" }), file(31, { minutes: 300, model: "H2S" })];
  const demand = [{ sku: "unicorn", name: "Unicorn", plates: 3, file: { id: 30 } }, ...p2s.map((f) => ({ sku: `t${f.id}`, name: `Toy ${f.id}`, plates: 1, file: { id: f.id } })), { sku: "rex", name: "Rex", plates: 3, file: { id: 31 } }];
  const out = run(stateOf([printer("a"), printer("t", { model: "H2S" })]), files, { a: idle(["#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd"]), t: idle(["#000000"]) }, { demand, maxChanges: 20 });
  const onT = out.add.filter((x) => x.printer === "t");
  assert.ok(onT.length >= 3, `the H2S line is filled (${onT.length})`);
  for (let i = 1; i < onT.length; i++) assert.notEqual(onT[i].fileId, onT[i - 1].fileId, `toy ${onT[i].fileId} twice in a row on the H2S: ${onT.map((x) => x.fileId)}`);
});

test("what sells goes in turns: select() takes one plate of each wanted toy per round, never six of one toy first", () => {
  const files = [file(40, { minutes: 300 }), file(41, { minutes: 300 }), file(42, { minutes: 300 })];
  const demand = [{ sku: "a", name: "Dolphin", plates: 3, file: { id: 40 } }, { sku: "b", name: "Seal", plates: 3, file: { id: 41 } }, { sku: "c", name: "Orca", plates: 1, file: { id: 42 } }];
  const sel = W.select(files, stateOf([printer("a")]), { mode: "demand", slotsByModel: { P2S: 60 }, demand, t: T0 });
  assert.deepEqual(sel.jobs.filter((j) => j.kind === "demand").map((j) => j.fileId), [40, 41, 42, 40, 41, 40, 41]);
  assert.deepEqual(sel.demand.map((r) => r.added), [3, 3, 1], "every row still gets its plates");
  const tight = W.select(files, stateOf([printer("a")]), { mode: "demand", slotsByModel: { P2S: 2 }, demand, t: T0 });
  assert.equal(tight.jobs.length, 2, "a model that runs out of room stops; the rows after it still get theirs");
});

test("targets count the plates already on the lines: a fill that runs again does not add the same target again", () => {
  const files = [file(40, { minutes: 300 }), file(41, { minutes: 300 })];
  const demand = [{ sku: "a", name: "Dolphin", plates: 3, file: { id: 40 } }];
  const queued = stateOf([printer("a")], [plate("Q1", { file: { id: 40, model: "P2S" }, title: "Toy 40 · P2S" }), plate("Q2", { file: { id: 40, model: "P2S" }, title: "Toy 40 · P2S", status: "printing", printer: "a" })]);
  const sel = W.select(files, queued, { slotsByModel: { P2S: 60 }, demand, t: T0 });
  assert.equal(sel.demand[0].onLines, 2); assert.equal(sel.demand[0].added, 1, "3 wanted, 2 on the lines: one more");
  // a must-have with `since` also counts the plates printed fine since the ask
  const done = stateOf([printer("a")], [plate("D1", { file: { id: 41, model: "P2S" }, title: "Toy 41 · P2S", status: "done", closedAt: new Date(T0 - HOUR).toISOString(), outcome: { good: 1 } })]);
  const m = W.select(files, done, { slotsByModel: { P2S: 60 }, must: [{ sku: "b", name: "Seal", plates: 2, file: { id: 41 }, since: new Date(T0 - DAY).toISOString() }], t: T0 });
  assert.equal(m.must[0].added, 1); assert.equal(m.jobs[0].kind, "must");
});

test("filler: skips printers out of service, stopped, switched off, without a driver or kept out of Fill; a known back time fills from then", () => {
  const files = [file(1)];
  const live = { a: idle(["#000000"]), b: idle(["#000000"]), c: idle(["#000000"]) };
  const state = stateOf([printer("a"), printer("b", { maintenance: { why: "nozzle" } }), printer("c", { stopped: true }), printer("d", { active: false }), printer("e", { driverId: null }), printer("f", { fillOff: true })]);
  const out = run(state, files, live);
  assert.ok(out.add.length > 0 && out.add.every((a) => a.printer === "a"));
  assert.deepEqual(Object.fromEntries(out.skipped.map((s) => [s.printer, s.why.split(" ")[0]])), { b: "out", c: "stopped", d: "switched", e: "no", f: "kept" });
  const back = T0 + DAY;
  const later = run(stateOf([printer("b", { maintenance: { why: "nozzle", backAt: new Date(back).toISOString() } })]), files, { b: idle(["#000000"]) });
  assert.ok(later.add.length > 0 && later.add.every((a) => a.start >= back), "nothing before it is back");
});

test("filler: a showpiece category lands at most once per printer per lab day", () => {
  const files = [file(1, { category: "signature", minutes: 120 }), file(2, { category: "signature", minutes: 120 })];
  const out = run(stateOf([printer("a")], [], { mix: { signature: 100 } }), files, { a: idle(["#000000"]) });
  const days = out.add.map((a) => new Date(a.start).toLocaleDateString("en-US", { timeZone: TZ }));
  assert.equal(new Set(days).size, days.length, `one signature piece a day: ${days}`);
});

test("filler: never touches printing, pinned, custom, `at` or held plates; Apply replaces unpinned stock, a fill only adds", () => {
  const f7 = file(7), f9 = file(9, { category: "premium" });
  const files = [f7, f9];
  const pl = (id, extra) => plate(id, { printer: "a", pinnedPrinter: "a", file: { id: 9, model: "P2S" }, title: "Toy 9 · P2S", minutes: 240, ...extra });
  const keepers = [
    pl("RUN", { status: "printing", startedAt: new Date(T0 - HOUR).toISOString() }),
    pl("CUSTOM", { source: { type: "custom" } }),
    pl("AT", { at: new Date(T0 + 30 * HOUR).toISOString() }),
    pl("HELD", { status: "hold" }),
    pl("LOCKED", { locked: true }),
  ];
  const stale = pl("STALE", {});                                                          // stock, unpinned, not started, toy 9
  const again = plate("AGAIN", { printer: "a", pinnedPrinter: "a", file: { id: 7, model: "P2S" }, title: "Toy 7 · P2S", minutes: 240 });   // stock the new goals still want
  const other = pl("OTHER", {});
  const state = stateOf([printer("a")], [...keepers, stale, again, other], { mix: { minis: 100, premium: 0 } });
  const live = { a: { connected: true, state: "RUNNING", remainingMin: 60, trays: [tray("#000000")], amsSlots: 4 } };
  const tick = run(state, files, live);
  assert.ok(tick.add.length > 0, "the line still has room before the horizon");
  assert.equal(tick.remove.length, 0); assert.equal(tick.keep.length, 0);
  assert.ok(tick.add.every((a) => a.fileId === 7), "the goals' mix: minis only");
  const s1 = applied(state, files, tick);
  for (const p of [...keepers, stale, again, other]) assert.equal(s1.plates[p.id].status, p.status, `${p.id} untouched by a fill`);
  const apply = run(state, files, live, { replace: true });
  assert.deepEqual(apply.remove.map((r) => r.plateId).sort(), ["OTHER", "STALE"]);
  assert.deepEqual(apply.keep, ["AGAIN"]);
  const s2 = applied(state, files, apply);
  assert.equal(s2.plates.STALE.status, "cancelled"); assert.equal(s2.plates.OTHER.status, "cancelled"); assert.equal(s2.plates.AGAIN.status, "waiting");
  for (const p of keepers) assert.deepEqual(s2.plates[p.id], state.plates[p.id], `${p.id} untouched by Apply`);
  const s3 = structuredClone(state); s3.plates.STALE.locked = true;
  filler.applyPlan(s3, apply, files, { by: "test", t: T0 });
  assert.equal(s3.plates.STALE.status, "waiting", "a plate someone pinned since the plan was made is not cancelled");
});

test("filler: a per-printer re-plan fills only that printer; a set is added whole, consecutive, with one set id", () => {
  const set = { ...file(5, { minutes: 360 }), plates: [{ index: 1, minutes: 180, grams: 20 }, { index: 2, minutes: 180, grams: 20 }] };
  const files = [file(1), set];
  const state = stateOf([printer("a"), printer("b")]);
  const out = run(state, files, { a: idle(["#000000"]), b: idle(["#000000"]) }, { only: "b" });
  assert.ok(out.add.length > 0 && out.add.every((a) => a.printer === "b"));
  assert.equal(out.lines.a, undefined, "the other printer is not even looked at");
  const sets = Object.values(applied(state, files, out).plates).filter((p) => p.set);
  assert.ok(sets.length >= 2 && sets.length % 2 === 0);
  const byId = {}; for (const p of sets) (byId[p.set.id] ||= []).push(p);
  for (const members of Object.values(byId)) { assert.deepEqual(members.map((p) => p.set.n).sort(), [1, 2]); assert.match(members[0].title, /plate \d of 2/); }
  const job = out.add.find((a) => a.fileId === 5);
  assert.equal(job.plates[1].start, job.plates[0].end + 15 * MIN, "the set's plates back to back on one printer");
});
