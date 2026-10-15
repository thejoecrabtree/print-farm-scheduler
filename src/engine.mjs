// The engine: plates, the queue, per-printer lanes, ETAs and every state transition.
//
// The model in one paragraph: a PLATE is one sliced file printed once on one printer. The QUEUE is one ordered list of plates;
// order = priority. Each plate is pinned to a printer or open to "any printer that fits". Each printer's LANE (now -> next -> then)
// and every ETA are derived from the queue plus the staffed windows. Starting hands the file to a printer driver; finishing is read
// from the printer; "plate off" counts the pieces and closes the plate.
//
// Functions take the state and a `live` map ({ printerKey: liveStatus }) and never do I/O. Mutations change the `state` object they
// are given; persisting it is the caller's job. Every function that needs the time takes it as `t` (default: now).
//
//   state = { printers: { key: Printer }, plates: { id: Plate }, order: [plateId …], settings }
//   Printer = { key, name, number?, model, active, autoStart?, driverId?, plateOn?, maintenance?, stopped?, fillOff?, asleep?, waking? }
//   live[key] = { connected, state: "IDLE"|"RUNNING"|"PREPARE"|"PAUSE"|"FINISH"|"FAILED"…, progress, remainingMin, job, trays, amsSlots,
//                 errors?: [{ kind: "stop"|"notice", text }], plate?: { clear } (an optional bed-clear sensor), storage? }
import { id as newPlateId, iso, modelKey, fam, err } from "./util.mjs";
import { tzOf, staffedOf, nextStaffed, labDate, clock } from "./labtime.mjs";
import { dayPlan } from "./dayplan.mjs";
import { filamentCheck, filamentScore, trayAssign, colorDist, expandMapping, autoMapping, COLOUR_OFF } from "./ams.mjs";

export { err };
export const PLATE_STATUS = ["waiting", "needs-file", "printing", "finished", "failed", "done", "hold", "cancelled"];
export const QUEUE_STATUSES = new Set(["waiting", "needs-file", "hold"]);
const MS = 60_000;

export const DEFAULT_SETTINGS = {
  tz: "UTC",
  staffed: [{ from: "06:30", to: "22:00" }],   // when someone is in the lab (labtime.mjs)
  swapMinutes: 15,                             // handling time between two plates on one printer
  startGapMinutes: 5,                          // the power stagger (below)
};
export function blankState(settings = {}) {
  return { printers: {}, plates: {}, order: [], settings: { ...structuredClone(DEFAULT_SETTINGS), ...settings } };
}

// ------------------------------------------------------------ helpers
// A plate fits a printer when its file was sliced for that model (or someone said "any <model>"). A plate with no model info fits
// anything. Kept strict on purpose: a file sliced for one model is not sent to another, even a bigger one; re-slice it instead.
export function fits(plate, printer) {
  const want = modelKey(plate.anyModel || plate.file?.model || "");
  if (!want) return true;
  return want === modelKey(printer.model);
}

// ------------------------------------------------------------ printer state
export function printerState(p, live, plates) {
  const onIt = plates.filter((x) => x.printer === p.key);
  const printing = onIt.find((x) => x.status === "printing");
  const finished = onIt.find((x) => x.status === "finished");
  const failed = onIt.find((x) => x.status === "failed");
  if (!p.active) return "off";
  if (failed) return "failed";
  if (finished) return "finished";
  const st = live?.state || "";
  // WARNING vs STOP: only a code the printer actually stopped for is an error state. A printer that kept printing through a code,
  // or still lists it after the print finished, carries a notice, not an error. One printer once showed the same harmless code for
  // 31 hours while it printed a long job to the end; treating it as an error would have stopped the farm for nothing.
  const errs = live?.errors || [];
  const running = st === "RUNNING" || st === "PREPARE";
  if (live?.connected && !running && errs.some((e) => e.kind === "stop")) return "error";
  if (live?.connected && (st === "PAUSE" || st === "PAUSED")) return "paused";
  if (printing) return "printing";          // a plate started by hand counts even with no live feed
  if (!live) return "unbound";
  if (!live.connected && (p.asleep || p.waking)) return p.waking ? "waking" : "asleep";   // smart plug off to save power: not lost, not broken
  if (!live.connected) return "offline";
  if (st === "RUNNING" || st === "PREPARE" || st === "SLICING") return "busy";   // printing something that is not from the queue
  if (live.plate?.clear === false) return "plate-on-bed";                          // a bed sensor can see the last print
  if (live.plate?.clear === true && !live.plate.suspect) return "idle";            // a suspected "not clear" is not idle yet
  if (st === "FINISH" && live.job) return "cleared?";                              // the bed may still hold the last print
  return "idle";
}

// ------------------------------------------------------------ lanes + ETA
// The power stagger: no two starts within settings.startGapMinutes (default 5) of each other, in queue order. Every printer heats
// its bed at the start of a print, the biggest power draw of the whole job; ten printers starting in the same minute is how a
// circuit trips. `lastStartAt` (opts) is when the last real start happened.
export function startGapMs(settings) { const m = Number(settings?.startGapMinutes); return (Number.isFinite(m) ? Math.max(0, Math.min(60, m)) : 5) * MS; }

