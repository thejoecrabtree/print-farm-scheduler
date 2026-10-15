// Printer lines: the timeline.
//
// Each printer has ONE ordered line of plates: that line is the plan, the queue and "next" at once. The line's order is the queue's
// order (state.order). A plate may carry a pinned printer, a pinned start (`plate.at`) and a lock (`plate.locked`: someone placed
// it, so Fill never moves it). Times are COMPUTED here, never stored. A plate starts at the latest of
//   - now,
//   - the end of the plate ahead of it on that printer + the changeover (settings.swapMinutes, default 15),
//   - its pinned `at`,
//   - the next staffed window when it needs someone: a plate swap (anything after another plate on the same printer) or an idle
//     printer nobody has confirmed a build plate on. A print may run and finish overnight; it only STARTS in staffed hours unless
//     someone already confirmed the plate is on,
//   - the printer's back-in-service time.
// It ends at start + its length (the live ETA for the one printing). A finished or failed plate still on the bed (a print stopped
// by hand too) blocks its printer until someone clears it. A service session (opts.service) is a block on each line.
//
// Pure: no I/O, no clock of its own, never mutates `state` (engine.lanes() writes _eta; this does not).
import { fits, handStop } from "./engine.mjs";
import { filamentCheck } from "./ams.mjs";
import { atLab, labDate, dayDate, tzOf, staffedOf, nextStaffed, clock } from "./labtime.mjs";
import { same, DEFAULT_SLOTS } from "./week.mjs";
import { modelKey } from "./util.mjs";

