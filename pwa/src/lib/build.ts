// Build stamp, one source for everyone who quotes a version: the About row in
// Settings, the CSV export header, and the bug report. Vite inlines
// import.meta.env at build time and exposes any VITE_-prefixed variable from
// the build environment, so CI sets these (see .github/workflows/deploy.yml).
// Unset — a local `npm run dev` — they degrade to the package version and
// nulls rather than lying about a commit.
const ENV = import.meta.env as unknown as Record<string, string | undefined>;

export const APP_VERSION = ENV.VITE_APP_VERSION ?? "0.1.0";
export const BUILD_SHA = ENV.VITE_BUILD_SHA ?? null;
export const BUILD_TIME = ENV.VITE_BUILD_TIME ?? null;

/** One line naming exactly this build, for a human to paste back at us. */
export function buildStamp(): string {
  const sha = BUILD_SHA ? `+${BUILD_SHA.slice(0, 7)}` : "";
  const mode = import.meta.env.DEV ? " (dev)" : "";
  return `${APP_VERSION}${sha}${mode}`;
}
