// Lab time and staffed hours.
//
// Every "today", "06:30" and "Monday" in the scheduler is the lab's wall clock (settings.tz), whatever zone the host runs in. The
// first version used the host clock; the server ran on UTC, so several day boundaries flipped at 7 pm local time. Pass settings.tz.
//
// Staffed windows are when someone is in the lab to swap a build plate or load a spool. A print may run and finish at any hour, but
// anything that needs hands (a plate swap, a cleared bed, a service) waits for the next staffed window.

export const DEFAULT_TZ = "UTC";
export const tzOf = (settings) => settings?.tz || DEFAULT_TZ;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const dayName = (d) => DAYS[((Number(d) % 7) + 7) % 7];

// One formatter per zone and shape. Building an Intl.DateTimeFormat costs far more than using one, and the planner asks "what time
// is it in the lab" tens of thousands of times per plan; caching them took a full preview from about 600 ms to a few dozen.
const FORMATS = new Map();
function fmt(tz, kind) {
  const k = `${tz}|${kind}`; let f = FORMATS.get(k);
  if (!f) {
    const o = { timeZone: tz };
    if (kind === "hm") Object.assign(o, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    else if (kind === "ymd") Object.assign(o, { year: "numeric", month: "2-digit", day: "2-digit" });
    else if (kind === "ymdw") Object.assign(o, { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
    else if (kind === "wd") Object.assign(o, { weekday: "short" });
    else if (kind === "full") Object.assign(o, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    else if (kind === "clock") Object.assign(o, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    f = new Intl.DateTimeFormat("en-US", o); FORMATS.set(k, f);
  }
  return f;
}

// minutes since lab midnight at instant t
export function hhmm(t, tz = DEFAULT_TZ) {
  const parts = fmt(tz, "hm").formatToParts(new Date(t));
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0) % 24, m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
}
// the lab's calendar day at instant t, "YYYY-MM-DD"
export function labDate(t = Date.now(), tz = DEFAULT_TZ) {
  const parts = fmt(tz, "ymd").formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value; return `${get("year")}-${get("month")}-${get("day")}`;
}
// "YYYY-MM-DD" plus n calendar days
export function dayDate(day, n) { const d = new Date(Date.parse(day + "T00:00:00Z")); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// the Monday (lab time) of the week containing t; a Saturday or Sunday answers the NEXT Monday (the week being planned)
export function mondayOf(t = Date.now(), tz = DEFAULT_TZ) {
  const parts = fmt(tz, "ymdw").formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value;
  const wd = DAYS.indexOf(get("weekday"));
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  d.setUTCDate(d.getUTCDate() - (wd >= 5 ? wd - 7 : wd));
  return d.toISOString().slice(0, 10);
}
// the lab weekday of instant t: 0 = Monday … 6 = Sunday
export function weekdayOf(t, tz = DEFAULT_TZ) {
  return DAYS.indexOf(fmt(tz, "wd").format(new Date(t)));
}

// "YYYY-MM-DD" + "HH:MM" on the lab's wall clock -> epoch ms. DST-safe: the zone's offset is read twice, at the guess and then at
// the answer. One read was an hour off on the two DST Sundays (Nov 1 06:30 came out 05:30).
const offsetAt = (t, tz) => {   // local wall clock minus UTC at instant t, in ms
  const p = fmt(tz, "full").formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) - Math.floor(t / 60_000) * 60_000;
};
export function atLab(day, time, tz = DEFAULT_TZ) {
  const [h, m] = String(time).split(":").map(Number);
  const wall = Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
}
// "Wed 14:30" in the lab's zone, for the plain-words explanations
export const clock = (ms, tz = DEFAULT_TZ) => fmt(tz, "clock").format(new Date(ms)).replace(",", "");

// ---- staffed windows
// settings.staffed: [{ from: "06:30", to: "22:00" }, …] (or one window as a plain object). A window may not cross midnight.
export const STAFFED = [{ from: "06:30", to: "22:00" }];
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const toMin = (s) => { const m = HHMM.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function staffedOf(settings = {}) {
  const raw = settings?.staffed;
  if (raw == null) return STAFFED.map((w) => ({ ...w }));
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((w) => toMin(w?.from) != null && toMin(w?.to) != null && toMin(w.from) < toMin(w.to))
    .map((w) => ({ from: w.from, to: w.to })).sort((a, b) => toMin(a.from) - toMin(b.from));
}
// no sensible window at all = someone is always there
export function isStaffed(t, staffed = STAFFED, tz = DEFAULT_TZ) {
  const wins = Array.isArray(staffed) ? staffed : [staffed];
  if (!wins.length) return true;
  const m = hhmm(t, tz);
  return wins.some((w) => m >= toMin(w.from) && m < toMin(w.to));
}
// the first instant >= t when someone is there (t itself inside a window)
export function nextStaffed(t, staffed = STAFFED, tz = DEFAULT_TZ) {
  const wins = (Array.isArray(staffed) ? staffed : [staffed]).filter((w) => toMin(w?.from) != null);
  if (!wins.length || isStaffed(t, wins, tz)) return t;
  const day = labDate(t, tz); const m = hhmm(t, tz);
  const later = wins.find((w) => toMin(w.from) > m);
  return later ? atLab(day, later.from, tz) : atLab(dayDate(day, 1), wins[0].from, tz);
}
