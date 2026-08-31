// The coach: a chat that can read the log and change the plan.
//
// Held to the same shape as the rest of the app rather than a generic chat
// widget. Two decisions worth knowing:
//
// HISTORY IS DEVICE-LOCAL. Conversations live in this browser and nowhere
// else. There is no server table of what someone asked their coach, which
// means a shared phone shares a thread and a new phone starts empty — the same
// trade the settings registry already makes, and the right one for the most
// personal thing in the app.
//
// A TURN IN FLIGHT CAN BE ABANDONED. Someone mid-session will start their next
// set halfway through an answer. Closing the sheet leaves the request running
// and keeps whatever arrived, because the tokens are already spent either way.
import { useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import { Markdown } from "./Markdown";
import {
  ACCEPTED_FILES,
  askCoach,
  getCoachSpend,
  newTurnId,
  readAttachment,
  recoverAnswer,
  type CoachAttachment,
  type CoachSpend,
  type CoachTurn,
} from "../lib/coach";
import { reportError, toast } from "../lib/errors";

const HISTORY_KEY = "strength-log.coach.thread";
/** Enough for a session's worth of back-and-forth; the API bills the whole
 *  thread every turn, so an unbounded one gets expensive quietly. */
const MAX_TURNS = 24;

interface Msg extends CoachTurn {
  /** set while this assistant turn is still being written */
  streaming?: boolean;
  tool?: string | null;
  /** adaptive thinking is running and no text has arrived yet */
  thinking?: boolean;
  /** the id this turn was asked under, so an answer this device did not stay
   *  connected for can be fetched back */
  turnId?: string;
}

function loadThread(): Msg[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Msg[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

function saveThread(msgs: Msg[]): void {
  try {
    // Attachments are stripped before storing: a few photos would blow the
    // 5 MB localStorage budget and take the settings envelope with them.
    const light = msgs.slice(-MAX_TURNS).map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.turnId ? { turnId: m.turnId } : {}),
      // Kept deliberately: on reopen this is how the app knows an answer was
      // still being written when the phone locked, and goes to fetch it.
      ...(m.streaming ? { streaming: true } : {}),
      ...(m.attachments?.length
        ? { attachments: m.attachments.map((a) => ({ ...a, data: "" })) }
        : {}),
    }));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(light));
  } catch {
    // a full quota must not break the conversation in progress
  }
}

