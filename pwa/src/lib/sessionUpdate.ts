import type { TransportError } from "./outbox";

/** What one guarded update did. `rows` is how many the server changed. */
export interface GuardedUpdate {
  error: { message: string; code?: string | null } | null;
  status: number | null;
  rows: number;
}

interface FilterBuilder {
  eq(column: string, value: string): FilterBuilder;
  is(column: string, value: null): FilterBuilder;
  select(columns: string): PromiseLike<{
    data: { id: string }[] | null;
    error: { message: string; code?: string | null } | null;
    status?: number | null;
  }>;
}

interface UpdateClient {
  from(table: string): {
    update(patch: Record<string, unknown>): FilterBuilder;
  };
}

/**
 * Apply an outbox update and count the rows it changed.
 *
 * A finish matches a session that is still open, so a discarded row never
 * gains `ended_at`. An open-session discard (`onlyIfOpen`) has the same
 * requirement, so a completed session never gains `discarded_at`. History's
 * discard of a finished session matches `discarded_at is null` only.
 * Rating a finished session is a different patch and does not use that guard.
 */
export async function guardedUpdate(
  client: UpdateClient,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  options?: { onlyIfOpen?: boolean },
): Promise<GuardedUpdate> {
  let query = client.from(table).update(patch).eq("id", id);
  if (table === "sessions") {
    const finishing = Object.prototype.hasOwnProperty.call(patch, "ended_at");
    const discarding = Object.prototype.hasOwnProperty.call(
      patch,
      "discarded_at",
    );
    // A finish never lands on a session that already ended or was discarded.
    // An open-session discard has the same requirement. History's discard of
    // a finished session only refuses a row that is already discarded.
    if (finishing || (discarding && options?.onlyIfOpen)) {
      query = query.is("ended_at", null).is("discarded_at", null);
    } else if (discarding) {
      query = query.is("discarded_at", null);
    }
  }
  const { data, error, status } = await query.select("id");
  return {
    error,
    status: status ?? null,
    rows: data?.length ?? 0,
  };
}

/**
 * The queue's view of that result. Zero rows is a refusal, not a success:
 * deleting the item would forget a close that never landed.
 */
export function outboxUpdateResult(result: GuardedUpdate): TransportError | null {
  if (result.error) {
    const code = result.error.code;
    return {
      message: result.error.message,
      code: typeof code === "string" && code.length > 0 ? code : null,
      status: result.status,
    };
  }
  if (result.rows === 0) {
    return {
      message: "update matched no rows",
      code: null,
      status: 409,
    };
  }
  return null;
}
