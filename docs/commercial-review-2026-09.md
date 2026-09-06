# Commercial Viability Review

**Repository:** `coltbradley/strength-tracker`
**Reviewed at:** commit `027da82`, 58 commits, 2026-08-25 to 2026-09-05
**Review date:** 2026-09-06
**Method:** eleven parallel research agents over the codebase, the web, and current vendor pricing. Every claim below is either cited to a file and line, cited to a URL, or explicitly labelled an estimate.

---

## How to read this document

Part 0 is the answer. If you read nothing else, read Part 0 and Part 7.

Parts 1 through 6 are the evidence, organised by question. Part 7 is the development plan with day estimates and file paths. Part 8 is the decision framework: the gates, the kill criteria, and what to measure so you are not doing this again in six months from the same standing start.

Appendices hold the raw numbers, the competitor table, the full security finding list, and sources.

**Labelling convention used throughout:**

- **[MEASURED]** counted or read directly from the repository, or a published list price fetched during this review.
- **[ESTIMATED]** derived by arithmetic from measured inputs. The inputs are named.
- **[ASSERTED]** a vendor claim or a secondary source that could not be verified directly. Treat with suspicion.
- **[UNVERIFIED]** could not be reached at all. Named so you can check it yourself.

---

## Contents

**[PART 0: EXECUTIVE SUMMARY](#part-0-executive-summary)**
- 0.1 The answer
- 0.2 What I recommend
- 0.3 What would make sense (three framings, priced)
- 0.4 What you would have to do
- 0.5 The fifteen numbers that drive everything
- 0.6 What would change my mind

**[PART 1: THE ASSET](#part-1-the-asset)**. what exists, what it is good at, what is invisible
- 1.1 Build state and real-world evidence
- 1.2 Functionality inventory, screen by screen
- 1.3 Capability inventory (14 capabilities, rebuild cost vs visibility)
- 1.4 Quality signals
- 1.5 The single-user assumptions

**[PART 2: ECONOMICS](#part-2-economics)**. what it costs, what it can charge
- 2.1 What is in the code
- 2.2 Token weight
- 2.3 Pricing
- 2.4 Cost per turn, with the arithmetic
- 2.5 Cost per active user per month
- 2.6 Supabase cost at 100 / 1,000 / 10,000 users
- 2.7 The dashboard is lying (2.7x)
- 2.8 Gross margin and break-even
- 2.9 Abuse and caps

**[PART 3: THE MARKET](#part-3-the-market)**. competitors, distribution, churn
- 3.1 Consumer strength logging: pricing
- 3.2 AI coaching is table stakes
- 3.3 The MCP cohort teardown
- 3.4 Distribution (the worst news in the review)
- 3.5 Churn
- 3.6 The coach-client segment
- 3.7 Where the gap actually is

**[PART 4: SECURITY, PRIVACY AND LEGAL](#part-4-security-privacy-and-legal)**
- 4.1 What is genuinely fine
- 4.2 Blockers to selling (S1-S4)
- 4.3 Fix before paid users (F1-F9)
- 4.4 Top attacks ranked
- 4.5 Legal: licensing, health data, AI liability, payments, entity, app stores
- 4.6 The three legal gates

**[PART 5: ARCHITECTURE DECISIONS](#part-5-architecture-decisions)**
- 5.1 Supabase: stay
- 5.2 Hosting: move to Cloudflare Pages
- 5.3 The `mcp_writer` role
- 5.4 Staging
- 5.5 The MCP split: keep it
- 5.6 Inference architecture (4 stages, 8 levers)
- 5.7 What was rejected: the router, leaving Anthropic, BYOK, inlining the loop
- 5.8 The $0 punch list

**[PART 6: STRATEGIC OPTIONS](#part-6-strategic-options)**
- 6.1 Option A: keep it as a tool
- 6.2 Option B: MCP-first product
- 6.3 Option C: team strength and conditioning
- 6.4 Option D: research and credentialing
- 6.5 Option E: license or partner the schema
- 6.6 Rejected: consumer, rehab, tactical, corporate wellness, studios
- 6.7 The ranking
- 6.8 What the data model could and could not become

**[PART 7: THE DEVELOPMENT PLAN](#part-7-the-development-plan)**
- 7.1 Wave 0: hygiene, ~12 hours, unconditional
- 7.2 Wave 1: import + compliance view, 4-5 days
- 7.3 Wave 2: the gate, ~2 weeks, no code
- 7.4 Wave 3a: MCP-first product, 10-14 days
- 7.5 Wave 3b: team S&C, +8-12 days
- 7.6 What NOT to build
- 7.7 The honest subtraction

**[PART 8: DECISION FRAMEWORK](#part-8-decision-framework)**
- 8.1 The gates
- 8.2 Kill criteria
- 8.3 What to measure, and how
- 8.4 The framing question

**[APPENDICES](#appendices)**
- A: Every number, with its source
- B: Where the numbers came from, and what was blocked
- C: Security findings, consolidated
- D: Key file index
- E: The one-page version

---

# PART 0: EXECUTIVE SUMMARY

## 0.1 The answer

**Selling this as a consumer subscription does not work. The reason is structural, not a quality problem.**

Everything that is rare about this system is invisible to a buyer. Everything visible about it is commodity.

Of fourteen distinct capabilities identified in the code, exactly one is highly legible to a non-technical buyer (parsing a coach's screenshot into a structured program), and that one is the least defensible thing in the repository because every LLM wrapper shipped it in 2026. One more is visible only as the absence of failure (the offline outbox). The remaining twelve, including the ones that took months of production incidents to get right, cannot be perceived by a lifter at all.

The buyers who would pay for those twelve are in regulated markets: physiotherapy clinics billing remote therapeutic monitoring, clinical trial sponsors, apprenticeship registrars. Every one of those markets is gated by credentials, procurement relationships, or regulatory determinations that a solo developer cannot obtain with better code.

Meanwhile the consumer market has a specific, verifiable shape that closes it:

- You need roughly **$20/month** to break even on a coach feature that **Hevy bundles free inside a $2.99/month tier** with 16 million users and near-zero marginal cost.
- The MCP angle, which looked like the differentiator, was already tried and abandoned by the only funded player. **AthleteData relegated MCP-only to a $9 stripped SKU** and sells $39/month proactive coaching instead.
- Anthropic's connector directory holds **1,625 connectors and has no Health and Fitness category at all**. Seven fitness-adjacent entries exist. None of the nine named competitors is listed.
- A PWA has no App Store presence, so the one acquisition channel a solo developer can afford (ASO plus organic) is halved before you start, and the SEO half is now occupied by 40-plus competitors publishing comparison content at each other.

**And the honest evidentiary position:** this product has **one real user who is not you**. Three completed sessions, 41 sets, 13 coach turns, logged 2026-09-01 to 09-03. Everything else in this review, mine included, is theory stacked on that single data point.

## 0.2 What I recommend

Ranked, with the reasoning compressed. Full detail in Part 7.

### Recommendation 1: Do the twelve-hour hygiene pass this week, regardless of every other decision

These are not strategy. They are defects, exposures and free money. They pay for themselves even if you never take a dollar from anyone.

| # | Action | Time | Why |
|---|---|---|---|
| 1 | Set `COACH_ALLOWED_USERS` to your real user ids | 0 h | Closes the single largest security blocker (unbounded Anthropic spend from open signup) with an env var that already exists |
| 2 | Fix `v_coach_cost` to price Opus, not Sonnet | 1 h | Every cost figure your deployment has ever reported is understated 2.5x on tokens and 4x on cache writes |
| 3 | Run `scripts/coach-eval/run.mjs` against the real model config | 0.25 d, ~$40-80 | Built, never run. Worth roughly 44 margin points. Include the config nobody tried: Sonnet 5 at effort `medium` |
| 4 | Set `COACH_LOG_CONTENT=off` | 0 h | Removes your largest legal exposure. The mechanism already exists and writes NULL |
| 5 | Move hosting to Cloudflare Pages | 0.5 d | GitHub Pages' terms prohibit commercial SaaS. Also gets you a CSP, which you currently do not have at all |
| 6 | Second cache breakpoint after conversation history | 1 h | Pure billing change, zero quality risk, ~$0.75/user/month typical |
| 7 | Delete the legacy `MCP_SECRET` auth branch | 0.5 h | A static env var that maps any holder to one user, with no expiry and no revocation |

**Total: roughly 12 hours plus one $40-80 eval run.**

### Recommendation 2: Build import, then the compliance view. Four to five dev-days.

This is the smallest change that makes the system valuable to anyone new, and it is a precondition for every other direction in this document.

**Import** (Hevy, Strong, generic CSV): 3 to 4 days.
**The missing compliance view** (`v_prescription_completion`): 0.5 to 1 day.

Today a new user's first screen is empty. `getLastActuals`, `getE1rmSeries`, `getAdherence` and `getGoalProgress` all return nothing. The coach's context block is empty. `find_similar_days` can never match because there is nothing to match against. **You cannot currently acquire a user who has ever trained before, which is all of them.**

And `v_adherence` is an inner join from sets to prescriptions, so a prescription nobody performed produces no row. There is no "prescribed and not done" anywhere in the thirteen views. That is the missing half of the one capability you would be selling.

### Recommendation 3: Find twenty coached lifters before writing a payment integration

Not a landing page. Not Stripe. Twenty people whose coach hands them a spreadsheet, a Notion page, or a photo of a whiteboard, and who currently retype it into Hevy every week.

Ask them what they pay for today. Watch ten of them log four weeks of training.

If ten still log after a month, the rest of this document becomes a roadmap. If they do not, you spent a week instead of six months, and you learned the one thing no amount of research in this document can tell you.

### Recommendation 4: Do not do the twenty-five weeks

The product-readiness pass estimated roughly 25 weeks solo from here to a sellable consumer v1: billing, landing page, legal, email infrastructure, real onboarding, push notifications, table-stakes features, settings sync, coach productionisation, ops, analytics, E2E tests, support.

Almost none of that work is in the parts of this codebase that are hard. The data model, offline engine, RLS boundary, MCP surface and coach authorization design are done and done well. What is missing is the entire commercial and operational shell. **The technically difficult 30% is finished. The tedious 70% has not been started, and it is 25 weeks against a market that this document argues will not pay for it.**

## 0.3 What would make sense

Three framings, each internally coherent, each with a different cost and a different definition of success. They are not mutually exclusive in sequence, but they are mutually exclusive in the next quarter.

### Framing A: This is a tool. Keep it, use it, stop selling it.

**Cost:** $25/month Supabase Pro, plus your Anthropic usage for two people (currently under $10/month combined at observed volume).
**Legal exposure:** near zero. You are not taking money from strangers, so no entity, no ToS, no privacy policy, no VAT, no HBNR, no CIPA.
**Work required:** Recommendation 1 only, and only items 2, 4 and 6 (the defect, the logging default, and the free cost saving).
**Success looks like:** you and Valentine keep training, and the log stays good.

This is the honest default. It is not failure. It is the outcome where you keep 100% of the value you have already built and spend nothing further.

### Framing B: This is a small business. Bottom-of-market team strength and conditioning.

**Buyer:** head strength coach at a high school, a small college, or a private performance facility. One person, one credit card or p-card, below procurement thresholds.
**Price:** $500 to $1,500 per program per year. TeamBuildr charges $90/month for 50 athletes, $150 for 250.
**Revenue at scale:** roughly **70 paying programs clears $100k gross**.
**Work required:** the multi-athlete model, 8 to 12 dev-days, plus import (Rec 2), plus the whole commercial shell (entity, Stripe, ToS, privacy policy) at 45 to 60 hours and $2,500 to $4,500.
**Channel:** coach-to-coach referral, NSCA and CSCCa conferences, direct outreach. Seasonal, mapped to the academic year.

**Why this one and not the others:** it is the only market in the six evaluated where every gate is one you can personally open. No clinical credential, no FedRAMP, no IRB, no institutional procurement. Your data model already handles supersets, ramps, sections, percentage of training max and prescribed-versus-performed with more structural fidelity than most incumbents.

**The honest downside:** it is a grind, not leverage. Seventy relationships at $1,500 against incumbents that are cheap, feature-complete and have a decade of coach trust. And the multi-athlete change is the most dangerous edit in the repository: your security posture goes from provable (an audit is reading 60 policies) to reviewed (correctness depends on one function returning the right answer in 14 places plus 65 hand-written filters on a path where RLS is not there to catch a mistake).

### Framing C: This is a credential. Convert it into standing, then re-enter in eighteen months.

**Mechanism:** exercise science research consulting. Compliance and protocol-adherence data is the deliverable in an intervention study, and researchers currently use REDCap and spreadsheets.
**Price:** $10,000 to $30,000 per study. Three or four studies.
**Deliverable beyond money:** co-authorship on a paper about prescription fidelity, and a named PI relationship.
**Supporting evidence:** a 2026 JMIR systematic review of exercise prescription apps evaluated them against FITT/FITT-VP and CERT and named transparent progression mechanisms and individualized adjustment as the priorities missing from the market. That is a published, citable statement that the thing you built well is the thing the field says is absent.
**Fit with the asset:** the append-only record with reconstructable corrections is genuinely the shape 21 CFR Part 11 wants. This is the one direction where the invisible capabilities become the visible value.

**The honest downside:** the sales cycle is the grant cycle, 9 to 18 months, with a high probability the grant is never funded and you wrote a letter of support for nothing. Treat it as a credentialing strategy with revenue attached, not a revenue strategy.

**Why it is on the list anyway:** eighteen months from now, a person with a co-authored paper on prescription fidelity and a funded study behind them is a different seller into rehab and college S&C than you are today. That is the only path in this document that converts the thing you cannot buy (credibility) out of the thing you already have (the schema).

## 0.4 What you would have to do

Sequenced, with the gate conditions. Full task breakdown in Part 7.

```
WAVE 0  ~12 hours          Hygiene. Unconditional. Do this week.
   |
   v
WAVE 1  4-5 dev-days       Import + compliance view.
   |                       Precondition for everything downstream.
   v
WAVE 2  ~2 weeks, no code  Twenty coached lifters. Watch them.
   |
   +-- GATE: do 10 of 20 still log after 4 weeks?
   |
   +-- NO  --> Framing A (tool) or Framing C (credential). Stop building.
   |
   +-- YES --> choose:
               |
               +-- WAVE 3a  MCP-first product     ~10-14 dev-days + legal
               +-- WAVE 3b  Team S&C              ~20-25 dev-days + legal
               +-- WAVE 3c  Both, sequenced       3a first, 3b if 3a holds
```

**Wave 0 detail (12 hours):** listed in 0.2 above.

**Wave 1 detail (4-5 days):**
- Import parsers for Hevy CSV, Strong CSV, and a generic mapping sheet. `pwa/src/lib/export.ts` is the exact mirror image and already handles paging, `load_entry`, and the settings envelope, so the shape is known.
- Exercise-name-to-id resolution with a confirmation sheet for misses. `pwa/src/lib/fuzzy.ts` already exists.
- Synthetic session boundaries from timestamps.
- `v_prescription_completion`: one view over `v_resolved_prescriptions` left-joined to a per-`prescription_id` count from `v_live_sets`.

**Wave 2 detail (no code):** recruit through r/weightroom, r/powerlifting, Discord servers for specific coaches, and the coaches themselves. The qualifying question is "does your coach send you a spreadsheet or a photo." Do not build a landing page. Do not take money.

**Wave 3a, MCP-first product (10-14 dev-days plus legal):**
- Settings > Connect: server-side token mint, copy-once display, copy-ready config block, revoke list, plus an `mcp_tokens` select policy scoped to `auth.uid()` exposing everything except `token_sha256`. **1 day.**
- OAuth 2.1 resource-server support against Supabase's OAuth server, keeping the static bearer alongside for ChatGPT connectors. **3 to 5 days.** This is not optional: Anthropic's directory listing requires OAuth 2.0, and a static API key makes you permanently unlistable.
- Move the `configs` tool gate out of `coach/index.ts` into the server as per-token capability flags, because deleting or demoting the coach removes the only place that gate exists. **1 to 2 days.**
- Rate limiting on the MCP server (there is none today) and on the new mint endpoint. **0.5 days.**
- Billing: Stripe, webhook function, `subscriptions` table, entitlement check replacing the env allowlist. **3 days.**
- Legal shell: LLC separate from Graphite Productions, ToS, privacy policy, account deletion, complete export. **45 to 60 hours, $2,500 to $4,500.**

**Wave 3b, team S&C (20-25 dev-days plus legal):** everything in 3a, plus the multi-athlete model: `coach_athletes` table, a `can_read(subject uuid)` SQL function, fourteen rewritten SELECT policies, explicit subject arguments through the twelve MCP tools a coach actually needs, and the PWA cache namespacing problem, which is the expensive part because `pwa/src/lib/db.ts` deliberately does not namespace cache keys by user.

## 0.5 The numbers that drive everything

Every strategic conclusion in this document reduces to one of these.

| # | Number | Value | Source | Consequence |
|---|---|---|---|---|
| 1 | Real users who are not you | **1** | `docs/superpowers/plans/2026-09-04-gaps-roadmap.md` | Everything else is theory |
| 2 | Anthropic cost, typical user | **$4.56/mo** | derived, Part 2 | Sets the price floor |
| 3 | Anthropic cost, heavy user | **$24.75/mo** | derived, Part 2 | Your best customers cost the most |
| 4 | Category price ceiling | **$2.99 to $15.99** | Part 3.1 | Collides with #2 |
| 5 | Supabase, all-in at 10,000 users | **$32/mo** | Part 5.1 | Infra is 0.2% of the bill. Stop optimising it |
| 6 | Fitness entries in Anthropic's connector directory | **7 of 1,625** | Part 3.4 | There is no MCP distribution channel for this vertical |
| 7 | Median subscription app revenue | **$492/mo** | RevenueCat 2026 | The realistic ceiling |
| 8 | Apps that never reach $1,000 total revenue | **57.7%** | RevenueCat 2026 | The realistic floor |
| 9 | AI app annual retention vs non-AI | **21.1% vs 30.7%** | RevenueCat | Adding the LLM subtracts retention |
| 10 | CAC per paying user, fitness | **$20 to $80** | Part 3.4 | Against a $24-96 annual price. Paid acquisition is closed |
| 11 | Coach platform price floor, per athlete | **$1 to $4/mo** | Part 3.6 | TrainHeroic is $1. The logging layer is a commodity input |
| 12 | Cost cut available with zero quality risk | **56%** | Part 5.6 | Nine hours of work |
| 13 | Dev-days to make the system usable by a new user | **4 to 5** | Part 7.2 | Import plus one view |
| 14 | `v_coach_cost` understatement | **2.5x tokens, 4x cache writes** | Part 2.6 | Your own sheet is wrong |
| 15 | Programs needed at $1,500/yr to clear $100k | **~70** | Part 6.3 | The grind, quantified |

## 0.6 What would change my mind

I want these written down so the conclusion is falsifiable rather than merely confident.

**If any of these turns out true, re-open the consumer question:**

1. **Ten of twenty coached lifters keep logging for four weeks and say they would pay $10/month.** This is the Wave 2 gate and it is the only evidence that matters. Everything in Part 3 is market structure; this is demand.
2. **The eval shows Sonnet 5 at effort `medium` matches or beats Opus 5 at `low` on side-effect error rate.** Combined with the Wave 0 fixes that puts typical COGS at roughly $0.80/month, which makes a $9 price viable at 64% margin and changes the collision in 0.1 materially.
3. **A coach with 30-plus athletes offers to pay for the multi-athlete version before you build it.** That inverts Framing B from a cold-outreach grind into a design partner relationship, which is a different business.
4. **Anthropic adds a Health and Fitness category to the connector directory, or ChatGPT's app directory starts surfacing fitness connectors in-conversation at volume.** That would create the distribution channel whose absence is currently decisive.

**If any of these turns out true, close the question harder:**

5. **Cora ships prescribed-versus-achieved.** They are YC W24, have 60-plus MCP tools on OAuth 2.1, native Apple Watch logging, a 4.8 App Store rating and $9.99/month. Adding the coached-lifter data model is a quarter of work for them, and being there first does not stop it.
6. **Hevy adds percentage-of-training-max to routines.** Their model is currently too flat to hold a percentage, which is the single largest structural gap you have against them. It is not a hard change for them.
7. **Fewer than five of twenty recruited lifters are still logging at four weeks.** Then the retention numbers in Part 3.5 apply to you specifically and no amount of engineering fixes it.


---

# PART 1: THE ASSET

## 1.1 Build state and real-world evidence

**[MEASURED]** 58 commits, 2026-08-25 to 2026-09-05. Two committer identities: `coltbradley <colt@graphite.productions>` and `Claude <noreply@anthropic.com>`. No third-party human contributors.

**[MEASURED]** Roughly 40,846 lines of TypeScript, TSX and SQL excluding node_modules. The PWA is ~29,800 lines of which 7,545 are tests. Edge functions are 8,671 lines. 27 migrations totalling 2,095 lines of SQL.

**[MEASURED]** Production evidence, from `docs/superpowers/plans/2026-09-04-gaps-roadmap.md`:

| Fact | Value |
|---|---|
| Users with live sets | 2 |
| Owner's sets | 13, Aug 24-28, smoke tests |
| Second user's sets | 41, in 3 completed sessions, Sep 1-3 (PUSH, LEGS, PULL) |
| Sets linked to a prescription | all of them |
| Voids | 0 |
| Set notes | 2 |
| Session RPE recorded | 0 |
| Bodyweight recorded | 0 |
| Coach turns | 13 |
| Edge function gateway 4xx/5xx in 7 days | 0 |
| Expired coach tokens never pruned | 27 |

**This is the entire evidentiary base for every product claim in this repository.** It is worth saying plainly because the codebase's quality creates a misleading impression of maturity. Three sessions is not a validated product; it is a working prototype with one enthusiastic user.

**The finding inside that evidence that matters most:** the second user did not use the product as specified. The spec describes a coached lifter pasting a human coach's screenshot. She built her own program *through the in-app coach*, in 13 turns, rejecting a proposed pullover four separate times before naming what she actually wanted (a pull-up), then approving with "Yes" and typing "Confirm". The roadmap records this as a second persona the spec never named: the self-coached lifter using Claude as the coach.

That persona is important to hold onto, because several strategic options in Part 6 abandon her.

## 1.2 Functionality inventory

Six routes plus sheets. Assessed screen by screen for what actually exists versus what is stubbed.

### Login (`pwa/src/screens/Login.tsx`, 234 lines)
**Polished, production-grade.** Email plus 6-digit OTP code, no passwords anywhere. Resend with a 30-second cooldown whose remaining time is derived from two timestamps rather than counted down, so it survives a sleeping phone. Silently accepts a pasted magic link as a fallback. Warns visibly when `VITE_SUPABASE_URL` or the anon key are missing.

The code-not-link decision was forced by a real constraint: an installed iOS PWA's storage is partitioned from Safari, so a magic link opened in Safari cannot authenticate the installed app. The committed template is code-only. Correct fix.

### Today (`pwa/src/screens/Today.tsx`, 1,550 lines)
**The most feature-dense screen, and polished.** Swipeable week strip. A per-day state machine (`workoutStates`) with a documented precedence order: DRAFT beats every date check, DONE and SKIPPED beat DRAFT. Calendar sheet, "Plan this day", template application, orphan-session recovery card, resume banner, prescription list with supersets rendered by letter and ramps grouped into one entry, and a start-session gate that refuses to render a Start button while it is still an open question whether a session is already running.

`useLocalToday` watches a midnight timer plus `visibilitychange` plus `online`, because an installed iOS PWA is not a page load: iOS suspends and resumes it with the same heap, and a screen left open on Monday evening was offering Monday's Start button on Tuesday and filing the whole workout against Monday's planned day.

**Test coverage: partial.** The pure helpers were deliberately extracted out (28 test cases). The screen itself has none.

### Session (`pwa/src/screens/Session.tsx`, 2,183 lines)
**The core loop. Largest single file in the repository. Polished in behaviour, zero test coverage.**

Contains: steppers with per-exercise increments, a number pad, a rest timer strip with -30/+30 and a wall-clock `startedAt` mirrored to IndexedDB so it survives an app kill, plate calculator (`pwa/src/lib/plates.ts`), per-side load resolution derived from equipment and exercise name, exercise demo sheet with photos and instructions from the seed, mid-session exercise add, "last time" reference, per-set notes, in-session correction (a void plus a replacement at the same index), tick-only tracking for activations, screen wake lock, and an oscillator beep at rest end.

**This is the file a customer touches most and it has no test at all.** That is the single largest quality risk in the codebase, and it is a deliberate strategy (extract the logic, test the logic) that has a real cost.

### Plan (`pwa/src/screens/Plan.tsx`, 1,739 lines)
**Full plan editor, polished, zero test coverage.** Add, reorder, remove exercises. Set schemes. Sections. Supersets. Ramps. Day rename. Reschedule. Duplicate to another date. Save as template. Plan notes.

Note the history here: the editor did not write `load_entry` until recently, which is why a real user's entire plan is stored at half weight on every dumbbell movement. The editor now loads the exercise library on mount rather than when the picker opens, specifically because a row editor that cannot tell dumbbells from a barbell is how that happened.

### History (`pwa/src/screens/History.tsx`, 476 lines)
**Half-built by the project's own admission.** Per-exercise only: set list, e1RM chart with goal line, weekly volume bars (two custom SVG charts in `pwa/src/components/charts/`), void a past set, discard a session.

`docs/flows.md:418` lists "No session-level history browse yet (per-exercise only)" as a known non-flow. **A user cannot answer "what did I do Tuesday" in this app.** That is the second question every lifter asks and it is a table-stakes gap.

### End (`pwa/src/screens/End.tsx`, 548 lines)
**Complete but under-reached.** Session RPE 0-10, bodyweight, note, duration, tonnage. Only reachable by tapping Finish, which is why the one real user has three sessions with zero sRPE and zero bodyweight recorded.

### Settings sheet (`pwa/src/components/SettingsSheet.tsx`, 823 lines)
**Polished, zero test coverage.** Units, plate and bar inventories, load steps, per-exercise overrides, rest defaults, rest sound, JSON and CSV export (paged past PostgREST's 1000-row cap), sync-now, version stamp, reset. Outbox-aware sign-out that warns how many unsynced sets are about to be lost.

### Coach sheet (`pwa/src/components/CoachSheet.tsx`, 534 lines)
Streaming chat over SSE with thinking indicators, tool-use narration, image/PDF/text attachments, thread persisted to localStorage (last 24 turns, attachment payloads stripped), reachable from a draggable floating dock on every screen.

### Offline (`pwa/src/lib/outbox.ts`, 501 lines, 704 lines of tests)
**Genuinely production-grade and the best thing in the repository.** Detailed in 1.3.3.

### Not built

| Feature | Status | Evidence |
|---|---|---|
| Push notifications | Designed, migration slot `20260905050000` reserved and skipped, never built | `docs/decisions.md:1907` |
| Per-set RPE | Designed, repo-priced at 1.0 day (task 5a) | sequenced plan |
| Bodyweight outside a session | Repo-priced at 1.0 day (task 5b) | sequenced plan |
| PR detection | Not built | `docs/plan.md` Phase 3.6 C2 |
| Session-level history | Not built | `docs/flows.md:412` |
| Time-tracked work (planks, carries) | Repo-priced 1.0 day (task 5f) | sequenced plan |
| Mid-session exercise swap | Not built. A real user worked around it with a session note | gaps roadmap |
| Settings sync across devices | Explicitly declined, needs a decision entry | `CLAUDE.md` |
| Import from anything | **Not built. No import path exists anywhere in the PWA** | verified by grep |

## 1.3 Capability inventory

This is the section that drives the entire strategic conclusion. Each capability is rated on **rebuild cost** (one person working with Claude, the repo's own estimating convention) and **visibility to a non-technical buyer**.

### 1.3.1 Point-in-time adherence at the individual set level
**Files:** `supabase/migrations/20260825120003_views.sql` (`v_adherence`), redefined in `20260825140000_planning_voids.sql` and `20260827180000_multi_user.sql`.

The join is `sets.prescription_id -> prescriptions.id`, **per set, not per workout**. The genuinely hard part is a lateral subquery: a `%TM` prescription resolves against the training max whose `effective_date <= (s.performed_at at time zone app_tz(s.user_id))::date`. That is the TM current **on the day the set was performed**, not today's. Re-read a workout from a year ago after three TM revisions and the prescribed load is still what was prescribed then.

It emits `rep_outcome` (missed/hit/exceeded) and `load_delta_kg`, and reads `v_live_sets` so voids and discarded sessions are already excluded.

**Two honest limits.** It is an **inner** join, so a prescription nobody performed produces no row at all. And `pwa/src/lib/outbox.ts` deliberately nulls `prescription_id` to save a set whose prescription vanished server-side (the `fk-prescription` branch of `classify`), so coverage silently degrades in exactly the messy cases.

- **Rebuild:** naive version 1 day. This version, correct under corrections, soft-deletes, per-user timezone, per-side load and point-in-time TM: **weeks**.
- **Visibility: LOW.** Surfaces in History via `getAdherence`/`summariseAdherence` (`pwa/src/lib/data.ts:1802-1917`) as hit/missed labels. Nobody buys a SQL view.

### 1.3.2 Immutable record, corrections as appends, enforced by RLS not code
**Files:** `20260825120002_rls.sql` (sets has select and insert only), `20260825140000_planning_voids.sql` (`set_voids`, itself append-only), `20260905010000_drop_hard_delete_policies.sql`, `pwa/src/lib/corrections.ts`.

A correction is two appends. `correctedSet` preserves `set_index`, `performed_at`, rest and prescription while changing only load, reps and type. The full edit history is reconstructable by reading `sets` plus `set_voids` in `created_at` order: what was logged first, what replaced it, when the lifter noticed.

The part that cannot be copied is the reasoning in `20260905010000`. Soft-deleting in code was not enough, because the DELETE policies were still standing and a session token could cascade straight through PostgREST. That migration drops `programs_delete` and `exercise_owners_delete` outright, and **narrows** `pw_delete` to `pw_delete_template` rather than dropping it, because RLS refuses by returning zero rows rather than erroring, so a bare drop would have made the template button silently do nothing.

- **Rebuild:** the policy set, 1 day. The conviction behind it, months of being wrong first.
- **Visibility: LOW to a consumer, HIGH to a regulated buyer.** **This is the single most important asymmetry in the repository.** A lifter does not care that their log is tamper-evident. A physio defending a claim, an apprenticeship registrar, and a trial sponsor care about nothing else.

### 1.3.3 Offline capture with owner-stamped, order-preserving, four-way-classified replay
**Files:** `pwa/src/lib/outbox.ts` (501 lines, 704 lines of tests), `db.ts`, `persistedSession.ts`.

Everything hard is present:

- Enqueue-ordered replay, so a session insert always precedes its sets.
- Idempotency from client-generated UUIDs plus `on conflict do nothing`.
- Classification into retry / dead / auth / fk-prescription, so one bad item cannot wedge the queue.
- The distinction that a 401 whose refresh **threw** stays retryable while a refresh that returned false is dead.
- Items stamped with the user who made them and **held**, never replayed under another identity, including the boot state where identity is not yet known. `start()` re-runs the queue when identity arrives.
- `persistedSession.ts` reads auth-js's own on-disk session so "no signal in a basement gym" is not misread as "signed out". Explicitly identity, never authorization.
- `navigator.storage.persist()` requested at startup, best-effort, never awaited on the boot path, because WebKit evicts IndexedDB after about a week idle and the outbox is the only copy of an unsynced set.

- **Rebuild:** **weeks to months.** Highest value per line in the repository.
- **Visibility: MEDIUM, and only negatively.** Nobody praises an outbox; they abandon apps that lose sets. It is a floor, not a differentiator, **because Hevy and Strong are also offline-capable.** The genuinely differentiated part, multi-identity holding on one device, matters only for shared devices: a gym floor tablet, a clinic iPad, a jobsite phone.

### 1.3.4 Screenshot to program parsing
**This capability is not in the repository.** There is no parser.

What exists is the target schema with unusually good `.describe()` strings (`supabase/functions/mcp-server/lib/prescriptions.ts:20-160`), validation that refuses a superset group of one (`assertSupersetGroups`), and a 298-line system prompt (`supabase/functions/coach/prompt.ts`). The parsing is done by Claude, which anyone with an API key can do.

What is defensible is the schema's refusals, and they are all incident-derived:

- `load_entry: 'per_side'` doubling a coach's per-hand number into `load_kg`.
- A percentage stored as a percentage rather than becoming prose in `notes`.
- `prescriptionRows` emitting `set_type` and `tracking` on every row, because a PostgREST bulk insert fills a missing key with NULL rather than the column default. That was three 500s on a real "Lower + Activation" day.

- **Rebuild:** the prompt, hours. The schema-with-refusals, about a week and a half of production failures you cannot shortcut.
- **Visibility: HIGH, and most commoditized.** Demos brilliantly. Every LLM wrapper does it. Five consumer apps and Trainerize already ship it.

### 1.3.5 A 30-tool MCP surface over a normalized training schema
**Files:** `supabase/functions/mcp-server/lib/handler.ts` registers all 30 (verified by name).

Stateless streamable HTTP. Per-request identity from a SHA-256 token digest (`lib/auth.ts`). Timing-safe legacy compare. Unauthenticated health endpoint. CORS that actually exposes `mcp-session-id` so browser MCP clients work.

The hard part is that **the service role bypasses RLS entirely**, so correctness is fully manual: **103** references to `db.ownerId` and **65** `.eq("user_id", ...)` calls, each one a place another user's data could leak. `requireExercise` and `visibleExerciseIds` in `lib/db.ts` exist because `upsert_program` once checked existence with a bare `.select("id").in("id", ids)`, and as the service role that sees every row, so another account's custom exercise passed the check and came back out of `get_program` by name.

- **Rebuild:** transport plus auth, 2-3 days. The 30 tools with their guards, **weeks**.
- **Visibility: LOW to a consumer, HIGH to a small specific buyer** who already lives in Claude Desktop.

### 1.3.6 Structure as row adjacency (ramps, supersets, sections)
`superset_group` (`20260826150000`), `section` (`20260831080000`), and "consecutive same exercise is a ramp". No join tables. The unit of reordering is the entry, not the row (`pwa/src/lib/sections.ts`, 359 lines, 457 lines of tests).

**Honest read: this is an elegant avoidance of complexity, not a capability.** It buys a simpler schema and costs an invariant that lives only in code. `CLAUDE.md`'s own admission that a fourth grouping idiom "needs a decision entry, not a table" is an admission that it does not extend.

- **Rebuild:** 2-3 days to copy the idea; weeks to get reordering right, which this repo has already had as a bug class.
- **Visibility: ZERO.** A user sees "A1/A2". Hevy has that.

### 1.3.7 %TM resolution that tolerates a missing training max
`resolveTrainingMaxes` in `lib/prescriptions.ts` returns `{tms, unresolved_pct, note}` and explains the future-dated-TM case. `v_resolved_prescriptions` yields a null `resolved_load_kg`; the UI says "70% TM · no TM set".

Good judgment, incident-derived: refusing was correct for a %TM program trained tomorrow and wrong for a first session, which is the calibration the TM comes from. A real coach wrote "60-75% of 1RM", the tool refused, the model put the percentage in `notes` as prose, and the 130 lb x 5 the session produced had nothing to become.

- **Rebuild:** half a day once you know. Knowing cost an incident.
- **Visibility: NEAR ZERO.** It is the absence of an error message.

### 1.3.8 Per-user timezone bucketing inside the views
`app_tz(p_user_id)` in `20260827180000_multi_user.sql`. `v_current_tm`, `v_weekly_volume`, `v_adherence` and `v_coach_spend_daily` all pass **the user_id of the row they bucket**, not `auth.uid()`, so the PWA path and the service-role path give the same answer without impersonation.

Client side, `pwa/src/hooks/useLocalToday.ts` watches a midnight timer, `visibilitychange` and `online`, and computes the boundary from the calendar date so DST lands right.

- **Rebuild:** 2-3 days for the SQL; the client hook is subtle enough to blow a day on its own, including standing down while a live session is held.
- **Visibility: ZERO until it breaks,** at which point a whole workout is filed against yesterday.

### 1.3.9 Strategy layer above programs
`supabase/migrations/20260905060000_training_plans.sql`. One live plan per user via a partial unique index on `superseded_at is null`. Revisions supersede rather than delete. Non-overlapping phases via an AFTER ROW trigger raising SQLSTATE 23P01, because PGlite has no `btree_gist` and PGlite is the validation path. `programs.phase_id` stops one-program-per-screenshot.

**Honest read: this landed 2026-09-05, one day before HEAD.** Written from Claude Desktop only; the in-app coach cannot write it. Essentially no production evidence. The most speculative thing in the repository.

- **Rebuild:** 2 days.
- **Visibility: LOW.** No UI beyond a PLAN line in the coach's context block.

### 1.3.10 A domain-agnostic offline-first Supabase kit
**Separate this from 1.3.3.** `outbox.ts` plus `db.ts` (the cache-key registry, invalidation families, `claimCacheFor`) plus `makeFetchWithCache` and `QueryError` in `data.ts` plus `persistedSession.ts` is roughly **2,900 lines with 544 passing test cases, and almost none of it knows what a "set" is.** It knows tables, owners, keys, families, and whether the server answered.

The `QueryError` design specifically distinguishes "the server never answered" (empty postgrest code) from "the server said no" (a SQLSTATE or PGRST code), which is why a missing view column stopped reading as offline on every cached device while Report-a-problem said RECENT ERRORS: none.

- **Rebuild: months. Visibility: zero.** This is reusable infrastructure and it is arguably worth more than the lifting app on top of it.

### 1.3.11 Per-turn LLM cost and content accounting with enforced caps
`20260831040000`, `20260831050000`, `20260831070000`. `coach_usage` records tokens, cache read and write, latency, `tools_used`, `stop_reason`, attachments, and prompt and response text, against a **client-chosen** `turn_id` with a unique partial index, so a reused id is a 409 and an app closed mid-answer can recover the turn.

A turn whose usage cannot be recorded does not run, because supabase-js returns a PostgREST error rather than throwing, and a silently failed usage write left `overLimit()` counting zero, which disabled both caps. Cost lives in a view (`v_coach_cost`) so re-pricing is one `create or replace` and never a backfill.

- **Rebuild: 3-4 days to do well, and most teams do it badly and late. Visibility: zero to users, high to whoever pays the bill.**

### 1.3.12 `feedback` as a table the assistant writes to
`20260831030000` plus `tools/feedback.ts`. "Somewhere for Claude to put 'I could not do that'", with a `context` field for what it was trying to do, a `source` of claude or user, and resolve-but-never-delete. Three MCP tools.

**This is an agent-experience primitive I have not seen productized elsewhere:** the model records the gap it hit and it outlives the conversation.

- **Rebuild: trivial. The idea is the asset.**

### 1.3.13 Schema validation with no Docker
`scripts/validate-db.mjs` (1,502 lines, 234 assertions) plus `check-selects.mjs` runs the entire migration chain, views and RLS in PGlite, in CI, in seconds. It is why `plan_phases` uses a trigger instead of an exclusion constraint.

`check-selects.mjs` verifies every column the code SELECTs actually exists. It was added after `get_program` shipped reading a column that never existed.

- **Rebuild: 3-5 days. Visibility: zero, and it is why the schema is as good as it is.**

### 1.3.14 A built, never-run eval harness
`scripts/coach-eval/` (~1,470 lines, 13 files): a real MCP server against a PGlite-backed PostgREST, 13 real turns plus 6 synthesized cases, end-state checks, an optional Opus judge, and a subagent driver needing no API key.

**Task 4b has never been run against the production model configuration.** The choice of `claude-opus-5` at effort `low` rests on argument rather than measurement.

### 1.3.15 The harsh cut

| Capability | Rebuild cost | Visible to a buyer? |
|---|---|---|
| 1. Point-in-time adherence | weeks | LOW |
| 2. Immutable record via RLS | 1 day + months of scar tissue | LOW consumer / HIGH regulated |
| 3. Offline outbox | weeks to months | MEDIUM, negatively only |
| 4. Screenshot parsing | ~1.5 weeks of incidents | **HIGH, and commoditized** |
| 5. 30-tool MCP surface | weeks | LOW / HIGH to a niche |
| 6. Row adjacency structure | 2-3 days | ZERO |
| 7. %TM without a TM | half a day | NEAR ZERO |
| 8. Per-user timezone in views | 2-3 days | ZERO |
| 9. Plan/phase layer | 2 days | LOW |
| 10. Offline-first kit | months | ZERO |
| 11. LLM cost accounting | 3-4 days | ZERO to users |
| 12. `feedback` primitive | trivial | ZERO |
| 13. PGlite validation | 3-5 days | ZERO |
| 14. Eval harness | (built, unrun) | ZERO |

**Of fourteen capabilities, exactly one is highly visible to a non-technical buyer, and it is the least defensible. One is visible only as an absence of failure. Twelve are invisible.**

**Elegant internals a user cannot perceive are not assets in a consumer market. They are assets in a market that audits.** That is the whole finding, and every strategic conclusion in Part 6 follows from it.

## 1.4 Quality signals

**[MEASURED] Tests: 517 vitest cases across 39 files, plus 61 Deno tests across 6 files. 578 total.**

Heavily covered: `entries.ts` (54), `data.ts` (47), `settings.ts` (38), `sections.ts` (30), `outbox.ts` (21), plus 28 pure helpers extracted out of Today. Component tests exist for Stepper, Sheet, SetRow, RestTimer, Toasts, SetSchemeSheet, ExerciseDemoSheet.

**Untested:** `Session.tsx` (2,183), `Plan.tsx` (1,739), `SettingsSheet.tsx` (823), `CoachSheet.tsx` (534), `History.tsx` (476). **Roughly 5,750 lines containing every screen a user actually touches.**

The tested surface is the pure logic deliberately extracted out of those screens. That is a defensible strategy and it is also why the untested part is exactly the part that breaks in front of a customer.

**No E2E tests.** No Playwright, Puppeteer or Cypress. **No accessibility tests.** No axe.

**Database validation is a genuine standout** and better than most funded startups: 234 assertions over the real migration chain in PGlite, no Docker, running in CI on every push.

**CI** (`.github/workflows/ci.yml`): three jobs on every push and PR. Database (PGlite migrations plus select-check), edge functions (`deno check` on both, `deno test lib/`), PWA (build plus vitest). Green gate.

**Deploy** (`.github/workflows/deploy.yml`): path-filtered, migrations before the client build, `pages` blocked by a failed `supabase` job. Written after shipping a build that read a column whose migration had not been pushed.

**Error reporting:** Sentry wired in three places. The PWA has a live DSN. **Both edge functions no-op entirely because `SENTRY_DSN` is unset**, so coach and MCP failures are currently invisible unless someone queries Supabase analytics. Task 4.4, open.

**`docs/decisions.md` (2,143 lines, ~60 entries) is the highest-signal artifact in the repository.** Entries like "The delete doors soft delete was supposed to have closed", "A basement gym is not a sign-out", "Only the device that started a session may discard it", and "Today has to notice that it is tomorrow" are records of real production failures found and fixed. Most teams do not have this at Series B.

**This matters commercially:** every capability rated "months to rebuild" above is months **because of what is written in `CLAUDE.md` and `docs/decisions.md`**, not because of the code. If this repository is ever sold or handed over, those two files are a material part of what is being transferred.

## 1.5 The single-user assumptions

Ranked by how much each hurts a paying stranger.

1. **Settings are device-local, permanently.** `CLAUDE.md` states there is no `user_settings` table and adding one requires a decision entry, because it would create a third write-ownership class for data no view and no MCP tool reads. `docs/setup.md:246`: "PWA device settings (plates, bars, rest, units): per device, not per user." A customer with a phone and an iPad configures plate inventory, units and per-exercise increments twice. New phone, everything resets.

2. **Per-user timezone is hand-run SQL.** `app_config.tz` is a single global row that `docs/setup.md:227` calls "the household default". A user in another timezone needs an `insert into user_config` executed by the operator in the Supabase SQL editor. The doc defends this: "it changes about once in a lifetime." It changes every time you acquire a customer.

3. **MCP token issuance is a CLI script plus manual SQL.** `scripts/issue-mcp-token.mjs --user <uuid> --label "..."` prints the token once and the SQL to activate it, which the operator pastes into the dashboard. Three artifacts a consumer will never touch: a terminal, a raw uuid, and a SQL editor.

4. **Coach access control is an environment variable.** `COACH_ALLOWED_USERS` requires `supabase secrets set` plus a redeploy. `docs/setup.md:277` notes "There is no append: adding someone means re-setting the whole list."

5. **Signup control is a dashboard toggle, not code.** Open by Supabase default. `config.toml` does not set `enable_signup`. `docs/setup.md:191` calls open signup "a convenience for exactly this step and a liability every other day of the year, because the coach spends the deployment owner's money."

6. **Conversation logging defaults to on and the operator can read everything.** `coach_usage` stores prompt and response text. `CLAUDE.md` calls this "a product decision, not a technical detail". The first-run card discloses it in one line of microcopy. Honest between two people who know each other. Sold to strangers it is a privacy policy, a DPA, and a default flip.

7. **Hardcoded deployment identity.** `config.toml` pins `site_url` to `coltbradley.github.io/strength-tracker/`. `deploy.yml` pins `PAGES_BASE` and a specific Sentry DSN. SMTP is one person's Gmail account.

8. **The exercise library is one shared table across all tenants.** Seeded rows are globally readable and globally writable through `update_exercise`. `exercises.name` was bounded to 80 characters of single-line printable text specifically because it is "the one field a user writes that every OTHER user's coach reads". The reasoning is excellent; the shape is still one global namespace.

9. **One Supabase project, no staging, no tenancy boundary above RLS.** Every push to main deploys migrations and both edge functions straight to production.


---

# PART 2: ECONOMICS

## 2.1 What is in the code

**[MEASURED]** from `supabase/functions/coach/index.ts` unless noted.

| Fact | Value | Line |
|---|---|---|
| Model | `claude-opus-5` | `:68` |
| Effort / thinking | `output_config:{effort:"low"}`, `thinking:{type:"adaptive",display:"summarized"}` | `:779-780` |
| `max_tokens` | 16,000 (counts thinking, tool calls AND the answer) | `:70` |
| System prompt | 13,958 characters assembled | measured by running `systemPrompt()` |
| MCP tools registered | 30 | `mcp-server/lib/handler.ts` |
| Tools the coach sees | 25 (5 disabled at the connector) | `:835-846` |
| Tool metadata, raw | 30,156 characters of registerTool metadata for the 25 | measured |
| Prompt caching | one breakpoint at end of `system`, `ttl:"1h"` | `:802` |
| Live cache read observed | **9,656 tokens** | `docs/decisions.md:1020` |
| History resent each turn | yes, whole thread. Client keeps 24 turns; server caps 40 turns and 20,000 chars/turn | `:124-125` |
| Context block | rebuilt every turn, prepended to the LATEST user turn only, so it sits after the cache breakpoint | `pwa/src/lib/coach.ts:72-79` |
| Turn cap | 150 per rolling 24h | `:79` |
| Token cap | 800,000 weighted per rolling 30d, weighted = `output + input/5` | `:84`, `:265-303` |
| Who may use it | `COACH_ALLOWED_USERS`, **unset means everyone** | `:100-113` |

**The five tools disabled at the connector:** `delete_program`, `delete_exercise`, `update_exercise`, `set_training_plan`, `confirm_training_plan`.

**Note the discrepancy:** `README.md` says the coach runs Sonnet. `CLAUDE.md` and the deployed code say `claude-opus-5`. The README is stale. Fix it.

## 2.2 Token weight

**[MEASURED] characters, [ESTIMATED] tokens.**

| Component | Characters | Est. tokens | Cached? |
|---|---|---|---|
| System prompt | 13,958 | ~3,500 | yes |
| 25 tool schemas (JSON Schema on the wire) | 30,156 raw TS | ~11,500 to 13,500 | yes |
| **Cached prefix total** | | **~15,000 to 17,000** | |
| Context block, rich mid-session | 2,085 | ~550 | **no** |
| Context block, minimal | ~450 | ~150 | **no** |
| Conversation history, turn 5 | | ~2,600 | **no** |

**On the prefix size.** A naive 4 chars/token on the raw TypeScript gives ~7,500 for the tools, but zod expands to JSON Schema on the wire and JSON tokenizes nearer 3.3 chars/token, and MCP wraps each tool in a name/description/input_schema envelope. That puts tools at 11,500 to 13,500.

**The code agrees with the larger number.** `index.ts:786` says "The MCP tool definitions are ~17k tokens" and `:800` says "a cold miss on ~17k tokens of tool definitions". Someone read a real `cache_creation_input_tokens` value once.

**Settle this for free:** one `messages.count_tokens` call with the same `tools` and `system` block gives the exact number and re-scales every prefix lever below.

**Whether the 5 disabled tools still occupy the prefix is unverified.** If `configs: {enabled: false}` only blocks execution rather than removing the definition, `set_training_plan` alone (2,248 chars, the second-largest schema) is being paid for on every turn for nothing. Check this with the same `count_tokens` call.

## 2.3 Pricing

**[MEASURED]** current list, September 2026.

| Model | Input $/MTok | Output $/MTok | Cache read (0.1x) | Cache write, 1h TTL (2x) |
|---|---|---|---|---|
| claude-opus-5 | 5.00 | 25.00 | 0.50 | 10.00 |
| claude-sonnet-5 | 2.00 | 10.00 | 0.20 | 4.00 |
| claude-haiku-4-5 | 1.00 | 5.00 | 0.10 | 2.00 |

## 2.4 Cost per turn

The MCP connector runs the tool loop **server-side**: Anthropic's servers call your `mcp-server` function directly. So a turn with N tool calls is **N+1 model passes**, and each pass re-bills the whole input. The prefix is a cheap cache read each pass; everything after the breakpoint (history, context block, tool results) is full price and grows every pass.

### Turn archetypes [ESTIMATED shapes, MEASURED rates]

| Archetype | Passes | Uncached input | Output | Opus cached | Opus no cache | Sonnet | Haiku |
|---|---|---|---|---|---|---|---|
| Cold, 1 tool (first msg) | 2 | 2,520 | 700 | **$0.135** | $0.130 | $0.054 | $0.027 |
| Warm, 2 tools (mid-thread) | 3 | 13,560 | 800 | **$0.103** | $0.238 | $0.041 | $0.021 |
| Deep thread, 2 tools | 3 | 19,000 | 800 | **$0.130** | $0.265 | $0.052 | $0.026 |
| Heavy (screenshot parse or review, 5 tools) | 6 | 48,300 | 2,500 | **$0.334** | $0.604 | $0.134 | $0.067 |

**Arithmetic for the warm typical turn, shown in full:**

```
cache reads:     3 passes x 10,000 tokens = 30,000 x $0.50/M = $0.0150
uncached input:  pass1 3,200 + pass2 4,520 + pass3 5,840
                 = 13,560 x $5.00/M                          = $0.0678
output:          800 x $25.00/M                              = $0.0200
                                                               -------
total                                                          $0.1028
```

### Cost line decomposition, and the finding that matters

Anchoring on the repository's own measurement (`gaps-roadmap.md`): the real user's 13 turns cost ~$0.44 on Sonnet 5 and ~$1.09 on Opus 5, with **64% of input tokens as cache reads**. That is $0.084/turn on Opus.

A turn at 2.0 average passes decomposes as:

| Line | Tokens | $/turn | Share |
|---|---|---|---|
| Cached prefix reads (2 passes) | 20,000 | 0.0100 | 12% |
| **Fresh input (history + context + tool results)** | 10,000 | **0.0500** | **59%** |
| Cache write, amortized over ~5 turns | 1,000 | 0.0100 | 12% |
| Output (thinking + tool args + answer) | 500 | 0.0125 | 15% |
| | | **0.0825** | |

**The single most important number in this section is that 59%.** The intuitive framing blames the 25 tool schemas, which are a cached line worth 12%. **The money is in uncached content being re-billed: conversation history that is never cached, and tool results the server-side loop re-sends at full price on every subsequent pass.**

That reorders the entire optimisation list in Part 5.6.

## 2.5 Cost per active user per month

Reconciling to the repository's own $0.084/turn Opus figure:

```
typical: $4.56 / $0.084 = ~54 turns/month  (1.8/day)
heavy:   $24.75 / $0.084 = ~295 turns/month (10/day)
```

| Tier | Turns/mo | Mix | Opus (cached) | Opus (no cache) | Sonnet | Haiku |
|---|---|---|---|---|---|---|
| Light | 5 | 5 cold | **$0.68** | $0.65 | $0.27 | $0.14 |
| Typical | 30-54 | 10 cold + 15 warm + 5 heavy | **$4.56** | $7.89 | $1.83 | $0.91 |
| Heavy | 150-295 | 30 cold + 95 deep + 25 heavy | **$24.75** | $44.18 | $9.90 | $4.95 |

**On caching:** it does real work on multi-tool turns, 57% off the warm turn. On a single-pass no-tool cold turn the 1h TTL is a **net loss**: the 2x write is $0.10 versus $0.05 uncached, and break-even at 1h TTL is three requests against the same prefix.

## 2.6 Supabase cost

**[MEASURED]** requirement against **[MEASURED]** published pricing.

Supabase Pro is **$25/mo per org** and includes 8 GB database ($0.125/GB after), 250 GB egress ($0.09/GB), 100,000 MAU ($0.00325 after), 100 GB storage, 2M edge function invocations ($2/M after), and $10 of compute credit covering one Micro instance.

Free is 500 MB / 50k MAU / 5 GB egress / 500k invocations, **pauses after a week idle, and has no automated backups**.

### Per-user consumption

| Resource | Per user per month | Basis |
|---|---|---|
| Database | ~160 KB | ~430 sets x 150 B = 65 KB, plus `coach_usage` at 30 turns x ~3 KB = 90 KB |
| Edge invocations | ~250 | 1 coach call + ~2 MCP handshake POSTs + 1 per tool call, ~8 per heavy turn |
| Egress | ~5 MB | after the first exercise-library load |

### Total at scale [ESTIMATED, 12 months accumulation]

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| DB storage | 0.5 GB | 2.2 GB | 19.5 GB |
| Edge invocations/mo | 25,000 | 250,000 | 2,500,000 |
| Egress/mo | 0.5 GB | 5 GB | 50 GB |
| Base | $25 | $25 | $25 |
| DB overage | $0 | $0 | $1.44 |
| Egress overage | $0 | $0 | $0 (50 of 250 GB) |
| Invocation overage | $0 | $0 | $1.00 |
| MAU overage | $0 | $0 | $0 (10k of 100k) |
| Compute above credit | $0 | $0 | $5 (Small) |
| **Total** | **$25** | **$25** | **$32** |

**Supabase is a fixed $25 to $110/month, not a per-user cost.** Marginal cost per user is under a cent until you outgrow the Micro instance. 8 GB of database is about **4,000 user-years**.

### The consequence

| Assuming 30% coach-active | Infra | LLM (realistic band) | Ratio |
|---|---|---|---|
| 100 users | $25 | $30 to $180 | 1x to 7x |
| 1,000 users | $25 | $300 to $1,800 | 12x to 72x |
| 10,000 users | $32 | $3,000 to $18,000 | 94x to 560x |

**At 10,000 users the backend is 0.2% of the bill.** Any effort spent choosing infrastructure to save $10/month while the model spends $8,000 is optimising the wrong term. This is why Part 5.1 recommends staying on Supabase without much agonising.

## 2.7 The dashboard is lying

**[MEASURED]** `v_coach_cost` in `20260831070000_coach_durability_cost.sql` prices at **Sonnet 5 list with a 5-minute cache write**. The function runs **Opus 5 with a 1h TTL**.

| | View says | Actual | Understated |
|---|---|---|---|
| Input | $2.00 | $5.00 | 2.5x |
| Output | $10.00 | $25.00 | 2.5x |
| Cache write | $2.50 | $10.00 | **4.0x** |
| Cache read | $0.20 | $0.50 | 2.5x |

**At the typical mix the sheet reports $1.68/user/month for something that costs $4.56. A 2.7x understatement.**

The fix is one `CREATE OR REPLACE VIEW`, which the migration comment explicitly designed for ("cost lives in a view so re-pricing is one statement and never a backfill").

**This is the first thing to fix in the entire document.** You cannot price a subscription against a number that is 2.7x low, and it has always been wrong, even under Sonnet, because the cache-write TTL was also mismatched.

## 2.8 Gross margin

Net of Stripe at 2.9% + $0.30. Opus, cached, current state.

| Price | Light (5 turns) | Typical (30) | Heavy (150) |
|---|---|---|---|
| $5/mo | $3.83 / **77%** | -$0.06 / **-1%** | -$20.25 / **-405%** |
| $10/mo | $8.68 / **87%** | $4.80 / **48%** | -$15.39 / **-154%** |
| $20/mo | $18.39 / **92%** | $14.51 / **73%** | -$5.68 / **-28%** |
| $30/mo | $28.10 / **94%** | $24.22 / **81%** | $4.03 / **13%** |

Same, on Sonnet 5:

| Price | Light | Typical | Heavy |
|---|---|---|---|
| $5/mo | 85% | 54% | -108% |
| $10/mo | 91% | 75% | -5% |
| $20/mo | 94% | 86% | 46% |
| $30/mo | 95% | 90% | 63% |

### Break-even usage

At a blended $0.152/turn on Opus:

| Price | Opus break-even | Sonnet break-even |
|---|---|---|
| $5 | 29 turns/mo | 74 |
| $10 | 61 turns/mo | 153 |
| $20 | 125 turns/mo | 313 |
| $30 | 189 turns/mo | 473 |

### Realistic-mix margin (9 typical + 1 heavy per 10)

This is the number that should drive pricing, because a cohort is not all typical.

| Price | Margin |
|---|---|
| $9 | **20.7%** |
| $12 | 39.8% |
| $15 | **51.2%** |

**A heavy user at $9 loses $16.31/month.** The in-app coach tier prices at **$15**, not $9. Drop to $9 only if the eval shows Sonnet matches Opus, at which point the same cohort is 64.6%.

**The structural problem, stated plainly: your most engaged customers cost you the most, and there is no cost signal in the product to slow them down.** That is upside-down for a subscription business and it is the reason $20 is the floor in the current architecture.

## 2.9 Abuse and caps

### What works

- **150 turns per rolling 24 hours.** Refusal rows correctly excluded, so a retry after hitting the cap does not extend the window. That was a real bug: counting refusals turned a 24-hour limit into a permanent lockout.
- **800,000 weighted tokens per rolling 30 days**, weighted as `output + input/5`. **This weighting is genuinely good design:** at Opus rates one output token and five uncached input tokens both cost $25/MTok, so the cap is roughly dollar-neutral across attack shapes. It works out to a ~$20 to $25 per user per month ceiling.
- The 40-turn / 20,000-char body cap stops a 500-turn replay.
- A malformed `turn_id` is a 400 before any tokens are spent. A reused one is a 409.
- Usage is written in a `finally`, so an aborted turn still counts.

All of these were real bypasses and all are closed.

### What does not work

1. **The quota is blind to cache tokens.** `overLimit()` sums `input_tokens + output_tokens` only. `input_tokens` from the API **excludes cached reads and writes**, which are recorded in separate columns nobody reads. A tool-loop-heavy pattern (each pass re-reads 10k of prefix) adds $1 to $2/day of spend the cap literally cannot see.

2. **No per-turn ceiling on the tool loop.** Nothing bounds passes except `max_tokens: 16000` of output. `get_recent_sessions` can return 400 sets in one result. A pathological turn re-billing growing results across many passes is a $10 to $15 single request, and nothing checks until after it is paid for.

3. **The monthly cap probably undercounts by 4x.** `coach/index.ts:286-295` selects every `coach_usage` row in a 30-day window and sums in JS, **with no paging**. Your own code asserts PostgREST caps responses at 1000 rows and pages around it (`pwa/src/lib/export.ts:9-11`). At 150 turns/day the window holds up to 4,500 rows. Fix: replace with a SQL aggregate. One hour.

4. **The quota check and the generation are not atomic.** `index.ts:682` checks, `:748` generates. N concurrent requests all pass one check.

5. **No fleet cap.** The only door is `COACH_ALLOWED_USERS`, and **unset means everyone**. Signup is open, the function URL is public, the key is yours. **100 strangers who find the URL are 100 x $25 = $2,500/month with nothing in the code to stop it.** The per-user quota shapes blast radius; it was never a door, and the code's own comment says so.

6. **No cost-denominated cap anywhere.** Everything is token-denominated, so the ceiling silently moved 2.5x the day the model changed to Opus.

### Priority

Fix in this order: (5) set the env var today, (3) the paging bug, (1) count cache tokens, (4) an atomic reserve-then-settle counter, (2) a pass ceiling, (6) denominate the cap in dollars using the corrected view.


---

# PART 3: THE MARKET

## 3.1 Consumer strength logging: pricing

**[MEASURED]** where a price page was reached, **[ASSERTED]** where it came through a search summary. Verify anything you would build a model on.

| App | Monthly | Annual | Free tier | Headline | Scale |
|---|---|---|---|---|---|
| **Hevy** | $2.99 | $23.99, $74.99 lifetime | Unlimited logging; 4 routines, 7 custom exercises, 3 months of graphs | Social feed plus fastest logger. The category default | 16M+ claimed |
| **Strong** | $4.99 | $29.99 ($99.99 lifetime) | Unlimited workouts, 3 routines | Minimalist logger, advanced-lifter favourite | not published |
| **Setgraph** | ~$4.99 | yearly + lifetime | essentials free | Fast logging, Smart Plates | not published |
| **SensAI** | $6.99 | $69.99 (7-day trial) | trial | **LLM coach with injury memory. Closest pure-play comp** | not published |
| **Boostcamp** | $14.99 | $59.99 | 11,000+ free published programs | Free library of real published strength programs | not published |
| **Alpha Progression** | $12.99 | $79.99 | limited | Progressive-overload engine | not published |
| **Fitbod** | $15.99 | $95.99 | trial only | Algorithmic daily workout generator | 15M+ downloads, 2.5M+ active |
| **JuggernautAI** | $34.99 | $349.99 | none | Chad Wesley Smith autoregulation | not published |
| **Ladder** | $29.99 ($14.99 annual equiv) | | trial | Coach-led teams | ~$4M/mo revenue est., raised $100M+ Nov 2024 |

**The one pricing-power signal:** Fitbod **raised prices in 2026** from $12.99/$79.99 to $15.99/$95.99, grandfathering legacy subscribers. That belongs to the app with an algorithmic generator, not to a logger.

**The collision, restated:** you need $20/month (Part 2.8). The category ceiling for anything that is not a named-coach brand is $15.99, and the closest AI-coach comp is **$6.99**.

## 3.2 AI coaching is table stakes, not a differentiator

**Who ships it in 2026:** Hevy (bundled, Feb 2026), Fitbod, Alpha Progression, JuggernautAI, Freeletics, Boostcamp, Jefit, Trainerize, Everfit, plus a long tail of LLM-native entrants.

**Hevy specifically.** "Hevy Trainer" shipped **18 February 2026, bundled into the existing $2.99 Pro tier at no extra charge**. Hevy describes it as algorithmic rather than AI, and it is not a chat coach. Separately Hevy ships **HevyGPT**, an official ChatGPT custom GPT that reads connected training history and writes routines back into Hevy, **available without Pro** (capped by the 4-routine free limit).

**The pricing pattern is unambiguous:** in the consumer strength tier, AI is bundled into the existing price, never sold as an upsell. The only AI features anyone successfully charges extra for are **nutrition** modules on coach platforms (Trainerize +$45/mo, Everfit +$39/mo).

### Does it work?

One rigorous data point. Stanford HCI's **Bloom** (LLM coaching agent "Beebo") ran a four-week field study, n=54, randomized against the same app with LLM features removed. Both arms significantly increased objective physical activity, with the share meeting guidelines doubling from 36% to 72%. The LLM arm reported greater gains in physical-activity mindset and satisfaction and built more varied plans. Best Paper, ACM CHI 2026.

Read honestly: **the app worked; the LLM layer improved subjective measures; the control group also doubled its activity.** Real but modest, in beginners, over four weeks, not in strength programming.

### Does it retain? No.

**This is the most important number in Part 3.** RevenueCat, across 3,500+ AI-powered apps:

- AI apps earn **41% more revenue per user** but **churn roughly 30 to 36% faster**.
- **Annual subscriber retention 21.1% for AI apps versus 30.7% for non-AI.**
- Twelve-month payer retention for AI apps was 9.2% (App Store) and 11.5% (Google Play) in 2025, and 2026 got worse.
- Elevated refund rates suggest overpromising.

RevenueCat's own reading: "novelty or one-off AI gimmicks will only churn in a few months."

### And the margin is structurally worse

A conversational consumer app pays roughly **$0.09 to $18.24 per daily active user per month** in inference at July 2026 list prices. AI-app gross margins run **50 to 60%** (Bessemer, a16z) against 80 to 90% for traditional SaaS; ICONIQ's 2026 surveyed average is **52%**. A heavy user can consume ~50% of their MRR in inference.

SensAI is explicit that this is why it charges $69.99/yr while Hevy charges $23.99: the logger has near-100% margin and the LLM coach does not.

**Competitive position, summarised: you carry a variable cost your main competitor does not have, to ship a feature they already bundle for free, into a subscriber cohort that churns a third faster.**

## 3.3 The MCP cohort

**[MEASURED]** where GitHub was reachable, **[ASSERTED]** for vendor sites that came through search summaries. Most vendor domains were blocked by the network proxy during this review; that is flagged per row.

| Product | Price | Tools | R/W | Capture path | Offline gym client | Models programming | Auth |
|---|---|---|---|---|---|---|---|
| **Trayna** | Free beta [ASSERTED] | not published | R+W | Chat only + web dashboard | **No** | claims "training plans", depth unverified | Google sign-in |
| **Workout Memory** | Free early access [ASSERTED] | 18 | R+W | Chat only; web log viewer | **No** | **No. Diary only** | Paste URL, custom connector |
| **AthleteData** | **$9/mo or $69/yr** MCP; **$39/mo** coach | ~30 integrations | **Read-only by design** | **None. Aggregates others' trackers** | **No** (inherits Garmin/Hevy) | reads planned workouts from sources | OAuth per source |
| **Arvo** | Free tier; Pro ~EUR 4-6/mo | 29 MCP (19R/10W) | R+W | **Native iOS + Android** | **Claimed yes**, cached local models [ASSERTED] | **Yes.** Imports coach PDF/photo | OAuth |
| **Cora** | **$9.99/mo** | **60+** | R+W | **Native iOS + Apple Watch** | not stated | plan + history + templates | **OAuth 2.1** |
| **Assistant Coach** | Free public beta, 15 clients | not published | **Read-only** | Coach-side web + client app | unknown | Yes, full coaching workflow | OAuth, coaches only |
| **Shape** | $5/mo or **$59.99 lifetime** | not published | R+W | Web planner + iOS; pushes to Garmin/Wahoo | No | Yes, but **endurance not strength** | Hosted MCP URL |
| **Training Tilt** | coach platform pricing | not published | R+W | Athlete app; pushes to Garmin/Zwift | No | Yes, coach-authored, endurance | account sign-in |
| **Hevy + community MCPs** | **Hevy Pro $2.99/mo**, API is Pro-gated | chrisdoc ~23; tomtorggler ~17 | R+W | **Hevy app, 15M+ users** | **Yes** | Routines vs workouts. **No %1RM, no coach-authored day** | **Static API key** |
| **MyMovement.Space** | EUR 29/mo | not published | R+W | Companion app, 528+ exercises | unknown | Yes, expert-validated | OAuth, **listed in Anthropic's directory** |

### The fact that reframes the MCP question

**`chrisdoc/hevy-mcp` is an open-source, ~23-tool MCP server for Hevy that reads AND writes workouts and routines, authenticated with a Hevy Pro API key. 453 GitHub stars. There is a hosted Cloudflare Worker at `mcp.hevy-mcp.dev/mcp`. Hevy Pro is $2.99/month.**

The MCP-first strength product already exists at $2.99, with 16 million users, a mature offline gym client, and a watch app, and it can do the one thing this repository's architecture deliberately refuses to do (log a workout from chat).

**"Ship an MCP server" is not differentiation. It is table stakes a competitor reached first via an API key field.**

### The offline finding, precisely stated

- **Zero offline capture:** Trayna, Workout Memory, AthleteData, Assistant Coach, Shape (for strength), Training Tilt, every Hevy wrapper. Trayna and Workout Memory **advertise the absence of an app as the feature**. In a basement gym on airplane mode they are dead products for the next hour.
- **Real offline capture:** Hevy (unambiguously), Arvo (claimed, unverified, ~1,600 Android installs), Cora (native app plus Watch, offline behaviour not stated).

**The accurate claim: no MCP-first product has solved offline gym capture. The two products with real loggers are app-first products that added MCP afterwards. Nobody started from the connector and built down to the barbell.**

### The market already ran the MCP-only experiment and abandoned it

**AthleteData is the only MCP-only product with real money behind it, and MCP-only is their $9 stripped SKU.** The actual product is $39/month proactive coaching over Telegram and WhatsApp. Two founders, launched April 2026, 800+ athletes claimed.

Trayna and Workout Memory are both free, with no announced pricing, no published tool surface, no directory listing, no traction signal, and no discoverable founder.

Near-zero COGS at near-zero price with no distribution is not a business.

### What nobody in the cohort models

- **Nobody has percentage-of-training-max resolved against a maintained TM.** Hevy's routine model is too flat to hold a percentage. "60-75% of 1RM" has nowhere to live in any of these products.
- Nobody has an append-only set log with voids instead of edits.
- Nobody separates a coach's prescribed day from what was achieved against it as first-class rows.
- Nobody models supersets, ramps and sections as structure a coach actually writes.

Assistant Coach and Training Tilt have coach-authored programming but are coach-side and read-only. **Arvo imports a coach's PDF and then lets an AI override it set by set, which is the opposite of what a coached lifter wants.**

### Screenshot parsing plus MCP plus a logger, all three

**Exactly one product: Arvo.** ~29 MCP tools with OAuth, native logger, imports a coach's program from PDF, photo or pasted text [ASSERTED, could not verify]. **It has roughly 1,600 Android installs and three ratings** as of June 2026.

Adjacent: WHOOP added screenshot-to-structured-plan parsing to Strength Trainer in February 2026 but has no user-facing MCP.

**Occupied and defended are different words.**

### The threat to watch

**Cora, not Trayna.** YC W24 (PurplePill AI). Native iOS plus Apple Watch with live strength logging. 4.8 App Store rating. **60+ MCP tools on OAuth 2.1**, nine of them scoped `training:read` / `training:write`. $9.99/month.

App-first with MCP bolted on, which is the direction of travel that matters. **Adding the coached-lifter data model is a quarter of work for them, and being there first does not stop it.**

## 3.4 Distribution

**This section contains the worst news in the review.**

### Anthropic's connector directory [MEASURED]

A primary snapshot of the catalog (capture date 2026-08-10) holds **1,625 connectors across 30 categories**.

- **There is no Health and Fitness category at all.** Fitness lives scattered under "Lifestyle and Local" (54 entries total) and "Healthcare and Life Sciences" (54, overwhelmingly bio/pharma).
- The **complete** fitness-adjacent set is **seven**: COROS, MFIT Personal, MyMovement.Space, Strava, Sweat & Tonic, MyCoach Pro, Alma.
- **None of Trayna, Workout Memory, AthleteData, Arvo, Assistant Coach, Shape, Training Tilt, Cora or Hevy is listed.** Zero hits across the whole catalog.

### The listing process

A Google Form with human review, not an app store. Requirements:

- Live HTTPS endpoint
- **OAuth 2.0 mandatory**
- `readOnlyHint` / `destructiveHint` annotations on every tool
- Human-readable tool titles
- **Published privacy policy and ToS. A missing privacy policy is an immediate rejection**
- A support channel
- 3+ example prompts
- A test account with sample data
- Logo, 3-5 screenshots

Passing lands you as a **community connector**. Anthropic separately picks high-value listings for a **verified** review where testers exercise every tool. No guaranteed turnaround; plan in weeks. No fee found.

**Two immediate consequences for this repository:**

1. **Static API keys disqualify you.** Every Hevy community MCP is structurally unlistable for this reason. So is `strength-tracker` today. **This makes the OAuth work in Part 7 non-optional if MCP is the product.**
2. You need a privacy policy before you can even apply, which folds into the legal work in Part 4.5.

### ChatGPT

OpenAI opened public app submissions and the App Directory in 2026, built on MCP. As of April 2026, 150 apps accepted in two weeks with ~500 in the queue; the directory became the Plugin directory on 2026-07-09. Discovery is in-conversation surfacing plus name-invocation. Roughly one billion weekly users behind it.

**This is the only channel with genuine consumer scale, and it rewards a memorable one-word product name more than keywords.**

### Registries

mcp.so indexed 20,222 servers as of April 2026. Smithery 7,000+. The official `modelcontextprotocol/registry` launched September 2025 and was still in preview as of July 2026.

**These are developer plumbing, not consumer discovery.**

### The honest channel picture

There is no ASO for MCP. There is a form, a several-week human review, an OAuth gate, and a directory with no fitness category and seven fitness entries out of 1,625.

Consumer discovery in 2026 is (a) the ChatGPT app directory plus in-conversation surfacing, (b) being name-dropped in a Claude conversation, and (c) ordinary SEO.

**AthleteData, Cora and Arvo all run enormous content-SEO operations precisely because the directories give them nothing. That is the real channel, and it is the same channel as 2015.**

### Mobile acquisition, for completeness

- CPI averages ~$4.70 iOS, ~$3.70 Android. Fitness subscription CPI benchmarks $4.30 to $5.50.
- Install-to-paid conversion for fitness runs 3 to 8%.
- **Real CAC per paying user: $20 to $80**, or 20 to 50x CPI.
- Against a $24 to $96 annual price at 21 to 31% annual retention, **paid acquisition does not close for a solo developer at any consumer price point in 3.1.**

**Hevy's playbook** was product quality plus SEO plus store algorithms plus social referral, reaching 2M downloads with no paid marketing, 77% of site traffic from SEO by late 2023. **That worked in 2020-2023.** In 2026 the "best workout tracker app" SERP is 40 competitor-published listicles deep, and **ASO is an App Store channel a PWA does not have.**

### The 40+ entrants

Encountered incidentally as *publishers* of competitor comparison content during this research, meaning each is a live commercial entrant: sensai.fit, arvo.guru, prpath.app, push-pull.app, gainframe.app, loadmuscle.com, gymgod.app, getbazu.com, repreturn.com, strive-workout.com, findyouredge.app, corahealth.app, chatrpe.com, mysplit.life, repstack, setgraph.app, gymscore.ai, rayfit.com, titans-grip.com, strongermobileapp.com, hevyload.com, shapecalendar.com, workoutmcp.com, trayna.io, athletedata.health, kensoforge.com, jefit.com, quickcoach.fit, coachway.io, coachbox.app, assistantcoach.fit, fitbudd.com, trainera.fit, pt-suite.com, coachingportal.io, 1fit.com, unlimitr.com, trainwell.net.

**The SEO channel Hevy used to win is now fully saturated by people running the same play.**

## 3.5 Churn

Fitness is the worst consumer subscription category for retention and it is not close.

| Metric | Value |
|---|---|
| Day-30 retention, health and fitness median | **3 to 5%** (strong performers 8-12%, leaders ~25%) |
| Activation, Day 1 to Day 28 | falls from 26% to 10% |
| Monthly subscription churn | 7 to 10%; one 2026 report says **9.2% monthly, 68.4% annual** |
| Annual subscriptions retained | **~33%** |
| Cross-category median monthly subscriber churn (RevenueCat) | 13 to 14% |
| Annual cancellations happening in month one | **35%** |
| Top stated reason for cancelling | **Lost motivation, 38%.** Not price, not features |
| Seasonality | Mass January signup, **40 to 60% cancellation by February** |
| AI apps specifically | **21.1% annual retention vs 30.7%** |

**Two structural notes that cut slightly in your favour.** Health and fitness sells **68% annual plans** (60.6% of category revenue), which papers over monthly churn and pushes the reckoning to month 12. And RevenueCat finds the second annual renewal, around month 24, is where churn stabilises and LTV compounds.

A coached lifter is by construction higher-intent than a New Year's resolution downloader, so your cohort should beat category median. But "beats a 3% Day-30 median" is a low bar, and you would be betting the business on a cohort effect you cannot yet measure. **That is exactly what Wave 2 in Part 7 exists to measure.**

## 3.6 The coach-client segment

**The coach pays. Always. The athlete gets the app free.** Uniform across TrueCoach, Trainerize, Everfit and TrainHeroic.

| Platform | Coach pricing | Athlete pays | AI status |
|---|---|---|---|
| **TrainHeroic** | from $9.99/mo + **$1/athlete**; bundles ~$30/5, $99/20, $199/50; enterprise **$0.50/athlete** at 1000+ | Free | not a headline feature |
| **TrueCoach** | $29.98/mo (5 clients), $69.98 (20), $164.98 (50) | Free | **No AI program building at all** |
| **Everfit** | Free tier; $19/mo at 5, $29 at 10, $95 at 50, $160 at 100, $290 at 300 | Free | AI workout builder included; **AI meal planning +$39/mo** |
| **ABC Trainerize** | Free (1 client), ~$9-10 (2), ~$22-23 (5), to ~$225 (200) | Free | AI Workout Builder included, **accepts PDF, Excel or text uploads**; AI meal planning **+$45/mo** |

### Derived price per athlete per month

- TrueCoach: ~$6.00 at 5 clients, ~$3.50 at 20, ~$3.30 at 50
- Everfit: ~$3.80 at 5, ~$1.90 at 50, ~$0.97 at 300
- TrainHeroic: **$1.00**, **$0.50** at enterprise scale
- Trainerize: ~$4.40 at 5, ~$1.12 at 200

**This is the single hardest number in the review.** The B2B2C wedge means selling into a market whose incumbent price floor is **$1 to $4 per athlete per month**, where the buyer already owns billing, messaging, check-ins, nutrition, video and habit tracking, and where switching costs are their entire client roster. **TrainHeroic at $1/athlete is not a price you undercut; it is a price that says the logging layer is a commodity input.**

### What coaches actually want AI for

FitBudd's 2026 survey: 91% of coaches now use AI, 75% started only in 2024-25, 71% plan to increase.

- **73% use it for content creation** (social, email, marketing copy).
- **Workout programming ranks considerably lower** in perceived value.
- 43% fear being outpaced by AI-using peers; only 20% think AI threatens the coach-client relationship.

**Coaches are buying AI for marketing, not for programming, and the thing they most want to protect is the judgment layer.** A pitch that says "AI analyzes your athlete's log" is the closest thing to the one job they are protecting.

### Segment size

400,000+ US personal trainers certified by major bodies. 21% plan to work exclusively online, 62% hybrid. Online coaches charge clients $150 to $300/month.

**The software TAM is small:** personal-trainer software at **$780.5M in 2025** rising to ~$1.85B by 2033 (Straits), or **$627M in 2026** for "online personal training software". The frequently quoted "$48B online fitness coaching market" measures coaching *services*, not software licences.

## 3.7 Where the gap actually is

Given everything above, exactly one position is unoccupied:

**The athlete-side client for someone who already has a human coach who programs outside any platform.**

Not "athlete with an online coach on TrueCoach", because that athlete's logger is already free and already integrated. The wedge is the athlete whose coach hands them a Google Sheet, a photo of a whiteboard, or a Notion page, and who currently retypes it into Hevy every week.

For that person, parse plus log plus analyze is genuinely one product instead of three. Nothing on any list in this section serves exactly that:

- MySplit and Repstack parse but do not do the coach loop.
- Hevy logs but cannot hold a percentage or a prescription.
- TrueCoach requires the *coach* to adopt it.
- Arvo imports the coach's program and then overrides it.
- Trayna and Workout Memory have no capture client and no prescription model.

### Four things that make even that gap hard to monetize

1. **It is small.** Coached lifters are a minority of lifters. Coached lifters whose coach refuses a platform are a minority of those. And that population skews toward powerlifting and strongman, the most price-resistant and most spreadsheet-loyal niches in the sport.

2. **The buyer with money is the coach, and the coach's ceiling is $1 to $4 per athlete.**

3. **Coaches are buying AI for marketing, not programming.**

4. **A PWA cannot reach these people.** No App Store listing, no ASO, no install prompt on iOS, and organic search occupied by 40 competitors.

### The strategic sentence

**The MCP server is not the moat, it is the demo.** Every product in 3.3 has one and Anthropic's directory has 1,625 of them.

**The moat, such as it is, is the offline write path and the prescribed-versus-achieved schema, both of which are boring database work the MCP-native cohort skipped because it is hard and unglamorous.**


---

# PART 4: SECURITY, PRIVACY AND LEGAL

## 4.1 What is genuinely fine

**Do not spend money here.** An independent audit went looking for a cross-tenant read or write path in the database and the MCP server and **could not find one**.

### RLS is complete [MEASURED]

All **20 tables** have `enable row level security`. All **13 views** carry `security_invoker = true`. No table with RLS off, no view running as definer.

| Table | Policies |
|---|---|
| `exercises` | select (shared-or-owned), insert (`source='custom'`), update/delete (custom + owned) |
| `training_maxes`, `goals`, `coach_memory` | owner select/insert/update/delete |
| `exercise_notes`, `user_config`, `feedback`, `training_plans`, `plan_phases` | owner select/insert/update, **no delete** |
| `programs` | owner select/insert/update; `programs_delete` **dropped** (`20260905010000:26`) |
| `planned_workouts` | owner select/insert/update; `pw_delete` **narrowed** to `pw_delete_template` (`:27,42-44`) |
| `prescriptions` | owner CRUD; delete guarded by `prescriptions_keep_logged_history` trigger |
| `sessions` | select/insert/update, **no delete** (`20260825120002_rls.sql:56-58`) |
| `sets` | **select + insert only** (`:61-62`) |
| `set_voids`, `set_notes` | owner + `exists(...)` proof the set is theirs |
| `exercise_owners` | select + insert owner; delete **dropped** |
| `coach_usage` | select owner only; no client write path |
| `mcp_tokens` | RLS on, **zero policies = deny all** |
| `app_config` | select-only to `authenticated`, no write policies |

UPDATE policies without `WITH CHECK` (e.g. `tm_update`) are fine: Postgres reuses the `USING` expression as the check, so `user_id` cannot be rewritten to another user.

### Every MCP tool filters by `db.ownerId` [MEASURED]

All 20 tool files checked. The three unscoped reads are safe: `find_similar_days.ts:194`, `get_recent_sessions.ts:136` and `training_plan.ts:288` read `exercises` by ids the caller already references or that `visibleExerciseIds` already filtered.

`upsert_program.ts:428-430` updates a program by id with no owner filter, but that id was created three statements earlier in the same call. `get_lift_history.ts:104` passes a variable table name from two hardcoded literals. `search_exercises.ts:95-100` interpolates ids into a PostgREST `or()` string, and those ids are constrained by `check (id ~ '^[0-9a-zA-Z_-]+$')` at `20260825120001_schema.sql:19`, so no injection. `safeFilterTerm` (`lib/filters.ts:19`) handles the query term.

### Token model is sound

32 bytes CSPRNG, SHA-256 at rest only (`scripts/issue-mcp-token.mjs:50-51`), timing-safe compare (`lib/auth.ts:38-45`), coach mints a per-turn token and revokes it in `finally` (`coach/index.ts:209-262, 916`). A leaked token is one user's data only, revocable with one UPDATE.

### Other things that are correct

- **No client-side service role exposure.** `pwa/src/lib/supabase.ts` uses the anon key only. Grep for `eyJ` / `sk-ant` across the repo returns only placeholders.
- **No XSS sink.** Model output goes through `markdown.ts` to elements, never `dangerouslySetInnerHTML`.
- **Passwordless OTP.** No password reset, no leaked-password check, no credential stuffing. Cross that whole category off.
- **CI actually tests isolation.** `scripts/validate-db.mjs:346-398` asserts cross-user reads return zero rows and that `sets` update/delete affect zero rows.
- **CORS `*` on both functions is fine.** Bearer auth, no cookies, so no CSRF. Health returns nothing about who exists.

## 4.2 Blockers to selling

### S1. Unbounded Anthropic spend from free signups
**`coach/index.ts:102-110, 628-635`**

`COACH_ALLOWED_USERS` unset means everyone, by design. Signup is open (`signInWithOtp` with default `shouldCreateUser`, `pwa/src/screens/Login.tsx:56`), the function URL is public, and the key is yours.

Per account the ceiling is 150 turns/day and roughly $50/month of Opus. Two multipliers on top: the quota check at `:682` and the generation at `:748` are **not atomic**, so N concurrent requests all pass one check; and nothing caps how many accounts one person makes.

**Exploit:** script 50 signups, fire parallel turns, five figures a month.
**Fix:** gate the coach on a paid entitlement row rather than an env allowlist, plus a per-user advisory lock or an atomic reserve-then-settle counter around `overLimit`. **8-14 h.**
**Mitigation available today at zero cost:** set `COACH_ALLOWED_USERS` to your real user ids.

### S2. Every customer's coach conversation stored in plaintext by default
**`coach/index.ts:520, 555-556`; `20260831050000_coach_observability.sql:24-32`**

`COACH_LOG_CONTENT` defaults to `"on"`. Prompt and full response text land in `coach_usage.prompt` / `.response`, readable by whoever holds the service role. The migration comment says "if a second person ever uses this deployment, they should be told."

Injuries live in `coach_memory` (the enum is `('injury','constraint','preference','context')`, `20260831100000:13`) and flow into these prompts. `sessions.bodyweight_kg` exists at `20260825120001_schema.sql:104`. **Those two facts move this out of "it is just numbers" territory.**

**Fix:** flip the default to off (zero hours, the mechanism writes NULL), then opt-in plus a 30-day retention window if you need it for debugging (~6 h), plus a consent screen (~3 h), plus one honest sentence in the privacy policy.

**This is the single best hours-to-risk trade in the entire document.** Turning the logging off is cheaper than disclosing it well, and it removes the CIPA hook, the HBNR blast radius, and the Amazon-shaped retention problem at once.

### S3. No account deletion, and export is partial
**`pwa/src/lib/export.ts:96, 107, 117`**

Export covers `sessions`, `v_live_sets`, `set_notes` and settings. It does **not** cover `programs`, `planned_workouts`, `prescriptions`, `goals`, `training_maxes`, `exercise_notes`, `coach_memory`, `training_plans`, or `coach_usage`.

There is no delete-account path anywhere. Every table cascades from `auth.users` on delete, so the DB side is nearly free; you need the endpoint, the UI, and the coach-conversation purge.

**Note the design tension and write it down:** "append-only" and "delete my account" are both true. The resolution is that account deletion cascades while individual sets stay void-not-delete.

**Fix:** complete the export, add a service-role delete endpoint. **10-16 h.**

### S4. Auth email runs through personal Gmail SMTP
**`supabase/config.toml:25-32`**

`smtp.gmail.com` with `SMTP_USER` / `SMTP_PASS`. Gmail caps around 500 sends/day and will flag the account.

**This is an attack surface, not just a ceiling.** Anyone can call `signInWithOtp` with arbitrary addresses. Supabase's hourly email rate limit then means **one attacker locks out sign-in for every real customer**, and the bounce traffic kills your deliverability permanently. It is also the single point of failure for all authentication, since there are no passwords.

**Fix:** Resend, Postmark or SES with a real sending domain and SPF/DKIM/DMARC. **3-5 h.**

## 4.3 Fix before paid users

### F1. `update_exercise` writes rows every other tenant reads
**`tools/manage_exercises.ts:45-53, 261, 263-266`**

`assertVisible` returns immediately for any row with `source !== 'custom'` (line 46), so an MCP token holder can rename, re-muscle or re-equipment any of the ~873 seeded library rows **for everyone**. The name then reaches every account through `search_exercises`, `get_program`, and the PWA context block.

RLS blocks this on the PWA path (`exercises_update_own_custom` requires `source='custom'`) and the coach disables the tool at the connector (`coach/index.ts:840`), so today it needs a manually issued token. **But shipping MCP access is the product, so the first customer you hand a token to gets a write into everyone else's data.**

The 80-char plain-text constraint (`20260905020000:36-49`) stops structural prompt injection, not vandalism or slurs.

**Fix:** copy-on-write (an edit forks a private `custom` row) or restrict `update_exercise` to custom-and-owned. **6-10 h.**

### F2. Legacy shared secret still accepted
**`supabase/functions/mcp-server/lib/auth.ts:85-90`**

If `MCP_SECRET` / `OWNER_USER_ID` are set, anyone holding that string **is** that user: no row in `mcp_tokens`, no expiry, no `revoked_at`, no way to revoke except a redeploy. Checked before the database, so it also bypasses the `last_used_at` audit stamp.

**Fix:** delete the branch, unset the secrets. **0.5 h.**

### F3. Users cannot mint, list, or revoke their own MCP tokens
**`scripts/issue-mcp-token.mjs:59-62`**

Issuance is you running a script and pasting SQL. No token list, no rotation, no "this device was compromised" button. A customer whose laptop is stolen has to email you.

**Fix:** a token management screen plus a service-role mint/revoke endpoint. **10-14 h.** (This is also Wave 3a's Connect screen, so it does double duty.)

### F4. No rate limiting on the MCP server at all
**`lib/handler.ts:130-246`**

Deployed `--no-verify-jwt` (`.github/workflows/deploy.yml:105`), so the gateway does not throttle it either. Every request, valid or not, costs an UPDATE against `mcp_tokens` (`auth.ts:108-119`). One token can run unlimited tool calls; unauthenticated traffic still forces a DB round trip each.

**Fix:** per-token and per-IP counters, in-isolate or in a small table. **4-8 h.**

### F5. No per-user resource quotas anywhere
**`20260825120002_rls.sql:22-23`**

`exercises_insert_custom` lets any authenticated user insert unlimited rows into the shared `exercises` table. Nothing caps `sets`, `set_voids`, `feedback` or `coach_memory` either. Free-tier Postgres is 500 MB.

**Fix:** row-count triggers on the two or three tables that matter. **4-8 h.**

### F6. The monthly spend cap probably undercounts 4x
**`coach/index.ts:286-295`**

Selects every `coach_usage` row in a 30-day window and sums in JS, with no paging, while your own code pages around PostgREST's 1000-row cap elsewhere. At 150 turns/day the window holds up to 4,500 rows.

**Fix:** SQL aggregate. **1 h.**

### F7. Backups and restore are undocumented and untested

Nothing in `docs/deploy.md` or `docs/setup.md` mentions backup, restore, or PITR. Free-tier Supabase gives daily backups with **no** point-in-time recovery.

**Fix:** Supabase PITR is ~$100/month per 7-day window. Buy it the day someone pays, not before. Do one rehearsed restore and write it into `deploy.md`. **4 h.**

### F8. No Content-Security-Policy
**`pwa/index.html:1-20`**

GitHub Pages cannot set response headers, and there is no `<meta http-equiv>` CSP either. **You currently have zero CSP.** The XSS surface is small (React, no innerHTML), but you have an LLM rendering attacker-influenced text and no `frame-ancestors` protection.

**Fix:** falls out of the Cloudflare Pages move, which supports a `_headers` file. **2-3 h including the move.**

### F9. No session revocation and no audit log

No operator path to invalidate a user's refresh tokens. No record of who signed in, who changed what, or who read what. The only audit trail in the system is `exercises.updated_at` / `updated_by` and `coach_usage`.

Note that `exercises_insert_custom` does not constrain `updated_by`, so a client can set it to another user's uuid on insert. Nothing branches on it, so this is forgery of an audit field rather than an authorization bug.

**Fix:** admin revoke endpoint plus an append-only `audit_events` table for privileged actions. **8-12 h.**

## 4.4 Top attacks, ranked by ease times damage

1. **Sign up, hammer the coach in parallel from N accounts.** No card required, quota is per account and racy. Direct cash loss, no skill needed. (S1)
2. **Spray `signInWithOtp` at arbitrary addresses.** Exhausts the Gmail send quota, locks every real customer out of sign-in, burns your sending reputation. One curl loop. (S4)
3. **Buy one seat, get an MCP token, rename the shared exercise library.** Every other tenant's app and coach context changes. Not detectable by them; you have no audit trail to attribute it. (F1)
4. **Bulk-insert junk into `exercises` and `sets` from a normal session token.** No quotas, RLS permits it, fills the database. (F5)
5. **Grind the MCP endpoint.** No rate limit, no JWT gate, one DB write per attempt. A bill and a latency problem, not a breach. (F4)

**Notably absent: reading another tenant's training data.** The audit looked for it specifically through RLS, the views, and all 20 MCP tools and did not find a path.

## 4.5 Legal

**Not legal advice.** Items marked `LAWYER` are ones where being wrong is expensive and the answer depends on facts a repository cannot settle.

### The open-source position

`LICENSE` is MIT, `Copyright (c) 2026 Colt Bradley`. Two committer identities, no third-party human contributors.

**You can relicense everything going forward, unilaterally.** Relicensing normally requires permission from every contributor holding copyright, and a single significant contributor can block it. You have none. `LAWYER` on whether the Claude-authored commits create any residual claim; the practical position is that Anthropic's Commercial Terms assign output ownership to the customer, so there is nothing to clear, but a buyer's diligence will ask.

**The free-exercise-db dependency is a non-issue.** Unlicense is a public-domain dedication and imposes no downstream condition.

**You cannot claw back what is already published.** Every commit currently on GitHub stays MIT forever. Relicensing at commit N+1 means the last MIT snapshot is a permanent, forkable, self-hostable product. That is exactly what happened to HashiCorp: the BSL change spawned OpenTofu from the pre-change tree.

**Can someone fork and self-host?** Yes, and `docs/setup.md` is the instruction manual. But the forker needs their own Supabase project **and their own Anthropic key**, so there is no free ride on your inference bill. Realistically a weekend for a competent developer and a non-starter for a lifter.

**What is theater: relicensing to AGPL.** AGPL's mechanism is forcing a network-service competitor to publish modifications. Your competitor is not AWS, it is one person who wants a free workout log and will never distribute anything. AGPL costs you the goodwill of a public repo and buys nothing enforceable.

**What is real:** the honest question is not "how do I stop forks" but "what do subscribers pay for that a fork does not give them." Today: a hosted Supabase, a managed Anthropic key, and you keeping it alive. That is a genuine product. Consider FSL or BSL if you ever want a shield against a funded competitor rebranding it. **Cost to relicense: 1 hour, $0.**

### Health data

**HIPAA almost certainly does not apply, and the reason is precise.** HIPAA reaches covered entities and their business associates. A direct-to-consumer app collecting data for its own purposes, with no covered entity in the chain and no BAA, is outside the definition. It does not become PHI because it is health-ish; it becomes PHI because of who you are working for, and you are working for the lifter.

**Sequel:** Supabase has no HIPAA path below the Team plan (BAA plus a $350/mo add-on on Team at $599/mo). If a gym or clinic ever asks you to take their members' data, the answer is no until that spend makes sense.

**The FTC Health Breach Notification Rule DOES apply and is the sharpest US exposure.** The 2024 final rule, effective 29 July 2024, was written specifically to pull in health apps and DTC wellness technology. Two details matter:

1. It reaches **"emergent health data"**, health information inferred from non-health inputs, which is a fair description of what an LLM coach does with a training log.
2. A "breach of security" includes unauthorized **disclosure**, not only a hack. That is the theory used against GoodRx and BetterHelp.

Notification runs to individuals, the FTC, and media for large breaches, within 60 calendar days of discovery, with civil penalties up to **$53,088 per violation**.

**Enforcement record:** BetterHelp **$7.8M** for sharing health information with ad platforms it had promised to keep private. GoodRx **$1.5M** plus a permanent ban on ad disclosures. **Neither was a hacker. Both were a pixel.**

**Practical consequence, and it is a code decision not a document:** do not put Meta, Google Ads or any ad-tech pixel on any authenticated page, ever. Do not send Sentry anything from `coach_memory`, `coach_usage`, or `sessions.bodyweight_kg`. That single discipline eliminates most of the realistic HBNR risk.

**Washington My Health My Data Act has a private right of action and no revenue threshold.** Covers regulated entities doing business in or targeting Washington consumers, regardless of size. Consumer health data is defined expansively and the healthcare-services definition explicitly reaches fitness. It requires a **separate consumer health data privacy policy**, distinct from your general one, linked from the homepage. ~2 hours on top of the main policy.

**CCPA/CPRA: you are not covered.** The 2026 threshold is $26,625,000 in annual gross revenue, or 100,000+ California consumers' data bought/sold/shared, or 50%+ of revenue from selling data. Ignore vendor blogs claiming otherwise; that is compliance-tool marketing.

**Connecticut and Texas do bite at your size.** Connecticut SB 1295, effective 1 July 2026, dropped the general threshold to 35,000 consumers **and added a no-threshold trigger for controllers processing sensitive data**, which in Connecticut includes consumer health data. `LAWYER` on whether that genuinely catches a one-person operation; the text reads like it does. Texas TDPSA has no threshold but exempts SBA-defined small businesses, with the carve-out that even exempt small businesses cannot sell sensitive personal data without consent. You are not selling data, so Texas is cheap.

**GDPR/UK GDPR applies only if you target the EU, and "target" is a real test.** Article 3(2) turns on offering goods or services to people in the Union, evidenced by EU currency pricing, localised content, or EU-directed marketing. **Merely being reachable is not targeting. But the moment you price in EUR through a merchant of record, you have targeted.**

If you do: injury data and bodyweight are **Article 9 special category data**, requiring explicit consent, not legitimate interests. And the Article 27 EU representative exemption will not save you: it requires processing that is occasional, not large-scale special category, **and** low risk, all three. Representative services run roughly EUR 490 to 710/year, and you need a separate one for the UK.

**The Replika fine is the cautionary tale:** EUR 5M from the Italian Garante in April 2025 for processing without a lawful basis, inadequate transparency, and no age verification, on a chatbot that encouraged users to disclose sensitive thoughts.

**Recommendation: geo-block the EU and UK at launch.** Not forever. Until revenue justifies ~EUR 1,200/yr in representatives plus a consent architecture for special category data. Say so plainly in the terms. **This is the single highest-leverage legal decision in the document. ~4 hours to implement.**

### Required versus theater

| Item | Verdict | Cost |
|---|---|---|
| Privacy policy, specific about `coach_usage`, `coach_memory`, subprocessors | **Required.** The document the FTC reads first | in the ToS engagement |
| Separate WA consumer health data policy, homepage link | **Required** if you accept WA users | ~2 h |
| Data export | **Required**, trivial for you, the schema is clean | ~4 h |
| Account deletion | **Required.** `on delete cascade` already does most of it | ~4 h |
| DPAs with subprocessors | Half theater. Supabase and Anthropic offer standard DPAs you accept, not negotiate. Sign anyway, they are free diligence artifacts | 1 h |
| Breach response plan | **Required, cheap, everyone skips it.** One page: who you notify, in what order, from what template | ~2 h |
| SOC 2, ISO 27001, HIPAA BAA | **Pure theater at this stage.** Tens of thousands for buyers you do not have | - |

### AI and liability

Two risks, and people conflate them.

**Injury liability.** A lifter follows an LLM-generated program and hurts their back. Defenses: a liability waiver plus assumption of risk, an LLC, and insurance. Gyms have run on that stack for decades. What is untested is whether "an AI told me to" changes the analysis. `LAWYER`, and the honest answer is nobody knows yet.

**Deceptive claims liability. This is where enforcement actually lands.** FTC Operation AI Comply launched 25 September 2024 and continues under the new administration. The line is "there is no AI exemption from the laws on the books." On the fitness side the enforcement is unglamorous: NextMed, final order 2025, for unsubstantiated weight-loss claims **plus deceptive billing and cancellation**. Evoke Wellness settled June 2025 for $1.9M.

**Note what NextMed was really about: billing and cancellation as much as claims.** That is ROSCA and the negative-option rule, and for a subscription app it is a more likely trip-hazard than anything about AI.

**What live AI fitness apps do**, surveying UltraFit360, PepCoach.AI, NOWFit, Elio Fit, MyLift AI and AI Workout Buddy: four shared moves. The app is a fitness guidance tool and not a medical provider; output is informational only; consult a healthcare professional before starting, **sometimes as an onboarding checkbox rather than buried text**; stop and seek medical attention on pain, dizziness or shortness of breath.

**The onboarding checkbox is the meaningful one**, because it creates a record of assent.

- **Required:** ToS with limitation of liability and assumption of risk, an onboarding acknowledgement checkbox, and an in-product disclaimer near the coach itself.
- **Required:** claim discipline in marketing. Never write "gets you stronger", "optimizes your program", or any outcome number you cannot substantiate.
- **Theater:** a wall of medical disclaimer text nobody reads.
- **Theater at your stage:** a certified-trainer human review layer. Anthropic's High-Risk requirements ask for that in healthcare *diagnosis and treatment*; strength programming is not that.

**Cost:** ToS 6-10 h DIY from a template, or **$1,500 to $3,000** with a lawyer. Combine with the privacy policy in one engagement. Tech E&O plus cyber insurance runs ~$800-2,500/yr and ~$1,000-3,000/yr respectively. Defer insurance until you have paying users; buy it the same week you do.

### Anthropic commercial terms

**You can build a paid product on the API, explicitly.** Anthropic permits customers to use the Services to power products made available to their own customers. Output ownership is assigned to you. Your architecture (one server-side key with per-user quota tracking) is the normal pattern.

**Prohibited:** reselling the Services except as expressly approved, and building a competing product or training competing models. Keep the distinction clean: pay for API usage on an API key, **never route a consumer product through a personal Claude subscription**. Selling a strength-training subscription that happens to call the API is not reselling. `LAWYER` if you ever expose a raw chat box with no product framing.

**Disclosure that it is AI: treat as a hard requirement.** Anthropic's Usage Policy tiers into Universal Standards, High-Risk Requirements, and Additional Use Case Guidelines, the last explicitly covering consumer-facing chatbots, with disclosure to end users at least at the start of each session.

**Is fitness restricted?** Healthcare *diagnosis or treatment recommendations* is high-risk. Strength programming is not. **But your `coach_memory` injury enum sits uncomfortably close:** a coach that reads "left shoulder impingement" and adjusts the program is doing something a regulator could characterize as working around a medical condition.

**The cheap fix, and it matches how you already think:** a system prompt boundary the coach will not cross (it programs around a constraint, it never assesses, diagnoses or rehabs) **plus** the structural version. You already disabled `delete_program`, `delete_exercise` and `update_exercise` at the connector layer rather than trusting a prompt. Do the same thinking here. **2 hours.**

**Rate limits are not a gate at your size,** but **the $500/month Start-tier spend cap is.** A hundred engaged subscribers can walk into it, at which point requests return HTTP 429 with `error_code: enforced_spend_limit_reached` and **no retry-after**, so SDK auto-retry will not save you, and it does not clear until 00:00 UTC on the first of the month.

### Payments and entity

**Fees.**

| Option | Rate |
|---|---|
| Stripe direct | 2.9% + $0.30, plus Stripe Billing 0.7% on recurring, plus Stripe Tax 0.5%, plus ~1.5% international and 1% FX. **All-in 4.5% to 6.5%** |
| Paddle | 5% + $0.50 |
| Lemon Squeezy | 5% + $0.50 (acquired by Stripe July 2024; direction is migration to Stripe Managed Payments) |
| Stripe Managed Payments | 3.5% **stacked on top of** standard Stripe fees. All-in ~6.4% domestic, 8-10% international |

**The admin burden is the real decision, and the two sides are not symmetric.**

**US sales tax:** you owe nothing anywhere until you cross a state's economic nexus, usually $100,000 in that state, plus physical nexus in your home state from day one. Illinois removed its 200-transaction threshold effective 1 January 2026. **For a solo dev selling a consumer subscription, this is close to theater in year one.** Register in your home state, use Stripe Tax to watch thresholds, revisit annually.

**EU VAT: the opposite.** **There is no registration threshold for non-EU sellers of B2C digital services. VAT is due from the first sale.** You would register for Non-Union OSS in one member state and file quarterly. That is a real recurring obligation for a one-person business, and it arrives with your first EUR 9 subscriber.

**So the recommendation falls out of the geo-blocking decision, not the fee table.** Geo-block the EU and UK: Stripe direct plus Stripe Tax, cheapest fees, best subscription tooling, tax problem dormant. Sell to the EU: take a merchant of record and pay the extra 2 to 3 points, because Paddle becoming the legal seller is what makes the VAT problem theirs. **Do not sell to the EU on Stripe direct and plan to sort out VAT later.**

**Does an LLC matter?** Yes, but for a specific reason: it separates personal assets from claims arising from the business (an injury claim, a data incident, a subscriber dispute). It does not protect against your own professional negligence and it collapses if you commingle funds. Cost is small: $35 to $500 formation, registered agent ~$125/yr, annual report $0 to $800.

**Use Graphite Productions or form new? Form a new one.** Graphite is a video production company with client relationships and its own liabilities. A consumer health-data app with injury records and an LLM giving training advice is an unrelated risk pool. You do not want a subscriber's claim reaching into the business that pays your bills, or a client dispute reaching the app. Separate entity, separate bank account, separate Stripe account. `LAWYER` and `ACCOUNTANT` on the tax election.

### Hosting: GitHub Pages prohibits this

**[MEASURED]** GitHub's Terms for Additional Products and Features state that GitHub Pages "is not intended for or allowed to be used as a free web hosting service to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or **providing commercial software as a service (SaaS)**", and notes Pages sites should not be used for sensitive transactions.

A paid PWA served from Pages is squarely inside that. **The failure mode is not a lawsuit, it is GitHub disabling Pages for your repo with little notice while your paying subscribers see nothing.**

**Move to Cloudflare Pages before the first invoice. Two hours, $0.**

### App stores, if you later wrap the PWA

Facts differ from intuition here and all the differences are in your favour.

**Apple, US.** After the April 2025 contempt ruling, the Ninth Circuit lifting the stay in April 2026, and the Supreme Court declining to pause it in May 2026, **US apps can link out to external payment with Apple currently collecting zero commission.** On 13-14 August 2026 Apple proposed 15% standard / 10% for subscription renewals and partner programs / **5% for Small Business Program** on link-outs. **Epic objected and as of early September 2026 the district court has not ruled.** The Supreme Court hears Apple's challenge in the term beginning October 2026. In-app remains 30%, or 15% under the Small Business Program (under $1M prior-year proceeds; new developers get 15% from day one).

**Google.** Epic and Google settled in March 2026; the new structure rolled out in the US, UK and EEA on 30 June 2026: **10% on the first $1M in annual earnings, 10% on subscriptions**, 20-25% above the threshold, a 5% billing fee only through Google Play Billing, and in the US alternative billing carries no platform fee under the injunction. Global rollout by 30 September 2027. **For an app under $1M, Android is now close to a 10% platform.**

**Practical read: do not wrap yet.** You have a PWA. Wrapping costs two developer accounts ($99/yr Apple, $25 one-time Google), review cycles, and a wrapper build to maintain, in exchange for discovery you do not yet need. The commission landscape is actively improving and unsettled; every month you wait, terms get better. **Wrap when a user tells you they cannot find the app.**

**One thing to fix before wrapping:** Apple requires an in-app account deletion path for any app with account creation, and health-adjacent apps get extra review scrutiny. Build deletion for S3 anyway and you have cleared it.

## 4.6 The three legal gates

Everything above is real. Only three items stand between you and a first paid subscriber.

### Gate 1: An entity, a merchant, and terms that create an enforceable contract
Form the LLC separate from Graphite Productions. Business bank account. Stripe connected to it. Publish a ToS (limitation of liability, assumption of risk, subscription and cancellation terms) plus a privacy policy that honestly describes `coach_usage`, `coach_memory` and `sessions.bodyweight_kg`.

**~20 hours plus $2,000 to $3,500** if a lawyer reviews the pair. For a health-adjacent AI product holding a stranger's injury data, that is money well spent. **This is the one I would not DIY.**

### Gate 2: Paid infrastructure and health-data hygiene, before the first charge
Supabase Pro so backups exist. Off GitHub Pages. `COACH_LOG_CONTENT=off`. Zero ad-tech pixels on any authenticated route, nothing sensitive to Sentry. Working export and delete.

**~20 hours plus $25/month.** The first three are afternoons; the last two you should build anyway.

### Gate 3: A decision on geography, made deliberately and enforced in code
EU or not is not a marketing question. It is the difference between a $25/month hobby-scale operation and one carrying VAT-from-the-first-sale, an Article 27 representative in two jurisdictions, explicit consent for Article 9 injury data, and Replika-shaped exposure.

**~4 hours to implement the block. Deciding is free; getting it wrong is not.**

**Total to a defensible first paid subscriber: 45 to 60 hours of your time, $2,500 to $4,500 up front, about $50/month running plus variable Anthropic COGS.**

### What needs a lawyer, explicitly

1. The ToS and privacy policy pair, drafted or reviewed by someone who has done consumer health apps.
2. Whether Connecticut's no-threshold sensitive-data trigger reaches a one-person operation.
3. Whether your liability waiver survives an injury claim in your state, and whether "an AI generated the program" changes it.
4. Whether logging and reading users' coaching conversations creates CIPA exposure given Anthropic's no-training commitment and 7-day default API retention. **My read is you have good facts and should still not rely on them when turning the flag off is free.**
5. The entity and tax structure relative to Graphite Productions.


---

# PART 5: ARCHITECTURE DECISIONS

## 5.1 Supabase: stay. The migration math is not close.

### Lock-in, measured rather than assumed

| Feature | Count | Portable to another Postgres? | Portable off Postgres? |
|---|---|---|---|
| `create policy` | 60 (11 migrations, 20 tables) | Yes, verbatim | No |
| `security_invoker` views | 13 views, 34 declarations | Yes, verbatim | No |
| Triggers | 4 | Yes | No |
| PL/pgSQL functions | 6 | Yes | No |
| Partial unique indexes | 2 | Yes | Mostly no |
| Indexes | 22 | Yes | Partly |
| **Generated columns** | **0** | n/a | n/a |
| **`create extension`** | **0** | n/a | n/a |
| `auth.uid()` | 91 usages | 10-line shim | No |
| `references auth.users` | 21 | one migration | No |

**The zero-extension finding is deliberate.** `20260905060000_training_plans.sql` explicitly declines an exclusion constraint because PGlite (the validation path) cannot load `btree_gist`, and uses an AFTER ROW trigger instead. **The schema is stock Postgres and moves to Neon, Fly, PlanetScale Postgres or a Hetzner box essentially unchanged.**

**The lock-in is in the two layers above it:**

**PostgREST.** 67 query chains in the PWA (~412 lines across 10 non-test files, 58 of them in `data.ts`), plus **103 in the edge functions**. **170 total**, which would become 60 to 90 hand-written endpoints. PostgREST-specific semantics in use: `onConflict` (7 sites), the 1000-row cap worked around with explicit paging, embedded resource syntax (`sets!inner(exercise_id)`), and the bulk-insert-fills-missing-keys-with-NULL behaviour `CLAUDE.md` documents as a hard rule. Plus `pwa/src/dev/mockSupabase.ts`, a 900+ line in-memory PostgREST fake driving `npm run demo`, dies with the migration.

**Supabase Auth.** 6 files, ~430 lines, 15 call sites. The code is an afternoon. **The expensive part is the semantics:** `CLAUDE.md` documents four separate production bugs from getting auth-state distinctions wrong (retryable-refresh vs sign-out, null-identity vs signed-out, 401-whose-refresh-threw vs 401-answered, cached-read vs server-said-no). Every one would be re-litigated against a new library. Highest-risk chunk, least visible in a line count.

**Edge functions are essentially portable.** The entire platform surface is `Deno.env.get` (14 uses) and `Deno.serve` (5 uses). Moving to Cloudflare Workers is `Deno.serve(h)` becoming `export default { fetch: h }`. One to two days.

### Migration cost

| Work | Dev-days |
|---|---|
| Schema port, `auth.uid()` shim, own users table | 2 |
| 60-90 API endpoints with per-request RLS GUC plumbing | 10-15 |
| PWA data layer (`data.ts` 1,931 lines + 9 files) | 6-8 |
| Auth: OTP, session persistence, the four semantic distinctions | 5-7 |
| Edge functions to Workers | 1-2 |
| Test suite + replacing `mockSupabase.ts` | 4-6 |
| Cutover, secrets, DNS, zero-loss data migration of an append-only log | 3-4 |
| **Total** | **31-44** |

**Call it 35 dev-days, seven working weeks solo.**

### Cost comparison

| Stack | 100 | 1,000 | 10,000 | Migration |
|---|---|---|---|---|
| **Supabase Pro** | **$25** | **$25** | **$32** | **0 days** |
| Neon Launch + Workers + Better Auth | ~$20 | ~$30-45 | ~$90 | 35 days |
| Neon + Workers + Clerk | ~$20 | ~$30-45 | ~$90 | 35 days |
| Fly.io MPG Basic | ~$50 | ~$50 | ~$60 | 40+ days |
| Railway Pro + Postgres | ~$40 | ~$60 | ~$100 | 40+ days |
| Self-hosted Supabase, Hetzner | ~$6 | ~$14 | ~$25 | 10 days + permanent ops |
| Convex Professional | $25 | $25 | $25+ | 60+ days (rewrite) |
| Firebase Blaze | usage | usage | usage | 60+ days (rewrite) |
| Turso / PlanetScale / Nhost / Appwrite | $5-50 | $5-50 | $25-100 | 35-60 days |

Neon compute is the swing factor: $0.106/CU-hour on Launch, and scale-to-zero stops helping once users span timezones. One always-on CU is ~$77/month, which is why Neon crosses **above** Supabase at 10,000 users.

**The best case for moving saves roughly $5 to $10/month between 100 and 1,000 users, and loses money at 10,000. Against 35 dev-days. Break-even would need a $1,750/month saving; the entire bill at 10,000 users is $32.**

### Individual rejections

- **Convex, Firebase, Appwrite:** no SQL views, no declarative row security. The 13 views and 60 policies become application code, and the boundary this repo treats as the security perimeter ("the PWA is not the boundary, RLS is") is deleted. Firestore's per-document read billing is also exactly wrong for an app whose core read pages 1,000 sets at a time.
- **Turso / libSQL:** SQLite has no RLS. All 60 policies move to application code. Also no `at time zone`, which `app_tz(user_id)` and every calendar view depend on.
- **PlanetScale Postgres, Nhost:** worse economics or the same price at a smaller vendor, with 60 policies rewritten for no benefit.
- **Self-hosted on Hetzner:** the only genuinely cheaper option, saving $120-240/year. For that you take on Postgres upgrades, GoTrue upgrades, TLS renewal, backup **and tested restore**, monitoring, and the 3am page, on a product with paying customers whose data is append-only and irreplaceable. **One incident costs more than a decade of savings.**

## 5.2 Hosting: move to Cloudflare Pages

Beyond the terms-of-service problem in 4.5:

GitHub Pages serves **no custom response headers**, so there is no CSP, no HSTS of your own, no `X-Content-Type-Options`, no `frame-ancestors`, no `Permissions-Policy`. `pwa/index.html` also has no `<meta http-equiv>` CSP, so there is not even the meta fallback.

**That matters more here than in a typical app.** This PWA renders LLM output and parses coach screenshots, which is untrusted input by definition. `CLAUDE.md` correctly requires model output to render to elements and never `dangerouslySetInnerHTML`. **A CSP is the second layer under that single first layer, and right now there is no second layer.**

Separately, `site_url` in `config.toml` is hardcoded to `coltbradley.github.io/strength-tracker/`. For a commercial product the sign-in email's origin is a personal GitHub username, which is a positioning problem as much as a technical one.

**Cloudflare Pages:** free, unlimited static bandwidth, `_headers` supports the full CSP set, free custom domain.

**Netlify is not strictly better.** Since 14 April 2026 its free tier is credit-metered at 20 credits/GB against 300 credits/month, roughly 15 GB. At 10,000 users times 5 MB that is 50 GB/month. **You would pay Netlify and not Cloudflare.**

**Effort: half a day.** Add `_headers`, register a domain, drop `PAGES_BASE`, add the new origin to `additional_redirect_urls` while keeping github.io during transition, swap the `peaceiris/actions-gh-pages` step in `.github/workflows/deploy.yml`.

## 5.3 The `mcp_writer` role: the best structural fix available

**This is the highest-value architecture change in the document and it is a runtime no-op today.**

Your hardest rule is: "`sets`, `sessions`, `set_voids` and `set_notes` are written ONLY by the PWA. MCP tools never write them."

**Today that rule is enforced by nothing but code review and the tools' own restraint.** The service role bypasses RLS entirely, so it can insert into `sets` at any time, and `sets` is append-only, so a wrong write is permanent.

**[MEASURED]** Across `supabase/functions/mcp-server/`, those four tables are touched at exactly **8 sites, and every one is a `.select()`**:

- `update_planned_workout.ts:237`
- `get_recent_sessions.ts:61,145`
- `lib/lastTime.ts:90,132`
- `search_exercises.ts:131`
- `get_lift_history.ts:138`

Neither edge function uses `auth.admin`, Storage, or Realtime anywhere, so nothing needs service-role privilege for its own sake.

```sql
create role mcp_writer nologin;
grant usage on schema public to mcp_writer;

-- read-only on the PWA-owned write set
grant select on sets, sessions, set_voids, set_notes to mcp_writer;

-- read/write on the planning surface
grant select, insert, update, delete on programs, planned_workouts,
  prescriptions, training_plans, plan_phases, goals, training_maxes,
  coach_memory, exercise_notes, feedback, exercise_owners to mcp_writer;

grant select on all views to mcp_writer;
-- no grants on mcp_tokens at all (coach only, separate role)
grant mcp_writer to authenticator;
```

Connect PostgREST as that role by minting a JWT with a `"role"` claim signed with the project's JWT secret; Supabase's PostgREST honours it.

**This converts your most-emphasised invariant from a convention into a constraint.** It also closes F1 (`update_exercise` writing shared library rows), which is currently gated only at the connector layer.

**Caveats:** keep every `db.ownerId` filter exactly as written, because a non-superuser role still sees all rows without RLS context. Each new table needs a grant, and **a forgotten grant is a loud permission error rather than a silent leak**, which is the right failure direction. `purge_expired_mcp_tokens` is `SECURITY DEFINER` and already revoked from PUBLIC/anon/authenticated, so the coach's role needs an explicit `grant execute`.

**Effort: 1.5 to 2 dev-days.** One migration of ~40 lines plus a change to `getClient()` in `lib/db.ts`.

## 5.4 Staging: the minimum-cost fix is $0

`docs/decisions.md` already reasons about this honestly and lists three conditions making no-staging acceptable: CI runs the full chain in PGlite, migrations are append-only by rule, `db push` is idempotent. It ends with "remove any one of those and this decision should be reopened."

**Selling the product removes a fourth thing that was never on the list: blast radius.** Today a bad migration inconveniences two people.

| Option | Cost | Note |
|---|---|---|
| **A second free Supabase project as staging** | **$0** | Free projects pause after 7 days idle, fine for something you touch on every release. No custom SMTP on free, so staging OTP uses the built-in sender at a low rate limit, acceptable for staging |
| **A GitHub environment protection rule on the `supabase` job** | **$0, 10 minutes** | Puts a human between merge and database, which is the specific thing missing |
| Supabase branching | $0.01344/branch/hour | A branch left running is ~$9.68/month. Per-PR ephemeral branches at 30 min each, 20 PRs/month, is ~$0.13/month. **Cheap only with disciplined teardown** |

**Recommendation: second free project plus the environment protection rule. $0 total, half a day.**

## 5.5 The MCP split: keep it. The intuitive premise is wrong.

**The tool loop does not run in the coach function.** `coach/index.ts:772` passes `betas: ["mcp-client-2025-11-20"]` with `mcp_servers: [{type: "url", url: mcpUrl, authorization_token: mcpToken}]`. **Anthropic's servers call the mcp-server function directly.** The coach makes one outbound call and streams the result back.

So "skip the MCP round trip" would not remove a hop. It would move tool execution from Anthropic's loop into the coach function's own loop, meaning the coach must hold the conversation and re-call the API per tool round. Same number of API calls, same tokens, and now you pay for a function to stay warm across the whole loop instead of streaming.

**What you would lose by inlining:** `mcp-server` is also the Claude Desktop surface, and the connector-level `configs` block disabling five tools is a **structural authority boundary an injected instruction cannot reach**. Inlining means reimplementing that gate in code you also have to trust.

**Verdict: the split is correct.** The real per-turn overhead worth attacking is elsewhere: `mintToken`, `revokeToken` and the `purge_expired_mcp_tokens` RPC are three extra database round trips per turn. Revoke and purge are already off the response path in a `finally`. **The mint is not.** Reusing one token across a conversation with a slightly longer TTL removes one round trip from the user-facing path. **One hour, not an architecture change.**

**The genuine loop problem is batching, not transport.** The file's own comment records "the worst turn on record was 37 seconds of six sequential exercise lookups, which is a tool-loop problem rather than a thinking-depth one." Fixing that (5.6, lever 3) is worth more than any hosting decision in this document.

**One consequence to note for 5.6:** with the server-side loop, the caller sends one request and never sees the intermediate passes, so **you cannot place a cache breakpoint on accumulated tool results.** A second breakpoint buys history caching across turns, not tool-result caching within a turn.

## 5.6 Inference architecture

### The four levers, ranked by saving per hour

All figures per typical user (54 turns/month) and heavy user (295 turns/month), against a $0.0825/turn baseline.

| # | Lever | Typical | Heavy | Hours | Quality risk |
|---|---|---|---|---|---|
| 1 | **Second cache breakpoint after history** | $0.75 | $4.10 | ~1 | **none** (pure billing) |
| 2 | **Prune 8 unused tools** | $0.13 | $0.71 | ~1 | near zero; removes a contradiction |
| 3 | **`resolve_exercises(names[])` batch tool** | **$1.35** | **$7.40** | ~4 | **none**; also fixes worst latency |
| 4 | **Cap and group `get_recent_sessions`** | $0.75 | $4.10 | ~3 | **negative** (it helps) |
| 5 | Opus 5 to Sonnet 5 | $2.74 | $14.85 | 1 line + ~8 h eval | **the real question** |
| 6 | Tool search / progressive disclosure | $0.21 | $1.15 | ~6 | real (deferring `find_similar_days`) |
| 7 | Inline the tool loop | $0.59 | $3.25 | ~20 | moderate |
| 8 | Router + cheap classifier | $0.58 | $3.15 | ~30 + eval | **high** (misroute = wrong coaching) |

### Lever 1 detail: the second cache breakpoint

Currently one breakpoint at the end of `system`, so conversation history is re-billed at full $5.00/MTok on every turn and every pass. History plus the repeated portion of context is roughly 7,250 of the 10,000 fresh tokens per turn.

**The design already accommodates this.** `pwa/src/lib/coach.ts:71` puts the context block on the **latest** turn only, with the comment "Prepended to the newest message keeps it after the cache breakpoint." So placing a breakpoint at the end of the second-to-last turn is clean.

```
re-read content moving from $5.00 to $0.50:
  7,250 x $4.50/1M                       = $0.0326/turn
minus write overhead on ~2,750 new tokens/turn:
  2,750 x $5.00/1M (1h TTL is 2x base)   = $0.0138/turn
                                           ----------
net                                        $0.0188/turn
```

**Use different TTLs at the two breakpoints.** Break-even for a 1h write (2x base) is 1.11 re-reads; for a 5m write (1.25x base) it is 0.28. The system prefix is re-read many times per conversation, so 1h is right and the existing comment defending it against the 5m proposal is correct. Growing history is re-read fewer times, so 5m fits better there. Verify mixed TTLs across breakpoints are permitted in one request; if not, 1h on both is still net-positive.

**Quality risk: zero.** The only hazard is a silent cache miss, and `cache_read_input_tokens` is already logged in `record()` precisely so that can be seen.

### Lever 2 detail: prune, do not defer

**How many tools does a turn actually need?** From the real transcript and the eval cases: **1 to 3**. The largest is the review turn, implying 5. The prompt names about 12 tools. **Twenty-five are loaded on every turn.**

**Progressive disclosure is a supported parameter** (`tool_search_tool_bm25_20251119` plus `defer_loading: true`), not a rewrite. But **the payback is eaten by the mechanism**: a deferred tool costs a tool-search round trip, which is another model pass, the expensive thing. Net ~$0.0039/turn.

**And it carries real quality risk.** `find_similar_days` is *required* by the prompt before `upsert_program`, to stop the same screenshot becoming a second program. **Deferring a tool the model must call before it knows it needs it breaks a documented safety rule.** `repeat_planned_workout` and `submit_feedback` have the same problem.

**Do the strictly better version: prune.** Eight tools have no coaching use in this surface:

`get_memory` (the prompt spends ~60 words telling the model *not* to call it, so a schema and a prompt paragraph both pay rent for a tool that should not be there), `get_training_maxes`, `list_programs`, `get_goal_progress`, `get_exercise_notes`, `list_feedback`, `resolve_feedback`, `forget`.

~5,600 chars off the prefix (~2,000 tokens) plus ~120 tokens of prompt. **One hour, near-zero risk, and it removes a prompt-versus-tool-list contradiction that currently ships.**

### Lever 3 detail: the batch tool

The measured worst turn: 37 seconds, six sequential `search_exercises` then two `upsert_program` calls. Nine passes.

```
today:
  prefix  9 x 16,000 x $0.50/1M                             = $0.072
  fresh   history x9 (18,900)
          + cumulative search results (800 x [1+2+3+4+5+6] = 16,800)
          + programs (4,000)
          = 39,700 x $5.00/1M                               = $0.199
  output  ~1,500 x $25/1M                                   = $0.038
                                                              -------
  turn                                                        ~$0.31

with resolve_exercises collapsing 6 searches into 1 (9 passes -> 4):
  prefix  4 x 16,000 x $0.50/1M                             = $0.032
  fresh   8,400 + 5,000 + 4,000 = 17,400 x $5.00/1M         = $0.087
  output  ~900 x $25/1M                                     = $0.023
                                                              -------
  turn                                                        ~$0.142
```

**Saving $0.17 per write turn. At 15% write turns: $1.35/month typical, $7.40 heavy.**

**And it cuts 37 seconds to maybe 15, which is the thing the lifter actually experiences.** Best lever on saving per hour *and* on user-visible quality. Already in the roadmap as finding 6. One new tool file plus one prompt sentence. Return the top 3 matches per name with `last_trained`, the ranking `search_exercises` already applies.

### Lever 4 detail: cap the tool results

`get_recent_sessions` caps at 400 sets. At ~25 tokens per set object that is ~10,000 tokens, re-sent at full price on every subsequent pass.

A review turn is the worst case: five passes, so a 10,000-token result re-sent on passes 3, 4 and 5 is `30,000 x $5.00/1M = $0.15` **on one turn**. That is nearly two typical turns of cost for one review, and reviews are a first-class flow triggered by the finished-day card.

Three caps, in order of value:

1. **Default `n` to 3 when `include_sets` is true.** The prompt's review procedure names a single date. 400 sets becomes ~120.
2. **Group sets by exercise.** `"Barbell Squat: 60x5, 80x5, 100x3x3"` is ~15 tokens where five set objects are ~125.
3. **Drop fields the coach never quotes:** per-set `performed_at` (session start plus order suffices) and `rest_s` (`v_rest` exists).

**Quality risk: negative, it helps.** A grouped, capped result is more readable than 400 flat rows, and the prompt's own instruction to read set notes before "calling a session clean" is easier to follow in 2,500 tokens than in 12,000.

### The Opus question

**The insurance premium is $2.74/user/month typical and $14.85 heavy.** The peril is real: a user's plan was corrupted.

But the repository's own eval run 1 found:

- **v12, the clone.** Run 1's words: *"The model did not choose badly; it had no correct move."* Structural. `upsert_program` cannot touch a confirmed program, so no call sequence existed. **Opus would have cloned it too.**
- **s01-swap.** A capable model *refused*, because the tool surface made "change one exercise" and "do not lose an empty day" mutually exclusive. Structural.
- **v02 and v09, memory misses.** Run 1's own heading: *"The memory misses are the prompt, not the model."* The proposed durable fix is a Haiku pass after each turn so that remembering is not a judgment call the model can skip.

**Four of four observed failures were structural or prompt. Zero were model tier.** The three cases that passed (per-hand loads, prompt injection, no invented training) were prompt and structure wins too. There is no logged instance of the peril, and the fix that landed for the one real corruption was `update_planned_workout`, a tool-surface change.

**And there is a configuration nobody has tried.** The repository's own Decision 1 is "effort before model". The code then went to Opus **and kept effort at `low`**. That is buying the expensive lever and leaving the cheap one unpulled. **Sonnet 5 at effort `medium`** may beat Opus 5 at `low` on side-effect error rate while costing less than half: medium roughly doubles output tokens, which is 15% of the bill, so ~$0.27/month against $2.74 saved.

**Do not decide this by argument. Run the eval.** `scripts/coach-eval/run.mjs` exists, has never run at the API level, and costs $40 to $80. **That is one heavy user's monthly coach bill to permanently answer a $14.85/user/month question.**

### The staged architecture

| Stage | Typical | Heavy | vs baseline | Quality exposure |
|---|---|---|---|---|
| Current (Opus 5, low) | $4.56 | $24.75 | baseline | none |
| **Stage 1: levers 1-4, ~9 hours** | **$2.01** | **$10.78** | **-56%** | **none** |
| Stage 2: + Sonnet, eval-gated | $0.80 | $4.31 | -82% | measured, not assumed |
| Stage 3: + write validators | $0.80 | $4.31 | -82% | **lower than today** |
| Stage 4: Luna, >50 users | ~$0.15 | ~$0.80 | -97% | unmeasured, needs a full eval |

Stage 1 arithmetic, with a 15% overlap haircut because the batch tool removes passes and so shrinks what the caching and payload levers have left to save:

```
levers 1 + 3 + 4:  0.75 + 1.35 + 0.75 = $2.85 x 0.85 = $2.42
lever 2:                                              = $0.13
typical: $4.56 - $2.55                                = $2.01  (-56%)
heavy:   (4.10 + 7.40 + 4.10) x 0.85 = $13.26 + $0.71 = $13.97
         $24.75 - $13.97                              = $10.78 (-56%)
```

### Stage 3: put the guarantees where you put every other guarantee

Your own rule is *"the PWA is not the boundary, RLS is."* **By the same logic, the model is not the boundary either.**

Most of what Opus is being bought for is expressible as assertions on the tool arguments before the write lands:

- `upsert_program` targeting a name that already exists confirmed (the clone, caught deterministically)
- `update_planned_workout` whose prescription list drops an exercise the day had, without the diff being stated in the turn
- a `load_pct_tm` prescription with a percentage sitting in `notes` as prose
- a prescription list that tears a `superset_group` or splits a ramp

**Those are checks, not judgment.** The `before delete` trigger guarding prescriptions with sets against them is already this pattern. Adding them makes the model choice a **cost** question rather than a **safety** question, which is the only way the $14.85 is ever safely recoverable.

## 5.7 What was rejected, and why

### The router (dropping the LLM for "simple" turns): REJECTED

The premise was "if 60% of turns are deterministic queries, use a cheap classifier." **They are not.**

The real user's 13 turns, categorized:

| Category | Count |
|---|---|
| Open judgment | **11** |
| Structured writes | 2 |
| Deterministic queries | **0** |

Volume-weighted estimate for the product as built: 55-65% open judgment, 5-10% image extraction, **10-20% deterministic**, 15-25% structured write.

**Three structural reasons the deterministic share is so low, all already in this codebase:**

1. **The context block already ate those turns.** `coachContext.ts` ships memory facts, today's plan, the running session, the last 12 logged sets, and the plan phase with every turn. "What am I doing today", "how much did I do on that last set", "what's my plan" are answered before they are asked. **That is a router, built, shipped, and costing zero classifier tokens.**
2. **The deterministic layer was already extracted.** Decision 5 in the roadmap: "PR detection, warmup ramps, plate math, missed-day and empty-day logic, adherence: SQL and TypeScript, no model." There are 13 SQL views.
3. **Judgment and writes are the same conversation.** Turn 12 is only cheap to route if the router lived through turns 1 to 11. Routing the write turn to a cheap model means either replaying eleven turns (the cost you were avoiding) or writing from a summary, **which is precisely how a plan gets corrupted**.

At 15% deterministic share, perfectly classified, the net saving is **$0.58/month** for 30+ hours plus an eval suite that does not exist. And the failure mode is the worst available: a judgment turn misclassified as a lookup returns a template answer, which reads as a coach who did not listen. `s03-midsession` is the trap: "single leg rdl felt shaky, drop the last two sets?" contains a lift name, a set count and a question, and is pure judgment answered with zero tools.

**Do instead:** extend the context block (already Task C.2) so non-session days include the full week's plan and the last session's sets. That converts one-tool turns into zero-tool turns, removing a whole model pass. Zero misroute risk, lower latency, no classifier, ~$0.35/month, and it is a PWA change with no inference cost at all.

**And measure before architecting.** `coach_usage` stores prompt text. One Haiku batch pass over existing rows classifies every turn the product has ever served for under a dollar. **Nobody has done this. Every argument above, mine included, reasons from one user's one session.**

### Leaving Anthropic: REJECTED at current scale

| Model | Input | Cached in | Output | Hosted MCP loop | Caching |
|---|---|---|---|---|---|
| Claude Opus 5 | $5.00 | $0.50 | $25.00 | yes | yes, 1h TTL |
| Claude Sonnet 5 | $2.00 | $0.20 | $10.00 | yes | yes |
| Claude Haiku 4.5 | $1.00 | $0.10 | $5.00 | yes | yes |
| GPT-6 Astra | $10.00 | $1.00 | $50.00 | yes (Responses API) | yes, 90% |
| GPT-5.6 Sol | $5.00 | $0.50 | $30.00 | yes | yes |
| GPT-5.6 Terra | $2.00 | ~$0.20 | $12.00 | yes | yes |
| **GPT-5.6 Luna** | **$0.20** | ~$0.02 | **$1.20** | **yes** | yes |
| Gemini 3.1 Pro | $2.00 | $0.20 | $12.00 | no | explicit + $0.50/hr storage |
| Gemini 3.7 Flash | $0.75 | $0.075 | $3.75 | no | implicit, **reportedly breaks with tools defined** |
| Llama 3.3 70B (Groq) | $0.59 | n/a | $0.79 | no | **none** |
| Qwen3-235B (DeepInfra) | $0.09 | n/a | $0.10 | no | none |
| DeepSeek V4 Pro (Fireworks) | $1.74 | $0.145 | $3.48 | no | partial |

Non-Anthropic prices came through search rather than primary pages. **Verify before committing.** Google's Flash rates are marked effective through 2026-12-31 and double on 2027-01-01.

**The finding that reorders this table: for this workload the repeated prefix dominates, so caching support outweighs sticker price by a wide margin.**

```
Opus 5, cached:        32,000 x $0.50/1M = $0.0160/turn
Llama 3.3 70B, Groq:   32,000 x $0.59/1M = $0.0189/turn   (no cache discount)
```

**A frontier model with prompt caching is cheaper on the prefix line than a mid-tier open-weight model without it. Groq is disqualified by architecture, not price.** The same logic threatens Gemini 3 Flash: there is a live report that implicit caching does not fire when tools are defined, which is exactly this request shape. If so, Flash costs `32,000 x $0.75/1M = $0.024/turn` on the prefix alone, **more than Opus cached**.

**Correction to a common assumption:** OpenAI's Responses API has hosted remote MCP servers with a server-side tool loop over Streamable HTTP, the same shape this code uses. So the MCP connector is **not** Anthropic-only, and GPT-5.6 Luna is the lowest-friction switch target if you ever need one: estimated **$0.10 to $0.15/month typical** after the Stage 1 fixes.

**Switching cost:** the coach's header comment states why it is 938 lines: "Anthropic connects to that server itself (the MCP connector), which means there is no tool loop here to get wrong and one authorization boundary rather than two." Leaving means writing that loop: `tools/list` fetch and schema translation, parallel `tool_use` blocks returned in a single user message (splitting them silently trains the model to stop calling in parallel), `is_error: true` on failures rather than dropped results, and the streaming interleave. **3 to 5 days plus a full eval sweep.**

**Verdict: keep the repository's existing rule, "revisit above ~50 users."** The entire Anthropic bill for a typical user is $4.56/month. Moving to Gemini Flash saves maybe $3.90/user/month, which at ten users is $39/month, less than an hour of work.

**The trap to avoid:** a cascade routing read turns to Sonnet and write turns to Opus is **cost-negative here.** Prompt caches are model-scoped, so every switch pays a cold prefix write: `16,000 x $10.00/1M = $0.16 per switch`. At 20% switching that is $1.73/month, which exceeds the saving from running the other 80% on Sonnet. **Pick one model per conversation.**

### Bring your own key as the default: REJECTED

**Does the model work commercially?** Yes, in developer tools. Kilo Gateway shipped BYOK across 20 providers in June 2026 at 0% markup; Cline, Roo, Aider and Continue are built on it. Anthropic's terms restrict reselling through *your* credentials, which is the opposite shape from BYOK.

**Why it fails here, three reasons:**

1. **The user is wrong for it.** The archetype is a lifter standing at a rack holding a phone. BYOK asks her to leave the app, create an account at a second company, add a credit card, find a keys page, generate a secret, copy it, come back and paste it. General SaaS onboarding data puts each removed friction point at 3-8% completion and multi-step setup at over 50% abandonment. For consumer fitness expect **70 to 90% abandonment** on an API key step.

2. **The margin arithmetic does not clear the friction.** At $12/month with $4.56 COGS the margin is already 62%. BYOK trades that for ~95%, so it wins only if it costs **less than 38% of conversions**. Every signal says it costs multiples of that.

3. **It contradicts this codebase's stated posture.** Your rule is that `mcp_tokens` stores only SHA-256 digests, and the coach mints a plaintext token per turn and revokes it in a `finally` specifically so no usable credential exists at rest. **A user's Anthropic API key cannot be hashed, because you need the plaintext to use it.** BYOK introduces N long-lived plaintext third-party credentials at rest, each able to spend its owner's money on any Anthropic endpoint, in a public-repo project. You would need envelope encryption with a KMS key the database does not hold and per-turn decryption in the edge function. It inverts "the server holds exactly one key, and it never leaves" into "the server holds one key per user."

It also breaks the quota: `LIMIT_TURNS_PER_DAY` and `COACH_ALLOWED_USERS` exist to protect **your** key. Under BYOK the user's runaway loop spends the user's money, which is either a feature or a support ticket you cannot resolve.

**The version that does work: BYOK as an escape valve, not a default.** Keep the included quota on your key. **When a user hits the cap, offer to keep going on their own key.** That captures the heavy-user tail, the $24.75/month user destroying the unit economics, without touching conversion for the other 95%. The quota machinery already exists; BYOK just becomes "your quota is your own key's." Store it encrypted, scope it to the coach function, let the user revoke it from Settings.

### Inlining the tool loop now: REJECTED

Saving is $0.59/user/month typical. Cost is 200-300 lines of loop code, ~20 hours, plus the wall-clock risk of putting a 37-second loop inside one edge function invocation, plus the deliberate loss of the architecture's central simplification.

**Do it when the provider answer changes, because the loop is a prerequisite for any provider switch. Doing it now pays the switching cost without collecting the switching saving.**

## 5.8 The $0 punch list

| # | Change | Cost/mo | Effort | Why |
|---|---|---|---|---|
| 1 | Fix `v_coach_cost` to price Opus | $0 | 1 h | Every cost number the product has produced is wrong. You cannot price against it |
| 2 | Dedicated `mcp_writer` role | $0 | 1.5-2 d | Makes the hardest rule a database constraint. All 8 current touches are reads, so it is a runtime no-op and a hard wall thereafter |
| 3 | Cloudflare Pages + custom domain + `_headers` CSP | $0 | 0.5 d | Adds the missing second layer under the no-`dangerouslySetInnerHTML` rule; removes a personal GitHub username from a commercial sign-in flow |
| 4 | Second free Supabase project as staging + GitHub environment approval | $0 | 0.5 d | Puts a human and a real remote Postgres between merge and production |
| 5 | Batch the exercise lookups (`resolve_exercises`) | saves LLM $ | 1 d | The recorded worst turn was 37s of six sequential lookups. Dominant cost item, and a tool design problem |
| 6 | Reuse one MCP token per conversation | $0 | 1 h | Removes one blocking DB round trip from the user-facing path |
| 7 | Supabase PITR when you take money | ~$100 | 10 min | Buy it the day someone pays. Daily backups cover you until then |
| 8 | Per-PR Supabase branching with enforced teardown | ~$0.13 | 1 d | Only after #4. Cheap if torn down, $9.68/mo per branch if forgotten |

**Items 1 through 4 total $0/month and about 4 dev-days.**


---

# PART 6: STRATEGIC OPTIONS

Six directions evaluated. Two survive for a solo operator, one is a credentialing play, three are fantasies. Each is scored on buyer, budget, incumbent, regulatory bar, sales motion, and distance from this codebase.

## 6.1 Option A: Keep it as a tool

**Buyer:** you, and Valentine.
**Cost:** $25/month Supabase Pro plus current Anthropic usage (under $10/month combined at observed volume).
**Work:** items 1, 2, 4 and 6 from the Wave 0 list. Roughly 3 hours.
**Legal exposure:** effectively zero. No entity, no ToS, no privacy policy, no VAT, no HBNR, no CIPA, because you are not taking money from strangers.

**What this preserves:** 100% of the value already built, at a running cost lower than a gym membership.

**What it forecloses:** nothing permanent. Every other option in this Part remains available later, and the codebase does not rot in six months.

**Verdict: this is the honest default, and it is not failure.** Every other option in this document has to beat it, and several do not.

## 6.2 Option B: MCP-first product

**Shape:** the PWA becomes the capture device. The MCP server becomes the product. The in-app coach is demoted to a paid tier rather than deleted.

### Why not MCP-only

Two corrections to the naive version of this idea:

**COGS is not "under $0.05/user".** It is the $25 Supabase floor divided by N. At 100 users that is **$0.26/user**. You need roughly 1,000 users to reach $0.05. And with Stripe fees the margin is **90 to 93%**, not 95%+.

**Deleting the coach makes one thing worse.** The gate disabling `update_exercise`, `delete_program`, `delete_exercise` and `set_training_plan` lives in the `configs` block in `coach/index.ts:800-830`. **Delete the coach and there is no connector layer left**, so those tools become reachable from whatever the user connects, which is the same untrusted-screenshot path. That is **1 to 2 days of new work** to move the gate into the server as per-token capability flags, not saved work.

**And the top blocker already has a lock on it.** `COACH_ALLOWED_USERS` exists. Setting it to your paying user ids closes the unbounded-spend problem today for zero engineering hours. **Deleting the coach to fix spend is demolishing a door that already has a lock on it.**

### What gets deleted if you do demote it hard

| Removed | Lines | Path |
|---|---|---|
| Coach edge function | 1,320 | `supabase/functions/coach/` (`index.ts` 938, `prompt.ts` 298, `sentry.ts` 84) |
| Coach eval harness | ~1,470 | `scripts/coach-eval/` |
| Chat UI | 534 | `pwa/src/components/CoachSheet.tsx` |
| SSE client + tests | 494 | `pwa/src/lib/coach.ts`, `coach.test.ts` |
| Context block + tests | 339 | `pwa/src/lib/coachContext.ts`, `coachContext.test.ts` |
| Markdown renderer + tests | 298 | `Markdown.tsx`, `lib/markdown.ts` (used only by CoachSheet) |
| Review entry point | 165 | `pwa/src/lib/review.ts` (used only by Today's DONE card) |
| Coach open bus | 34 | `pwa/src/lib/coachOpen.ts` |
| Chat CSS | ~230 | `pwa/src/styles.css` ~3257-3480 |

**About 4,800 lines, roughly 16% of the PWA source plus the whole second edge function.**

Schema that goes dead (migrations stay on disk, correctly): `coach_usage`, `v_coach_cost`, `v_coach_spend_daily`, `mcp_tokens.expires_at`, `purge_expired_mcp_tokens()`.

**`coach_memory` does not die, and this is the subtle loss.** The table is written by MCP tools but **delivered** by the context block. The repository's own rule is "memory that must be fetched is memory that gets forgotten." Deleting the context block converts memory from ambient to fetched. The table survives; the design intent does not.

**Security findings that evaporate: roughly 60 to 70%** of a coach-era remediation list. Unbounded spend, racy quota checks, `turn_id` reuse, unread usage insert errors, per-turn token minting, request-body hardening, and the conversation-logging privacy problem all go entirely. **But Wave 2 in your sequenced plan is already marked done, so this saves prospective maintenance, not the 35 to 50 hours.**

### What breaks

**The persona.** The one real user built her whole program *through the in-app coach*, in 13 turns. Claude's iOS and Android apps do support remote MCP connectors (provided the connector was added on claude.ai first), so the **capability** survives. What does not:

1. **The context block.** Median latency 10.8s, and 3 of 13 turns needed no tool at all because the context already answered them (`docs/decisions.md:1227`). Without it, every mid-set question pays a tool round trip on top of an app switch.
2. **"Which set am I on."** The active session lives in IndexedDB and the outbox until it flushes. **An MCP client cannot see a set that has not synced, and cannot see anything at all while the phone is offline.**
3. **The guided entry points.** Today's DONE card sends a pre-built review turn with the session id. That becomes "open Claude, remember to ask, paste the date."
4. **Presence.** Between sets, with a rest clock running and a wake lock held, app-switching is a different act from tapping a button on the screen you are already holding.

**What does not break:** screenshot parsing gets better (the coach function is a proxy; vision is the model's). Offline is unaffected (`FabDock.tsx` already disables the coach when offline). The confirm gate survives. All 30 MCP tools remain reachable.

**Accurate summary: MCP-first loses latency, ambient context, and in-session presence. It does not lose capability.** A real loss for the mid-set question, a small one for the Sunday-afternoon programming session, which is where 13 of her 13 turns actually were.

### Pricing

MCP tier margins at 1,000 users, Stripe included:

| Price | Fees | COGS | Margin |
|---|---|---|---|
| $5 | $0.45 | $0.035 | 90.4% |
| $7 | $0.50 | $0.035 | 92.4% |
| $9 | $0.56 | $0.035 | 93.4% |

**Recommended tiers:**

- **Free.** PWA capture, full JSON/CSV export, one device. Competes with Workout Memory free and Arvo free, and gives away the thing that is cheap.
- **$5/month, Connected.** MCP connection, multi-device, plan and phase layer, adherence views. **Gating MCP behind a paid tier has direct precedent: Hevy puts its API key behind $2.99 Pro.** $5 is a defensible premium for the prescription model, not for the protocol.
- **$15/month, Coached.** In-app coach, hard-capped, gated by entitlement. **Drop to $9 only after the Sonnet eval passes.**

**The ceiling constraint to hold onto: hevy-mcp at $2.99 caps what "we have an MCP server" can charge. The $5 has to be paid for by the prescription model.**

### Effort

10 to 14 dev-days plus the legal shell. Detailed in Part 7.

### Verdict

**Viable as a small business, contingent on the Wave 2 gate.** It puts you in Hevy's margin structure instead of an AI app's, which removes your structural cost disadvantage. It does not fix distribution, which is the actual constraint.

## 6.3 Option C: Team strength and conditioning

**Buyer:** head S&C coach at a high school, small college, or private performance facility. One person, one credit card or p-card, below procurement thresholds.

**Incumbents and price:**

| Product | Price |
|---|---|
| TeamBuildr | Strength Silver $90/mo for 50 athletes, Gold $150 for 250, ~$280 for 1,000+; AMS add-on $50/mo; annual billed at 10x monthly |
| BridgeAthletic | from ~$3,000 for schools, $30/mo individuals |
| CoachMePlus | $19/mo for 50 athletes |
| Kitman Labs, Teamworks | quote-only enterprise with paid onboarding. Teamworks reported at 98% of NCAA D1 (competitor-published, directional only) |

**Revenue per customer: $1,000 to $3,400/year for the reachable segment.** That is the whole story of this market.

**Sales motion:** the head coach is user and champion, but money moves through athletic department or district procurement. State institutions typically require sole-source justification or competitive bidding above thresholds (one example puts IT sole-source review in the $5,001 to $250,000 band). **Below those thresholds a coach can often put it on a p-card, which is the actual path in.** Buying is seasonal, mapped to the academic year, driven by coach-to-coach referral plus NSCA and CSCCa conference presence.

**Regulatory bar:** effectively zero.

**Distance from the asset: small.** Your data model already handles supersets, ramps, sections, %TM and prescribed-versus-performed with **more structural fidelity than most of these tools**. What is missing is the coach-side model: squad rostering, bulk assignment, one coach seeing 200 athletes, leaderboards, and velocity or force-plate device integrations.

**The dangerous part, quantified.**

The current design forbids cross-user reads: 60 policies, 91 `auth.uid()` occurrences, 13 `security_invoker` views, and in the MCP server 103 `db.ownerId` references plus 65 `.eq("user_id", ...)` calls, each a manual scoping decision because the service role bypasses RLS.

**The correct change is not to loosen policies.** It is one new table `coach_athletes(coach_user_id, athlete_user_id, granted_at, revoked_at, scope)` plus a SQL function `can_read(subject uuid)` returning `subject = auth.uid() or exists(...)`, then rewriting **fourteen** SELECT policies: `sessions`, `sets`, `set_voids`, `set_notes`, `programs`, `planned_workouts`, `prescriptions`, `training_maxes`, `goals`, `exercise_notes`, `coach_memory`, `training_plans`, `plan_phases`, `feedback`. **That part is 2 days.**

What makes it 8 to 12:

- **Every WRITE policy must stay `= auth.uid()`.** If a coach can insert as an athlete, a misattributed set is permanent, because `sets` is append-only with no ownership correction path. This is the invariant `outbox.ts`'s `replayable()` already protects on the client.
- **The MCP server does not use RLS at all.** All 65 filter sites need an explicit subject, and every read tool needs an athlete argument. Doing all 30 honestly is weeks. **Budget 4 days for the 12 a coach actually needs** and leave the rest single-subject.
- **The PWA cache is deliberately not namespaced by user.** `pwa/src/lib/db.ts`: "Cache keys are NOT namespaced by user on purpose: one marker has one place to be wrong, forty key builders do not." A coach switching athletes either blows the entire `kv` cache on every switch or, worse, does not. **That single decision, correct for the current product, is the most expensive thing to undo. Budget 2 days and expect to get it wrong once.**
- **`coach_memory` reaches the model through the per-turn context block** and holds injuries and constraints. A coach reading it is fine. **A coach's model pulling three athletes' injuries into one context is a disclosure incident.**

**What it endangers:** today "your data is yours" is enforced by the *absence* of a policy, and an audit is reading 60 policies. Afterwards, correctness depends on one function returning the right answer in 14 places plus 65 hand-written filters on a path where RLS is not there to catch a mistake, and where a mistake is silent and cross-tenant. **The security posture goes from provable to reviewed.**

**The arithmetic:** at $1,500/year you need **about 70 paying programs to clear $100k gross**, against incumbents that are cheap, feature-complete, and have a decade of coach relationships.

**Verdict: the best technical fit of the six, and the only market where every gate is one you can personally open.** It is a grind business, not a leveraged one.

## 6.4 Option D: Research and credentialing

**Is the pain real?** Yes, and there is a citable statement of it. A **2026 JMIR systematic review** of exercise prescription apps for professional use evaluated them against FITT/FITT-VP for clinical integrity and CERT for intervention fidelity, and concluded these apps are appropriate only as adjunctive tools, **naming transparent progression mechanisms and individualized adjustment as the priorities for future development.** That is a published statement that the thing you built well is the thing the field says is absent.

**What researchers use today:** REDCap, for exactly this. Session attendance and home practice completion logged into REDCap; adherence to diet and exercise recommendations reviewed there. **REDCap is free to consortium member institutions, already IRB-approved locally, and already has an institutional support team.** You are not competing with a vendor, you are competing with free and pre-approved.

**Budget:** NIH modular budgets cap at $250,000 direct costs per year. Data management is roughly 15% of a trial budget; EDC startup runs $5,000 to $12,000 with $1,000 to $5,000 monthly. Commercial eCOA vendors (Medidata, Veeva, Oracle, Castor, Clario, Signant) publish no rate cards.

**Procurement path:** a PI writes you into a grant budget as a subaward or a PO line, or the university buys you on a sole-source justification. **The sales cycle is the grant cycle: 9 to 18 months**, with a high probability the grant is never funded and you wrote a letter of support for nothing. Add IRB review, a data use agreement, and, if FDA-regulated, 21 CFR Part 11 validation, a six-figure lift of its own.

**Distance from the asset: medium.** This is where the append-only design is most genuinely valuable: an immutable audit trail with reconstructable corrections is the shape Part 11 wants. You would need randomization, study configuration, blinded exports, and statistician-friendly extracts.

**Note the Part 11 gap honestly:** Part 11 requires the audit trail to record who changed what **and why**, with operator identity and reason. `set_voids` is `(set_id, user_id, created_at)` and nothing else. No reason field, no second-party attestation anywhere in the schema.

**Verdict: the best intellectual fit for the asset's actual differentiator, and close to a fantasy as a venture.** It is real as **consulting**: $10,000 to $30,000 per study, three or four studies, plus co-authorship that becomes the clinical credential you lack for Option E.

**Treat it as a credentialing strategy with revenue attached, not a revenue strategy.** Eighteen months from now, a person with a co-authored paper on prescription fidelity and a funded study behind them is a different seller into rehab and college S&C.

## 6.5 Option E: License or partner the schema

**Shape:** the 30 MCP tools plus the prescribed-versus-achieved schema plus the structured parsing target are the least-replicated part of the asset in 2026. They are worth more inside someone else's distribution than in front of a buyer who has never heard of you.

**Plausible partners:** a coach platform that wants a real logging layer (TrueCoach has no AI programming at all), an AI fitness startup that has an LLM but no data model, or an acquihire of the domain design.

**What you would actually be selling:** not the code, which is MIT and public. The schema design plus `CLAUDE.md` plus `docs/decisions.md`, which is the record of which invariants were learned by breaking them. **If this repository is ever transferred, those two files are a material part of what is being transferred.**

**Verdict: not a plan, but the right frame to keep in mind.** It is why Part 4.5 recommends against AGPL and why Part 1.4 says not to delete `decisions.md`. Keep the option alive by keeping the documentation good.

## 6.6 Rejected directions

### Consumer subscription: REJECTED
Covered in Part 3. Cost floor $20 against a category ceiling of $15.99 for non-branded products and $6.99 for the closest AI-coach comp. AI apps churn 30-36% faster. Paid acquisition closed at CAC $20-80 against a $24-96 annual price. Median subscription app earns $492/month; 57.7% never reach $1,000 total.

### Physical therapy and rehab: REJECTED for a solo operator, despite the best-looking fit

**The fit is genuinely excellent.** Same entities, same direction of authority. `tracking = 'done'` already exists for movements nobody counts, and a tick already writes a real row. `exercise_notes` keyed `(user_id, exercise_id)` is exactly a therapist's standing cue. `exercises.images` and `instructions` are already demo photos and how-to steps.

Schema changes required are all additive: `tracking='time'` for holds and carries (repo-priced 1.0 day), a per-set symptom scalar structurally identical to the per-set RPE already designed (1.0 day), a rehab exercise seed (the `exercises.curated.sql` pattern already exists), plus the missing compliance view.

**Market and money are real.** Medbridge is $329-369 per seat per year. Physitrack from ~$21.99/practitioner/month. Limber ~$20 per engaged patient per month. Exer AI claims ~$125/patient/month in new RTM profit. Above them, Hinge Health (~$4.3B market cap, $350M+ revenue at S-1) and Sword Health (~$4B, ~$240M ARR). Roughly 37,000 outpatient rehab clinics in the US with the largest operator at ~5% share, so genuinely fragmented.

**RTM looked like the unlock.** Effective 1 January 2026 the CY2026 PFS final rule added MSK codes dropping thresholds from 16 days of data and 20 minutes of management to **2 days and 10 minutes**. Vendor-published 2026 national averages sum to roughly **$135 per patient per month, $157 in month one**. PTs bill independently under their own NPI with a GP modifier, no physician order needed. Combined Part B RPM/RTM spend was ~$910M in 2024.

**And here is the trap, which is the single most important finding in this section.**

**RTM requires the data be collected by something meeting the FDA definition of a device.** Self-reported data through an app can qualify, but only if the app itself qualifies as Software as a Medical Device. Using a non-cleared app is a documented denial scenario, with **all** RTM claims denied.

Meanwhile FDA reissued **General Wellness: Policy for Low Risk Devices on 6 January 2026**, superseding the 2019 version and **widening** the zone of products that are not devices.

**Read those together: the clearer it is that your exercise adherence app is general wellness needing no FDA review, the weaker its claim to be the "device" that makes RTM billable. You cannot have both.** Resolving it requires paid regulatory counsel, and if the answer is "you need a 510(k) or a de novo," the market is closed.

**Two more killers.** **You do not bill RTM; the clinic does.** So you are selling "we make your billing defensible," and the clinic will ask you to **indemnify them in an audit**. A one-person LLC cannot carry that. And the workflow moat is the EMR: WebPT alone serves ~155,000 therapists across 27,000 clinics at ~$99/user/month. **Anything that does not write back to the EMR is double documentation, and clinicians will not do it twice.**

Plus HIPAA: a BAA is mandatory, OCR's proposed Security Rule overhaul (targeted ~May 2026) converts MFA, encryption at rest and in transit, audit logs and network segmentation from addressable to required, and business associate penalties run from ~$145 to ~$2,190,294 per violation category.

**The only credible wedge:** cash-pay sports-rehab and return-to-sport clinics where incumbents are weak at barbell loading and percentage-of-max programming, which is precisely where this asset is strong. **That is a real gap. It is also small, and it does not need RTM.**

### Tactical, military, first responder: REJECTED

**Money exists and is not reachable.** The Army is competing the Holistic Health and Fitness Management System (H2FMS) through Army Contracting Command APG using Other Transaction Authority prototype agreements. Teamworks Tactical claims ~200,000 service members across 30 defense teams. Naval Special Warfare Command issued a presolicitation for Teamworks nutrition software licenses in January 2026. Sparta Science holds an AFWERX STTR Phase I with AFSOC.

**The wall is CMMC 2.0**, mandatory for contractors handling FCI or CUI, affecting 220,000+ organizations, with Phase 2 slated for 10 November 2026 (suspended 13 July 2026 pending review) and full implementation by November 2028. **CMMC Level 2 expects cloud services storing or processing CUI to be FedRAMP authorized or equivalent. A solo developer does not get FedRAMP. That is a categorical exclusion, not a difficulty.**

**First responders are marginally softer.** NFPA 1583 mandates fitness-related data collection as one of five program components, rolled into NFPA 1580. A documentation mandate is the right shape for this asset. But departments buy through municipal procurement, budgets are small, and the buyer is a health and fitness coordinator with no discretionary spend.

**The one honest path is an AFWERX or Army SBIR/STTR Phase I**, roughly $75k to $250k for a prototype. **Call it what it is: applying for a research grant, not entering a market.**

### Corporate wellness and insurance: REJECTED

**Compliance verification is not valued, and the evidence says so.** The Illinois Workplace Wellness Study and the BJ's Wholesale cluster-randomized trial both found self-reported behavior changes with **no significant differences in clinical measures, health spending, or employment outcomes**. An $8B industry with 80% of large employers participating and unimpressive measured returns is definitionally a compliance-optics market.

**Legal ambiguity actively discourages the product.** The EEOC's 30% incentive cap was vacated in 2018, replacement de minimis rules withdrawn in 2021, and there is currently no federal incentive ceiling, leaving a case-by-case voluntariness test. **Employers respond by making programs less verified and less medical, not more. Your core value proposition points the wrong direction.**

**HR wants aggregate participation percentages and a green checkmark. Nobody in this chain wants to know whether the third set of the back squat hit the prescribed load.**

### Studios and gyms (B2B): REJECTED as duplicative

Studio owners already pay Mindbody ($79 to $699/month per location, with 24-month contracts a common complaint) or Wodify ($79 to $179), plus a programming tool. Regulatory bar is effectively zero, which is the appeal and the reason margins are compressed.

**This is the coach-platform market from Part 3.6 with a slightly higher price tag and a worse acquisition story**, because studio owners are harder to reach than individual coaches and switching costs are dominated by a payments integration you do not have.

## 6.7 The ranking

| Rank | Option | Rev/customer/yr | Fit | Friction | Read |
|---|---|---|---|---|---|
| 1 | **Team S&C** | $1k-3.4k | High | Low-medium | Only one a solo dev can build and sell. Grind economics |
| 2 | **MCP-first product** | $60-180 | High | Medium (distribution) | Fixes margin, not distribution. Gated on Wave 2 |
| 3 | **Research consulting** | $10k-30k/study | High on audit trail | High (IRB, grants) | Real as credentialing. Not a company |
| 4 | **Keep as a tool** | $0 | Perfect | None | The honest default. Everything must beat this |
| 5 | PT / rehab | $4k-20k+ | Medium | Very high | Needs a clinical cofounder and a regulatory opinion |
| 6 | Studios / gyms | $600-2.4k | Medium | Near zero | Commoditized, already rejected |
| 7 | Tactical / military | six figures | Medium | Extreme | SBIR only, and that is a grant |
| 8 | Corporate wellness | varies | Low | Medium legal, high sales | The buyer does not want the thing you built |

## 6.8 What the data model could and could not become

The abstract shape, confirmed by reading rather than assumed: **an authority issues a dated, ordered protocol, a person performs it immutably, and compliance is computed by joining the two at the item level.** Plus a shared reference catalogue, a per-person calibration constant the protocol can express itself as a percentage of, a strategy layer, four distinct note homes, and standing facts about the person.

| Domain | Fit | Changes required |
|---|---|---|
| **Physical rehab HEP** | **FITS, nearly unchanged. Best fit by a wide margin** | `tracking='time'` (1.0 d), a per-set symptom scalar (1.0 d), a rehab seed, plus the therapist read. `load_kg` and `training_maxes` simply go unused; `load_kg = 0` is already legal |
| **Music practice** | **FITS the schema, does not fit the market** | Rename nothing in the database. `load_kg` becomes tempo, `training_maxes` becomes max tempo, so `load_pct_tm` literally becomes "80% of your top tempo", a real practice method. Smallest change set of any candidate. **But teachers do not buy software.** Technically closest, commercially worst |
| **Skilled-trade certification hours** | **PARTIAL** | The unit is wrong: hours against competency categories, not sets against movements. `prescriptions.sets` is NOT NULL checked 1-20 and `reps_min` NOT NULL checked 1-100, so you add a duration column and relax three CHECKs, touching `v_adherence`, `v_weekly_volume` and `v_e1rm`. Worse, you need a **supervisor attestation**, a second identity, which the per-user RLS model forbids |
| **Medication adherence** | **DOES NOT FIT** | Three structural failures: (1) `planned_workouts` carries one `scheduled_date` with `unique (program_id, day_index)`, but a medication is a **recurrence rule**; generating 90 rows makes every read meaningless. (2) **The direction of trust is inverted**: here the performing app owns truth; in medication the authority's record is authoritative and self-report is low-trust. (3) Compliance must be inferrable from absence, and `v_adherence` is an inner join |
| **Clinical trial protocols** | **DOES NOT FIT. Rewrite** | Part 11 requires who changed what **and why**, with operator identity and reason. `set_voids` has no reason field and no second-party attestation. And a protocol is one document applied to many subjects with per-subject randomization, whereas every row is owned by one `user_id` |
| **Equipment maintenance** | **DOES NOT FIT. Rewrite** | The performer is an asset, not an account. You would key on `asset_id` with many technicians reading and writing one asset's history, inverting ownership completely. Schedules are recurrence-based |
| **Veterinary / livestock** | **DOES NOT FIT** | Subject is an animal; herd protocols are one-to-many. **The one piece that would survive intact is the offline layer**, because `outbox.ts` does not care what it is queuing, and a barn with no signal is exactly its use case. **That is the tell: the reusable asset is the sync layer, not the schema** |

**All four failures come down to the same two causes: recurrence rules instead of dated rows, and a subject that is not the account holder.**


---

# PART 7: THE DEVELOPMENT PLAN

Estimates are dev-days for one person working with Claude, matching the convention in `docs/superpowers/plans/2026-09-04-sequenced-plan.md:12`. Comparables from that plan: `update_planned_workout` was 1.5, "a sessions view plus a weekly summary view plus an MCP tool" was 1.5, proposal cards with Apply/Change were 2.0.

Every task assumes the repository's existing preflight:

```bash
node scripts/validate-db.mjs \
  && node scripts/check-selects.mjs \
  && (cd supabase/functions/mcp-server && deno check index.ts) \
  && (cd pwa && npm run build && npm test -- --run)
```

And every deviation from `docs/spec.md` gets an entry in `docs/decisions.md`.

## 7.1 Wave 0: hygiene. Unconditional. ~12 hours.

**Do this week regardless of every strategic decision. These are defects, exposures and free money.**

### 0.1 Set `COACH_ALLOWED_USERS` (0 hours)
```bash
supabase secrets set COACH_ALLOWED_USERS="<your-uuid>,<valentine-uuid>"
```
Closes S1, the single largest security blocker. Note there is no append: adding someone means re-setting the whole list.

### 0.2 Fix `v_coach_cost` (1 hour)
New migration. `create or replace view v_coach_cost` with Opus 5 rates: $5.00 input, $25.00 output, $10.00 cache write (1h TTL), $0.50 cache read. The original migration comment explicitly designed for this.

**Do this before making any pricing decision from your own data.**

### 0.3 Run the eval (0.25 days, $40-80)
```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > scripts/coach-eval/.env
cd scripts/coach-eval && node run.mjs --smoke
node run.mjs --configs sonnet-low,sonnet-medium,opus-low --trials 1 --out out/run2
node report.mjs --out out/run2
```
**Include `sonnet-medium`.** Your own Decision 1 was "effort before model" and the code went to Opus while keeping effort `low`. This is the configuration nobody has tried.

Read `out/run2/report.md`, then the failing traces. The metric that matters is **side-effect error rate**, not prose quality.

### 0.4 `COACH_LOG_CONTENT=off` (0 hours)
```bash
supabase secrets set COACH_LOG_CONTENT=off
```
Removes the CIPA hook, the HBNR blast radius, and the Amazon-shaped retention problem at once. Keep the token, cost, latency and tools columns; those are the ones you actually use.

### 0.5 Cloudflare Pages (0.5 days)
1. Register a domain.
2. Create a Cloudflare Pages project pointed at the repo, build command `npm run build` in `pwa/`.
3. Add `pwa/public/_headers` with a CSP: `default-src 'self'`, `connect-src 'self' https://<project>.supabase.co`, `img-src 'self' data: https://raw.githubusercontent.com`, `frame-ancestors 'none'`, plus HSTS and `X-Content-Type-Options`.
4. Drop `PAGES_BASE` from `deploy.yml`; the app now serves from root.
5. Add the new origin to `additional_redirect_urls` in `config.toml`, **keeping github.io during transition**.
6. Update `site_url`.
7. Swap the `peaceiris/actions-gh-pages` step.

Note the `img-src` line: exercise demo photos are cross-origin from the upstream repo, pinned as one constant in `pwa/src/lib/exerciseMedia.ts`.

### 0.6 Second cache breakpoint (1 hour)
In `coach/index.ts`, add a `cache_control` breakpoint at the end of the second-to-last message. Use `ttl: "5m"` there and keep `1h` on the system breakpoint (verify mixed TTLs are permitted in one request; if not, use 1h on both).

Verify immediately from `cache_read_input_tokens` in `record()`, which is already logged.

### 0.7 Delete the legacy `MCP_SECRET` branch (0.5 hours)
`supabase/functions/mcp-server/lib/auth.ts:85-90`. Delete the branch, unset `MCP_SECRET` and `OWNER_USER_ID`. Reissue a real `mcp_tokens` row for any Claude Desktop config that was relying on it.

### 0.8 Fix the `overLimit` paging bug (1 hour)
`coach/index.ts:286-295`. Replace the JS sum with a SQL aggregate or an RPC. At 150 turns/day the 30-day window holds up to 4,500 rows against PostgREST's 1000-row cap, so the cap is silently 4x too generous.

### 0.9 Fix the README (0.25 hours)
It says the coach runs Sonnet. It runs `claude-opus-5`. Also update the tool count (it says 22, `handler.ts` registers 30).

### 0.10 Prune 8 unused tools (1 hour)
Remove from the coach's connector config: `get_memory`, `get_training_maxes`, `list_programs`, `get_goal_progress`, `get_exercise_notes`, `list_feedback`, `resolve_feedback`, `forget`. Then delete the ~60 words in `prompt.ts` telling the model not to call `get_memory`.

**Verify with `messages.count_tokens` whether `configs: {enabled: false}` removes a tool from the prefix or merely blocks execution.** If the latter, this task is larger and more valuable than estimated.

## 7.2 Wave 1: make the product usable by someone new. 4-5 dev-days.

**Precondition for every strategic direction. Do this before deciding anything.**

### 1.1 Import (3 to 4 days)

**Files:**
- Create: `pwa/src/lib/import.ts`
- Create: `pwa/src/lib/importParsers/hevy.ts`, `strong.ts`, `generic.ts`
- Create: `pwa/src/components/ImportSheet.tsx`
- Modify: `pwa/src/components/SettingsSheet.tsx` (entry point)
- Test: `pwa/src/lib/import.test.ts`

**What already exists and mirrors this exactly:** `pwa/src/lib/export.ts` (221 lines) pages every session and set with a stable total order, denormalizes to CSV, preserves `load_entry`, carries the settings envelope so a restore knows the units, and prefixes leading `=+-@` out of Excel formula position. **Read it first; the import is its inverse.**

**What makes this tractable:**
- `sets` and `sessions` take client-generated UUIDs with `on conflict do nothing`, so **a bulk import is idempotent by construction**. Re-running it is a no-op.
- `pwa/src/lib/fuzzy.ts` already exists for name matching.
- 873 seeded exercises plus `supabase/seed/exercises.curated.sql` to map onto.

**Steps:**
- [ ] Parser per source. Hevy CSV columns, Strong CSV columns, and a generic column-mapping UI for anything else.
- [ ] Exercise-name-to-id resolution pass using `fuzzy.ts`, with a confirmation sheet listing the misses and offering "create as custom" or "map to X".
- [ ] Synthetic session boundaries from timestamps: a gap over N minutes starts a new session. Make N configurable in the sheet, default 90 minutes.
- [ ] Units decision: Hevy and Strong export in the user's display unit. Ask once, convert to kg on the way in.
- [ ] `load_entry`: imported rows are UNKNOWN (NULL), never `'total'`. **Do not guess.** `sets` is append-only, so a wrong guess is permanent, and NULL already means unknown per `CLAUDE.md`.
- [ ] `prescription_id` is NULL for all imported sets. They were not prescribed by anything in this system.
- [ ] Write through the outbox, not directly, so the existing idempotency and owner-stamping apply.
- [ ] Test: a 500-row Hevy export produces the right session count, the right set count, no duplicate on a second run, and unmapped exercises land in the confirmation list rather than being dropped.
- [ ] Decision entry.

**Note this touches no RLS, no view and not the outbox's internals.**

### 1.2 The missing compliance view (0.5 to 1 day)

**The gap:** `v_adherence` inner-joins from `sets` to `prescriptions`, so **a prescription nobody performed produces no row at all.** There is no "prescribed and not done" anywhere in the 13 views. `v_plan_workouts.exercise_count` tells you a day is empty and `skipped_at` tells you a day was skipped, but nothing computes per-prescription completion.

**Files:**
- Create: a new migration defining `v_prescription_completion`
- Modify: `pwa/src/lib/data.ts` (a reader), `pwa/src/screens/History.tsx` (surface it)
- Modify: `supabase/functions/mcp-server/tools/get_lift_history.ts` or a new read tool
- Test: assertions in `scripts/validate-db.mjs`

**Shape:** one view over `v_resolved_prescriptions` LEFT JOINed to a per-`prescription_id` count from `v_live_sets`, yielding `prescribed_sets`, `performed_sets`, `completion_state` (not_started / partial / complete / exceeded).

**Why this is first among equals:** it makes capability 1.3.1 roughly twice as useful, and **every compliance story in Part 6 requires it.** Half a day.

- [ ] Migration, `security_invoker = true`, reading `v_live_sets` never `sets`.
- [ ] Assertions in `validate-db.mjs`: a prescription with zero sets yields a row with `completion_state = 'not_started'`.
- [ ] Surface in History next to the existing hit/missed labels.
- [ ] Decision entry.

## 7.3 Wave 2: the gate. ~2 weeks, no code.

**Do not build a landing page. Do not integrate Stripe. Do not take money.**

**Recruit twenty coached lifters.** The qualifying question is: *"does your coach send you a spreadsheet, a PDF, or a photo of what to do?"*

**Where:** r/weightroom, r/powerlifting, r/strength_training, Discord servers for specific coaches, and the coaches themselves. Barbell Medicine, Stronger by Science and similar communities skew toward exactly this person.

**What to do:**
1. Onboard each one personally. Import their history (Wave 1.1 exists now, use it).
2. Have them log four weeks.
3. Ask, at week 1 and week 4: what do you pay for today? What did you stop doing because of this? What made you almost stop using it?

**The gate: do 10 of 20 still log at four weeks?**

**Why this specific test:** health and fitness Day-30 retention has a median of 3 to 5%, and the top stated reason for cancelling is lost motivation at 38%. A coached lifter should beat that by a wide margin because the coach supplies the motivation. **If your cohort does not beat it, the retention numbers in Part 3.5 apply to you specifically and no engineering fixes it.**

**Instrument it.** You currently have no product analytics at all: no PostHog, no Plausible, no Mixpanel, no GA. For twenty users you do not need a tool; a weekly SQL query against `v_live_sets` grouped by user is enough, and it does not put health data into a third party.

## 7.4 Wave 3a: MCP-first product. 10-14 dev-days plus legal.

**Gate: Wave 2 passed.**

### 3a.1 Settings > Connect (1 day)
- [ ] A small authenticated edge function, or a `security definer` RPC scoped to `auth.uid()`, that mints an `mcp_tokens` row and returns the plaintext **once**.
- [ ] **Rate-limit the mint endpoint.** It is a credential factory.
- [ ] A Connect panel: the token with a copy button, the endpoint URL, a copy-ready `claude_desktop_config.json` block, and a list of live tokens with revoke.
- [ ] **New RLS policy needed.** `mcp_tokens` currently has RLS on with **zero policies** on purpose. Adding a self-serve list needs a select policy scoped to `user_id = auth.uid()` exposing `label`, `created_at`, `last_used_at`, `revoked_at` and **never** `token_sha256`.
- [ ] Decision entry. This changes a deliberate deny-all to a scoped read, and it should be argued in writing.

This deletes the terminal and the SQL editor from onboarding and works today in Claude Desktop via `mcp-remote` and in ChatGPT custom connectors via `x-api-key`, both of which `lib/auth.ts:60-66` already accepts.

### 3a.2 OAuth 2.1 resource-server support (3 to 5 days)

**This is not optional if MCP is the product.** Anthropic's directory listing requires OAuth 2.0, and a static API key makes you permanently unlistable.

**The 2026-08-25 decision needs reopening, and both its premises moved:**
- "Overkill for one user" stops being true when the install *is* the product and the install cost *is* the churn.
- **Supabase now ships an OAuth 2.1 server** (public beta since Nov 2025) with mandatory PKCE, OIDC, dynamic client registration for MCP clients, `/.well-known/oauth-authorization-server` discovery, and a JWKS endpoint. **The authorization server is no longer yours to build.**

**What is left is resource-server work:**
- [ ] Serve `/.well-known/oauth-protected-resource`.
- [ ] Add `resource_metadata=` to the `WWW-Authenticate` header `auth.ts` already emits (RFC 9110 compliance is already there).
- [ ] Validate a Supabase access token via cached JWKS (or `getUser`) inside `resolveCaller`, mapping `sub` to a user id. **Every tool already reads `db.ownerId`, so the identity plumbing is done.**
- [ ] **Keep the static bearer path alongside it.** ChatGPT connectors and MCP Inspector still want a key field, and hevy-mcp proves that path is commercially viable.
- [ ] Add `readOnlyHint` / `destructiveHint` annotations to all 30 tools. Required for directory listing.
- [ ] Human-readable tool titles. Also required.

**Caveats:** Supabase's OAuth server is still beta. Anthropic issues #112 and #411 are still open. The Nov 2025 spec update made Client ID Metadata Documents the preferred default over DCR after DCR's openness caused account-takeover incidents.

### 3a.3 Move the connector gate into the server (1 to 2 days)
- [ ] Add a capability column or a scopes array to `mcp_tokens`.
- [ ] `handler.ts` refuses `update_exercise`, `delete_program`, `delete_exercise`, `set_training_plan`, `confirm_training_plan` unless the token carries the capability.
- [ ] Default new tokens to the coach's current restricted set.
- [ ] Decision entry: the connector layer stops being universal once MCP is a first-class surface, so the gate must move behind it.

### 3a.4 Rate limiting (0.5 days)
- [ ] Per-token and per-IP counters on `handler.ts`. In-isolate is fine to start; a small table if you need it to survive restarts.
- [ ] The 401 path must not cost a DB write. Today every request, valid or not, costs an UPDATE against `mcp_tokens`.

### 3a.5 Billing and entitlement (3 days)
- [ ] `subscriptions` table: `(user_id, status, tier, current_period_end, provider_customer_id)`. RLS select-own. **Written only by the webhook, running as service role.** No client write policy.
- [ ] `billing-webhook` edge function alongside `mcp-server` and `coach`, verifying the Stripe signature, upserting the table. Deploy `--no-verify-jwt` since the provider is not an authenticated user.
- [ ] Replace `COACH_ALLOWED_USERS` with an entitlement lookup. **Keep the env var as an override for yourself and for comps.**
- [ ] Gate the MCP mint endpoint on an active subscription.
- [ ] Checkout redirect from the Settings sheet.
- [ ] Handle the cancellation path: entitlement lapses at `current_period_end`, data is retained, export still works.

### 3a.6 Fix F1: `update_exercise` writes shared rows (6 to 10 hours)
Copy-on-write: an edit to a seeded row forks a private `custom` row owned by the editor, and the prescription is repointed. Or restrict the tool to custom-and-owned outright.

**Do this before handing a token to a customer**, because that is the moment the exposure becomes real.

### 3a.7 The legal shell (45 to 60 hours, $2,500-4,500)
Per Part 4.6. LLC separate from Graphite. Business bank account. Stripe. ToS plus privacy policy with a lawyer. Account deletion. Complete the export to all 12 tables. Geo-block decision implemented in code. A separate WA consumer health data policy if you accept WA users. A one-page breach response plan.

## 7.5 Wave 3b: team S&C. Additional 8-12 dev-days on top of 3a.

**Gate: Wave 2 passed AND a coach has said they would pay.**

**Do not build this speculatively.** It is the most dangerous change in the repository and it is only justified by a named buyer.

### 3b.1 The tenancy change (2 days for the SQL)
- [ ] `coach_athletes(coach_user_id, athlete_user_id, granted_at, revoked_at, scope)`. Append-only granting, revoke by timestamp, never delete.
- [ ] `can_read(subject uuid)` returning `subject = auth.uid() or exists (select 1 from coach_athletes where coach_user_id = auth.uid() and athlete_user_id = subject and revoked_at is null)`.
- [ ] Rewrite **fourteen** SELECT policies to use it: `sessions`, `sets`, `set_voids`, `set_notes`, `programs`, `planned_workouts`, `prescriptions`, `training_maxes`, `goals`, `exercise_notes`, `coach_memory`, `training_plans`, `plan_phases`, `feedback`.
- [ ] **Every WRITE policy stays `= auth.uid()`. No exceptions.** A coach inserting as an athlete produces a permanently misattributed set in an append-only table.
- [ ] Assertions in `validate-db.mjs`: a coach with a grant reads; a coach without one does not; a revoked grant stops reading; **a coach cannot write as an athlete**.

### 3b.2 The MCP subject argument (4 days)
- [ ] Add an optional `athlete_id` to the 12 read tools a coach actually needs.
- [ ] Resolve it against `coach_athletes` in `lib/db.ts` before any query. **The service role bypasses RLS, so this check is the only thing standing between tenants on this path.**
- [ ] Leave the other 18 tools single-subject.
- [ ] **`coach_memory` needs a specific decision.** It holds injuries and reaches the model through the context block. A coach reading one athlete's is fine. A coach's model pulling three athletes' injuries into one context is a disclosure incident. Either exclude it from the coach path or scope the context block to exactly one athlete at a time and say so in the prompt.

### 3b.3 The cache namespacing problem (2 days, expect to get it wrong once)
`pwa/src/lib/db.ts` deliberately does not namespace cache keys by user: "one marker has one place to be wrong, forty key builders do not."

A coach switching athletes either blows the entire `kv` cache on every switch, or does not, and shows athlete A's data under athlete B's name.

- [ ] Extend `claimCacheFor` to a `(user, subject)` pair, or clear on every subject switch and accept the refetch.
- [ ] Test the switch explicitly. **This is the single most expensive thing to undo in the repository.**

### 3b.4 Coach-side UI (3 to 4 days)
Roster list, athlete switcher, bulk assignment of a program to N athletes, a compliance dashboard reading `v_prescription_completion` from Wave 1.2.

## 7.6 What NOT to build

Listed so it stays decided.

| Do not build | Why |
|---|---|
| **Voice logging / a generic `log_set` MCP tool** | `set_index` is computed from what the device can read. An MCP write cannot know the index of a set sitting unsynced in the outbox, and in an append-only table **an index collision is permanent**. You have already lived through "a corrected set 2 became set 5". It also loses on its own terms: the repo's own market research ranks fast 2-to-3-tap entry first and entry effort as a top abandonment cause. Speaking to a chat app between sets is more effort with a multi-second latency floor |
| A router with a cheap classifier | Part 5.7. Saves $0.58/month for 30+ hours, and a misroute reads as a coach who did not listen |
| BYOK as the default | Part 5.7. API keys cannot be hashed; it inverts your entire credential posture |
| Inlining the tool loop | Part 5.7. $0.59/month for 20 hours, and it pays the provider-switch cost without collecting the saving |
| Migrating off Supabase | Part 5.1. 35 dev-days to save at most $10/month |
| AGPL relicensing | Part 4.5. Costs goodwill, buys nothing enforceable against your actual competitor |
| Wrapping the PWA natively | Part 4.5. The commission landscape is improving monthly and unsettled. Wrap when a user says they cannot find the app |
| SOC 2, ISO 27001, HIPAA BAA | Part 4.5. Tens of thousands for buyers you do not have |
| Push notifications, before Wave 2 passes | 2.5 weeks of work including an injectManifest rewrite of the riskiest file in the repo. Real gap, wrong time |
| Settings sync | Needs a decision entry, creates a third write-ownership class. Not before there is a business |

**The one narrow relaxation of the write rule that IS defensible, if user evidence demands it: `log_past_workout`.** One call, one closed session with `started_at` and `ended_at` both in the past, the full set list with all UUIDs and indices generated in that call, **refused outright if the user has any open session**, and refused for today if a session exists for today. It serves a need already observed: the real user logs some sets after the fact, and her one session note is a substitution reconstructed afterwards. It would need a `source` column on `sets` recording which client wrote it (additive, legal) and a decision entry carrying the blast-radius argument `docs/security.md` requires.

## 7.7 The honest subtraction

Dead weight that could go regardless of direction.

| Remove | Lines | Why |
|---|---|---|
| `pwa/src/dev/` | **2,191** (`fixtures.ts` 1,175, `mockSupabase.ts` 960, `scenarioBadge.ts` 56) | A hand-written second implementation of PostgREST's behaviour that must be kept in sync by hand. **Largest maintenance liability in the repo, and structurally why a bug like the bulk-insert-NULL failure can pass tests.** The replacement already exists in-house: PGlite, used by `validate-db.mjs` and `coach-eval/stack.mjs`. Net removal ~2,100 lines and a strictly better test signal |
| `docs/superpowers/plans/` (4 of 5 files) | ~1,190 | Three are marked done end to end. They are a work log, not documentation, and `docs/decisions.md` already carries the reasoning. Keep `2026-09-05-plan-and-review-loop.md`, which describes unbuilt work |
| Legacy MCP credential branch | ~8 | Wave 0.7 |
| Exercise demo media | ~130 (`ExerciseDemoSheet.tsx` 109, `exerciseMedia.ts` 23) | Photos are cross-origin from a third-party GitHub raw host, deliberately not service-worker cached. Small code, real third-party supply risk on a HOW TO panel. Cut for any commercial direction |

**What looks like overhead and must not be deleted:** `CLAUDE.md` (461 lines) and `docs/decisions.md` (2,143 lines). Every capability rated "months to rebuild" in Part 1.3 is months **because of what is written there**. They are the record of which invariants were learned by breaking them, and they are the only reason 27 migrations are legible to someone new. **If this repository is ever sold or handed over, those two files are a material part of what is being transferred.**

---

# PART 8: DECISION FRAMEWORK

## 8.1 The gates

Three, in order. Do not pass one without clearing the previous.

**Gate 1 (after Wave 1): does import actually work on a stranger's data?**
Take three real Hevy exports from three different people. If the exercise mapping needs more than five manual corrections per hundred sets, the resolution pass is not good enough and Wave 2 will fail for a reason that has nothing to do with the product.

**Gate 2 (after Wave 2): do 10 of 20 still log at four weeks?**
The single most important measurement in this document. Nothing downstream is worth doing if this fails.

**Gate 3 (before Wave 3b): has a named coach said they would pay?**
Not "would you use this." *"Would you pay $1,500 a year for this for your program?"* If nobody has said yes with a number attached, do not build the multi-athlete model, because it is the most dangerous change in the repository and it is only justified by a buyer.

## 8.2 Kill criteria

Write these down now so you are not negotiating with yourself later.

| Signal | Action |
|---|---|
| Fewer than 5 of 20 still logging at 4 weeks | Stop. Framing A or C |
| Import needs heavy manual mapping on every export | Fix it or stop; it gates everything |
| Cora ships prescribed-versus-achieved | Stop the consumer direction. Reassess Option C or E |
| Hevy adds %TM to routines | Your largest structural gap closes. Reassess everything |
| Six months in, under 20 paying users | Stop. The channel is not working and more features will not fix a channel |
| Anthropic spend exceeds revenue in any month | Fix the caps immediately (Part 2.9), then reassess pricing |

## 8.3 What to measure, and how

You currently have **no product analytics at all**. For a cohort of twenty, do not add a tool; add a weekly SQL query. It keeps health data out of a third party, which matters under Part 4.5.

**Weekly, per user:**
```sql
-- sessions and sets per user per week, live only
select user_id, date_trunc('week', performed_at) as wk,
       count(distinct session_id) as sessions, count(*) as sets
from v_live_sets group by 1,2 order by 2 desc, 1;
```

**Retention:** weeks since first set, versus weeks with at least one set. That is your Day-30 number and the one that decides Gate 2.

**Adherence, once Wave 1.2 lands:** the share of prescriptions reaching `complete`. **This is the number that proves the product's actual thesis**, and until `v_prescription_completion` exists you cannot compute it.

**Cost, once Wave 0.2 lands:** `v_coach_cost` per user per month, against revenue per user. Watch the heavy tail specifically; the mean is not the risk.

**What NOT to measure at this stage:** anything requiring an analytics SDK, a funnel tool, or a session recorder. Twenty users is a spreadsheet, and a session recorder on an authenticated health-data page is exactly the CIPA and HBNR shape Part 4.5 warns about.

## 8.4 The framing question

Three coherent answers, different next actions, mutually exclusive in the next quarter:

| | A: Tool | B: Business | C: Credential |
|---|---|---|---|
| **Next action** | Wave 0 items 1, 2, 4, 6 | Wave 0, 1, 2, then 3a | Wave 0, then find a PI |
| **Time** | 3 hours | 6 to 9 months | 18 months, part-time |
| **Money in** | $25/mo | $2,500-4,500 + 25 weeks | ~$0 |
| **Money out** | $0 | $500-5,000/mo if it works | $10k-30k/study |
| **Risk** | none | high, and the evidence says the market is hostile | low, but slow |
| **What you get** | a log that works | maybe a small business | standing you cannot buy |

**The research says B is hard and A is underrated.** But the research cannot tell you which of these you actually want, and that is the only input it is missing.

---

# APPENDICES

## Appendix A: Every number, with its source

### Cost and pricing
| Number | Value | Source |
|---|---|---|
| Opus 5 input / output | $5.00 / $25.00 per MTok | Anthropic list, Sep 2026 |
| Opus 5 cache read / write (1h) | $0.50 / $10.00 | same |
| Sonnet 5 input / output | $2.00 / $10.00 | same |
| Haiku 4.5 input / output | $1.00 / $5.00 | same |
| Cached prefix, measured live | 9,656 tokens | `docs/decisions.md:1020` |
| Cached prefix, code's own claim | ~17,000 tokens | `coach/index.ts:786` |
| System prompt | 13,958 chars | measured |
| 25 tool schemas | 30,156 chars raw TS | measured |
| Real user's 13 turns, Opus | ~$1.09 | gaps roadmap |
| Real user's 13 turns, Sonnet | ~$0.44 | gaps roadmap |
| Cache read share of input | 64% | gaps roadmap |
| Cost per turn, Opus | $0.084 | derived |
| Typical user | $4.56/mo | derived |
| Heavy user | $24.75/mo | derived |
| Supabase Pro | $25/mo | Supabase pricing |
| Supabase at 10,000 users | $32/mo | derived |
| Supabase PITR | ~$100/mo per 7-day window | Supabase docs |
| Supabase HIPAA | Team $599/mo + $350/mo add-on | Supabase docs |

### Market
| Number | Value | Source |
|---|---|---|
| Hevy | $2.99/mo, $23.99/yr, $74.99 lifetime | vendor |
| Hevy users | 16M+ claimed | vendor |
| Hevy Trainer shipped | 18 Feb 2026, bundled | vendor |
| Strong | $4.99/mo, $29.99/yr | vendor |
| SensAI | $6.99/mo, $69.99/yr | vendor |
| Fitbod | $15.99/mo (raised from $12.99 in 2026) | vendor |
| JuggernautAI | $34.99/mo | vendor |
| AthleteData MCP tier | $9/mo, $69/yr | vendor |
| AthleteData coach tier | $39/mo | vendor |
| Cora | $9.99/mo | vendor |
| TrainHeroic per athlete | $1.00, $0.50 enterprise | vendor |
| TrueCoach at 50 clients | $164.98/mo | vendor |
| Everfit at 50 clients | $95/mo | vendor |
| Median subscription app | $492/mo, down 22% YoY | RevenueCat 2026 |
| Apps never reaching $1,000 total | 57.7% | RevenueCat 2026 |
| Revenue concentration | 94.5% to top 10% | Adapty |
| AI app annual retention | 21.1% vs 30.7% | RevenueCat |
| AI app revenue per user | +41% | RevenueCat |
| AI app churn | +30-36% | RevenueCat |
| Health/fitness Day-30 retention | 3-5% median | UXCam / Fitness Refined 2026 |
| Fitness monthly churn | 7-10%, one report 9.2% | Adapty |
| Annual subs retained | ~33% | category reports |
| Annual cancellations in month one | 35% | category reports |
| Top cancel reason | lost motivation, 38% | category reports |
| CPI iOS / Android | ~$4.70 / ~$3.70 | SEM Nexus |
| Fitness install-to-paid | 3-8% | benchmarks |
| Real CAC per paying user | $20-80 | derived |
| AI app gross margin | 50-60%; ICONIQ 2026 avg 52% | Bessemer, a16z, ICONIQ |
| Fitness app revenue worldwide 2026 | $9.12B | Statista |
| Personal-trainer software market | $780.5M (2025) to ~$1.85B (2033) | Straits Research |

### MCP distribution
| Number | Value | Source |
|---|---|---|
| Anthropic connectors in directory | 1,625 across 30 categories | catalog snapshot 2026-08-10 |
| Health and Fitness category | **does not exist** | same |
| Fitness-adjacent entries | 7 | same |
| Named competitors listed | **0 of 9** | same |
| mcp.so indexed servers | 20,222 (Apr 2026) | mcp.so |
| Smithery servers | 7,000+ | Smithery |
| ChatGPT apps accepted | 150 in two weeks, ~500 queued (Apr 2026) | OpenAI |
| chrisdoc/hevy-mcp stars | 453 | GitHub |
| Arvo Android installs | ~1,600 (Jun 2026) | AppBrain |

### Repository
| Number | Value |
|---|---|
| Commits | 58 |
| Total TS/TSX/SQL lines | ~40,846 |
| PWA source | ~29,809 (7,545 tests) |
| Edge functions | 8,671 |
| Migrations | 27 files, 2,095 lines |
| Tables | 20 |
| Views | 13, all `security_invoker` |
| RLS policies | 60 |
| `auth.uid()` usages | 91 |
| MCP tools registered | 30 (25 visible to the coach) |
| `db.ownerId` references in the server | 103 |
| `.eq("user_id", ...)` in the server | 65 |
| PostgREST query chains, PWA | 67 (~412 lines) |
| PostgREST query chains, edge | 103 |
| Tests | 578 (517 vitest, 61 Deno) |
| `validate-db.mjs` assertions | 234 |
| Untested screen lines | ~5,750 |
| Real users | 2 |
| Real sets logged by a non-owner | 41 |

## Appendix B: Where the numbers came from

**Reached directly:** the repository itself, all GitHub and raw.githubusercontent.com content, the Anthropic connector catalog snapshot, Anthropic's published API pricing, Supabase's published pricing and docs, Cloudflare and Netlify pricing docs.

**Reached through search summaries only** (a retrieval layer read the live page; the raw HTML was not seen): trayna.io, workoutmcp.com, athletedata.health, arvo.guru, assistantcoach.fit, shapecalendar.com, corahealth.app, api.hevyapp.com, trainingtilt.com, apps.apple.com, play.google.com, and every MCP directory (LobeHub, Glama, PulseMCP, mcp.so, Smithery). **Treat all vendor marketing claims from these, especially Arvo's offline claim, as vendor-asserted.**

**Blocked entirely and therefore absent from this review:** reddit.com and Hacker News. **That is a real gap.** The demand evidence in Part 3.7 rests on products that exist and on secondary reporting, not on primary user voice. Before acting on Wave 2, read the actual forums yourself.

**Non-Anthropic LLM pricing** in Part 5.7 came through search rather than primary pricing pages. Verify before committing to any provider switch.

**Anything legal or regulatory** should be verified against the primary rule text before you rely on it. In particular: do not price an RTM business off the vendor-published CPT averages in Part 6.6 until you have read the CY2026 Physician Fee Schedule final rule yourself.

## Appendix C: Security findings, consolidated

| ID | Finding | Severity | Effort | File |
|---|---|---|---|---|
| S1 | Unbounded Anthropic spend from open signup; racy quota; no account cap | **Blocker** | 8-14 h (0 h to mitigate) | `coach/index.ts:102-110, 628-635, 682, 748` |
| S2 | Coach conversations logged in plaintext by default | **Blocker** | 0 h to disable | `coach/index.ts:520, 555-556` |
| S3 | No account deletion; export covers 3 of ~12 tables | **Blocker** | 10-16 h | `pwa/src/lib/export.ts:96, 107, 117` |
| S4 | Auth email via personal Gmail SMTP; lockout attack | **Blocker** | 3-5 h | `supabase/config.toml:25-32` |
| F1 | `update_exercise` writes rows every tenant reads | High | 6-10 h | `tools/manage_exercises.ts:45-53` |
| F2 | Legacy `MCP_SECRET` shared credential, unrevocable | High | 0.5 h | `mcp-server/lib/auth.ts:85-90` |
| F3 | No self-serve token mint / list / revoke | High | 10-14 h | `scripts/issue-mcp-token.mjs:59-62` |
| F4 | No rate limiting on the MCP server at all | High | 4-8 h | `mcp-server/lib/handler.ts:130-246` |
| F5 | No per-user resource quotas | Medium | 4-8 h | `20260825120002_rls.sql:22-23` |
| F6 | Monthly spend cap undercounts ~4x (no paging) | Medium | 1 h | `coach/index.ts:286-295` |
| F7 | Backups and restore undocumented and untested | Medium | 4 h | `docs/deploy.md` |
| F8 | No Content-Security-Policy at all | Medium | 2-3 h | `pwa/index.html` |
| F9 | No session revocation, no audit log | Medium | 8-12 h | - |
| A1 | `mcp_writer` role: make the write rule a constraint | **Recommended** | 1.5-2 d | `mcp-server/lib/db.ts` |

**Confirmed clean:** cross-tenant reads through RLS, the 13 views, and all 30 MCP tools. Client-side service role exposure. XSS sinks. Committed secrets. Password-based attack classes (there are no passwords).

## Appendix D: Key file index

| Path | Lines | Role |
|---|---|---|
| `pwa/src/screens/Session.tsx` | 2,183 | Core set-entry loop. **Untested** |
| `pwa/src/screens/Plan.tsx` | 1,739 | Plan editor. **Untested** |
| `pwa/src/screens/Today.tsx` | 1,550 | Week strip, day states, session start |
| `pwa/src/lib/data.ts` | 1,931 | Every read. 58 PostgREST chains |
| `supabase/functions/coach/index.ts` | 938 | The LLM proxy. Model, caps, connector config |
| `pwa/src/components/SettingsSheet.tsx` | 823 | Settings, export, sign-out |
| `pwa/src/lib/outbox.ts` | 501 | The offline queue. 704 lines of tests |
| `pwa/src/components/CoachSheet.tsx` | 534 | Chat UI. **Untested** |
| `pwa/src/screens/End.tsx` | 548 | sRPE, bodyweight, tonnage |
| `pwa/src/screens/History.tsx` | 476 | Per-exercise only. **Untested** |
| `supabase/functions/coach/prompt.ts` | 298 | 298-line system prompt |
| `pwa/src/lib/export.ts` | 221 | **Read this before writing import** |
| `pwa/src/lib/sections.ts` | 359 | Entry grouping. 457 lines of tests |
| `scripts/validate-db.mjs` | 1,502 | 234 assertions, PGlite, no Docker |
| `scripts/coach-eval/` | ~1,470 | **Built, never run at the API level** |
| `pwa/src/dev/` | 2,191 | **Deletion candidate** |
| `docs/decisions.md` | 2,143 | **Do not delete. Material asset** |
| `CLAUDE.md` | 461 | **Do not delete. Material asset** |

## Appendix E: The one-page version

**Do not sell this as a consumer app.** You need $20/month against a $2.99 incumbent that bundles your differentiator free.

**Do these seven things this week, regardless:** set `COACH_ALLOWED_USERS`, fix `v_coach_cost`, run the $2 eval, turn `COACH_LOG_CONTENT` off, move to Cloudflare Pages, add the second cache breakpoint, delete the legacy auth branch. **~12 hours.**

**Then build import and the compliance view. 4 to 5 days.** Without them the product cannot accept a user who has ever trained before, and cannot answer the one question it exists to answer.

**Then find twenty coached lifters and watch them for four weeks.** If ten still log, you have a business decision to make. If they do not, you saved six months.

**The three real options are:** keep it as a tool ($25/month, zero risk, not failure), grind out bottom-of-market team S&C (70 programs at $1,500 clears $100k), or convert it into a research credential and re-enter in eighteen months as someone with standing.

**The thing you built that is genuinely scarce is invisible to buyers.** That is a fact about markets, not about the work.
