// One set's receipt, in the words the design uses: ◐ On this phone, ↑ Sending,
// ✓ Saved, ! Needs review (and ‖ Held when this phone may not send it). The
// glyph carries the state and the word names it, so colour is never the only
// signal.
//
// The vocabulary is a claim, so each word is earned:
//  - Saved needs the exact set UUID read back from (or acknowledged by) the
//    server — never an empty queue, never the aggregate sync chip.
//  - On this phone needs a committed local outbox write.
//  - Sending is shown only while the queue is actively flushing AND this
//    set's writes are waiting in it. The outbox has no per-operation
//    in-flight evidence, so this says "the queue is sending and this set is
//    in it", not "this set has left the phone".
//  - Held and Needs review are the two that ask for attention.

import type { SetReceipt } from "../../lib/setReceipt";

export type ReceiptKind = "local" | "sending" | "held" | "synced" | "review";

export function receiptKind(
  receipt: SetReceipt,
  opts: { sending?: boolean; held?: boolean } = {},
): ReceiptKind {
  if (receipt.state === "synced") return "synced";
  if (receipt.state === "review") return "review";
  if (opts.held) return "held";
  return opts.sending ? "sending" : "local";
}

export const RECEIPT_GLYPH: Record<ReceiptKind, string> = {
  local: "◐",
  sending: "↑",
  held: "‖",
  synced: "✓",
  review: "!",
};

export const RECEIPT_WORD: Record<ReceiptKind, string> = {
  local: "On this phone",
  sending: "Sending…",
  held: "Held for its account",
  synced: "Saved",
  review: "Needs review",
};

const RECEIPT_LABEL: Record<ReceiptKind, string> = {
  local: "On this phone, waiting to send",
  sending: "Sending: the queue is sending and this set is waiting in it",
  held: "Held on this phone for its own account",
  synced: "Saved to the server",
  review: "Needs review",
};

export function SetReceiptStatus({
  receipt,
  sending = false,
  held = false,
  onReview,
  announce = true,
  mark = false,
}: {
  receipt: SetReceipt;
  sending?: boolean;
  held?: boolean;
  onReview?: () => void;
  announce?: boolean;
  /** List rows: the glyph alone, quiet; the word stays in the accessible
   *  name. A set that needs review still carries its Details control. */
  mark?: boolean;
}) {
  const kind = receiptKind(receipt, { sending, held });
  const label = RECEIPT_LABEL[kind];
  return (
    <span className={`set-receipt set-receipt-${kind}${mark ? " set-receipt-mark" : ""}`}>
      <span
        className="set-receipt-label"
        role={announce ? "status" : "note"}
        aria-label={`Set status: ${label}`}
      >
        <span className="set-receipt-glyph" aria-hidden="true">
          {RECEIPT_GLYPH[kind]}
        </span>
        {mark ? (
          <span className="sr-only">{RECEIPT_WORD[kind]}</span>
        ) : (
          <span className="set-receipt-word">{RECEIPT_WORD[kind]}</span>
        )}
      </span>
      {kind === "review" && onReview && (
        <button
          type="button"
          className="set-receipt-review"
          aria-label={`Review sync status: ${receipt.reason ?? "Server confirmation is missing."}`}
          onClick={onReview}
        >
          Details
        </button>
      )}
    </span>
  );
}
