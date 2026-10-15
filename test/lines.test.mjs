// The printer lines: each printer has ONE ordered line, in the queue's order. A plate may carry a pinned start (`at`) and a lock.
// Times are computed, never stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lines from "../src/lines.mjs";
import { atLab } from "../src/labtime.mjs";

const TZ = "America/Chicago";
const at = (day, hhmm) => atLab(day, hhmm, TZ);
const MIN = 60_000;
const WED = "2026-09-23", THU = "2026-09-24", SUN = "2026-09-27";
const printer = (key, extra = {}) => ({ key, name: key.toUpperCase(), number: { a: 1, b: 2, c: 3 }[key] ?? 9, model: "P2S", active: true, autoStart: true, driverId: 1, plateOn: true, ...extra });
const idle = () => ({ connected: true, state: "IDLE", remainingMin: 0, trays: [], amsSlots: 0 });
const plate = (id, extra = {}) => ({ id, title: `Toy ${id}`, status: "waiting", file: { id: 100, model: "P2S" }, minutes: 60, createdAt: "2026-09-20T00:00:00Z", ...extra });
const stateOf = (printers, plates, order = plates.map((p) => p.id), settings = {}) => ({ printers: Object.fromEntries(printers.map((p) => [p.key, p])), plates: Object.fromEntries(plates.map((p) => [p.id, p])), order, settings: { tz: TZ, swapMinutes: 15, ...settings } });
const waitingOf = (ln) => ln.blocks.filter((b) => b.kind === "waiting");

test("lines: waiting plates follow the queue, and each starts after the one ahead + the changeover", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("W1", { printer: "a" }), plate("W2", { printer: "a" }), plate("W3")], ["W2", "W1", "W3"]);
  const out = lines.build(s, { a: idle() }, { t });
  const ws = waitingOf(out.lines.a);
  assert.deepEqual(ws.map((b) => b.plateId), ["W2", "W1", "W3"], "the queue's order");
  assert.equal(ws[0].start, t, "an idle printer with the plate confirmed starts its head now");
  assert.equal(ws[1].start, ws[0].end + 15 * MIN, "then the end of the plate ahead + 15 min changeover");
  assert.equal(ws[2].start, ws[1].end + 15 * MIN);
  assert.equal(ws[0].placedBy, "printer"); assert.equal(ws[2].placedBy, "auto");
  assert.equal(out.lines.a.head, "W2");
  assert.equal(out.lines.a.wouldStart, "W2", "idle, plate on, auto-start on: the head would start now");
});

test("lines: a pinned start (at) is never started before; the plates behind it fill the gap only when they finish in time", () => {
  const t = at(WED, "08:00");
  const pin = new Date(at(WED, "10:15")).toISOString();
  // P2 (60 min) ends 09:00, + 15 changeover = 09:15 - done before 10:15: it fills the gap, P1 still starts at 10:15
  const s = stateOf([printer("a")], [plate("P1", { printer: "a", at: pin, locked: true }), plate("P2", { printer: "a" })]);
  const [first, second] = waitingOf(lines.build(s, { a: idle() }, { t }).lines.a);
  assert.equal(first.plateId, "P2"); assert.equal(first.start, t);
  assert.equal(second.plateId, "P1"); assert.equal(second.start, at(WED, "10:15")); assert.equal(second.pinnedAt, at(WED, "10:15")); assert.equal(second.locked, true);
  assert.match(second.why, /pinned to/);
  // P2 of 180 min would still be printing at 10:15: the pinned plate goes first and P2 waits behind it
  const long = stateOf([printer("a")], [plate("P1", { printer: "a", at: pin }), plate("P2", { printer: "a", minutes: 180 })]);
  const o2 = lines.build(long, { a: idle() }, { t });
  const [p1, p2] = waitingOf(o2.lines.a);
  assert.equal(p1.plateId, "P1"); assert.equal(p1.start, at(WED, "10:15"));
  assert.equal(p2.plateId, "P2"); assert.equal(p2.start, p1.end + 15 * MIN);
  assert.equal(o2.lines.a.wouldStart, null, "not before its pinned time");
  assert.match(o2.lines.a.wouldWhy, /not before/);
  // a pinned time that has passed is simply due: first on the line, now
  const past = lines.build(stateOf([printer("a")], [plate("X", { printer: "a" }), plate("Y", { printer: "a", at: new Date(t - 3600_000).toISOString() })]), { a: idle() }, { t });
  assert.deepEqual(waitingOf(past.lines.a).map((b) => b.plateId), ["Y", "X"]); assert.equal(waitingOf(past.lines.a)[0].start, t);
});

