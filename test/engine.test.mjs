import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../src/engine.mjs";
import * as A from "../src/ams.mjs";
import { nextStaffed } from "../src/labtime.mjs";

function state() {
  const s = E.blankState();
  s.printers = {
    h2s: { key: "h2s", name: "Printer 1", model: "Bambu Lab H2S", active: true, plateOn: true, number: 1, driverId: 1 },
    "p2s-1": { key: "p2s-1", name: "Printer 2", model: "P2S", active: true, plateOn: true, number: 2, driverId: 2 },
    "p2s-2": { key: "p2s-2", name: "Printer 3", model: "P2S", active: true, plateOn: true, number: 3, driverId: null },
  };
  s.settings.staffed = [{ from: "00:00", to: "23:59" }];   // always staffed, so ETAs are plain sums
  return s;
}
const idle = { connected: true, state: "IDLE", progress: 0, remainingMin: 0, job: "" };
const running = (min, pct = 40) => ({ connected: true, state: "RUNNING", progress: pct, remainingMin: min, job: "x.gcode.3mf" });
const fileP2S = { id: 8, name: "Blobtopus.gcode.3mf", model: "P2S", minutes: 338, grams: 94 };
const fileH2S = { id: 4, name: "keychain.gcode.3mf", model: "H2S", minutes: 17, grams: 12 };

test("plates fit only the model they were sliced for", () => {
  const s = state();
  const [p] = E.addPlates(s, { file: fileP2S });
  assert.equal(E.fits(p, s.printers["p2s-1"]), true);
  assert.equal(E.fits(p, s.printers.h2s), false);
  const [q] = E.addPlates(s, { file: { ...fileH2S, model: "Bambu Lab H2S" } });
  assert.equal(E.fits(q, s.printers.h2s), true);
});

test("lanes: unpinned plates go to the fitting printer that is free first; pinned ones stay put", () => {
  const s = state();
  const [a, b, c] = E.addPlates(s, { file: fileP2S, count: 3 });
  const [d] = E.addPlates(s, { file: fileH2S, printer: "h2s" });
  const live = { h2s: idle, "p2s-1": running(200), "p2s-2": idle };
  const L = E.lanes(s, live);
  assert.equal(L["p2s-2"].items[0].id, a.id, "first plate goes to the idle P2S");
  assert.equal(L["p2s-1"].items[0].id, b.id, "second waits behind the running print (200m < 338m+swap)");
  assert.equal(L["p2s-2"].items[1].id, c.id);
  assert.equal(L.h2s.items[0].id, d.id);
  assert.equal(a._eta.auto, true); assert.equal(d._eta.auto, false);
  assert.ok(b._eta.start > a._eta.start);
});

test("power stagger: two idle printers never get starts within the gap; a start that just happened pushes the plan", () => {
  const s = state();
  const [a, b] = E.addPlates(s, { file: fileP2S, count: 2 });
  s.printers["p2s-2"].driverId = 3;
  const live = { h2s: idle, "p2s-1": idle, "p2s-2": idle };
  const t = Date.now();
  E.lanes(s, live, { t });
  const gap = E.startGapMs(s.settings);
  assert.equal(gap, 5 * 60_000, "default gap is 5 min");
  const first = Math.min(a._eta.start, b._eta.start), second = Math.max(a._eta.start, b._eta.start);
  assert.ok(second - first >= gap, "the second printer's start is at least the gap after the first");
  E.lanes(s, live, { t, lastStartAt: t - 60_000 });                        // a printer started a minute ago
  assert.ok(Math.min(a._eta.start, b._eta.start) >= t + gap - 61_000, "nothing starts until the gap after that start");
  s.settings.startGapMinutes = 0;
  E.lanes(s, live, { t });
  assert.ok(Math.abs(a._eta.start - b._eta.start) < 1000, "gap 0 = both may start now");
});

