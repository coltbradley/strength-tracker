// WHEN to ask, decided separately from HOW to deliver.
//
// This module is pure: it takes the clock, the person's preferences and what is
// already known, and returns what is due. It touches no network, no database
// and no push API. That separation is the point -- the delivery half needs a
// scheduler nobody has set up yet (see docs/deploy.md), and this half can be
// finished, tested and trusted before that exists. When a scheduler arrives it
// calls this and arms what comes back; if one never arrives, the app can call
// it on foreground and ask in-app instead. Neither path changes these rules.
//
// Everything is computed in LOCAL time from the device clock, which is the same
// decision useLocalToday makes and for the same reason: the phone travels with
// the lifter, and a 7am prompt means 7am where they are.

export type PromptKind =
  | "daily_readiness"
  | "ostrc_weekly"
  | "next_morning_pain";

export interface PromptPrefs {
  dailyEnabled: boolean;
  /** "HH:MM", local. */
  dailyAt: string;
  weeklyEnabled: boolean;
  /** 0 = Sunday. The OSTRC recall period is seven days, so this is the day it
   *  closes on. */
  weeklyWeekday: number;
  weeklyAt: string;
  nextMorningEnabled: boolean;
  nextMorningAt: string;
}

export const DEFAULT_PROMPT_PREFS: PromptPrefs = {
  dailyEnabled: true,
  dailyAt: "07:30",
  weeklyEnabled: true,
  weeklyWeekday: 0,
  weeklyAt: "18:00",
  nextMorningEnabled: true,
  nextMorningAt: "08:00",
};

export interface PromptState {
  /** Local date of the most recently answered daily panel, or null. */
  lastReadinessDate: string | null;
  /** recall_end of the most recent OSTRC response, or null. */
  lastOstrcRecallEnd: string | null;
  /** Local date of the last day a session or activity happened, or null. */
  lastTrainedDate: string | null;
  /** Whether anything is currently being monitored. */
  hasOpenEpisode: boolean;
}

export interface DuePrompt {
  kind: PromptKind;
  /** When it should fire, as an instant. */
  fireAt: Date;
  /** True when the moment has already passed and it is still unanswered. */
  overdue: boolean;
}

/** Local ISO date (YYYY-MM-DD) for a Date, using its local components. */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A Date at "HH:MM" local on the same calendar day as `on`. */
export function atLocalTime(on: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(on);
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86_400_000,
  );
}

/**
 * What should be asked, and when.
 *
 * Returns at most one entry per kind. An entry whose `fireAt` is in the past is
 * marked `overdue`: the moment has gone and the answer has not, which is a
 * different thing from a prompt scheduled for later today and the caller should
 * be able to tell them apart.
 */
export function duePrompts(
  now: Date,
  prefs: PromptPrefs,
  state: PromptState,
): DuePrompt[] {
  const out: DuePrompt[] = [];
  const today = localDate(now);

  // Daily panel. Due at the configured time on any day it has not been
  // answered; once the time has passed and it is still unanswered it stays
  // due rather than rolling to tomorrow, because the answer is still worth
  // having and a missed morning is exactly the gap this is trying to close.
  if (prefs.dailyEnabled) {
    const answeredToday = state.lastReadinessDate === today;
    if (!answeredToday) {
      const at = atLocalTime(now, prefs.dailyAt);
      out.push({
        kind: "daily_readiness",
        fireAt: at,
        overdue: at.getTime() <= now.getTime(),
      });
    } else {
      out.push({
        kind: "daily_readiness",
        fireAt: atLocalTime(addDays(now, 1), prefs.dailyAt),
        overdue: false,
      });
    }
  }

  // The OSTRC, weekly and only weekly. Its recall period IS the measurement --
  // seven days -- so prompting more often is off-label and prompting less often
  // asks somebody to remember further back than the instrument was validated
  // for. Asked whether or not anything currently hurts, because it is
  // SURVEILLANCE: an instrument that only appears once you already have a
  // problem cannot tell you when the problem started.
  if (prefs.weeklyEnabled) {
    const last = state.lastOstrcRecallEnd;
    const dueNow = last === null || daysBetween(last, today) >= 7;
    // The next occurrence of the configured weekday, today included.
    const ahead = (prefs.weeklyWeekday - now.getDay() + 7) % 7;
    const nextDay = addDays(now, ahead);
    const at = atLocalTime(nextDay, prefs.weeklyAt);
    if (dueNow && ahead === 0) {
      out.push({
        kind: "ostrc_weekly",
        fireAt: at,
        overdue: at.getTime() <= now.getTime(),
      });
    } else {
      out.push({
        kind: "ostrc_weekly",
        fireAt: ahead === 0 ? atLocalTime(addDays(now, 7), prefs.weeklyAt) : at,
        overdue: false,
      });
    }
  }

  // The morning after. This is the criterion doing the real work in both
  // published pain-monitoring models, and it is a 24-hour DELAYED signal, so it
  // cannot be collected at the end of the session.
  //
  // Gated on there being something to monitor. Asking every single morning
  // after every session, of somebody with nothing wrong, is how a prompt
  // becomes noise and then becomes ignored -- and the adherence it would burn
  // is the load-bearing assumption of the whole injury half.
  if (
    prefs.nextMorningEnabled &&
    state.hasOpenEpisode &&
    state.lastTrainedDate !== null
  ) {
    const morningAfter = atLocalTime(
      new Date(`${state.lastTrainedDate}T12:00:00`),
      prefs.nextMorningAt,
    );
    morningAfter.setDate(morningAfter.getDate() + 1);
    // Only while it is still that morning; a stale one is not worth asking.
    const staleAfter = morningAfter.getTime() + 12 * 3_600_000;
    if (now.getTime() <= staleAfter) {
      out.push({
        kind: "next_morning_pain",
        fireAt: morningAfter,
        overdue: morningAfter.getTime() <= now.getTime(),
      });
    }
  }

  return out;
}

/** Just the ones whose moment has passed and which are still unanswered. */
export function overduePrompts(
  now: Date,
  prefs: PromptPrefs,
  state: PromptState,
): DuePrompt[] {
  return duePrompts(now, prefs, state).filter((p) => p.overdue);
}