// Each printer's lane (now -> next -> then), derived from the ordered queue. A pinned plate goes to its printer; an unpinned one to
// the fitting printer that becomes free first, weighed against colours (below). Writes `plate._eta` on every waiting plate.
// Returns { lanes: { key: { printer, state, now, items, freeAt, usable } }, plan } (plan = the colour day plan used).
export function computeLanes(state, live = {}, { t = Date.now(), lastStartAt = 0, nameOf = () => null } = {}) {
  const t0 = t;
  const settings = state.settings || {};
  const tz = tzOf(settings), staffed = staffedOf(settings);
  const gap = startGapMs(settings);
  const starts = [];                                     // every start already on the plan (or just happened)
  if (lastStartAt && t0 - lastStartAt < gap) starts.push(lastStartAt);
  const stagger = (s) => {
    if (gap <= 0) return s;
    let moved = true;
    while (moved) { moved = false; for (const x of starts) if (Math.abs(s - x) < gap) { s = x + gap; moved = true; } }
    starts.push(s);
    return s;
  };
  const plates = Object.values(state.plates);
  const printers = Object.values(state.printers).filter((p) => p.active);
  const lane = {};
  for (const p of printers) {
    const st = printerState(p, live[p.key], plates);
    const printing = plates.find((x) => x.printer === p.key && x.status === "printing");
    const l = live[p.key];
    let freeAt;
    if (printing) { freeAt = t0 + Math.max(1, Number(l?.remainingMin || printing.minutes || 60)) * MS; const sa = Date.parse(printing.startedAt || 0); if (sa && t0 - sa < gap) starts.push(sa); }
    else if (st === "busy") freeAt = t0 + Math.max(1, Number(l?.remainingMin || 60)) * MS;
    else freeAt = t0;   // idle, finished, failed, offline, unbound: can start once someone is there
    lane[p.key] = { printer: p, state: st, now: printing || null, items: [], freeAt, usable: st !== "off" && !p.maintenance };   // out of service = no new plates placed here
  }
  for (const p of plates) if (p.status !== "waiting") delete p._eta;   // no stale placements on plates that moved on
  const order = state.order.filter((pid) => state.plates[pid] && state.plates[pid].status === "waiting");
  // the colour day plan: which colour set each printer runs, so spools are swapped once, not per plate
  const plan = dayPlan(state, live, { fits, nameOf });
  const setPrinter = {};   // set id -> printer key: a toy's plates stay on one printer (its loaded colours)
  for (const p of plates) if (p.set && p.printer && p.status === "done") setPrinter[p.set.id] ??= p.printer;   // a set stays on the printer its first plate ran on, even after that plate is off
  for (const p of plates) if (p.set && p.printer && ["printing", "finished", "failed"].includes(p.status)) setPrinter[p.set.id] = p.printer;
  for (const pid of order) {
    const plate = state.plates[pid];
    let target = null;
    const stuck = plate.set && setPrinter[plate.set.id];
    if (plate.printer && lane[plate.printer] && lane[plate.printer].usable) target = lane[plate.printer];   // pinned to a printer that is out of service / off: placed like any other plate (it moves)
    else if (stuck && lane[stuck]?.usable) target = lane[stuck];   // the rest of a set follows its printer - unless that printer went out of service; then it moves (it used to wait there for good)
    else {
      // a printer kept out of Fill (fillOff) or stopped gets no plate without a printer of its own
      let cands = Object.values(lane).filter((L) => L.usable && !L.printer.fillOff && !L.printer.stopped && fits(plate, L.printer));
      // an automatic retry avoids the printer it just failed on (when there is any other choice)
      if (plate.avoid?.length) { const other = cands.filter((L) => !plate.avoid.includes(L.printer.key)); if (other.length) cands = other; }
      // Connected printers first (an offline one cannot print anything; an asleep one is a minute from booting, not offline), then
      // colour affinity weighed against waiting: every step short of "all colours loaded" costs two hours of queue time, so a free
      // printer with some of the colours beats a perfect one that is busy all day (a printer once sat empty while the others
      // stacked up behind their perfect colours). The day plan's printer for this plate pays no colour cost (its spools are on
      // today's loading list); any other printer pays for each colour it lacks, plus an hour for breaking the plan.
      const online = (L) => (live[L.printer.key]?.connected || L.printer.asleep || L.printer.waking ? 1 : 0);
      const eff = (L) => L.freeAt + (plan.printerOf[pid] === L.printer.key ? 0 : (3 - filamentScore(plate, live[L.printer.key])) * 2 * 60 * MS + (plan.printerOf[pid] ? 60 * MS : 0));
      cands.sort((a, b) => online(b) - online(a) || eff(a) - eff(b) || a.freeAt - b.freeAt || a.printer.key.localeCompare(b.printer.key));
      target = cands[0] || null;
    }
    if (!target) { plate._eta = null; continue; }
    if (plate.set) setPrinter[plate.set.id] = target.printer.key;
    // Staffed windows only push starts that happen UNATTENDED (a printer finishing later, with nobody there to swap the plate).
    // The first plate on a printer that is free right now starts now: someone just queued it and is standing there.
    const freeNow = target.items.length === 0 && target.freeAt <= t0 + MS;
    const start = stagger(target.printer.autoStart || freeNow ? Math.max(target.freeAt, t0) : nextStaffed(Math.max(target.freeAt, t0), staffed, tz));
    const end = start + Math.max(5, Number(plate.minutes || 60)) * MS;
    target.items.push(plate);
    plate._eta = { printer: target.printer.key, printerName: target.printer.name, auto: !plate.printer, set: !!stuck, start, end, position: target.items.length, filament: filamentCheck(plate, live[target.printer.key]), offline: !live[target.printer.key]?.connected };
    target.freeAt = end + (settings.swapMinutes ?? 15) * MS;
  }
  return { lanes: lane, plan };
}
export function lanes(state, live = {}, opts = {}) { return computeLanes(state, live, opts).lanes; }