test("board: printer state, now/next, needs-you, counts", async () => {
  const s = state();
  const [a, b] = E.addPlates(s, { file: fileP2S, count: 2 });
  const live = { h2s: idle, "p2s-1": idle, "p2s-2": null };
  let sent = null;
  await E.start(s, live, a.id, "p2s-1", async (f, pid) => { sent = [f, pid]; });
  assert.deepEqual(sent, [8, 2]);
  assert.equal(s.plates[a.id].status, "printing");
  assert.equal(s.plates[a.id].manual, false);
  live["p2s-1"] = running(300, 10);
  let bd = E.board(s, live);
  const p1 = bd.printers.find((p) => p.key === "p2s-1");
  assert.equal(p1.state, "printing"); assert.equal(p1.now.id, a.id);
  assert.equal(p1.next?.id, b.id, "a connected printer (even busy) is preferred over an unconnected one - it can start by itself");
  const p2 = bd.printers.find((p) => p.key === "p2s-2");
  assert.equal(p2.state, "unbound"); assert.equal(p2.next, null);
  assert.equal(bd.counts.printing, 1); assert.equal(bd.counts.waiting, 1);
  await assert.rejects(() => E.start(s, live, b.id, "p2s-1", async () => {}), /already printing/);
  // the printer finishes
  s.plates[a.id].startedAt = new Date(Date.now() - 10 * 60000).toISOString();
  live["p2s-1"] = { connected: true, state: "FINISH", progress: 100, remainingMin: 0, job: "x" };
  const tr = E.applyLive(s, live);
  assert.equal(tr.length, 1); assert.equal(tr[0].event, "finished");
  bd = E.board(s, live);
  assert.equal(bd.needs.length, 1); assert.equal(bd.printers.find((p) => p.key === "p2s-1").state, "finished");
  assert.equal(bd.counts.needsYou, 1);
  await assert.rejects(() => E.start(s, live, b.id, "p2s-1", async () => {}), /take it off/);
  E.off(s, a.id, { good: 1, oops: 0 });
  assert.equal(s.plates[a.id].status, "done");
  live["p2s-1"] = idle;
  bd = E.board(s, live);
  assert.equal(bd.needs.length, 0);
  assert.equal(bd.printers.find((p) => p.key === "p2s-1").next.id, b.id);
});

test("manual start when there is no printer driver", async () => {
  const s = state();
  const [a] = E.addPlates(s, { file: fileP2S });
  const out = await E.start(s, { "p2s-2": null }, a.id, "p2s-2", null);
  assert.equal(out.manual, true); assert.equal(out.status, "printing");
});

test("applyLive ignores the first minutes after start and flags a failure", () => {
  const s = state();
  const [a] = E.addPlates(s, { file: fileP2S });
  s.plates[a.id].status = "printing"; s.plates[a.id].printer = "p2s-1"; s.plates[a.id].startedAt = new Date().toISOString();
  assert.equal(E.applyLive(s, { "p2s-1": { connected: true, state: "FINISH" } }).length, 0, "too soon after start - the printer has not picked the file up");
  s.plates[a.id].startedAt = new Date(Date.now() - 5 * 60000).toISOString();
  const tr = E.applyLive(s, { "p2s-1": { connected: true, state: "FAILED" } });
  assert.equal(tr[0].event, "failed"); assert.equal(s.plates[a.id].status, "failed");
  const n = E.retry(s, a.id);
  assert.equal(n.status, "waiting"); assert.equal(s.order[0], n.id, "retry goes to the top");
});

test("queue: reorder, move, hold, cancel, needs-file", async () => {
  const s = state();
  const [a, b, c] = E.addPlates(s, { file: fileP2S, count: 3 });
  const [n] = E.addPlates(s, { file: null, title: "Unsliced thing" });
  assert.equal(n.status, "needs-file");
  E.reorder(s, [c.id, a.id]);
  assert.deepEqual(s.order, [c.id, a.id, b.id, n.id]);
  E.moveTo(s, b.id, 0);
  assert.deepEqual(s.order, [b.id, c.id, a.id, n.id]);
  E.hold(s, a.id, "wait for gold filament");
  assert.equal(s.plates[a.id].status, "hold");
  const planned = Object.values(E.lanes(s, { "p2s-1": idle })).reduce((x, L) => x + L.items.length, 0);
  assert.equal(planned, 2, "held plates are not planned");
  E.unhold(s, a.id); assert.equal(s.plates[a.id].status, "waiting");
  E.cancel(s, c.id);
  assert.equal(s.plates[c.id].status, "cancelled"); assert.equal(s.order.includes(c.id), false);
  await assert.rejects(() => E.start(s, { "p2s-1": idle }, n.id, "p2s-1", null), /no sliced file/);
  E.setPlate(s, n.id, { file: fileP2S });
  assert.equal(s.plates[n.id].status, "waiting");
});

test("custom jobs go ahead of stock plates", () => {
  const s = state();
  const [st] = E.addPlates(s, { file: fileP2S, source: { type: "stock" } });
  const [cu] = E.addPlates(s, { file: fileP2S, source: { type: "custom" } });
  E.prioritizeCustom(s);
  assert.deepEqual(s.order, [cu.id, st.id]);
});

test("public board strips customers and order numbers", () => {
  const s = state();
  E.addPlates(s, { file: fileP2S, source: { type: "order", ref: "#1001", customer: "Customer A" } });
  const pb = E.publicBoard(s, { "p2s-1": idle });
  const str = JSON.stringify(pb);
  assert.equal(str.includes("Customer A"), false); assert.equal(str.includes("#1001"), false);
  assert.equal(pb.queue[0].source.type, "order");
});

