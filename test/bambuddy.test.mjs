// The Bambuddy adapter, against a fake fetch: no network in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBambuddy, trayView, statusView, amsSlotCount, stageOf, fileView } from "../adapters/bambuddy.mjs";

test("bambuddy: not configured without a base URL and a key, and says so", async () => {
  const b = createBambuddy({ baseUrl: "", key: "" });
  assert.equal(b.configured(), false);
  await assert.rejects(b.printers(), /set BAMBUDDY_URL and BAMBUDDY_KEY/);
});

test("bambuddy: trays from both shapes; an untagged spool is present but unknown; the external spool is 'ext'", () => {
  const s = { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PLA", tray_color: "F2754EFF", remain: 80 }, { id: 1, exists: true }, { id: 2, exists: false }, { id: 3, tray_type: "PETG", tray_color: "161616FF", remain: -1 }] }], vt_tray: { tray_type: "PLA", tray_color: "FFFFFFFF" } };
  const trays = trayView(s);
  assert.deepEqual(trays.map((x) => [x.ams, x.slot, x.type, x.color, x.unknown ?? false]), [[0, 0, "PLA", "#F2754E", false], [0, 1, "", null, true], [0, 3, "PETG", "#161616", false], ["ext", 0, "PLA", "#FFFFFF", false]]);
  assert.equal(trays[0].remain, 80); assert.equal(trays[2].remain, null, "-1 = no tag, no remaining %");
  assert.equal(amsSlotCount(s), 4);
  assert.equal(trayView({ ams: { ams: [{ tray: [{ tray_type: "PLA", tray_color: "00AE42FF" }] }] } })[0].color, "#00AE42", "raw MQTT shape");
});

test("bambuddy: status becomes the live shape; HMS codes are a stop only when the printer stopped for them", () => {
  const running = statusView({ connected: true, state: "running", progress: 40, remaining_time: 95, subtask_name: "Mini owl", hms_errors: [{ full_code: "0300_0200_0002_0002" }], stg_cur: 0, ams: [] });
  assert.equal(running.state, "RUNNING"); assert.equal(running.remainingMin, 95); assert.equal(running.job, "Mini owl"); assert.equal(running.errors[0].kind, "notice"); assert.equal(running.stage, "printing");
  assert.equal(statusView({ connected: true, state: "PAUSE", hms_errors: [{ full_code: "x" }] }).errors[0].kind, "stop");
  assert.equal(stageOf({ stg_cur: null }), null, "null is no stage, not 0 = printing");
});

test("bambuddy: a start goes through the queue; a refused start deletes its queue item", async () => {
  const calls = [];
  const fake = (fail) => async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    assert.equal(init.headers["X-API-Key"], "test-key");
    if (init.method === "POST" && /\/queue\/$/.test(new URL(url).pathname)) return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    if (init.method === "POST" && /start$/.test(new URL(url).pathname)) return fail ? new Response("busy", { status: 409 }) : new Response("{}", { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const ok = createBambuddy({ baseUrl: "http://bambuddy.test/", key: "test-key", fetchImpl: fake(false) });
  assert.deepEqual(await ok.send(7, 3, 2, [0, 1], true), { itemId: 42 });
  assert.deepEqual(calls, ["POST /api/v1/queue/", "POST /api/v1/queue/42/start"]);
  calls.length = 0;
  const bad = createBambuddy({ baseUrl: "http://bambuddy.test", key: "test-key", fetchImpl: fake(true) });
  await assert.rejects(bad.send(7, 3, null, null, true), /409/);
  assert.deepEqual(calls, ["POST /api/v1/queue/", "POST /api/v1/queue/42/start", "DELETE /api/v1/queue/42"]);
});

test("bambuddy: library files keep only what the scheduler needs", () => {
  assert.deepEqual(fileView({ id: 5, filename: "MIN-01 Mini owl.gcode.3mf", sliced_for_model: "P2S", print_time_seconds: 6600, filament_used_grams: 41.6, print_count: 3 }),
    { id: 5, name: "MIN-01 Mini owl.gcode.3mf", sliced: true, model: "P2S", minutes: 110, grams: 42, printCount: 3 });
  assert.equal(fileView({ id: 6, filename: "Mini owl.stl" }).sliced, false);
});
