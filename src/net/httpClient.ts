/**
 * Single outbound HTTP client (§2.1 item 4). ALL application HTTP goes through
 * here. Hosts must be in NETWORK_ALLOWLIST or the call is rejected before any
 * bytes leave the machine. A test verifies unlisted hosts are rejected.
 */
import { NETWORK_ALLOWLIST } from "../safety/denylist.js";

export class DisallowedHostError extends Error {
  constructor(host: string) {
    super(
      `Outbound HTTP to "${host}" is not in the network allowlist. ` +
        `Allowed: ${NETWORK_ALLOWLIST.join(", ")}`,
    );
    this.name = "DisallowedHostError";
  }
}

export function assertAllowedUrl(url: string | URL): URL {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (parsed.protocol !== "https:") {
    throw new DisallowedHostError(`${parsed.host} (non-https blocked)`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = NETWORK_ALLOWLIST.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
  if (!allowed) throw new DisallowedHostError(host);
  return parsed;
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Allowlist-enforcing wrapper around global fetch. */
export async function allowedFetch(
  url: string | URL,
  options: FetchOptions = {},
): Promise<Response> {
  const parsed = assertAllowedUrl(url);
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  return fetch(parsed, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
