#!/usr/bin/env node
// Live load/sync end-to-end harness for the Strength Log PWA.
//
// What it does (see docs/live-load-sync-e2e.md):
//   1. starts the demo (VITE_DEMO=1) of a checkout through the Vite API, with
//      the fidelity patches in live-demo-plugin.mjs,
//   2. drives it in real Chromium through realistic sessions in lb AND kg
//      (number pad, dock steps, plate sheet, per-hand toggle, unit switches
//      mid-draft / mid-rest, corrections, supersets, extra sets, offline),
//   3. records every write the app enqueues (IndexedDB "outbox" store hook),
//   4. compares every screen with what was typed and with the arithmetic
//      (bar + 2 x plates == shown total), screenshotting discrepancies,
//   5. writes <out>/live-payloads.json and <out>/live-report.json, then hands
//      the payloads to scripts/replay-payloads.mjs, which inserts them into a
//      PGlite database built from the full migration chain.
//
// Usage (from the repo root):
//   node pwa/e2e/live-load-sync.mjs [--label branch] [--out DIR]
//        [--pwa-dir PATH]   checkout to test (default: the pwa/ next to this file)
//        [--url URL]        use an already running demo instead of starting one
//        [--units lb,kg]    [--only name,name]   [--no-replay]   [--headed]
//
// Exit code: 0 clean; 1 when any payload is rejected by the database, violates
// an AGENTS.md invariant, or a screen disagrees with what was typed.

import { chromium } from "playwright";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveDemoPlugin } from "./live-demo-plugin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const pwaDir = path.resolve(args["pwa-dir"] ?? path.join(here, ".."));
const label = args.label ?? "branch";
const outDir = path.resolve(args.out ?? path.join(process.cwd(), "live-e2e-out"));
const shotsDir = path.join(outDir, `shots-live-${label}`);
const UNITS = (args.units ?? "lb,kg").split(",");
const ONLY = args.only ? args.only.split(",") : null;
mkdirSync(shotsDir, { recursive: true });

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[k] = true;
    else {
      o[k] = next;
      i++;
    }
  }
  return o;
}

const KG_PER_LB = 0.45359237;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- server ----

