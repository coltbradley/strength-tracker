// Long `.in()` lists become long GET URLs, and the gateway refuses a request
// line past a few KB (resolve_exercises.ts documents the 500-name case). 36-char
// UUIDs at ~100 per request is ~3.8 KB, comfortably under it.

export const IN_CHUNK = 100;

export function chunk<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run one query per chunk of `ids` and concatenate the rows. The caller owns
 * anything that spans chunks: an `order`/`limit` applies per request, so a
 * caller that needs a global order or cap re-sorts and slices the result.
 * Errors throw like `must`, with `what` in the message.
 */
export async function inChunks<T>(
  ids: readonly string[],
  what: string,
  run: (
    ids: string[],
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  size = IN_CHUNK,
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk(ids, size)) {
    const res = await run(part);
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    rows.push(...((res.data ?? []) as T[]));
  }
  return rows;
}

/** PostgREST's default max-rows. A read past it is cut off with no error. */
export const PAGE = 1000;

/**
 * `inChunks` that also pages inside each chunk with `.range()`, for reads that
 * can exceed PostgREST's row cap (a long program's prescriptions). `build`
 * must order its query by something stable so pages do not overlap.
 */
export async function inChunksPaged<T>(
  ids: readonly string[],
  what: string,
  build: (
    ids: string[],
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  size = IN_CHUNK,
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk(ids, size)) {
    for (let from = 0;; from += PAGE) {
      const res = await build(part, from, from + PAGE - 1);
      if (res.error) throw new Error(`${what}: ${res.error.message}`);
      const page = (res.data ?? []) as T[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return rows;
}
