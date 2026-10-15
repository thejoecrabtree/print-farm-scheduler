// Goals are the plan: sliders and words change the goals; a deterministic planner places the plates.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../src/goals.mjs";
import * as lines from "../src/lines.mjs";
import * as engine from "../src/engine.mjs";
import { atLab } from "../src/labtime.mjs";
import { files, fleet, demandFor } from "../examples/catalogue.mjs";
import { proposeGoals } from "../examples/propose-goals-stub.mjs";

const TZ = "America/Chicago";
const WED = atLab("2026-10-21", "09:00", TZ);
let n = 0; const newId = (p) => `${p}-${++n}`;
const farm = () => { const { printers, live } = fleet(); return { state: { printers, plates: {}, order: [], settings: { tz: TZ, staffed: [{ from: "07:00", to: "22:00" }], fillDays: 2 } }, live }; };

test("cleanGoals: known categories only, plates and budget clamped, dates checked", () => {
  const base = G.standingGoals({});
  const g = G.cleanGoals({ mix: { minis: 250, bogus: 5, dragons: "40" }, targets: { "mini-axolotl": 99, "bad key!": 3 }, must: [{ sku: "sea-serpent", plates: 4, by: "2026-10-23" }, { sku: "x", plates: 0 }, { sku: "rex", plates: 2, by: "Friday" }], changes: 9 }, base);
  assert.equal(g.mix.minis, 100); assert.equal(g.mix.dragons, 40); assert.equal(g.mix.bogus, undefined);
  assert.deepEqual(g.targets, { "mini-axolotl": 40 });
  assert.deepEqual(g.must, [{ sku: "sea-serpent", plates: 4, by: "2026-10-23" }, { sku: "rex", plates: 2 }], "a non-date `by` is dropped, a zero-plate ask too");
  assert.equal(g.changes, 6);
  assert.deepEqual(G.cleanGoals({ targets: null, must: null }, g).must, []);
});

test("words -> goals: the model writes goals, names are mapped to skus, unknown toys are dropped and reported", async () => {
  const { state } = farm();
  const out = await G.goalsFromText("more dragons, half the minis, 4 sea serpents by Friday, 6 mini axolotls, 3 unicorn cupcakes", { proposeGoals, files, settings: state.settings, t: WED });
  assert.equal(out.goals.mix.dragons, 30); assert.equal(out.goals.mix.minis, 15);
  assert.equal(out.goals.targets["mini-axolotl"], 6);
  assert.deepEqual(out.goals.must.map((m) => [m.sku, m.plates, m.by]), [["sea-serpent", 4, "2026-10-23"]], "'Friday' on a Wednesday is the 23rd");
  assert.equal(out.goals.must[0].since, new Date(WED).toISOString());
  assert.match(out.notes, /understood/);
  // a model that names a toy that does not exist: dropped, never invented
  const liar = async () => ({ targets: { "Golden goose": 5 }, must: [{ toy: "Moon rocket", plates: 2 }] });
  const l = await G.goalsFromText("anything", { proposeGoals: liar, files, settings: state.settings, t: WED });
  assert.deepEqual(l.dropped, ["Golden goose", "Moon rocket"]); assert.deepEqual(l.goals.targets, {}); assert.deepEqual(l.goals.must, []);
  await assert.rejects(G.goalsFromText("", { proposeGoals, files }), /say what you want/);
});

test("resolveDay: weekdays become the next such lab date, today included", () => {
  assert.equal(G.resolveDay("friday", WED, TZ), "2026-10-23");
  assert.equal(G.resolveDay("Wed", WED, TZ), "2026-10-21");
  assert.equal(G.resolveDay("monday", WED, TZ), "2026-10-26");
  assert.equal(G.resolveDay("tomorrow", WED, TZ), "2026-10-22");
  assert.equal(G.resolveDay("2026-11-02", WED, TZ), "2026-11-02");
  assert.equal(G.resolveDay("soon", WED, TZ), null);
});