const patchLog = [];
let server = null;
let baseUrl = args.url ?? null;
if (!baseUrl) {
  process.env.VITE_DEMO = "1";
  const vitePath = path.join(pwaDir, "node_modules", "vite", "dist", "node", "index.js");
  if (!existsSync(vitePath)) throw new Error(`vite not found under ${pwaDir}/node_modules`);
  const { createServer } = await import(pathToFileURL(vitePath).href);
  server = await createServer({
    root: pwaDir,
    configFile: path.join(pwaDir, "vite.config.ts"),
    plugins: [liveDemoPlugin((p) => patchLog.push(p))],
    server: { port: Number(args.port ?? 0) || undefined, strictPort: false, host: "127.0.0.1" },
    logLevel: "error",
    clearScreen: false,
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.config.server.port ?? server.httpServer.address().port}`;
}

// ------------------------------------------------------------ the plan ------
// One authored day that exercises every load path. load_kg is ALWAYS the
// total system kg; entered_* is what the author typed (consistent with the
// production trigger, so a clean prescription is never the source of a
// rejection). `entered: [value, unit]`; `entry: 'per_side'` doubles.

const rx = (o) => {
  const entry = o.entry ?? null;
  const mult = entry === "per_side" ? 2 : 1;
  let load_kg = o.load_kg ?? null;
  let entered_load = null;
  let entered_unit = null;
  if (o.entered) {
    [entered_load, entered_unit] = o.entered;
    load_kg = r2(entered_load * (entered_unit === "lb" ? KG_PER_LB : 1) * mult);
  }
  return {
    exercise_id: o.ex,
    sets: o.sets ?? 2,
    reps_min: o.reps ?? 5,
    reps_max: o.reps ?? 5,
    load_kg,
    load_pct_tm: o.pct ?? null,
    rest_seconds: 90,
    notes: null,
    superset_group: o.ss ?? null,
    load_entry: entry,
    entered_load,
    entered_unit,
    set_type: o.type ?? "working",
    section: null,
    tracking: o.tracking ?? "reps",
  };
};

const PLAN = [
  rx({ ex: "Barbell_Squat", sets: 1, reps: 8, type: "warmup", entered: [135, "lb"], entry: "total" }),
  rx({ ex: "Barbell_Squat", sets: 2, reps: 5, entered: [100, "kg"], entry: "total" }),
  rx({ ex: "Barbell_Bench_Press", sets: 3, reps: 5, entered: [102.5, "kg"], entry: "total" }),
  rx({ ex: "Romanian_Deadlift", sets: 2, reps: 8, entered: [225, "lb"], entry: "total" }),
  rx({ ex: "Seated_Dumbbell_Press", sets: 4, reps: 8, entered: [50, "lb"], entry: "per_side" }),
  rx({ ex: "Dumbbell_Bicep_Curl", sets: 3, reps: 10, entered: [22.5, "kg"], entry: "per_side" }),
  rx({ ex: "Face_Pull", sets: 3, reps: 12, entered: [25, "kg"], entry: "total", ss: 1 }),
  rx({ ex: "Triceps_Pushdown", sets: 3, reps: 12, entered: [60, "lb"], entry: "total", ss: 1 }),
  rx({ ex: "Leg_Press", sets: 3, reps: 10, entered: [300, "lb"], entry: "total" }),
  rx({ ex: "Pullups", sets: 3, reps: 6 }),
  rx({ ex: "Barbell_Deadlift", sets: 3, reps: 3, pct: 80 }),
  rx({ ex: "Hammer_Curls", sets: 2, reps: 10, load_kg: 17.5 }), // legacy: no entered pair
  rx({ ex: "Lat_Pulldown", sets: 12, reps: 10, entered: [72.5, "kg"], entry: "total" }),
];

// -------------------------------------------------------------- browser -----

const consoleErrors = [];
const mockGaps = [];
const report = {
  label,
  baseUrl,
  pwaDir,
  startedAt: new Date().toISOString(),
  patches: patchLog,
  scenarios: [],
  consoleErrors,
  mockGaps,
  mismatches: [],
  notes: [],
};
const payloads = [];

const browser = await chromium.launch({ headless: !args.headed });

const INIT = (unit) => `
(() => {
  try { if (!localStorage.getItem("strength-log.settings"))
    localStorage.setItem("strength-log.settings", JSON.stringify({ v: 2, values: { unit: ${JSON.stringify(unit)} } })); } catch {}
  const KEY = "__outboxLog";
  const log = [];
  try { const prev = sessionStorage.getItem(KEY); if (prev) log.push(...JSON.parse(prev)); } catch {}
  window.__outboxLog = log;
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(log)); } catch {} };
  for (const m of ["add", "put"]) {
    const orig = IDBObjectStore.prototype[m];
    IDBObjectStore.prototype[m] = function (value, key) {
      try {
        if (this.name === "outbox" && value && value.op) {
          log.push({ m, t: Date.now(), value: JSON.parse(JSON.stringify(value)) });
          save();
        }
      } catch {}
      return orig.apply(this, arguments);
    };
  }
})();`;

// ------------------------------------------------------- the driver ---------

class Run {
  constructor(name, unit, opts = {}) {
    this.name = name;
    this.unit = unit; // device display unit at the start
    this.opts = opts;
    this.steps = [];
    this.seen = new Set();
    this.sets = []; // payloads of this run
    this.logCursor = 0;
    this.mismatches = [];
    this.n = 0;
    this.before = null; // screen snapshot taken before the last LOG
    this.barKg = {}; // exercise -> base weight the harness set (kg), if any
  }

  async open(first = null) {
    this.ctx = await browser.newContext({ viewport: { width: 402, height: 812 } });
    this.ctx.setDefaultTimeout(Number(args.timeout ?? 6000));
    await this.ctx.addInitScript(INIT(this.unit));
    this.page = await this.ctx.newPage();
    this.page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") {
        const text = m.text().slice(0, 300);
        if (/Download the React DevTools|favicon/.test(text)) return;
        // demo-mock limitations (not product behaviour): kept apart from app errors
        if (/mockSupabase: unknown relation|\.range is not a function|\.order\(\.\.\.\)\.range/.test(text)) {
          mockGaps.push({ run: this.name, text: text.slice(0, 160) });
          return;
        }
        consoleErrors.push({ run: this.name, type: m.type(), text });
      }
    });
    this.page.on("pageerror", (e) =>
      consoleErrors.push({ run: this.name, type: "pageerror", text: String(e.message).slice(0, 300) }),
    );
    await this.page.goto(`${baseUrl}/?demo=default`, { timeout: 45000 });
    await this.page.waitForFunction(() => window.__demo && window.__engine, null, { timeout: 20000 }).catch(() => {});
    await sleep(1200);
    let plan = PLAN.map((r, i) => ({ ...r, _i: i }));
    if (first) {
      const id = EX_ID[first];
      const head = plan.filter((r) => r.exercise_id === id);
      const groups = new Set(head.map((r) => r.superset_group).filter((g) => g != null));
      const lead = plan.filter((r) => r.exercise_id === id || (r.superset_group != null && groups.has(r.superset_group)));
      plan = [...lead, ...plan.filter((r) => !lead.includes(r))];
    }
    this.planOrder = plan.map((r) => r._i);
    await this.page.evaluate(
      ({ plan }) => {
        const s = window.__demo.store;
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const pw = s.planned_workouts.find((w) => w.scheduled_date === today && !w.skipped_at);
        if (!pw) throw new Error("no workout today in the demo store");
        s.prescriptions = s.prescriptions.filter((r) => r.planned_workout_id !== pw.id);
        plan.forEach((r, i) =>
          s.prescriptions.push({
            ...r,
            id: `live-rx-${r._i}`,
            user_id: pw.user_id,
            planned_workout_id: pw.id,
            position: i,
            created_at: new Date().toISOString(),
          }),
        );
        // an empty section list keeps the plan flat
      },
      { plan },
    );
    // force Today to re-read the store: bounce through another tab
    await this.page.getByRole("link", { name: /program/i }).click().catch(() => {});
    await sleep(500);
    await this.page.getByRole("link", { name: /^train$/i }).click().catch(() => {});
    await sleep(800);
  }

  async start() {
    const p = this.page;
    await p.getByRole("button", { name: /^go$/i }).click();
    await sleep(600);
    await p.getByRole("button", { name: /start workout/i }).click();
    await p.waitForURL(/\/session/, { timeout: 8000 });
    await sleep(1500);
    // The late-October redesign moved the unit switch and the exercise list
    // into a "Today's workout" sheet and made corrections a sheet.
    this.v3 = (await p.getByRole("button", { name: /^Today's workout, \d+ of \d+ sets done/ }).count()) > 0;
    this.curUnit = this.unit;
    report.notes.push(`${this.name}: UI flavor ${this.v3 ? "workout-sheet" : "focus-dock"}`);
    await this.snap("session started");
  }

  /** A finished exercise offers "+ Extra set" instead of a dock. */
  async armExtra() {
    const extra = this.page.getByRole("button", { name: /^\+ extra set$/i });
    if (this.v3 && (await extra.count())) {
      this.extraSeen = true;
      await extra.first().click();
      await sleep(500);
      return true;
    }
    return false;
  }

  async finishWorkout() {
    const p = this.page;
    if (this.v3) {
      await this.openWorkoutSheet();
      await p.getByRole("button", { name: /^finish session$/i }).first().click();
    } else {
      await p.getByRole("button", { name: /workout/i }).first().click();
      await sleep(500);
      await p.getByRole("button", { name: /^finish$/i }).first().click();
    }
    await sleep(800);
  }

  async openWorkoutSheet() {
    await this.page.getByRole("button", { name: /^Today's workout, \d+ of \d+ sets done/ }).click();
    await sleep(500);
  }

  async shot(tag) {
    const f = path.join(shotsDir, `${this.name}-${String(++this.n).padStart(3, "0")}-${tag.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`);
    await this.page.screenshot({ path: f }).catch(() => {});
    return path.relative(outDir, f);
  }

  // ---- scraping ----
  async read() {
    const raw = await this.page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const txt = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : null);
      const loadBtns = [...document.querySelectorAll('button[aria-label="load value — tap to type"]')].filter(vis);
      const loads = loadBtns.map((b) => ({
        value: txt(b),
        sub: txt(b.parentElement.querySelector(".stepper-sub")) ?? txt(b.closest(".stepper")?.querySelector(".stepper-sub")),
        sectionText: txt(b.closest("section")),
        parentText: txt(b.parentElement?.parentElement),
      }));
      const correction = !!document.querySelector(".correction-sheet");
      const pressed = [...document.querySelectorAll('.session-unit-switch button[aria-pressed="true"]')].filter(vis).map(txt);
      const q = (s) => [...document.querySelectorAll(s)].filter(vis).map(txt);
      return {
        loads,
        correction,
        unitPressed: pressed[0] ?? null,
        stage: q(".focus-load-stage-value")[0] ?? null,
        stageBase: q(".focus-load-stage-base")[0] ?? null,
        loadPicture: q(".load-picture, .lp-text, .plate-text").join(" || ") || null,
        lastSet: q(".focus-last-set")[0] ?? q(".focus-saved-line")[0] ?? null,
        lastPerf: q(".focus-last-performance")[0] ?? null,
        dockSub: q(".focus-dock .microcopy, .focus-load-detail")[0] ?? null,
        heading: q("h1.focus-deck-name")[0] ?? null,
        current: [...document.querySelectorAll("button[aria-label$='— current']")].map((b) => b.getAttribute("aria-label")).filter(() => true)[0] ?? null,
        sheet: q(".sheet, [role=dialog]").join(" || ") || null,
        body: document.body.innerText.replace(/\s+/g, " "),
      };
    });
    return raw;
  }

  parse(raw) {
    const num = (s) => {
      const m = s == null ? null : /-?\d+(?:\.\d+)?/.exec(String(s));
      return m ? parseFloat(m[0]) : null;
    };
    const out = { unit: raw.unitPressed ?? this.curUnit ?? this.unit, raw };
    const l = (raw.correction ? raw.loads[raw.loads.length - 1] : raw.loads[0]) ?? null;
    out.shown = l ? num(l.value) : null;
    out.sub = l?.sub ?? null;
    const body = raw.body;
    let m = /([\d.]+) (lb|kg) per hand · ([\d.]+) (lb|kg) total/.exec(raw.stage ?? "");
    out.perHand = !!m || /EACH HAND\s*×\s*2/i.test(l?.sectionText ?? "") || /per hand/.test(raw.stage ?? "") || /\beach\b/i.test(l?.parentText ?? "");
    const head = raw.heading ?? (raw.current ? raw.current.replace(/(, selected)? — current$/, "") : null);
    out.exerciseName = head;
    if (m) {
      out.stagePerHand = parseFloat(m[1]);
      out.stageTotal = parseFloat(m[3]);
      out.stageUnit = m[2];
    } else if ((m = /([\d.]+) (lb|kg) total/.exec(raw.stage ?? ""))) {
      out.stageTotal = parseFloat(m[1]);
      out.stageUnit = m[2];
    }
    // plate text: from the stage picture, the plate sheet, or (main) the dock line
    const plateSrc = [raw.loadPicture, raw.sheet, body].filter(Boolean).join(" || ");
    m = /((?:(?:\d+×)?\d+(?:\.\d+)? \+ )*(?:\d+×)?\d+(?:\.\d+)?) per side(?: · closest is ([\d.]+))?/.exec(plateSrc);
    if (m) {
      // "45 + 2×10" = one 45 and two 10s on each side
      out.plates = m[1].split(" + ").flatMap((tok) => {
        const g = /^(\d+)×([\d.]+)$/.exec(tok);
        return g ? Array(Number(g[1])).fill(parseFloat(g[2])) : [parseFloat(tok)];
      });
      out.closest = m[2] ? parseFloat(m[2]) : null;
    } else if (/Bar only|Sled only|No plates/.test(plateSrc)) {
      out.plates = [];
      const cm = /(?:Bar only|Sled only|No plates)\s*·\s*closest is ([\d.]+)/.exec(plateSrc);
      out.closest = cm ? parseFloat(cm[1]) : null;
    }
    m = /([\d.]+) (lb|kg) base/.exec(raw.stageBase ?? "") ?? /\b(?:Bar|Sled|Base) ([\d.]+) (lb|kg)\b/.exec(body);
    out.base = m ? parseFloat(m[1]) : null;
    return out;
  }

  async snap(desc, extra = {}) {
    const raw = await this.read();
    const s = this.parse(raw);
    const issues = this.checkScreen(s, desc, extra);
    const rec = { desc, unit: s.unit, shown: s.shown, sub: s.sub, stage: raw.stage, plates: s.plates ?? null, closest: s.closest ?? null, base: s.base ?? null, plateChecked: Boolean(issues.plateChecked), lastSet: raw.lastSet, lastPerf: raw.lastPerf, issues: [...issues] };
    this.steps.push(rec);
    if (issues.length) {
      const shot = await this.shot(desc);
      for (const i of issues) {
        this.mismatches.push({ run: this.name, step: desc, ...i, shot });
      }
      rec.shot = shot;
    }
    if (args["shots-all"]) rec.shot = rec.shot ?? (await this.shot(desc));
    this.cur = s;
    return s;
  }

  // ---- screen invariants (no knowledge of what was typed) ----
  checkScreen(s, desc, extra) {
    const issues = [];
    const add = (kind, detail) => issues.push({ kind, detail });
    const unit = s.unit;
    const tol = 0.06;
    if (s.shown != null && unit) {
      // 1. the load label's unit is the display unit
      if (s.sub && /^(lb|kg)$/i.test(s.sub) && s.sub.toLowerCase() !== unit)
        add("unit-label", `load unit label "${s.sub}" but unit switch says ${unit}`);
      if (s.stageUnit && s.stageUnit !== unit)
        add("unit-label", `stage says ${s.stageUnit} but unit switch says ${unit}: "${s.raw.stage}"`);
      // 2. stage figure == dock figure
      if (s.perHand) {
        if (s.stagePerHand != null && Math.abs(s.stagePerHand - s.shown) > tol)
          add("stage-vs-dock", `per-hand stage ${s.stagePerHand} vs dock ${s.shown}`);
        if (s.stageTotal != null && Math.abs(s.stageTotal - 2 * s.shown) > 0.15 + tol)
          add("per-hand-total", `total ${s.stageTotal} is not 2 x ${s.shown}`);
      } else if (s.stageTotal != null && Math.abs(s.stageTotal - s.shown) > tol) {
        add("stage-vs-dock", `stage total ${s.stageTotal} vs dock ${s.shown}`);
      }
      // 3. plate arithmetic: base + 2 x plates == shown total (or the stated "closest")
      if (s.plates && !s.perHand && s.raw.sheet === null) {
        const sum = s.plates.reduce((a, b) => a + b, 0);
        const base = s.base ?? extra.base ?? null;
        if (base != null) {
          issues.plateChecked = true;
          const built = base + 2 * sum;
          const target = s.closest ?? s.shown;
          if (Math.abs(built - target) > tol + 0.01)
            add("plate-arithmetic", `base ${base} + 2 x (${s.plates.join(" + ")}) = ${r2(built)} but screen says ${target}${s.closest ? " (closest)" : ""}`);
          if (s.closest != null) {
            const gap = s.shown - s.closest;
            const step = unit === "lb" ? 5 : 2.5;
            if (s.shown < base - tol) {
              // below the bar nothing lighter than the bar can be built
              if (Math.abs(s.closest - base) > tol) add("plate-closest", `target ${s.shown} is below the ${base} base but "closest" is ${s.closest}`);
            } else if (gap < -tol || gap >= step + tol)
              add("plate-closest", `closest ${s.closest} vs target ${s.shown} (gap ${r2(gap)} should be 0..${step})`);
          } else if (Math.abs(built - s.shown) > tol + 0.01) {
            add("plate-arithmetic", `plates claim an exact build but ${r2(built)} != ${s.shown}`);
          }
        }
      }
    }
    return issues;
  }

  // ---- outbox capture ----
  async drain(tag) {
    const log = await this.page.evaluate(() => window.__outboxLog ?? []);
    const fresh = [];
    for (const e of log) {
      const op = e.value.op;
      const key = JSON.stringify([op.kind, op.table, op.payload ?? op.patch ?? null, op.id ?? null]);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const rec = { run: this.name, unitAtStart: this.unit, step: tag, op, owner: e.value.owner ?? null, t: e.t };
      fresh.push(rec);
      payloads.push(rec);
    }
    return fresh;
  }

  // ---- actions ----
  async select(name) {
    const p = this.page;
    this.exId = EX_ID[name] ?? null;
    const here = (await this.read()).heading;
    if (here === name) {
      await this.armExtra();
      return;
    }
    if (this.v3) {
      await this.openWorkoutSheet();
      await p.getByRole("button", { name: new RegExp(`^(A\\d · )?${escapeRe(name)}(, selected)? — `) }).first().click();
      await sleep(500);
      const still = p.locator("button:visible").filter({ hasText: /^close$/i });
      if (await still.count()) await still.last().click().catch(() => {});
      await sleep(300);
      const focusBtn = p.getByRole("button", { name: /^focus$/i });
      if (await focusBtn.count()) await focusBtn.first().click().catch(() => {});
      await sleep(400);
      await this.armExtra();
      return;
    }
    const inOverview = await p.getByRole("button", { name: new RegExp(`^${escapeRe(name)} — `) }).count();
    if (!inOverview) {
      await p.getByRole("button", { name: /workout/i }).first().click();
      await sleep(400);
    }
    await p.getByRole("button", { name: new RegExp(`^${escapeRe(name)}(, selected)? — `) }).first().click();
    await sleep(400);
    const focusBtn = p.getByRole("button", { name: /^focus$/i });
    if (await focusBtn.count()) {
      await focusBtn.first().click();
    } else {
      // checkouts without the Focus/List switch: the accordion edits the current entry
      const cur = p.getByRole("button", { name: /go to current exercise/i });
      if (await cur.count()) await cur.first().click().catch(() => {});
      report.notes.push(`${this.name}: select(${name}) fell back to the accordion (no Focus switch)`);
    }
    await sleep(500);
  }

  /** The rest scene replaces the load stage; the HIDE control brings it back. */
  async hideRest() {
    const h = this.page.getByRole("button", { name: /hide the rest timer/i });
    if (await h.count()) {
      await h.first().click().catch(() => {});
      await sleep(350);
    }
  }

  async toList() {
    await this.page.getByRole("button", { name: /^list$/i }).first().click();
    await sleep(500);
  }
  async toFocus() {
    await this.page.getByRole("button", { name: /^focus$/i }).first().click();
    await sleep(500);
  }

  /** A superset member's target caption must say what the member's dock says. */
  async checkSupersetTargets(desc) {
    const rows = await this.page.evaluate(() =>
      [...document.querySelectorAll("section")].filter((sec) => sec.querySelector(".superset-member-target")).map((sec) => ({
        label: sec.querySelector(".superset-round-member-label")?.innerText.replace(/\s+/g, " ").trim(),
        target: sec.querySelector(".superset-member-target")?.innerText.replace(/\s+/g, " ").trim(),
        dock: sec.querySelector(".stepper-value")?.innerText.trim(),
        unit: sec.querySelector(".stepper-sub")?.innerText.trim(),
      })),
    );
    for (const row of rows) {
      const m = /@\s*([\d.]+)\s*(lb|kg)/i.exec(row.target ?? "");
      if (!m) continue;
      if (Math.abs(parseFloat(m[1]) - parseFloat(row.dock)) > 0.06 || m[2].toLowerCase() !== (row.unit ?? "").toLowerCase())
        this.mismatches.push({ run: this.name, step: desc, kind: "target-caption", detail: `${row.label}: target caption "${row.target}" but the dock shows ${row.dock} ${row.unit} for the untouched prescription`, shot: await this.shot(desc) });
    }
    return rows;
  }

  /** After an action the lifter expects to have changed the staged load. */
  async expectShown(value, desc, extra = {}) {
    const s = await this.snap(desc, extra);
    if (s.shown == null || Math.abs(s.shown - value) > 0.06) {
      const shot = await this.shot(desc);
      this.mismatches.push({
        run: this.name,
        step: desc,
        kind: "typed-not-applied",
        detail: `expected the dock to show ${value} ${s.unit}, it shows ${s.shown}`,
        shot,
      });
    }
    return s;
  }

  /** A block that needs UI the checkout under test may not have (e.g. reopening
   *  a finished exercise on a pre-redesign build). With --lenient a failure is
   *  recorded as a note and the scenario continues; otherwise it aborts. */
  async tryBlock(name, fn) {
    try {
      await fn();
    } catch (e) {
      if (!args.lenient) throw e;
      const shot = await this.shot(`block-${name}`);
      report.notes.push(`${this.name}: block "${name}" not drivable on this checkout: ${String(e.message).split("\n")[0].slice(0, 120)} (${shot})`);
      this.skippedBlocks = (this.skippedBlocks ?? 0) + 1;
    }
  }

  /** Open the correction for the newest set. */
  async openFix() {
    const p = this.page;
    for (const sel of [".focus-saved-card button", ".focus-last-set"]) {
      const loc = p.locator(sel);
      if (await loc.count()) {
        await loc.first().click();
        await sleep(600);
        return;
      }
    }
    await p.getByRole("button", { name: /fix last/i }).first().click();
    await sleep(600);
  }

  async setUnit(u) {
    const sw = this.page.getByRole("button", { name: u === "lb" ? /show weights in pounds/i : /show weights in kilograms/i });
    if (this.v3 && !(await sw.count())) await this.openWorkoutSheet();
    await sw.first().click();
    await sleep(350);
    if (this.v3) await this.closeSheet();
    this.curUnit = u;
  }

  async stepUp(fine = false) {
    const re = /^increase load by/i;
    const b = this.page.getByRole("button", { name: re });
    const inSheet = (await this.page.locator(".correction-sheet").count()) > 0;
    await (inSheet ? b.last() : fine ? b.first() : b.last()).click();
    await sleep(250);
  }
  async stepDown(fine = false) {
    const re = /^decrease load by/i;
    const b = this.page.getByRole("button", { name: re });
    const inSheet = (await this.page.locator(".correction-sheet").count()) > 0;
    await (inSheet ? b.last() : fine ? b.last() : b.first()).click();
    await sleep(250);
  }

  async pad(text, kind = "load", nth = 0) {
    const p = this.page;
    const target = p.getByRole("button", { name: new RegExp(`^${kind} value — tap to type`) });
    const inSheet = (await p.locator(".correction-sheet").count()) > 0;
    await (inSheet ? target.last() : target.nth(nth)).click();
    await sleep(300);
    for (const ch of text) {
      if (ch === ".") await p.locator(".pad-key", { hasText: /^\.$/ }).click();
      else await p.locator(".pad-key", { hasText: new RegExp(`^${ch}$`) }).click();
    }
    await p.locator(".pad-done").click();
    await sleep(350);
  }

  /** via "dock": the Plates button in the focus dock; via "more": the More
   *  sheet's PLATE CALCULATOR. Falls back to the other when one is absent. */
  async openPlates(via = "dock") {
    const p = this.page;
    const dock = p.getByRole("button", { name: /^plates$/i });
    const caption = p.getByRole("button", { name: /per side|^bar only|^sled only|^no plates/i });
    if (via === "dock" && (await dock.count())) {
      await dock.first().click();
    } else if (via === "dock" && this.v3 && (await caption.count())) {
      await caption.first().click();
    } else {
      await p.getByRole("button", { name: /more options for/i }).first().click();
      await sleep(500);
      await p.getByRole("button", { name: /plate calculator/i }).first().click();
    }
    await sleep(500);
  }
  async closeSheet() {
    const p = this.page;
    for (let i = 0; i < 3; i++) {
      // ux/skin renders the sheet's dismissal as a visual "×" plus an sr-only
      // "CLOSE" (textContent "×CLOSE"), so match the accessible name — what a
      // screen-reader user and getByRole see — not the visible text.
      const close = p.getByRole("button", { name: /^close$/i });
      if (!(await close.count())) break;
      await close.last().click({ timeout: 3000 }).catch(() => p.keyboard.press("Escape"));
      await sleep(400);
    }
  }

  /** Tap LOG and report the writes it produced, compared with the screen
   *  as it was just before the tap. `typed` is {value, unit} when the number
   *  on screen was typed on the pad. */
  /** Screenshot (once) every mismatch raised since `from` that has none yet. */
  async attachShots(from, desc) {
    const missing = this.mismatches.slice(from).filter((m) => !m.shot);
    if (!missing.length) return;
    const shot = await this.shot(desc);
    for (const m of missing) m.shot = shot;
  }

  async log(desc, { typed = null, perSide = null, expectReps = null, noWrite = false } = {}) {
    const p = this.page;
    const mFrom = this.mismatches.length;
    const before = await this.snap(`before ${desc}`);
    const btnRe = /^(log (set|warmup|extra set)\b.*|log a\d|done|save set \d+|save correction)$/i;
    let btn = p.getByRole("button", { name: btnRe }).first();
    if ((await p.locator(".correction-sheet").count()) > 0) btn = p.getByRole("button", { name: /^save correction$/i }).first();
    else if (!(await btn.count())) {
      const extra = p.getByRole("button", { name: /^\+ extra set$/i });
      if (await extra.count()) {
        await extra.first().click();
        await sleep(500);
        btn = p.getByRole("button", { name: btnRe }).first();
      }
    }
    await btn.click();
    await sleep(700);
    const fresh = await this.drain(desc);
    const sets = fresh.filter((f) => f.op.kind === "insert" && f.op.table === "sets");
    if (!sets.length && !noWrite) {
      // Nothing was queued. A checkout that validates a set before queueing it
      // (the outbox load gate) must say so on screen; a silent no-op is a defect.
      const alerts = await p.evaluate(() => [...document.querySelectorAll('[role="alert"], .log-error, .superset-round-error')].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => e.innerText.replace(/\s+/g, " ").trim()));
      const shot = await this.shot(`no-write-${desc}`);
      if (alerts.length)
        this.mismatches.push({ run: this.name, step: desc, kind: "log-refused", severity: "info", detail: `the UI refused the set: "${alerts.join(" / ").slice(0, 200)}"`, shot });
      else
        this.mismatches.push({ run: this.name, step: desc, kind: "log-no-write", detail: "LOG produced no write and no on-screen explanation", shot });
    }
    for (const f of sets) {
      this.sets.push(f);
      f.expect = { typed, displayUnit: before.unit, shownValue: before.shown, perHand: before.perHand };
      this.compareSet(f.op.payload, before, { desc, typed, perSide, expectReps });
    }
    await this.hideRest();
    const after = await this.snap(`after ${desc}`);
    this.checkLastSet(sets.map((f) => f.op.payload), after, desc);
    await this.attachShots(mFrom, desc);
    return sets.map((f) => f.op.payload);
  }

  /** The LAST SET card must say what was just written, in the display unit. */
  checkLastSet(written, after, desc) {
    const last = written[written.length - 1];
    const card = after.raw.lastSet;
    const id = after.exerciseName ? EX_ID[after.exerciseName] : null;
    if (!last || !card || id !== last.exercise_id) return;
    const m = /(\d+(?:\.\d+)?)\s*(lb|kg)(\/side| each)?\s*×\s*(\d+)/.exec(card);
    if (!m) return;
    const unit = after.unit;
    const per = last.load_entry === "per_side";
    const f = unit === "lb" ? KG_PER_LB : 1;
    const want = last.load_kg / f / (per ? 2 : 1);
    const issues = [];
    if (m[2] !== unit) issues.push(`card unit ${m[2]} but display unit ${unit}`);
    if (Math.abs(parseFloat(m[1]) - want) > 0.06) issues.push(`card shows ${m[1]} ${m[2]}${m[3] ?? ""} but the write is ${last.load_kg} kg (= ${r1(want)} ${unit}${per ? "/side" : ""})`);
    if (parseInt(m[4], 10) !== last.reps) issues.push(`card reps ${m[4]} vs ${last.reps}`);
    for (const d of issues) this.mismatches.push({ run: this.name, step: desc, kind: "last-set-card", detail: d, card });
  }

  compareSet(set, before, { desc, typed, perSide, expectReps }) {
    const issue = (kind, detail) => {
      const i = { run: this.name, step: desc, kind, detail, payload: set };
      this.mismatches.push(i);
    };
    const unit = before.unit;
    const f = unit === "lb" ? KG_PER_LB : 1;
    const per = set.load_entry === "per_side";
    if (before.shown != null && set.load_kg > 0) {
      const mult = before.perHand ? 2 : 1;
      const expectKg = before.shown * f * mult;
      const tol = 0.06 * f * mult + 0.011;
      if (Math.abs(set.load_kg - expectKg) > tol)
        issue("load-vs-screen", `screen showed ${before.shown} ${unit}${before.perHand ? " per hand" : ""} (= ${r2(expectKg)} kg) but load_kg = ${set.load_kg}`);
      if (before.perHand !== per) issue("entry-vs-screen", `screen per-hand=${before.perHand} but load_entry=${set.load_entry}`);
    }
    const expectId = before.exerciseName && EX_ID[before.exerciseName] ? EX_ID[before.exerciseName] : null;
    if (expectId && set.exercise_id !== expectId && !/superset/.test(desc))
      issue("wrong-exercise", `screen showed ${before.exerciseName} but the set is for ${set.exercise_id}`);
    const rxIdx = /^live-rx-(\d+)$/.exec(set.prescription_id ?? "");
    if (rxIdx && PLAN[Number(rxIdx[1])] && PLAN[Number(rxIdx[1])].set_type !== set.set_type)
      issue("set-type", `prescription ${set.prescription_id} is ${PLAN[Number(rxIdx[1])].set_type} but the set was written as ${set.set_type}`);
    // what the coach prescribed vs what an untouched set wrote
    if (rxIdx && PLAN[Number(rxIdx[1])] && /unchanged|untouched|next set after mid-rest|superset round [23]/i.test(desc)) {
      const rx = PLAN[Number(rxIdx[1])];
      if (rx.load_kg != null) {
        const drift = Math.round((set.load_kg - rx.load_kg) * 100) / 100;
        if (Math.abs(drift) > 0.0051)
          this.mismatches.push({
            run: this.name, step: desc, kind: "authored-drift", severity: "info",
            detail: `prescribed ${rx.load_kg} kg (${rx.entered_load ?? "?"} ${rx.entered_unit ?? ""}), logged untouched as ${set.load_kg} kg (${set.entered_load} ${set.entered_unit}); drift ${drift} kg`,
          });
      }
    }
    if (!typed && before.unit === "lb" && before.shown != null && /\.\d\d/.test(String(before.shown)))
      issue("display-precision", `lb draft shown as ${before.shown} (more than the one decimal every other lb figure uses)`);
    if (typed) {
      if (set.entered_load !== typed.value || set.entered_unit !== typed.unit)
        issue("typed-vs-entered", `typed ${typed.value} ${typed.unit} but entered_load/unit = ${set.entered_load} ${set.entered_unit}`);
    }
    if (perSide != null && per !== perSide) issue("per-side", `expected per_side=${perSide}, got ${set.load_entry}`);
    if (expectReps != null && set.reps !== expectReps) issue("reps", `expected ${expectReps} got ${set.reps}`);
  }

  async close() {
    this.finished = {
      name: this.name,
      unit: this.unit,
      steps: this.steps,
      setCount: this.sets.length,
      serverRows: await this.page.evaluate(() => {
        const s = window.__demo?.store;
        return s ? { sets: s.sets.filter((x) => x.session_id && String(x.id).length > 20 || !String(x.id).startsWith("sess-")).length } : null;
      }).catch(() => null),
    };
    await this.ctx.close();
    report.scenarios.push(this.finished);
    report.mismatches.push(...this.mismatches);
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------ scenarios -----

const EX_ID = {
  "Barbell Squat": "Barbell_Squat",
  "Barbell Bench Press": "Barbell_Bench_Press",
  "Romanian Deadlift": "Romanian_Deadlift",
  "Seated Dumbbell Press": "Seated_Dumbbell_Press",
  "Dumbbell Bicep Curl": "Dumbbell_Bicep_Curl",
  "Face Pull": "Face_Pull",
  "Triceps Pushdown": "Triceps_Pushdown",
  "Leg Press": "Leg_Press",
  Pullups: "Pullups",
  "Barbell Deadlift": "Barbell_Deadlift",
  "Hammer Curls": "Hammer_Curls",
  "Lat Pulldown": "Lat_Pulldown",
};
const FIRST = {
  barbell: "Barbell Squat",
  "bench-unit-switch": "Barbell Bench Press",
  "rdl-lb-authored": "Romanian Deadlift",
  "plate-sheet": "Barbell Squat",
  "plate-sheet-via-more": "Barbell Squat",
  "plate-sweep": "Barbell Squat",
  "leg-press-sled": "Leg Press",
  stack: "Lat Pulldown",
  "dumbbell-per-side": "Seated Dumbbell Press",
  "bodyweight-plus-load": "Pullups",
  superset: "Face Pull",
  corrections: "Barbell Deadlift",
  "mid-rest-unit-switch": "Hammer Curls",
  "offline-sync": "Barbell Squat",
  "extra-sets-and-finish": "Barbell Squat",
  "boundary-typed": "Lat Pulldown",
  "finish-record": "Barbell Squat",
};
const other = (u) => (u === "lb" ? "kg" : "lb");
const SCENARIOS = {};

SCENARIOS["barbell"] = async (r, unit) => {
  const base = unit === "lb" ? 45 : 20;
  await r.select("Barbell Squat");
  await r.snap("squat: lb-authored 135 lb warmup in " + unit, { base });
  await r.log("squat warmup unchanged");
  await r.snap("squat: kg-authored 100 kg working in " + unit, { base });
  await r.stepUp();
  await r.snap("squat: step up from prescription", { base });
  await r.log("squat working after +step");
  await r.stepDown();
  await r.stepDown();
  await r.snap("squat: two steps down", { base });
  await r.log("squat working after -2 steps");
  // the plan is complete: the app moves on, so come back for extra sets
  await r.tryBlock("squat extras", async () => {
    await r.select("Barbell Squat");
    await r.snap("squat: reopened after the plan is complete", { base });
    const typed = unit === "lb" ? ["225", 225] : ["102.5", 102.5];
    await r.pad(typed[0]);
    await r.snap(`squat: typed ${typed[0]} ${unit}`, { base });
    await r.log(`squat extra typed ${typed[0]}`, { typed: { value: typed[1], unit } });
    await r.select("Barbell Squat");
    await r.pad("44.1");
    await r.snap(`squat: typed 44.1 ${unit}`, { base });
    await r.log(`squat extra typed 44.1`, { typed: { value: 44.1, unit } });
    await r.select("Barbell Squat");
    await r.pad("137.5");
    await r.log(`squat extra typed 137.5 (not plate-able exactly in lb)`, { typed: { value: 137.5, unit } });
  });
};

SCENARIOS["bench-unit-switch"] = async (r, unit) => {
  const o = other(unit);
  const base = (u) => (u === "lb" ? 45 : 20);
  await r.select("Barbell Bench Press");
  await r.snap("bench: kg-authored 102.5 kg in " + unit, { base: base(unit) });
  await r.log("bench prescription unchanged");
  await r.stepUp();
  await r.setUnit(o);
  await r.snap(`bench: stepped in ${unit}, switched to ${o} mid-draft`, { base: base(o) });
  await r.log(`bench logged after switching ${unit}->${o}`);
  await r.setUnit(unit);
  await r.stepDown();
  await r.snap(`bench: back to ${unit}, step down`, { base: base(unit) });
  await r.log(`bench step in ${unit} after round trip`);
  // type in the other unit, then switch back before logging (extra set)
  await r.tryBlock("bench extra", async () => {
    await r.select("Barbell Bench Press");
    await r.setUnit(o);
    await r.pad(o === "lb" ? "225" : "100");
    await r.setUnit(unit);
    await r.snap(`bench: typed ${o === "lb" ? "225 lb" : "100 kg"} then switched to ${unit}`);
    await r.log(`bench typed in ${o} logged in ${unit} view`, { typed: { value: o === "lb" ? 225 : 100, unit: o } });
    await r.setUnit(unit);
  });
};

SCENARIOS["rdl-lb-authored"] = async (r, unit) => {
  await r.select("Romanian Deadlift");
  await r.snap("rdl: lb-authored 225 lb in " + unit, { base: unit === "lb" ? 45 : 20 });
  await r.log("rdl prescription unchanged");
  await r.stepUp();
  await r.log("rdl +step");
  await r.tryBlock("rdl extra", async () => {
    await r.select("Romanian Deadlift");
    await r.stepDown();
    await r.stepDown();
    await r.log("rdl extra -2 steps");
  });
};

const plateSheet = (via) => async (r, unit) => {
  await r.select("Barbell Squat");
  const base0 = unit === "lb" ? 45 : 20;
  await r.openPlates(via);
  await r.snap("plate sheet opened (prescription target)", { base: base0 });
  await r.page.getByRole("button", { name: /type a target load/i }).click();
  await sleep(300);
  const target = unit === "lb" ? "315" : "142.5";
  for (const ch of target) await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch === "." ? "\\." : ch}$`) }).click();
  await r.page.locator(".pad-done").click();
  await sleep(500);
  await r.snap(`plate sheet: typed target ${target} ${unit}`, { base: base0 });
  const sled = unit === "lb" ? "75" : "35";
  let baseApplied = false;
  await r.tryBlock("plate sheet base weight controls", async () => {
  // step the base weight down (bar 45 lb -> 40 lb; 20 kg -> 17.5 kg), then type 0 and a sled base
  await r.page.getByRole("button", { name: /decrease base weight/i }).click();
  await sleep(300);
  await r.snap("plate sheet: base stepped down once", {});
  await r.page.getByRole("button", { name: /^type$/i }).click();
  await sleep(300);
  for (const ch of "0") await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch}$`) }).click();
  await r.page.locator(".pad-done").click();
  await sleep(500);
  await r.snap("plate sheet: base typed 0", { base: 0 });
  await r.page.getByRole("button", { name: /^(type|set sled weight|set bar weight)$/i }).click();
  await sleep(300);
  for (const ch of sled) await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch}$`) }).click();
  await r.page.locator(".pad-done").click();
  await sleep(500);
  await r.snap(`plate sheet: base typed ${sled} ${unit}`, { base: Number(sled) });
  baseApplied = true;
  });
  await r.closeSheet();
  await r.expectShown(Number(target), `dock after typing target ${target} ${unit} on the plate sheet`, baseApplied ? { base: Number(sled) } : {});
  await r.log(`squat with typed target ${target} ${unit} and base ${sled}`, { typed: { value: Number(target), unit } });
  await r.tryBlock("restore bar", async () => {
  // restore the bar
  await r.openPlates(via);
  await r.page.getByRole("button", { name: /^type$/i }).click();
  await sleep(300);
  for (const ch of String(base0)) await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch}$`) }).click();
  await r.page.locator(".pad-done").click();
  await sleep(400);
  await r.snap("plate sheet: bar restored", { base: base0 });
  await r.closeSheet();
  });
};

SCENARIOS["plate-sheet"] = plateSheet("dock");
SCENARIOS["plate-sheet-via-more"] = plateSheet("more");

SCENARIOS["plate-sweep"] = async (r, unit) => {
  // Pure display: type a spread of totals (round plates, odd decimals, below
  // the bar, unbuildable) and compare the plate caption with the arithmetic.
  const bar = unit === "lb" ? 45 : 20;
  const values = unit === "lb"
    ? [44.5, 45, 47.5, 50, 95, 100.5, 115, 125, 133, 135, 137.5, 145, 185, 205, 222.2, 225, 225.4, 245, 275, 315, 365, 405, 455, 500]
    : [19, 20, 20.5, 22.5, 25, 30, 40, 57.3, 60, 61.2, 62.5, 70, 82.5, 100, 100.1, 102.5, 120, 142.4, 142.5, 180, 200, 227.5];
  await r.select("Barbell Squat");
  for (const v of values) {
    await r.pad(String(v));
    await r.snap(`sweep ${v} ${unit} on a ${bar} ${unit} bar`, { base: bar });
  }
  // a plate-loaded base: 0 (sled) and 75 lb / 35 kg
  await r.tryBlock("sweep with other bases", async () => {
    for (const baseVal of [0, unit === "lb" ? 75 : 35]) {
      await r.openPlates("dock");
      await r.page.getByRole("button", { name: /^type$/i }).click();
      await sleep(300);
      for (const ch of String(baseVal)) await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch}$`) }).click();
      await r.page.locator(".pad-done").click();
      await sleep(400);
      await r.closeSheet();
      const vals = unit === "lb" ? [100, 135, 137.5, 225, 315] : [60, 61.2, 100, 142.5];
      for (const v of vals) {
        await r.pad(String(v));
        await r.snap(`sweep ${v} ${unit} on a ${baseVal} ${unit} base`, { base: baseVal });
      }
    }
  });
};

