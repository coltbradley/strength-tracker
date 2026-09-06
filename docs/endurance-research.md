# Endurance planning: what the evidence supports

Research pass completed 2026-09-06, six parallel lanes: how existing platforms
model the problem, training-load and readiness science, ultra-specific
periodization, strength programming and concurrent training, injury
surveillance and triage, and what athlete data is actually obtainable.

This document is the evidence base for the endurance layer. It is not a plan;
[endurance-plan.md](endurance-plan.md) is the plan. Its job is to record what
may be encoded as a rule, what may only be reported as an observation, and what
must not be built at all.

## How to read the tags

- `[STRONG]` replicated, meta-analytic, or a consensus statement.
- `[MODERATE]` supported but limited: small n, single site, or extrapolated.
- `[WEAK]` mixed, methodologically criticised, or contested.
- `[CONVENTION]` widely practised by credentialed coaches, little published support.
- `[NEGATIVE]` the evidence supports NOT doing the thing.

A rule may be encoded in the planner only if it is `[STRONG]` or `[MODERATE]`.
`[CONVENTION]` may be a default the user can see and change. `[WEAK]` may be
reported to the user as an observation and may never gate a decision.

## What this system refuses to compute

This list is the most valuable output of the research pass, because every item
on it is something the market ships and something a plausible-looking
implementation would reach for first.

**Acute:chronic workload ratio (ACWR).** `[NEGATIVE]` Acute load is a subset of
chronic load, so the ratio is mathematically coupled and produces spurious
correlations. Meta-analyses disagree on the direction of the effect. When
outliers are removed and load is treated as continuous the relationship to
injury disappears. In ultramarathon runners specifically the effect on injury
risk was non-significant (p = 0.3). Randomised chronic loads perform as well as
real ones.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC12487117/>

**TSB, CTL, ATL, and the Performance Management Chart.** `[NEGATIVE]` ATL's
7-day window is a subset of CTL's 42-day window, which is the identical coupling
defect. The 42 and 7 day constants are asserted, not derived per athlete, and
the "form" bands are vendor heuristics. There is no independent peer-reviewed
validation of TSS/CTL/ATL. Its parent, the Banister fitness-fatigue
impulse-response model, is descriptive rather than predictive: Hellard showed
the parameters are ill-conditioned, with unstable estimates and wide intervals
that shift with the fitting window.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC1974899/>

**Any predicted finish time or predicted future performance date.** `[NEGATIVE]`
Follows from the above. Riegel extrapolation past the marathon is unreliable and
ultra finish time is dominated by course profile, aid strategy, nutrition and
heat rather than by flat-road fitness.

**A single composite readiness score.** `[NEGATIVE]` Subjective and objective
recovery measures generally do not correlate (Saw 2016, 56 studies). A composite
merges signals the evidence says move independently, and hides which one moved.
Report a panel with per-signal confidence, including "not enough data".

**hrTSS, rTSS, and Strava Relative Effort.** `[WEAK]` Second-order estimates
layered on an unvalidated first-order metric. Relative Effort is a reweighted
Banister TRIMP described only in an engineering blog post with no published
validation. Session-RPE does the same job honestly.

**Any overtraining or NFOR diagnosis.** `[NEGATIVE]` The ECSS/ACSM consensus is
that hormonal, performance, psychological, biochemical and immune markers all
fail acceptance criteria. Diagnosis is by exclusion and NFOR is distinguished
from OTS only retrospectively by recovery duration. The tool may flag a pattern.
It may not name a syndrome.
<https://onlinelibrary.wiley.com/doi/10.1080/17461391.2012.730061>

**Injury prediction from passive signals.** `[NEGATIVE]` There is no prospective
evidence that consumer wearable running-dynamics metrics (cadence, ground
contact time asymmetry, vertical oscillation) detect emerging injury before the
athlete reports it. ML injury-prediction models run at roughly AUC 0.52 and were
"largely unable to distinguish injured from non-injured individuals", with ML
not superior to logistic regression. Running injury incidence is about 7.7 per
1000 hours, so at any plausible sensitivity a daily passive alarm is
overwhelmingly false positives.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC12013557/>
<https://link.springer.com/article/10.1007/s40279-022-01760-6>