test("lines: staffed hours - a plate swap due at 23:00 moves to 06:30; a plate already confirmed on starts overnight", () => {
  const t = at(WED, "20:00");
  // a: printing, 165 min left -> ends 22:45, + 15 changeover = 23:00, needs someone to swap plates -> Thursday 06:30
  const s = stateOf([printer("a"), printer("b", { plateOn: true }), printer("c", { plateOn: false })],
    [plate("RUN", { status: "printing", printer: "a", startedAt: new Date(at(WED, "12:00")).toISOString(), minutes: 600 }), plate("NEXT", { printer: "a", minutes: 600 }),
      plate("B1", { printer: "b", at: new Date(at(WED, "23:00")).toISOString() }), plate("C1", { printer: "c" })]);
  const late = at(WED, "23:00");
  const out = lines.build(s, { a: { connected: true, state: "RUNNING", remainingMin: 165 }, b: idle(), c: idle() }, { t });
  const next = waitingOf(out.lines.a)[0];
  assert.equal(next.start, at(THU, "06:30"), "the swap waits for the morning");
  assert.equal(next.needsOperator, true); assert.match(next.why, /needs someone \(plate swap\)/);
  assert.equal(next.end, at(THU, "06:30") + 600 * MIN, "it may run long after 22:00 once started");
  assert.equal(waitingOf(out.lines.b)[0].start, late, "plate confirmed on: its 23:00 plate starts unattended");
  const c1 = waitingOf(out.lines.c)[0];
  assert.equal(c1.start, t, "20:00 is still staffed");
  assert.equal(out.lines.c.wouldStart, null); assert.match(out.lines.c.wouldWhy, /build plate/);
  const night = lines.build(s, { a: { connected: true, state: "RUNNING", remainingMin: 165 }, b: idle(), c: idle() }, { t: late + 30 * MIN });
  assert.equal(waitingOf(night.lines.c)[0].start, at(THU, "06:30"), "23:30 with no plate confirmed: the morning");
  // the windows are a setting
  const s2 = { ...s, settings: { ...s.settings, staffed: { from: "07:00", to: "23:30" } } };
  assert.equal(waitingOf(lines.build(s2, { a: { connected: true, state: "RUNNING", remainingMin: 165 }, b: idle(), c: idle() }, { t }).lines.a)[0].start, at(WED, "23:00"));
  assert.equal(lines.nextStaffed(at(WED, "05:00"), lines.STAFFED, TZ), at(WED, "06:30"));
  assert.equal(lines.nextStaffed(at(WED, "21:59"), lines.STAFFED, TZ), at(WED, "21:59"));
  assert.equal(lines.nextStaffed(at(WED, "22:00"), lines.STAFFED, TZ), at(THU, "06:30"));
});

test("lines: two staffed windows a day - a swap at lunchtime waits for the evening window", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("A1", { printer: "a", minutes: 240 }), plate("A2", { printer: "a" })], undefined, { staffed: [{ from: "07:00", to: "09:00" }, { from: "17:00", to: "21:00" }] });
  const [a1, a2] = waitingOf(lines.build(s, { a: idle() }, { t }).lines.a);
  assert.equal(a1.start, t);
  assert.equal(a2.start, at(WED, "17:00"), "12:15 is nobody's hour; the evening window is");
});

test("lines: a finished or failed plate still on the bed (a hand stop too) blocks its printer until someone clears it", () => {
  const night = at(WED, "23:30");
  const s = stateOf([printer("a")], [plate("OLD", { status: "failed", printer: "a", finishedAt: new Date(at(WED, "21:00")).toISOString(), stoppedByHand: "operator" }), plate("W", { printer: "a" })]);
  const out = lines.build(s, { a: { connected: true, state: "FAILED", remainingMin: 0 } }, { t: night });
  const [bed, w] = out.lines.a.blocks;
  assert.equal(bed.kind, "finished-on-bed"); assert.equal(bed.plateId, "OLD"); assert.equal(bed.stoppedByHand, "operator");
  assert.match(bed.why, /stopped by hand - still on the bed/);
  assert.equal(bed.end, at(THU, "06:30"), "cleared when someone is there");
  assert.equal(w.start, at(THU, "06:30"), "the next plate starts when the bed is cleared - no extra changeover");
  assert.equal(out.lines.a.head, "W");
  assert.equal(out.lines.a.wouldStart, null);
  const day = lines.build({ ...s, plates: { ...s.plates, OLD: { ...s.plates.OLD, status: "finished", stoppedByHand: undefined } } }, { a: { connected: true, state: "FINISH" } }, { t: at(THU, "09:00") });
  assert.equal(day.lines.a.blocks[0].kind, "finished-on-bed"); assert.equal(day.lines.a.blocks[1].start, at(THU, "09:00"));
  assert.equal(day.lines.a.wouldStart, null); assert.equal(day.lines.a.wouldWhy, "the bed is not clear");
});

