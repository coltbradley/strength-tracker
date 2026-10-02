import { pathToFileURL } from "node:url";

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const PUBLISHABLE_RE = /^sb_publishable_[A-Za-z0-9_-]+$/;

// The role claim of a JWT, or null when the payload does not decode. Never
// verified: this only stops a mispasted service key, it is not authentication.
function jwtRole(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

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
  } else if (key.startsWith("sb_secret_")) {
    // The bundle is public; a secret key here bypasses RLS for everyone.
    problems.push("VITE_SUPABASE_ANON_KEY is a secret key, not a publishable one");
  } else if (PUBLISHABLE_RE.test(key)) {
    // New-format publishable key: fine.
  } else if (!JWT_RE.test(key)) {
    problems.push("VITE_SUPABASE_ANON_KEY is not a JWT");
  } else if (jwtRole(key) !== "anon") {
    problems.push("VITE_SUPABASE_ANON_KEY is not an anon-role key");
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
