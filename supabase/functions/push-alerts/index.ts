// Rest alerts while the app is closed.
//
// The rest timer survives the app closing; the ALERT did not. An installed
// iOS web app can receive Web Push through its service worker (16.4+), but
// nothing can schedule a LOCAL notification from a closed page, so something
// still running at the deadline has to SEND one. This function is that
// something: the app tells it "rest ends at T, for Barbell Row set 3" the
// moment a set is logged, it answers 202 at once, and then it waits until T in
// the background and pushes — unless the next set was logged first, in which
// case the app cancelled and nothing is sent.
//
// HOW IT WAITS, AND WHY THERE IS A CAP. `EdgeRuntime.waitUntil` keeps the
// worker alive after the response until the promise settles, and that is
// where the sleep happens. The platform caps how long a worker may live — the
// WALL CLOCK limit, 150 s on the Free plan and 400 s on paid plans (Supabase
// "Limits", and the "wall clock time limit reached" troubleshooting page: a
// worker over the limit is killed with a 546) — and the cap is per WORKER, not
// per request. Workers are reused, and a worker that has just slept through
// one rest is exactly the one the next LOG lands on. So `schedule` measures
// its own worker's age, and a `fire_at` that would not fit in what is left of
// the wall clock (minus a 10 s margin) is REFUSED with a 422 rather than
// accepted and silently never sent. The client treats a 422 as "no alert is
// coming" and says nothing, because the tone still plays if the app is open.
// PUSH_WALL_CLOCK_SECONDS is the plan's limit; unset, it assumes Free.
//
// SECURITY. The caller proves who they are with their Supabase session
// (verify_jwt is ON; resolveUser is the coach's). Everything else runs as the
// service role, scoped by that user id in every query. The VAPID private key
// is generated here on first use and lives only in push_config, a table with
// RLS on and NO policies, so no client can read it and no secret has to be
// pasted anywhere. Nothing in a log line is ever an endpoint or a key: an
// endpoint is a capability URL (whoever holds it can push to that phone), and
// the logs are readable by whoever runs the deployment.
import { createClient } from "@supabase/supabase-js";
import {
  buildPushRequest,
  generateVapidKeys,
  type VapidKeys,
} from "./lib/webpush.ts";

// Provided by the Supabase edge runtime; absent under plain `deno run`.
declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;

/** When this WORKER started. Module evaluation is worker birth, and the wall
 *  clock counts from there — not from this request. */
const WORKER_BORN = Date.now();

/**
 * The platform's wall-clock limit for one worker, in seconds. 150 on the Free
 * plan, 400 on paid plans; set PUSH_WALL_CLOCK_SECONDS=400 there or every rest
 * over about two minutes is refused for no reason.
 */
const WALL_CLOCK_SECONDS = (() => {
  const raw = Number(Deno.env.get("PUSH_WALL_CLOCK_SECONDS") ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 150;
})();
/** Left before the kill, once encryption and the push service round trip have
 *  had their turn. */
const SAFETY_MARGIN_SECONDS = 10;
/** A fire_at slightly in the past — clock skew, a slow request — still sends
 *  immediately; older than this is a rest that is already over. */
const LATE_GRACE_SECONDS = 5;
/** How long the push service may hold an undelivered alert. A rest alert a
 *  minute late is noise, not news. */
const TTL_SECONDS = 60;
/** RFC 8292 wants a contact URI in the token. The app's own origin is the one
 *  URL this repo already publishes; override it for another deployment. */
const VAPID_SUBJECT =
  Deno.env.get("PUSH_VAPID_SUBJECT")?.trim() ||
  "https://coltbradley.github.io/strength-tracker/";
/** Mirrors the CHECK on rest_alerts.label, so a bad label is a 400 here and
 *  never a 500 from Postgres. */
const LABEL_MAX = 120;
/** C0 and C1 controls plus the two Unicode line separators. Spelled as code
 *  points rather than a regex with backslash-u escapes: the Supabase MCP deploy path
 *  carries source as a JSON string and decoded those escapes into the raw
 *  control characters, which is an unterminated regex literal. */
function hasForbiddenChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x01 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      return true;
    }
  }
  return false;
}
const B64URL_87 = /^[A-Za-z0-9_-]{87}$/;
const B64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Db = ReturnType<typeof serviceClient>;

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

/** Who is calling, from their Supabase session. Identical to the coach's. */
async function resolveUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (!jwt) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