**The 10% rule.** `[NEGATIVE]` Falsified twice. GRONORUN found no injury
reduction from a 13-week graded 10% program versus a standard 8-week one. Buist
2008 (n = 532) found injury in 20.8% of a 10%/week graded program versus 20.3%
of a standard ~24%/week program.
<https://pubmed.ncbi.nlm.nih.gov/17940147/>

**Wearable sleep staging and vendor recovery percentages.** `[WEAK]` Closed
algorithms, no published validation. Total sleep time is usable; stages are not.

**An injury-prevention claim for strength training.** `[WEAK]` Contested. See
"Strength" below. Strength earns its place on other grounds.

## The two-state model

The single most important structural finding. The planner must carry two state
variables with different time constants, not one fitness number.

**Aerobic state decays fast and returns fast.** `[STRONG]` VO2max falls 4 to 8%
at three weeks off and 6 to 20% by four weeks in highly trained athletes. The
steepest early loss is driven by plasma and blood volume contraction, which is
restored within days to two weeks of retraining.
<https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2023.1334766/full>

**Tissue tolerance decays and rebuilds on a slower clock.** `[MODERATE]` Bone
stress injuries appear roughly 3 to 4 weeks after a load shift, cortical
remodeling runs 4 weeks to 3 months, and tendon adaptation lags muscle by 6 to
12 weeks. Timelines are inferred from the injury and healing literature rather
than from detraining studies.
<https://www.jospt.org/doi/10.2519/jospt.2021.9982>

The consequence: after a multi-week gap the aerobic system is ready first and
the structures are ready last. A return-to-training plan must be gated by the
slower variable. A single fitness score gets this exactly backwards, because it
reflects the fast variable and therefore says "ramp".

This is not hypothetical for this repository's first user. The Strava history
shows a 26-day zero-running gap (2026-07-26 to 2026-08-21) following a peak of
75 km/wk, and a second near-gap in late June. The pattern is the dominant
variable in his training and no platform models it.

## Encodable rules

These are the constraints a block generator may enforce.

### Progression

| Rule | Tag | Source |
|---|---|---|
| Longest run may not exceed 110% of the longest run in the prior 30 days, measured in DURATION | `[MODERATE]` | <https://runnersconnect.net/injury-prevention/> |
| Weekly volume increase >30% over two weeks is a warning, not a block. Shown in novices only | `[MODERATE]` | <https://www.jospt.org/doi/10.2519/jospt.2014.5164> |
| Weekly-mileage change predicts injury at near chance; do not gate on it | `[NEGATIVE]` | as above |

Duration rather than distance is deliberate. Trail pace varies two to three
times with grade, so distance is a poor dose proxy. The "time on feet" framing
is mechanistically sound but is `[CONVENTION]`: no study compares
duration-prescribed against distance-prescribed long runs.

### Descent and eccentric load

Descent is the design driver and the thing no platform models.

- Mountain ultras produce about 40% knee-extensor strength loss at the finish,
  CK elevations around +900%, and 5 to 9 days to normalise. `[STRONG]`
  <https://pubmed.ncbi.nlm.nih.gov/41602794/>
- The repeated bout effect reduces damage markers on a subsequent bout by 50 to
  80%. `[STRONG]` <https://www.nature.com/articles/s41598-020-76008-2>
- One exposure confers most of the protection; further bouts add less.
  `[MODERATE]`
- Protection lasts about 2 to 3 weeks, decaying, and is gone by around 9.
  `[MODERATE]`
- Climbing partly transfers from general aerobic fitness; descending does not.
  `[MODERATE]` <https://pmc.ncbi.nlm.nih.gov/articles/PMC8281813/>

Encoded: hard descent exposures every 10 to 14 days from 6 to 8 weeks out, with
descent vertical progressed independently of total volume, and 5 to 9 days
between high-eccentric sessions.

