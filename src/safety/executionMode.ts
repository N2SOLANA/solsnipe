/**
 * Hardcoded execution mode (§2.1 item 1).
 *
 * This is a compile-time constant, deliberately NOT read from environment,
 * config files, CLI flags, or any other runtime input. There is no code path
 * that branches into a non-paper mode — the type system enforces it: the
 * literal type "PAPER" has exactly one inhabitant.
 *
 * Changing this requires a source edit, review, and an explicit §29 approval.
 * Any missing/ambiguous/invalid mode must fail safe (block execution).
 */
export const EXECUTION_MODE = "PAPER" as const;

export type ExecutionMode = typeof EXECUTION_MODE;

export function assertPaperMode(): void {
  if (EXECUTION_MODE !== "PAPER") {
    throw new Error(
      `FATAL: execution mode is not PAPER (${String(EXECUTION_MODE)}). Refusing to operate.`,
    );
  }
}