// ---- VAPID keys ---------------------------------------------------------------

/**
 * The deployment's key pair, generated on first use.
 *
 * Cached at module scope on purpose: this is a fact about the DEPLOYMENT, not
 * about a caller, so the rule against caching anything user-derived does not
 * apply — there is nothing here that could reach the wrong person. What is
 * cached is always what the TABLE holds: two workers generating at once both
 * try to insert row 1, one loses on the primary key, and both then re-read the
 * winner. A subscription is bound to the public key the browser was shown, so
 * two live pairs would mean pushes that some phones cannot verify.
 */
let vapidCache: VapidKeys | null = null;

async function readVapid(db: Db): Promise<VapidKeys | null> {
  const { data, error } = await db
    .from("push_config")
    .select("vapid_public_key, vapid_private_jwk")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`push_config read: ${error.message}`);
  if (!data) return null;
  return {
    publicKey: data.vapid_public_key as string,
    privateJwk: data.vapid_private_jwk as JsonWebKey,
  };
}

async function loadVapid(db: Db): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  let keys = await readVapid(db);
  if (!keys) {
    const fresh = await generateVapidKeys();
    const { error } = await db.from("push_config").insert({
      id: 1,
      vapid_public_key: fresh.publicKey,
      vapid_private_jwk: fresh.privateJwk,
    });
    // 23505: another worker generated first. Theirs is the pair every
    // subscription from now on is bound to, so read it back rather than
    // keeping ours.
    if (error && error.code !== "23505") {
      throw new Error(`push_config write: ${error.message}`);
    }
    if (!error) log("push_vapid_generated", {});
    keys = await readVapid(db);
    if (!keys) throw new Error("push_config: written but not readable");
  }
  vapidCache = keys;
  return keys;
}

// ---- routes -----------------------------------------------------------------

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function subscriptionShape(body: Record<string, unknown>): {
  endpoint: string;
  p256dh: string;
  auth: string;
} | null {
  const endpoint = body.endpoint;
  const keys = body.keys;
  if (typeof endpoint !== "string" || !isObject(keys)) return null;
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048) return null;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== "string" || !B64URL_87.test(p256dh)) return null;
  if (typeof auth !== "string" || !B64URL_22.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

/** Seconds of wall clock this worker has left, after the margin. */
function secondsLeft(): number {
  const age = (Date.now() - WORKER_BORN) / 1000;
  return WALL_CLOCK_SECONDS - age - SAFETY_MARGIN_SECONDS;
}

async function subscribe(req: Request, db: Db, userId: string): Promise<Response> {
  const body = await readBody(req);
  const sub = body ? subscriptionShape(body) : null;
  if (!sub) return json({ error: "That is not a push subscription." }, 400);
  // One row per endpoint. A device that subscribes again — after a reinstall,
  // or with a different person signed in — replaces its own row, and the row
  // follows the CURRENT user: an endpoint is one phone, and the phone's alerts
  // belong to whoever is logging on it.
  const { error } = await db.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      user_agent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
      revoked_at: null,
    },
    { onConflict: "endpoint" },
  );
  if (error) throw new Error(`subscribe: ${error.message}`);
  log("push_subscribed", { user_id: userId });
  return json({ ok: true });
}

async function unsubscribe(req: Request, db: Db, userId: string): Promise<Response> {
  const body = await readBody(req);
  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string") return json({ error: "Missing endpoint." }, 400);
  const { error } = await db
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("endpoint", endpoint)
    .is("revoked_at", null);
  if (error) throw new Error(`unsubscribe: ${error.message}`);
  // Off means off, for every kind: an alert already scheduled must not arrive
  // after the person turned the feature off.
  await cancelOpenAlerts(db, userId);
  log("push_unsubscribed", { user_id: userId });
  return json({ ok: true });
}

/**
 * Cancel this user's open alerts.
 *
 * `kind` omitted means EVERY kind, and the two callers want different things:
 * turning push off must silence everything, while arming one alert must
 * supersede only others of its own kind. One person can only be resting once,
 * which is where the supersede rule came from -- but a morning check-in prompt
 * armed for 07:00 must not cancel a rest timer armed for 06:58, and before
 * `kind` existed it silently would have.
 */
async function cancelOpenAlerts(
  db: Db,
  userId: string,
  kind?: string,
  except?: string,
): Promise<void> {
  let q = db
    .from("rest_alerts")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("sent_at", null)
    .is("cancelled_at", null);
  if (kind) q = q.eq("kind", kind);
  if (except) q = q.neq("id", except);
  const { error } = await q;
  if (error) throw new Error(`cancel open alerts: ${error.message}`);
}