**The trap:** soreness responses differ by bout number but neuromuscular fatigue
responses do not. Feeling fine is not the same as being protected. No rule may
read absence of soreness as adaptation.

Total descent is the wrong dose unit. 500 m descended at walking pace is not
500 m descended at 4 m/s. A grade-and-speed weighted descent metric is
computable from FIT files and is the defensible input for dosing this block.

### Taper

The best-quantified parameter in the whole pass. `[STRONG]` Reduce volume 41 to
60%, hold intensity AND frequency constant, duration up to 21 days, progressive
or step. Reducing intensity produces no benefit.
<https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0282838>

`[MODERATE]` caveat: the meta-analyses are built on events far shorter than
50K, so the percentages are extrapolation. The "hold intensity" half is robust.

### Race modifiers, solved backward from race date

This is what makes block generation a solver rather than a template filler.

| Modifier | Dose | Placement | Tag |
|---|---|---|---|
| Altitude | 3 to 4 weeks at 2000 to 2500 m | longest lead time; below 1800 m is not worth doing | `[MODERATE]` |
| Heat | 7 to 14 exposures; adaptation decays 2.3 to 2.6%/day, re-acclimation 8 to 12x faster | block ends within ~2 weeks of race, then top-ups | `[STRONG]` |
| Gut (60 to 90 g/h carbohydrate) | 4 to 6 weeks, adaptation reported from 10 to 14 days | rides on existing long runs | `[MODERATE]` |
| Night running | familiarisation only | below 161 km, continuous running beats sleeping, and runners who slept MORE pre-race finished faster | `[MODERATE]` |
| Eccentric/descent | see above | every 10 to 14 days, ending >=3 weeks out | `[MODERATE]` |

<https://pubmed.ncbi.nlm.nih.gov/29129022/>
<https://pmc.ncbi.nlm.nih.gov/articles/PMC10185635/>
<https://link.springer.com/article/10.1186/s40798-024-00704-w>

### Intensity distribution

`[STRONG]` "Most volume easy" is supported. `[WEAK]` The specific 80/20 split is
not. Observational marathon data is about 76% Z1 / 16% Z2 / 8% Z3, with faster
groups doing more Z1; elites are typically pyramidal by volume and polarized by
session count.

`[MODERATE]` Polarized beat other distributions for VO2peak only, only in
interventions under 12 weeks, and only in highly trained athletes. Time trial,
time to exhaustion and lactate threshold outcomes were equivalent across
distributions. Sequence may matter more than label: pyramidal then polarized
produced the largest gains in a 16-week trial.

`[WEAK]` Ultra-endurance has no intensity-distribution RCT. Everything here is
extrapolated from 5K to marathon cohorts where the limiting physiology differs.

## Load and readiness

### What to compute

**Session-RPE (RPE x minutes).** `[MODERATE]` The best-validated field load
method, roughly 36 validity and reliability studies, correlating strongly with
HR-based TRIMP. Critically it is one unit that covers running and lifting, which
makes it the cross-modality currency this system needs.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC5673663/>

Its documented failure modes are real: sensitive to collection timing (about 30
minutes post-session), sensitive to mood state, and structurally unable to
distinguish 60 minutes at RPE 5 from 30 minutes at RPE 10. The timing condition
becomes a schema field, not an assumption: store when the RPE was collected.

**Daily subjective wellness.** `[STRONG]` This is the headline finding of the
load lane. Saw, Main and Gastin (BJSM 2016), 56 studies: subjective wellbeing
tracked acute and chronic load with superior sensitivity and consistency
compared to objective measures, and the two categories generally did not
correlate. Wellbeing fell with acute load increases and rose with taper.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC4789708/>

The build-order consequence: the cheapest data to collect is also the best
signal. Automate the mechanical facts completely so the entire user-attention
budget can be spent on the subjective ones.

`[MODERATE]` for validated instruments (POMS, RESTQ-Sport, DALDA), `[WEAK]` for
the short custom wellness sliders most apps ship, which are unvalidated as
psychometric instruments.