export function CoachSheet({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>(loadThread);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<CoachAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [spend, setSpend] = useState<CoachSpend | null>(null);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the stream only when already at the bottom. Scrolling someone back
  // down while they are reading an earlier answer is the single most annoying
  // thing a chat can do, and it happens on every token.
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = threadRef.current;
    if (el === null) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  // An answer this device was not connected for. The phone locks mid-answer,
  // or the app is closed; the function finishes the turn regardless and stores
  // it. On reopen, go and get what was missed rather than leaving a truncated
  // reply on screen with no way to tell it is truncated.
  useEffect(() => {
    const last = msgs[msgs.length - 1];
    if (!last?.streaming || !last.turnId || busy) return;
    let cancelled = false;
    void recoverAnswer(last.turnId).then((text) => {
      if (cancelled) return;
      setMsgs((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1
            ? {
                ...m,
                streaming: false,
                tool: null,
                thinking: false,
                text:
                  text ??
                  (m.text ||
                    "(That answer was interrupted and didn't finish. Ask again.)"),
              }
            : m,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // Runs once per sheet open; msgs is intentionally not a dependency or the
    // recovery would re-fire on every streamed chunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => saveThread(msgs), [msgs]);

  // What this has cost. Shown rather than merely recorded: the person asking
  // is not the person paying, and a number nobody sees is a number nobody
  // acts on. Refreshed when a turn finishes, not on every streamed chunk.
  useEffect(() => {
    if (busy) return;
    void getCoachSpend().then(setSpend);
  }, [busy]);

  // Grow with the text rather than making someone write a paragraph through a
  // two-line slot. Capped so the thread above never disappears entirely.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const pick = async (list: FileList | null) => {
    if (!list) return;
    const next: CoachAttachment[] = [];
    for (const f of Array.from(list)) {
      try {
        const a = await readAttachment(f);
        if (a) next.push(a);
        else toast(`Can't read ${f.name} — try a photo, PDF, CSV or text file`, "error");
      } catch (e) {
        reportError(e, "read file");
      }
    }
    setFiles((prev) => [...prev, ...next]);
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || busy) return;

    const mine: Msg = {
      role: "user",
      text: text || "(see attached)",
      ...(files.length ? { attachments: files } : {}),
    };
    // The placeholder assistant turn goes in immediately so the thread never
    // looks like it swallowed the question.
    const turnId = newTurnId();
    const history = [...msgs, mine];
    setMsgs([
      ...history,
      { role: "assistant", text: "", streaming: true, turnId },
    ]);
    setDraft("");
    setFiles([]);
    setBusy(true);

    const ctrl = new AbortController();
    abort.current = ctrl;

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)));

    void askCoach(
      history.map(({ role, text: t, attachments }) => ({
        role,
        text: t,
        ...(attachments?.length ? { attachments } : {}),
      })),
      {
        onText: (chunk) =>
          patchLast((m) => ({
            ...m,
            text: m.text + chunk,
            tool: null,
            thinking: false,
          })),
        onThinking: () => patchLast((m) => ({ ...m, thinking: true })),
        onTool: (name) =>
          patchLast((m) => ({ ...m, tool: name, thinking: false })),
        onDone: () => {
          patchLast((m) => ({
            ...m,
            streaming: false,
            tool: null,
            thinking: false,
          }));
          setBusy(false);
        },
        onError: (message) => {
          patchLast((m) => ({
            ...m,
            streaming: false,
            tool: null,
            thinking: false,
            text: m.text ? `${m.text}\n\n(${message})` : message,
          }));
          setBusy(false);
        },
      },
      ctrl.signal,
      turnId,
    );
  };

  /** Stop mid-answer. The tokens are spent either way, so whatever arrived
   *  is kept rather than thrown away — and the server finishes and records the
   *  turn regardless, so the full text is recoverable. */
  const stop = () => {
    abort.current?.abort();
    setBusy(false);
    setMsgs((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1
          ? {
              ...m,
              streaming: false,
              tool: null,
              thinking: false,
              text: m.text || "(stopped)",
            }
          : m,
      ),
    );
  };

  /** Ask the last question again, dropping the answer that failed. */
  const retry = () => {
    if (busy) return;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setMsgs((prev) => {
      const cut = [...prev];
      while (cut.length > 0 && cut[cut.length - 1]!.role === "assistant")
        cut.pop();
      return cut;
    });
    // Re-send on the next tick, once the failed turn is out of the thread.
    setTimeout(() => {
      setDraft(lastUser.text);
      setFiles(lastUser.attachments ?? []);
    }, 0);
  };

  const clear = () => {
    abort.current?.abort();
    setMsgs([]);
    setBusy(false);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // nothing to do; the in-memory thread is already gone
    }
  };

  return (
    <Sheet
      title="Coach"
      onClose={onClose}
      tall
      className="coach-sheet"
      headRight={
        msgs.length > 0 ? (
          <button type="button" className="sheet-head-action" onClick={clear}>
            NEW
          </button>
        ) : undefined
      }
    >
      <div className="coach-thread" ref={threadRef}>
        {msgs.length === 0 && (
          <>
            <div className="microcopy">
              Ask about your training. I can see your log and your plan, and I
              can change what’s scheduled. Send a photo for a form check, or a
              spreadsheet or PDF from another app.
            </div>
            {/* A blank box is a hard thing to start from, and these double as
                a statement of what it can actually do. */}
            <div className="coach-starters">
              {[
                "How did my last session go?",
                "What should I do today?",
                "Am I making progress on squat?",
                "This felt heavy — should I back off?",
              ].map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip"
                  onClick={() => setDraft(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={`coach-msg coach-msg-${m.role}`}>
            {m.attachments && m.attachments.length > 0 && (
              <div className="coach-files">
                {m.attachments.map((a, j) => (
                  <span key={j} className="chip">
                    {a.name}
                  </span>
                ))}
              </div>
            )}
            {/* The lifter's own turns are plain text they typed; only the
                coach writes markdown. Rendering both through the parser would
                turn a question containing an asterisk into formatting. */}
            {m.role === "assistant" ? (
              <Markdown source={m.text} />
            ) : (
              <div className="coach-text">{m.text}</div>
            )}
            {m.role === "assistant" && !m.streaming && m.text.length > 0 && (
              <div className="coach-msg-actions">
                <button
                  type="button"
                  className="coach-msg-action"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(m.text)
                      .then(() => toast("Copied"))
                      .catch(() => toast("Couldn't copy", "error"));
                  }}
                >
                  Copy
                </button>
                {i === msgs.length - 1 && (
                  <button
                    type="button"
                    className="coach-msg-action"
                    onClick={retry}
                  >
                    Ask again
                  </button>
                )}
              </div>
            )}
            {m.streaming && (
              <div className="coach-status">
                {m.tool
                  ? `checking your ${label(m.tool)}…`
                  : m.thinking
                    ? "thinking it through…"
                    : "…"}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {files.length > 0 && (
        <div className="coach-files">
          {files.map((a, i) => (
            <button
              key={i}
              type="button"
              className="chip chip-on"
              aria-label={`remove ${a.name}`}
              onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
            >
              {a.name} ✕
            </button>
          ))}
        </div>
      )}

      {/* The textarea gets the full width on its own row; the controls sit
          under it. Side by side, a 44px attach button and an "Ask" button left
          the input at 213px of a 375px screen, wrapping every four words. */}
      {spend !== null && spend.costMonth > 0 && (
        <div className="coach-spend">
          {spend.turnsToday} today · ${spend.costToday.toFixed(2)} today · $
          {spend.costMonth.toFixed(2)} this month
        </div>
      )}

      <div className="coach-compose">
        <textarea
          ref={inputRef}
          className="input coach-input"
          rows={3}
          placeholder="Squat felt heavy today — should I drop the last set?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter inserts a newline on a phone, where it is the only way to
            // get one. Cmd/Ctrl+Enter sends, for anyone on a keyboard.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <div className="coach-actions">
          <label className="btn btn-ghost coach-attach">
            <span aria-hidden="true">＋ Photo or file</span>
            <span className="sr-only">attach a photo or file</span>
            <input
              type="file"
              multiple
              accept={ACCEPTED_FILES}
              onChange={(e) => {
                void pick(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {busy ? (
            <button
              type="button"
              className="btn btn-outline-ink coach-send"
              onClick={stop}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary coach-send"
              disabled={draft.trim() === "" && files.length === 0}
              onClick={send}
            >
              Ask
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Tool names are snake_case internals; say them the way a person would. */
function label(tool: string): string {
  if (tool.includes("program")) return "plan";
  if (tool.includes("session")) return "recent sessions";
  if (tool.includes("history") || tool.includes("lift")) return "history";
  if (tool.includes("exercise")) return "exercise library";
  if (tool.includes("goal")) return "goals";
  return "log";
}
