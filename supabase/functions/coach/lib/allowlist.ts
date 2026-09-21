/** WHO may use the in-app coach.
 *  `null` means the secret is unset: the coach returns 503 (not configured).
 *  A present list that names nobody refuses everyone with 403. */
export function parseAllowlist(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return new Set(
    trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

export const COACH_NOT_CONFIGURED = "The coach is not configured";
export const COACH_NOT_ENABLED = "The coach isn't enabled for this account.";

export function coachAdmission(
  userId: string,
  allowlist: Set<string> | null,
):
  | { status: 200 }
  | { status: 403; error: string }
  | { status: 503; error: string } {
  if (allowlist === null) {
    return { status: 503, error: COACH_NOT_CONFIGURED };
  }
  if (!allowlist.has(userId.toLowerCase())) {
    return { status: 403, error: COACH_NOT_ENABLED };
  }
  return { status: 200 };
}

export function isCoachUserAllowed(
  userId: string,
  allowlist: Set<string> | null,
): boolean {
  return coachAdmission(userId, allowlist).status === 200;
}
