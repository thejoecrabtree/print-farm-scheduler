// Goals are the plan.
//
// A goal set says what the week should look like, not where each plate goes:
//   goals = { mix: { category: percent }, targets: { sku: plates }, must: [{ sku, plates, by?, since? }], changes }
//   - mix: the balance of stock printing by category (the sliders),
//   - targets: plates wanted per selling toy (laid over the caller's demand rows),
//   - must: hard asks, optionally by a lab date ("4 crystal dragons by Friday"); `since` = when the ask was made, so plates printed
//     after it count towards it,
//   - changes: the colour-change budget per printer for one plan.
// The board is always the deterministic result of the goals + what has already started + what someone placed by hand.
//
//   previewGoals()  the would-be plan, no changes made (fast enough to run on every slider move)
//   applyGoals()    commit it: unstarted stock plates the goals no longer want are replaced; started, printing, done, custom,
//                   locked (hand-placed) and time-pinned plates are never touched
//   goalsFromText() words -> goals through a pluggable model call; the model writes GOALS, never slots
//   reviewPlan()    the plan checked against the goals and the history: warnings and notes in plain words
//   autoPlan()      plan from the standing goals, review, and apply by itself only when the review has no warnings
import * as filler from "./filler.mjs";
import * as categories from "./categories.mjs";
import { toyKey } from "./week.mjs";
import { fileQuality } from "./engine.mjs";
import { tzOf, labDate, dayDate, weekdayOf, atLab, clock, DAYS } from "./labtime.mjs";
import { clamp, iso } from "./util.mjs";