test("sets stay on one printer; colour-loaded printers are preferred; auto AMS mapping", async () => {
  const s = state();
  const glow = { type: "PLA", color: "#7ED957" };
  const live = {
    "p2s-1": { ...idle, trays: [{ ams: 0, slot: 0, type: "PLA", color: "#F2754E" }, { ams: 0, slot: 1, type: "PLA", color: "#FFFFFF" }] },
    "p2s-2": { ...idle, trays: [{ ams: 0, slot: 2, type: "PLA", color: "#7ED957" }] },   // has the green
    h2s: idle,
  };
  const set = { id: "S-1", of: 3 };
  const made = [1, 2, 3].map((i) => E.addPlates(s, { file: fileP2S, title: `Dragon · plate ${i} of 3`, plate: { index: i, of: 3 }, set: { ...set, n: i }, filaments: [glow], minutes: 60 })[0]);
  const L = E.lanes(s, live);
  assert.equal(L["p2s-2"].items.length, 3, "all three plates land on the printer with green loaded");
  assert.equal(L["p2s-1"].items.length, 0);
  assert.equal(made[0]._eta.filament.ok, true);
  assert.deepEqual(A.autoMapping(made[0], live["p2s-2"]), [2], "slot 2 of AMS 0 -> global tray 2");
  // once plate 1 is printing on p2s-2, plates 2 and 3 follow it even if another printer frees up
  let sent = null;
  s.printers["p2s-2"].driverId = 3;
  await E.start(s, live, made[0].id, "p2s-2", async (f, pid, plateIndex, mapping) => { sent = [f, pid, plateIndex, mapping]; });
  assert.deepEqual(sent, [8, 3, 1, [2]]);
  live["p2s-2"] = { ...running(50), trays: live["p2s-2"].trays };
  const L2 = E.lanes(s, live);
  assert.equal(L2["p2s-2"].items.length, 2);
  assert.equal(L2["p2s-1"].items.length, 0);
  // a plate needing a colour nobody has loaded still prints (same material), flagged "colour differs"
  const [odd] = E.addPlates(s, { file: fileP2S, filaments: [{ type: "PLA", color: "#0000FF" }] });
  E.lanes(s, live);
  assert.equal(odd._eta.filament.ok, true);
  assert.equal(odd._eta.filament.colorOff[0].wanted, "#0000FF");
  // ...but a material nobody has loaded is a real "no"
  const [petg] = E.addPlates(s, { file: fileP2S, filaments: [{ type: "PETG", color: "#0000FF" }] });
  E.lanes(s, live);
  assert.equal(petg._eta.filament.ok, false);
  assert.equal(petg._eta.filament.missing[0], "PETG #0000FF");
});

test("a connected printer wins over an unconnected one even when its colour doesn't match", () => {
  const s = state();
  const [a] = E.addPlates(s, { file: fileP2S, filaments: [{ type: "PLA", color: "#F2754E" }] });   // wants orange
  const live = { "p2s-1": { ...idle, amsSlots: 4, trays: [{ ams: 0, slot: 0, type: "PLA", color: "#161616" }, { ams: 0, slot: 1, type: "PLA", color: "#46A8F9" }] } };
  E.lanes(s, live);
  assert.equal(a._eta.printer, "p2s-1");
  assert.equal(a._eta.offline, false);
  assert.equal(a._eta.filament.ok, true, "same material is loaded, so it can print...");
  assert.ok(a._eta.filament.colorOff, "...with a 'colour differs' note");
  const [b] = E.addPlates(s, { file: fileH2S });
  E.lanes(s, live);
  assert.equal(b._eta.printer, "h2s"); assert.equal(b._eta.offline, true, "no connected printer at all: still planned, flagged offline");
});

test("nextStaffed moves a start into the staffed windows", () => {
  const wins = [{ from: "07:00", to: "08:30" }, { from: "17:00", to: "21:00" }];
  const t = Date.UTC(2026, 8, 10, 12, 0);            // noon -> 17:00
  assert.equal(new Date(nextStaffed(t, wins, "UTC")).toISOString(), "2026-09-10T17:00:00.000Z");
  const t2 = Date.UTC(2026, 8, 10, 18, 0);           // inside the evening window
  assert.equal(nextStaffed(t2, wins, "UTC"), t2);
  const t3 = Date.UTC(2026, 8, 10, 22, 0);           // after the last window -> 07:00 next day
  assert.equal(new Date(nextStaffed(t3, wins, "UTC")).toISOString(), "2026-09-11T07:00:00.000Z");
});

