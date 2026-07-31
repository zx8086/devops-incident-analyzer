# IaC poll-budget/interval env var validation

Date: 2026-07-31
Origin: CodeRabbit review on [PR #552](https://github.com/zx8086/devops-incident-analyzer/pull/552) (SIO-1307), flagging `IAC_FLEET_APPLY_TICKER_BUDGET_MS`/`_INTERVAL_MS` and `ELASTIC_IAC_FLEET_APPLY_POLL_BUDGET_MS` as read via raw `Number(process.env.X ?? "default")` with no validation.

## Problem

Investigation showed the CodeRabbit finding is not specific to the two new SIO-1307 vars -- it's the established (unvalidated) pattern for every poll-budget/interval env var in both files touched by that PR:

`packages/agent/src/iac/nodes.ts`:
- `IAC_PIPELINE_POLL_BUDGET_MS` (default 90000)
- `IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED` (default 90000)
- `IAC_PIPELINE_POLL_INTERVAL_MS` (default 10000, two call sites)
- `ELASTIC_IAC_DRIFT_CONCURRENCY` (default 4 -- a count, not milliseconds)
- `IAC_FLEET_APPLY_TICKER_BUDGET_MS` (default 40000)
- `IAC_FLEET_APPLY_TICKER_INTERVAL_MS` (default 10000)

`packages/mcp-server-elastic-iac/src/tools/gitlab.ts`:
- `ELASTIC_IAC_DRIFT_POLL_BUDGET_MS` (default 90000)
- `ELASTIC_IAC_DRIFT_POLL_INTERVAL_MS` (default 5000)
- `ELASTIC_IAC_FLEET_APPLY_POLL_BUDGET_MS` (default 30000)
- `ELASTIC_IAC_DRIFT_FAIL_LOG_TAIL_BYTES` (default 16000 -- a byte count, not milliseconds)

A NaN, zero, negative, or `Infinity` value for any of these could skip a polling window entirely (`Date.now() < deadline` is immediately false or always true) or create a tight loop. Fixing only the 2 new vars from PR #552 would be inconsistent with the file's own established pattern, so this spec covers all 10 call sites.

## Design

### Shared helper module

New file `packages/shared/src/env-validation.ts`, exported from `packages/shared/src/index.ts`. Both consuming packages (`packages/agent`, `packages/mcp-server-elastic-iac`) already declare a `workspace:*` dependency on `@devops-agent/shared`, so no new dependency edges are needed.

```ts
// shared/src/env-validation.ts
import { z } from "zod";

interface EnvLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

const noopLogger: EnvLogger = { warn: () => {} };

function readValidatedEnv(name: string, defaultValue: number, schema: z.ZodTypeAny, logger: EnvLogger): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = schema.safeParse(Number(raw));
  if (!parsed.success) {
    logger.warn({ name, raw, defaultValue }, "invalid env var, falling back to default");
    return defaultValue;
  }
  return parsed.data;
}

export function readPositiveMsEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
  return readValidatedEnv(name, defaultValue, z.number().finite().positive(), logger);
}

export function readPositiveIntEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
  return readValidatedEnv(name, defaultValue, z.number().finite().positive().int(), logger);
}
```

Two helpers, sharing one internal Zod-schema-driven validator:

- **`readPositiveMsEnv`** -- finite and `> 0`. Allows fractional milliseconds (matches today's behavior: `Number("5000.5")` already works, and `setTimeout`/`Date.now()` arithmetic tolerates non-integer ms). Used for all budget/interval vars.
- **`readPositiveIntEnv`** -- finite, `> 0`, and a whole number. Used for `ELASTIC_IAC_DRIFT_CONCURRENCY` (a concurrency count) and `ELASTIC_IAC_DRIFT_FAIL_LOG_TAIL_BYTES` (a byte count) -- both are "positive whole number" constraints with no fractional meaning.

### Fallback behavior

Per this repo's convention (operational tuning knobs, not safety-critical config): **never throw**. An invalid value logs a warning (var name, raw string value, and the default being substituted) and the function returns the default. This matches the CodeRabbit-cited "Zod for all runtime validation" guideline while keeping these vars non-fatal to misconfigure.

### Logging

The helper takes an optional `logger` param defaulting to a no-op, so the module itself has no logging dependency. Callers pass their package's real structured logger:
- `packages/agent/src/iac/nodes.ts` passes its existing `getLogger()` instance (from `@devops-agent/observability`).
- `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` passes its existing `createContextLogger()` instance.

This keeps warnings inside the normal Pino log pipeline rather than bypassing it with `console.warn`.

### Call site changes

All 10 call sites listed above switch from `Number(process.env.X ?? "default")` to `readPositiveMsEnv("X", default, log)` or `readPositiveIntEnv("X", default, log)` as appropriate. No change to default values, no change to where/when each var is read (still lazily read inline at each call site, not hoisted to a startup-time config object) -- this is a targeted correctness fix, not a config-architecture refactor.

## Testing

Unit tests for the two helpers in `packages/shared/src/__tests__/env-validation.test.ts`:
- valid numeric string -> parsed value returned, no warning
- var unset -> default returned, no warning
- NaN (garbage string) -> default returned, one warning logged
- `"0"` -> default returned, one warning logged
- negative value -> default returned, one warning logged
- `"Infinity"` -> default returned, one warning logged
- (int helper only) fractional value (e.g. `"5000.5"`) -> default returned, one warning logged

No integration test changes required -- the 10 call sites keep identical default behavior for valid input; only the invalid-input path changes (from silently propagating `NaN`/`0`/`Infinity` into loop conditions, to a logged fallback).

## Out of scope

- No refactor of the surrounding config loading in either file into a Zod schema object.
- No change to any default value.
- No eager/startup-time validation pass -- vars remain read lazily per call site.
- No changes to non-numeric env vars in either file (e.g. `ELASTIC_IAC_GITLAB_TOKEN`).