test("preview changes nothing; Apply never touches started, custom or hand-placed plates, and the lines then match the preview", async () => {
  const { state, live } = farm();
  // a first plan, then a few plates start and an operator drops an order by hand
  const first = G.planGoals({ state, files, live, t: WED, demand: demandFor() });
  G.applyGoals(state, first, files, G.standingGoals(state.settings), { t: WED, newId });
  const started = Object.values(state.plates).filter((p) => p.printer === "printer-1").slice(0, 1);
  for (const p of started) await engine.start(state, live, p.id, "printer-1", null, { t: WED });
  const [hand] = engine.addPlates(state, { file: files.find((f) => f.sku === "name-tag"), printer: "printer-4", source: { type: "custom" }, t: WED, newId });
  hand.locked = true;
  const before = JSON.stringify(state);
  const said = await G.goalsFromText("no minis, more fidget toys, 3 crystal dragons by Thursday", { proposeGoals, files, settings: state.settings, t: WED + 60_000 });
  const pv = G.previewGoals({ state, files, goals: said.goals, live, t: WED + 60_000, demand: demandFor() });
  assert.equal(JSON.stringify(state), before, "the preview is dry");
  assert.ok(pv.ms < 2000, `fast enough for a slider (${pv.ms} ms)`);
  assert.ok(pv.stats.added > 0 && pv.stats.removed > 0);
  assert.ok(!pv.plan.add.some((a) => a.category === "minis"), "no minis in the new plan");
  const keepers = Object.values(state.plates).filter((p) => p.status !== "waiting" || p.locked || p.source?.type !== "stock").map((p) => JSON.stringify(p));
  G.applyGoals(state, pv.plan, files, said.goals, { by: "operator", t: WED + 60_000, newId });
  for (const k of keepers) { const p = JSON.parse(k); assert.equal(JSON.stringify(state.plates[p.id]), k, `${p.title} untouched`); }
  assert.deepEqual(state.settings.goals.must.map((m) => m.sku), ["crystal-dragon"], "Apply keeps the goals as the standing ones");
  // the lines now show every planned plate at the time the preview gave it
  const built = lines.build(state, live, { t: WED + 60_000, settings: state.settings, files });
  const startOf = new Map(Object.values(built.lines).flatMap((ln) => ln.blocks.filter((b) => b.plateId).map((b) => [b.plateId, b.start])));
  const fresh = Object.values(state.plates).filter((p) => p.createdAt === new Date(WED + 60_000).toISOString());
  const planned = pv.plan.add.flatMap((a) => a.plates.map((pl) => ({ printer: a.printer, fileId: a.fileId, start: pl.start })));
  assert.ok(fresh.length > 5 && Object.keys(pv.plan.keepAt).length > 0, `something new and something kept (${fresh.length} new, ${Object.keys(pv.plan.keepAt).length} kept)`);
  for (const p of fresh) assert.ok(planned.some((x) => x.printer === p.printer && x.fileId === p.file.id && x.start === startOf.get(p.id)), `${p.title} on ${p.printer} at its previewed time`);
  for (const [pid, at] of Object.entries(pv.plan.keepAt)) assert.equal(startOf.get(pid), at, "a kept plate takes the time its job had in the preview");
});

test("review: a must-have that cannot be met in time is a warning; a toy that failed twice in a row is a warning", () => {
  const { state, live } = farm();
  const goals = G.cleanGoals({ must: [{ sku: "jumbo-crystal-dragon", plates: 9, by: "2026-10-21", since: new Date(WED).toISOString() }] }, G.standingGoals(state.settings));
  const plan = G.planGoals({ state, files, goals, live, t: WED });
  const rv = G.reviewPlan(plan, goals, { state, files });
  assert.ok(rv.warnings >= 1);
  assert.ok(rv.findings.some((f) => f.level === "warn" && /Jumbo crystal dragon/.test(f.text)), JSON.stringify(rv.findings));
  // two bad prints in a row of a file the plan wants
  const shark = files.find((f) => f.sku === "flexi-shark");
  for (const [i, at] of ["2026-10-20T10:00:00Z", "2026-10-20T14:00:00Z"].entries()) state.plates[`bad${i}`] = { id: `bad${i}`, title: "Flexi shark", file: { id: shark.id }, status: "done", closedAt: at, outcome: { good: 0, oops: 1, wasFailed: true } };
  const p2 = G.planGoals({ state, files, goals: G.cleanGoals({ targets: { "flexi-shark": 2 } }, G.standingGoals(state.settings)), live, t: WED });
  assert.ok(G.reviewPlan(p2, G.standingGoals(state.settings), { state, files }).findings.some((f) => f.level === "warn" && /last two prints failed/.test(f.text)));
});

test("auto-plan: applies itself when the review has no warnings, stays a preview when it has one; due on Monday after 00:05 once", () => {
  const { state, live } = farm();
  const mon = atLab("2026-10-19", "00:05", TZ);
  const ok = G.autoPlan({ state, files, live, t: mon, demand: demandFor(), newId });
  assert.equal(ok.review.warnings, 0, JSON.stringify(ok.review.findings)); assert.equal(ok.applied, true);
  assert.ok(Object.keys(state.plates).length > 20, "the plates are on the lines");
  const { state: s2, live: l2 } = farm();
  s2.settings.goals = { must: [{ sku: "dragon-bust", plates: 12, by: "2026-10-19" }] };   // twelve 12-hour busts on one H2C by tonight: impossible
  const no = G.autoPlan({ state: s2, files, live: l2, t: mon, newId });
  assert.ok(no.review.warnings > 0); assert.equal(no.applied, false); assert.equal(Object.keys(s2.plates).length, 0, "nothing applied");
  assert.equal(G.autoPlanDue(mon, { settings: { tz: TZ } }), true);
  assert.equal(G.autoPlanDue(mon, { settings: { tz: TZ }, lastRunDay: "2026-10-19" }), false, "once a day");
  assert.equal(G.autoPlanDue(atLab("2026-10-19", "00:01", TZ), { settings: { tz: TZ } }), false);
  assert.equal(G.autoPlanDue(atLab("2026-10-20", "09:00", TZ), { settings: { tz: TZ } }), false, "Mondays only");
});
