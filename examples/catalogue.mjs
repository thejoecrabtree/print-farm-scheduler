// A fictional toy catalogue and a ten-printer farm for the examples and the tests. Every name here is made up.

// one shelf of PLA colours: the hexes are far enough apart that no two count as "the same spool" (RGB distance > 80)
export const COLOURS = {
  black: { hex: "#161616", name: "Charcoal" },
  white: { hex: "#F5F5F0", name: "Ivory" },
  red: { hex: "#C12E1F", name: "Scarlet" },
  orange: { hex: "#FF6A13", name: "Orange" },
  yellow: { hex: "#FEC600", name: "Sunflower" },
  green: { hex: "#00AE42", name: "Leaf green" },
  teal: { hex: "#2BC6B0", name: "Teal" },
  navy: { hex: "#0A2989", name: "Navy" },
  violet: { hex: "#5E43B7", name: "Violet" },
  pink: { hex: "#F5547C", name: "Pink" },
  grey: { hex: "#8E9089", name: "Grey" },
  gold: { hex: "#C49A42", name: "Gold" },
};
export const colourName = (type, hex) => Object.values(COLOURS).find((c) => c.hex.toLowerCase() === String(hex).toLowerCase())?.name || null;
const pla = (names, grams) => names.map((n, i) => ({ type: "PLA", color: COLOURS[n].hex, grams: Math.round((grams / names.length) * (i === 0 ? 1.4 : 0.8)), slot: i + 1 }));

// [id, sku, name, category, model, minutes, grams, colours, plates?]
const ROWS = [
  [101, "mini-axolotl", "Mini axolotl", "minis", "P2S", 95, 38, ["pink", "black"]],
  [102, "mini-owl", "Mini owl", "minis", "P2S", 110, 42, ["orange", "white", "black"]],
  [103, "mini-hatchling", "Mini dragon hatchling", "minis", "P2S", 120, 45, ["green", "yellow"]],
  [104, "mini-frog", "Mini frog", "minis", "P2S", 80, 30, ["green", "black"]],
  [105, "mini-octopus", "Mini octopus", "minis", "P2S", 100, 36, ["violet", "white"]],
  [106, "mini-fox", "Mini fox", "minis", "P2S", 90, 34, ["orange", "white"]],
  [111, "flexi-caterpillar", "Flexi caterpillar", "fidgets", "P2S", 150, 55, ["green", "yellow", "black"]],
  [112, "star-spinner", "Fidget star spinner", "fidgets", "P2S", 70, 28, ["navy", "white"]],
  [113, "infinity-cube", "Infinity cube", "fidgets", "P2S", 130, 48, ["red", "black"]],
  [114, "click-slider", "Click slider", "fidgets", "P2S", 60, 22, ["teal", "white"]],
  [115, "flexi-shark", "Flexi shark", "fidgets", "P2S", 160, 60, ["navy", "grey", "white"]],
  [121, "crystal-dragon", "Crystal dragon", "dragons", "P2S", 300, 120, ["violet", "teal"]],
  [122, "fire-dragon", "Fire dragon", "dragons", "P2S", 330, 130, ["red", "orange", "yellow"]],
  [123, "sea-serpent", "Sea serpent", "dragons", "P2S", 280, 110, ["teal", "navy"]],
  [124, "ice-dragon", "Ice dragon", "dragons", "P2S", 310, 125, ["white", "navy"]],
  [131, "articulated-rex", "Articulated rex", "premium", "P2S", 420, 160, ["green", "black"]],
  [132, "castle-playset", "Castle playset", "premium", "P2S", 510, 230, ["grey", "red", "gold"], [180, 180, 150]],
  [133, "hot-air-balloon", "Hot air balloon", "premium", "P2S", 360, 140, ["red", "yellow", "navy", "white"]],
  [141, "jumbo-crystal-dragon", "Jumbo crystal dragon", "signature", "P2S", 900, 380, ["violet", "teal", "white"]],
  [142, "giant-octopus", "Giant flexi octopus", "signature", "P2S", 780, 300, ["pink", "white", "black"], [400, 380]],
  [151, "walking-robot", "Walking robot", "robots", "P2S", 240, 90, ["grey", "orange", "black"]],
  [152, "robot-dog", "Robot dog", "robots", "P2S", 200, 80, ["white", "navy"]],
  [161, "name-tag", "Name tag", "name-tags", "P2S", 30, 10, ["white", "black"]],
  // the same toys sliced for the bigger printers (variants share the sku), and the large-format pieces
  [221, "crystal-dragon", "Crystal dragon", "dragons", "H2S", 260, 120, ["violet", "teal"]],
  [231, "articulated-rex", "Articulated rex", "premium", "H2S", 380, 160, ["green", "black"]],
  [252, "robot-dog", "Robot dog", "robots", "H2S", 180, 80, ["white", "navy"]],
  [271, "treasure-chest", "Treasure chest", "large-format", "H2S", 480, 210, ["gold", "black", "red"]],
  [322, "fire-dragon", "Fire dragon", "dragons", "H2C", 290, 130, ["red", "orange", "yellow"]],
  [371, "dragon-bust", "Dragon bust", "large-format", "H2C", 700, 320, ["red", "orange", "yellow", "black", "gold"]],
  [372, "rainbow-unicorn", "Rainbow unicorn", "large-format", "H2C", 640, 280, ["pink", "violet", "teal", "yellow", "white"]],
];

