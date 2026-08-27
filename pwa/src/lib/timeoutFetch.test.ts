import { describe, expect, it, vi } from "vitest";
import { createTimeoutFetch, REQUEST_TIMEOUT_MS } from "./timeoutFetch";

/** A connection that associates but never routes. Like the real `fetch`, it
 *  settles only when its signal aborts. */
const never: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

describe("createTimeoutFetch", () => {
  it("aborts a request that never answers", async () => {
    // the gym-wifi case: associated but not routing. Without this the read
    // sits on 'Loading…' with the answer already in IndexedDB.
    const f = createTimeoutFetch(10, never);
    await expect(f("https://example.test")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("aborts with a DOMException, which PostgREST turns into a plain error", async () => {
    // PostgrestBuilder catches a rejected fetch and returns
    // { error, status: 0, code: '' } — so data.ts's throwIf throws and
    // fetchWithCache falls back to the cache, and the outbox classifies it
    // as retryable rather than dead-lettering the write
    const f = createTimeoutFetch(10, never);
    const err = await f("https://example.test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
  });

  it("leaves a fast request untouched", async () => {
    const res = new Response("ok");
    const impl = vi.fn(async () => res);
    const f = createTimeoutFetch(1000, impl as unknown as typeof fetch);
    await expect(f("https://example.test")).resolves.toBe(res);
    expect(impl).toHaveBeenCalledOnce();
  });

  it("still honours a caller's own abort signal", async () => {
    const controller = new AbortController();
    const f = createTimeoutFetch(60_000, (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted downstream")),
        );
      });
    });
    const p = f("https://example.test", { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow("aborted downstream");
  });

  it("keeps a budget generous enough for a slow-but-working request", () => {
    // the largest read is the ~80 kB exercise library; a tighter budget would
    // start aborting requests that were going to succeed
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });
});
