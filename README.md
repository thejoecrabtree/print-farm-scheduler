# print-farm-scheduler

Goal-set scheduling for a small 3D print farm. Node 22, ES modules, no dependencies, and no I/O in the scheduling core.

I run Texas Toy Lab, a small 3D-printing toy business with about ten Bambu printers. This repository is the scheduling part of
the software that runs the farm, taken out and cleaned up so it stands on its own. It decides which plate each printer prints next
and when, keeps spool changes down, and lets me steer the week with a handful of goals instead of placing plates one by one.

```
goals ("more dragons, half the minis, 4 sea serpents by Friday")
  -> select:  what to print (must-haves, what sells, then the category mix)
  -> fill:    where and when, on each printer's line (colours, variety, staffed hours)
  -> preview -> apply -> the starter starts each line's head when its time comes
```

## The model

- **Plate.** One sliced file printed once on one printer. Nothing else is a unit of work. A multi-plate file becomes a *set* of
  plates that stay together on one printer, back to back.
- **The queue.** One ordered list of plates; order is priority. A plate is pinned to a printer or open to any printer of the model
  it was sliced for. Custom jobs (orders, anything someone dropped in by hand) go ahead of the automatic stock plates.
- **Lanes and lines.** Each printer's lane is *now -> next -> then*, derived from the queue. Every ETA is computed, never stored.
  `engine.lanes()` is the quick view. `lines.build()` is the full timeline per printer that Fill and the starter work from. A plate
  starts at the latest of: now; the end of the plate ahead plus a 15-minute changeover; its pinned time; the printer's
  back-in-service time; and, when it needs hands, the next staffed window.
- **Staffed windows.** When someone is in the lab (`settings.staffed`, default 06:30-22:00; several windows a day are fine). A
  print may run all night, but a plate swap, a bed to clear or a spool to load waits for the next window. The first plate on a
  printer where someone already confirmed a clean build plate may start unattended; that is how the night gets used.
- **The colour day plan.** A Bambu AMS holds four spools (eight on some setups). Swapping spools plate by plate means someone
  walking to a printer all day. The day plan decides once which colour set each printer runs: keep what is loaded and needed, give
  each waiting plate to the printer whose set already covers it, and add a colour only when no printer covers the plate. The
  result is one loading list per printer ("load Violet into slot 1 instead of Grey") and plates that share colours run on the same
  machine.
- **Fill.** Tops each printer's line up to three days ahead from the goals. A periodic fill only adds. Applying new goals may
  replace stock plates that are unpinned and not started, and nothing else.
- **Goals.** `{ mix, targets, must, changes }`: the category mix (the sliders), plates wanted per selling toy, hard asks with a
  date, and a colour-change budget per printer.

## From "randomly selecting stuff" to goal-set planning

The first scheduler worked on a week grid: half-day cells per printer, and an auto-fill that put a plate into every empty cell from
a flat balance of the catalogue. It kept the printers busy, but the week it produced looked random, and changing it meant moving
cells by hand. I also tried asking a large model to re-plan the week as a list of slot operations. That took two to four minutes,
the answer was sometimes cut off, and it decided *what* and *where* at once, so when the result was wrong I could not tell which
half was wrong.

The note I wrote myself was that it had to be goal-set, rather than just randomly selecting stuff. What came out of that:

1. **Sliders.** One per category (percent of the week), one number per selling toy, and a colour-change budget.
2. **A preview in about 40 ms.** Moving a slider re-runs the deterministic planner on the free part of the week and draws the
   result ghosted over the board. On the real farm a full week previewed in about 40 ms, fast enough to drag a slider and watch.
3. **Apply never touches started or hand-placed cells.** Only unstarted, automatic plates are replaced. Anything printing, done or
   placed by hand stays exactly where it is, and every plate the new plan would print on the same printer anyway is kept instead
   of being cancelled and added again.
4. **A Monday auto-plan that approves itself.** Early on Monday the week plans itself from the standing goals, a review checks it,
   and it applies itself only when the review has no warnings. With a warning it waits as a preview for someone to decide.

A few days later the week grid went too. Each printer got one line, Fill tops it up three days ahead, and the goals carried over
unchanged. That is the version here: `goals.previewGoals`, `goals.applyGoals`, `goals.reviewPlan` and `goals.autoPlan`.

## Why the language model only writes goals

There is still a text box: "more dragons, half the minis, get 4 sea serpents done by Friday". A model turns those words into goals,
`{ mix, targets, must, notes }`, and the deterministic planner does the placing.

