// FILL: top every printer's line up with waiting plates until its computed work reaches now + settings.fillDays days (default 3).
//
// The rules that came out of running it:
//   - Fill looks 3 days ahead. Further out, the plan is mostly wrong by the time it arrives (failures, rush jobs, a printer down).
//   - When the goals change, Apply may replace plates that are unpinned and not started. A periodic auto-fill only ADDS.
//
// WHAT to print is week.select() (must-haves, then what sells, then the goals' category mix). WHERE is a cost function on real
// time. Each round the cheapest (job, line) pair is taken among the next WINDOW (6) jobs of each printer model, in select's order; a
// job further down pays RANK_COST (15) per place, so what sells still goes first, but a line takes the next toy in its loaded
// colours (or a different toy) over a colour swap (or a repeat):
//   - colours: a colour the AMS does not hold costs 10 while it fits beside what is loaded; a whole colour-set change costs 100 and
//     only happens inside the budget (maxChanges per printer per fill: settings.autoFillChanges for a periodic fill, goals.changes
//     for Apply); more colours than the AMS holds never lands,
//   - variety (unless settings.variety === false or job.sameOk): the same toy on another printer at an overlapping time costs
//     week.SAME_TIME_COST, the same toy straight after itself on one printer costs week.BACK_TO_BACK_COST,
//   - time: one point per hour until it would start (an idle printer is filled first), half a point per plate already added,
//   - showpieces: a category listed in settings.oncePerDay (default ["signature"]) lands at most once per printer per lab day, so the
//     long, high-value prints are spread across the fleet instead of stacked on one machine,
//   - the model it was sliced for; a printer out of service is filled only once someone has said when it is back (then from that
//     time), never one that is stopped, switched off, without a driver, or kept out of Fill (fillOff),
//   - staffed hours: a plate after another plate (a swap), or on a printer nobody confirmed a clean plate on, starts only when
//     someone is there, exactly as the lines compute it; a service session holds the line too.
// New plates are ordinary waiting plates pinned to their printer, source stock, note "filled".
//
// Never touched: printing / paused / finished / failed / done / held plates, custom (and order) jobs, plates someone placed
// (plate.locked) and plates with a pinned start (`at`). With `replace` (Apply of new goals) the OTHER waiting stock plates on the
// lines being filled are planned away first; the plan is made without them, and every one the new plan would print again on the
// same printer is kept. Only the rest are cancelled.
//
// plan() is pure: no I/O, no clock of its own, never mutates `state`. applyPlan() makes the plates, inside the caller's save.
import * as week from "./week.mjs";
import * as lines from "./lines.mjs";
import { tzOf, staffedOf, nextStaffed, labDate, clock } from "./labtime.mjs";
import { modelKey, fam, MIN, HOUR, DAY } from "./util.mjs";
import * as engine from "./engine.mjs";

export const FILL_DAYS = 3;
export const COLOUR_MISS_COST = 10, COLOUR_CHANGE_COST = 100, HOUR_COST = 1, PLATE_COST = 0.5, RANK_COST = 15, WINDOW = 6;
export function fillDaysOf(settings) { const n = Number(settings?.fillDays); return Number.isFinite(n) && n > 0 ? Math.min(14, n) : FILL_DAYS; }
const oncePerDayOf = (settings) => new Set(Array.isArray(settings?.oncePerDay) ? settings.oncePerDay : ["signature"]);

// ---- which plates Fill may plan away (replace) and which it must never touch
export function hasAt(p) { return Number.isFinite(typeof p?.at === "number" ? p.at : Date.parse(p?.at || "")); }
export function isPinned(p) { return !!p?.locked; }
export function replaceable(p) { return !!p && p.status === "waiting" && p.source?.type === "stock" && !isPinned(p) && !hasAt(p); }

const sameToy = (a, b) => (a.fileId != null && a.fileId === b.fileId) || (!!a.name && a.name === b.name);
const missing = (set, needs) => needs.filter((n) => !set.some((s) => week.same(s, n)));