// The loading list: what to load where. One list per printer from the day plan (every spool to load today, in one go), then a row
// per colour for any plate the plan could not cover (more colours than the AMS holds, or a printer the plan does not know). Never a
// gate on its own: engine.start() still refuses a start whose material is missing. `nameOf(type, hex)` may name a colour.
export function colourNeeds(state, live = {}, { nameOf = () => null, perPrinter = 2, t = Date.now(), lastStartAt = 0 } = {}) {
  const { lanes: L, plan } = computeLanes(state, live, { t, lastStartAt, nameOf });
  const out = [];
  for (const pr of plan.printers) {
    if (!pr.loads.length) continue;
    const lines = pr.loads.map((l, i) => `${i + 1}. ${l.name}${l.color ? ` (${l.color})` : ""} -> AMS ${Number(l.ams) + 1} slot ${Number(l.slot) + 1}${l.empty ? " (empty)" : ` (swap out ${l.replaces})`} · ${l.plates} plate${l.plates === 1 ? "" : "s"}, ~${l.grams} g`);
    const keep = pr.keep.length ? ` Keep: ${pr.keep.map((k) => k.name).join(", ")}.` : "";
    out.push({ printer: pr.key, printerName: pr.name, number: pr.number, id: "load-plan", plan: true, name: `Set up ${pr.name}: ${pr.loads.length} spool${pr.loads.length === 1 ? "" : "s"}`, minutes: 3 * pr.loads.length,
      colour: pr.loads[0].color, type: pr.loads[0].type, plate: pr.loads[0].firstPlate?.id || null, plateTitle: pr.loads[0].firstPlate?.title || null,
      loads: pr.loads.map((l) => ({ name: l.name, color: l.color, type: l.type, ams: l.ams, slot: l.slot, empty: !!l.empty, replaces: l.replaces || null, plates: l.plates, grams: l.grams })), keep: pr.keep.map((k) => ({ name: k.name, color: k.color, ams: k.ams, slot: k.slot })),
      how: `${pr.plates} plate${pr.plates === 1 ? "" : "s"} (~${Math.round(pr.minutes / 60)} h) are planned on ${pr.name} in ${pr.keep.length + pr.loads.length} colours.${keep} Load: ${lines.join(" ")} Then set the material and colour on the printer screen for any spool without a tag. ${pr.swaps ? `${pr.swaps} swap${pr.swaps === 1 ? "" : "s"} now instead of one per plate through the day` : "No swaps, only empty slots"}.` });
  }
  for (const lane of Object.values(L)) {
    const pr = lane.printer; const l = live[pr.key];
    if (!l?.connected || !l?.trays?.length) continue;
    let n = 0;
    for (const plate of lane.items) {
      if (n >= perPrinter) break;
      const c = plate._eta?.filament;
      if (!c?.known) continue;
      if (plate.colours === "loaded") continue;   // this job goes ahead in whatever is loaded
      if (plan.printerOf[plate.id] === pr.key && plan.printers.some((x) => x.key === pr.key && x.loads.length)) continue;   // covered by this printer's list above
      const wants = [];
      const asg = trayAssign(plate.filaments || [], l.trays);
      for (const [i, need] of (plate.filaments || []).entries()) {
        const tr = asg.byNeed[i]; const d = tr && need.color && tr.color ? colorDist(need.color, tr.color) : 60;
        if (!tr) wants.push({ type: need.type || "PLA", color: need.color || null, why: "no slot of its own" });
        else if (d > COLOUR_OFF) wants.push({ type: need.type || "PLA", color: need.color || null, why: `only ${tr.name || tr.color || "another colour"} loaded` });
      }
      if (!wants.length) continue;
      n++;
      // a slot for EACH colour: three missing colours were once all told "AMS 1 slot 3". Empty slots first, then the spools this
      // plate does not use, least left first - never the same slot twice
      const slots = Number(l.amsSlots || 0);
      const used = new Set((l.trays || []).map((x) => `${x.ams}/${x.slot}`));
      const needed = new Set(asg.byNeed.filter(Boolean).map((x) => `${x.ams}/${x.slot}`));
      const free = [];
      for (let g = 0; g < slots; g++) { const k = `${Math.floor(g / 4)}/${g % 4}`; if (!used.has(k)) free.push({ ams: Math.floor(g / 4), slot: g % 4, empty: true }); }
      for (const spare of (l.trays || []).filter((x) => x.ams !== "ext" && !needed.has(`${x.ams}/${x.slot}`)).sort((a, b) => (a.remain ?? 100) - (b.remain ?? 100))) free.push({ ams: spare.ams, slot: spare.slot, empty: false, now: spare.name || spare.color || spare.type });
      const custom = plate.source?.type !== "stock";   // a stock plate's colours are the plan's; only a custom job may go ahead in what is loaded
      for (const w of wants) {
        const slot = free.shift() || null;
        const name = nameOf(w.type, w.color) || w.color || w.type;
        const where = slot ? `AMS ${Number(slot.ams) + 1} slot ${Number(slot.slot) + 1}${slot.empty ? " (empty)" : ` (swap out ${slot.now || "the spool in it"})`}` : "any free slot";
        out.push({ printer: pr.key, printerName: pr.name, number: pr.number ?? null, id: `load-${String(w.color || w.type).replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`, name: `Load ${w.type} ${name}`, minutes: 3,
          colour: w.color, type: w.type, plate: plate.id, plateTitle: plate.title, slot, custom,
          how: `${plate.title} needs ${name}${w.color ? ` (${w.color})` : ""} - ${w.why}. Put it in ${where}, then set ${w.type} and the colour on the printer screen if it has no tag.${custom ? " It may also go ahead in the colours that are loaded." : " The plan chose this colour - it is not picked here."}` });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ views
// Who stopped this print, if someone did. A print someone stopped on purpose is not a failure: the plate still ends on the bed and
// has to come off before the next start, but it is not the machine's or the file's fault.
export const handStop = (p) => p?.stoppedByHand || (/\bstopped (from the app|with the kill switch|at the printer|on purpose)\b/i.test(p?.note || "") || /went idle mid-print/i.test(p?.note || "") ? "someone" : null);
// Per-toy quality memory: a plate is "bad" when it failed or was graded 1-2 stars. Two bad in a row for the same file, on any
// printers, and the file needs a look (`clearedAt` restarts the count once someone fixed it). A hand stop is never held against it.
export const isBad = (p) => !!(p.outcome?.stars != null && p.outcome.stars <= 2) || (!handStop(p) && !!(p.outcome?.wasFailed || p.status === "failed"));
export function fileQuality(state, fileId, { clearedAt = null } = {}) {
  const runs = Object.values(state.plates || {})
    .filter((x) => x.file?.id === fileId && ["done", "failed"].includes(x.status) && x.closedAt && (!clearedAt || Date.parse(x.closedAt) > Date.parse(clearedAt)))
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const last = runs.slice(0, 2);
  const badStreak = last.length >= 2 && last.every(isBad) ? last : null;
  const graded = runs.filter((x) => x.outcome?.stars != null);
  const avg = graded.length ? Math.round((graded.reduce((a, x) => a + x.outcome.stars, 0) / graded.length) * 10) / 10 : null;
  return { runs: runs.length, bad: runs.filter(isBad).length, avgStars: avg, badStreak, last: last.map((x) => ({ id: x.id, title: x.title, printer: x.printer, at: x.closedAt, stars: x.outcome?.stars ?? null, failed: !!(x.outcome?.wasFailed || x.status === "failed"), note: x.outcome?.note || x.note || "" })) };
}
export function plateView(p, { publicView = false, printers = null } = {}) {
  const v = {
    id: p.id, title: p.title, sku: p.sku || null, status: p.status,
    file: p.file ? { id: p.file.id, name: p.file.name, model: p.file.model || null } : null,
    printer: p.printer || null, printerName: p.printer ? printers?.[p.printer]?.name || p.printer : null, anyModel: p.anyModel || null, batch: p.batch || null,
    plate: p.plate || null, set: p.set || null, filaments: p.filaments || null, amsMapping: p.amsMapping || null,
    minutes: p.minutes || null, grams: p.grams || null, units: p.units || null,
    createdAt: p.createdAt, startedAt: p.startedAt || null, finishedAt: p.finishedAt || null, closedAt: p.closedAt || null,
    outcome: p.outcome || null, note: p.note || "", holdNote: p.holdNote || "", manual: !!p.manual, colours: p.colours || defaultColours(p.source),
    stoppedByHand: handStop(p), at: p.at || null, locked: !!p.locked,
    eta: p._eta ? { ...p._eta } : null, progress: p.progress || null,
  };
  // the public view never carries customer names or order numbers
  v.source = publicView ? { type: p.source?.type || "custom" } : { type: p.source?.type || "custom", ref: p.source?.ref || null, customer: p.source?.customer || null, note: p.source?.note || null, retryOf: p.source?.retryOf || null, auto: !!p.source?.auto };
  if (!publicView && p.avoid?.length) v.avoid = p.avoid;
  return v;
}

// Why is this printer not printing the plate planned for it? One sentence, shown on its card.
function idleWhyOf(p, st, l, first, needs, settings, tz) {
  if (p.stopped) return `STOPPED${p.stopped.by ? ` by ${p.stopped.by}` : ""}${p.stopped.at ? ` ${clock(Date.parse(p.stopped.at), tz)}` : ""} - release it to start again`;
  if (p.maintenance) return `OUT OF SERVICE${p.maintenance.why ? ` - ${p.maintenance.why}` : ""} - put it back in service to start again`;
  if (st === "unbound") return "not connected to a printer driver yet";
  if (st === "asleep") return p.plateOn === true ? "asleep to save power - waking it for this plate" : "asleep to save power - it wakes when someone confirms a build plate";
  if (st === "waking") return "waking up - about a minute, then it starts";
  if (st === "offline") return "can't reach the printer";
  if (st === "error") return "printer error - fix it first";
  if (st === "failed") return handStop(needs) ? "the stopped print is still on the bed - take it off" : "the failed print is still on the bed - take it off";
  if (st === "finished") return "take the last plate off first";
  if (st === "plate-on-bed") return "the bed sensor sees a print on the bed";
  if (st === "cleared?") return "the bed may not be clear - confirm it";
  if (!p.driverId) return "no printer driver - start it by hand";
  if (l?.storage === false) return "no storage in the printer - files cannot be sent to it";
  if (first._eta?.filament?.ok === false) return first._eta.filament.why || (first._eta.filament.amsEmpty ? "the AMS is empty - load a spool" : `needs ${first._eta.filament.missing.join(", ")} loaded`);
  if (first._eta?.filament?.low) return "spool is nearly empty - swap it";
  if ((l?.amsSlots || 0) > 0 && !(l?.trays || []).some((x) => x.type && !x.unknown)) return (l.trays || []).length ? "the loaded spools have no type set - set the material and colour on the printer" : "the AMS is empty - load a spool";
  if (!p.autoStart) return "auto-start is off - start it by hand";
  if (settings?.colourStrict !== false && first.colours !== "loaded" && first._eta?.filament?.colorOff?.length) return `waiting for a colour: ${first._eta.filament.colorOff.map((c) => c.wanted).filter(Boolean).slice(0, 3).join(", ")} - load it, or let this job print in what is loaded`;
  if (st === "idle") return "starting shortly";
  return null;
}

// Everything a screen needs: each printer's state, now / next / then, ONE "needs you" list (every item carries the same words the
// card shows, and `urgent` = hands needed now), counts and the day plan.
export function board(state, live = {}, { t = Date.now(), lastStartAt = 0, nameOf = () => null, publicView = false } = {}) {
  const { lanes: L, plan } = computeLanes(state, live, { t, lastStartAt, nameOf });
  const settings = state.settings || {}; const tz = tzOf(settings);
  const extras = { publicView, printers: state.printers };
  const plates = Object.values(state.plates);
  const printers = Object.values(state.printers).sort((a, b) => (a.number ?? 99) - (b.number ?? 99) || String(a.name).localeCompare(String(b.name))).map((p) => {
    const l = live[p.key] || null, lane = L[p.key];
    const st = lane ? lane.state : printerState(p, l, plates);
    const needs = plates.find((x) => x.printer === p.key && (x.status === "finished" || x.status === "failed")) || null;
    const nowPlate = lane?.now || null;
    const first = lane?.items[0];
    const idleWhy = first && !nowPlate ? idleWhyOf(p, st, l, first, needs, settings, tz) : null;
    return {
      key: p.key, number: p.number ?? null, name: p.name, model: p.model, active: !!p.active, autoStart: !!p.autoStart, fillOff: !!p.fillOff, state: st, idleWhy,
      stoppedByHand: handStop(needs),
      stopped: p.stopped ? { at: p.stopped.at || null, by: p.stopped.by || null, why: p.stopped.why || "" } : null,
      maintenance: p.maintenance ? { why: p.maintenance.why || "", backAt: p.maintenance.backAt || null } : !p.active ? { why: "switched off" } : null,
      plateOn: p.plateOn === true,
      live: l ? { connected: l.connected, state: l.state, progress: l.progress, remainingMin: l.remainingMin, job: l.job, trays: l.trays || [], amsSlots: l.amsSlots || 0 } : null,
      now: nowPlate ? plateView(nowPlate, extras) : null,
      needs: needs ? { kind: needs.status, plate: plateView(needs, extras) } : null,
      next: first ? plateView(first, extras) : null,
      then: (lane?.items || []).slice(1, 4).map((x) => plateView(x, extras)),
      laneCount: lane?.items.length || 0,
      freeAt: lane ? new Date(lane.freeAt).toISOString() : null,
    };
  });
  // the timetable: per printer, the running print then every planned plate with its window
  const lanesOut = printers.map((p) => {
    const lane = L[p.key]; const blocks = [];
    if (lane?.now) { const l = live[p.key]; blocks.push({ id: lane.now.id, title: lane.now.title, kind: "now", start: Date.parse(lane.now.startedAt || 0) || t - 60 * MS, end: t + Math.max(1, Number(l?.remainingMin || lane.now.minutes || 60)) * MS, progress: l?.progress ?? lane.now.progress ?? 0 }); }
    else if (lane?.state === "busy") { const l = live[p.key]; blocks.push({ id: null, title: l?.job || "a print", kind: "busy", start: t - 60 * MS, end: t + Math.max(1, Number(l?.remainingMin || 60)) * MS, progress: l?.progress ?? 0 }); }
    for (const it of lane?.items || []) blocks.push({ id: it.id, title: it.title, kind: "planned", start: it._eta.start, end: it._eta.end, auto: it._eta.auto, set: it.set || null, filamentOk: it._eta.filament?.ok ?? null });
    return { printer: p.key, number: p.number, name: p.name, state: lane?.state || "off", blocks };
  });
  const today = labDate(t, tz);
  const doneToday = plates.filter((p) => p.status === "done" && p.closedAt && labDate(Date.parse(p.closedAt), tz) === today);
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const stats = {
    today: { plates: doneToday.length, good: sum(doneToday, (x) => x.outcome?.good), oops: sum(doneToday, (x) => x.outcome?.oops), hours: Math.round(sum(doneToday, (x) => x.minutes) / 6) / 10 },
    queueHours: Math.round(sum(state.order.map((pid) => state.plates[pid]).filter((p) => p && p.status === "waiting"), (x) => x.minutes) / 6) / 10,
    finishAll: lanesOut.reduce((m, l) => Math.max(m, ...l.blocks.map((b) => b.end)), 0) || null,
  };
  const queue = state.order.map((pid) => state.plates[pid]).filter((p) => p && QUEUE_STATUSES.has(p.status)).map((p) => plateView(p, extras));
  const needs = [
    ...printers.filter((p) => p.state === "error" && !p.maintenance).map((p) => { const e = (p.live?.errors || []).find((x) => x.kind === "stop") || null; return { printer: p.key, printerName: p.name, kind: "error", urgent: true, text: `${e?.text || "printer error"} - fix it at the printer`, plate: p.now || null }; }),
    // a printer off line for maintenance is being worked on: its finished / failed plate is part of that job, not a "needs you"
    ...printers.filter((p) => p.needs && !p.maintenance && p.active).map((p) => ({ printer: p.key, printerName: p.name, kind: p.needs.kind, byHand: p.needs.plate.stoppedByHand || null, urgent: true, text: p.needs.kind === "failed" ? `${p.needs.plate.title} ${p.needs.plate.stoppedByHand ? "was stopped by hand" : "stopped"} - clear the bed` : `${p.needs.plate.title} finished - take the plate off and count`, plate: p.needs.plate })),
    ...printers.filter((p) => p.idleWhy && !p.now && !p.needs && p.state !== "error" && p.state !== "unbound" && !/^(starting shortly|auto-start is off|no printer driver)/.test(p.idleWhy)).map((p) => ({ printer: p.key, printerName: p.name, kind: p.state === "plate-on-bed" || p.state === "cleared?" ? "bed" : p.maintenance ? "maintenance" : p.stopped ? "stopped" : p.state === "offline" ? "offline" : "idle", urgent: !(p.maintenance || p.stopped || p.state === "offline"), text: p.idleWhy, plate: p.next || null })),
  ];
  return {
    at: iso(t), printers, queue, needs, lanes: lanesOut, stats,
    amsPlan: publicView ? undefined : plan.printers,
    counts: { printing: printers.filter((p) => p.state === "printing" || p.state === "busy").length, online: printers.filter((p) => p.active && p.live?.connected).length, waiting: queue.filter((q) => q.status === "waiting").length, needsFile: queue.filter((q) => q.status === "needs-file").length, hold: queue.filter((q) => q.status === "hold").length, needsYou: needs.filter((n) => n.urgent !== false).length },
  };
}
// a board safe for a screen anyone can see: no customers, no order numbers, no settings, the first dozen queued plates
export function publicBoard(state, live = {}, opts = {}) {
  const b = board(state, live, { ...opts, publicView: true });
  return { at: b.at, printers: b.printers, queue: b.queue.slice(0, 12), needs: b.needs, counts: b.counts };
}

// ------------------------------------------------------------ mutations
// The two filament choices per job:
//   "match"  = RECOMMENDED: the file's own colours. The scheduler proposes a slot per colour, an operator may change any slot, and
//              the job waits (and asks for the spool) when a colour is not loaded.
//   "loaded" = AUTOMATIC: map whatever is loaded, closest colour per slot, never wait for a colour.
// Default by job: stock toys Automatic (their colour changes are planned on the lines, not asked for per job), everything someone
// or a customer asked for Recommended. Either can be switched per job.
export const defaultColours = (source) => (source?.type === "stock" ? "loaded" : "match");

// `plate` = { index, of, name } for one plate of a multi-plate file; `set` = { id, n, of } groups the plates of one toy so they stay
// on one printer (its loaded colours). `filaments` = [{ type, color, grams?, slot? }] the plate needs. `newId` makes ids (tests and
// simulations pass a counter); `t` is the creation time.
export function addPlates(state, { file, sku, title, count = 1, printer = null, anyModel = null, source = { type: "custom" }, material = null, color = null, minutes = null, grams = null, units = null, top = false, note = "", plate = null, set = null, filaments = null, colours = null, t = Date.now(), newId = newPlateId }) {
  count = Math.max(1, Math.min(50, Number(count) || 1));
  const made = [];
  const batchId = count > 1 ? newId("B") : null;
  for (let i = 1; i <= count; i++) {
    const p = {
      id: newId("P"), title: title || file?.name?.replace(/\.gcode\.3mf$/i, "") || sku || "Plate", sku: sku || file?.sku || null,
      file: file ? { id: file.id, name: file.name, model: file.model || null } : null,
      plate: plate ? { index: plate.index, of: plate.of, name: plate.name || null } : null,
      set: set ? { id: set.id, n: set.n, of: set.of } : null,
      filaments: Array.isArray(filaments) && filaments.length ? filaments.map((f) => ({ type: String(f.type || "").toUpperCase(), color: f.color || null, ...(f.grams != null ? { grams: Number(f.grams) } : {}), ...(f.slot != null ? { slot: Number(f.slot) } : {}) })) : (file?.filaments || null),
      // how many filament slots the 3MF project defines - the AMS mapping is indexed by them (ams.expandMapping)
      projectSlots: Math.max(0, ...((file?.filaments || []).map((f) => Number(f.slot) || 0)), ...((Array.isArray(filaments) ? filaments : []).map((f) => Number(f.slot) || 0))) || null,
      printer: printer || null, pinnedPrinter: printer || null, anyModel: printer ? null : anyModel || file?.model || null,
      batch: batchId ? { id: batchId, n: i, of: count } : null,
      source, material, color, minutes: minutes ?? file?.minutes ?? null, grams: grams ?? file?.grams ?? null, units,
      status: file ? "waiting" : "needs-file", createdAt: iso(t), note,
      colours: colours === "match" || colours === "loaded" ? colours : defaultColours(source),
    };
    state.plates[p.id] = p;
    made.push(p);
  }
  const ids = made.map((p) => p.id);
  state.order = top ? [...ids, ...state.order] : [...state.order, ...ids];
  return made;
}

// Custom jobs (dropped files, orders, anything someone put in by hand) stay ahead of the automatic stock plates: "the next
// available place", not the back of a three-day queue.
export function prioritizeCustom(state) {
  const isWaiting = (pid) => state.plates[pid] && state.plates[pid].status === "waiting";
  const custom = state.order.filter((pid) => isWaiting(pid) && state.plates[pid].source?.type !== "stock");
  const stock = state.order.filter((pid) => isWaiting(pid) && state.plates[pid].source?.type === "stock");
  const rest = state.order.filter((pid) => !isWaiting(pid));
  state.order = [...custom, ...stock, ...rest];
}
export function reorder(state, ids) {
  const want = [...new Set(ids)].filter((x) => state.plates[x] && QUEUE_STATUSES.has(state.plates[x].status));   // duplicates would plan a plate twice
  const rest = state.order.filter((x) => !want.includes(x));
  state.order = [...want, ...rest];
}
export function moveTo(state, pid, index) {
  const cur = state.order.filter((x) => state.plates[x] && QUEUE_STATUSES.has(state.plates[x].status));
  const i = cur.indexOf(pid); if (i < 0) return;
  cur.splice(i, 1); cur.splice(Math.max(0, Math.min(cur.length, index)), 0, pid);
  reorder(state, cur);
}

export function setPlate(state, pid, patch) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (("printer" in patch || "anyModel" in patch || patch.file) && !QUEUE_STATUSES.has(p.status)) throw err(409, `plate is ${p.status} - it cannot be moved or re-filed now`);
  if ("printer" in patch && patch.printer && state.printers[patch.printer] && p.file && !fits({ file: p.file, anyModel: null }, state.printers[patch.printer])) throw err(409, `${state.printers[patch.printer].name} is not a ${p.file.model || "matching"} printer`);
  if ("printer" in patch) p.pinnedPrinter = patch.printer || null;
  if (patch.title != null) p.title = String(patch.title).slice(0, 80);
  if ("printer" in patch) { p.printer = patch.printer || null; if (p.printer) p.anyModel = null; }
  if ("anyModel" in patch) { p.anyModel = patch.anyModel || null; if (p.anyModel) p.printer = null; }
  if (patch.note != null) p.note = String(patch.note).slice(0, 300);
  if (patch.colours != null) p.colours = patch.colours === "loaded" ? "loaded" : "match";
  if (patch.minutes != null) p.minutes = Math.max(1, Number(patch.minutes) || p.minutes);
  if ("at" in patch) p.at = patch.at || null;            // a pinned start (lines.mjs)
  if ("locked" in patch) p.locked = !!patch.locked;      // someone placed it: Fill never moves it
  // a saved colour choice (AMS slot per filament), used by automatic starts too; null = automatic
  if ("amsMapping" in patch) p.amsMapping = Array.isArray(patch.amsMapping) && patch.amsMapping.length ? patch.amsMapping.map(Number) : null;
  if (patch.file) { p.file = { id: patch.file.id, name: patch.file.name, model: patch.file.model || null }; if (p.status === "needs-file") p.status = "waiting"; if (patch.file.minutes) p.minutes = patch.file.minutes; if (patch.file.grams) p.grams = patch.file.grams; }
  return p;
}

export function hold(state, pid, note = "") {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (!["waiting", "needs-file"].includes(p.status)) throw err(409, `can't hold a plate that is ${p.status}`);
  p.status = "hold"; p.holdNote = note; p.heldFrom = p.file ? "waiting" : "needs-file";
  return p;
}
export function unhold(state, pid) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (p.status !== "hold") throw err(409, "not on hold");
  p.status = p.file ? "waiting" : "needs-file"; p.holdNote = "";
  return p;
}
export function cancel(state, pid, note = "", { t = Date.now() } = {}) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (!QUEUE_STATUSES.has(p.status)) throw err(409, `can't cancel a plate that is ${p.status} - stop it first`);
  p.status = "cancelled"; p.closedAt = iso(t); p.note = note || p.note;
  state.order = state.order.filter((x) => x !== pid);
  return p;
}

// Start = an operator (or the automatic starter) sends the plate to the printer. `send` is async
// (fileId, driverId, plateIndex, amsMapping, useAms) -> { itemId }; null = a manual start (someone starts it at the printer and we
// only track it).
export async function start(state, live, pid, printerKey, send, { amsMapping = null, bedClear = false, plateConfirmed = false, t = Date.now() } = {}) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (p.status !== "waiting") throw err(409, p.status === "needs-file" ? "this plate has no sliced file yet" : `plate is ${p.status}`);
  const pr = state.printers[printerKey]; if (!pr || !pr.active) throw err(400, "no such printer");
  if (pr.maintenance) throw err(409, `${pr.name} is out of service${pr.maintenance.why ? ` (${pr.maintenance.why})` : ""} - put it back in service first`);
  if (!fits(p, pr)) throw err(409, `${p.title} was sliced for ${p.anyModel || p.file?.model}, not the ${pr.model}`);
  const plates = Object.values(state.plates);
  const st = printerState(pr, live[printerKey], plates);
  if (["printing", "busy", "paused"].includes(st)) throw err(409, `${pr.name} is already printing`);
  if (st === "finished" || st === "failed") throw err(409, `${pr.name} still has a plate on it - take it off and count first`);
  if (st === "plate-on-bed") throw err(409, `${pr.name}'s bed sensor can still see the last print - clear it first`);
  if (st === "cleared?" && !bedClear) throw err(409, `${pr.name} finished a print and nobody has confirmed the bed is clear`);
  // Nothing starts - by hand, from a phone or by itself - until someone has confirmed a build plate is on this bed. A print was once
  // started on a bare heatbed. The printer's own check at the start of a job is only the backstop.
  if (pr.plateOn !== true && !plateConfirmed) throw err(409, `${pr.name}: nobody has confirmed a build plate is on the bed`);
  let manual = true;
  // colour choice: an explicit mapping for this start > the plate's saved choice > the automatic match
  const saved = Array.isArray(p.amsMapping) && p.amsMapping.length ? p.amsMapping : null;
  const mapping = Array.isArray(amsMapping) && amsMapping.length ? expandMapping(p, amsMapping.map(Number)) : saved ? expandMapping(p, saved) : autoMapping(p, live[printerKey]);
  let item = null;
  // Nothing the scheduler sends starts unless every colour the plate needs has its own loaded spool with a type set. A printer once
  // paused at 67 % on a mapping it could not build: one slot had no type. A colour that is off (the "go ahead with what's loaded"
  // choice) still counts as a spool; a start recorded by hand at the printer's own screen is the printer's business.
  if (send) {
    const needs = p.filaments || []; const l = live[printerKey];
    if (needs.length) {
      const fc = filamentCheck(p, l);
      const logged = (l?.trays || []).filter((x) => !x.off && !x.unknown && x.type);
      const colours = new Set(needs.map((n) => `${fam(n.type)}|${String(n.color || "").toLowerCase()}`)).size;
      if (fc?.known && !fc.ok) throw err(409, `${pr.name}: ${colours} colour${colours === 1 ? "" : "s"} needed, ${logged.length} roll${logged.length === 1 ? "" : "s"} logged in the AMS${fc.missing?.length ? ` - missing ${fc.missing.join(", ")}` : ""}. Load each colour in its own slot and set its type on the printer screen`);
      if (Array.isArray(mapping) && mapping.length) {
        const bad = mapping.map((m, i) => ({ m: Number(m), need: needs[i] })).filter(({ m }) => m >= 0 && m !== 254 && !logged.some((x) => Number(x.ams) * 4 + Number(x.slot) === m));
        if (bad.length) throw err(409, `${pr.name}: ${bad.map(({ m, need }) => `AMS ${Math.floor(m / 4) + 1} slot ${(m % 4) + 1} (${need?.color || need?.type || "?"})`).join(", ")} ${bad.length === 1 ? "has" : "have"} no roll logged - load it and set its type on the printer screen first`);
      }
    }
  }
  // only ask the printer to use the AMS when it holds an identified spool; an unidentified one fails the mapping on the printer
  const useAms = (live[printerKey]?.trays || []).some((x) => !x.unknown && x.type);
  if (send && pr.driverId != null && p.file?.id != null) { const r = await send(p.file.id, pr.driverId, p.plate?.index || null, mapping, useAms); item = r?.itemId ?? null; manual = false; }
  p.status = "printing"; p.printer = printerKey; p.anyModel = null; p.startedAt = iso(t); p.manual = manual; p.progress = 0; p.amsMapping = mapping;
  p.driverItem = item; p.dispatched = manual;   // a hand start needs no confirmation; a driver send is confirmed when the printer takes the file
  state.order = state.order.filter((x) => x !== pid);
  return p;
}