SCENARIOS["leg-press-sled"] = async (r, unit) => {
  await r.select("Leg Press");
  await r.snap("leg press: lb-authored 300 lb in " + unit);
  await r.log("leg press prescription unchanged");
  await r.pad(unit === "lb" ? "410" : "185");
  await r.log("leg press typed", { typed: { value: unit === "lb" ? 410 : 185, unit } });
};

SCENARIOS["stack"] = async (r, unit) => {
  await r.select("Lat Pulldown");
  await r.snap("lat pulldown: kg-authored 72.5 kg in " + unit);
  await r.setUnit(other(unit));
  await r.snap(`lat pulldown: switched ${unit}->${other(unit)} untouched`);
  await r.log(`lat pulldown logged after ${unit}->${other(unit)} switch, number untouched`);
  await r.setUnit(unit);
  await r.snap(`lat pulldown: switched back to ${unit}`);
  await r.log("lat pulldown prescription unchanged after round trip");
  await r.stepUp();
  await r.log("lat pulldown +step");
  await r.pad(unit === "lb" ? "130" : "60");
  await r.log("lat pulldown typed", { typed: { value: unit === "lb" ? 130 : 60, unit } });
};

SCENARIOS["dumbbell-per-side"] = async (r, unit) => {
  await r.select("Seated Dumbbell Press");
  await r.snap("db press: 50 lb/side authored in " + unit);
  await r.log("db press prescription unchanged", { perSide: true });
  await r.stepUp();
  await r.log("db press +step", { perSide: true });
  await r.pad(unit === "lb" ? "50" : "22.5");
  await r.log("db press typed per hand", { typed: { value: unit === "lb" ? 50 : 22.5, unit }, perSide: true });
  await r.tryBlock("per-hand toggle", async () => {
    if (r.v3) {
      // the toggle lives in the More sheet: "each hand" / "one total weight"
      await r.page.getByRole("button", { name: /more options for/i }).first().click();
      await sleep(400);
      await r.page.getByRole("button", { name: /^(each hand|one total weight)$/i }).first().click();
      await sleep(400);
      await r.closeSheet();
    } else {
      await r.toList();
      const tog = r.page.getByRole("button", { name: /switch to one total weight/i });
      if (!(await tog.count())) {
        report.notes.push(`${r.name}: no per-hand toggle reachable in list view`);
        return;
      }
      await tog.first().click();
      await sleep(400);
    }
    await r.snap("db press: toggled to ONE TOTAL WEIGHT");
    await r.pad(unit === "lb" ? "100" : "45");
    await r.snap("db press: typed total");
    await r.log("db press typed as one total weight", { typed: { value: unit === "lb" ? 100 : 45, unit }, perSide: false });
  });
};

