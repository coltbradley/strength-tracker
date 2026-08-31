// The coach client's parsing and file handling. The network and the model are
// not under test here; the SSE frame handling and the attachment classifier
// are, because both are places a silent wrong answer is possible.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: "test-jwt" } } }),
    },
  },
}));
vi.mock("./settings", () => ({ getUnit: () => "kg" }));
vi.mock("./coachContext", () => ({
  buildCoachContext: () => Promise.resolve("CONTEXT HERE"),
}));
vi.mock("./errors", () => ({ reportError: vi.fn() }));

import { askCoach, readAttachment } from "./coach";

/** A Response whose body streams the given SSE text in arbitrary chunks. */
function sseResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(body, { status: 200 });
}

function collector() {
  const text: string[] = [];
  const tools: string[] = [];
  let thinking = 0;
  let done = 0;
  const errors: string[] = [];
  return {
    events: {
      onText: (c: string) => text.push(c),
      onTool: (n: string) => tools.push(n),
      onThinking: () => (thinking += 1),
      onDone: () => (done += 1),
      onError: (m: string) => errors.push(m),
    },
    get text() {
      return text.join("");
    },
    get tools() {
      return tools;
    },
    get thinking() {
      return thinking;
    },
    get done() {
      return done;
    },
    get errors() {
      return errors;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
});

describe("askCoach SSE handling", () => {
  it("reassembles text split across network chunks", async () => {
    const frames =
      'event: text\ndata: {"text":"Drop the last "}\n\n' +
      'event: text\ndata: {"text":"set."}\n\n' +
      'event: done\ndata: {}\n\n';
    vi.mocked(fetch).mockResolvedValue(sseResponse(frames, 5));
    const c = collector();
    await askCoach([{ role: "user", text: "hi" }], c.events);
    expect(c.text).toBe("Drop the last set.");
    expect(c.done).toBe(1);
    expect(c.errors).toEqual([]);
  });

  it("reports tools and thinking so the UI never sits silent", async () => {
    const frames =
      'event: thinking\ndata: {"text":"..."}\n\n' +
      'event: tool\ndata: {"name":"get_program"}\n\n' +
      'event: text\ndata: {"text":"ok"}\n\n' +
      'event: done\ndata: {}\n\n';
    vi.mocked(fetch).mockResolvedValue(sseResponse(frames, 11));
    const c = collector();
    await askCoach([{ role: "user", text: "hi" }], c.events);
    expect(c.thinking).toBe(1);
    expect(c.tools).toEqual(["get_program"]);
  });

  it("surfaces a server error frame as an error, not as answer text", async () => {
    const frames = 'event: error\ndata: {"message":"upstream failed"}\n\n';
    vi.mocked(fetch).mockResolvedValue(sseResponse(frames));
    const c = collector();
    await askCoach([{ role: "user", text: "hi" }], c.events);
    expect(c.errors).toEqual(["upstream failed"]);
    expect(c.text).toBe("");
  });

  it("passes the rate-limit message through verbatim", async () => {
    // It is written for the person to read; a generic "429" would be worse.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Daily limit reached (150)." }), {
        status: 429,
      }),
    );
    const c = collector();
    await askCoach([{ role: "user", text: "hi" }], c.events);
    expect(c.errors).toEqual(["Daily limit reached (150)."]);
  });

  it("attaches context to the last user turn only", async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse('event: done\ndata: {}\n\n'));
    await askCoach(
      [
        { role: "user", text: "first" },
        { role: "assistant", text: "reply" },
        { role: "user", text: "second" },
      ],
      collector().events,
    );
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1] as { body: string }).body,
    ) as { turns: { text: string }[] };
    expect(body.turns[0]!.text).toBe("first");
    expect(body.turns[2]!.text).toContain("CONTEXT HERE");
    expect(body.turns[2]!.text).toContain("second");
  });

  it("says so when there is no session rather than failing silently", async () => {
    const { supabase } = await import("./supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as never);
    const c = collector();
    await askCoach([{ role: "user", text: "hi" }], c.events);
    expect(c.errors[0]).toMatch(/sign in/i);
  });
});

describe("readAttachment", () => {
  const file = (name: string, type: string, body = "x") =>
    new File([body], name, { type });

  it("sends a CSV as text, not base64", async () => {
    const a = await readAttachment(file("log.csv", "text/csv", "a,b\n1,2"));
    expect(a).toMatchObject({ kind: "text", data: "a,b\n1,2" });
  });

  it("classifies a PDF as a document", async () => {
    const a = await readAttachment(file("plan.pdf", "application/pdf"));
    expect(a?.kind).toBe("pdf");
  });

  it("falls back to the extension when the browser gives no type", async () => {
    const a = await readAttachment(file("block.csv", "", "a,b"));
    expect(a?.kind).toBe("text");
  });

  it("refuses a type the API cannot read", async () => {
    expect(await readAttachment(file("clip.mov", "video/quicktime"))).toBeNull();
  });
});
