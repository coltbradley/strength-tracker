// Loads scripts/coach-eval/.env (gitignored) into process.env when present, so
// the API key never has to be pasted into a shell history or a chat.
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const text = await readFile(join(dirname(fileURLToPath(import.meta.url)), ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env; rely on the environment
}