SCENARIOS["bodyweight-plus-load"] = async (r, unit) => {
  await r.select("Pullups");
  await r.snap("pullups: bodyweight");
  await r.log("pullups bodyweight", { expectReps: 6 });
  await r.tryBlock("weighted pullups", async () => {
    if (r.v3) {
      // added load is stepped (no number pad): + Add load, then the +/- on the chip
      await r.page.getByRole("button", { name: /add load/i }).first().click();
      await sleep(400);
      const up = r.page.getByRole("button", { name: /^increase added load by/i });
      await up.first().click();
      await sleep(250);
      await up.first().click();
      await sleep(250);
      const chip = (await r.page.locator(".dock-added-load-text").first().innerText()).replace(/\s+/g, " ");
      const shownAdded = parseFloat(/\+\s*([\d.]+)/.exec(chip)?.[1] ?? "NaN");
      await r.snap(`pullups: added load stepped to ${chip}`);
      const [set] = await r.log("pullups weighted (stepped)");
      const f = unit === "lb" ? KG_PER_LB : 1;
      if (set && Math.abs(set.load_kg - shownAdded * f) > 0.06 * f + 0.011)
        r.mismatches.push({ run: r.name, step: "pullups weighted (stepped)", kind: "load-vs-screen", detail: `chip said "${chip}" (${r2(shownAdded * f)} kg) but load_kg = ${set.load_kg}` });
      return;
    }
    await r.select("Pullups");
    await r.toList();
    const lv = r.page.getByRole("button", { name: /^load value — tap to type/ });
    if (await lv.count()) {
      await r.pad(unit === "lb" ? "25" : "10");
      await r.snap("pullups: added load typed");
      await r.log("pullups weighted", { typed: { value: unit === "lb" ? 25 : 10, unit } });
    } else report.notes.push(`${r.name}: no load field for bodyweight`);
  });
};