**Submaximal HR and RPE at a fixed benchmark effort.** `[MODERATE]` The one
objective marker with functional-overreaching evidence behind it. Requires a
repeatable protocol.

**Time in zone as durations against a versioned zone definition.** Percentages
are derived. Zone boundaries change, so the definition needs the threshold test
date that produced it.

**Ascent and descent separately.** Grade-adjusted pace is derived and labelled,
never stored as load. `[MODERATE]` for metabolic cost, `[WEAK]` as load: GAP
rests on Minetti 2002 (10 subjects, treadmill, +/-45%) and ignores eccentric
muscle damage, technicality, and fatigue-induced economy loss.

### The overreaching direction trap

`[MODERATE]` In functional overreaching the reproducible early markers are
counter-intuitive: LOWER heart rate at a fixed submaximal intensity, FASTER heart
rate recovery, higher RPE at the same load, and worsening DALDA/POMS. A naive
"faster HR recovery means recovered" rule reads overreaching as fitness.
<https://journals.humankinetics.com/view/journals/ijspp/16/8/article-p1065.xml>

`[MODERATE]` Subjective fatigue and readiness distinguished functional
overreaching from acute fatigue after only three days of overload, before any
performance decline.

### How much data before a signal means anything

`[MODERATE]` HRV needs a minimum 4-week personal baseline, and most positive
HRV-guided trials used 60 days or more. Use a 7-day rolling mean against a
smallest worthwhile change of 0.5x within-athlete SD, never a fixed percentage.
Typical within-athlete lnRMSSD CV is 5 to 8%, which is the noise floor any daily
readiness number must clear.

`[MODERATE]` Anything inferred from under 6 weeks of one athlete's data is a
hypothesis, not a finding.

HRV-guided training itself is `[MODERATE]` with small effects: ES around 0.40 on
VO2max in one meta-analysis; g = 0.296 for submaximal physiology but
non-significant for performance (g = 0.079) and VO2peak (g = 0.171) in another.
The main documented benefit is fewer non-responders.

## Strength and concurrent training

### The maintenance floor

`[STRONG]` Strength and muscle size are maintained for up to 32 weeks on as
little as 1 session per week and 1 set per exercise, provided relative load is
held. Intensity is the non-negotiable variable; frequency and volume are the
ones that may be cut.
<https://pubmed.ncbi.nlm.nih.gov/33629972/>

This is how "strength does not get cut" becomes an encodable constraint rather
than a preference: a floor on `load_pct_tm` (>=85%), with sets and frequency
absorbing all running-volume pressure. Reduced-frequency trials support it:
1x/week preserved about 95.6% of leg press 1RM and quadriceps CSA after 12 weeks
of concurrent training.

`[STRONG]` Development, as opposed to maintenance, needs 2 to 3 sessions per
week for at least 10 weeks before running-economy effects are reliably
measurable. Below about 8 weeks the literature is largely null. The engine
should refuse to label a shorter block a strength-development phase.

`[WEAK]` Running-economy gains from strength training persist about 4 weeks
without further stimulus. That is the size of the safe strength taper, and it
means a 3-week ramp-down with load preserved costs essentially nothing.

### What kind of strength

`[STRONG]` Heavy resistance training beats plyometrics for running economy
(pooled g = -0.32 vs -0.13) and time trial (-0.24 vs -0.17). Near-maximal loads
(>=90% 1RM) outperformed lower loads. Effects were largest at 10 to 14 weeks.
<https://pubmed.ncbi.nlm.nih.gov/36370207/>

`[MODERATE]` Plyometric benefit to running economy is speed-restricted to
12.00 km/h and below, which makes it largely irrelevant at 50K pace. High-load
work improves time trial and time to exhaustion with no change in VO2max, so the
mechanism is non-metabolic: stiffness, rate of force development, recruitment.

`[MODERATE]` Typical running-economy improvement is 2 to 8%, but the pooled
effect is small. Do not let the engine oversell it.

### Interference, in two directions

`[STRONG]` Chronically, interference is one-directional. Endurance blunts
strength; strength does not blunt VO2max. Aerobic gains are comparable between
concurrent and endurance-only training.
<https://pubmed.ncbi.nlm.nih.gov/41762427/>

