// Toy categories and the mix. A week of stock printing should be a balanced mix of the catalogue, not whatever happens to be at the
// top of the list, so every toy file carries a category and the goals give each category a weight (percent of plates).
//
// The defaults below are an example catalogue. Pass your own as settings.categories: [{ slug, label, weight }]. A file's category
// comes from file.category, else a "[minis]" tag in its name, else a guess from the library's naming (MIN-01 …). A file with no
// category is a manual part (a jig, a spare, a replacement knob): it is never planned on its own, only dropped in by hand.

export const DEFAULT_CATEGORIES = [
  { slug: "minis", label: "Minis", weight: 30, prefix: "MIN" },
  { slug: "fidgets", label: "Fidget toys", weight: 20, prefix: "FID" },
  { slug: "dragons", label: "Dragons", weight: 20, prefix: "DRG" },
  { slug: "premium", label: "Premium", weight: 10, prefix: "PRE" },
  { slug: "signature", label: "Signature pieces", weight: 10, prefix: "SIG" },
  { slug: "large-format", label: "Large format", weight: 5, prefix: "LRG" },
  { slug: "robots", label: "Robots", weight: 5, prefix: "BOT" },
  // weight 0: only ever printed when demand or a goal asks for it
  { slug: "name-tags", label: "Name tags", weight: 0, prefix: "TAG" },
];

export const categoriesOf = (settings = {}) => (Array.isArray(settings?.categories) && settings.categories.length ? settings.categories : DEFAULT_CATEGORIES);
export const DEFAULT_MIX = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.slug, c.weight]));

// the mix in force: each category's own weight, then settings.mix on top (known slugs only, 0-100)
export function mixOf(settings = {}) {
  const cats = categoriesOf(settings);
  const m = Object.fromEntries(cats.map((c) => [c.slug, Number(c.weight) || 0]));
  for (const [k, v] of Object.entries(settings?.mix || {})) if (k in m && Number.isFinite(Number(v))) m[k] = Math.max(0, Math.min(100, Number(v)));
  return m;
}

// "01 Minis" / "minis" / "Fidget toys" / "[fidgets]" -> slug, or null
export function slugOf(text, cats = DEFAULT_CATEGORIES) {
  const t = String(text || "").toLowerCase().replace(/^\d+\s*[-_. ]?\s*/, "").replace(/[[\]]/g, "").trim();
  if (!t) return null;
  for (const c of cats) if (t === c.slug || t === c.label.toLowerCase()) return c.slug;
  const singular = t.replace(/s$/, "");
  for (const c of cats) if (singular === c.slug.replace(/s$/, "") || singular === c.label.toLowerCase().replace(/s$/, "")) return c.slug;
  for (const c of cats) if (t.startsWith(c.slug.replace(/s$/, ""))) return c.slug;
  return null;
}
// a "[minis]" tag anywhere in a file name
export function tagIn(name, cats = DEFAULT_CATEGORIES) { const m = String(name || "").match(/\[([^\]]+)\]/); return m ? slugOf(m[1], cats) : null; }
// the library's own naming as a last guess: "MIN-01 Mini owl" -> minis
export function guessFrom(name, cats = DEFAULT_CATEGORIES) {
  const pre = String(name || "").match(/^\s*([A-Z]{2,4})-?\d*/i)?.[1]?.toUpperCase();
  return (pre && cats.find((c) => c.prefix && c.prefix.toUpperCase() === pre)?.slug) || null;
}
// the category of a library file: its own, else a tag in its name, else the naming guess
export function of(file, cats = DEFAULT_CATEGORIES) { return file?.category || tagIn(file?.name, cats) || guessFrom(file?.name, cats) || null; }
export function annotate(files, cats = DEFAULT_CATEGORIES) { for (const f of files || []) f.category = of(f, cats); return files; }