// ---- long-dated alerts: arm now, deliver from a sweep ----------------------
//
// `schedule` below holds THIS worker open until the alert fires, which is right
// for a rest (two to five minutes) and structurally impossible for a prompt due
// at 07:30 tomorrow: the wall-clock cap refuses it, honestly, rather than
// promising something the platform will kill.
//
// So arming and delivering are split. `arm` writes the row and returns; `sweep`
// sends whatever is due. Nothing here knows or cares what calls the sweep --
// pg_cron through pg_net, a Supabase scheduled function, a GitHub Action, or a
// person with curl. That is the seam: the scheduler is a deployment decision
// and this file should not have an opinion about it.

const PROMPT_COPY: Record<string, { title: string; body: string }> = {
  daily_readiness: { title: "Morning check-in", body: "How are you today?" },
  ostrc_weekly: { title: "Weekly check", body: "Anything bothering you?" },
  next_morning_pain: {
    title: "How does it feel this morning?",
    body: "The morning after is the one that counts.",
  },
};

/** Kinds that may be armed. 'rest' is deliberately absent: it goes through
 *  `schedule`, which can hold a short wait and get the latency a rest needs. */
const ARMABLE = new Set(Object.keys(PROMPT_COPY));

async function arm(req: Request, db: Db, userId: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return json({ error: "Bad request body." }, 400);

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!ARMABLE.has(kind)) {
    return json(
      { error: `kind must be one of: ${[...ARMABLE].join(", ")}.` },
      400,
    );
  }
  const fireAt = typeof body.fire_at === "string" ? Date.parse(body.fire_at) : NaN;
  if (!Number.isFinite(fireAt)) {
    return json({ error: "fire_at must be an ISO timestamp." }, 400);
  }
  // A prompt more than a week out is a scheduling bug somewhere, not a plan.
  if (fireAt > Date.now() + 8 * 86_400_000) {
    return json({ error: "fire_at is too far ahead." }, 422);
  }
  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim()
      : PROMPT_COPY[kind].body;
  if (label.length > LABEL_MAX || hasForbiddenChar(label)) {
    return json({ error: `label must be one printable line of at most ${LABEL_MAX} characters.` }, 400);
  }

  const { data: inserted, error: insErr } = await db
    .from("rest_alerts")
    .insert({ user_id: userId, kind, fire_at: new Date(fireAt).toISOString(), label })
    .select("id")
    .single();
  if (insErr || !inserted) throw new Error(`arm: ${insErr?.message ?? "no row"}`);
  const alertId = inserted.id as string;

  // One live alert PER KIND: re-arming today's check-in replaces today's
  // check-in and leaves a rest timer and the weekly alone.
  await cancelOpenAlerts(db, userId, kind, alertId);

  log("alert_armed", { user_id: userId, alert_id: alertId, kind, fire_at: new Date(fireAt).toISOString() });
  // 202: accepted and stored. Whether it is DELIVERED depends on a sweep
  // running, which this endpoint cannot promise and does not pretend to.
  return json({ ok: true, alert_id: alertId, kind }, 202);
}

/**
 * Send one already-due alert. Shared by the sweep; `deliver` keeps its own
 * copy of this shape because it also owns the sleep and the cancel-race
 * re-read that only a held-open worker needs.
 */