test("applyLive: the driver's verdict finishes a plate whose printer already went idle (the rescan after a crash)", () => {
  const s = state();
  const pl = E.addPlates(s, { file: fileP2S, count: 1 })[0];
  pl.status = "printing"; pl.printer = "p2s-1"; pl.startedAt = new Date(Date.now() - 60 * 60000).toISOString(); pl.progress = 100; pl.driverItem = 7; pl.dispatched = true;
  assert.equal(E.applyLive(s, { "p2s-1": { connected: true, state: "IDLE" } }, { [pl.id]: { status: "printing" } }).length, 0);
  const tr = E.applyLive(s, { "p2s-1": { connected: true, state: "IDLE" } }, { [pl.id]: { status: "completed", completedAt: "2026-09-13T20:00:00.000Z" } });
  assert.equal(tr.length, 1); assert.equal(tr[0].event, "finished"); assert.equal(tr[0].reconciled, true);
  assert.equal(s.plates[pl.id].status, "finished"); assert.equal(s.plates[pl.id].finishedAt, "2026-09-13T20:00:00.000Z");
});

test("a failed plate is retried once, at the front, avoiding the printer it failed on; a retry that fails is not retried", async () => {
  const s = state();
  const [a] = E.addPlates(s, { file: fileP2S, title: "Blobtopus" });
  const [b] = E.addPlates(s, { file: fileP2S, title: "Other" });
  s.printers["p2s-2"].driverId = 3;
  await E.start(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle }, a.id, "p2s-1", async () => {}, { bedClear: true });
  E.markFinished(s, a.id, false, { why: "the printer reported a failure" });
  const n = E.autoRetry(s, a.id);
  assert.ok(n && n.status === "waiting"); assert.equal(n.source.retryOf, a.id); assert.deepEqual(n.avoid, ["p2s-1"]);
  assert.equal(s.order[0], n.id, "the retry goes to the front");
  const L = E.lanes(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle });
  assert.equal(L["p2s-2"].items[0].id, n.id, "planned for the other P2S");
  assert.equal(L["p2s-1"].items[0].id, b.id);
  await E.start(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle }, n.id, "p2s-2", async () => {}, { bedClear: true });
  E.markFinished(s, n.id, false, { why: "the printer reported a failure" });
  assert.equal(E.autoRetry(s, n.id), null, "no third go");
  // with only one fitting printer, "avoid" does not strand the plate
  const [c] = E.addPlates(s, { file: fileP2S, title: "Solo" }); c.avoid = ["p2s-1", "p2s-2"];
  const L2 = E.lanes(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle });
  assert.ok(Object.values(L2).some((l) => l.items.some((x) => x.id === c.id)));
});

test("colour affinity: the printer holding every colour beats one with some, which beats material only", () => {
  const s = state();
  const [p] = E.addPlates(s, { file: fileP2S, filaments: [{ type: "PLA", color: "#FF0000" }, { type: "PLA", color: "#00FF00" }] });
  const live = {
    "p2s-1": { ...idle, trays: [{ ams: 0, slot: 0, type: "PLA", color: "#FF0000" }, { ams: 0, slot: 1, type: "PLA", color: "#0000FF" }] },   // one of two
    "p2s-2": { ...idle, trays: [{ ams: 0, slot: 0, type: "PLA", color: "#FF0000" }, { ams: 0, slot: 1, type: "PLA", color: "#00FF00" }] },   // both
    h2s: idle,
  };
  assert.equal(E.lanes(s, live)["p2s-2"].items[0]?.id, p.id);
  live["p2s-2"].trays = [{ ams: 0, slot: 0, type: "PLA", color: "#FFFFFF" }];   // now only the material
  assert.equal(E.lanes(s, live)["p2s-1"].items[0]?.id, p.id, "one exact colour beats none");
});

test("the first plate on a printer that is free now starts now, even without auto-start; later plates wait for a staffed window", () => {
  const s = state();
  const t = Date.UTC(2026, 9, 14, 12, 0);
  s.settings.tz = "UTC"; s.settings.staffed = [{ from: "23:50", to: "23:59" }];   // nobody there at noon
  s.printers["p2s-1"].autoStart = false;
  const [a, b] = E.addPlates(s, { file: fileP2S, count: 2, minutes: 60 });
  const L = E.lanes(s, { "p2s-1": idle, "p2s-2": { ...idle, connected: false }, h2s: idle }, { t });
  assert.equal(L["p2s-1"].items[0].id, a.id);
  assert.ok(a._eta.start - t < 5 * 60_000, `first plate starts now (in ${(a._eta.start - t) / 60000} min)`);
  assert.equal(new Date(b._eta.start).toISOString(), "2026-10-14T23:50:00.000Z", "the second one waits for the window");
});

