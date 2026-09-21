import { pathToFileURL } from "node:url";

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function validatePwaEnv(env) {
  const urlRaw = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  const problems = [];

  if (!urlRaw) {
    problems.push("VITE_SUPABASE_URL is missing");
  } else {
    let parsed;
    try {
      parsed = new URL(urlRaw);
    } catch {
      problems.push("VITE_SUPABASE_URL is not a URL");
    }
    if (parsed) {
      if (parsed.protocol !== "https:") {
        problems.push("VITE_SUPABASE_URL must be https");
      }
      if (
        parsed.hostname === "placeholder.supabase.co" ||
        !parsed.hostname.endsWith(".supabase.co")
      ) {
        problems.push("VITE_SUPABASE_URL host is not a Supabase project");
      }
    }
  }

  if (!key) {
    problems.push("VITE_SUPABASE_ANON_KEY is missing");
  } else if (!JWT_RE.test(key)) {
    problems.push("VITE_SUPABASE_ANON_KEY is not a JWT");
  }

  if (problems.length > 0) return { ok: false, message: problems.join("; ") };
  return { ok: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = validatePwaEnv(process.env);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}