// Plan a fill.
// opts: { t, live, settings, build (state -> lines.build result; default lines.build over `live`), demand and must rows (week.select),
//         mix (goals.mix; null = the settings' mix), maxChanges, only (one printer key), replace (Apply: plan the unpinned waiting
//         stock away first), max (a cap on jobs added) }
// Returns { at, horizon, days, budget, add: [job + { printer, plates: [{ …, start, end }], why }], remove: [{ plateId, printer, title }],
//           keep: [plateId], lines: { key: { from, to, added, changes, full } | { skipped } }, skipped, unplaced, demand, must }
export function plan(state, files, { build = null, t = Date.now(), live = {}, settings = state?.settings || {}, demand = [], must = [], mix = null, maxChanges = null, only = null, replace = false, max = 400 } = {}) {
  build ||= (s) => lines.build(s, live, { t, settings: s.settings || settings, files });
  const tz = tzOf(settings);
  const staffed = staffedOf(settings);
  const change = lines.changeoverMs(settings);
  const days = fillDaysOf(settings);
  const horizon = t + days * DAY;
  const budget = Math.max(0, Math.min(6, Number(maxChanges ?? settings.autoFillChanges ?? 1) || 0));
  const variety = settings.variety !== false;
  const oncePerDay = oncePerDayOf(settings);
  const byFile = new Map((files || []).map((f) => [f.id, f]));
  const staffedAt = (x) => nextStaffed(x, staffed, tz);

  // 1. the lines as they stand - without the plates Apply may plan away
  const printers = state?.printers || {};
  const eligible = {}; const skipped = [];
  const firstBuilt = build(state);
  for (const k of Object.keys(firstBuilt.lines || {})) {
    if (only && k !== only) continue;
    const pr = printers[k] || {};
    const why = pr.driverId == null ? "no printer driver"
      : pr.active === false ? "switched off"
      : pr.fillOff ? "kept out of Fill (fillOff)"
      : pr.stopped ? "stopped (kill switch)"
      : pr.maintenance && !Number.isFinite(Date.parse(pr.maintenance.backAt || "")) ? "out of service - no back time yet"
      : pr.maintenance && Date.parse(pr.maintenance.backAt) >= horizon ? `out of service until ${clock(Date.parse(pr.maintenance.backAt), tz)}`
      : null;
    if (why) { skipped.push({ printer: k, why }); continue; }
    eligible[k] = true;
  }
  const away = new Set();
  if (replace) for (const [k, ln] of Object.entries(firstBuilt.lines || {})) {
    if (!eligible[k]) continue;
    for (const b of ln.blocks) if (b.kind === "waiting" && b.plateId && !b.locked && b.pinnedAt == null && replaceable(state.plates?.[b.plateId])) away.add(b.plateId);
  }
  let st = state, built = firstBuilt;
  if (away.size) {
    const plates = { ...state.plates }; for (const pid of away) plates[pid] = { ...plates[pid], status: "cancelled" };
    st = { ...state, plates, order: (state.order || []).filter((pid) => !away.has(pid)) };
    built = build(st);
  }

  // 2. every line's state at its end: where new work may start, what is loaded, the same-toy timeline for variety
  const timeline = [];   // { printer, fileId, name, start, end }
  const lanes = [];
  const catOf = (fileId, fallback) => byFile.get(fileId)?.category || fallback || null;
  for (const [k, ln] of Object.entries(built.lines || {})) {
    const nonService = ln.blocks.filter((b) => b.kind !== "service");
    for (const b of nonService) if (["printing", "paused", "waiting", "finished-on-bed"].includes(b.kind) && (b.fileId != null || b.title)) timeline.push({ printer: k, fileId: b.fileId ?? null, name: week.toyKey(b.title), start: b.start, end: b.end });
    if (!eligible[k]) continue;
    const pr = printers[k] || {}; const l = live?.[k] || null;
    const model = modelKey(pr.model || ln.printer?.model) || "P2S";
    const last = nonService[nonService.length - 1] || null;
    const cursor = Math.max(t, ln.printer?.readyAt ?? t, last ? last.end + (last.kind === "finished-on-bed" ? 0 : change) : 0);
    // the service blocks after the last plate: an added plate goes behind them once their time has come
    const lastIdx = last ? ln.blocks.lastIndexOf(last) : -1;
    const pending = ln.blocks.slice(lastIdx + 1).filter((b) => b.kind === "service" && b.gates !== false && Number.isFinite(b.pinnedAt)).map((b) => ({ at: b.pinnedAt, minutes: Math.max(1, Math.round((b.end - b.start) / MIN)) })).sort((a, b) => a.at - b.at);
    // what the AMS holds by the end of the line: the live trays, then what each waiting plate ahead needs (its own swap, not ours)
    const slots = Number(l?.amsSlots) || week.DEFAULT_SLOTS[model] || 4;
    let set = (l?.trays || []).filter((x) => x.ams !== "ext" && x.type && x.color).map((x) => ({ type: fam(x.type), color: x.color }));
    for (const b of nonService) {
      if (b.kind !== "waiting") continue;
      const need = (b.colours || []).map((c) => ({ type: fam(c.type), color: c.color }));
      const miss = missing(set, need);
      if (set.length + miss.length <= slots) set = [...set, ...miss]; else set = [...need];
    }
    const lastJob = last && (last.fileId != null || last.title) ? { fileId: last.fileId ?? null, name: week.toyKey(last.title) } : null;
    const bigDays = new Set(nonService.filter((b) => oncePerDay.has(String(catOf(b.fileId, b.category) || ""))).map((b) => labDate(b.start, tz)));
    const workEnd = Math.max(t, last ? last.end : cursor);
    lanes.push({ key: k, name: pr.name || k, number: pr.number ?? 99, model, slots, set, cursor, workEnd, from: workEnd, prev: nonService.length > 0, unattendedOk: lines.unattendedOk(pr), pending, last: lastJob, bigDays, changes: 0, added: 0, jobs: [] });
  }
  lanes.sort((a, b) => a.number - b.number || a.key.localeCompare(b.key));
  // a line is open while its work ends before the horizon AND the next plate could still start before it (a swap after the last
  // staffed hour waits for the morning - past the horizon that line is full)
  const laneOpen = (lane) => lane.workEnd < horizon && (lane.prev || !lane.unattendedOk ? staffedAt(lane.cursor) : lane.cursor) < horizon;

  // 3. what to print: week.select over the time left on the lines (one "slot" per free hour - the horizon is the real limit)
  const slotsByModel = {};
  for (const ln of lanes) if (laneOpen(ln)) slotsByModel[ln.model] = (slotsByModel[ln.model] || 0) + Math.max(0, Math.ceil((horizon - ln.cursor) / HOUR));
  const sel = week.select(files, st, { mode: "demand", mix, slotsByModel, demand, must, t });
  const jobs = sel.jobs.filter((j) => j.kind !== "custom");

  // 4. every job, in select's order, to the line where it costs least
  // the times of a job's plates on a lane (the same cursor / services / staffed rule as lines.build)
  const timesFor = (lane, job) => {
    let cursor = lane.cursor, prev = lane.prev; const pending = lane.pending.map((s) => ({ ...s })); const out = [];
    const service = () => { const s = pending.shift(); const start = staffedAt(Math.max(cursor, s.at)); cursor = start + s.minutes * MIN; prev = true; };
    for (const pl of job.plates) {
      while (pending.length && pending[0].at <= cursor) service();
      let start = cursor; const needsOperator = prev || !lane.unattendedOk;
      if (needsOperator) start = staffedAt(start);
      const end = start + Math.max(1, Number(pl.minutes) || 60) * MIN;
      out.push({ index: pl.index, name: pl.name || null, minutes: pl.minutes, grams: pl.grams, colours: pl.colours, start, end, needsOperator });
      cursor = end + change; prev = true;
    }
    return { plates: out, cursor, pending };
  };
  const add = []; const unplaced = [];
  const open = () => lanes.some(laneOpen);
  // the cost of one job on one lane (null = wrong model), with why, in words
  const costOn = (lane, job) => {
    const need = job.colours || [];
    if (lane.model !== job.model) return null;
    if (!laneOpen(lane)) return { full: true };
    const miss = missing(lane.set, need);
    const fitsSet = lane.set.length + miss.length <= lane.slots;
    const swap = !fitsSet && lane.changes < budget && need.length <= lane.slots;
    if (!fitsSet && !swap) return { no: `${lane.name}: ${need.length > lane.slots ? "more colours than its AMS holds" : "its colour-change budget is spent"}` };
    const at = timesFor(lane, job);
    const start = at.plates[0].start, end = at.plates[at.plates.length - 1].end;
    if (start >= horizon) return { no: `${lane.name}: nobody is there before the horizon` };
    if (oncePerDay.has(String(job.category || "")) && at.plates.some((p) => lane.bigDays.has(labDate(p.start, tz)))) return { no: `${lane.name}: already has a ${job.category} piece that day` };
    const me = { fileId: job.fileId, name: week.toyKey(job.name) };
    let sameness = 0; const bits = [];
    if (variety && !job.sameOk) {
      if (lane.last && sameToy(lane.last, me)) { sameness += week.BACK_TO_BACK_COST; bits.push("the same toy straight after"); }
      if (timeline.some((x) => x.printer !== lane.key && sameToy(x, me) && x.start < end && start < x.end)) { sameness += week.SAME_TIME_COST; bits.push("the same toy on another printer then"); }
    }
    const cost = (swap ? COLOUR_CHANGE_COST : miss.length * COLOUR_MISS_COST) + sameness + ((start - t) / HOUR) * HOUR_COST + lane.added * PLATE_COST;
    return { lane, job, at, swap, miss, me, cost, bits };
  };
  const pendingJobs = jobs.slice();
  while (pendingJobs.length && add.length < max && open()) {
    let best = null;
    // the window is per MODEL: each line sees the next WINDOW jobs sliced for it. With one global window, a printer model with few
    // toys had its toys sitting outside the window behind the other model's jobs, and it printed the same two toys over and over.
    const seen = new Map();   // model -> jobs of it looked at this round
    for (let i = 0; i < pendingJobs.length; i++) {
      const job = pendingJobs[i]; const rank = seen.get(job.model) || 0;
      if (rank >= WINDOW) continue;
      seen.set(job.model, rank + 1);
      let any = null; const no = [];
      for (const lane of lanes) { const c = costOn(lane, job); if (!c || c.full) continue; if (c.no) { no.push(c.no); continue; } any = c; const total = c.cost + rank * RANK_COST; if (!best || total < best.total - 1e-9) best = { ...c, total, i }; }
      // nowhere to go: say why when a line of its model was open and refused it; nothing to say when those lines are all full
      if (!any) { if (no.length) unplaced.push({ name: job.name, fileId: job.fileId, sku: job.sku, kind: job.kind, why: no[0] }); pendingJobs.splice(i, 1); i--; seen.set(job.model, rank); }
    }
    if (!best) continue;
    const { lane, job, at, swap, miss, me, cost, bits } = best;
    pendingJobs.splice(best.i, 1);
    const need = job.colours || [];
    if (swap) { lane.changes++; lane.set = [...need]; } else lane.set = [...lane.set, ...miss];
    const why = [job.kind === "must" ? `must${job.by ? ` (by ${job.by})` : ""}` : job.kind === "demand" ? "sells (demand)" : `the ${job.category || "stock"} mix`];
    why.push(swap ? `colour change (${lane.changes} of ${budget})` : miss.length ? `loads ${miss.length} colour${miss.length === 1 ? "" : "s"}` : "colours already loaded");
    if (at.plates[0].needsOperator && at.plates[0].start > lane.cursor) why.push(`someone is there from ${clock(at.plates[0].start, tz)}`);
    why.push(...bits);
    const rec = { ...job, printer: lane.key, printerName: lane.name, plates: at.plates, start: at.plates[0].start, end: at.plates[at.plates.length - 1].end, swap, cost: Math.round(cost * 10) / 10, why: why.join(" · ") };
    add.push(rec); lane.jobs.push(rec);
    lane.cursor = at.cursor; lane.workEnd = rec.end; lane.pending = at.pending; lane.prev = true; lane.added++;
    lane.last = me;
    for (const p of at.plates) { timeline.push({ printer: lane.key, fileId: job.fileId, name: me.name, start: p.start, end: p.end }); if (oncePerDay.has(String(job.category || ""))) lane.bigDays.add(labDate(p.start, tz)); }
  }

  // 5. Apply: the plates planned away that the new plan prints again on the same printer are kept (no cancel, no new plate); each
  // kept plate takes the time the plan gave its job (keepAt), so applyPlan can put the queue in the plan's order
  const keep = []; const remove = []; const keepAt = {};
  if (away.size) {
    const pool = [...away].map((pid) => state.plates[pid]).filter(Boolean);
    const taken = new Set();
    const onLine = new Map(); for (const [k, ln] of Object.entries(firstBuilt.lines || {})) for (const b of ln.blocks) if (b.plateId) onLine.set(b.plateId, k);
    const lineOf = new Map(pool.map((p) => [p.id, onLine.get(p.id) || p.printer || null]));
    for (let i = 0; i < add.length; i++) {
      const job = add[i];
      if (job.plates.length > 1) {
        // a set is kept only whole: every plate of one set id of this file on this printer
        const sets = {}; for (const p of pool) if (!taken.has(p.id) && p.file?.id === job.fileId && lineOf.get(p.id) === job.printer && p.set?.id) (sets[p.set.id] ||= []).push(p);
        const whole = Object.values(sets).find((xs) => xs.length === job.plates.length);
        if (whole) { whole.sort((a, b) => (a.set?.n || 0) - (b.set?.n || 0)).forEach((p, n) => { taken.add(p.id); keep.push(p.id); keepAt[p.id] = job.plates[n]?.start ?? job.start; }); add.splice(i, 1); i--; }
        continue;
      }
      const hit = pool.find((p) => !taken.has(p.id) && !p.set?.id && p.file?.id === job.fileId && lineOf.get(p.id) === job.printer);
      if (hit) { taken.add(hit.id); keep.push(hit.id); keepAt[hit.id] = job.start; add.splice(i, 1); i--; }
    }
    for (const p of pool) if (!taken.has(p.id)) remove.push({ plateId: p.id, printer: lineOf.get(p.id) || null, title: p.title, why: "no longer in the plan for these goals" });
  }

  const linesOut = {};
  for (const lane of lanes) linesOut[lane.key] = { name: lane.name, from: lane.from, to: lane.workEnd, added: add.filter((a) => a.printer === lane.key).length, plates: add.filter((a) => a.printer === lane.key).reduce((n, a) => n + a.plates.length, 0), changes: lane.changes, full: !laneOpen(lane) };
  for (const s of skipped) linesOut[s.printer] = { skipped: s.why };
  return { at: t, horizon, days, budget, add, remove, keep, keepAt, lines: linesOut, skipped, unplaced: unplaced.slice(0, 30), demand: (sel.demand || []).slice(0, 30), must: sel.must || [], jobs: jobs.length, slotsByModel };
}

