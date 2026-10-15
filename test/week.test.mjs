import { test } from "node:test";
import assert from "node:assert/strict";
import * as W from "../src/week.mjs";
import * as C from "../src/categories.mjs";
import * as T from "../src/labtime.mjs";

const tz = "America/Chicago";
const t = Date.parse("2026-09-20T20:00:00Z");   // Sunday 15:00 lab time
const fil = (cols) => cols.map((c) => ({ type: "PLA", color: c }));
const file = (id, name, minutes, cols, extra = {}) => ({ id, name: `${name}.gcode.3mf`, sliced: true, model: "P2S", minutes, grams: 30, filaments: fil(cols), plates: [{ index: 1, minutes, grams: 30, filaments: fil(cols) }], printCount: 0, ...extra });
const files = [
  file(1, "Mini frog", 90, ["#000000", "#ffffff"], { category: "minis" }),
  file(2, "Mini dragon", 120, ["#000000", "#ff0000"], { category: "minis" }),
  file(3, "Fidget star", 60, ["#000000"], { category: "fidgets" }),
  file(4, "Crystal dragon", 300, ["#000000", "#ffffff", "#0000ff"], { category: "dragons" }),
  file(5, "Articulated rex", 540, ["#ffcc00", "#000000"], { category: "premium" }),
  file(6, "Jumbo dragon", 1200, ["#0000ff", "#ffffff", "#000000"], { category: "signature" }),
  { id: 7, name: "Raccoon set.gcode.3mf", sliced: true, model: "P2S", minutes: 600, grams: 80, filaments: fil(["#8b4513", "#000000"]), category: "dragons", printCount: 0,
    plates: [{ index: 1, minutes: 200, grams: 30, filaments: fil(["#8b4513", "#000000"]) }, { index: 2, minutes: 200, grams: 30, filaments: fil(["#8b4513", "#000000"]) }, { index: 3, minutes: 200, grams: 20, filaments: fil(["#8b4513"]) }] },
  file(8, "Big bust", 700, ["#ff00ff", "#00ffff", "#000000", "#ffffff", "#ff0000"], { model: "H2C", category: "large-format" }),
  file(9, "Name tag", 30, ["#ffffff"], { category: "name-tags" }),
  file(10, "Spare hinge", 30, ["#000000"]),   // no category: a manual part
];
const state = { printers: {}, plates: {}, settings: { tz } };

test("selection: recently printed toys go last - new prints first", () => {
  const recent = { ...state, plates: { a: { status: "done", file: { id: 1 }, closedAt: new Date(t - 2 * 86_400_000).toISOString(), outcome: { good: 4 } } } };
  const sel = W.select(files, recent, { mode: "stock", slotsByModel: { P2S: 3, H2C: 0 }, t });
  const minis = sel.jobs.filter((j) => j.category === "minis");
  assert.ok(minis.length && minis[0].fileId === 2, "the mini dragon (never printed) before the mini frog (printed two days ago)");
  assert.ok(sel.recentSkipped.includes("Mini frog"));
});

test("selection: a balanced mix by category weight, sets counted whole, files taken out of planning left out, manual parts never", () => {
  const sel = W.select(files, { ...state, settings: { tz, repeatOff: [5] } }, { mode: "stock", slotsByModel: { P2S: 20, H2C: 4 }, t });
  assert.ok(sel.jobs.length > 8);
  assert.ok(!sel.jobs.some((j) => j.fileId === 5), "taken out of planning stays out");
  assert.ok(!sel.jobs.some((j) => j.fileId === 10), "a file with no category is a manual part");
  const cats = sel.byCategory;
  assert.ok((cats.minis || 0) >= (cats.dragons || 0), "minis weigh most");
  assert.ok(sel.jobs.some((j) => j.setOf === 3), "the set is one job");
  assert.equal(sel.jobs.filter((j) => j.category === "name-tags").length, 0, "weight 0 = only on demand");
  const flagged = W.select(files.map((f) => (f.id === 2 ? { ...f, flag: true } : f)), state, { mode: "stock", slotsByModel: { P2S: 20 }, t });
  assert.ok(!flagged.jobs.some((j) => j.fileId === 2), "a file with a bad streak waits for someone to look at it");
});

test("selection: the toy behind a file ignores the model, copies and plate n of m", () => {
  assert.equal(W.toyKey("Crystal dragon x2 · H2S.gcode.3mf"), "crystal dragon");
  assert.equal(W.toyKey("Crystal dragon · plate 2 of 3"), "crystal dragon");
  assert.equal(W.toyKey("Mini owl · A1 mini"), "mini owl");
});

test("categories: folder names and tags map to slugs; the mix keeps its shape; custom categories work", () => {
  assert.equal(C.slugOf("01 Minis"), "minis"); assert.equal(C.slugOf("04 Signature pieces"), "signature"); assert.equal(C.slugOf("fidget"), "fidgets");
  assert.equal(C.slugOf("Name tags"), "name-tags"); assert.equal(C.slugOf("done"), null);
  assert.equal(C.tagIn("Baby dragon [minis].3mf"), "minis");
  assert.equal(C.guessFrom("DRG-03 Sea serpent"), "dragons");
  assert.equal(C.mixOf({ mix: { minis: 50, bogus: 9 } }).minis, 50);
  assert.equal(C.mixOf({ mix: { minis: 50, bogus: 9 } }).bogus, undefined);
  const mine = { categories: [{ slug: "boats", label: "Boats", weight: 70 }, { slug: "cars", label: "Cars", weight: 30 }] };
  assert.deepEqual(C.mixOf(mine), { boats: 70, cars: 30 });
  assert.equal(C.slugOf("car", C.categoriesOf(mine)), "cars");
});

test("lab time: atLab lands on the asked wall-clock time on both DST Sundays and at month edges", () => {
  const lab = (x) => new Date(x).toLocaleString("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const [d, h, want] of [["2026-11-01", "06:30", "11/01/2026, 06:30"], ["2026-03-08", "06:30", "03/08/2026, 06:30"], ["2026-10-31", "19:30", "10/31/2026, 19:30"], ["2026-10-01", "00:30", "10/01/2026, 00:30"], ["2026-09-22", "21:00", "09/22/2026, 21:00"]])
    assert.equal(lab(T.atLab(d, h, tz)), want, `${d} ${h}`);
});

test("lab time: the week being planned, the lab date and the weekday follow the lab's zone, not the host's", () => {
  assert.equal(T.mondayOf(t, tz), "2026-09-21", "a Sunday plans the next week");
  assert.equal(T.mondayOf(Date.parse("2026-09-23T15:00:00Z"), tz), "2026-09-21");
  const evening = Date.parse("2026-09-23T02:30:00Z");   // Tuesday 21:30 in the lab, Wednesday in UTC
  assert.equal(T.labDate(evening, tz), "2026-09-22"); assert.equal(T.weekdayOf(evening, tz), 1);
  assert.equal(T.labDate(evening, "UTC"), "2026-09-23");
});