SCENARIOS["superset"] = async (r, unit) => {
  const o = other(unit);
  await r.select("Face Pull");
  await r.snap("superset round 1 shown in " + unit);
  await r.checkSupersetTargets("superset round 1 shown in " + unit);
  if (r.v3) {
    // one dock, members logged one after the other (A1 then A2)
    await r.pad(unit === "lb" ? "60" : "27.5");
    await r.log("superset round 1 A1 typed", { typed: { value: unit === "lb" ? 60 : 27.5, unit } });
    await r.log("superset round 1 A2 as prescribed");
    await r.setUnit(o);
    await r.snap(`superset: round 2 after switching ${unit}->${o}`);
    await r.log(`superset round 2 A1 (switched to ${o})`);
    await r.log(`superset round 2 A2 (switched to ${o})`);
    await r.setUnit(unit);
    await r.log("superset round 3 A1");
    await r.log("superset round 3 A2");
    return;
  }
  const loads = r.page.getByRole("button", { name: /^load value — tap to type/ });
  const nLoads = await loads.count();
  if (nLoads < 2) {
    report.notes.push(`${r.name}: superset did not render two load editors (${nLoads})`);
    return;
  }
  const logRound = async (desc) => {
    const before = await r.snap(`before ${desc}`);
    await r.page.getByRole("button", { name: /^log round$|^log .* only$/i }).first().click();
    await sleep(800);
    const fresh = await r.drain(desc);
    const mFrom = r.mismatches.length;
    for (const f of fresh.filter((x) => x.op.table === "sets")) {
      r.sets.push(f);
      f.expect = { typed: null, displayUnit: before.unit, shownValue: null, perHand: false };
      r.compareSet(f.op.payload, { ...before, shown: null }, { desc, typed: null, perSide: null, expectReps: null });
    }
    await r.attachShots(mFrom, desc);
    await r.hideRest();
    await r.snap(`after ${desc}`);
    return fresh.filter((x) => x.op.table === "sets").map((x) => x.op.payload);
  };
  // round 1: member A typed, member B as prescribed
  await r.pad(unit === "lb" ? "60" : "27.5", "load", 0);
  await r.snap("superset: A typed");
  await logRound("superset round 1");
  // round 2: switch units with both members staged, then log
  await r.setUnit(o);
  await r.snap(`superset: round 2 after switching ${unit}->${o}`);
  await logRound(`superset round 2 (switched to ${o})`);
  await r.setUnit(unit);
  await r.snap("superset: round 3 back in " + unit);
  await logRound("superset round 3");
};