// Inside the caller's save: cancel `remove` (only while still replaceable) and add every job's plates, pinned to its printer, source
// stock, note "filled". A set gets one set id. Then the plan's plates (new and kept) move to the back of the queue in the order of
// their planned starts. The plan was made with them after everything else on each line, and a line's order IS the queue's order:
// appending only the new plates put them behind the kept ones, so after Apply the lines no longer matched the preview (a must-have
// planned for Wednesday ran on Thursday night). Returns { added: [plate ids], removed, jobs }.
export function applyPlan(s, planned, files, { by = "auto", t = Date.now(), newId } = {}) {
  const byFile = new Map((files || []).map((f) => [f.id, f]));
  let removed = 0; const added = []; let jobs = 0; let seq = 0; const placed = [];
  for (const r of planned.remove || []) if (replaceable(s.plates[r.plateId])) { engine.cancel(s, r.plateId, `replaced when the goals changed (${by})`, { t }); removed++; }
  for (const job of planned.add || []) {
    const file = byFile.get(job.fileId); if (!file) continue;
    const printer = s.printers?.[job.printer] ? job.printer : null; if (!printer) continue;
    const of = job.plates.length; const setId = of > 1 ? `S-${t.toString(36)}f${(seq++).toString(36)}` : null;
    const name = String(job.name || file.name || "").replace(/\.gcode\.3mf$/i, "");
    job.plates.forEach((pl, i) => {
      const fp = (file.plates || []).find((x) => x.index === pl.index) || null;
      const [p] = engine.addPlates(s, { file, sku: file.sku || null, count: 1, printer, source: { type: "stock", note: "filled", ref: "fill", by, kind: job.kind || "stock" }, title: of > 1 ? `${name} · plate ${pl.index} of ${of}` : name,
        plate: of > 1 ? { index: pl.index, of, name: pl.name || null } : null, set: of > 1 ? { id: setId, n: i + 1, of } : null,
        minutes: Number(pl.minutes) || undefined, grams: Number(pl.grams) || undefined, filaments: fp?.filaments || file.filaments || null, t, ...(newId ? { newId } : {}) });
      added.push(p.id); placed.push({ id: p.id, start: pl.start });
    });
    jobs++;
  }
  for (const [pid, start] of Object.entries(planned.keepAt || {})) if (s.plates[pid]?.status === "waiting") placed.push({ id: pid, start });
  if (placed.length) {
    placed.sort((a, b) => a.start - b.start);
    const moved = new Set(placed.map((x) => x.id));
    s.order = [...s.order.filter((pid) => !moved.has(pid)), ...placed.map((x) => x.id)];
  }
  return { added, removed, jobs };
}