test("quality memory: two bad in a row (failed or ≤2 stars) on any printers flags the file; a clear restarts the count", () => {
  const s = state();
  const file = { id: 77, name: "Baby Dragon Fidget.gcode.3mf", model: "P2S" };
  const closed = (pid, at, extra) => { s.plates[pid] = { id: pid, title: "Baby Dragon", file, status: "done", closedAt: at, outcome: { good: 1, oops: 0, ...extra } }; };
  closed("q1", "2026-09-14T10:00:00Z", { stars: 5 });
  closed("q2", "2026-09-14T12:00:00Z", { stars: 2, note: "stringing" });
  assert.equal(E.fileQuality(s, 77).badStreak, null, "one bad plate is not a streak");
  closed("q3", "2026-09-14T14:00:00Z", { good: 0, oops: 1, wasFailed: true });
  const q = E.fileQuality(s, 77);
  assert.ok(q.badStreak, "2 stars then a failure = needs a look"); assert.deepEqual(q.badStreak.map((x) => x.id), ["q3", "q2"]);
  assert.equal(q.avgStars, 3.5); assert.equal(q.bad, 2);
  assert.equal(E.fileQuality(s, 77, { clearedAt: "2026-09-14T13:00:00Z" }).badStreak, null, "after 'fixed' only newer plates count");
  closed("q4", "2026-09-14T16:00:00Z", { stars: 4 });
  assert.equal(E.fileQuality(s, 77).badStreak, null, "a good plate ends the streak");
  assert.equal(E.stars("3"), 3); assert.equal(E.stars(0), null); assert.equal(E.stars(6), null); assert.equal(E.stars(null), null);
});

test("colour matching is perceptual: pastel pink goes to the pink spool, not white; yellow to the yellow", () => {
  const trays = [{ ams: 0, slot: 0, type: "PLA", color: "#000000" }, { ams: 0, slot: 1, type: "PLA", color: "#F5547C" }, { ams: 0, slot: 2, type: "PLA", color: "#F4A925" }, { ams: 0, slot: 3, type: "PLA", color: "#FFFFFF" }];
  const pick = (c) => A.trayMatch({ type: "PLA", color: c }, trays, false).tray.slot;
  assert.equal(pick("#E8AFCF"), 1, "pastel pink -> pink");
  assert.equal(pick("#FEC600"), 2, "yellow -> yellow, not white");
  assert.equal(pick("#FFFFFF"), 3); assert.equal(pick("#000000"), 0);
  assert.equal(pick("#EEEEEE"), 3, "light grey -> white, never a colour");
  assert.ok([1, 2].includes(pick("#0056B8")), "blue with no blue loaded goes to a colour, never to black or white");
  assert.ok(A.trayMatch({ type: "PLA", color: "#0056B8" }, trays, false).colorOff, "blue is 'off' when no blue is loaded");
  assert.deepEqual(A.autoMapping({ filaments: [{ type: "PLA", color: "#E8AFCF" }, { type: "PLA", color: "#000000" }, { type: "PLA", color: "#FFFFFF" }, { type: "PLA", color: "#FEC600" }] }, { trays }), [1, 0, 3, 2]);
});

test("the printer carried on: a plate called failed goes back to printing when the printer is on the same job again", () => {
  const s = state();
  const [a] = E.addPlates(s, { file: { id: 170, name: "LRG-02 Jumbo unicorn - 110%, four colours · H2C.gcode.3mf", model: "P2S" } });
  const p = s.plates[a.id];
  p.status = "failed"; p.printer = "p2s-1"; p.startedAt = new Date(Date.now() - 3 * 3600_000).toISOString(); p.finishedAt = new Date(Date.now() - 20 * 60_000).toISOString(); p.progress = 1;
  assert.equal(E.applyLive(s, { "p2s-1": { connected: true, state: "RUNNING", progress: 7, layer: 18, job: "MIN-02_Mini_hedgehog_P2S" } }).length, 0, "a different job: nothing");
  assert.equal(p.status, "failed");
  assert.equal(E.applyLive(s, { "p2s-1": { connected: false, state: "PAUSE", progress: 7, job: "LRG-02_Jumbo_unicorn_-_110%,_four_colours_·_H2C" } }).length, 0, "off the air: nothing");
  const tr = E.applyLive(s, { "p2s-1": { connected: true, state: "PAUSE", progress: 7, layer: 18, remainingMin: 1086, job: "LRG-02_Jumbo_unicorn_-_110%,_four_colours_·_H2C" } });
  assert.equal(tr.length, 1); assert.equal(tr[0].event, "resumed"); assert.equal(tr[0].was, "failed");
  assert.equal(p.status, "printing"); assert.equal(p.progress, 7); assert.equal(p.finishedAt, undefined);
  assert.match(p.note, /carried on/);
  assert.equal(E.printerState(s.printers["p2s-1"], { connected: true, state: "PAUSE", errors: [] }, Object.values(s.plates)), "paused");
  // the same failure hours ago is not revisited
  p.status = "failed"; p.finishedAt = new Date(Date.now() - 7 * 3600_000).toISOString();
  assert.equal(E.applyLive(s, { "p2s-1": { connected: true, state: "RUNNING", progress: 7, layer: 18, job: "LRG-02_Jumbo_unicorn_-_110%,_four_colours_·_H2C" } }).length, 0);
  assert.equal(E.sameJob("Blobtopus.gcode.3mf", "Blobtopus"), true);
  assert.equal(E.sameJob("Blobtopus.gcode.3mf", "Blobtopus_v2"), true, "the printer may add a suffix");
  assert.equal(E.sameJob("Blobtopus.gcode.3mf", "Mini_hedgehog"), false);
});

