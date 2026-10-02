export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What to record for a turn that threw (EDGE-8). `usage` only arrives with
 * finalMessage(), so a stream that dies mid-generation left zero tokens, and a
 * non-null `refused` kept the row out of the daily count: Anthropic billed the
 * partial answer and neither cap saw it. When generation had begun and no real
 * usage exists, estimate (about 4 characters a token) and leave `refused` null
 * so the turn counts. A failure before anything streamed was not billed and
 * stays a refusal. Real usage is never overwritten.
 */
export function failedTurnAccounting(a: {
  failed: string | null;
  generationBegan: boolean;
  usage: TurnUsage;
  answerChars: number;
  promptChars: number;
}): { usage: TurnUsage; refused: string | null; stop: string | null } {
  if (a.failed === null) return { usage: a.usage, refused: null, stop: null };
  if (!a.generationBegan) {
    return { usage: a.usage, refused: a.failed, stop: null };
  }
  const hasReal = a.usage.input > 0 || a.usage.output > 0;
  return {
    usage: hasReal
      ? a.usage
      : {
          ...a.usage,
          input: Math.ceil(a.promptChars / 4),
          output: Math.ceil(a.answerChars / 4),
        },
    refused: null,
    stop: `error: ${a.failed}`.slice(0, 200),
  };
}

/**
 * Write the audit row for a request refused by an already-enforced quota.
 *
 * Supabase returns PostgREST failures in `error` instead of throwing them. The
 * response must remain a 429 even if telemetry is unavailable, so the helper
 * reports either failure shape and never rethrows into the request handler.
 */
export async function recordRefusalUsage(
  write: () => PromiseLike<{ error: { message: string } | null }>,
  reportFailure: (message: string) => Promise<void>,
): Promise<void> {
  let failure: string | null = null;

  try {
    const { error } = await write();
    failure = error?.message ?? null;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failure === null) return;

  try {
    await reportFailure(failure);
  } catch {
    // A failed alarm must not change an already-correct quota refusal.
  }
}