`[MODERATE]` Acutely, the direction reverses. Residual fatigue from a resistance
session impairs subsequent endurance quality for several hours to days,
degrading running kinematics and raising energy cost.
<https://link.springer.com/article/10.1007/s40279-017-0758-3>

These are separate rules. A single interference penalty gets one of them wrong.

`[MODERATE]` Separation: 6 hours yields strength outcomes equivalent to 24
hours. 3 hours clears the molecular signalling (AMPK back to baseline) but total
work capacity remains depressed for 8 hours or more after endurance. So 3 hours
is the floor, 6 the working recommendation, 24 optimal.

`[MODERATE]` Interference scales with endurance frequency and duration, and is
absent when trained athletes split the modes into separate sessions. Running is
worse than cycling, attributed to eccentric contraction-induced damage.

`[WEAK]` Intra-session order affects power indices but not strength, lean mass
or aerobic fitness over 9 weeks. This is the weakest evidence in the section.

### Eccentric protocols

`[MODERATE]` Four weeks and 10 sessions of downhill running produced
neuromuscular adaptations equivalent to high-intensity eccentric resistance
training. A single 30-minute downhill bout 14 days prior attenuated fatigue in
subsequent running.

`[CONVENTION]` Gym side: 3 to 5 second lowering on squats, split squats and
step-downs; 3x6-8 for strength-biased, 12 to 15 reps for endurance-biased;
progress by height, load, or assistance.

### The injury-prevention conflict

Two lanes disagreed and the disagreement is recorded rather than resolved in
favour of the convenient answer.

Lauersen 2018 reports RR 0.34 for overall injury, about a 66% reduction, from 26
RCTs. `[MODERATE]` at best: 6 RCTs on the strength arm, mostly non-runners.
<https://pubmed.ncbi.nlm.nih.gov/30131332/>

More recent meta-analyses report RR 0.97 (95% CI 0.57 to 1.63), that is no
preventive effect, and RR 0.94 with I2 = 81% in adult recreational athletes.
`[WEAK/CONTESTED]`
<https://pmc.ncbi.nlm.nih.gov/articles/PMC9298606/>

Position taken: weight the peer-reviewed nulls higher. Strength training is
plausibly protective and certainly not harmful, but the engine may not promise
injury reduction. Justify strength on running economy and descent durability,
which have better support, and treat injury reduction as a bonus. This changes
what the product claims, not what it schedules.

## Injury surveillance and triage

### Copy the instrument, do not invent one

The OSTRC Overuse Injury Questionnaire is the standard surveillance instrument.
Four items, 7-day recall, self-completed weekly, scored 0 to 100. The 2020
revision (OSTRC-O2 / OSTRC-H2) reworded all four stems, notably Q2 from
"reduced your training volume" to "modified your training or competition".
`[STRONG]` <https://pubmed.ncbi.nlm.nih.gov/32071062/>

v2.0 stems, 7-day recall:

1. Have you had any difficulties participating in training and competition due
   to [location] problems during the past 7 days?
2. To what extent have you modified your training or competition due to
   [location] problems during the past 7 days?
3. To what extent have [location] problems affected your performance during the
   past 7 days?
4. To what extent have you experienced pain? (No pain / Mild / Moderate / Severe)

Case definitions, which are what triage branches on:

- **Health problem**: Q1 is anything other than "Full participation without
  health problems".
- **Substantial health problem**: Q1 "Cannot participate", OR Q2 >= "To a
  moderate extent", OR Q3 >= "To a moderate extent".

**VERIFICATION REQUIRED BEFORE SHIPPING ITEM TEXT.** The research session's
egress proxy blocked PMC, BMJ, SAGE and the OSTRC's own site. The wording above
was reconstructed from the Oslo group's own R package (`ostRc`) and a public
dataset, then cross-checked against search snippets. The v2 scoring in
particular, whether Q2/Q3 collapse to four options at 0-8-17-25, is the piece
most in need of confirmation. Verify against Clarsen 2020, BJSM 54:390-6.