SCENARIOS["superset-from-warmup"] = async (r, unit) => {
  // The natural order of the day: the first exercise has a staged WARMUP set,
  // then the lifter jumps (overview) to a superset whose prescriptions are
  // all working sets.
  await r.snap("first exercise open with a staged warmup");
  await r.select("Face Pull");
  await r.snap("jumped to the superset");
  await r.checkSupersetTargets("jumped to the superset");
  if (r.v3) {
    await r.log("superset round 1 A1 after jumping from a warmup exercise");
    await r.log("superset round 1 A2");
    return;
  }
  const before = await r.snap("before superset round 1");
  const btn = r.page.getByRole("button", { name: /^log round$|^log .* only$/i }).first();
  await btn.click();
  await sleep(800);
  const fresh = await r.drain("superset round 1 after jumping from a warmup exercise");
  const mFrom = r.mismatches.length;
  for (const f of fresh.filter((x) => x.op.table === "sets")) {
    r.sets.push(f);
    f.expect = { typed: null, displayUnit: before.unit, shownValue: null, perHand: false };
    r.compareSet(f.op.payload, { ...before, shown: null }, { desc: "superset round 1 after jumping from a warmup exercise", typed: null, perSide: null, expectReps: null });
  }
  await r.attachShots(mFrom, "superset after jumping from a warmup exercise");
  await r.hideRest();
  await r.snap("after superset round 1");
  const left = await r.page.getByRole("button", { name: /^log round$/i }).count();
  if (!left)
    r.mismatches.push({ run: r.name, step: "superset round 2", kind: "round-stuck", detail: "after round 1 the Log round button is gone (only a single-member log is offered)", shot: await r.shot("round-stuck") });
};

