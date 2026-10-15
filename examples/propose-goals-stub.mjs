// A deterministic stand-in for the language model in goals.goalsFromText(): a few keyword rules, no network. It answers in the same
// shape a model would ({ mix, targets, must, notes }, toys by NAME), so tests and the simulator run offline and give the same
// answer every time. It understands sentences like:
//   "more dragons, half the minis, no robots, 4 sea serpents by Friday, 6 mini axolotls"
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const singular = (s) => s.replace(/(ies)$/, "y").replace(/s$/, "");

export async function proposeGoals(text, catalog) {
  const mix = { ...(catalog?.current?.mix || {}) };
  const targets = {}; const must = []; const said = [];
  const catOf = (words) => {
    const w = singular(norm(words).replace(/^(the|of the|our)\s+/, ""));
    return (catalog?.categories || []).find((c) => singular(c.slug.replace(/-/g, " ")) === w || singular(norm(c.label)) === w)?.slug || null;
  };
  const toyOf = (words) => {
    const w = singular(norm(words).replace(/^(the|more|extra)\s+/, ""));
    return (catalog?.toys || []).find((x) => singular(norm(x.name)) === w)?.name || (catalog?.toys || []).find((x) => w.includes(singular(norm(x.name))))?.name || null;
  };
  for (const clause of String(text || "").split(/\s*(?:[,;.]|\band\b)\s*/i).map(norm).filter(Boolean)) {
    let m;
    if ((m = clause.match(/^(?:make |print |get )?(\d+) (.+?)(?: (?:done |ready )?by (\w+))?$/))) {
      const toy = toyOf(m[2]); if (!toy) continue;
      if (m[3]) { must.push({ toy, plates: Number(m[1]), by: m[3] }); said.push(`${m[1]} ${toy} by ${m[3]}`); }
      else { targets[toy] = Number(m[1]); said.push(`${m[1]} ${toy}`); }
    } else if ((m = clause.match(/^(?:more|extra|lots of) (.+)$/))) {
      const cat = catOf(m[1]);
      if (cat) { mix[cat] = Math.min(100, Math.round((mix[cat] || 10) * 1.5)); said.push(`more ${cat}`); }
    } else if ((m = clause.match(/^(?:half|halve)(?: of)?(?: the)? (.+)$/))) {
      const cat = catOf(m[1]); if (cat) { mix[cat] = Math.round((mix[cat] || 0) / 2); said.push(`half the ${cat}`); }
    } else if ((m = clause.match(/^(?:fewer|less) (.+)$/))) {
      const cat = catOf(m[1]); if (cat) { mix[cat] = Math.round((mix[cat] || 0) * 0.7); said.push(`fewer ${cat}`); }
    } else if ((m = clause.match(/^no (.+)$/))) {
      const cat = catOf(m[1]); if (cat) { mix[cat] = 0; said.push(`no ${cat}`); }
    }
  }
  return { mix, targets, must, notes: said.length ? `understood: ${said.join("; ")}` : "nothing I could map to a goal" };
}