// Someone started this plate from the printer's own screen: attach the waiting plate to the print that is running, so it is
// tracked and not printed twice.
export function adopt(state, pid, printerKey, { t = Date.now() } = {}) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (p.status !== "waiting") throw err(409, `plate is ${p.status}`);
  const pr = state.printers[printerKey]; if (!pr) throw err(404, "no such printer");
  if (Object.values(state.plates).some((x) => x.printer === printerKey && x.status === "printing")) throw err(409, `${pr.name} already has a plate tracked on it`);
  p.status = "printing"; p.printer = printerKey; p.anyModel = null; p.startedAt = iso(t); p.manual = true; p.dispatched = true; p.progress = 0;
  p.note = [p.note, "adopted: started from the printer"].filter(Boolean).join(" · ").slice(0, 300);
  state.order = state.order.filter((x) => x !== pid);
  return p;
}

// The printer never actually started it (upload refused, wrong file, Start pressed twice): back to the top of the queue, nothing counted.
export function unstart(state, pid, note = "") {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (!["printing", "finished", "failed"].includes(p.status)) throw err(409, `plate is ${p.status}`);
  p.status = "waiting"; p.printer = p.pinnedPrinter || null; p.anyModel = p.anyModel || p.file?.model || null;
  delete p.startedAt; delete p.finishedAt; delete p.manual; delete p.progress; delete p.driverItem; delete p.dispatched;   // amsMapping is the saved colour choice - keep it
  p.note = [p.note, note].filter(Boolean).join(" · ").slice(0, 300);
  state.order = [pid, ...state.order.filter((x) => x !== pid)];
  return p;
}