// the library, in the shape a printer manager's library has once sliced
export const files = ROWS.map(([id, sku, name, category, model, minutes, grams, colours, plates]) => {
  const filaments = pla(colours, grams);
  const f = { id, sku, toyName: name, name: `${name} · ${model}.gcode.3mf`, category, model, sliced: true, minutes, grams, filaments, plates: [] };
  if (plates) f.plates = plates.map((m, i) => ({ index: i + 1, name: `Part ${i + 1}`, minutes: m, grams: Math.round((grams * m) / minutes), filaments }));
  return f;
});

// ten printers: eight P2S, one H2S, one H2C (eight AMS slots)
const LOADED = {
  "printer-1": ["black", "white", "pink", "green"],
  "printer-2": ["orange", "white", "black", "yellow"],
  "printer-3": ["violet", "teal", "white", "black"],
  "printer-4": ["navy", "white", "grey", "red"],
  "printer-5": ["green", "yellow", "black", "orange"],
  "printer-6": ["red", "black", "yellow", "white"],
  "printer-7": ["teal", "navy", "white", "black"],
  "printer-8": ["grey", "orange", "black", "white"],
  "printer-9": ["violet", "teal", "green", "black"],
  "printer-10": ["red", "orange", "yellow", "black", "gold", "pink", "white", "teal"],
};
export function fleet() {
  const printers = {}; const live = {};
  Object.entries(LOADED).forEach(([key, colours], i) => {
    const model = i < 8 ? "P2S" : i === 8 ? "H2S" : "H2C";
    printers[key] = { key, name: key, number: i + 1, model, active: true, autoStart: true, driverId: i + 1, plateOn: true };
    live[key] = { connected: true, state: "IDLE", progress: 0, remainingMin: 0, job: "", amsSlots: model === "H2C" ? 8 : 4,
      trays: colours.map((c, j) => ({ ams: Math.floor(j / 4), slot: j % 4, type: "PLA", color: COLOURS[c].hex, name: COLOURS[c].name, remain: 90 })) };
  });
  return { printers, live };
}

// what sells: plates wanted this week per toy (a shop would compute these from sales and stock on hand)
export const weeklyDemand = [
  { sku: "mini-axolotl", name: "Mini axolotl", plates: 6 },
  { sku: "star-spinner", name: "Fidget star spinner", plates: 4 },
  { sku: "crystal-dragon", name: "Crystal dragon", plates: 3 },
  { sku: "flexi-shark", name: "Flexi shark", plates: 3 },
  { sku: "name-tag", name: "Name tag", plates: 2 },
];
// the demand rows on their shortest file (as goals.demandRows would build them)
export const demandFor = (rows = weeklyDemand) => rows.map((r) => { const f = files.filter((x) => x.sku === r.sku).sort((a, b) => a.minutes - b.minutes)[0]; return { ...r, file: f ? { id: f.id } : null }; });
