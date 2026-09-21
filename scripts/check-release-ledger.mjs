import { readFileSync } from "node:fs";
import { parseLedger, validateLedger } from "./lib/release-ledger.mjs";

const path = new URL("../docs/roadmaps/release-ledger.md", import.meta.url);
const errors = validateLedger(parseLedger(readFileSync(path, "utf8")));
if (errors.length) {
  console.error(`release-ledger: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("release-ledger: ok");