export const DEFAULT_CHANGES = 2;
export const MAX_PLATES = 40;
const SKU = /^[\w .\-·'&()+/]{1,60}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v, lo, hi) => clamp(Math.round(Number(v)), lo, hi);

// the goals in force: settings.goals over the category weights
export function standingGoals(settings = {}) {
  const g = settings?.goals || {};
  return {
    mix: categories.mixOf({ ...settings, mix: { ...(settings?.mix || {}), ...(g.mix || {}) } }),
    targets: g.targets && typeof g.targets === "object" ? { ...g.targets } : {},
    must: Array.isArray(g.must) ? g.must.map((m) => ({ ...m })) : [],
    changes: Number.isFinite(Number(g.changes)) ? int(g.changes, 0, 6) : DEFAULT_CHANGES,
  };
}

// Goals from anywhere (a slider, an API body, a model) are checked like any other input: known categories only, plates 0-40,
// a budget of 0-6, dates as YYYY-MM-DD. Whatever does not pass is left as it was in `base`.
export function cleanGoals(input, base = standingGoals()) {
  const g = { mix: { ...base.mix }, targets: { ...(base.targets || {}) }, must: (base.must || []).map((m) => ({ ...m })), changes: base.changes ?? DEFAULT_CHANGES };
  const src = input && typeof input === "object" ? input : {};
  if (src.mix && typeof src.mix === "object") for (const [k, v] of Object.entries(src.mix)) if (k in g.mix && Number.isFinite(Number(v))) g.mix[k] = int(v, 0, 100);
  if (src.targets === null) g.targets = {};
  else if (src.targets && typeof src.targets === "object") { const t = {}; for (const [k, v] of Object.entries(src.targets)) if (SKU.test(k) && Number.isFinite(Number(v))) t[k] = int(v, 0, MAX_PLATES); g.targets = t; }
  if (src.must === null) g.must = [];
  else if (Array.isArray(src.must)) {
    g.must = src.must.filter((m) => m && SKU.test(String(m.sku || "")) && Number(m.plates) > 0).slice(0, 20)
      .map((m) => ({ sku: String(m.sku), plates: int(m.plates, 1, MAX_PLATES), ...(DATE.test(String(m.by || "")) ? { by: m.by } : {}), ...(Number.isFinite(Date.parse(m.since || "")) ? { since: new Date(Date.parse(m.since)).toISOString() } : {}) }));
  }
  if (src.changes != null && Number.isFinite(Number(src.changes))) g.changes = int(src.changes, 0, 6);
  return g;
}

// ---- the catalogue: one entry per toy (its files share a sku, or a toy id, or a name)
const skuOf = (f) => String(f.sku || f.toy || toyKey(f.name));
export function catalogOf(files) {
  const toys = new Map();
  for (const f of files || []) {
    if (!f.sliced || !f.category) continue;
    const k = skuOf(f); const t = toys.get(k) || { sku: k, name: toyKey(f.name).replace(/^\w/, (c) => c.toUpperCase()), category: f.category, fileIds: [], models: [] };
    if (f.toyName) t.name = f.toyName;
    t.fileIds.push(f.id); if (f.model && !t.models.includes(f.model)) t.models.push(f.model);
    toys.set(k, t);
  }
  return [...toys.values()];
}
// the shortest sliced file of a toy (the one a demand row prints)
function fileFor(files, sku) { return (files || []).filter((f) => f.sliced && skuOf(f) === sku).sort((a, b) => (a.minutes || 1e9) - (b.minutes || 1e9))[0] || null; }

// The planner's rows for a goal set: the caller's demand rows (what sells) with goals.targets laid over them, plus a row for any
// target the demand did not have; and the must-haves. Rows: [{ sku, name, plates, file: { id }, by?, since? }].
export function demandRows(files, goals, base = []) {
  const name = (sku) => catalogOf(files).find((x) => x.sku === sku)?.name || sku;
  const demand = (base || []).map((r) => ({ ...r }));
  for (const r of demand) if (goals?.targets?.[r.sku] != null) r.plates = goals.targets[r.sku];
  for (const [sku, n] of Object.entries(goals?.targets || {})) if (n > 0 && !demand.some((r) => r.sku === sku)) { const f = fileFor(files, sku); demand.push({ sku, name: name(sku), plates: n, file: f ? { id: f.id } : null }); }
  const must = (goals?.must || []).map((m) => { const f = fileFor(files, m.sku); return { sku: m.sku, name: name(m.sku), plates: m.plates, file: f ? { id: f.id } : null, ...(m.by ? { by: m.by } : {}), ...(m.since ? { since: m.since } : {}) }; });
  return { demand: demand.filter((r) => (r.plates || 0) > 0), must };
}

// Plan the lines for a goal set. replace = true (Preview / Apply): the unpinned, not started stock plates are planned away first and
// kept only where the new plan prints the same toy on the same printer.
export function planGoals({ state, files, goals = standingGoals(state?.settings), live = {}, t = Date.now(), demand = [], replace = true, build = null, only = null, max = 400 } = {}) {
  const rows = demandRows(files, goals, demand);
  return filler.plan(state, files, { build, t, live, settings: state.settings || {}, demand: rows.demand, must: rows.must, mix: goals.mix, maxChanges: goals.changes, replace, only, max });
}

// The preview: the same plan, dry, with the numbers a goals panel shows. Nothing in `state` changes.
export function previewGoals(opts = {}) {
  const t0 = performance.now();
  const plan = planGoals(opts);
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  const byCategory = {};
  for (const a of plan.add) byCategory[a.category || "other"] = (byCategory[a.category || "other"] || 0) + a.plates.length;
  const stats = { kept: plan.keep.length, added: plan.add.reduce((n, a) => n + a.plates.length, 0), removed: plan.remove.length, minutes: plan.add.reduce((n, a) => n + (Number(a.minutes) || 0), 0), changes: Object.values(plan.lines).reduce((n, l) => n + (l.changes || 0), 0), byCategory };
  return { plan, stats, ms };
}

// Apply: commit a plan made by planGoals / previewGoals, and keep the goals as the standing ones. Mutates `state` (the caller saves).
export function applyGoals(state, plan, files, goals, { by = "operator", t = Date.now(), newId } = {}) {
  const r = filler.applyPlan(state, plan, files, { by, t, newId });
  state.settings ||= {};
  state.settings.goals = { mix: { ...goals.mix }, targets: { ...(goals.targets || {}) }, must: (goals.must || []).map((m) => ({ ...m })), changes: goals.changes };
  state.settings.mix = { ...goals.mix };
  return { ...r, kept: plan.keep.length };
}

// ---- words -> goals
// The model writes goals, never slots. `proposeGoals(text, catalog)` is any async function returning { mix, targets, must, notes }:
//   mix: { categorySlug: percent }, targets: { toyName: plates }, must: [{ toy: toyName, plates, by?: "Friday" | "YYYY-MM-DD" }]
// `catalog` = { categories: [{ slug, label, weight }], toys: [{ sku, name, category }], current: { mix, targets, changes }, today, weekday }.
// The model names toys by NAME; they are mapped to skus here, loosely (case, punctuation). Unknown names are dropped and reported.
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function resolveDay(by, t, tz) {
  const s = norm(by);
  if (!s) return null;
  if (DATE.test(String(by).trim())) return String(by).trim();
  const today = labDate(t, tz);
  if (s === "today") return today;
  if (s === "tomorrow") return dayDate(today, 1);
  const wd = DAYS.findIndex((d) => s.startsWith(d.toLowerCase()));
  if (wd < 0) return null;
  return dayDate(today, (wd - weekdayOf(t, tz) + 7) % 7);   // the next such day, today included
}
export function catalogForModel(files, settings = {}, t = Date.now()) {
  const current = standingGoals(settings); const tz = tzOf(settings);
  const toys = catalogOf(files);
  return {
    categories: categories.categoriesOf(settings).map((c) => ({ slug: c.slug, label: c.label, weight: current.mix[c.slug] ?? c.weight })),
    toys: toys.map((x) => ({ sku: x.sku, name: x.name, category: x.category })),
    current: { mix: current.mix, targets: Object.fromEntries(Object.entries(current.targets).map(([sku, n]) => [toys.find((x) => x.sku === sku)?.name || sku, n])), changes: current.changes },
    today: labDate(t, tz), weekday: DAYS[weekdayOf(t, tz)],
  };
}
export async function goalsFromText(text, { proposeGoals, files, settings = {}, t = Date.now() } = {}) {
  if (typeof proposeGoals !== "function") throw new Error("goalsFromText needs proposeGoals(text, catalog)");
  const words = String(text || "").trim().slice(0, 400);
  if (!words) throw new Error("say what you want");
  const tz = tzOf(settings);
  const current = standingGoals(settings);
  const catalog = catalogForModel(files, settings, t);
  const raw = (await proposeGoals(words, catalog)) || {};
  const dropped = [];
  const find = (name) => { const n = norm(name); if (!n) return null; return catalog.toys.find((x) => norm(x.sku) === n || norm(x.name) === n) || catalog.toys.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name))) || null; };
  const targets = {};
  for (const [k, v] of Object.entries(raw.targets && typeof raw.targets === "object" ? raw.targets : {})) { const hit = find(k); if (hit) targets[hit.sku] = v; else dropped.push(k); }
  const must = [];
  for (const m of Array.isArray(raw.must) ? raw.must : []) {
    const hit = find(m?.toy ?? m?.sku ?? m?.name); if (!hit) { dropped.push(String(m?.toy ?? m?.name ?? "?")); continue; }
    const by = m.by ? resolveDay(m.by, t, tz) : null;
    must.push({ sku: hit.sku, plates: m.plates, ...(by ? { by } : {}), since: iso(t) });
  }
  const goals = cleanGoals({ mix: raw.mix, targets: { ...current.targets, ...targets }, must: must.length ? must : undefined, changes: raw.changes }, current);
  return { goals, notes: String(raw.notes || "").slice(0, 200), dropped };
}

