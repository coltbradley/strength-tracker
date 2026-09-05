// Error handling for tool handlers. ToolError carries a message that is safe
// to show the caller (validation failures, missing rows). Anything else is
// logged in full server-side and returned as a generic message + request id.

// Extensionless on purpose: type-only import (erased at runtime), and the
// extensionless path is the one whose types resolve under Deno.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { log } from "./log.ts";
import { captureError } from "./sentry.ts";

/** Expected, user-facing tool failure. The message goes to the client verbatim. */
export class ToolError extends Error {}

/** Per-request state shared between index.ts and the tool guard. */
export interface RequestContext {
  requestId: string;
  /** Set by guard() when a tool call fails; index.ts logs it as the outcome. */
  toolError?: string;
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Success result: data pretty-printed as JSON in a text block, optionally
 * preceded by extra text blocks (e.g. the upsert_program markdown table).
 */
export function jsonResult(
  data: unknown,
  ...preamble: string[]
): CallToolResult {
  return {
    content: [
      ...preamble.map((text) => ({ type: "text" as const, text })),
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

/**
 * Wrap a tool handler body. ToolError -> its message as an MCP tool error.
 * Anything else -> full detail logged, generic message + request id returned.
 */
export async function guard(
  ctx: RequestContext,
  tool: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) {
      ctx.toolError = err.message;
      return errorResult(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.toolError = message;
    log("error", "tool_unexpected_error", {
      request_id: ctx.requestId,
      tool,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Reported as well as logged. This branch, not handleRequest's catch, is
    // where nearly everything that goes wrong in this server ends up: MCP
    // returns a tool failure as a successful HTTP response carrying an error
    // result, so a tool that throws never reaches the top-level handler. The
    // ToolError branch above deliberately does not report — a validation
    // message is the system working. Only the arguments-free facts go up; a
    // tool's arguments are the caller's training data.
    await captureError(err, { request_id: ctx.requestId, tool });
    return errorResult(
      `Unexpected server error. Reference request_id ${ctx.requestId} in the function logs.`,
    );
  }
}
