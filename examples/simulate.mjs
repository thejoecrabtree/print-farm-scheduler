// A week on a ten-printer farm, simulated with the real scheduler and a fictional catalogue.
//
//   node examples/simulate.mjs                 the default week
//   node examples/simulate.mjs --days 3 --seed 11 --fail 0.05
//
// What happens, in virtual time, every five minutes:
//   - printers print; a few prints fail (seeded, so every run is the same) and are retried once on another printer,
//   - in staffed hours (07:00-22:00) the operator takes finished plates off, confirms a clean build plate, and loads the spools a
//     plate needs before it starts; outside them, a finished plate waits on the bed until morning,
//   - every 30 minutes Fill tops each printer's line up to three days ahead (add only),
//   - the starter starts the head of each line when its computed time has come, one start per five minutes (the power stagger).
// Monday 00:05 the week plans itself from the standing goals and applies itself if the review has no warnings. Tuesday a customer
// order is dropped on one printer by hand. Wednesday morning the operator types new goals in plain words; a stand-in for the
// language model turns them into goals, the preview shows what would change, and Apply leaves started and hand-placed plates alone.
import { pathToFileURL } from "node:url";
import { engine, lines, filler, goals as G, starter, labtime as T, dayplan, week } from "../src/index.mjs";
import { files, fleet, weeklyDemand, demandFor, colourName } from "./catalogue.mjs";
import { proposeGoals } from "./propose-goals-stub.mjs";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const show = (title) => String(title || "").replace(/ · (P1S|P2S|X1C|H2S|H2D|H2C|A1 ?MINI|A1)\b/i, "");
const LETTER = { minis: "m", fidgets: "f", dragons: "d", premium: "p", signature: "S", "large-format": "L", robots: "r", "name-tags": "t" };

// a small seeded PRNG, so a run is repeatable
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

// the AMS as a list of slots; load the colours a plate needs, replacing the least recently used spool this plate does not need
function loadColours(ams, needs, t) {
  let loads = 0;
  for (const n of needs) {
    const have = ams.trays.find((x) => week.same(n, x));
    if (have) { have.usedAt = t; continue; }
    const usedSlots = new Set(ams.trays.map((x) => x.ams * 4 + x.slot));
    let slot = null;
    for (let g = 0; g < ams.slots; g++) if (!usedSlots.has(g)) { slot = g; break; }
    if (slot == null) {
      const spare = ams.trays.filter((x) => !needs.some((m) => week.same(m, x))).sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0))[0];
      if (!spare) continue;
      slot = spare.ams * 4 + spare.slot; ams.trays = ams.trays.filter((x) => x !== spare);
    }
    ams.trays.push({ ams: Math.floor(slot / 4), slot: slot % 4, type: n.type, color: n.color, name: colourName(n.type, n.color) || n.color, remain: 100, usedAt: t });
    loads++;
  }
  return loads;
}

