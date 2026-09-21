export const LEDGER_STATES = Object.freeze([
  "open",
  "fixed with test",
  "needs live proof",
  "not reproducible",
]);

function range(from, to) {
  const n = (id) => Number(id.slice(2));
  const out = [];
  for (let i = n(from); i <= n(to); i++)
    out.push(`A-${String(i).padStart(2, "0")}`);
  return out;
}

/** Audit triage "Stop release / contain" expanded. Order is the audit's. */
export const STOP_RELEASE_IDS = Object.freeze([
  "A-01",
  "A-02",
  "A-03",
  "A-07",
  ...range("A-24", "A-26"),
  "A-49",
  "A-69",
  ...range("A-74", "A-76"),
  "A-84",
  ...range("A-90", "A-92"),
  "A-94",
  "A-98",
  "A-99",
  "A-107",
  ...range("A-134", "A-141"),
  "A-143",
  ...range("A-148", "A-152"),
  ...range("A-156", "A-159"),
]);

function splitRow(line) {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  if (cells.length !== 7) return null;
  const [
    id,
    boundary,
    owner,
    state,
    regressionTest,
    productionProof,
    rollback,
  ] = cells;
  if (!/^A-\d{2,3}$/.test(id)) return null;
  return {
    id,
    boundary,
    owner,
    state,
    regressionTest,
    productionProof,
    rollback,
  };
}

export function parseLedger(markdown) {
  return markdown
    .split("\n")
    .map(splitRow)
    .filter((row) => row && row.id !== "ID");
}

export function validateLedger(rows) {
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`${row.id}: duplicate row`);
    seen.add(row.id);
    if (!LEDGER_STATES.includes(row.state))
      errors.push(`${row.id}: illegal state ${JSON.stringify(row.state)}`);
    for (const col of [
      "boundary",
      "owner",
      "regressionTest",
      "productionProof",
      "rollback",
    ]) {
      if (!row[col]) errors.push(`${row.id}: empty ${col}`);
    }
  }
  for (const id of STOP_RELEASE_IDS) {
    if (!seen.has(id)) errors.push(`${id}: missing stop-release row`);
  }
  return errors;
}