async function sendAlertNow(
  db: Db,
  a: { id: string; user_id: string; kind: string; label: string; fire_at: string },
): Promise<"sent" | "no_subscription" | "failed"> {
  const base = { user_id: a.user_id, alert_id: a.id, kind: a.kind };
  const { data: subs, error: subErr } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", a.user_id)
    .is("revoked_at", null);
  if (subErr) throw new Error(`subscriptions: ${subErr.message}`);
  if (!subs || subs.length === 0) {
    await stamp(db, a.id, { error: "no active subscription at send time" });
    log("alert_failed", { ...base, reason: "no subscription" });
    return "no_subscription";
  }

  const copy = PROMPT_COPY[a.kind] ?? { title: "Reminder", body: a.label };
  const vapid = await loadVapid(db);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      kind: a.kind,
      title: copy.title,
      body: a.label || copy.body,
      alert_id: a.id,
      fire_at: a.fire_at,
      badge: 1,
    }),
  );

  const results = await Promise.all(
    (subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(
      async (sub) => {
        try {
          const push = await buildPushRequest({
            endpoint: sub.endpoint,
            subscription: { p256dh: sub.p256dh, auth: sub.auth },
            payload,
            vapid,
            subject: VAPID_SUBJECT,
            ttlSeconds: TTL_SECONDS,
            // Topic per KIND, so a phone that was offline for a day wakes to
            // one of each rather than a week of check-in reminders.
            topic: a.kind.slice(0, 32),
            // A prompt is not urgent the way a rest is; low urgency lets the
            // push service batch it and costs the phone less battery.
            urgency: "normal",
          });
          const res = await fetch(push.endpoint, {
            method: "POST",
            headers: push.headers,
            body: push.body,
            signal: AbortSignal.timeout(8000),
          });
          if (res.status === 404 || res.status === 410) {
            await db
              .from("push_subscriptions")
              .update({ revoked_at: new Date().toISOString() })
              .eq("id", sub.id);
          }
          return res.ok;
        } catch {
          return false;
        }
      },
    ),
  );
  const ok = results.some(Boolean);
  await stamp(db, a.id, ok ? {} : { error: "every endpoint failed" });
  log("alert_swept", { ...base, ok });
  return ok ? "sent" : "failed";
}

/**
 * Send everything due. Idempotent: `stamp` sets sent_at, and the query only
 * takes rows where it is null, so running the sweep twice sends nothing twice.
 *
 * Authenticated by a shared secret rather than a user session, because the
 * caller is a machine. Compared by digest so the check does not leak length
 * through timing, the same shape the MCP server's bearer check uses.
 */
async function sweep(req: Request, db: Db): Promise<Response> {
  const secret = Deno.env.get("SWEEP_SECRET") ?? "";
  if (secret.length === 0) {
    // Refusing is the honest answer: an unset secret must not mean an open
    // endpoint that anyone can use to drain somebody's alerts.
    return json({ error: "Sweep is not configured." }, 503);
  }
  const offered = req.headers.get("x-sweep-secret") ?? "";
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(offered)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  if (diff !== 0) return json({ error: "no" }, 401);

  // A grace window, not "everything ever": an alert whose moment passed hours
  // ago is stale, and asking about this morning at 3pm is worse than not
  // asking. Stale rows are stamped so they stop being considered.
  const now = Date.now();
  const graceMs = 6 * 3_600_000;
  const { data: due, error } = await db
    .from("rest_alerts")
    .select("id, user_id, kind, label, fire_at")
    .is("sent_at", null)
    .is("cancelled_at", null)
    .neq("kind", "rest")
    .lte("fire_at", new Date(now).toISOString())
    .order("fire_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`sweep: ${error.message}`);

  let sent = 0;
  let stale = 0;
  let failed = 0;
  for (const row of (due ?? []) as {
    id: string; user_id: string; kind: string; label: string; fire_at: string;
  }[]) {
    if (now - Date.parse(row.fire_at) > graceMs) {
      await stamp(db, row.id, { error: "stale; not sent" });
      stale += 1;
      continue;
    }
    const outcome = await sendAlertNow(db, row);
    if (outcome === "sent") sent += 1;
    else failed += 1;
  }
  log("sweep_done", { considered: due?.length ?? 0, sent, stale, failed });
  return json({ ok: true, considered: due?.length ?? 0, sent, stale, failed });
}

async function schedule(req: Request, db: Db, userId: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return json({ error: "Bad request body." }, 400);

  const fireAt = typeof body.fire_at === "string" ? Date.parse(body.fire_at) : NaN;
  if (!Number.isFinite(fireAt)) return json({ error: "fire_at must be an ISO timestamp." }, 400);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length === 0 || label.length > LABEL_MAX || hasForbiddenChar(label)) {
    return json({ error: `label must be one printable line of at most ${LABEL_MAX} characters.` }, 400);
  }

  const now = Date.now();
  const leadSeconds = (fireAt - now) / 1000;
  if (leadSeconds < -LATE_GRACE_SECONDS) {
    return json({ error: "That rest is already over.", max_lead_seconds: Math.floor(secondsLeft()) }, 422);
  }
  // The cap, and the reason for it, is at the top of this file. Refusing is
  // the honest answer: a 202 for an alert the platform will kill before it
  // fires is a promise nobody can keep.
  const left = secondsLeft();
  if (leadSeconds > left) {
    log("rest_alert_refused", {
      user_id: userId,
      lead_s: Math.round(leadSeconds),
      left_s: Math.round(left),
      wall_clock_s: WALL_CLOCK_SECONDS,
      worker_age_s: Math.round((now - WORKER_BORN) / 1000),
    });
    return json(
      {
        error: `This server can only hold an alert for about ${Math.max(0, Math.floor(left))} s right now; a ${Math.round(leadSeconds)} s rest is beyond that.`,
        max_lead_seconds: Math.max(0, Math.floor(left)),
      },
      422,
    );
  }

  // No device to send to is a 409, not a silent 202: the app only asks when it
  // believes this device is subscribed, so a mismatch is worth knowing about.
  const { data: subs, error: subErr } = await db
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .limit(1);
  if (subErr) throw new Error(`subscription check: ${subErr.message}`);
  if (!subs || subs.length === 0) {
    return json({ error: "No push subscription for this account." }, 409);
  }

  const { data: inserted, error: insErr } = await db
    .from("rest_alerts")
    .insert({ user_id: userId, fire_at: new Date(fireAt).toISOString(), label })
    .select("id")
    .single();
  if (insErr || !inserted) throw new Error(`schedule: ${insErr?.message ?? "no row"}`);
  const alertId = inserted.id as string;
  // One live REST alert per person. The app cancels its own on the next LOG,
  // but a reload or a second device cannot, and two buzzes for one rest is a
  // bug. Scoped to 'rest' so a queued check-in prompt survives it.
  await cancelOpenAlerts(db, userId, "rest", alertId);

  const work = deliver(db, { alertId, userId, fireAt, label, requestedAt: now });
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(work);
  } else {
    // Plain Deno (local serve without the edge runtime): nothing keeps the
    // process alive on our behalf, but nothing kills it either.
    void work;
  }
  log("rest_alert_scheduled", {
    user_id: userId,
    alert_id: alertId,
    lead_s: Math.round(leadSeconds),
    worker_age_s: Math.round((now - WORKER_BORN) / 1000),
  });
  return json({ alert_id: alertId, fire_at: new Date(fireAt).toISOString() }, 202);
}

