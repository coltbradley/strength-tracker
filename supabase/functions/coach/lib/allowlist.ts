/** WHO may use the in-app coach. An unset or blank secret admits nobody. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) return new Set();
  return new Set(
    trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

export function isCoachUserAllowed(
  userId: string,
  allowlist: Set<string>,
): boolean {
  return allowlist.has(userId.toLowerCase());
}
