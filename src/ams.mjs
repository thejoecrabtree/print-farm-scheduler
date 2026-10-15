// Matching a plate's filaments to the spools a printer has loaded in its AMS (Bambu's automatic material system: four spool slots
// per unit, more with more units). Pure functions over a `live` printer status:
//   live = { connected, amsSlots, trays: [{ ams, slot, type, color: "#RRGGBB", name?, remain? (percent), unknown?, off? }] }
// `ams: "ext"` is the external spool holder. `unknown` is a loaded spool whose type nobody has set (no RFID tag): it cannot be mapped.
import { fam } from "./util.mjs";

// ---- colour distance
// Perceptual, not RGB. Plain RGB distance sent a pastel pink to the WHITE slot: in RGB a pale pink sits nearer white than a hot
// pink. This is CIE Lab ΔE (the same units for every hue) plus two rules anyone applies without thinking:
//   - a coloured target never goes to a neutral spool (white / grey / black) while a coloured one exists, and a neutral target
//     never goes to a coloured spool;
//   - between coloured spools the HUE decides first (pink stays pink, yellow stays yellow), lightness second.
// Scale: 0 = same, under 80 = the same colour, give or take a shade, over 80 = a different colour.
function lab(hex) {
  const p = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(p(1)), g = lin(p(3)), b = lin(p(5));
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(y) - 16, A = 500 * (f(x) - f(y)), B = 200 * (f(y) - f(z));
  return { L, A, B, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
export const COLOUR_OFF = 80;
export function colorDist(a, b) {
  if (!a || !b || !/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return 999;
  const p = lab(a), q = lab(b);
  const dE = Math.hypot(p.L - q.L, p.A - q.A, p.B - q.B);
  const NEUTRAL = 12;
  const pn = p.C < NEUTRAL, qn = q.C < NEUTRAL;
  if (pn !== qn) return Math.min(400, 2.5 * dE + 120);                        // colour vs neutral: never the best while any alternative exists
  if (pn && qn) return 2.5 * dE;                                               // white / grey / black among themselves: lightness only
  const dh = Math.min(Math.abs(p.h - q.h), 360 - Math.abs(p.h - q.h));         // hue first, then the rest
  return Math.min(400, 1.5 * dE + 1.2 * dh);
}

// loaded trays of the right material for one needed filament
function typeMatches(need, trays) {
  return (trays || []).filter((t) => !t.off && !t.unknown && t.type && (!need.type || t.type === need.type || (need.type.startsWith("PLA") && t.type.startsWith("PLA"))));
}
// The best loaded tray: same material, closest colour. `strict` = the colour must be close; otherwise the closest colour of the
// right material will do (colour is a preference, material is not).
export function trayMatch(need, trays, strict = true) {
  let best = null, bd = 999;
  for (const t of typeMatches(need, trays)) { const d = need.color && t.color ? colorDist(need.color, t.color) : 60; if (d < bd) { bd = d; best = t; } }
  if (!best) return null;
  return strict && bd > COLOUR_OFF ? null : { tray: best, dist: bd, colorOff: bd > COLOUR_OFF };
}

// One tray per needed colour. A crab with an orange body and a yellow hat once had both colours mapped to the yellow slot and
// printed in one colour: if a file specifies two colours, two slots are used, never one slot for both. Needs with the same colour
// share a tray; different colours never do. The assignment with the smallest total colour distance wins (a tiny search: at most
// 8 needs over at most 16 trays). Returns { byNeed: [tray | null …], missing: [need …], groups }.
export function trayAssign(needs, trays) {
  const groups = []; const idx = [];
  for (const n of needs) { const k = `${fam(n.type)}|${String(n.color || "").toLowerCase()}`; let g = groups.findIndex((x) => x.k === k); if (g < 0) { g = groups.length; groups.push({ k, need: n }); } idx.push(g); }
  const cands = groups.map((g) => typeMatches(g.need, trays).map((t) => ({ t, d: g.need.color && t.color ? colorDist(g.need.color, t.color) : 60 })).sort((a, b) => a.d - b.d));
  // stage 1: a colour that is loaded (a close match) keeps its spool - closest pairs first, each spool once - so a near-exact
  // yellow is never handed to orange just to make the sums work
  const byGroup = groups.map(() => null); const used = new Set();
  const pairs = cands.flatMap((cs, gi) => cs.filter((c) => c.d <= COLOUR_OFF).map((c) => ({ gi, ...c }))).sort((a, b) => a.d - b.d);
  for (const pr of pairs) { const key = `${pr.t.ams}/${pr.t.slot}`; if (byGroup[pr.gi] || used.has(key)) continue; byGroup[pr.gi] = pr.t; used.add(key); }
  // stage 2: the rest take the closest spools still free, one each, cheapest total; a colour left over is missing
  const rest = groups.map((g, i) => i).filter((i) => !byGroup[i]);
  let best = null;
  const go = (k, usedNow, pick, cost) => {
    if (best && cost >= best.cost) return;
    if (k === rest.length) { best = { cost, pick: [...pick] }; return; }
    let any = false;
    for (const c of cands[rest[k]]) { const key = `${c.t.ams}/${c.t.slot}`; if (usedNow.has(key)) continue; any = true; usedNow.add(key); pick.push(c.t); go(k + 1, usedNow, pick, cost + c.d); pick.pop(); usedNow.delete(key); }
    if (!any) { pick.push(null); go(k + 1, usedNow, pick, cost + 1000); pick.pop(); }
  };
  go(0, new Set(used), [], 0);
  if (best) rest.forEach((gi, k) => { byGroup[gi] = best.pick[k]; });
  return { byNeed: idx.map((g) => byGroup[g]), missing: groups.filter((g, i) => !byGroup[i]).map((g) => g.need), groups: groups.length };
}

// Can this plate print on this printer with what is loaded? "ok" = the right MATERIAL is loaded for every filament the slice needs,
// each colour on its own spool. Colour is a preference: a different colour of the same material still prints (colorOff says so).
export function filamentCheck(plate, l) {
  const needs = plate.filaments || [];
  if (!needs.length) return null;
  // the printer has an AMS with nothing in it: that is a known "no", not an unknown
  if (!l?.trays?.length && (l?.amsSlots || 0) > 0) return { known: true, ok: false, missing: needs.map((n) => `${n.type || "?"} ${n.color || ""}`.trim()), low: false, amsEmpty: true };
  if (!l?.trays?.length) return { known: false, ok: null, missing: [], low: false };
  const asg = trayAssign(needs, l.trays);
  const matchOf = (i) => { const t = asg.byNeed[i]; if (!t) return null; const d = needs[i].color && t.color ? colorDist(needs[i].color, t.color) : 60; return { tray: t, dist: d, colorOff: d > COLOUR_OFF }; };
  const missing = needs.filter((n, i) => !asg.byNeed[i]);
  const colorOff = needs.map((n, i) => ({ n, m: matchOf(i) })).filter((x) => x.m?.colorOff).map(({ n, m }) => ({ wanted: n.color, got: m.tray.color, type: m.tray.type, name: m.tray.name || "" }));
  const unknownTrays = l.trays.filter((t) => t.unknown).length;
  if (missing.length && unknownTrays && !l.trays.some((t) => !t.unknown)) {
    return { known: true, ok: false, missing: missing.map((n) => `${n.type || "?"} ${n.color || ""}`.trim()), low: false, unknownTrays, why: "the loaded spools have no type set - set the material and colour on the printer screen" };
  }
  const typed = (l.trays || []).filter((t) => !t.off && !t.unknown && t.type).length;
  const why = missing.length && asg.groups > typed ? `${asg.groups} colours needed, ${typed} spools loaded - each colour needs its own slot` : undefined;
  // spool truth from the printer: a tagged spool reports remaining %, so we can say whether this plate (and how many more like
  // it) fit on what is loaded. Sizing only, never a block.
  let low = false, platesLeft = null;
  for (const [i, n] of needs.entries()) {
    const m = matchOf(i); if (!m) continue;
    const gramsLeft = m.tray.remain != null ? (m.tray.remain / 100) * (m.tray.weightG || 1000) : Number.isFinite(m.tray.grams) ? m.tray.grams : null;
    if (gramsLeft == null) continue;
    const need = Number(n.grams || plate.grams || 0);
    if (need > 0) { const k = Math.floor(gramsLeft / need); platesLeft = platesLeft == null ? k : Math.min(platesLeft, k); if (gramsLeft < need * 1.1) low = true; }
  }
  // how close the loaded colours are, per filament (0 = exact), so a caller can pick the printer whose spools come closest
  const picks = needs.map((n, i) => { const m = matchOf(i); return m ? { wanted: n.color, got: m.tray.color, name: m.tray.name || "", type: m.tray.type, dist: Math.round(m.dist), slot: m.tray.ams === "ext" ? "ext" : `AMS ${Number(m.tray.ams) + 1} slot ${Number(m.tray.slot) + 1}` } : null; }).filter(Boolean);
  const fit = picks.length ? Math.round(picks.reduce((a, x) => a + x.dist, 0) / picks.length) : null;
  return { known: true, ok: missing.length === 0, missing: missing.map((n) => `${n.type || "?"} ${n.color || ""}`.trim()), low, platesLeft, colorOff: colorOff.length ? colorOff : null, fit, picks, ...(why ? { why } : {}) };
}
// 3 = every colour loaded, 1-3 = right material with some colours off (closer is better), 0 = unknown, -1 = cannot print here
export function filamentScore(plate, l) {
  const c = filamentCheck(plate, l);
  if (!c || !c.known) return 0;
  if (!c.ok) return -1;
  if (!c.colorOff) return 3;
  return 3 - Math.min(2, (c.fit ?? 120) / 120);
}

// ---- the AMS mapping sent with a start
// For each filament slot in the slice, the global tray id (ams * 4 + slot; the external spool is 254). Bambu's mapping is indexed
// by the PROJECT's filament slots, not by the filaments this plate happens to use: plate 3 of a project that uses slot 2 only must
// send [-1, <tray>, -1, -1]. Sending [<tray>] told the printer "slot 1 -> tray", left slot 2 unmapped, and the print stopped with
// "failed to get the AMS mapping". Plates carry `slot` per filament and `projectSlots`.
export function expandMapping(plate, perNeed) {
  const needs = plate.filaments || [];
  if (!perNeed || perNeed.length !== needs.length || !needs.every((n) => n.slot != null)) return perNeed;
  const n = Math.max(plate.projectSlots || 0, ...needs.map((x) => Number(x.slot) || 0)); if (!n) return perNeed;
  const map = Array(n).fill(-1); needs.forEach((need, i) => { map[Number(need.slot) - 1] = perNeed[i]; }); return map;
}
// a colour without a tray of its own = no automatic mapping (and no automatic start: the loading list says what to put in)
export function autoMapping(plate, l) {
  const needs = plate.filaments || [];
  if (!needs.length || !l?.trays?.length) return null;
  const map = trayAssign(needs, l.trays).byNeed.map((t) => (!t ? null : t.ams === "ext" ? 254 : Number(t.ams) * 4 + Number(t.slot)));
  return map.every((x) => x != null) ? expandMapping(plate, map) : null;
}

// Spool watch DURING a print. Two plates passed the start check and died hours later at a colour change, when the slot they still
// needed read empty or lost its type. So the check keeps running while the plate prints: for every filament the plate needs, is the
// tray it is mapped to still there, typed, and not about to run out? Returns [{ i, need, tray, ams, slot, why }], empty when fine.
export function spoolCheck(plate, l) {
  const needs = plate?.filaments || []; const trays = l?.trays || [];
  if (!needs.length || !l?.connected) return [];
  const map = Array.isArray(plate.amsMapping) && plate.amsMapping.length ? plate.amsMapping : null;
  const projectIndexed = !!map && needs.every((n) => n.slot != null) && map.length >= Math.max(...needs.map((n) => Number(n.slot) || 0));
  const out = [];
  needs.forEach((need, i) => {
    const tid = map ? Number(projectIndexed ? map[Number(need.slot) - 1] : map[i]) : NaN;
    const label = `${need.color || ""}${need.type ? ` ${need.type}` : ""}`.trim() || "filament";
    if (Number.isFinite(tid) && tid >= 0 && tid < 254) {
      const ams = Math.floor(tid / 4), slot = tid % 4;
      const t = trays.find((x) => x.ams !== "ext" && Number(x.ams) === ams && Number(x.slot) === slot);
      if (!t) out.push({ i, need: label, tray: tid, ams, slot, why: "reads empty" });
      else if (t.unknown || !t.type) out.push({ i, need: label, tray: tid, ams, slot, why: "has no type set" });
      else if (t.remain != null && t.remain >= 0 && t.remain <= 3) out.push({ i, need: label, tray: tid, ams, slot, why: `is nearly empty (${t.remain} %)` });
      return;
    }
    if (Number.isFinite(tid) && tid === 254) return;   // the external spool: nothing to read
    // no mapping saved (the printer chose): is there still SOME loaded, typed spool of that material?
    if (!trays.some((x) => x.type && !x.unknown && !x.off) && (l?.amsSlots || 0) > 0) { out.push({ i, need: label, tray: null, ams: null, slot: null, why: "has no loaded spool left" }); return; }
    if (!trayMatch(need, trays.filter((x) => !x.off), false)) out.push({ i, need: label, tray: null, ams: null, slot: null, why: "has no loaded spool of that material" });
  });
  return out;
}