`[STRONG]` Adherence is achievable: mean weekly response 91.5% in one cohort,
82 to 96% across others, 79% responding within one day with SMS prompting.
Weekly is the validated cadence, because the recall period is the measurement.
More frequent prompting of this instrument is off-label.

### The individual noise floor

`[MODERATE]` In runners the OSTRC severity score has a minimal important change
of 18.5 but a smallest detectable change of 35.06 for an individual (9.30 for a
group). SDC exceeds MIC individually, so a single runner's week-to-week change
below 35 is largely measurement noise.
<https://onlinelibrary.wiley.com/doi/full/10.1111/sms.13885>

Trend, never alarm on deltas. What catches problems instead is persistence:
same body region flagged three consecutive weeks warrants clinician
assessment regardless of severity. Persistence, not intensity, is the overuse
signature.

### Pain gates

`[MODERATE]` Silbernagel pain-monitoring model, from an Achilles tendinopathy
RCT: continued running permitted at pain <=5/10 during and after loading,
provided it settles to baseline by the next morning and does not increase week
to week. The continued-activity group did not do worse than rest.
<https://journals.sagepub.com/doi/abs/10.1177/0363546506298279>

`[CONVENTION]` General return-to-run is stricter: <=2/10 during, not escalating
within the run, back to baseline within 24 hours. Above 3/10, or next-morning
symptoms, means repeat the previous stage rather than progress.

The next-morning criterion does the real work in both models, and it is a
24-hour delayed signal. It must be asked the morning after a run, as a separate
prompt with its own timestamp, not as a field on the run.

### Red flags

`[CONVENTION]` Bone stress injury presentation, where any single one triggers
referral rather than a combination: focal point tenderness over bone (as against
diffuse soft-tissue tenderness), night or rest pain, pain reproduced by
single-leg hopping, pain progressing earlier into successive runs, pain present
in daily walking.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC13504497/>

Store as separate booleans, not a score. A score invites a threshold and there
is not one.

`[STRONG]` REDs: the 2023 IOC consensus and CAT2 are explicitly physician-led at
the diagnostic step. A consumer tool may screen and refer. It may not stratify.

### Predictors

`[STRONG]` Previous injury is the strongest and most replicated predictor:
HRR 1.9 (95% CI 1.2 to 3.2) over one year in 224 recreational runners.
<https://www.jospt.org/doi/10.2519/jospt.2021.9673>

`[WEAK]` Biomechanical and musculoskeletal variables show trivial-to-small
effects in prospective studies and are not generally supported as risk factors.
Shoe cushioning effects are conditional on body mass; motion-control RCTs are
largely null.

### Base rates

`[STRONG]` Trail running injury incidence is 8 to 10.7 per 1000 hours, with
about 40% of runners injured over a 14-week race build. Over 70% are overuse.
Sites in ultra runners: ankle 34.5%, knee 28.1%, lower leg 12.9%. Structures:
muscle 47%, tendon 24%.
<https://link.springer.com/article/10.1007/s40279-020-01418-1>

That 40% is the number the injury half of this system exists to move.

### One finding handled carefully

`[WEAK]` In 106 ultramarathoners, LOWER training volume predicted HIGHER injury
risk, roughly 2x at under 25 km/wk versus 100 km/wk, with risk minimised near
150 km/wk. Retrospective, road (Comrades), and confounded by fitness, since
fitter people both run more and get injured less.

The defensible reading is narrow: treating "go easy" as automatically safe is
not supported. It is not evidence that anyone should ramp. This may be reported
as context and may never gate a decision.

## Data sources

### What is obtainable

Verified against the live account on 2026-09-06.

