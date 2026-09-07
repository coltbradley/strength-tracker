# Running these prototypes

They live here, not in `pwa/public/`, because everything under `public/` is
copied into the build and the service worker's `globPatterns` include `html`
and `css`. With them in place the precache went from **11 entries / 794 KiB**
to **25 entries / 907 KiB** — 14 extra files and 112 KiB downloaded and held
offline by every install, for design scratch no lifter ever opens.

They reference `/fonts/…` and `/tex/…` as absolute paths, so to run them:

```bash
# from the repo root — copy in, run, then discard the copies
cp -r docs/design-log/2026-09-07-world-class/prototypes pwa/public/proto
cp -r docs/design-log/2026-09-07-world-class/textures   pwa/public/tex
cp -r docs/design-log/2026-09-07-world-class/themes     pwa/public/themes
npm --prefix pwa run demo      # http://localhost:5199/proto/morph.html?state=barbell
```

Then delete `pwa/public/proto`, `pwa/public/tex` and `pwa/public/themes` again.
Do not commit them back.

## What is here

- `morph.html?state=…` — the six-state system, CREAM. The version that scored
  highest (8.8). States: `barbell`, `dumbbell`, `cable`, `bodyweight`, `carry`,
  `activation`.
- `iron.html?state=…` — the same architecture re-skinned as CAST IRON. Scored
  8.6; kept because the yellow pin is the best single moment in the set and
  because the reskin is the evidence for why cream stayed the base.
- `rail.html`, `deck*.html` — the earlier arc, barbell-only. Superseded, kept
  because the critiques reference them by name.
- `plates.js` — the prototypes' own naive plate maths. **The app does not use
  this.** `pwa/src/lib/plates.ts` is better and is what shipped.

The themes in `../themes/` are the five seed-string directions from the first
round. They are token-layer overlays for the REAL app, not for these files:
load one over `http://localhost:5199` with a `<link>` tag.