export async function simulate({ monday = "2026-10-19", days = 7, tz = "America/Chicago", seed = 7, failRate = 0.03, stepMin = 5, fillEveryMin = 30,
  goalText = "more dragons, half the minis, 4 sea serpents by Friday", goalAt = { day: 2, time: "09:00" }, orderAt = { day: 1, time: "10:00" }, print = console.log } = {}) {
  const rand = rng(seed);
  let n = 0; const newId = (prefix) => `${prefix}-${String(++n).padStart(4, "0")}`;
  const { printers, live } = fleet();
  const initial = structuredClone(live);
  const settings = { tz, staffed: [{ from: "07:00", to: "22:00" }], swapMinutes: 15, startGapMinutes: 5, fillDays: 3, autoFillChanges: 1, goals: { changes: 2 } };
  const state = { printers, plates: {}, order: [], settings };
  const staffed = T.staffedOf(settings);
  const t0 = T.atLab(monday, "00:05", tz), tEnd = T.atLab(T.dayDate(monday, days), "00:00", tz);
  const when = (x) => T.clock(x, tz);
  const ends = {}; const fails = {}; const history = []; const unplaced = new Map(); const stockLeftOut = new Set();
  let lastStartAt = 0, loads = 0, unattended = 0, failures = 0, retries = 0, fillsAdded = 0;
  const out = { t0, tEnd };

  // what sells, less what the farm printed this week (a shop would refresh this from its stock)
  const doneOf = (sku) => Object.values(state.plates).filter((p) => p.status === "done" && !p.outcome?.wasFailed && p.sku === sku).length;
  const baseDemand = () => demandFor(weeklyDemand.map((r) => ({ ...r, plates: Math.max(0, r.plates - doneOf(r.sku)) }))).filter((r) => r.plates > 0);
  const fill = (t) => {
    const goals = G.standingGoals(state.settings);
    const rows = G.demandRows(files, goals, baseDemand());
    const plan = filler.plan(state, files, { t, live, settings: state.settings, demand: rows.demand, must: rows.must, mix: goals.mix, maxChanges: state.settings.autoFillChanges });
    for (const u of plan.unplaced) if (u.kind === "stock") stockLeftOut.add(u.name); else unplaced.set(show(u.name), u.why);
    fillsAdded += filler.applyPlan(state, plan, files, { by: "auto", t, newId }).added.length;
  };
  const boardAt = (t) => {
    const built = lines.build(state, live, { t, settings, files });
    print(`\n${when(t)}  the board (now / next / then, with ETAs)`);
    for (const [key, ln] of Object.entries(built.lines)) {
      const head = ln.blocks.find((b) => b.kind === "printing" || b.kind === "paused" || b.kind === "finished-on-bed");
      const waiting = ln.blocks.filter((b) => b.kind === "waiting");
      const row = (left, label, title, times) => print(`  ${left.padEnd(16)}${label.padEnd(11)}${title.padEnd(36)}${times}`);
      const left = `${key.padEnd(11)}${printers[key].model}`;
      if (head) row(left, head.kind === "finished-on-bed" ? "on the bed" : head.kind, show(head.title), head.kind === "finished-on-bed" ? `until ${when(head.end)}` : `ends ${when(head.end)}`);
      else row(left, "idle", "", waiting[0] ? `(${ln.wouldWhy || "starting"})` : "");
      for (const [i, b] of waiting.slice(0, 3).entries()) row("", i ? "then" : "next", show(b.title), `${when(b.start)} - ${when(b.end)}${b.load ? `  load ${b.load.map((c) => colourName(c.type, c.color) || c.color).join(", ")}` : ""}`);
    }
  };

  print(`print-farm-scheduler: a simulated week from Mon ${monday} (${tz})`);
  print(`10 printers (8 P2S, 1 H2S, 1 H2C) · staffed ${staffed.map((w) => `${w.from}-${w.to}`).join(", ")} · ${files.length} files, ${G.catalogOf(files).length} toys · seed ${seed}`);

  for (let t = t0; t < tEnd; t += stepMin * MIN) {
    const staffedNow = T.isStaffed(t, staffed, tz);
    // 1. the printers
    for (const [key, l] of Object.entries(live)) {
      const p = Object.values(state.plates).find((x) => x.printer === key && x.status === "printing"); if (!p) continue;
      if (t >= ends[p.id]) Object.assign(l, { state: fails[p.id] ? "FAILED" : "FINISH", remainingMin: 0, progress: fails[p.id] ? 40 : 100 });
      else Object.assign(l, { state: "RUNNING", remainingMin: Math.ceil((ends[p.id] - t) / MIN), progress: Math.round(100 * (1 - (ends[p.id] - t) / (ends[p.id] - Date.parse(p.startedAt)))) });
    }
    for (const e of engine.applyLive(state, live, {}, { t })) if (e.event === "failed") { failures++; if (engine.autoRetry(state, e.plate.id, { t, newId })) retries++; }
    // 2. the operator: plates off, a clean build plate confirmed
    if (staffedNow) for (const p of Object.values(state.plates).filter((x) => x.status === "finished" || x.status === "failed")) {
      engine.off(state, p.id, { good: p.status === "finished" ? 1 : 0, oops: p.status === "failed" ? 1 : 0, t });
      Object.assign(live[p.printer], { state: "IDLE", job: "", progress: 0, remainingMin: 0 }); printers[p.printer].plateOn = true;
    }
    // 3. planning
    if (t === t0) {
      const ap = G.autoPlan({ state, files, live, t, demand: baseDemand(), newId });
      const placed = ap.plan.add.reduce((x, a) => x + a.plates.length, 0);
      print(`\n${when(t)}  auto-plan from the standing goals: ${placed} plates on ${Object.keys(ap.plan.lines).length} lines, ${ap.stats.changes} colour-set changes, ${ap.plan.days} days ahead (planned in ${ap.ms} ms)`);
      print(`            review: ${ap.review.summary} -> ${ap.applied ? "applied by itself" : "left as a preview for someone"}`);
      for (const f of ap.review.findings.slice(0, 4)) print(`            (${f.level}) ${f.text}`);
      out.autoPlan = { applied: ap.applied, warnings: ap.review.warnings, plates: placed, ms: ap.ms };
    } else if ((t - t0) % (fillEveryMin * MIN) === 0) fill(t);
    if (t === T.atLab(T.dayDate(monday, 0), "06:55", tz)) {
      // the colour day plan: what to load on each printer for today's plates, in one go
      const built = lines.build(state, live, { t, settings, files });
      const endOfDay = T.atLab(T.dayDate(monday, 1), "00:00", tz);
      const today = new Set(Object.values(built.lines).flatMap((ln) => ln.blocks.filter((b) => b.kind === "waiting" && b.start < endOfDay).map((b) => b.plateId)));
      const plan = dayplan.dayPlan(state, live, { fits: engine.fits, nameOf: colourName, include: (pid) => today.has(pid) });
      print(`\n${when(t)}  the colour day plan (today's plates, one loading list per printer)`);
      for (const pr of plan.printers) print(`  ${pr.key.padEnd(10)} ${String(pr.plates).padStart(2)} plates  keep ${pr.keep.map((k) => k.name).join(", ") || "-"}${pr.loads.length ? ` · load ${pr.loads.map((l) => `${l.name} -> slot ${l.ams * 4 + l.slot + 1}${l.empty ? "" : ` (for ${l.replaces})`}`).join(", ")}` : " · nothing to load"}`);
    }
    if (t === T.atLab(T.dayDate(monday, orderAt.day), orderAt.time, tz)) {
      const tag = files.find((f) => f.sku === "name-tag");
      const made = engine.addPlates(state, { file: tag, sku: tag.sku, count: 3, printer: "printer-4", source: { type: "custom", ref: "order-1001" }, title: "Name tag (order)", t, newId });
      for (const p of made) p.locked = true;
      engine.prioritizeCustom(state);
      print(`\n${when(t)}  a customer order: 3 name tags dropped on printer-4 by hand (custom, locked) - they go ahead of the stock`);
      out.order = made.map((p) => p.id);
    }
    if (goalText && t === T.atLab(T.dayDate(monday, goalAt.day), goalAt.time, tz)) {
      const before = G.standingGoals(state.settings);
      const said = await G.goalsFromText(goalText, { proposeGoals, files, settings: state.settings, t });
      const changed = Object.keys(said.goals.mix).filter((k) => said.goals.mix[k] !== before.mix[k]).map((k) => `${k} ${before.mix[k]} -> ${said.goals.mix[k]}`);
      const pv = G.previewGoals({ state, files, goals: said.goals, live, t, demand: baseDemand() });
      const rv = G.reviewPlan(pv.plan, said.goals, { state, files });
      const startedBefore = Object.values(state.plates).filter((p) => p.status !== "waiting" || p.locked).map((p) => JSON.stringify(p));
      print(`\n${when(t)}  the operator types: "${goalText}"`);
      print(`            the model (an offline stand-in here) wrote goals: ${[...changed, ...said.goals.must.map((m) => `must ${m.plates} x ${m.sku} by ${m.by}`)].join("; ")}`);
      print(`            preview in ${pv.ms} ms: ${pv.stats.added} plates in, ${pv.stats.removed} replaced, ${pv.stats.kept} kept, ${pv.stats.changes} colour-set changes`);
      print(`            review: ${rv.summary}`);
      for (const f of rv.findings.slice(0, 4)) print(`            (${f.level}) ${f.text}`);
      const r = G.applyGoals(state, pv.plan, files, said.goals, { by: "operator", t, newId });
      const untouched = startedBefore.every((s) => { const p = JSON.parse(s); return JSON.stringify(state.plates[p.id]) === s; });
      print(`            Apply: ${r.added.length} added, ${r.removed} cancelled; every started, printing, done and hand-placed plate untouched: ${untouched ? "yes" : "NO"}`);
      out.goals = { ms: pv.ms, untouched, warnings: rv.warnings, since: t };
    }
    // 4. the starter: each line's head when its time has come, one start per pass, the power stagger between starts
    if (t - lastStartAt >= engine.startGapMs(settings)) {
      const built = lines.build(state, live, { t, settings, files });
      for (const pick of starter.linePicks(built, state, live, { t }).picks) {
        const plate = state.plates[pick.plate]; const l = live[pick.printer];
        const needs = week.coloursOf(plate);
        const missing = needs.filter((c) => !l.trays.some((x) => week.same(c, x)));
        if (missing.length && !staffedNow) continue;              // a spool change needs someone: it waits for the morning
        const ams = { trays: l.trays, slots: l.amsSlots };
        loads += loadColours(ams, needs, t); l.trays = ams.trays;
        await engine.start(state, live, plate.id, pick.printer, async () => ({ itemId: n }), { t });
        plate.dispatched = true;                                   // the driver confirmed the printer took the file
        const minutes = Math.round((plate.minutes || 60) * (0.92 + rand() * 0.16));
        fails[plate.id] = rand() < failRate;
        ends[plate.id] = t + (fails[plate.id] ? Math.round(minutes * 0.4) : minutes) * MIN;
        Object.assign(l, { state: "RUNNING", job: plate.file.name, remainingMin: minutes, progress: 0 });
        if (!staffedNow) unattended++;
        const file = files.find((f) => f.id === plate.file.id);
        history.push({ id: plate.id, kind: plate.source?.kind || plate.source?.type, printer: pick.printer, model: printers[pick.printer].model, title: plate.title, sku: plate.sku, category: file?.category, start: t, end: ends[plate.id], failed: fails[plate.id], colours: needs });
        lastStartAt = t;
        break;
      }
    }
    if (t === T.atLab(monday, "09:00", tz)) boardAt(t);
  }

  // ---- the week, three hours per character
  const SLOT = 3 * HOUR, perDay = 24 / 3;
  print(`\nThe week, three hours per character (${Object.entries(LETTER).map(([c, l]) => `${l} ${c}`).join(", ")}; x failed; . idle)`);
  print(`${"".padEnd(13)}${Array.from({ length: days }, (_, d) => T.dayName(d).padEnd(perDay + 1)).join("")}`);
  for (const key of Object.keys(printers)) {
    let row = "";
    const startOfWeek = T.atLab(monday, "00:00", tz);
    for (let d = 0; d < days; d++) {
      for (let s = 0; s < perDay; s++) {
        const a = startOfWeek + d * DAY + s * SLOT, b = a + SLOT;
        let best = null, bestMs = 0;
        for (const h of history) if (h.printer === key) { const ms = Math.min(b, h.end) - Math.max(a, h.start); if (ms > bestMs) { bestMs = ms; best = h; } }
        row += !best || bestMs < SLOT / 3 ? "." : best.failed ? "x" : LETTER[best.category] || "?";
      }
      row += " ";
    }
    print(`  ${key.padEnd(11)}${row}`);
  }

  // ---- the numbers
  const tEndSim = tEnd;
  const printed = history.filter((h) => h.end <= tEndSim);
  const okPlates = printed.filter((h) => !h.failed).length;
  const busyMs = history.reduce((x, h) => x + Math.max(0, Math.min(h.end, tEndSim) - h.start), 0);
  // the naive baseline: the same plates in the same order, each to the printer of its model that is free first, no colour awareness;
  // spools change per plate whenever its colours are not loaded (the same loading rule as above)
  const naive = Object.entries(initial).map(([key, l]) => ({ key, model: printers[key].model, free: t0, ams: { trays: structuredClone(l.trays), slots: l.amsSlots } }));
  let naiveLoads = 0;
  for (const h of [...history].sort((a, b) => a.start - b.start)) {
    const x = naive.filter((p) => p.model === h.model).sort((a, b) => a.free - b.free || a.key.localeCompare(b.key))[0];
    naiveLoads += loadColours(x.ams, h.colours, Math.max(x.free, h.start));
    x.free = Math.max(x.free, h.start) + (h.end - h.start) + 15 * MIN;
  }
  const built = lines.build(state, live, { t: tEndSim, settings, files });
  const waiting = Object.values(built.lines).flatMap((ln) => ln.blocks.filter((b) => b.kind === "waiting"));
  const fridayEnd = T.atLab(T.dayDate(monday, 5), "00:00", tz);
  // a must counts every plate of its toy finished since the ask, whichever goal put it on the line (select's rule)
  const serpents = out.goals ? history.filter((h) => h.sku === "sea-serpent" && !h.failed && h.end > out.goals.since && h.end <= fridayEnd).sort((x, y) => x.end - y.end) : [];
  print(`\nSummary`);
  print(`  plates started: ${history.length} · finished fine: ${okPlates} · failed: ${failures} (retried once on another printer: ${retries})`);
  print(`  printer time used: ${Math.round(busyMs / HOUR)} of ${Math.round((Object.keys(printers).length * (tEndSim - t0)) / HOUR)} printer-hours (${Math.round((100 * busyMs) / (Object.keys(printers).length * (tEndSim - t0)))} %) · unattended starts: ${unattended}`);
  print(`  spool loads: ${loads} with the planner vs ${naiveLoads} naive (same plates, first free printer, a swap whenever a plate's colours are missing): ${naiveLoads - loads} saved (${naiveLoads ? Math.round((100 * (naiveLoads - loads)) / naiveLoads) : 0} %)`);
  if (out.goals) print(`  the must-have (4 sea serpents by Friday): ${serpents.length} finished between the ask and the end of Friday${serpents.length >= 4 ? `, the fourth at ${when(serpents[3].end)}` : ""}`);
  print(`  the customer order: ${(out.order || []).filter((pid) => state.plates[pid]?.status === "done").length} of 3 name tags done`);
  print(`  unplaced: ${unplaced.size} asked-for toy${unplaced.size === 1 ? "" : "s"} Fill could not land at some point${unplaced.size ? " (why, as last seen):" : ""}`);
  for (const [name, why] of [...unplaced].slice(0, 6)) print(`    ${name}: ${why}`);
  print(`  (and ${stockLeftOut.size} stock toys offered by select() but left out at least once - normal: it offers more than the horizon holds)`);
  if (built.unplaced.length) for (const u of built.unplaced.slice(0, 4)) print(`    ${u.title}: ${u.why}`);
  print(`  at the end: ${waiting.length} plates waiting on the lines; ETAs per printer, last planned plate ends:`);
  for (const [key, ln] of Object.entries(built.lines)) { const w = ln.blocks.filter((b) => b.kind === "waiting"); print(`    ${key.padEnd(10)} ${String(w.length).padStart(2)} waiting${w.length ? `, next ${when(w[0].start)}, last ends ${when(w.at(-1).end)}` : ""}`); }
  Object.assign(out, { history, loads, naiveLoads, failures, retries, unattended, okPlates, fillsAdded, state });
  return out;
}

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await simulate({ days: Number(arg("days", 7)), seed: Number(arg("seed", 7)), failRate: Number(arg("fail", 0.03)), monday: arg("monday", "2026-10-19") });
}