| Fact | Source | Cost |
|---|---|---|
| Volume, duration, ascent | Strava `list_activities` | free |
| HR, power, cadence | Strava `get_activity_performance` | 1 call per activity |
| Climb vs descent performance | Strava lap `avg_grade` | same call |
| Fitness trend | repeated segment HR and watts | free, derived |
| Speed anchors | `best_efforts`, rolling max | free |
| Zones, FTP, max HR | `get_athlete_zones` | free |
| Shoe mileage and rotation | `get_gear` | free |
| Candidate travel windows | Google Calendar, multi-day and OOO | free, confirm once |
| Race date and course | Gmail registration, then the race site | free, confirm once |
| Heat acclimation need | historical weather for race location and date | free, derived |
| Iron, vitamin D, thyroid | HealthEx labs | free if records connected |
| Strength load, e1RM, sRPE, bodyweight | this repository | already have it |
| Sleep, HRV, resting HR | NOT in Strava | see below |
| Trail vs road | unreliable; derive from grade variance or polyline | |
| Pain, energy, session intent | irreducibly self-report | |

Two findings from probing the live account are worth recording:

`get_strength_workout_details` returns `exercise_name: "Unknown"` with a step
count for this user's weight-training activities. Strava holds nothing usable
about strength. That settles the split: strength detail lives here, endurance
lives upstream, and there is no reconciliation problem.

The account has `has_device_watts: true`. Running power is available, which is
grade-independent and therefore solves the "pace is meaningless on a climb"
problem without a grade-adjustment model.

### The integration recommendation

**intervals.icu, not the Strava API.** `[DOCUMENTED]`

One free instant API key (Settings, Developer Settings, HTTP Basic) gives
activities, streams, FIT upload and download, and a wellness endpoint carrying
resting HR, HRV, sleep and weight. Webhooks fire on activity upload and calendar
change. It auto-syncs wellness from Garmin, Polar, Suunto, Coros, Oura, Whoop,
Amazfit and Huawei, with Garmin landing within about five minutes including
overnight HRV, sleep stages, Body Battery and Training Readiness.

Its terms explicitly grant commercial use: "non-exclusive, worldwide,
royalty-free, perpetual license for any lawful purpose, including commercial
use", with derived outputs freely distributable. The one condition is
attribution when consuming Garmin-origin data.
<https://www.intervals.icu/features/open-api/>

Compare the Strava API path: Standard tier capped around 10 users, requiring the
developer to hold a paid Strava subscription, roughly 100 reads per 15 minutes
and 1000 per day, an API agreement barring use of the data in AI models, a
display restriction, and a platform owner that acquired Runna and now sells the
competing product.

The split adopted: Strava's MCP remains the ad-hoc reading surface in Claude
Desktop, where the segment and lap data lives and costs nothing. intervals.icu
is the programmatic integration the edge function talks to.

Risk accepted: intervals.icu is a one-person free service with no SLA, and its
data quality is only as good as its upstream sync. The fallback is FIT file
parsing, which carries raw R-R intervals and running dynamics that no API
returns.

### Sources ruled out

- **Garmin direct.** `[DOCUMENTED]` The Connect Developer Program
  access-request form was removed in 2026 and maintainers report it on hold with
  no reopen date. Historically required a legal entity and business review. Do
  not plan around it.
- **Fitbit.** `[DOCUMENTED]` New developer accounts are no longer issued and the
  legacy Web API turns down September 2026. The Google Health replacement has
  zero schema overlap and all scopes are Restricted.
- **Oura direct.** `[DOCUMENTED]` Its API agreement prohibits using user data to
  "train, fine-tune, develop, improve or enhance any AI model, regardless of
  technique", and bars aggregators from relaying Oura data to any LLM. Inference
  on the user's own consented data appears permitted, but that is a distinction
  requiring legal confidence.
- **Aggregators (Terra, Rook).** `[DOCUMENTED]` Priced for companies. Terra
  Quick Start about $399/mo, Rook Core $399/mo. No free tier.
- **Coros, Suunto, Wahoo.** Partner-gated. Wahoo carries workouts only, no
  sleep, HRV or resting HR.
- **Apple HealthKit.** Readable only on device. Requires a companion iOS app or
  a bridge, and HealthKit is unreadable while the phone is locked, so overnight
  sleep and HRV land only after an unlock.