test("lines: a service session is a block on each line - a plate starting before it runs over and pushes it, later plates go after it", () => {
  const t = at(SUN, "10:00");
  const s = stateOf([printer("a"), printer("b")], [plate("A1", { printer: "a", minutes: 300 }), plate("A2", { printer: "a", minutes: 180 }), plate("A3", { printer: "a", minutes: 60 }), plate("B1", { printer: "b", minutes: 60 })]);
  const service = { sessions: [{ id: SUN, at: at(SUN, "16:00"), printers: { a: { minutes: 30 }, b: { minutes: 30 } } }] };
  const out = lines.build(s, { a: idle(), b: idle() }, { t, service });
  assert.deepEqual(out.lines.a.blocks.map((b) => b.kind === "service" ? "service" : b.plateId), ["A1", "A2", "service", "A3"]);
  const [, a2, svc, a3] = out.lines.a.blocks;
  assert.equal(a2.start, at(SUN, "15:15"), "15:15 is before 16:00: A2 goes first");
  assert.equal(svc.start, a2.end + 15 * MIN, "the service waits for A2 to end");
  assert.equal(svc.end, svc.start + 30 * MIN);
  assert.equal(a3.start, svc.end, "the plate after the service starts when the service is done");
  const bs = out.lines.b.blocks;
  assert.equal(bs[1].kind, "service"); assert.equal(bs[1].start, at(SUN, "16:00"));
  const late = lines.build(stateOf([printer("a")], [plate("L", { printer: "a", minutes: 600 })]), { a: idle() }, { t: at(SUN, "15:00"), service });
  assert.equal(late.lines.a.blocks[1].kind, "service"); assert.equal(late.lines.a.blocks[1].start, at("2026-09-28", "06:30"), "a service that falls at night waits for someone");
  const soft = lines.build(s, { a: idle(), b: idle() }, { t, service: { ...service, gates: false } });
  assert.equal(soft.lines.a.blocks.find((b) => b.plateId === "A3").start, a2.end + 15 * MIN, "drawn only: the plates do not move");
  assert.equal(soft.lines.a.blocks.find((b) => b.kind === "service").gates, false);
  const done = lines.build(s, { a: idle(), b: idle() }, { t, service: { sessions: [{ ...service.sessions[0], printers: { a: { minutes: 30, done: true } } }] } });
  assert.ok(!done.lines.a.blocks.some((b) => b.kind === "service")); assert.ok(!done.lines.b.blocks.some((b) => b.kind === "service"));
});

test("lines: the printing head carries the live ETA; without a live feed its planned length", () => {
  const t = at(WED, "12:00");
  const s = stateOf([printer("a")], [plate("RUN", { status: "printing", printer: "a", startedAt: new Date(at(WED, "09:00")).toISOString(), minutes: 240 }), plate("N", { printer: "a" })]);
  const out = lines.build(s, { a: { connected: true, state: "RUNNING", remainingMin: 90, progress: 62.5 } }, { t });
  const [run, next] = out.lines.a.blocks;
  assert.equal(run.kind, "printing"); assert.equal(run.start, at(WED, "09:00")); assert.equal(run.end, t + 90 * MIN);
  assert.match(run.why, /live ETA/); assert.equal(run.progress, 62.5); assert.equal(run.eta, "printer");
  assert.equal(next.start, run.end + 15 * MIN);
  assert.equal(out.lines.a.wouldStart, null, "a printing printer starts nothing");
  const blind = lines.build(s, {}, { t });
  assert.equal(blind.lines.a.blocks[0].end, at(WED, "13:00"), "09:00 + 240 min"); assert.equal(blind.lines.a.blocks[0].eta, "plan");
});

test("lines: two plates of the same toy on one line keep their order (variety is Fill's job, not the line's)", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("L1", { printer: "a", file: { id: 223, model: "P2S" } }), plate("X", { printer: "a", file: { id: 5, model: "P2S" } }), plate("L2", { printer: "a", file: { id: 223, model: "P2S" } })], ["L1", "L2", "X"]);
  assert.deepEqual(waitingOf(lines.build(s, { a: idle() }, { t }).lines.a).map((b) => b.plateId), ["L1", "L2", "X"]);
});