test("every colour gets its own AMS slot - the two-tone crab never prints in one colour", () => {
  const trays = [{ ams: 0, slot: 0, type: "PLA", color: "#161616" }, { ams: 0, slot: 1, type: "PLA", color: "#46A8F9" }, { ams: 0, slot: 3, type: "PLA", color: "#F4EE2A" }];
  const crab = { filaments: [{ type: "PLA", color: "#FF6A13" }, { type: "PLA", color: "#000000" }, { type: "PLA", color: "#FFFFFF" }, { type: "PLA", color: "#FEC600" }] };
  const a = A.trayAssign(crab.filaments, trays);
  const slots = a.byNeed.filter(Boolean).map((x) => x.slot);
  assert.equal(new Set(slots).size, slots.length, "no two colours share a slot");
  assert.equal(a.byNeed[3].slot, 3, "yellow keeps the yellow spool"); assert.equal(a.byNeed[1].slot, 0, "black keeps the black spool");
  assert.equal(a.missing.length, 1, "four colours, three spools: one colour has no slot");
  assert.equal(A.autoMapping(crab, { trays }), null, "so it does not start by itself");
  const c = A.filamentCheck(crab, { trays, amsSlots: 4 });
  assert.equal(c.ok, false); assert.match(c.why || "", /each colour needs its own slot/);
  const full = [...trays, { ams: 0, slot: 2, type: "PLA", color: "#FFFFFF" }];
  const m = A.autoMapping(crab, { trays: full });
  assert.equal(new Set(m).size, 4, "four different slots"); assert.equal(m[1], 0); assert.equal(m[2], 2); assert.equal(m[3], 3);
  assert.deepEqual(A.autoMapping({ filaments: [{ type: "PLA", color: "#000000" }, { type: "PLA", color: "#000000" }] }, { trays }), [0, 0], "the same colour twice shares one spool");
});

test("the AMS mapping is indexed by the project's filament slots", () => {
  const plate = { filaments: [{ type: "PLA", color: "#000000", slot: 2 }], projectSlots: 4 };
  assert.deepEqual(A.expandMapping(plate, [5]), [-1, 5, -1, -1]);
  assert.deepEqual(A.expandMapping({ filaments: [{ type: "PLA", color: "#000000" }] }, [5]), [5], "no slot info: as given");
});