SCENARIOS["corrections"] = async (r, unit) => {
  const o = other(unit);
  await r.select("Barbell Deadlift");
  await r.snap("deadlift: %TM prescription in " + unit);
  await r.log("deadlift %TM unchanged");
  await r.tryBlock("corrections", async () => {
  // Fix last in the OTHER unit
  await r.setUnit(o);
  await r.openFix();
  await r.snap(`correction opened in ${o} (set logged in ${unit})`);
  const typedVal = o === "lb" ? "315" : "142.5";
  await r.pad(typedVal);
  await r.snap(`correction: typed ${typedVal} ${o}`);
  await r.log(`correction typed ${typedVal} ${o}`, { typed: { value: Number(typedVal), unit: o } });
  // second correction of the same set with a fine step
  await r.openFix();
  await r.stepUp(true);
  await r.snap("correction: fine step");
  await r.log("correction after fine step");
  // reps-only correction: the old authored pair must survive
  await r.setUnit(unit);
  await r.openFix();
  await r.page.getByRole("button", { name: /increase reps by 1/i }).last().click();
  await sleep(250);
  await r.log("correction reps only");
  // switch units while a correction is open, then save
  await r.openFix();
  if (!r.v3) {
    await r.setUnit(o);
    await r.stepUp();
    await r.snap(`correction: unit switched to ${o} mid-edit, stepped`);
    await r.log(`correction saved after unit switch to ${o} mid-edit`);
    await r.setUnit(unit);
  } else {
    await r.stepUp();
    await r.log("correction after a step (the unit switch is not reachable while a correction sheet is open)");
  }
  // no-op correction
  await r.openFix();
  await r.log("correction no-op", { noWrite: true });
  });
};

SCENARIOS["mid-rest-unit-switch"] = async (r, unit) => {
  await r.select("Hammer Curls");
  await r.snap("hammer curls legacy 17.5 kg (no authored pair) in " + unit);
  await r.log("hammer curls unchanged");
  await r.setUnit(other(unit));
  await r.snap("hammer curls: unit switched during rest");
  await r.log("hammer curls next set after mid-rest switch");
  await r.setUnit(unit);
  await r.tryBlock("hammer extra", async () => {
    await r.select("Hammer Curls");
    await r.pad(unit === "lb" ? "40" : "17.5");
    await r.log("hammer curls extra set", { typed: { value: unit === "lb" ? 40 : 17.5, unit } });
  });
};

SCENARIOS["boundary-typed"] = async (r, unit) => {
  // Numbers the pad can produce (6 keys, one dot). The database re-derives
  // load_kg from the typed value with exact decimal arithmetic and rounds
  // half away from zero; the client rounds a binary float.
  const total = unit === "kg"
    ? ["1.005", "0.145", "12.345", "10000", "99999", "2500", "0.01", "9999.9"]
    : ["99999", "2500", "0.01", "1.005", "225.55", "22046"];
  for (const t of total) {
    await r.tryBlock(`boundary ${t}`, async () => {
      await r.select("Lat Pulldown");
      await r.pad(t);
      await r.snap(`typed ${t} ${unit} (total)`);
      await r.log(`typed boundary ${t} ${unit} total`, { typed: { value: Number(t), unit } });
    });
  }
  // per hand: doubled by the app
  for (const t of unit === "kg" ? ["1.005", "6000"] : ["1.005", "13000"]) {
    await r.tryBlock(`boundary per hand ${t}`, async () => {
      await r.select("Dumbbell Bicep Curl");
      await r.pad(t);
      await r.snap(`typed ${t} ${unit} (per hand)`);
      await r.log(`typed boundary ${t} ${unit} per hand`, { typed: { value: Number(t), unit }, perSide: true });
    });
  }
};