// Plate off the bed and counted: closes the plate. `stars` is an optional quality grade, 1-5.
export const stars = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : null; };
export function off(state, pid, { good = 0, oops = 0, note = "", stars: st = null, t = Date.now() } = {}) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (!["finished", "failed", "printing"].includes(p.status)) throw err(409, `plate is ${p.status}`);
  good = Math.max(0, Number(good) || 0); oops = Math.max(0, Number(oops) || 0);
  p.outcome = { good, oops, note: String(note || "").slice(0, 300), wasFailed: p.status === "failed", stars: stars(st) };
  p.status = "done"; p.closedAt = iso(t);
  if (!p.finishedAt) p.finishedAt = p.closedAt;
  return p;
}

// `byHand`: a print someone stopped on purpose is not a failure. It still ends the same way - on the bed, to come off before the
// next start - but it is not the machine's fault and does not count against the file's quality record.
export function markFinished(state, pid, ok = true, info = {}) {
  const p = state.plates[pid]; if (!p || p.status !== "printing") return null;
  p.status = ok ? "finished" : "failed"; p.finishedAt = info.finishedAt || iso(info.t ?? Date.now()); p.progress = ok ? 100 : p.progress;
  if (!ok && info.byHand) p.stoppedByHand = typeof info.byHand === "string" ? info.byHand : "someone";
  if (info.why) p.note = [p.note, info.why].filter(Boolean).join(" · ").slice(0, 300);
  return p;
}

