// WHAT to print. select() turns the library, the goals and the history into an ordered list of jobs; the filler (filler.mjs) then
// decides WHERE and WHEN each job goes on the printer lines. Splitting the two is the point: the "what" is a policy you can
// explain in one sentence, the "where" is a cost function you can test.
//
// The order select() produces:
//   1. must-haves (goals.must: "4 crystal dragons by Friday"), one plate of each per round,
//   2. what sells (demand rows / goals.targets), one plate of each per round,
//   3. a balanced mix by category weight (goals.mix): at every step the category furthest below its weight, and inside it every
//      toy once before any twice, never-printed before recently printed, then the least printed.
import { modelKey, fam } from "./util.mjs";
import * as categories from "./categories.mjs";
import { dist as colourDist, CLOSE } from "./dayplan.mjs";

// AMS slots per printer model, used when a printer is not on the network right now
export const DEFAULT_SLOTS = { P1S: 4, P2S: 4, X1C: 4, H2S: 4, H2D: 8, H2C: 8, A1: 4, A1MINI: 4 };
// select() counts printer time in rough "slots" of up to this many minutes; the filler hands it one slot per free hour, so select
// over-offers and the lines' horizon is the real limit
export const SLOT_MINUTES = 600;

// ---- colours
export const same = (a, b) => fam(a.type) === fam(b.type) && !!a.color && !!b.color && colourDist(a.color, b.color) <= CLOSE;
export function coloursOf(file) {
  const out = [];
  for (const f of file?.filaments || []) { if (!f?.color) continue; const c = { type: fam(f.type), color: f.color }; if (!out.some((x) => same(x, c))) out.push(c); }
  return out;
}

// ---- the toy behind a file or a plate
// One toy can have several files (sliced for two printer models, re-sliced after a fix) and many plates. The toy is file.toy or
// file.sku when the library has one, else the name with the model, copies and "plate n of m" stripped. Done plates keep the file id
// they were sliced from and a re-sliced toy gets a new id, so names matter too.
const MODEL_SUFFIX = /\s*(x\d+)?\s*·\s*(P1S|P1P|P2S|X1C|X1E|H2S|H2D|H2C|A1 ?MINI|A1)\s*$/i;
export const toyKey = (s) => String(s || "").replace(/\.gcode\.3mf$/i, "").replace(/\s*·\s*plate\s+\d+\s+of\s+\d+\s*$/i, "").replace(MODEL_SUFFIX, "").replace(/\s*x\d+\s*$/i, "").replace(/\s*\(all plates\)\s*$/i, "").trim().toLowerCase();

// ---- jobs
// A job is one file printed once: one plate, or a set of plates (a multi-plate file) that should run back to back on one printer.
// job = { fileId, sku, name, model, category, minutes, grams, colours, plates: [{ index, name, minutes, grams, colours }], setOf, kind }
export function jobFromFile(file, kind = "stock") {
  const plates = (file.plates || []).length > 1
    ? file.plates.map((pl) => ({ index: pl.index, name: pl.name || null, minutes: Number(pl.minutes) || Number(file.minutes) || 60, grams: Number(pl.grams) || 0, colours: (pl.filaments || []).length ? coloursOf({ filaments: pl.filaments }) : coloursOf(file) }))
    : [{ index: 1, name: null, minutes: Number(file.minutes) || 60, grams: Number(file.grams) || 0, colours: coloursOf(file) }];
  return { fileId: file.id, sku: file.sku ?? null, name: String(file.name || "").replace(/\.gcode\.3mf$/i, ""), model: modelKey(file.model) || "P2S", category: file.category || null, minutes: plates.reduce((a, p) => a + p.minutes, 0), grams: plates.reduce((a, p) => a + p.grams, 0), colours: coloursOf(file), plates, setOf: plates.length, kind, toy: file.toy || file.sku || null };
}
// A toy printed inside this many days is "recent": it goes to the back of its category. A stock week should be new prints, not the
// same few toys again.
export const RECENT_DAYS = 14;
// only TOYS plan themselves: a file with no toy category (a jig, a spare part, a tool) is a manual part, dropped in by hand
export function isToyFile(f) { return !!(f && f.category && f.category !== "other" && f.category !== "tools"); }

const ON_LINES = new Set(["waiting", "hold", "printing", "finished"]);

