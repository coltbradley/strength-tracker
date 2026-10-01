// Boots PGlite with the Supabase platform pieces shimmed and the WHOLE real
// migration chain applied, unmodified. validate-db.mjs does the same inline
// (it predates this helper and also loads the seed and fixtures); anything
// that only needs the schema and its triggers imports this instead.
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function bootChain() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
    create role authenticated login;
    create role anon login;
    create role service_role nologin bypassrls;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
  `);
  const migDir = join(root, "supabase", "migrations");
  const migrations = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
  if (migrations.length === 0) throw new Error("no migrations found");
  for (const m of migrations) await db.exec(await readFile(join(migDir, m), "utf8"));
  return { db, migrations };
}