async function cancel(req: Request, db: Db, userId: string): Promise<Response> {
  const body = await readBody(req);
  const alertId = body?.alert_id;
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) {
    return json({ error: "alert_id must be a uuid." }, 400);
  }
  const { data, error } = await db
    .from("rest_alerts")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error) throw new Error(`cancel: ${error.message}`);
  const cancelled = (data?.length ?? 0) > 0;
  log("rest_alert_cancelled", { user_id: userId, alert_id: alertId, cancelled });
  return json({ ok: true, cancelled });
}

// ---- the send -------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Wait for the deadline, re-check, send, stamp. Runs after the response.
 *
 * Every failure here is recorded on the row (`error`) and logged; none can
 * reach the caller, who was answered minutes ago. The one thing it must never
 * do is throw out of the background task and leave the row open: an open row
 * that never fires is indistinguishable, later, from one that was never
 * scheduled.
 */
async function deliver(
  db: Db,
  a: { alertId: string; userId: string; fireAt: number; label: string; requestedAt: number },
): Promise<void> {
  const base = { user_id: a.userId, alert_id: a.alertId };
  try {
    await sleep(a.fireAt - Date.now());

    // Re-read: the next set may have been logged while we slept.
    const { data: row, error: rowErr } = await db
      .from("rest_alerts")
      .select("cancelled_at, sent_at")
      .eq("id", a.alertId)
      .maybeSingle();
    if (rowErr) throw new Error(`re-read: ${rowErr.message}`);
    if (!row || row.cancelled_at || row.sent_at) {
      log("rest_alert_skipped", { ...base, reason: !row ? "gone" : row.cancelled_at ? "cancelled" : "already sent" });
      return;
    }

    const { data: subs, error: subErr } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", a.userId)
      .is("revoked_at", null);
    if (subErr) throw new Error(`subscriptions: ${subErr.message}`);
    if (!subs || subs.length === 0) {
      await stamp(db, a.alertId, { error: "no active subscription at send time" });
      log("rest_alert_failed", { ...base, reason: "no subscription" });
      return;
    }

    const vapid = await loadVapid(db);
    const payload = new TextEncoder().encode(
      JSON.stringify({
        kind: "rest",
        title: "Rest over",
        body: a.label,
        alert_id: a.alertId,
        fire_at: new Date(a.fireAt).toISOString(),
        // One thing is waiting: the set they are about to do.
        badge: 1,
      }),
    );

    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          const push = await buildPushRequest({
            endpoint: s.endpoint as string,
            subscription: { p256dh: s.p256dh as string, auth: s.auth as string },
            payload,
            vapid,
            subject: VAPID_SUBJECT,
            ttlSeconds: TTL_SECONDS,
            // A newer rest alert replaces an older undelivered one at the
            // push service, so a phone that was offline gets one buzz, not a
            // backlog.
            topic: "rest",
            urgency: "high",
          });
          const res = await fetch(push.endpoint, {
            method: "POST",
            headers: push.headers,
            body: push.body,
            signal: AbortSignal.timeout(8000),
          });
          // The push service says this endpoint is gone (the person removed
          // the app, or the browser rotated the subscription). Stop trying it.
          if (res.status === 404 || res.status === 410) {
            const { error } = await db
              .from("push_subscriptions")
              .update({ revoked_at: new Date().toISOString() })
              .eq("id", s.id as string);
            if (error) logError("push_revoke_failed", { ...base, error: error.message });
          }
          return { status: res.status, ok: res.ok };
        } catch (e) {
          return { status: 0, ok: false, error: message(e) };
        }
      }),
    );

    const anyOk = results.some((r) => r.ok);
    const summary = results
      .map((r) => (r.ok ? `ok ${r.status}` : `fail ${r.status}${r.error ? ` ${r.error}` : ""}`))
      .join("; ")
      .slice(0, 500);
    await stamp(
      db,
      a.alertId,
      anyOk ? { sent_at: new Date().toISOString() } : { error: summary },
    );
    log(anyOk ? "rest_alert_sent" : "rest_alert_failed", {
      ...base,
      devices: results.length,
      statuses: results.map((r) => r.status),
      late_ms: Date.now() - a.fireAt,
      held_ms: Date.now() - a.requestedAt,
    });
  } catch (e) {
    logError("rest_alert_error", { ...base, error: message(e) });
    try {
      await stamp(db, a.alertId, { error: message(e).slice(0, 500) });
    } catch (e2) {
      logError("rest_alert_stamp_failed", { ...base, error: message(e2) });
    }
  }
}