- **Fast.** A small model turns a sentence into a few numbers in seconds. The planner then runs in tens of milliseconds, so the
  result is on screen straight away.
- **Explainable.** Every planned plate carries a `why` in plain words ("sells (demand) · colours already loaded · someone is there
  from Tue 07:00"). A model placing plates cannot tell you why a plate is where it is, and asking twice gets two answers.
- **Previewable.** The model's answer lands in the sliders, not on the printers. You see what would change, and nothing changes
  until Apply. Toy names the model gets wrong are dropped and reported, never invented.

In the library this step is an async function you pass in:

```js
const { goals: proposed, notes, dropped } = await goals.goalsFromText("more dragons, half the minis, 4 sea serpents by Friday", {
  proposeGoals,   // async (text, catalog) => { mix, targets, must, notes }
  files,
  settings: state.settings,
});
```

Two implementations are included:

- `examples/propose-goals-openai.mjs` calls any OpenAI-compatible chat endpoint (hosted, or a local server). It is configured by
  environment variables only: `GOALS_LLM_URL` (the base URL, before `/chat/completions`), `GOALS_LLM_MODEL`, and optionally
  `GOALS_LLM_AUTH`, which is sent as the Authorization header exactly as given.
- `examples/propose-goals-stub.mjs` is a deterministic keyword version ("more dragons", "half the minis", "4 sea serpents by
  Friday") used by the tests and the simulator, so both run offline.

## Run it

Node 22 or later. There is nothing to install.

```
node examples/simulate.mjs     # a simulated week on ten printers
npm test                       # node --test: 80 tests
```

The simulator runs the real scheduler for a week of virtual time on ten printers (eight P2S, one H2S, one H2C) with a fictional
catalogue of dragons, minis, fidget toys, robots and a few large pieces. Prints run and some fail, using a fixed random seed. During
staffed hours an operator clears beds and loads spools. Fill runs every 30 minutes. On Tuesday a customer order is dropped on one
printer by hand. On Wednesday morning the operator types new goals. Abridged output (timings vary by machine):

```
Mon 00:05  auto-plan from the standing goals: 143 plates on 10 lines, 17 colour-set changes, 3 days ahead (planned in 78.1 ms)
            review: no warnings -> applied by itself

Mon 09:00  the board (now / next / then, with ETAs)
  printer-2  P2S  printing   Mini fox                            ends Mon 09:26
                  next       Castle playset · plate 1 of 3       Mon 09:41 - Mon 12:41  load Grey, Scarlet, Gold
                  then       Castle playset · plate 2 of 3       Mon 12:56 - Mon 15:56
                  then       Castle playset · plate 3 of 3       Mon 16:11 - Mon 18:41

Wed 09:00  the operator types: "more dragons, half the minis, 4 sea serpents by Friday"
            the model (an offline stand-in here) wrote goals: minis 30 -> 15; dragons 20 -> 30; must 4 x sea-serpent by 2026-10-23
            preview in 56.8 ms: 79 plates in, 112 replaced, 38 kept, 15 colour-set changes
            review: no warnings
            Apply: 79 added, 112 cancelled; every started, printing, done and hand-placed plate untouched: yes

The week, three hours per character (m minis, f fidgets, d dragons, p premium, S signature, L large-format, r robots, ...)
             Mon      Tue      Wed      Thu      Fri      Sat      Sun
  printer-1  m.mSSSSS ..mppmSS ..SSmppp ..ddmdmd d.mddddd ..ddfdfd d.fddmfd
  printer-6  f.ppddff ..fmffm. ..mffppp ..ffmppp ..ffddpp ..pddffm ..dddddd
  ...

Summary
  plates started: 315 · finished fine: 303 · failed: 9 (retried once on another printer: 9)
  printer time used: 1192 of 1679 printer-hours (71 %) · unattended starts: 10
  spool loads: 153 with the planner vs 296 naive (same plates, first free printer, a swap whenever a plate's colours are missing): 143 saved (48 %)
  the must-have (4 sea serpents by Friday): 6 finished between the ask and the end of Friday, the fourth at Thu 18:07
```

The dots just after midnight are prints that finished overnight and wait on the bed for the morning. The "naive" baseline replays
the same plates in the same order, each on the first free printer of its model, loading spools whenever a plate's colours are
missing. It is a fair yardstick for placement only, not a model of how anyone actually runs a farm.

### Using the library

```js
import { engine, lines, goals, starter } from "print-farm-scheduler";
import { createBambuddy } from "print-farm-scheduler/adapters/bambuddy";

const state = engine.blankState({ tz: "America/Chicago", staffed: [{ from: "07:00", to: "22:00" }] });
state.printers["printer-1"] = { key: "printer-1", name: "printer-1", model: "P2S", active: true, autoStart: true, driverId: 1, plateOn: true };

const driver = createBambuddy();                 // BAMBUDDY_URL and BAMBUDDY_KEY from the environment
const files = await driver.libraryFiles();       // sliced files with plates, filaments and a category
const live = await driver.liveFor(state.printers);

// plan from the standing goals, review, apply (your code saves `state` afterwards)
const g = goals.standingGoals(state.settings);
const { plan, stats, ms } = goals.previewGoals({ state, files, live, goals: g });
const review = goals.reviewPlan(plan, g, { state, files });
if (!review.warnings) goals.applyGoals(state, plan, files, g);

// every pass: start what is due (one start per pass keeps the power stagger)
const built = lines.build(state, live, { files });
const [pick] = starter.linePicks(built, state, live).picks;
if (pick) await engine.start(state, live, pick.plate, pick.printer, driver.send);
```

The core never reads a file, a clock or the network: every function takes the state, the `live` printer map and the time `t`, and
mutations change only the state object you pass in. Persisting it, and calling the driver, is the caller's job.

### Layout

```
src/
  engine.mjs      plates, the queue, lanes and ETAs, every state transition, the board
  lines.mjs       the per-printer timeline: computed starts, staffed windows, beds to clear, service blocks
  filler.mjs      Fill: top the lines up from the goals (the placement cost function)
  week.mjs        select(): what to print - must-haves, demand, then the category mix
  goals.mjs       clean, preview, apply, words -> goals, review, the Monday auto-plan
  dayplan.mjs     the colour day plan
  ams.mjs         matching a plate's colours to loaded spools; the AMS mapping sent with a start
  starter.mjs     which line's head starts now, and why the others wait
  categories.mjs  the category list and the mix
  labtime.mjs     lab time and staffed windows
adapters/
  bambuddy.mjs    a driver for Bambuddy (status, library, send, pause / resume / stop)
examples/         the simulator, the fictional catalogue, two proposeGoals implementations
test/             node --test
```

Bambuddy is an open-source manager for Bambu Lab printers. Here it is only the printer driver: the scheduler's queue is the
only queue. Nothing in `src/` depends on it; any driver that produces the `live` shape and a `send`
function will do.

## Lessons

- **Split what from where.** `select()` decides what to print; Fill decides where and when. Each half can be explained in a
  sentence and tested on its own. The version that did both at once was the one nobody could debug.
- **Costs, not bans.** "Not the same toy on two printers at once, not twice in a row on one printer" are costs in Fill, not rules.
  When there is nothing else to print, the lines still fill.
- **Compute times, never store them.** Every start is derived from the line on each pass. A stored time is wrong as soon as a
  print runs long.
- **Someone's word gates every start.** Nothing starts until someone has confirmed a build plate is on the bed. A print was once
  started on a bare heatbed; a camera alone is not enough.
- **A stopped print is not a failed print.** It still leaves a plate to clear, but it should not count against the file or the
  machine, and the screens should not say "failed".
- **Use lab time, not the host clock.** The server ran on UTC and day boundaries flipped at 7 pm local time. Every time helper
  takes the zone.
- **Ask in turns.** A target of "six plates of this toy", taken toy by toy, put six of the same toy in a row on one printer. Demand
  is taken one plate per toy per round.
- **Count what is already on the lines.** A target of six means six including the ones already waiting, or a fill that runs every
  half hour adds the same six again.
- **Apply has to leave the queue in the order it previewed.** I found this one while extracting the code: kept plates kept their old
  place in the queue and new plates went behind them, so a must-have previewed for Wednesday ran on Thursday night. Only a
  whole-week simulation showed it.
- **Build the time-zone formatter once.** Creating an `Intl.DateTimeFormat` on every call made a preview take 600 ms. Caching one
  per zone brought it under 60.

## What is not here

The farm's software also sends notifications, runs the screens and the HTTP API, switches lights and smart plugs, talks to the
shop, prices things, watches prints with a camera and tracks maintenance. None of that is scheduling, so none of it is here. In the
farm, the plan review also hands its facts to a model for a second opinion; the review here is rules only.

## Licence

MIT. See [LICENSE](LICENSE).
