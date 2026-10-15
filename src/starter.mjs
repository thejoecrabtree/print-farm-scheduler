// The automatic starter's CHOICE: which plate a free printer starts next, and when. The printer lines decide: each line's head,
// once its computed start has come, passed through the machine gates engine.start() would apply anyway, so the starter never asks
// for a start that would be refused.
//
// Only the choice lives here. What happens after it is the caller's: a short countdown with a fresh AMS read, holds, the power
// stagger (engine.startGapMs), one start per pass, and engine.start() as the last word.
//
// Pure: no I/O, no clock of its own, never mutates `state`.
import { fits, printerState } from "./engine.mjs";
import { filamentCheck } from "./ams.mjs";
import { tzOf, clock } from "./labtime.mjs";

const IDLE_LIVE = ["IDLE", "FINISH", "FAILED", ""];
const ON_BED = new Set(["printing", "finished", "failed"]);

// built = lines.build(...). opts.colourOk(printerKey, plate) -> true when an operator said "go ahead in the loaded colours".
// Returns { picks: [{ printer, plate, start, why }], why: { printerKey: what held it } }, the line that waited longest first.
export function linePicks(built, state, live = {}, { t = Date.now(), colourOk = () => false } = {}) {
  const picks = []; const why = {}; const taken = new Set();
  const plates = state?.plates || {}; const all = Object.values(plates);
  const strict = state?.settings?.colourStrict !== false;
  const tz = tzOf(state?.settings);
  for (const [k, ln] of Object.entries(built?.lines || {})) {
    const pr = state?.printers?.[k]; const l = live?.[k] || null;
    const no = (w) => { why[k] = w; };
    if (!pr) { no("a printer the farm does not know"); continue; }
    if (!ln?.head) { no("nothing waiting on its line"); continue; }
    if (!ln.wouldStart) { no(ln.wouldWhy || "the line's head is not ready"); continue; }
    const pid = ln.wouldStart;
    if (pid !== ln.head) { no("the line's head is not the plate it would start"); continue; }
    const block = (ln.blocks || []).find((b) => b.kind === "waiting" && b.plateId === pid);
    if (!block) { no("the head plate has no block on the line"); continue; }
    // never before the computed start (lines.build says "would start" up to a minute early; the starter does not) nor a pinned `at`
    if (!(Number(block.start) <= t)) { no(`not before ${clock(block.start, tz)}`); continue; }
    if (block.pinnedAt != null && t < Number(block.pinnedAt)) { no(`pinned to ${clock(block.pinnedAt, tz)}`); continue; }
    const plate = plates[pid];
    if (!plate) { no("the head plate is gone"); continue; }
    if (plate.status !== "waiting") { no(`the head plate is ${plate.status}`); continue; }   // a plate is started once
    if (taken.has(pid)) { no("the head plate is already picked for another printer"); continue; }
    if (plate.file?.id == null) { no("the head plate has no sliced file"); continue; }
    if (pr.active === false) { no("switched off"); continue; }
    if (pr.stopped) { no("stopped (kill switch) - nothing starts until it is released"); continue; }
    if (pr.maintenance) { no("out of service"); continue; }
    if (!pr.autoStart) { no("auto-start is off"); continue; }
    if (pr.driverId == null) { no("no printer driver"); continue; }
    if (pr.plateOn !== true) { no("nobody has confirmed the build plate is on"); continue; }   // someone's word: a sensor alone never starts a print
    if (all.some((x) => x.printer === k && ON_BED.has(x.status))) { no("a plate is printing, paused or still on the bed"); continue; }
    const st = printerState(pr, l, all);
    if (st !== "idle") { no(`the printer is ${st}`); continue; }
    if (!l?.connected || !IDLE_LIVE.includes(String(l.state || ""))) { no(l?.connected ? `the printer is ${String(l.state).toLowerCase()}` : "printer not reachable"); continue; }
    if (l.storage === false) { no("no storage in the printer"); continue; }
    if (!fits(plate, pr)) { no("sliced for another model"); continue; }
    const f = filamentCheck(plate, l);
    if (f?.ok === false) { no("filament missing"); continue; }
    if (strict && plate.colours !== "loaded" && f?.colorOff?.length && !colourOk(k, plate)) { no("waiting for a colour"); continue; }
    if ((l.amsSlots || 0) > 0 && !(l.trays || []).some((x) => x.type && !x.unknown)) { no("the AMS has no typed spool"); continue; }
    taken.add(pid);
    picks.push({ printer: k, plate: pid, start: Number(block.start), why: `the next plate on ${pr.name}'s line${block.why ? ` (${block.why})` : ""}` });
  }
  const num = (k) => state?.printers?.[k]?.number ?? 99;
  picks.sort((a, b) => a.start - b.start || num(a.printer) - num(b.printer) || a.printer.localeCompare(b.printer));
  return { picks, why };
}

// Is the line's head due now? The time and the line's own holds only (for waking a printer that sleeps on a smart plug: a sleeping
// printer is unreachable, so the live gates cannot be asked yet).
export function lineDue(built, key, t = Date.now()) {
  const ln = built?.lines?.[key]; if (!ln?.head || ln.printer?.held) return false;
  const b = (ln.blocks || []).find((x) => x.kind === "waiting" && x.plateId === ln.head);
  return !!b && Number(b.start) <= t && (b.pinnedAt == null || Number(b.pinnedAt) <= t);
}