test("loading lists: every missing colour gets its own slot, and only a custom job may go ahead in what is loaded", () => {
  const s = state();
  const live = { "p2s-1": { ...idle, plate: { clear: true }, amsSlots: 4, trays: [{ ams: 0, slot: 2, type: "PLA", color: "#FF0000", name: "Red" }] }, "p2s-2": idle, h2s: idle };
  const [a] = E.addPlates(s, { file: fileP2S, printer: "p2s-1", filaments: [{ type: "PLA", color: "#FF6A13" }, { type: "PLA", color: "#FEC600" }, { type: "PLA", color: "#FFFFFF" }], source: { type: "stock" }, colours: "match" });
  const plan = E.colourNeeds(s, live, { perPrinter: 9 }).find((r) => r.plan && r.printer === "p2s-1");
  assert.ok(plan && plan.loads.length === 3, "the day plan's list carries one load per colour");
  assert.equal(new Set(plan.loads.map((l) => `${l.ams}/${l.slot}`)).size, 3, "three different slots");
  // five colours on a four-slot AMS: the plan cannot cover it, the per-plate rows take over - still one slot each
  E.cancel(s, a.id, "test");
  const [b] = E.addPlates(s, { file: fileP2S, printer: "p2s-1", filaments: ["#FF6A13", "#FEC600", "#FFFFFF", "#0000FF", "#00AA00"].map((c) => ({ type: "PLA", color: c })), source: { type: "stock" }, colours: "match" });
  const rows = E.colourNeeds(s, live, { perPrinter: 9 }).filter((r) => r.plate === b.id && !r.plan);
  assert.equal(rows.length, 4, "one row per missing colour (orange rides the red spool)");
  const slots = rows.map((r) => (r.slot ? `${r.slot.ams}/${r.slot.slot}` : null)).filter(Boolean);
  assert.equal(slots.length, 3, "three slots to offer - the fourth says 'any free slot'");
  assert.equal(new Set(slots).size, 3, `three different slots, got ${slots.join(" ")}`);
  assert.ok(rows.every((r) => r.custom === false), "a stock plate's colours are the plan's");
  assert.match(rows[0].how, /The plan chose this colour/);
  const [c] = E.addPlates(s, { file: fileP2S, printer: "p2s-2", filaments: ["#FF6A13", "#FEC600", "#FFFFFF", "#0000FF", "#00AA00"].map((x) => ({ type: "PLA", color: x })), source: { type: "custom" } });
  const live2 = { ...live, "p2s-2": { ...live["p2s-1"] } };
  assert.equal(c.colours, "match", "a custom job defaults to Recommended");
  const crow = E.colourNeeds(s, live2, { perPrinter: 9 }).find((r) => r.plate === c.id && !r.plan);
  assert.ok(crow && crow.custom === true, "a Recommended custom job asks for the spool and may go ahead in what is loaded");
  E.setPlate(s, c.id, { colours: "loaded" });
  assert.ok(!E.colourNeeds(s, live2, { perPrinter: 9 }).find((r) => r.plate === c.id && !r.plan), "an Automatic job asks for nothing");
  const [d] = E.addPlates(s, { file: fileP2S, printer: "p2s-2", filaments: [{ type: "PLA", color: "#FF6A13" }], source: { type: "stock" } });
  assert.equal(d.colours, "loaded", "a stock plate defaults to Automatic");
});

test("start: every colour needs its own roll logged in the AMS", async () => {
  const s = state();
  const four = [{ type: "PLA", color: "#2B2344" }, { type: "PLA", color: "#2BC6B0" }, { type: "PLA", color: "#FFF6E9" }, { type: "PLA", color: "#FFC933" }];
  const trays = [{ ams: 0, slot: 0, type: "PLA", color: "#161616" }, { ams: 0, slot: 1, type: "PLA", color: "#46A8F9" }, { ams: 0, slot: 2, type: "", unknown: true, color: null }, { ams: 0, slot: 3, type: "PLA", color: "#F4EE2A" }];
  const [a] = E.addPlates(s, { file: fileP2S, filaments: four });
  const send = async () => ({ itemId: 1 });
  await assert.rejects(() => E.start(s, { "p2s-1": { ...idle, amsSlots: 4, trays } }, a.id, "p2s-1", send), /4 colours needed, 3 rolls logged/);
  assert.equal(s.plates[a.id].status, "waiting");
  const eight = [...trays, { ams: 1, slot: 0, type: "PLA", color: "#FFFFFF" }];
  await assert.rejects(() => E.start(s, { "p2s-1": { ...idle, amsSlots: 8, trays: eight } }, a.id, "p2s-1", send, { amsMapping: [0, 1, 2, 3] }), /slot 3 .* no roll logged/);
  await assert.rejects(() => E.start(s, { "p2s-1": { ...idle, amsSlots: 4, trays: [] } }, a.id, "p2s-1", send), /0 rolls logged/);
  // a start recorded by hand at the printer (no send) is not gated - the printer did its own check
  const [b] = E.addPlates(s, { file: fileP2S, filaments: four });
  await E.start(s, { "p2s-2": { ...idle, amsSlots: 4, trays } }, b.id, "p2s-2", null);
  assert.equal(s.plates[b.id].status, "printing");
  trays[2] = { ams: 0, slot: 2, type: "PLA", color: "#FFFFFF" };
  let sent = null;
  await E.start(s, { "p2s-1": { ...idle, amsSlots: 4, trays } }, a.id, "p2s-1", async (f, pid, idx, mapping) => { sent = mapping; return { itemId: 2 }; });
  assert.equal(s.plates[a.id].status, "printing");
  assert.deepEqual([...sent].sort(), [0, 1, 2, 3]);
});

test("start: nothing starts until someone confirmed a build plate is on the bed", async () => {
  const s = state();
  s.printers["p2s-1"].plateOn = false;
  const [a] = E.addPlates(s, { file: fileP2S });
  await assert.rejects(() => E.start(s, { "p2s-1": idle }, a.id, "p2s-1", null), /build plate/);
  await E.start(s, { "p2s-1": idle }, a.id, "p2s-1", null, { plateConfirmed: true });
  assert.equal(s.plates[a.id].status, "printing");
});

