/** WHO may use the in-app coach.
 *  `null` means the secret is unset: everyone is admitted (Phase 0 keeps
 *  this; Phase 1 A-02 fail-closes it). A present list that names nobody
 *  refuses everyone. */
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

export function isCoachUserAllowed(
  userId: string,
  allowlist: Set<string> | null,
): boolean {
  if (allowlist === null) return true;
  return allowlist.has(userId.toLowerCase());
}
