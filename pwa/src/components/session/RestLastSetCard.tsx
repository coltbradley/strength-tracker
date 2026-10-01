// "LAST SET" on the rest screen: what was just saved, how far it has got, and
// Fix. It describes ONE real row (the newest live set), so after a correction
// it names the replacement, and it never says "already saved" — the receipt
// line says what is actually true of that row (On this phone, Sending, Saved,
// Needs review).

import type { ReactNode } from "react";

export function RestLastSetCard({
  line,
  receipt,
  pairNote,
  onFix,
}: {
  /** "Bench Press · set 3 · 135 lb × 8" */
  line: string;
  /** the SetReceiptStatus for that exact set */
  receipt: ReactNode;
  /** "Correction waiting to send": the original is still live on the server */
  pairNote?: string;
  onFix: () => void;
}) {
  return (
    <div className="focus-saved-card">
      <span className="focus-saved-text">
        <span className="focus-card-eyebrow">LAST SET</span>
        <span className="focus-saved-line">{line}</span>
        <span className="focus-saved-receipt">{receipt}</span>
        {pairNote && <span className="focus-saved-pair">{pairNote}</span>}
      </span>
      <button type="button" className="focus-card-action" onClick={onFix}>
        Fix
      </button>
    </div>
  );
}
