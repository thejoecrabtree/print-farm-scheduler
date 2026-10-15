// proposeGoals() for any OpenAI-compatible chat endpoint (a hosted API, or a local server such as llama.cpp, vLLM or Ollama).
// Configured by environment variables only:
//   GOALS_LLM_URL    the base URL, the part before /chat/completions (e.g. https://<your-endpoint>/v1)
//   GOALS_LLM_MODEL  the model name the endpoint expects
//   GOALS_LLM_AUTH   optional: sent as the Authorization header exactly as given (most local servers need none)
//
// The model only ever writes GOALS ({ mix, targets, must, notes }); goals.goalsFromText() checks and maps its answer, and the
// deterministic planner does the placing. A small, fast model is enough: the job is to turn a sentence into a few numbers.
//
// Try it against the fictional catalogue:
//   GOALS_LLM_URL=... GOALS_LLM_MODEL=... node examples/propose-goals-openai.mjs "more dragons, half the minis, 4 sea serpents by Friday"

export function openAICompatible({ baseUrl = process.env.GOALS_LLM_URL, model = process.env.GOALS_LLM_MODEL, auth = process.env.GOALS_LLM_AUTH, timeoutMs = 45_000, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !model) throw new Error("set GOALS_LLM_URL and GOALS_LLM_MODEL");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  return async function proposeGoals(text, catalog) {
    const system = [
      "You turn a toy print farm operator's words into planning GOALS. You never schedule plates; a planner does that.",
      'Answer ONLY with JSON: {"mix": {category: percent}, "targets": {toyName: plates}, "must": [{"toy": toyName, "plates": n, "by": "weekday or YYYY-MM-DD"}], "notes": "one line"}.',
      `mix keys must be from ${JSON.stringify(catalog.categories.map((c) => c.slug))}. Start from the current mix and move only what the words ask; the values should sum to about 100.`,
      "targets: plates wanted per selling toy, only for toys the words mention. must: hard asks, usually with a day (\"by Friday\"). Toy names must be exact names from the list; plates 1-40. Never invent toys.",
    ].join(" ");
    const user = `Words: ${text}\n\nToday: ${catalog.weekday} ${catalog.today}\nCurrent mix: ${JSON.stringify(catalog.current.mix)}\nCurrent targets: ${JSON.stringify(catalog.current.targets)}\nToys: ${JSON.stringify(catalog.toys.map((x) => ({ name: x.name, category: x.category })))}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ model, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`goals model: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const content = String(body?.choices?.[0]?.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    try { return JSON.parse(content); } catch { throw new Error(`goals model: the answer was not JSON: ${content.slice(0, 160)}`); }
  };
}

// run as a script: words -> goals -> a preview against the fictional farm
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { goals: G } = await import("../src/index.mjs");
  const { files, fleet, demandFor } = await import("./catalogue.mjs");
  const words = process.argv.slice(2).join(" ") || "more dragons, half the minis, 4 sea serpents by Friday";
  const { printers, live } = fleet();
  const state = { printers, plates: {}, order: [], settings: { tz: "America/Chicago" } };
  const out = await G.goalsFromText(words, { proposeGoals: openAICompatible(), files, settings: state.settings });
  console.log("goals:", JSON.stringify(out.goals, null, 1));
  if (out.notes) console.log("model notes:", out.notes);
  if (out.dropped.length) console.log("names the catalogue does not have:", out.dropped.join(", "));
  const pv = G.previewGoals({ state, files, goals: out.goals, live, demand: demandFor() });
  console.log(`preview in ${pv.ms} ms:`, pv.stats);
}
