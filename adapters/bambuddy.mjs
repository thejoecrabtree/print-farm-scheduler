// Adapter for Bambuddy, the open-source manager for Bambu Lab printers. Bambuddy holds the LAN connection to every printer and a
// library of sliced .gcode.3mf files; it can send a file to a printer, pause, resume or stop it, and report its status. Here it is
// the printer DRIVER, not the queue: the scheduler's queue is the only queue.
//
// This file does network I/O; src/ does not. Configuration comes from the environment only:
//   BAMBUDDY_URL  the base URL of your Bambuddy (the part before /api/v1)
//   BAMBUDDY_KEY  an API key made in Bambuddy's settings
// An API key cannot register printers; adding a printer is done once in Bambuddy's own UI.
import { modelKey } from "../src/util.mjs";
import * as categories from "../src/categories.mjs";

export function createBambuddy({ baseUrl = process.env.BAMBUDDY_URL, key = process.env.BAMBUDDY_KEY, fetchImpl = globalThis.fetch, timelapse = true } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const configured = () => !!base && !!key;
  async function call(method, path, { body, query, timeout = 8000 } = {}) {
    if (!configured()) throw new Error("Bambuddy is not configured: set BAMBUDDY_URL and BAMBUDDY_KEY");
    const url = new URL(`${base}/api/v1${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const r = await fetchImpl(url, { method, headers: { "X-API-Key": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { j = text; }
    if (!r.ok) { const e = new Error(`bambuddy ${method} ${path} -> ${r.status} ${String(typeof j === "object" ? JSON.stringify(j) : j).slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
  }

  // ---- printers
  const printers = async () => {
    const ps = await call("GET", "/printers/");
    return (Array.isArray(ps) ? ps : []).map((p) => ({ id: p.id, name: p.name, model: p.model || "", modelKey: modelKey(p.model), active: p.is_active !== false }));
  };
  // the `live` shape the scheduler reads (src/engine.mjs)
  const status = async (id) => statusView(await call("GET", `/printers/${id}/status`, { timeout: 6000 }));
  // live for every scheduler printer that has a driverId (its Bambuddy printer id); an unreachable one reads { connected: false }
  async function liveFor(farmPrinters) {
    const out = {};
    await Promise.all(Object.values(farmPrinters || {}).filter((p) => p.driverId != null).map(async (p) => {
      try { out[p.key] = await status(p.driverId); } catch { out[p.key] = { connected: false }; }
    }));
    return out;
  }

  // ---- printing
  // Send a library file to a printer and start it, always through Bambuddy's queue so there is an item id to watch: the upload to the
  // printer happens asynchronously and can fail (no storage in the printer, printer busy). The item is created held, then started
  // explicitly; the printer's own filament check still runs. A refused start deletes its item, so nothing is left behind.
  async function printFile(fileId, printerId, plateIndex = null, amsMapping = null, useAms = true) {
    const body = { library_file_id: fileId, printer_id: printerId, manual_start: true, quantity: 1, use_ams: useAms !== false, timelapse: !!timelapse };
    if (plateIndex) body.plate_id = plateIndex;
    if (amsMapping) body.ams_mapping = amsMapping;
    const item = await call("POST", "/queue/", { body, timeout: 30000 });
    try { await call("POST", `/queue/${item.id}/start`, { body: {}, timeout: 120000 }); }
    catch (e) { await call("DELETE", `/queue/${item.id}`).catch(() => null); throw e; }
    return { itemId: item.id };
  }
  // the `send` engine.start() expects
  const send = (fileId, driverId, plateIndex, mapping, useAms) => printFile(fileId, driverId, plateIndex, mapping, useAms);
  // -> { status: pending | printing | completed | failed | cancelled …, error, startedAt, completedAt }: engine.applyLive's verdicts
  async function queueItem(id) {
    const q = await call("GET", `/queue/${id}`, { timeout: 8000 });
    return { status: String(q.status || "").toLowerCase(), error: q.error_message || null, startedAt: q.started_at || null, completedAt: q.completed_at || null };
  }
  // wait until the printer has actually taken the file (or refused it)
  async function awaitDispatch(itemId, ms = 45000, every = 2500) {
    const t0 = Date.now(); let last = null;
    while (Date.now() - t0 < ms) {
      try { last = await queueItem(itemId); } catch { last = null; }
      if (last && ["printing", "failed", "completed", "cancelled"].includes(last.status)) return last;
      await new Promise((r) => setTimeout(r, every));
    }
    return last || { status: "unknown", error: null };
  }
  const pause = (id) => call("POST", `/printers/${id}/print/pause`, { body: {} });
  const resume = (id) => call("POST", `/printers/${id}/print/resume`, { body: {} });
  const stop = (id) => call("POST", `/printers/${id}/print/stop`, { body: {} });

  // ---- the library (only sliced files can be printed)
  async function library() {
    const files = await call("GET", "/library/files", { query: { limit: 2000 } });
    return (Array.isArray(files) ? files : files?.files || files?.items || []).map(fileView);
  }
  // the plates inside a sliced multi-plate 3MF, one entry per plate
  async function plates(fileId) {
    try {
      const r = await call("GET", `/library/files/${fileId}/plates`);
      return (r.plates || []).map((p) => ({ index: p.index, name: p.name || `Plate ${p.index}`, minutes: p.print_time_seconds ? Math.round(p.print_time_seconds / 60) : null, grams: p.filament_used_grams != null ? Math.round(p.filament_used_grams) : null, filaments: (p.filaments || []).map((f) => ({ slot: f.slot_id ?? f.slot ?? null, type: String(f.type || "").toUpperCase(), color: hex6(f.color), grams: f.used_grams })) }));
    } catch { return []; }
  }
  async function filaments(fileId) {
    try { const r = await call("GET", `/library/files/${fileId}/filament-requirements`); return (r.filaments || []).map((x) => ({ slot: x.slot_id, type: String(x.type || "").toUpperCase(), color: hex6(x.color), grams: x.used_grams })); }
    catch { return []; }
  }
  // the library in the shape week.select() and the filler read, with a category per file (categories.of: a [tag] or a name prefix)
  async function libraryFiles({ cats = categories.DEFAULT_CATEGORIES, categoryOf = null } = {}) {
    const out = [];
    for (const f of (await library()).filter((x) => x.sliced)) {
      const [pl, fil] = await Promise.all([plates(f.id), filaments(f.id)]);
      out.push({ ...f, plates: pl.length > 1 ? pl : [], filaments: fil, category: (categoryOf && categoryOf(f)) || categories.of(f, cats) });
    }
    return out;
  }

  return { configured, call, printers, status, liveFor, printFile, send, queueItem, awaitDispatch, pause, resume, stop, library, plates, filaments, libraryFiles };
}

// ---- pure normalisers (exported for tests and for other drivers that speak the same printer protocol)

// Bambu's print stages (stg_cur): what the printer is doing right now, in plain words
export const STAGES = { 0: "printing", 1: "levelling the bed", 2: "heating the bed", 3: "vibration calibration", 4: "changing filament", 5: "paused (M400)", 6: "paused - filament ran out", 7: "heating the nozzle", 8: "calibrating extrusion", 9: "scanning the bed surface", 10: "inspecting the first layer", 11: "identifying the build plate", 12: "calibrating the lidar", 13: "homing", 14: "cleaning the nozzle tip", 15: "checking extruder temperature", 16: "paused by the user", 17: "paused - front cover", 18: "calibrating the lidar", 19: "calibrating flow", 20: "paused - nozzle temperature fault", 21: "paused - bed temperature fault", 22: "unloading filament", 23: "paused - skipped step", 24: "loading filament", 25: "motor noise calibration", 26: "paused - AMS lost", 27: "paused - heat-break fan", 28: "paused - chamber temperature", 29: "cooling the chamber", 30: "paused by gcode", 31: "motor noise showoff", 32: "paused - filament on the nozzle", 33: "paused - cutter error", 34: "paused - first layer error", 35: "paused - nozzle clog" };
export function stageOf(s) {
  const n = s.stg_cur == null || s.stg_cur === "" ? NaN : Number(s.stg_cur);   // null is "no stage", not 0 = "printing"
  const named = s.stg_cur_name && String(s.stg_cur_name).trim();
  if (Number.isFinite(n) && n >= 0 && STAGES[n]) return STAGES[n];
  if (named && named.toLowerCase() !== "none") return named.toLowerCase();
  return null;
}

// Bambuddy's printer status -> the scheduler's live shape. Bambuddy's `state` is Bambu's gcode_state (IDLE / RUNNING / PAUSE /
// FINISH / FAILED / PREPARE / SLICING …). HMS codes become errors: a code the printer stopped for (paused or failed) is a "stop", any
// other a "notice" (a printer that keeps printing through a code is not in error).
export function statusView(s) {
  const state = String(s.state || "").toUpperCase();
  const stopped = state === "PAUSE" || state === "FAILED";
  const hms = Array.isArray(s.hms_errors) ? s.hms_errors : [];
  return {
    connected: !!s.connected, state,
    progress: Number(s.progress ?? 0), remainingMin: Number(s.remaining_time ?? 0),
    job: s.subtask_name || s.gcode_file || "", layer: s.layer_num ?? null, layers: s.total_layers ?? null,
    errors: hms.map((e) => ({ code: String(e.full_code ?? e.code ?? e.attr ?? ""), kind: stopped ? "stop" : "notice", text: e.description || e.message || `HMS ${e.full_code ?? e.code ?? ""}`.trim() })),
    trays: trayView(s), amsSlots: amsSlotCount(s),
    stage: stageOf(s),
    // a P2S needs storage in the printer for LAN files: without it the upload fails and nothing prints
    storage: s.sdcard == null ? null : !!s.sdcard,
  };
}

// What filament is loaded: one entry per AMS slot (+ the external spool). Bambu reports tray_type ("PLA") and tray_color
// ("F2754EFF"); both the raw MQTT shape and Bambuddy's flattened one are accepted.
export function trayView(s) {
  const out = [];
  const amsList = Array.isArray(s.ams) ? s.ams : Array.isArray(s.ams?.ams) ? s.ams.ams : [];
  amsList.forEach((a, ai) => {
    (a.tray || a.trays || a.slots || []).forEach((t, ti) => {
      const type = t.tray_type || t.type || t.material || "";
      // A spool without an RFID tag is "present but unidentified" (no type). It cannot be mapped until someone sets its type on the
      // printer. Bambuddy marks loaded slots with exists: true; raw MQTT has no `exists`, so fall back to the state bits.
      const present = !!type || (t.exists !== undefined ? t.exists === true : Number(t.state || 0) > 0);
      if (!present) return;
      out.push({ ams: a.id ?? ai, slot: t.id ?? ti, type: String(type || "").toUpperCase(), unknown: !type, color: hex6(t.tray_color || t.color), name: t.tray_sub_brands || t.name || "", remain: remainPct(t), weightG: Number(t.tray_weight) > 0 ? Number(t.tray_weight) : 1000 });
    });
  });
  const vt = Array.isArray(s.vt_tray) ? s.vt_tray : s.vt_tray ? [s.vt_tray] : [];
  vt.forEach((t) => { const type = t.tray_type || t.type; if (type) out.push({ ams: "ext", slot: 0, type: String(type).toUpperCase(), color: hex6(t.tray_color || t.color), name: t.tray_sub_brands || "", remain: remainPct(t), weightG: 1000 }); });
  return out;
}
export function amsSlotCount(s) {
  const amsList = Array.isArray(s.ams) ? s.ams : Array.isArray(s.ams?.ams) ? s.ams.ams : [];
  return amsList.reduce((a, x) => a + (x.tray || x.trays || x.slots || []).length, 0);
}
// tagged spools report remaining %; third-party spools say -1
function remainPct(t) { const r = Number(t.remain); return Number.isFinite(r) && r >= 0 ? Math.min(100, r) : null; }
function hex6(c) { const m = String(c || "").replace("#", "").match(/^([0-9a-fA-F]{6})/); return m ? `#${m[1].toUpperCase()}` : null; }

export function fileView(f) {
  const sliced = /gcode\.3mf$/i.test(f.filename || "") || f.file_type === "gcode.3mf";
  return {
    id: f.id, name: f.filename || "", sliced, model: f.sliced_for_model || "",
    minutes: f.print_time_seconds ? Math.round(f.print_time_seconds / 60) : null,
    grams: f.filament_used_grams != null ? Math.round(f.filament_used_grams) : null,
    printCount: f.print_count || 0,
  };
}