export { STAFFED, staffedOf, isStaffed, nextStaffed } from "./labtime.mjs";
const MIN = 60_000;
export const CHANGEOVER_MIN = 15;
const short = (s, n = 40) => { const x = String(s || "").replace(/\s*·\s*(P1S|P2S|X1C|H2S|H2D|H2C|A1 ?MINI|A1)\s*$/i, ""); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const RUNNING = /RUNNING|PRINTING|PREPARE|PAUSE/i;
export const changeoverMs = (settings) => { const m = Number(settings?.swapMinutes); return (Number.isFinite(m) && m >= 0 ? m : CHANGEOVER_MIN) * MIN; };
// can this printer start a plate with nobody there? Only when someone already confirmed a clean build plate on it, it starts
// itself, and the scheduler can drive it
export const unattendedOk = (p) => p.plateOn === true && p.autoStart !== false && p.driverId != null && p.active !== false;

// opts: t, settings, files (library, for plate lengths), service: { sessions: [{ id, at, printers: { key: { minutes, done } } }],
//       gates (false = drawn only) }, colourName(type, hex), categoryOf(fileId), pastDays (history kept on each line, default 8)
export function build(state, live = {}, opts = {}) {
  const t = Number.isFinite(opts.t) ? opts.t : Date.now();
  const settings = opts.settings || state?.settings || {};
  const tz = tzOf(settings);
  const staffed = staffedOf(settings);
  const change = changeoverMs(settings);
  const plates = state?.plates || {};
  const files = new Map((opts.files || []).map((f) => [f.id, f]));
  const serviceGates = opts.service?.gates !== false;
  const sessions = (opts.service?.sessions || []).filter((s) => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const staffedAt = (x) => nextStaffed(x, staffed, tz);
  const minutesOf = (p) => Math.max(1, Number(p.minutes) || Number(files.get(p.file?.id)?.minutes) || 60);
  // what a screen draws on a block (display only: nothing here changes a time or an order): the file and plate for its picture,
  // the colours (with shelf names when the caller can name them), the category, custom or not
  const nameOf = typeof opts.colourName === "function" ? opts.colourName : null;
  const catOf = typeof opts.categoryOf === "function" ? opts.categoryOf : null;
  const coloursOf = (p) => {
    const out = [];
    for (const f of p.filaments || []) {
      if (!f?.color) continue;
      const type = String(f.type || "PLA").toUpperCase().split(" ")[0]; const color = String(f.color);
      if (out.some((c) => c.type === type && c.color.toLowerCase() === color.toLowerCase())) continue;
      const c = { type, color };
      if (nameOf) { try { const n = nameOf(type, color); if (n) c.name = n; } catch { /* a name is a nicety */ } }
      out.push(c);
    }
    return out;
  };
  const look = (p) => {
    let category = null;
    if (catOf && p.file?.id != null) { try { category = catOf(p.file.id) || null; } catch { category = null; } }
    if (!category) category = files.get(p.file?.id)?.category || null;
    return { fileId: p.file?.id ?? null, sku: p.sku ?? null, plateIndex: p.plate?.index ?? null, category, custom: p.source?.type === "custom", colours: coloursOf(p), planMin: minutesOf(p) };
  };
  const atOf = (p) => { const x = typeof p.at === "number" ? p.at : Date.parse(p.at || ""); return Number.isFinite(x) ? x : null; };
  const PAST_MS = (Number(opts.pastDays) > 0 ? Number(opts.pastDays) : 8) * 86_400_000;

  const printers = Object.values(state?.printers || {}).sort((a, b) => (a.number ?? 99) - (b.number ?? 99) || String(a.key).localeCompare(String(b.key)));
  const L = {};
  for (const p of printers) {
    const l = live?.[p.key] || null;
    const heads = []; const notes = [];
    const onIt = Object.values(plates).filter((x) => x.printer === p.key);
    const printing = onIt.filter((x) => x.status === "printing").sort((a, b) => (Date.parse(a.startedAt || 0) || 0) - (Date.parse(b.startedAt || 0) || 0));
    const onBed = onIt.filter((x) => x.status === "finished" || x.status === "failed");
    const liveRunning = !!l?.connected && RUNNING.test(String(l.state || ""));
    const paused = !!l?.connected && /PAUSE/i.test(String(l.state || ""));
    const remaining = !!l?.connected && Number(l.remainingMin) > 0 ? Number(l.remainingMin) : null;
    let readyAt = t;
    if (printing.length) {
      printing.forEach((x, i) => {
        const last = i === printing.length - 1;
        const start = Date.parse(x.startedAt || "") || t;
        const left = last && remaining != null ? remaining : Math.max(1, Math.round((start + minutesOf(x) * MIN - t) / MIN));
        const shown = { ...look(x), progress: last && l?.connected && Number.isFinite(Number(l.progress)) ? Math.max(0, Math.min(100, Number(l.progress))) : null, eta: last && remaining != null ? "printer" : "plan" };
        if (last && paused) {
          const resume = staffedAt(t);
          heads.push({ plateId: x.id, title: x.title, kind: "paused", start, end: resume + left * MIN, pinnedAt: null, pinnedPrinter: x.pinnedPrinter || x.printer || null, locked: true, why: `paused - someone resumes it${resume > t ? ` (${clock(resume, tz)})` : ""}, then ${left} min left`, ...shown });
        } else {
          heads.push({ plateId: x.id, title: x.title, kind: "printing", start, end: t + left * MIN, pinnedAt: null, pinnedPrinter: x.pinnedPrinter || x.printer || null, locked: true, why: last && remaining != null ? "printing - live ETA from the printer" : "printing - no live ETA, planned length", ...shown });
        }
      });
      if (printing.length > 1) notes.push(`${printing.length} plates marked printing on one printer`);
      if (onBed.length) notes.push("a finished / failed plate is also recorded on this printer - ignored while it prints");
    } else if (liveRunning && remaining != null) {
      heads.push({ plateId: null, title: l.job || "a print the scheduler did not start", kind: paused ? "paused" : "printing", start: t, end: (paused ? staffedAt(t) : t) + remaining * MIN, pinnedAt: null, pinnedPrinter: null, locked: true, why: "the printer is busy with a job that is not on the queue (live ETA)",
        fileId: null, sku: null, plateIndex: null, category: null, custom: false, colours: [], planMin: remaining, progress: Number.isFinite(Number(l.progress)) ? Math.max(0, Math.min(100, Number(l.progress))) : null, eta: "printer" });
    } else if (onBed.length) {
      const clear = staffedAt(t);
      for (const x of onBed) {
        const sb = x.status === "failed" ? handStop(x) : null;
        heads.push({ plateId: x.id, title: x.title, kind: "finished-on-bed", start: Date.parse(x.finishedAt || x.closedAt || "") || t, end: clear, pinnedAt: null, pinnedPrinter: x.printer, locked: true, stoppedByHand: sb || null,
          why: `${x.status === "finished" ? "finished" : sb ? "stopped by hand" : "failed"} - still on the bed until someone clears it${clear > t ? ` (${clock(clear, tz)})` : ""}`,
          failed: x.status === "failed", startedAt: Date.parse(x.startedAt || "") || null, ...look(x) });
      }
    }
    for (const h of heads) readyAt = Math.max(readyAt, h.end + (h.kind === "finished-on-bed" ? 0 : change));
    // out of service: back at its time; unknown = the next morning someone is there
    let backAt = null;
    if (p.maintenance || p.active === false) {
      const b = Date.parse(p.maintenance?.backAt || "");
      backAt = Number.isFinite(b) ? b : staffedAt(atLab(dayDate(labDate(t, tz), 1), "00:00", tz));
      if (!Number.isFinite(b)) notes.push(p.active === false ? "switched off - back time unknown (assumed tomorrow morning)" : "out of service - back time unknown (assumed tomorrow morning)");
      readyAt = Math.max(readyAt, backAt);
    }
    // what this printer printed lately (closed plates, off the bed): history, drawn before "now", never the plan
    const past = onIt.filter((x) => x.status === "done").map((x) => {
      const end = Date.parse(x.finishedAt || x.closedAt || ""); const start = Date.parse(x.startedAt || "");
      return Number.isFinite(end) && end >= t - PAST_MS ? { plateId: x.id, title: x.title, kind: x.outcome?.wasFailed ? "failed" : "done", start: Number.isFinite(start) ? Math.min(start, end) : end - minutesOf(x) * MIN, end, ...look(x) } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start).slice(-80);
    L[p.key] = { p, l, heads, notes, readyAt, backAt, unattendedOk: unattendedOk(p), entries: [], past };
  }

  // ---- which line each waiting plate is on, and in which order: the queue's
  const qIndex = new Map((state?.order || []).map((pid, i) => [pid, i]));
  const waiting = Object.values(plates).filter((p) => p.status === "waiting")
    .sort((a, b) => (qIndex.get(a.id) ?? 1e9) - (qIndex.get(b.id) ?? 1e9) || (Date.parse(a.createdAt || 0) || 0) - (Date.parse(b.createdAt || 0) || 0) || String(a.id).localeCompare(String(b.id)));
  const setPrinter = {};
  for (const p of Object.values(plates)) if (p.set?.id && p.printer && p.status === "done") setPrinter[p.set.id] ??= p.printer;
  for (const p of Object.values(plates)) if (p.set?.id && p.printer && ["printing", "finished", "failed"].includes(p.status)) setPrinter[p.set.id] = p.printer;
  const usable = (k) => { const x = L[k]; return !!x && x.p.active !== false && !x.p.maintenance; };
  const unplaced = []; const auto = [];
  for (const p of waiting) {
    let key = null, by = null;
    if (p.printer && L[p.printer]) { key = p.printer; by = "printer"; }
    else if (p.set?.id && setPrinter[p.set.id] && L[setPrinter[p.set.id]]) { key = setPrinter[p.set.id]; by = "set"; }
    if (p.printer && !L[p.printer]) { unplaced.push({ plateId: p.id, title: p.title, why: `pinned to a printer that is not in the farm (${p.printer})` }); continue; }
    if (!key) { auto.push({ p }); continue; }
    L[key].entries.push({ p, by, q: qIndex.get(p.id) ?? 1e9, at: atOf(p) });
  }
  const sortLine = (x) => x.entries.sort((a, b) => a.q - b.q);

  // ---- times along one line
  const schedule = (x) => {
    const out = x.heads.map((h) => ({ ...h }));
    let cursor = Math.max(t, x.readyAt);
    let prev = x.heads.length > 0;
    const pending = sessions.filter((s) => s.printers?.[x.p.key] && !s.printers[x.p.key].done && s.at < t + 8 * 86_400_000).map((s) => ({ ...s, minutes: Math.max(1, Number(s.printers[x.p.key].minutes) || 30) }));
    const service = (s) => {
      const from = Math.max(cursor, s.at);
      const start = staffedAt(from); const end = start + s.minutes * MIN;
      const why = [`service ${s.id}${s.open ? " (in progress)" : ""}`];
      if (from > s.at) why.push("after the plate ahead of it");
      if (start > from) why.push(`someone does it - ${clock(start, tz)}`);
      if (!serviceGates) why.push("drawn only - it does not hold the line");
      out.push({ plateId: null, title: "Service", kind: "service", start, end, pinnedAt: s.at, pinnedPrinter: x.p.key, locked: true, gates: serviceGates, why: why.join(" · ") });
      if (serviceGates) { cursor = end; prev = true; }
    };
    // where a plate would go right now (no commit): after the plate ahead + changeover, at its pinned time, when someone is there
    const timesOf = (e) => {
      const p = e.p; const at = e.at; let start = cursor; const why = [];
      const ahead = [...out].reverse().find((b) => b.kind !== "service" || b.gates !== false);
      if (ahead) why.push(`after ${ahead.kind === "service" ? "the service" : short(ahead.title, 28) || "the plate ahead"}${ahead.kind === "finished-on-bed" ? " is cleared" : ahead.kind === "service" ? "" : ` + ${Math.round(change / MIN)} min changeover`}`);
      if (x.backAt && out.length === x.heads.length && x.backAt >= start) why.push(`back in service ${clock(x.backAt, tz)}`);
      if (at != null && at > start) { start = at; why.push(`pinned to ${clock(at, tz)}`); }
      const needsOperator = prev || !x.unattendedOk;
      if (needsOperator) {
        const s2 = staffedAt(start);
        if (s2 > start) why.push(`needs someone (${prev ? "plate swap" : "plate-on not confirmed"}) - staffed from ${clock(s2, tz)}`);
        start = s2;
      }
      return { start, end: start + minutesOf(p) * MIN, why, needsOperator };
    };
    const plain = x.entries.filter((e) => e.at == null);
    const pinned = x.entries.filter((e) => e.at != null).sort((a, b) => a.at - b.at || a.q - b.q);
    while (plain.length || pinned.length) {
      // A pinned plate waits for its time. The plates behind it in the queue fill the gap before it only when they finish (plus
      // the changeover) by then; a pinned time that has passed is simply due.
      let e;
      if (!pinned.length) e = plain.shift();
      else if (!plain.length) e = pinned.shift();
      else { const tr = timesOf(plain[0]); e = tr.start >= pinned[0].at || tr.end + change > pinned[0].at ? pinned.shift() : plain.shift(); }
      // a service due before this plate would start goes first (a plate that starts before it runs over and pushes it instead)
      while (pending.length && pending[0].at <= Math.max(cursor, e.at ?? 0)) service(pending.shift());
      const p = e.p; const { start, end, why, needsOperator } = timesOf(e);
      out.push({ plateId: p.id, title: p.title, kind: "waiting", start, end, minutes: minutesOf(p), pinnedAt: e.at, pinnedPrinter: p.pinnedPrinter || p.printer || null, locked: !!p.locked,
        placedBy: e.by, needsOperator, why: why.join(" · ") || "first on the line", ...look(p) });
      cursor = end + change; prev = true;
    }
    for (const s of pending) service(s);
    return out;
  };
  for (const x of Object.values(L)) sortLine(x);
  const timed = {};
  for (const [k, x] of Object.entries(L)) timed[k] = schedule(x);

  // plates with no printer: the fitting, in-service line that is free first takes it. A printer kept out of Fill (fillOff) takes
  // no plate that has no printer of its own - only what is dropped on it.
  for (const { p } of auto) {
    const cands = Object.keys(L).filter((k) => usable(k) && !L[k].p.stopped && !L[k].p.fillOff && fits(p, L[k].p) && !(p.avoid || []).includes(k));
    const pool = cands.length ? cands : Object.keys(L).filter((k) => usable(k) && !L[k].p.fillOff && fits(p, L[k].p));
    if (!pool.length) { unplaced.push({ plateId: p.id, title: p.title, model: modelKey(p.anyModel || p.file?.model || "") || null, minutes: minutesOf(p), why: `no ${modelKey(p.anyModel || p.file?.model || "") || "fitting"} printer in service and in Fill` }); continue; }
    const endOf = (k) => { const b = timed[k]; return b.length ? b[b.length - 1].end : Math.max(t, L[k].readyAt); };
    pool.sort((a, b) => endOf(a) - endOf(b) || a.localeCompare(b));
    const k = pool[0];
    L[k].entries.push({ p, by: "auto", q: qIndex.get(p.id) ?? 1e9, at: atOf(p) });
    timed[k] = schedule(L[k]);
  }

  // ---- spool changes: walking each line from the spools in the AMS now, a waiting plate that needs a colour the AMS will not hold
  // at that point carries `load` [{ type, color, name? }] (a screen draws a marker there). The AMS after a plate = its colours first,
  // then what was loaded that it did not need, up to the printer's slots. With no live trays (offline, asleep) the first plate on
  // the line is the starting point and gets no marker of its own.
  for (const [k, blocks] of Object.entries(timed)) {
    const x = L[k]; const l = x.l;
    const slots = Number(l?.amsSlots) || DEFAULT_SLOTS[modelKey(x.p.model || "")] || 4;
    const trays = (l?.connected ? (l.trays || []) : []).filter((tr) => tr && tr.ams !== "ext" && tr.type && !tr.unknown && tr.color).map((tr) => ({ type: String(tr.type).toUpperCase().split(" ")[0], color: tr.color }));
    let set = trays.length ? trays : null;
    for (const b of blocks) {
      if (b.kind !== "waiting" && b.kind !== "printing" && b.kind !== "paused") continue;
      const needs = (b.colours || []).filter((c) => c && c.color);
      if (!needs.length) continue;
      if (b.kind !== "waiting") { set = [...needs, ...(set || []).filter((e) => !needs.some((n) => same(n, e)))].slice(0, Math.max(slots, needs.length)); continue; }   // what prints now is loaded
      if (set) { const miss = needs.filter((n) => !set.some((e) => same(n, e))); if (miss.length) b.load = miss.map((c) => ({ ...c })); }
      set = [...needs, ...(set || []).filter((e) => !needs.some((n) => same(n, e)))].slice(0, Math.max(slots, needs.length));
    }
  }

  // ---- out
  const lines = {};
  for (const [k, x] of Object.entries(L)) {
    const blocks = timed[k];
    const head = blocks.find((b) => b.kind === "waiting") || null;
    const pr = x.p, l = x.l;
    const held = pr.stopped ? "stopped (kill switch) - nothing starts until it is released" : pr.maintenance ? "out of service" : pr.active === false ? "switched off" : null;
    // would the line start its head plate NOW? (the machine-side gates only; a starter keeps its own: stagger, one start per pass)
    let wouldStart = null, wouldWhy = null;
    if (head && head.start <= t + MIN) {
      const plate = plates[head.plateId];
      const f = plate ? filamentCheck(plate, l) : null;
      const gate = held ? held
        : !pr.autoStart ? "auto-start is off"
        : pr.driverId == null ? "no printer driver"
        : !l?.connected ? "printer not reachable"
        : !["IDLE", "FINISH", "FAILED", ""].includes(String(l.state || "")) ? `printer is ${String(l.state).toLowerCase()}`
        : x.heads.length ? "the bed is not clear"
        : pr.plateOn !== true ? "nobody has confirmed the build plate is on"
        : l.storage === false ? "no storage in the printer"
        : plate && !fits(plate, pr) ? "sliced for another model"
        : f?.ok === false ? "filament missing"
        : null;
      if (gate) wouldWhy = gate; else wouldStart = head.plateId;
    } else if (head) wouldWhy = `not before ${clock(head.start, tz)}`;
    lines[k] = {
      printer: { key: pr.key, name: pr.name, number: pr.number ?? null, model: pr.model || null, active: pr.active !== false, inService: !pr.maintenance && pr.active !== false, stopped: !!pr.stopped, autoStart: pr.autoStart !== false, bound: pr.driverId != null, plateOn: pr.plateOn === true, backAt: x.backAt, readyAt: x.readyAt, held, fillOff: !!pr.fillOff },
      blocks, head: head?.plateId || null, wouldStart, wouldWhy, notes: x.notes, past: x.past,
    };
  }
  return { at: t, staffed, changeoverMin: Math.round(change / MIN), lines, unplaced };
}