// ---- the review
// Before a plan runs by itself, it is checked against the goals and the history. A "warn" needs someone; an "info" is worth knowing.
export function reviewPlan(plan, goals, { state, files = [], settings = state?.settings || {} } = {}) {
  const tz = tzOf(settings);
  const findings = [];
  const warn = (text) => findings.push({ level: "warn", text });
  const info = (text) => findings.push({ level: "info", text });
  const kept = (plan.keep || []).map((pid) => state?.plates?.[pid]).filter(Boolean);
  const placedOf = (row, kind) => plan.add.filter((a) => a.kind === kind && a.fileId === row.fileId).length + kept.filter((p) => p.file?.id === row.fileId).length;
  // the must-haves: all of them, in time
  for (const row of plan.must || []) {
    if (row.skipped) { warn(`${row.name}: a must-have, but ${row.skipped}`); continue; }
    const want = Math.max(0, (row.plates || 0) - (row.onLines || 0));
    const placed = placedOf(row, "must");
    if (placed < want) warn(`${row.name}: only ${placed} of ${want} must-have plates fit in the next ${plan.days} days`);
    if (row.by) {
      const deadline = atLab(dayDate(row.by, 1), "00:00", tz);
      const late = plan.add.filter((a) => a.kind === "must" && a.fileId === row.fileId && a.end > deadline);
      if (late.length) warn(`${row.name}: ${late.length} plate${late.length === 1 ? "" : "s"} would finish after ${row.by} (the last ${clock(Math.max(...late.map((a) => a.end)), tz)})`);
    }
  }
  // what sells: a target with nothing planned is a warning, a partly covered one a note (three days rarely hold a whole target)
  for (const row of plan.demand || []) {
    if (row.skipped) { warn(`${row.name}: ${row.plates} wanted, but ${row.skipped}`); continue; }
    const want = Math.max(0, (row.plates || 0) - (row.onLines || 0)); if (!want) continue;
    const placed = placedOf(row, "demand");
    if (!placed) warn(`${row.name}: ${want} plate${want === 1 ? "" : "s"} wanted, none planned`);
    else if (placed < want) info(`${row.name}: ${placed} of ${want} wanted plates in the next ${plan.days} days`);
  }
  // a toy whose last two prints failed or were graded badly
  const names = new Map((files || []).map((f) => [f.id, f.name]));
  for (const fid of new Set(plan.add.map((a) => a.fileId))) if (state && fileQuality(state, fid).badStreak) warn(`${names.get(fid) || `file ${fid}`}: its last two prints failed or were graded badly - check it before it runs again`);
  // what did not land, and why. Only asked-for jobs count: select() offers more stock than fits on purpose (the lines' horizon is
  // the real limit), so a stock job left out is normal.
  const asked = plan.unplaced.filter((u) => u.kind === "must" || u.kind === "demand");
  const budget = asked.filter((u) => /budget/.test(u.why));
  if (budget.length) info(`${budget.length} asked-for job${budget.length === 1 ? "" : "s"} left out because the colour-change budget (${plan.budget}) was spent`);
  for (const u of asked.filter((x) => !/budget/.test(x.why)).slice(0, 5)) info(`${u.name}: ${u.why}`);
  for (const s of plan.skipped || []) info(`${s.printer}: not filled - ${s.why}`);
  if (!plan.add.length && !plan.keep.length && Object.values(plan.lines || {}).some((l) => l.full === false)) warn("nothing could be planned although some lines have room");
  // the mix, once there are enough plates to judge it
  const count = {}; let total = 0;
  for (const a of plan.add) if (a.kind === "stock") { count[a.category] = (count[a.category] || 0) + 1; total++; }
  if (total >= 12) {
    const wsum = Object.values(goals.mix || {}).reduce((a, b) => a + b, 0) || 100;
    for (const [cat, w] of Object.entries(goals.mix || {})) { const want = (100 * w) / wsum, got = (100 * (count[cat] || 0)) / total; if (w > 0 && Math.abs(got - want) > 15) info(`${cat}: ${Math.round(got)} % of the stock jobs, the goal is ${Math.round(want)} %`); }
  }
  findings.sort((a, b) => (a.level === "warn" ? 0 : 1) - (b.level === "warn" ? 0 : 1));
  const warnings = findings.filter((f) => f.level === "warn").length;
  return { findings, warnings, summary: warnings ? `${warnings} thing${warnings === 1 ? "" : "s"} to look at before this runs` : "no warnings" };
}

// ---- the weekly auto-plan
// Monday shortly after midnight the week plans itself from the standing goals, reviews itself, and applies itself when the review
// has no warnings. With a warning it stays a preview and someone decides.
export function autoPlanDue(t, { lastRunDay = null, settings = {}, at = "00:05" } = {}) {
  const tz = tzOf(settings); const today = labDate(t, tz);
  return weekdayOf(t, tz) === 0 && lastRunDay !== today && t >= atLab(today, at, tz);
}
export function autoPlan({ state, files, live = {}, t = Date.now(), demand = [], build = null, by = "auto", newId } = {}) {
  const goals = standingGoals(state.settings);
  const { plan, stats, ms } = previewGoals({ state, files, goals, live, t, demand, build, replace: true });
  const review = reviewPlan(plan, goals, { state, files });
  let applied = null;
  if (!review.warnings) applied = applyGoals(state, plan, files, goals, { by, t, newId });
  return { applied: !!applied, result: applied, review, plan, stats, ms, goals };
}