// A failed or finished plate can be printed again: a fresh plate at the top, not pinned to the printer it failed on. It keeps its
// filaments and its plate index (plate 2 of a three-plate file is plate 2 again) but not its set, so it is free to move.
export function retry(state, pid, { t = Date.now(), newId } = {}) {
  const p = state.plates[pid]; if (!p) throw err(404, "no such plate");
  if (!["failed", "finished", "done", "cancelled"].includes(p.status)) throw err(409, `plate is ${p.status} - nothing to retry yet`);
  const [n] = addPlates(state, { file: p.file, sku: p.sku, title: p.title, count: 1, printer: null, anyModel: p.anyModel || p.file?.model || state.printers[p.printer]?.model || null, source: { ...(p.source || { type: "custom" }), retryOf: pid }, material: p.material, color: p.color, minutes: p.minutes, grams: p.grams, units: p.units, top: true, colours: p.colours || null, filaments: p.filaments, plate: p.plate, t, ...(newId ? { newId } : {}) });
  return n;
}
// An automatic second go after a failure: same file, front of the queue, on a different printer if there is one (the first failure
// may be the machine's fault). Once only: a plate that already is a retry is not retried again - that is a "check the design" call.
export function autoRetry(state, pid, { samePrinter = false, amsMapping = null, why = null, t = Date.now(), newId } = {}) {
  const p = state.plates[pid]; if (!p || p.status !== "failed") return null;
  if (!samePrinter && (p.source?.retryOf || p.source?.autoRetry === false)) return null;
  const n = retry(state, pid, { t, newId });
  if (samePrinter && p.printer) { n.printer = p.printer; n.pinnedPrinter = p.printer; n.anyModel = null; n.avoid = []; if (amsMapping) n.amsMapping = amsMapping; }
  else n.avoid = p.printer ? [p.printer] : [];
  n.source = { ...(n.source || {}), auto: true };
  n.note = why || `automatic retry - ${p.title} failed on ${state.printers[p.printer]?.name || p.printer || "a printer"}`;
  reorder(state, [n.id]);
  return n;
}

