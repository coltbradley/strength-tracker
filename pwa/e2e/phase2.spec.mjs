import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loadLocalConfig } from "./local-config.mjs";
import { cleanupUsers } from "./lifecycle-utils.mjs";

const local = await loadLocalConfig();
let userA;
let userB;

async function authenticatedRequest(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ supabaseUrl, anonKey, path, method, body }) => {
    const values = Object.keys(localStorage).map((key) => {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    });
    const accessToken = values.find((value) => typeof value?.access_token === "string")?.access_token;
    if (!accessToken) throw new Error("Authenticated browser session was not found");
    const response = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "POST" ? { prefer: "return=representation" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { status: response.status, payload };
  }, { supabaseUrl: local.supabaseUrl, anonKey: local.anonKey, path, method, body });
}

function adminHeaders(extra = {}) {
  return {
    apikey: local.serviceRoleKey,
    authorization: `Bearer ${local.serviceRoleKey}`,
    ...extra,
  };
}

async function adminRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${local.supabaseUrl}${path}`, {
    method,
    headers: adminHeaders(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`Local Supabase ${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function rows(page, table, query) {
  const result = await authenticatedRequest(page, `/rest/v1/${table}?${query}`);
  if (result.status !== 200) throw new Error(`Authenticated read of ${table} returned ${result.status}`);
  return result.payload;
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function createUser(label, runId) {
  const email = `phase2-${label}-${runId}@example.com`;
  const password = `${randomUUID()}-LocalOnly9!`;
  const user = await adminRequest("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password, email_confirm: true },
  });
  return { id: user.id, email, password };
}

async function signIn(page, user) {
  const tokenResponse = await fetch(`${local.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: local.anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Local Auth password sign-in returned ${tokenResponse.status}`);
  }
  const session = await tokenResponse.json();
  session.expires_at = Math.floor(Date.now() / 1000) + session.expires_in;
  const projectRef = new URL(local.supabaseUrl).hostname.split(".")[0];
  await page.goto("/");
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await page.addInitScript(({ key, savedSession }) => {
    localStorage.setItem(key, JSON.stringify(savedSession));
  }, { key: `sb-${projectRef}-auth-token`, savedSession: session });
  await page.reload();
  await expect(page.getByRole("button", { name: "settings" })).toBeVisible();
}

