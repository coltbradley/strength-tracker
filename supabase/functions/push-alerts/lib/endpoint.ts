const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (host.includes(":") || IPV4_RE.test(host)) return false;

  if (host === "web.push.apple.com" || host.endsWith(".push.apple.com")) {
    return true;
  }
  if (host === "fcm.googleapis.com" || host === "android.googleapis.com") {
    return true;
  }
  if (host === "updates.push.services.mozilla.com") return true;
  if (
    host.endsWith(".notify.windows.com") ||
    host.endsWith(".wns.windows.com")
  ) {
    return true;
  }
  return false;
}

/** Whether a Web Push subscription endpoint may be stored or fetched server-side. */
export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return hostAllowed(url.hostname);
}