Whoop is the notable alternative: fully self-serve OAuth, webhooks, 100 req/min
and 10,000/day, recovery objects carrying resting HR, HRV, SpO2 and skin
temperature, and no AI language in its API terms at all. Its weakness is
activities, which are strain sessions rather than GPS files.

### FIT files

`[DOCUMENTED]` FIT carries what no API returns: per-second GPS, HR, cadence,
power and temperature, running dynamics, lap structure, raw R-R intervals in the
`hrv` message, and third-party developer fields such as Stryd. Parse with
`fitdecode` (best maintained), `python-fitparse`, or `fitfast`.

Selection rule: collect FIT for **repeated** runs, not important ones.
Comparability comes from repetition, and the one evidence-backed objective
fatigue marker is a fixed benchmark effort. Designate two or three fixtures.

Store derived metrics only, never per-second streams:

- Quartile splits of moving time (pace, HR, cadence, GCT, vertical oscillation,
  power). This is the within-session decay curve, which is the ultra-specific
  measurement and is available nowhere else.
- Grade-band splits (below -8%, -8 to -3, -3 to +3, +3 to +8, above +8): time,
  pace, HR, cadence, GCT in each.
- GCT balance as a distribution, not a mean.
- Weighted eccentric descent dose.

About thirty numbers per file, joining cleanly to the activity row.

## What the market does, and does not do

Surveyed: TrainingPeaks, Runna, Athletica, Vert.run, Uphill Athlete, Final
Surge, intervals.icu, Humango, AI Endurance, Join, Stryd, TriDot, COROS Training
Hub, Garmin Coach.

**The workout shape is settled.** TrainingPeaks structured JSON, Zwift .zwo,
Garmin FIT `workout_step`, and the intervals.icu text DSL all reduce to
`workout -> step -> repeat-block(steps)`, and nothing nests deeper than one
repeat level. FIT encodes repeats as a step that jumps back rather than by
nesting. Adopting this shape means `planned_efforts` can later export to .zwo or
FIT and push structured workouts to a watch.

**Nobody models descent or technicality.** Runna's terrain field is a four-value
enum (Flat / Rolling / Moderate / Hilly) describing where the user *lives*, not
where they race, used as a workout-mix dial rather than a vert budget. Uphill
Athlete counts gain only, at +10 hrTSS per 1000 ft. Vert.run's Mountain Index
compares race vert density against weekly vert, still gain-only. Not one asks
about elevation loss or technical terrain.

**Race environment and training environment are usually conflated.** TriDot is
the exception, normalising prescribed paces against training conditions
(EnviroNorm) while modelling race-day conditions separately (RaceX). Runna's
single enum is why it cannot distinguish "I live in San Francisco and run hills"
from "my race has 2000 m of descent".

**Adaptation to a past gap is the universal failure.** The consistent complaint
across Runna and Garmin Coach reviews: plans that do not adjust for missed
workouts, no retroactive logging of illness days, no ability to backdate an
adjustment before the day it is made, 18-week plans that never change regardless
of feedback. TrainingPeaks does not adapt at all by design; rescheduling is a
human act.

**One public arbitration rule exists.** Uphill Athlete: progress load OR
vertical, never both in the same week. It is the only explicitly stated
endurance/strength arbitration rule the survey found.

**Runna has no dedicated ultra plan.** 50K goes through generic "run a specific
distance". Athletica and Humango regenerate the plan forward each week rather
than storing a fixed dated artifact.

## Open questions

1. OSTRC v2 item text and scoring need verification against Clarsen 2020 before
   the questions ship.
2. Whether this user's running power is Stryd or watch-native. If Stryd, the FIT
   developer fields carry Leg Spring Stiffness and Form Power, which are genuine
   stiffness and eccentric proxies.
3. Whether trail-versus-road can be derived reliably from grade variance or
   requires polyline matching against OSM trail data.
4. Whether intervals.icu-relayed Garmin data is compliant onward transfer at
   scale. Low risk for a single self-owned account, unresolved beyond that.
5. Ultra-specific intensity distribution has no RCT. Anything the engine does
   here is extrapolation and should be labelled as such to the user.