async function deleteUser(id) {
  await adminRequest(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
}

test.describe("Phase 2 local seeded browser lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  const runId = randomUUID();

  test.beforeAll(async () => {
    userA = await createUser("owner", runId);
    userB = await createUser("friend", runId);
  });

  test.afterAll(async () => {
    await cleanupUsers([userB, userA].filter(Boolean), (user) => deleteUser(user.id));
  });

  test("creates a confirmed plan, resumes, logs offline, corrects, finishes, and enforces tenant RLS", async ({ page, context, browser }) => {
    await signIn(page, userA);

    await page.getByRole("button", { name: "Plan a workout" }).click();
    await expect(page).toHaveURL(/\/plan\/[0-9a-f-]+$/i);
    const plannedWorkoutId = new URL(page.url()).pathname.split("/").at(-1);

    await page.getByRole("button", { name: "Add exercise" }).click();
    await page.getByRole("searchbox", { name: "search exercises" }).fill("bench press");
    const exercise = page.locator(".search-results button").filter({ hasText: /bench press/i }).first();
    await expect(exercise).toBeVisible();
    const exerciseName = (await exercise.locator(".drawer-name").innerText()).trim();
    await exercise.click();
    const addSets = page.getByRole("button", { name: /^Add \d+ sets?$/ });
    await expect(addSets).toBeVisible();
    await addSets.click();
    await page.getByRole("button", { name: "Done planning" }).click();

    const planRows = await waitFor(async () => {
      const result = await rows(page, "planned_workouts", `select=id,program_id&user_id=eq.${userA.id}&id=eq.${plannedWorkoutId}`);
      return result.length ? result : null;
    }, "the new planned day");
    const programs = await rows(page, "programs", `select=id,confirmed_at&user_id=eq.${userA.id}&id=eq.${planRows[0].program_id}`);
    expect(programs).toHaveLength(1);
    expect(programs[0].confirmed_at).not.toBeNull();
    const prescriptions = await rows(page, "prescriptions", `select=id,exercise_id,sets,reps_min,reps_max,load_kg&user_id=eq.${userA.id}&planned_workout_id=eq.${plannedWorkoutId}&order=position.asc`);
    expect(prescriptions).toHaveLength(1);
    expect(prescriptions[0].exercise_id).toBeTruthy();
    expect(prescriptions[0].sets).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Start session" }).click();
    const openSessionRows = await waitFor(async () => {
      const result = await rows(page, "sessions", `select=id,planned_workout_id,ended_at,discarded_at&user_id=eq.${userA.id}&ended_at=is.null&order=started_at.desc&limit=1`);
      return result[0] ? result : null;
    }, "the started session");
    const session = openSessionRows[0];
    expect(session.planned_workout_id).toBe(plannedWorkoutId);

    await page.goto("/");
    await page.getByRole("link", { name: "Resume" }).click();
    await expect(page.getByRole("heading", { name: exerciseName })).toBeVisible();

    await context.setOffline(true);
    await page.getByRole("button", { name: /^LOG SET(?:\s|$)/i }).click();
    await expect(page.locator(".focus-progress-rail")).toBeVisible();
    const queued = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("strength-log", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const items = await new Promise((resolve, reject) => {
        const request = database.transaction("outbox", "readonly").objectStore("outbox").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return items.filter((item) => item.op?.kind === "insert" && item.op.table === "sets");
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].user_id).toBe(userA.id);
    await page.getByRole("button", { name: `more options for ${exerciseName}` }).click();
    await expect(page.locator(".logged-set-wrap")).toHaveCount(1);
    await page.getByRole("button", { name: "Close" }).click();

    await context.setOffline(false);
    let sessionSets = await waitFor(async () => {
      const result = await rows(page, "sets", `select=id,user_id,session_id,prescription_id,set_index,load_kg,reps,performed_at&session_id=eq.${session.id}&order=created_at.asc`);
      return result.length ? result : null;
    }, "the offline set to sync");
    expect(sessionSets).toHaveLength(1);
    const originalSet = sessionSets[0];

    await page.getByRole("button", { name: `more options for ${exerciseName}` }).click();
    await page.getByRole("button", { name: "Correct logged set 1" }).click();
    await page.getByRole("button", { name: /increase load by/i }).click();
    await page.getByRole("button", { name: /^SAVE SET 1$/i }).click();
    sessionSets = await waitFor(async () => {
      const result = await rows(page, "sets", `select=id,user_id,session_id,prescription_id,set_index,load_kg,reps,performed_at&session_id=eq.${session.id}&order=created_at.asc`);
      return result.length >= 2 ? result : null;
    }, "the corrected set to sync");
    const correctedSet = sessionSets.find((set) => set.id !== originalSet.id && set.set_index === originalSet.set_index);
    expect(correctedSet).toBeTruthy();
    expect(correctedSet.load_kg).not.toBe(originalSet.load_kg);
    expect(correctedSet.performed_at).toBe(originalSet.performed_at);
    expect(correctedSet.prescription_id).toBe(originalSet.prescription_id);
    expect(correctedSet.prescription_id).toBe(prescriptions[0].id);

    for (let index = 0; index < 2; index += 1) {
      await page.getByRole("button", { name: /^LOG SET(?:\s|$)/i }).click();
    }
    await page.getByRole("button", { name: /^FINISH$/i }).click();
    await expect(page.getByRole("heading", { name: "End session" })).toBeVisible();
    await page.getByRole("button", { name: "End session" }).click();

    const finalSession = await waitFor(async () => {
      const result = await rows(page, "sessions", `select=id,ended_at,discarded_at,user_id,planned_workout_id&user_id=eq.${userA.id}&id=eq.${session.id}`);
      return result[0]?.ended_at ? result[0] : null;
    }, "the ended session to sync");
    expect(finalSession.discarded_at).toBeNull();
    expect(finalSession.planned_workout_id).toBe(plannedWorkoutId);

    sessionSets = await rows(page, "sets", `select=id,user_id,session_id,set_index,load_kg,reps&session_id=eq.${session.id}&order=created_at.asc`);
    const voids = await rows(page, "set_voids", `select=set_id,user_id&user_id=eq.${userA.id}&set_id=in.(${sessionSets.map((set) => set.id).join(",")})`);
    expect(sessionSets).toHaveLength(4);
    expect(voids).toHaveLength(1);
    expect(voids[0].user_id).toBe(userA.id);
    expect(sessionSets.every((set) => set.user_id === userA.id && set.session_id === session.id)).toBe(true);
    const liveSets = sessionSets.filter((set) => !voids.some((voidRow) => voidRow.set_id === set.id));
    expect(liveSets.map((set) => set.set_index).sort((a, b) => a - b)).toEqual([0, 1, 2]);

    const friendContext = await browser.newContext();
    try {
      const friendPage = await friendContext.newPage();
      await signIn(friendPage, userB);
      const readAsB = await rows(friendPage, "sets", `select=id&session_id=eq.${session.id}`);
      const planReadAsB = await rows(friendPage, "planned_workouts", `select=id&id=eq.${plannedWorkoutId}`);
      const sessionReadAsB = await rows(friendPage, "sessions", `select=id&id=eq.${session.id}`);
      const foreignSetId = randomUUID();
      const appendAsB = await authenticatedRequest(friendPage, "/rest/v1/sets", {
        method: "POST",
        body: {
          id: foreignSetId,
          session_id: session.id,
          exercise_id: prescriptions[0].exercise_id,
          prescription_id: prescriptions[0].id,
          set_index: 99,
          set_type: "working",
          load_kg: 1,
          reps: 1,
          performed_at: originalSet.performed_at,
        },
      });
      const rlsSetId = randomUUID();
      const appendWithForeignOwner = await authenticatedRequest(friendPage, "/rest/v1/sets", {
        method: "POST",
        body: {
          id: rlsSetId,
          user_id: userA.id,
          session_id: session.id,
          exercise_id: prescriptions[0].exercise_id,
          prescription_id: prescriptions[0].id,
          set_index: 100,
          set_type: "working",
          load_kg: 1,
          reps: 1,
          performed_at: originalSet.performed_at,
        },
      });
      const writeAsB = await authenticatedRequest(friendPage, "/rest/v1/set_voids", {
        method: "POST",
        body: { set_id: liveSets[0].id },
      });
      expect(readAsB).toEqual([]);
      expect(planReadAsB).toEqual([]);
      expect(sessionReadAsB).toEqual([]);
      expect(appendAsB.status).toBe(409);
      expect(appendAsB.payload?.code).toBe("23503");
      expect(appendWithForeignOwner.status).toBe(403);
      expect(writeAsB.status).toBe(403);
      expect(await rows(friendPage, "sets", `select=id&session_id=eq.${session.id}&id=eq.${foreignSetId}`)).toEqual([]);
      expect(await rows(friendPage, "sets", `select=id&session_id=eq.${session.id}&id=eq.${rlsSetId}`)).toEqual([]);
      expect(await rows(friendPage, "set_voids", `select=set_id&set_id=eq.${liveSets[0].id}`)).toEqual([]);
    } finally {
      await friendContext.close();
    }

    const finalVoids = await rows(page, "set_voids", `select=set_id,user_id&set_id=eq.${liveSets[0].id}`);
    expect(finalVoids).toHaveLength(0);
  });
});