// A print someone stops is not a failure: the plate still has to come off the bed before the next start, but the words and the
// file's quality record must say "stopped", not "failed".
test("a print stopped by hand is not a failure - the bed still has to be cleared, but nothing is blamed", async () => {
  const s = state();
  const [a] = E.addPlates(s, { file: fileP2S, title: "Seal" });
  E.addPlates(s, { file: fileP2S, title: "Next one" });
  await E.start(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle }, a.id, "p2s-1", async () => {}, { bedClear: true });
  E.markFinished(s, a.id, false, { byHand: "operator", why: "stopped from the app" });
  const p = s.plates[a.id];
  assert.equal(p.status, "failed", "the plate still ends on the bed");
  assert.equal(p.stoppedByHand, "operator");
  assert.equal(E.isBad(p), false, "a hand stop is not held against the file");
  assert.equal(E.fileQuality(s, fileP2S.id).badStreak, null);
  const b = E.board(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle });
  const pr = b.printers.find((x) => x.key === "p2s-1");
  assert.equal(pr.stoppedByHand, "operator");
  assert.match(pr.idleWhy || "", /stopped print is still on the bed/);
  const need = b.needs.find((n) => n.printer === "p2s-1" && n.kind === "failed");
  assert.ok(need, "someone still has to clear the bed");
  assert.equal(need.byHand, "operator");
  assert.match(need.text, /was stopped by hand/);
  const [c] = E.addPlates(s, { file: fileP2S, title: "Other" });
  await E.start(s, { "p2s-2": idle }, c.id, "p2s-2", async () => {}, { bedClear: true });
  E.markFinished(s, c.id, false, { why: "the printer reported a failure" });
  assert.equal(s.plates[c.id].stoppedByHand, undefined);
  assert.equal(E.isBad(s.plates[c.id]), true);
  const need2 = E.board(s, { "p2s-1": idle, "p2s-2": idle, h2s: idle }).needs.find((n) => n.printer === "p2s-2" && n.kind === "failed");
  assert.equal(need2.byHand, null, "nobody stopped this one - it failed");
  assert.doesNotMatch(need2.text, /by hand/);
});

test("a set's remaining plates follow their printer while it is usable, and move when it goes out of service", () => {
  const pr = (key) => ({ key, name: key, model: "P2S", active: true, driverId: key === "a" ? 1 : 2, autoStart: true, plateOn: true });
  const plate = (pid, n, status, printer = null) => ({ id: pid, title: `Set ${n}`, status, printer, anyModel: "P2S", file: { id: 9, model: "P2S" }, set: { id: "S-1", n, of: 2 }, minutes: 60, createdAt: "2026-09-22T10:00:00Z" });
  const s = { printers: { a: pr("a"), b: pr("b") }, plates: { P1: plate("P1", 1, "done", "a"), P2: plate("P2", 2, "waiting") }, order: ["P2"], settings: {} };
  const live = { a: { connected: true, state: "IDLE", trays: [] }, b: { connected: true, state: "IDLE", trays: [] } };
  assert.equal(E.lanes(s, live).a.items[0]?.id, "P2");
  s.printers.a.maintenance = { at: "2026-09-22T11:00:00Z", why: "nozzle" };
  const L = E.lanes(s, live);
  assert.equal(L.a.items.length, 0); assert.equal(L.b.items[0]?.id, "P2");
});

test("idle 30 min with nothing printed: back to the queue; not before, not once it ran, not while the driver says it is printing", () => {
  const st = (startedMinAgo, extra = {}) => ({ printers: { p1: { key: "p1", name: "Printer 1", model: "P2S", active: true } }, order: [],
    plates: { "P-1": { id: "P-1", title: "Frog", status: "printing", printer: "p1", manual: true, dispatched: true, progress: 0, startedAt: new Date(Date.now() - startedMinAgo * 60_000).toISOString(), ...extra } } });
  const s = st(45);
  assert.deepEqual(E.applyLive(s, { p1: { connected: true, state: "IDLE", progress: 0 } }).map((o) => o.event), ["unstarted"]);
  assert.equal(s.plates["P-1"].status, "waiting"); assert.equal(s.order[0], "P-1");
  assert.equal(E.applyLive(st(20), { p1: { connected: true, state: "IDLE", progress: 0 } }).length, 0);
  assert.notEqual(E.applyLive(st(45, { seenRunning: true }), { p1: { connected: true, state: "IDLE", progress: 0 } })[0]?.event, "unstarted");
  assert.equal(E.applyLive(st(45), { p1: { connected: true, state: "IDLE", progress: 0 } }, { "P-1": { status: "printing" } }).length, 0);
});