async function stamp(
  db: Db,
  alertId: string,
  patch: { sent_at?: string; error?: string },
): Promise<void> {
  const { error } = await db.from("rest_alerts").update(patch).eq("id", alertId);
  if (error) throw new Error(`stamp: ${error.message}`);
}

// ---- entry ----------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Routed by the LAST path segment, so the same code answers whether the
  // gateway hands us /push-alerts/schedule or /functions/v1/push-alerts/schedule.
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const route = path.slice(path.lastIndexOf("/") + 1);

  // The sweep is answered BEFORE the session check, because its caller is a
  // machine with a shared secret and no Supabase session to offer. It is the
  // only route on this function that is not acting for a signed-in person, and
  // it authenticates itself (see sweep()).
  if (req.method === "POST" && route === "sweep") {
    try {
      return await sweep(req, serviceClient());
    } catch (e) {
      logError("sweep_failed", { error: message(e) });
      return json({ error: "Sweep failed." }, 500);
    }
  }

  const userId = await resolveUser(req);
  if (!userId) return json({ error: "Sign in to use rest alerts." }, 401);

  const db = serviceClient();
  try {
    switch (`${req.method} ${route}`) {
      case "GET vapid-public-key": {
        const keys = await loadVapid(db);
        return json({
          public_key: keys.publicKey,
          // What the client may ask for right now. Informational: the cap is
          // enforced on schedule, and a different worker may answer that call.
          max_lead_seconds: Math.max(0, Math.floor(secondsLeft())),
          wall_clock_seconds: WALL_CLOCK_SECONDS,
        });
      }
      case "POST subscribe":
        return await subscribe(req, db, userId);
      case "POST unsubscribe":
        return await unsubscribe(req, db, userId);
      case "POST arm":
        return await arm(req, db, userId);
      case "POST schedule":
        return await schedule(req, db, userId);
      case "POST cancel":
        return await cancel(req, db, userId);
      default:
        return json({ error: "No such route." }, 404);
    }
  } catch (e) {
    logError("push_alerts_failed", { route, method: req.method, user_id: userId, error: message(e) });
    return json({ error: "Rest alerts are unavailable right now." }, 500);
  }
});