test("lines: a plate pinned to a printer rides that printer's line; an unpinned one goes to the fitting printer free first", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a"), printer("b")], [plate("P", { printer: "b", pinnedPrinter: "b" }), plate("Q")]);
  const out = lines.build(s, { a: idle(), b: idle() }, { t });
  assert.deepEqual(waitingOf(out.lines.b).map((b) => b.plateId), ["P"]);
  assert.equal(waitingOf(out.lines.b)[0].placedBy, "printer"); assert.equal(waitingOf(out.lines.b)[0].pinnedPrinter, "b");
  assert.deepEqual(waitingOf(out.lines.a).map((b) => b.plateId), ["Q"], "b is busy with P: Q goes to a, free first");
  assert.equal(waitingOf(out.lines.a)[0].placedBy, "auto");
  const s2 = stateOf([printer("a"), printer("b")], [plate("R", { status: "printing", printer: "a", startedAt: new Date(t).toISOString() }), plate("F"), plate("H", { file: { id: 9, model: "H2C" } })]);
  const o2 = lines.build(s2, { a: { connected: true, state: "RUNNING", remainingMin: 60 }, b: idle() }, { t });
  assert.equal(o2.lines.b.head, "F");
  assert.deepEqual(o2.unplaced.map((u) => u.plateId), ["H"], "a plate no printer fits is unplaced");
});

test("lines: a paused print holds its printer until someone resumes it", () => {
  const t = at(WED, "23:00");
  const s = stateOf([printer("a")], [plate("RUN", { status: "printing", printer: "a", startedAt: new Date(at(WED, "18:00")).toISOString(), minutes: 400 }), plate("N", { printer: "a" })]);
  const [run, next] = lines.build(s, { a: { connected: true, state: "PAUSE", remainingMin: 60 } }, { t }).lines.a.blocks;
  assert.equal(run.kind, "paused"); assert.match(run.why, /someone resumes it/);
  assert.equal(run.end, at(THU, "06:30") + 60 * MIN, "resumed in the morning, then the 60 min left");
  assert.equal(next.start, run.end + 15 * MIN);
});

test("lines: out of service - the line starts at its back time; the kill switch holds the line", () => {
  const t = at(WED, "08:00");
  const back = at(WED, "14:00");
  const s = stateOf([printer("a", { maintenance: { why: "nozzle", backAt: new Date(back).toISOString() } }), printer("b", { stopped: { by: "operator" } })], [plate("A", { printer: "a" }), plate("B", { printer: "b" })]);
  const out = lines.build(s, { a: idle(), b: idle() }, { t });
  assert.equal(out.lines.a.blocks[0].start, back); assert.match(out.lines.a.blocks[0].why, /back in service/);
  assert.equal(out.lines.a.printer.inService, false);
  assert.equal(out.lines.b.wouldStart, null); assert.match(out.lines.b.wouldWhy, /kill switch/);
});

test("lines: build never writes to the state it reads (no _eta, no reorder)", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("W1"), plate("W2", { status: "printing", printer: "a", startedAt: new Date(t).toISOString() })]);
  const before = JSON.stringify(s);
  lines.build(s, { a: { connected: true, state: "RUNNING", remainingMin: 30 } }, { t });
  assert.equal(JSON.stringify(s), before);
});

test("lines (screens): a waiting block carries its picture, colours, category and custom flag - display only", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("W1", { filaments: [{ type: "PLA Basic", color: "#FF0000" }, { type: "PLA", color: "#ff0000" }, { type: "PETG", color: "#00FF00" }, { type: "PLA" }], plate: { index: 2 }, source: { type: "custom" } }), plate("W2")]);
  const named = lines.build(s, { a: idle() }, { t, colourName: (type, hex) => (hex.toLowerCase() === "#ff0000" ? "Red" : null), categoryOf: (id) => (id === 100 ? "dragons" : null) });
  const [w1, w2] = waitingOf(named.lines.a);
  assert.deepEqual(w1.colours, [{ type: "PLA", color: "#FF0000", name: "Red" }, { type: "PETG", color: "#00FF00" }], "one chip per colour, named when the shelf knows it");
  assert.equal(w1.category, "dragons");
  assert.equal(w1.fileId, 100); assert.equal(w1.plateIndex, 2); assert.equal(w1.custom, true); assert.equal(w2.custom, false);
  assert.equal(w1.planMin, 60);
  const plain = lines.build(s, { a: idle() }, { t });
  assert.deepEqual(plain.lines.a.blocks.map((b) => [b.plateId, b.start, b.end]), named.lines.a.blocks.map((b) => [b.plateId, b.start, b.end]), "same times without the display hooks");
  assert.equal(plain.lines.a.head, named.lines.a.head);
});