// files: the library ([{ id, name, sku?, toy?, model, category, sliced, minutes, grams, filaments, plates, printCount?, flag? }])
// opts: mix (category weights; default the settings' mix), slotsByModel ({ P2S: n } - printer time on offer per model), demand and
//       must rows ([{ sku, name, plates, file: { id }, by?, since? }]), t, recentDays
export function select(files, state, { mode = "demand", mix = null, slotsByModel = {}, demand = [], must = [], t = Date.now(), recentDays = RECENT_DAYS } = {}) {
  const settings = state?.settings || {};
  const weights = mix || categories.mixOf(settings);
  const off = new Set((settings.repeatOff || []).map(String));   // files someone took out of automatic planning
  const plates = Object.values(state?.plates || {});
  const toyOf = (f) => f.toy || f.sku || toyKey(f.name);
  const toyIds = {}; const toyNames = {}; for (const f of files || []) { (toyIds[toyOf(f)] ||= new Set()).add(f.id); toyNames[toyOf(f)] = toyKey(f.name); }
  const isToy = (p, f) => { const ids = toyIds[toyOf(f)] || new Set([f.id]); return (p.file?.id != null && ids.has(p.file.id)) || toyKey(p.file?.name || p.title) === toyNames[toyOf(f)]; };
  // printed by the farm: its own history plus the library's print count; the same toy on another printer model counts
  const since = t - recentDays * 86_400_000;
  const printedOf = (f) => plates.filter((p) => p.status === "done" && !p.outcome?.wasFailed && isToy(p, f)).length + (Number(f.printCount) || 0);
  // recent = printed fine, printing or on the bed inside the window (a failed print is not stock)
  const recentOf = (f) => plates.filter((p) => isToy(p, f) && ((p.status === "done" && !p.outcome?.wasFailed) || p.status === "printing" || p.status === "finished") && Date.parse(p.closedAt || p.finishedAt || p.startedAt || 0) >= since).length;
  const queuedOf = (f) => plates.filter((p) => p.file?.id === f.id && ["waiting", "hold", "printing"].includes(p.status)).length;
  // plates of the toy already on the lines (and, for a must with `since`, printed fine since the goal was set): a target counts
  // them, so a fill that runs every few minutes does not add the same target again
  const onLinesOf = (f, sinceIso) => plates.filter((p) => isToy(p, f) && (ON_LINES.has(p.status) || (sinceIso && p.status === "done" && !p.outcome?.wasFailed && Date.parse(p.closedAt || 0) >= Date.parse(sinceIso)))).length;
  // a file with a bad streak (`flag`: failed or graded badly twice in a row) waits for someone to look at it
  const cands = (files || []).filter((f) => f.sliced && !off.has(String(f.id)) && !f.flag && isToyFile(f) && (slotsByModel[modelKey(f.model) || "P2S"] || 0) > 0)
    .map((f) => ({ file: f, job: jobFromFile(f), load: printedOf(f) + queuedOf(f), recent: recentOf(f), planned: 0 }));
  const left = { ...slotsByModel };
  const jobs = [];
  const slotsNeeded = (job) => job.plates.reduce((a, p) => a + Math.max(1, Math.ceil(p.minutes / SLOT_MINUTES)), 0);
  const takeOne = (c, kind, extra = {}) => { const n = slotsNeeded(c.job); if ((left[c.job.model] || 0) < n) return false; left[c.job.model] -= n; c.planned++; jobs.push({ ...c.job, kind, ...extra }); return true; };

  // Rows go in TURNS: one plate of each wanted toy per round, in the rows' order, until each has its plates. Taken toy by toy, a
  // "keep 6 plates" target put six of one toy at the head of the list, the filler's look-ahead saw nothing else, and one printer
  // printed the same toy six times in a row.
  const turns = (list, kind, out) => {
    const rows = [];
    for (const s of list || []) {
      const c = s.file ? cands.find((x) => x.file.id === s.file.id) : null;
      if (!c) { out.push({ sku: s.sku, name: s.name, plates: s.plates, skipped: s.file ? "no fitting printer" : "needs slicing", ...(s.by ? { by: s.by } : {}) }); continue; }
      const already = onLinesOf(c.file, s.since);
      const row = { sku: s.sku, name: s.name, plates: s.plates, fileId: c.file.id, onLines: already, added: 0, ...(s.by ? { by: s.by } : {}) };
      out.push(row);
      const want = Math.max(0, (Number(s.plates) || 0) - already);
      if (want > 0) rows.push({ c, row, want, open: true });
    }
    for (let more = true; more;) {
      more = false;
      for (const r of rows) {
        if (!r.open || r.row.added >= r.want) continue;
        if (takeOne(r.c, kind, r.row.by ? { by: r.row.by } : {})) { r.row.added++; more = true; } else r.open = false;   // its model is full: this toy stops, the others go on
      }
    }
  };
  const mustRows = []; const demandRows = [];
  if (mode !== "stock") { turns(must, "must", mustRows); turns(demand, "demand", demandRows); }

  // the balance: at every step the category furthest below its weight, then the toy with the least printed + queued + planned
  const byCat = {}; for (const j of jobs) byCat[j.category] = (byCat[j.category] || 0) + 1;
  let guard = 0;
  while (guard++ < 5000) {
    const total = jobs.length;
    const open = cands.filter((c) => (left[c.job.model] || 0) >= slotsNeeded(c.job) && (weights[c.job.category] ?? 0) > 0);
    if (!open.length) break;
    const cats = [...new Set(open.map((c) => c.job.category))];
    cats.sort((a, b) => ((weights[b] || 0) * (total + 1) / 100 - (byCat[b] || 0)) - ((weights[a] || 0) * (total + 1) / 100 - (byCat[a] || 0)));
    const cat = cats[0];
    // every toy once before any twice; never printed before recently printed; then the least printed; then the shortest
    const pick = open.filter((c) => c.job.category === cat).sort((a, b) => a.planned - b.planned || (a.recent > 0 ? 1 : 0) - (b.recent > 0 ? 1 : 0) || a.load - b.load || a.job.minutes - b.job.minutes || String(a.file.id).localeCompare(String(b.file.id), "en", { numeric: true }))[0];
    if (!takeOne(pick, "stock")) break;
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  return { jobs, must: mustRows, demand: demandRows, weights, byCategory: byCat, recentSkipped: cands.filter((c) => c.recent > 0 && c.planned === 0).map((c) => c.job.name) };
}

// ---- variety
// "Avoid repeating jobs across printers at the same time, or on one printer one after another - we want variety, unless told
// otherwise." Two costs, not two bans, so the lines still fill when there is nothing else to print. SAME_TIME = the same toy on
// another printer at an overlapping time; BACK_TO_BACK = the same toy again straight after itself on one printer. The plates of
// ONE job (a set) are meant to be consecutive: only separate jobs of the same toy count. Off with settings.variety = false, or per
// job with job.sameOk (a repeat job told to run as a block).
export const SAME_TIME_COST = 220, BACK_TO_BACK_COST = 160;