SCENARIOS["offline-sync"] = async (r, unit) => {
  await r.select("Barbell Squat");
  await r.page.evaluate(() => { window.__engine.offline = true; });
  await r.ctx.setOffline(true);
  await sleep(300);
  await r.pad(unit === "lb" ? "185" : "82.5");
  const a = await r.log("offline squat set A", { typed: { value: unit === "lb" ? 185 : 82.5, unit } });
  await r.stepUp();
  await r.setUnit(other(unit));
  const b = await r.log("offline squat set B (unit switched)");
  const queued = await r.page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open("strength-log"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const all = await new Promise((res) => { const t = db.transaction("outbox").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
    db.close();
    return all.map((x) => ({ table: x.op.table, status: x.status, retries: x.retries, err: x.last_error }));
  });
  report.notes.push(`${r.name}: offline outbox after 2 sets = ${JSON.stringify(queued)}`);
  const ids = r.sets.map((x) => x.op.payload.id);
  const serverHas = () => r.page.evaluate((ids) => ids.filter((id) => window.__demo.store.sets.some((s) => s.id === id)).length, ids);
  const beforeServer = await serverHas();
  await r.page.evaluate(() => { window.__engine.offline = false; });
  await r.ctx.setOffline(false);
  await r.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await sleep(2500);
  const afterServer = await serverHas();
  const afterQueue = await r.page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open("strength-log"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const all = await new Promise((res) => { const t = db.transaction("outbox").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
    db.close();
    return all.map((x) => ({ table: x.op.table, status: x.status, retries: x.retries, err: x.last_error }));
  });
  report.notes.push(`${r.name}: reconnect -> outbox ${JSON.stringify(afterQueue)}; offline sets present on the (mock) server before/after reconnect: ${beforeServer}/${afterServer} of ${ids.length}`);
  if (afterServer !== ids.length || afterQueue.length)
    r.mismatches.push({ run: r.name, step: "reconnect", kind: "offline-sync", detail: `after reconnect ${afterServer}/${ids.length} sets reached the server, outbox has ${afterQueue.length} item(s)` });
  r.offlineResult = { queued, afterQueue };
};

SCENARIOS["extra-sets-and-finish"] = async (r, unit) => {
  await r.select("Barbell Squat");
  for (let i = 0; i < 3; i++) await r.log(`squat planned set ${i + 1}`);
  await r.tryBlock("extra sets", async () => {
  await r.select("Barbell Squat");
  await r.snap("squat reopened after the plan is complete");
  report.notes.push(`${r.name}: "+ Extra set" offered after the plan was complete = ${Boolean(r.extraSeen)}`);
  await r.log("squat extra set 1");
  await r.select("Barbell Squat");
  await r.stepUp();
  await r.log("squat extra set 2 after +step");
  });
  // finish with a bodyweight typed in the display unit
  await r.finishWorkout();
  await r.snap("finish / end screen");
  report.notes.push(`${r.name}: end screen text = ${(await r.page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
};

SCENARIOS["finish-record"] = async (r, unit) => {
  await r.select("Barbell Squat");
  await r.log("record: squat warmup");
  await r.pad(unit === "lb" ? "227.5" : "102.5");
  await r.log("record: squat working typed", { typed: { value: unit === "lb" ? 227.5 : 102.5, unit } });
  await r.stepUp();
  await r.log("record: squat working +step");
  const written = r.sets.map((x) => x.op.payload);
  // finish
  await r.finishWorkout();
  await r.snap("end screen");
  const bw = r.page.getByRole("button", { name: /add bodyweight/i });
  const bwValue = unit === "lb" ? "180.5" : "81.9";
  if (await bw.count()) {
    await bw.first().click();
    await sleep(400);
    await r.page.getByRole("button", { name: /^bodyweight value — tap to type/ }).click();
    await sleep(300);
    for (const ch of bwValue) await r.page.locator(".pad-key", { hasText: new RegExp(`^${ch === "." ? "\\." : ch}$`) }).click();
    await r.page.locator(".pad-done").click();
    await sleep(400);
    await r.snap("end screen: bodyweight typed " + bwValue + " " + unit);
  } else report.notes.push(`${r.name}: no bodyweight control on the end screen`);
  await r.page.getByRole("button", { name: /^end session$/i }).first().click();
  await sleep(1500);
  const endOps = await r.drain("finish");
  for (const o of endOps.filter((x) => x.op.kind === "update" && x.op.patch?.bodyweight_kg != null)) {
    const typedBw = Number(bwValue);
    const kgWritten = o.op.patch.bodyweight_kg;
    const f = unit === "lb" ? KG_PER_LB : 1;
    const back = Math.round((kgWritten / f) * 10) / 10;
    if (Math.abs(back - typedBw) > 0.051)
      r.mismatches.push({ run: r.name, step: "end session", kind: "bodyweight-roundtrip", detail: `typed ${typedBw} ${unit}; bodyweight_kg=${kgWritten} reads back as ${back} ${unit}`, shot: await r.shot("bodyweight-roundtrip") });
    o.expect = { bodyweight: { typed: typedBw, unit } };
  }
  await r.snap("after end session");
  // Record / history
  await r.page.getByRole("link", { name: /record/i }).first().click().catch(() => {});
  await sleep(1200);
  let text = (await r.page.locator("body").innerText()).replace(/\s+/g, " ");
  if (!/RECENT SETS/i.test(text)) {
    // the newer Record lists lifts first: open the squat to see its sets
    await r.page.getByRole("button", { name: /^Barbell Squat\b/ }).first().click().catch(() => r.page.getByText(/^Barbell Squat/).first().click().catch(() => {}));
    await sleep(900);
    text = (await r.page.locator("body").innerText()).replace(/\s+/g, " ");
  }
  report.notes.push(`${r.name}: record screen text = ${text.slice(0, 900)}`);
  await r.shot("record");
  // every written set must appear in the display unit on Record (when sets are listed)
  const f = unit === "lb" ? KG_PER_LB : 1;
  const missing = written
    .map((w) => `${r1(w.load_kg / f)}`)
    .filter((v) => !text.includes(v) && !text.includes(String(Math.round(parseFloat(v)))));
  if (missing.length && /squat/i.test(text))
    r.mismatches.push({ run: r.name, step: "record", kind: "record-vs-written", detail: `Record does not show ${missing.join(", ")} ${unit}` });
};

// ---------------------------------------------------------------- main ------

const names = Object.keys(SCENARIOS).filter((n) => !ONLY || ONLY.includes(n));
let exitCode = 0;
for (const unit of UNITS) {
  for (const name of names) {
    const r = new Run(`${name}-${unit}`, unit);
    try {
      await r.open(FIRST[name] ?? null);
      await r.start();
      await SCENARIOS[name](r, unit);
    } catch (e) {
      const buttons = await r.page.locator("button:visible").evaluateAll((bs) => bs.map((b) => (b.getAttribute("aria-label") || b.innerText).replace(/\s+/g, " ").slice(0, 40))).catch(() => []);
      console.error(`   visible buttons: ${buttons.join(" ## ")}`);
      r.mismatches.push({ run: r.name, step: "scenario aborted", kind: "harness-error", detail: `${String(e.message).split("\n")[0].slice(0, 200)} @${(/live-load-sync\.mjs:(\d+)/.exec(e.stack ?? "") ?? [])[1]}`, shot: await r.shot("abort") });
      console.error(`[${r.name}] aborted: ${String(e.message).split("\n")[0]}`);
    }
    await r.drain("end").catch(() => {});
    await r.close().catch(() => {});
    console.log(`[${r.name}] ${r.sets.length} sets, ${r.mismatches.length} screen/payload mismatches`);
  }
}

await browser.close();
if (server) await server.close();

report.finishedAt = new Date().toISOString();
writeFileSync(path.join(outDir, `live-payloads-${label}.json`), JSON.stringify({ label, generatedAt: report.finishedAt, plan: PLAN, ops: payloads }, null, 1));
writeFileSync(path.join(outDir, `live-report-${label}.json`), JSON.stringify(report, null, 1));
console.log(`wrote ${payloads.length} outbox ops, ${report.mismatches.length} mismatches (${report.mismatches.filter((m) => m.severity !== "info").length} gating), ${consoleErrors.length} console errors -> ${outDir}`);

if (!args["no-replay"]) {
  const replay = path.resolve(here, "..", "..", "scripts", "replay-payloads.mjs");
  const res = spawnSync(process.execPath, [replay, path.join(outDir, `live-payloads-${label}.json`), "--out", path.join(outDir, `replay-${label}.json`), "--repo", path.dirname(pwaDir)], { stdio: "inherit" });
  if (res.status !== 0) exitCode = 1;
}
const allow = new Set(String(args.allow ?? "").split(",").filter(Boolean));
const failing = report.mismatches.filter((m) => m.severity !== "info" && !allow.has(m.kind));
if (failing.length) exitCode = 1;
process.exit(exitCode);