test("lines (screens): `past` holds what each printer printed lately (closed plates), oldest first, never the plan", () => {
  const t = at(THU, "12:00");
  const s = stateOf([printer("a"), printer("b")], [
    plate("D1", { status: "done", printer: "a", startedAt: new Date(at(WED, "06:30")).toISOString(), finishedAt: new Date(at(WED, "09:00")).toISOString() }),
    plate("D2", { status: "done", printer: "a", startedAt: new Date(at(WED, "10:00")).toISOString(), closedAt: new Date(at(WED, "11:00")).toISOString(), outcome: { good: 1, oops: 9, wasFailed: true } }),
    plate("OLD", { status: "done", printer: "a", startedAt: "2026-09-01T10:00:00Z", finishedAt: "2026-09-01T12:00:00Z" }),
    plate("GONE", { status: "cancelled", printer: "a" }),
    plate("W", { printer: "a" })]);
  const out = lines.build(s, { a: idle(), b: idle() }, { t });
  assert.deepEqual(out.lines.a.past.map((b) => [b.plateId, b.kind]), [["D1", "done"], ["D2", "failed"]]);
  assert.deepEqual(out.lines.b.past, []);
  assert.ok(!out.lines.a.blocks.some((b) => b.plateId === "D1"), "history is not on the line");
});

test("lines: the line keeps the queue's order - a custom job is ahead of the stock because the queue puts it there", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a")], [plate("S1", { printer: "a", source: { type: "stock" } }), plate("C1", { source: { type: "custom" }, printer: "a" }), plate("W1", { printer: "a", source: { type: "stock" } })], ["C1", "S1", "W1"]);
  assert.deepEqual(waitingOf(lines.build(s, { a: idle() }, { t }).lines.a).map((b) => b.plateId), ["C1", "S1", "W1"]);
  const back = stateOf([printer("a")], Object.values(s.plates), ["S1", "C1", "W1"]);
  assert.deepEqual(waitingOf(lines.build(back, { a: idle() }, { t }).lines.a).map((b) => b.plateId), ["S1", "C1", "W1"], "the lines never reorder the queue themselves");
});

test("lines: a spool-change mark sits on the waiting plate that needs a colour the AMS will not hold then", () => {
  const t = at(WED, "08:00");
  const f = (...cs) => cs.map((c) => ({ type: "PLA Basic", color: c }));
  const s = stateOf([printer("a"), printer("b")], [
    plate("P1", { printer: "a", filaments: f("#000000", "#FFFFFF") }), plate("P2", { printer: "a", filaments: f("#FEC600", "#000000") }), plate("P3", { printer: "a", filaments: f("#FEC600", "#000000") }),
    plate("B1", { printer: "b", filaments: f("#FF0000") }), plate("B2", { printer: "b", filaments: f("#FF0000") }), plate("B3", { printer: "b", filaments: f("#00FF00") })]);
  const trays = [{ ams: 0, slot: 0, type: "PLA", color: "#000000" }, { ams: 0, slot: 1, type: "PLA", color: "#FFFFFF" }];
  const out = lines.build(s, { a: { connected: true, state: "IDLE", trays, amsSlots: 2 }, b: null }, { t });
  const [p1, p2, p3] = waitingOf(out.lines.a);
  assert.equal(p1.load, undefined, "black and white are loaded");
  assert.deepEqual(p2.load.map((c) => c.color), ["#FEC600"], "yellow has to go in");
  assert.equal(p3.load, undefined, "the same colours as the plate ahead");
  const [b1, b2, b3] = waitingOf(out.lines.b);
  assert.equal(b1.load, undefined); assert.equal(b2.load, undefined); assert.deepEqual(b3.load.map((c) => c.color), ["#00FF00"], "no live trays: the first plate is the start");
});

test("lines: a printer kept out of Fill takes no plate that has no printer of its own - only what is dropped on it", () => {
  const t = at(WED, "08:00");
  const s = stateOf([printer("a", { fillOff: true }), printer("b")], [plate("Q"), plate("P", { printer: "a" })]);
  const out = lines.build(s, { a: idle(), b: idle() }, { t });
  assert.deepEqual(waitingOf(out.lines.a).map((b) => b.plateId), ["P"], "a plate pinned to it still prints");
  assert.deepEqual(waitingOf(out.lines.b).map((b) => b.plateId), ["Q"], "the free plate goes elsewhere");
  const only = lines.build(stateOf([printer("a", { fillOff: true })], [plate("Q")]), { a: idle() }, { t });
  assert.deepEqual(only.unplaced.map((u) => u.plateId), ["Q"]); assert.match(only.unplaced[0].why, /in Fill/);
});
