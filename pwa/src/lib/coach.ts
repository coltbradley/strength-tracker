// Client for the coach edge function.
//
// The browser never holds an Anthropic key or an MCP token: it sends the
// user's Supabase session and the function does everything else. The response
// is server-sent events, so answers appear as they are written rather than
// after a ten-second silence.

import { supabase } from "./supabase";
import { getUnit } from "./settings";
import { buildCoachContext } from "./coachContext";
import { reportError } from "./errors";

export interface CoachAttachment {
  kind: "image" | "pdf" | "text";
  media_type: string;
  name: string;
  /** base64 for image/pdf, plain text for text */
  data: string;
}

export interface CoachTurn {
  role: "user" | "assistant";
  text: string;
  attachments?: CoachAttachment[];
}

export interface CoachEvents {
  onText: (chunk: string) => void;
  /** a tool round trip started, so the UI can say what it is doing */
  onTool: (name: string) => void;
  /** adaptive thinking is running; nothing is written yet */
  onThinking: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}

function endpoint(): string {
  const base = import.meta.env.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/coach`;
}

export function coachConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL);
}

/**
 * Ask the coach. Resolves when the answer is complete.
 *
 * `signal` aborts a turn in flight — the person put the phone down, or started
 * their next set. The server bills what it generated either way, which is why
 * the UI keeps whatever text arrived rather than throwing it away.
 */
export async function askCoach(
  turns: CoachTurn[],
  events: CoachEvents,
  signal?: AbortSignal,
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    events.onError("Sign in again to use the coach.");
    return;
  }

  // What the app already knows, attached to the LATEST turn only. It goes
  // stale the moment another set is logged — which is exactly when they ask —
  // so it is rebuilt per turn rather than pinned to the top of the thread.
  // Prepended to the newest message keeps it after the cache breakpoint.
  let withContext = turns;
  try {
    const ctx = await buildCoachContext();
    withContext = turns.map((t, i) =>
      i === turns.length - 1 && t.role === "user"
        ? { ...t, text: `<current_context>\n${ctx}\n</current_context>\n\n${t.text}` }
        : t,
    );
  } catch (e) {
    // Answering with less context beats not answering.
    reportError(e, "coach context");
  }

  let res: Response;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ turns: withContext, unit: getUnit() }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    reportSilently(e, "coach request");
    events.onError(
      e instanceof Error && /fetch/i.test(e.message)
        ? "Can't reach the coach — check your connection."
        : "Couldn't reach the coach.",
    );
    return;
  }

  if (!res.ok || !res.body) {
    // The function answers errors as JSON, including the rate-limit message,
    // which is written for the person to read.
    let message = `The coach is unavailable (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON body; keep the status message
    }
    // 429 is the rate limit doing its job and is not worth an alert; anything
    // else means the coach is broken and should show up in Sentry.
    if (res.status !== 429) {
      reportSilently(new Error(`coach ${res.status}: ${message}`), "coach");
    }
    events.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Minimal SSE parse: events are separated by a blank line, and we only ever
  // emit single-line JSON payloads from the server.
  const handle = (block: string) => {
    let name = "message";
    let payload = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) payload += line.slice(5).trim();
    }
    if (!payload) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const p = parsed as { text?: string; name?: string; message?: string };
    if (name === "text" && p.text) events.onText(p.text);
    else if (name === "thinking") events.onThinking();
    else if (name === "tool") events.onTool(p.name ?? "tool");
    else if (name === "done") events.onDone();
    else if (name === "error") events.onError(p.message ?? "The coach failed.");
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        handle(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) handle(buffer);
  } catch (e) {
    if (!signal?.aborted) {
      reportSilently(e, "coach stream");
      events.onError(
        e instanceof Error ? e.message : "The answer was cut off.",
      );
    }
  }
}

/**
 * Report to Sentry WITHOUT the toast reportError raises.
 *
 * The chat shows its own failure inline, in the thread, where the person is
 * already looking. A toast on top of that is the same news twice.
 */
function reportSilently(err: unknown, context: string): void {
  try {
    reportError(err, context);
  } catch {
    // reporting must never be the thing that breaks the chat
  }
}

/** What the file picker accepts, and what each type becomes on the wire. */
export const ACCEPTED_FILES =
  "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/csv,text/plain,text/markdown,application/json,.csv,.md";

const IMAGE = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const TEXTY = ["text/csv", "text/plain", "text/markdown", "application/json"];

/**
 * Turn a picked file into an attachment.
 *
 * Text files are sent as TEXT rather than base64: a CSV of training data is
 * something the model should read, not decode, and inlining it costs fewer
 * tokens than the base64 of the same bytes.
 */
export async function readAttachment(
  file: File,
): Promise<CoachAttachment | null> {
  const type = file.type || guessType(file.name);
  if (IMAGE.includes(type)) {
    return {
      kind: "image",
      media_type: type,
      name: file.name,
      data: await toBase64(file),
    };
  }
  if (type === "application/pdf") {
    return {
      kind: "pdf",
      media_type: type,
      name: file.name,
      data: await toBase64(file),
    };
  }
  if (TEXTY.includes(type)) {
    return {
      kind: "text",
      media_type: type,
      name: file.name,
      data: await file.text(),
    };
  }
  return null;
}

function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return "text/csv";
  if (ext === "md") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "txt") return "text/plain";
  if (ext === "pdf") return "application/pdf";
  return "";
}

/**
 * Base64 without FileReader.
 *
 * `arrayBuffer()` is promise-based, exists everywhere including the test
 * environment, and skips the data-URL prefix that would have to be sliced back
 * off anyway. Encoded in chunks because `String.fromCharCode(...bytes)` on a
 * multi-megabyte photo overflows the call stack.
 */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
