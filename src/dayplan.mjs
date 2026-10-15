// The colour day plan. Asking for a spool swap plate by plate, as each plate comes up, means someone walks to a printer and swaps
// spools many times a day. Instead the scheduler decides once which colour set each printer runs: it keeps what is loaded and
// needed, gives every waiting plate to the printer whose set already covers it, and only adds a colour to a set when no printer
// covers the plate. The decision rule is fewest colour swaps first, total time as the tiebreaker. The result is one "set up this
// printer" list per printer (load these spools now), and plates that share a colour set run on the same printer.
//
// Pure: takes the state and the live trays, returns { printerOf, printers }. engine.lanes() uses printerOf as placement affinity;
// engine.colourNeeds() turns each printer's `loads` into its loading list.
import { modelKey, fam } from "./util.mjs";

const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
// RGB distance: here it only answers "is this the same spool?", where RGB is good enough (the perceptual distance in ams.mjs
// decides which loaded tray a colour goes to)
export const dist = (a, b) => { if (!a || !b) return 999; const [x, y] = [hex(a), hex(b)]; return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0)); };
export const CLOSE = 80;   // RGB distance under which two colours count as the same spool

function covers(entry, need) { return fam(entry.type) === fam(need.type) && !!entry.color && !!need.color && dist(entry.color, need.color) <= CLOSE; }

// opts: fits(plate, printer), nameOf(type, hex) -> a shelf name ("Sakura Pink") or null, include(plateId) -> only plan these
// (e.g. the plates that start today)
export function dayPlan(state, live = {}, { fits = () => true, nameOf = () => null, include = null } = {}) {
  const printers = Object.values(state.printers || {})
    .filter((p) => p.active && live[p.key]?.connected && (Number(live[p.key].amsSlots) || 0) > 0)
    .map((p) => {
      const l = live[p.key];
      const trays = (l.trays || []).filter((t) => t.ams !== "ext" && t.type);
      const set = trays.map((t) => ({ type: t.type, color: t.color || null, name: t.name || null, loaded: true, ams: t.ams, slot: t.slot, remain: t.remain ?? null, needed: false, grams: 0, plates: [] }));
      const printing = Object.values(state.plates || {}).find((x) => x.status === "printing" && x.printer === p.key);
      return { p, model: modelKey(p.model), slots: Number(l.amsSlots) || 4, set, minutes: printing ? Number(l.remainingMin || printing.minutes || 0) : 0, plates: [], unplanned: [] };
    });
  const byKey = Object.fromEntries(printers.map((x) => [x.p.key, x]));
  const printerOf = {};
  const order = (state.order || []).filter((pid) => state.plates?.[pid]?.status === "waiting" && (!include || include(pid)));
  for (const pid of order) {
    const plate = state.plates[pid];
    const needs = []; for (const f of plate.filaments || []) { if (!f.color) continue; if (!needs.some((n) => fam(n.type) === fam(f.type) && dist(n.color, f.color) <= CLOSE)) needs.push({ type: f.type || "PLA", color: f.color, grams: Number(f.grams) || 0 }); }
    const skip = !needs.length;
    // the same rule as the lines: a printer kept out of Fill, out of service or stopped takes no plate that has no printer of its
    // own. Without it, an operator was told to load a spool for a part the schedule had put on no printer at all.
    let cands = plate.printer && byKey[plate.printer] ? [byKey[plate.printer]] : printers.filter((pr) => fits(plate, pr.p) && !pr.p.fillOff && !pr.p.maintenance && !pr.p.stopped);
    if (!cands.length) continue;
    const info = (pr) => {
      const missing = skip ? [] : needs.filter((n) => !pr.set.some((e) => covers(e, n)));
      const free = pr.slots - pr.set.filter((e) => e.needed || !e.loaded).length;   // slots not yet claimed by today's set
      return { missing, fitsSlots: missing.length <= Math.max(0, free) };
    };
    cands = cands.map((pr) => ({ pr, ...info(pr) })).sort((a, b) => (a.missing.length - b.missing.length) || ((b.fitsSlots ? 1 : 0) - (a.fitsSlots ? 1 : 0)) || (a.pr.minutes - b.pr.minutes) || a.pr.p.key.localeCompare(b.pr.p.key));
    const pick = cands[0];
    if (!pick.fitsSlots) { pick.pr.unplanned.push(pid); continue; }   // more colours than the AMS holds: the per-plate loading list handles it
    for (const n of skip ? [] : needs) {
      const e = pick.pr.set.find((x) => covers(x, n));
      if (e) { e.needed = true; e.grams += n.grams; e.plates.push(pid); }
      else pick.pr.set.push({ type: n.type, color: n.color, name: nameOf(n.type, n.color) || null, loaded: false, ams: null, slot: null, remain: null, needed: true, grams: n.grams, plates: [pid] });
    }
    pick.pr.plates.push(pid); pick.pr.minutes += Number(plate.minutes) || 0; printerOf[pid] = pick.pr.p.key;
  }
  // where each new spool goes: an empty slot first, then the loaded spool nobody needs today with the least left on it
  const out = [];
  for (const pr of printers) {
    const used = new Set(pr.set.filter((e) => e.loaded).map((e) => `${e.ams}/${e.slot}`));
    const empty = []; for (let g = 0; g < pr.slots; g++) { const k = `${Math.floor(g / 4)}/${g % 4}`; if (!used.has(k)) empty.push({ ams: Math.floor(g / 4), slot: g % 4 }); }
    const spare = pr.set.filter((e) => e.loaded && !e.needed).sort((a, b) => (a.remain ?? 100) - (b.remain ?? 100));
    const loads = [];
    for (const e of pr.set.filter((x) => !x.loaded).sort((a, b) => b.grams - a.grams)) {
      const where = empty.shift() || spare.shift();
      if (!where) break;
      const firstPlate = e.plates.map((pid) => state.plates[pid]).sort((a, b) => (a._eta?.start || 0) - (b._eta?.start || 0))[0] || null;
      loads.push({ type: e.type, color: e.color, name: e.name || `${e.type} ${e.color}`, grams: Math.round(e.grams), ams: where.ams, slot: where.slot, empty: !where.type, replaces: where.type ? (where.name || nameOf(where.type, where.color) || where.color || where.type) : null, plates: e.plates.length, firstPlate: firstPlate ? { id: firstPlate.id, title: firstPlate.title } : null });
    }
    const keep = pr.set.filter((e) => e.loaded && e.needed).map((e) => ({ type: e.type, color: e.color, name: e.name || nameOf(e.type, e.color) || e.color, ams: e.ams, slot: e.slot, plates: e.plates.length }));
    out.push({ key: pr.p.key, name: pr.p.name, number: pr.p.number ?? null, model: pr.model, slots: pr.slots, plates: pr.plates.length, minutes: Math.round(pr.minutes), keep, loads, stillMissing: pr.set.filter((x) => !x.loaded).length - loads.length, unplanned: pr.unplanned.length, swaps: loads.filter((l) => !l.empty).length });
  }
  return { printerOf, printers: out.sort((a, b) => (a.number ?? 99) - (b.number ?? 99)) };
}
