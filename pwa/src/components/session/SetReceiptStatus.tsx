import type { SetReceipt } from "../../lib/setReceipt";

const LABEL: Record<SetReceipt["state"], string> = {
  local: "On this phone",
  synced: "Synced",
  review: "Review",
};

export function SetReceiptStatus({
  receipt,
  onReview,
}: { receipt: SetReceipt; onReview?: () => void }) {
  const label = LABEL[receipt.state];
  return (
    <span className={`set-receipt set-receipt-${receipt.state}`}>
      <span className="set-receipt-label" role="status" aria-label={`Set status: ${label}`}>
        {label}
      </span>
      {receipt.state === "review" && onReview && (
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
