# Group 06: Shared PWA interface and device settings

## Scope and evidence

Inspected `pwa/src/App.tsx`, `styles.css`, shared `Sheet`, `FabDock`, `Toasts`, and `Note`; `useDragList`, `useFabDrag`, `useSettings`, `useUnit`; `settings.ts` and `format.ts` with adjacent tests; PWA HTML, Vite/package/TypeScript configuration, public icons, and `scripts/make-icons.mjs`. Read the assigned audit README, active roadmap, release ledger, full `AGENTS.md`, and the listed 2026-09-19 audit leads.

Checks were source inspections using `nl`, `sed`, and `rg` to trace route state, settings persistence, accessible semantics, safe-area rules, and subpath asset URLs. No tests or builds were run, and no browser, screen reader, installed PWA, phone, or production behavior was exercised.

## Executive summary

Seven confirmed findings: 1 P1, 6 P2. The top risks are stale settings overwriting newer device preferences between tabs (G06-F01), screen-reader users receiving no toast announcements (G06-F02), and route changes leaving modal state and focus over a different screen (G06-F04). Four additional bounded navigation and deployment defects affect location context, unknown URLs, and installed icons under the supported subpath.

## Findings

### G06-F01. A stale tab can overwrite newer device settings

- **Severity:** P1. **Confidence:** High. **Existing audit:** A-187.
- **Trigger:** Two same-origin tabs remain open. Each tab loads one in-memory settings envelope; one tab changes a setting, then the stale tab changes any setting.
- **Evidence:** The module has a single in-memory `values` snapshot and only subscribes React listeners; it does not register a `storage` event listener (`pwa/src/lib/settings.ts:603-604`, `670-682`). A write mutates the snapshot and persists the entire envelope (`pwa/src/lib/settings.ts:647-663`, `695-706`).
- **Impact:** The later tab can restore older values for unrelated settings, including unit choice, plate inventory, and per-exercise equipment preferences. A later reload can therefore use stale logging or load-entry assumptions.
- **Fix boundary:** Merge or reload cross-tab changes before persisting, with a defined conflict policy that does not replace a newer envelope with an old snapshot.
- **Verification needed:** A two-context test where tab A changes one key and stale tab B changes another; confirm both survive in storage and both tabs update.

### G06-F02. Toasts are not announced to assistive technology

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-123.
- **Trigger:** Any error, confirmation, or status toast appears.
- **Evidence:** Toast text is rendered in ordinary `div` elements without a live region or status/alert role (`pwa/src/components/Toasts.tsx:16-25`). Current tests check visibility, pointer behavior, stack count, and styling, but no announcement semantics (`pwa/src/components/Toasts.test.tsx:22-58`).
- **Impact:** Screen-reader users may miss write confirmations and errors, including messages explaining queued or failed writes.
- **Fix boundary:** Add an announcement strategy to the shared toast surface, with urgency chosen by message kind and repeated-message behavior considered.
- **Verification needed:** Assert appropriate live-region semantics and manually verify representative informational and error messages with a screen reader.

### G06-F03. Route changes do not update the document title or move focus

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-126.
- **Trigger:** Navigation swaps a route, especially when the action unmounts the control that initiated it.
- **Evidence:** `App` changes route content inside `Routes` and provides no location effect, title update, route announcement, or heading focus (`pwa/src/App.tsx:107-125`). The only page title is the static `Strength Log` title in `pwa/index.html:14`.
- **Impact:** Keyboard and screen-reader users can remain at an unmounted control with no clear location context; browser and assistive-technology titles also remain generic.
- **Fix boundary:** Add a shared route-change policy for page title and focus/announcement, respecting routes such as an active session.
- **Verification needed:** Route-level tests for title and focus after tab navigation and a route transition that removes its initiating control; screen-reader smoke check.

### G06-F04. Browser navigation leaves global sheets open over the new route

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-194.
- **Trigger:** Open Settings, Coach, or Report, then use browser Back/Forward to change location.
- **Evidence:** Settings open state is owned by `Shell`, and the sheet is rendered independently of route content (`pwa/src/App.tsx:44-45`, `153-156`). `FabDock` keeps its own open state and renders Coach or Report sheets without any route-change close effect (`pwa/src/components/FabDock.tsx:21-24`, `150-153`).
- **Impact:** A modal and its focus trap remain over a different underlying screen; visible context and navigation state disagree.
- **Fix boundary:** Reconcile shared modal state with location changes, or represent modal navigation in history consistently.
- **Verification needed:** Browser Back/Forward tests from each global sheet and checks that the sheet closes (or history first closes it) and focus returns to a valid control on the current route.

