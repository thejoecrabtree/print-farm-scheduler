// Small shared helpers. Nothing in src/ touches the disk, the network or a clock it was not handed.
import { randomUUID } from "node:crypto";

export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export function id(prefix = "P") { return `${prefix}-${randomUUID().slice(0, 8)}`; }
export const iso = (t = Date.now()) => new Date(t).toISOString();

// "Bambu Lab H2S" / "H2S" / "A1 mini" / "A1MINI" -> "H2S" / "A1MINI", so a file sliced for a model and a printer of that model
// compare equal however each side spells it.
export function modelKey(s) {
  return String(s || "").toUpperCase().replace(/BAMBU\s*LAB/g, "").replace(/[^A-Z0-9]/g, "");
}

// "PLA Basic" / "PLA Matte" -> "PLA": the base material. Two spools of one base material can stand in for each other; PLA and PETG cannot.
export const fam = (t) => String(t || "PLA").toUpperCase().split(" ")[0];

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// An error with an HTTP-ish status, so a caller with an API can pass it straight through (404 no such plate, 409 not now).
export function err(status, message) { const e = new Error(message); e.status = status; return e; }
