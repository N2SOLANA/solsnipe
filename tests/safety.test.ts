import { describe, expect, it } from "vitest";
import { EXECUTION_MODE, assertPaperMode } from "../src/safety/executionMode.js";
import {
  assertAllowedUrl,
  DisallowedHostError,
} from "../src/net/httpClient.js";
import { NETWORK_ALLOWLIST } from "../src/safety/denylist.js";
import { redactSecrets } from "../src/util/logger.js";
import { loadConfig, ConfigSchema } from "../src/config.js";
import { readFileSync } from "node:fs";

describe("execution mode (§2.1.1)", () => {
  it("is hardcoded to PAPER", () => {
    expect(EXECUTION_MODE).toBe("PAPER");
    const mode: "PAPER" = EXECUTION_MODE; // type-level: only inhabitant
    expect(mode).toBe("PAPER");
  });

  it("assertPaperMode does not throw for PAPER", () => {
    expect(() => assertPaperMode()).not.toThrow();
  });

  it("mode is not sourced from env or config", () => {
    const src = readFileSync(
      new URL("../src/safety/executionMode.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/process\.env/);
    expect(src).toContain('"PAPER" as const');
  });
});

describe("network allowlist (§2.1.4)", () => {
  it("permits listed hosts over https", () => {
    for (const host of NETWORK_ALLOWLIST) {
      expect(() => assertAllowedUrl(`https://${host}/x`)).not.toThrow();
    }
  });

  it("rejects unlisted hosts", () => {
    expect(() => assertAllowedUrl("https://evil.example.com/swap")).toThrow(
      DisallowedHostError,
    );
    expect(() => assertAllowedUrl("https://api.dexscreener.com.evil.com/")).toThrow(
      DisallowedHostError,
    );
  });

  it("rejects non-https", () => {
    expect(() => assertAllowedUrl("http://api.dexscreener.com/")).toThrow(
      DisallowedHostError,
    );
  });
});

describe("secret hygiene (§2.1.6)", () => {
  it("redacts api keys and tokens", () => {
    const out = redactSecrets('{"api_key": "sk-abcdef1234567890"}');
    expect(out).not.toContain("sk-abcdef1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts seed phrases and private keys", () => {
    expect(
      redactSecrets("mnemonic = abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
    ).toContain("[REDACTED]");
    expect(redactSecrets('private_key: "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3"')).toContain(
      "[REDACTED]",
    );
  });

  it(".env and key material are gitignored", () => {
    const gi = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    for (const pattern of [".env", "*.key", "*.pem", "wallet.json", "*.sqlite"]) {
      expect(gi).toContain(pattern);
    }
  });
});

describe("config validation", () => {
  it("loads defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.startingCapitalLamports).toBe(10_000_000_000);
    expect(cfg.maxOpenPositions).toBe(6);
  });

  it("rejects invalid values loudly", () => {
    expect(() => ConfigSchema.parse({ maxOpenPositions: -1 })).toThrow();
    expect(() => loadConfig({ SOLSNIPE_PORT: "not-a-number" } as NodeJS.ProcessEnv)).toThrow();
  });
});