### G06-F05. Unknown deep links render the Train screen under an invalid URL

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-196.
- **Trigger:** Open or navigate to any path not matched by a declared route.
- **Evidence:** The wildcard route renders Today in Train presentation without redirecting or displaying a not-found state (`pwa/src/App.tsx:121-124`).
- **Impact:** A stale or mistyped link appears to be a valid Train screen while the URL remains invalid; there is no matching active tab and actions can report the bad path as their route context.
- **Fix boundary:** Give unknown paths an explicit not-found/redirect behavior and preserve the chosen URL semantics.
- **Verification needed:** Tests for direct unknown URLs and Back/Forward through one, including the active navigation state.

### G06-F06. HTML icon links bypass the configured deployment base path

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-132.
- **Trigger:** Build for a Pages subpath using `PAGES_BASE`, then load the deployed page or install it from that location.
- **Evidence:** Vite config derives `base` from `PAGES_BASE` and documents subpath support (`pwa/vite.config.ts:6-11`), while HTML requests the favicon and Apple touch icon from root paths (`pwa/index.html:12-13`).
- **Impact:** At `/strength-tracker/`, those requests target `/icons/...` outside the deployment prefix, so browser and home-screen icons can be missing even though manifest assets use relative paths (`pwa/vite.config.ts:15-35`).
- **Fix boundary:** Make static HTML icon URLs honor Vite's configured base path.
- **Verification needed:** Build with a non-root `PAGES_BASE`, then inspect emitted HTML and verify the icon requests resolve under that prefix.

### G06-F07. Settings writes report success after storage persistence fails

- **Severity:** P2. **Confidence:** High. **Existing audit:** A-188, partially changed.
- **Trigger:** `localStorage` is unavailable or `setItem` throws during a setting change or reset.
- **Evidence:** `persist()` catches storage errors and emits a one-time error report but returns no success value (`pwa/src/lib/settings.ts:647-663`). `setSetting()` still notifies subscribers and returns `true` (`pwa/src/lib/settings.ts:695-706`); reset paths likewise notify after calling `persist()` (`pwa/src/lib/settings.ts:718-728`).
- **Impact:** The current tab applies the value in memory, while a reload restores old values or defaults. Callers cannot distinguish a durable change from a temporary one, so equipment or unit choices can unexpectedly revert.
- **Fix boundary:** Propagate persistence outcome to callers and make the settings UI clearly represent a failed save while retaining safe in-memory behavior if desired.
- **Verification needed:** Throwing-storage tests for set, single reset, and reset-all; confirm return/report/UI state reflects that nothing persisted.

## Opportunities

### G06-O01. Add a small cross-browser accessibility smoke gate

The shared sheet, route shell, sticky controls, and toasts define repeated app-wide behavior. A focused keyboard and screen-reader smoke checklist would catch regressions that component tests cannot model. Cost is ongoing manual verification across at least one desktop screen reader and one mobile assistive-technology setup; evidence needed is the actual supported browser/device matrix and release-owner time. This is an opportunity, separate from the confirmed defects above.

## Documentation gaps

- `pwa/src/lib/settings.ts:8-10` documents the persisted envelope as version 1, while current code declares `ENVELOPE_VERSION = 2` at line 490 (the current format claim should say version 2 and describe the v1-to-v2 migration).
- The 2026-09-19 system audit's A-188 wording says persistence errors are swallowed silently. Current code reports the first `persist()` failure through `reportError` (`pwa/src/lib/settings.ts:655-661`), but still returns success and applies memory state. Update the audit backlog wording to reflect that partial change when the central synthesis revalidates it.

## Handoffs

- Group 03: revalidate focus-mode exit target and safe-area controls (old A-127/A-128) in session-specific components; current shared stylesheet has bottom safe-area padding on `.focus-deck` (`pwa/src/styles.css:3292-3299`), so the old A-128 evidence no longer establishes a current defect.
- Group 04: revalidate plan navigation return path and plan editor input labels (old A-125/A-195), whose primary fixes belong to the planning screen.
- Group 05: revalidate End/History labels and nonvisual chart equivalents (old A-125/A-133); these are feature-owned surfaces.
- Group 10: coach stream announcements and coach composer label (old A-124/A-125), owned by the coach client surface.
- Group 13: update the central audit's A-188 wording after its status is reconciled with this finding.

## Open questions and limits

- A-127's old target-size concern belongs to the session focus controls and was not assessed as a group 06 finding. Current generic tap-target and focus-visible rules exist in `pwa/src/styles.css:341-402`, but they do not prove every feature control meets target-size requirements.
- A-125 spans report-bug, End, Plan, and Coach inputs. The shared sheet correctly labels its dialog with a heading, but this review did not duplicate feature-surface findings owned by other groups.
- Whether the subpath icon defect is user-visible in an actual Pages release was not tested in a browser; source paths and configured base establish the mismatch.
- The PWA baseline in the roadmap explicitly separates local engineering checks from phone/browser acceptance. This review supplies static source evidence only.