// Live tick: apply what the printers report to the plates that are printing. Returns [{ plate, event }] so the caller can tell
// someone. `verdicts` ({ plateId: { status: "completed"|"failed"|"cancelled"|"printing", completedAt } }) is what the printer driver
// recorded for the plate's job. It breaks the tie when the live state cannot tell the story on its own: after the scheduler was down
// a print may have finished AND been taken off, leaving the printer IDLE - that is a finished plate, not a failed one.
// opts.graceMs: after a start the printer still shows its previous job's end state for a while (default 3 minutes).
export const sameJob = (a, b) => { const n = (x) => String(x || "").replace(/\.gcode\.3mf$|\.3mf$/i, "").replace(/[\s_]+/g, " ").trim().toLowerCase(); const x = n(a), y = n(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };
const RESUME_WINDOW_MS = 6 * 3600_000;
export function applyLive(state, live = {}, verdicts = {}, { t = Date.now(), graceMs = 3 * MS } = {}) {
  const out = [];
  for (const p of Object.values(state.plates)) {
    // Called failed or finished, but the printer is printing THAT job again: it carried on after a link blip, or someone restarted
    // the same file at the printer. Within six hours, the same job name, no other plate tracked there: the plate is printing again.
    // (A plate was once marked failed during a lost link and was back at layer 18 three hours later while the board said "clear the bed".)
    if ((p.status === "failed" || p.status === "finished") && p.printer && p.finishedAt && t - Date.parse(p.finishedAt) < RESUME_WINDOW_MS) {
      const l = live[p.printer];
      const st = l?.connected ? String(l.state || "").toUpperCase() : "";
      const onSame = (st === "RUNNING" || st === "PREPARE" || st === "PAUSE" || st === "PAUSED") && sameJob(l.job, p.liveJob || p.file?.name || p.title);
      const other = Object.values(state.plates).some((x) => x !== p && x.printer === p.printer && x.status === "printing");
      if (onSame && !other && (st !== "RUNNING" || Number(l.progress || 0) > 0 || Number(l.layer || 0) > 0)) {
        const was = p.status;
        p.status = "printing"; delete p.finishedAt; p.progress = Number(l.progress || 0); p.remainingMin = l.remainingMin; p.seenRunning = true; p.manual = true; p.dispatched = true;
        p.note = [p.note, `the printer carried on (${was === "failed" ? "it is printing the same file again" : "it started the same file again"})`].filter(Boolean).join(" · ").slice(0, 300);
        out.push({ plate: p, event: "resumed", was });
      }
      continue;
    }
    if (p.status !== "printing" || !p.printer) continue;
    if (p.driverItem != null && !p.dispatched) continue;   // the printer has not taken the file yet; the caller's dispatch watcher owns it
    const v = verdicts[p.id] || null;
    const l = live[p.printer];
    const connected = !!l?.connected;
    if (!connected && !v) continue;
    const st = connected ? l.state : "";
    const age = t - Date.parse(p.startedAt || 0);
    if (st === "RUNNING" || st === "PREPARE") { p.progress = l.progress; p.remainingMin = l.remainingMin; if (l.job) p.liveJob = l.job; p.seenRunning = true; continue; }
    if (age < graceMs) continue;   // the printer may not have picked the file up yet
    // a hand start: the printer may still show its PREVIOUS job's end state until someone presses print
    if (p.manual && !p.seenRunning && !v && age < 30 * MS && (st === "FINISH" || st === "FAILED")) continue;
    const done = v?.status === "completed", broke = v?.status === "failed" || v?.status === "cancelled";
    if (st === "FINISH" || done) { markFinished(state, p.id, true, { finishedAt: st === "FINISH" ? null : v?.completedAt || null, t }); out.push({ plate: p, event: "finished", reconciled: st !== "FINISH" }); }
    else if (st === "FAILED" || broke) { const byHand = v?.status === "cancelled" ? "at the printer" : null; markFinished(state, p.id, false, { byHand, why: st === "FAILED" ? (byHand ? "stopped at the printer" : "the printer reported a failure") : `the driver recorded the print as ${v.status}`, finishedAt: st === "FAILED" ? null : v?.completedAt || null, t }); out.push({ plate: p, event: "failed", byHand, reconciled: st !== "FAILED" }); }
    else if (st === "IDLE" && age > 10 * MS && (p.progress || 0) > 0 && v?.status !== "printing") { markFinished(state, p.id, false, { byHand: "at the printer", why: "the printer went idle mid-print - stopped at the printer", t }); out.push({ plate: p, event: "failed", byHand: "at the printer" }); }
    // idle for half an hour and never seen running (a hand start nobody pressed, a send cancelled at the printer's screen before it
    // began): nothing printed, so the plate goes back to the top of the queue. It used to sit "printing" for ever and block the printer.
    else if (st === "IDLE" && age > 30 * MS && !p.seenRunning && !((p.progress || 0) > 0) && v?.status !== "printing") { unstart(state, p.id, "the printer never started it (idle for 30 min)"); out.push({ plate: p, event: "unstarted" }); }
  }
  return out;
}
