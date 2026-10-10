/**
 * Structured JSON logging with secret redaction (§5.1, §2.1 item 6).
 * Every log line is one JSON object. Values matching known secret patterns
 * are replaced before serialization. Tests verify redaction.
 */

// Matches common secret shapes in free text AND "key": "value" JSON fragments.
const SECRET_PATTERNS: RegExp[] = [
  // Solana base58 secret keys (88-char) and 44-char pubkey-like secrets in secret contexts.
  /("?(?:secret|private)[_ -]?key"?\s*[:=]\s*"?)[A-HJ-NP-Za-km-z1-9]{32,128}("?)/gi, // safety-scan-exempt(redaction): redaction pattern, not secret handling
  // Mnemonic / seed phrase assignments.
  /("?(?:mnemonic|seed(?:\s*phrase)?)"?\s*[:=]\s*"?)([a-z]+\s+){11,23}[a-z]+("?)/gi, // safety-scan-exempt(redaction): redaction pattern, not secret handling
  // Bearer / API tokens.
  /("?(?:bearer|api[_ -]?key|token|auth)"?\s*[:=]\s*"?)[A-Za-z0-9\-._~+/=]{16,}("?)/gi, // safety-scan-exempt(redaction): redaction pattern, not secret handling
  // Long base58 blobs that look like raw key material.
  /\b[1-9A-HJ-NP-Za-km-z]{80,130}\b/g,
];

const REDACTED = "[REDACTED]";

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_m, prefix?: string, suffix?: string) => {
      if (typeof prefix === "string") return `${prefix}${REDACTED}${suffix ?? ""}`;
      return REDACTED;
    });
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  const safe = redactSecrets(line);
  if (level === "error") console.error(safe);
  else console.log(safe);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};
