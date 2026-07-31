# IaC Poll-Budget/Interval Env Var Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unvalidated `Number(process.env.X ?? "default")` reads with Zod-validated helpers across all 10 poll-budget/interval/count env vars in the IaC pipeline, so invalid values (NaN, zero, negative, Infinity, or non-integer for count vars) fall back to the documented default with a logged warning instead of silently breaking poll loops.

**Architecture:** One new shared module (`packages/shared/src/env-validation.ts`) exports two small functions -- `readPositiveMsEnv` and `readPositiveIntEnv` -- both built on a single internal Zod-schema-driven validator. Each of the 10 call sites in `packages/agent/src/iac/nodes.ts` and `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` swaps its raw `Number(...)` read for a call to one of these helpers, passing the package's existing structured logger.

**Tech Stack:** TypeScript (strict), Zod, Bun test runner, Pino-compatible loggers (`@devops-agent/observability` getLogger / local `createContextLogger`).

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Zod for all runtime validation, no `.default()` in config schemas (per CLAUDE.md) -- defaults are handled by the helper's own fallback logic, not baked into the Zod schema.
- No emojis in code, logs, comments, or output.
- File headers: single-line relative path comment only (e.g. `// packages/shared/src/env-validation.ts`).
- No change to any existing default value for the 10 env vars.
- Named exports preferred.
- Run `bun run typecheck && bun run lint && bun run test` after every change.
- Linear issue [SIO-1308](https://linear.app/siobytes/issue/SIO-1308/add-zod-validation-for-iac-poll-budgetinterval-env-vars) tracks this work; commit messages use `SIO-1308: message`.

---

### Task 1: Shared env-validation helper module + unit tests

**Files:**
- Create: `packages/shared/src/env-validation.ts`
- Create: `packages/shared/src/__tests__/env-validation.test.ts`
- Modify: `packages/shared/src/index.ts` (add export block)

**Interfaces:**
- Produces: `readPositiveMsEnv(name: string, defaultValue: number, logger?: EnvLogger): number`
- Produces: `readPositiveIntEnv(name: string, defaultValue: number, logger?: EnvLogger): number`
- Produces: `type EnvLogger = { warn: (obj: Record<string, unknown>, msg: string) => void }` (exported so callers can type their logger param if needed)

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/__tests__/env-validation.test.ts`:

```typescript
// packages/shared/src/__tests__/env-validation.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readPositiveIntEnv, readPositiveMsEnv } from "../env-validation.ts";

const TEST_VAR = "__ENV_VALIDATION_TEST_VAR__";

function makeSpyLogger() {
	const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
	return {
		logger: {
			warn: (obj: Record<string, unknown>, msg: string) => {
				calls.push({ obj, msg });
			},
		},
		calls,
	};
}

describe("readPositiveMsEnv", () => {
	beforeEach(() => {
		delete process.env[TEST_VAR];
	});
	afterEach(() => {
		delete process.env[TEST_VAR];
	});

	test("returns the parsed value for a valid numeric string, no warning", () => {
		process.env[TEST_VAR] = "5000";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(5000);
		expect(calls.length).toBe(0);
	});

	test("returns the default when the var is unset, no warning", () => {
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(0);
	});

	test("allows fractional milliseconds", () => {
		process.env[TEST_VAR] = "5000.5";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(5000.5);
		expect(calls.length).toBe(0);
	});

	test("falls back to default and warns on a garbage (NaN) string", () => {
		process.env[TEST_VAR] = "not-a-number";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
		expect(calls[0].obj).toMatchObject({ name: TEST_VAR, raw: "not-a-number", defaultValue: 1000 });
	});

	test("falls back to default and warns on zero", () => {
		process.env[TEST_VAR] = "0";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on a negative value", () => {
		process.env[TEST_VAR] = "-500";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on Infinity", () => {
		process.env[TEST_VAR] = "Infinity";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("works without a logger argument (defaults to no-op)", () => {
		process.env[TEST_VAR] = "not-a-number";
		expect(readPositiveMsEnv(TEST_VAR, 1000)).toBe(1000);
	});
});

describe("readPositiveIntEnv", () => {
	beforeEach(() => {
		delete process.env[TEST_VAR];
	});
	afterEach(() => {
		delete process.env[TEST_VAR];
	});

	test("returns the parsed value for a valid integer string, no warning", () => {
		process.env[TEST_VAR] = "4";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 1, logger)).toBe(4);
		expect(calls.length).toBe(0);
	});

	test("returns the default when the var is unset, no warning", () => {
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(0);
	});

	test("falls back to default and warns on a fractional value", () => {
		process.env[TEST_VAR] = "4.5";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on zero", () => {
		process.env[TEST_VAR] = "0";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on a negative value", () => {
		process.env[TEST_VAR] = "-1";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on Infinity", () => {
		process.env[TEST_VAR] = "Infinity";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/shared/src/__tests__/env-validation.test.ts`
Expected: FAIL with a module-not-found error for `../env-validation.ts` (file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/env-validation.ts`:

```typescript
// packages/shared/src/env-validation.ts
import { z } from "zod";

export type EnvLogger = {
	warn: (obj: Record<string, unknown>, msg: string) => void;
};

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

// Accepts fractional milliseconds -- Number("5000.5") is valid input today and
// setTimeout/Date.now() arithmetic tolerates non-integer ms, so there is no
// functional reason to reject it.
export function readPositiveMsEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
	return readValidatedEnv(name, defaultValue, z.number().finite().positive(), logger);
}

// For counts/byte-sizes where a fractional value has no meaning (e.g. concurrency,
// byte-tail length).
export function readPositiveIntEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
	return readValidatedEnv(name, defaultValue, z.number().finite().positive().int(), logger);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/__tests__/env-validation.test.ts`
Expected: PASS, all 15 tests green.

- [ ] **Step 5: Export from the shared package barrel**

In `packages/shared/src/index.ts`, insert a new export line in alphabetical order, immediately before the existing `focus-match.ts` export (`embedding-truncate.ts` sorts before `env-validation.ts` sorts before `focus-match.ts`):

```typescript
export { type EnvLogger, readPositiveIntEnv, readPositiveMsEnv } from "./env-validation.ts";
```

So the surrounding block reads:

```typescript
export { embeddingMaxChars, truncateForEmbedding } from "./embedding-truncate.ts";
export { type EnvLogger, readPositiveIntEnv, readPositiveMsEnv } from "./env-validation.ts";
export { matchesFocus, normalize, tokenize } from "./focus-match.ts";
```

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

Get explicit user authorization before committing (per this repo's "never commit without explicit user authorization" rule), then:

```bash
git add packages/shared/src/env-validation.ts packages/shared/src/__tests__/env-validation.test.ts packages/shared/src/index.ts
git commit -m "SIO-1308: add readPositiveMsEnv/readPositiveIntEnv shared helpers"
```

---

### Task 2: Wire helpers into packages/agent/src/iac/nodes.ts

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (6 call sites: lines ~7618-7629, ~9351, ~11126-11127; one var, `IAC_PIPELINE_POLL_INTERVAL_MS`, appears at two of those sites)

**Interfaces:**
- Consumes: `readPositiveMsEnv(name: string, defaultValue: number, logger?: EnvLogger): number` and `readPositiveIntEnv(name: string, defaultValue: number, logger?: EnvLogger): number` from `@devops-agent/shared` (Task 1)
- Consumes: existing `log` variable already defined at module scope in this file (`const log = getLogger("agent:iac");`, line 91) -- no new logger needs to be created.

- [ ] **Step 1: Add the import**

In `packages/agent/src/iac/nodes.ts`, find the existing `import type { AnnotationMap } from "@devops-agent/shared";` (line 7) and change it to a combined import:

```typescript
import { type AnnotationMap, readPositiveIntEnv, readPositiveMsEnv } from "@devops-agent/shared";
```

- [ ] **Step 2: Replace the watchPipeline budget/interval reads (first call site, ~line 7618-7629)**

Before:
```typescript
	const defaultBudgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
	const extendedBudgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED ?? "90000");
	// SIO-984: distinguish the two ways watchPipeline is entered. Straight after openMr (intent
	// "gitops") it polls to TERMINAL so the card shows triggered->running->succeeded in one turn; a
	// "check my MR" follow-up (intent "pipeline-status") only extends when the user asks to "watch
	// until done". SIO-989: the extended budget is now the same 90s as the default, so a cold-runner
	// pipeline (~130s) may not reach terminal within the turn -- the card returns at "running" and the
	// user re-checks with "check my MR". Returns early the instant the pipeline hits terminal, so the
	// budget is a ceiling, not a fixed wait. Override both via IAC_PIPELINE_POLL_BUDGET_MS[_EXTENDED].
	const isPostMrWatch = state.intent === "gitops";
	const budgetMs = resolveWatchPipelineBudgetMs(isPostMrWatch, lastHumanText(state), defaultBudgetMs, extendedBudgetMs);
	const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
```

After:
```typescript
	const defaultBudgetMs = readPositiveMsEnv("IAC_PIPELINE_POLL_BUDGET_MS", 90000, log);
	const extendedBudgetMs = readPositiveMsEnv("IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED", 90000, log);
	// SIO-984: distinguish the two ways watchPipeline is entered. Straight after openMr (intent
	// "gitops") it polls to TERMINAL so the card shows triggered->running->succeeded in one turn; a
	// "check my MR" follow-up (intent "pipeline-status") only extends when the user asks to "watch
	// until done". SIO-989: the extended budget is now the same 90s as the default, so a cold-runner
	// pipeline (~130s) may not reach terminal within the turn -- the card returns at "running" and the
	// user re-checks with "check my MR". Returns early the instant the pipeline hits terminal, so the
	// budget is a ceiling, not a fixed wait. Override both via IAC_PIPELINE_POLL_BUDGET_MS[_EXTENDED].
	const isPostMrWatch = state.intent === "gitops";
	const budgetMs = resolveWatchPipelineBudgetMs(isPostMrWatch, lastHumanText(state), defaultBudgetMs, extendedBudgetMs);
	const intervalMs = readPositiveMsEnv("IAC_PIPELINE_POLL_INTERVAL_MS", 10000, log);
```

- [ ] **Step 3: Replace the drift-concurrency read (~line 9351)**

Before:
```typescript
	const cap = Number(process.env.ELASTIC_IAC_DRIFT_CONCURRENCY ?? "4");
```

After:
```typescript
	const cap = readPositiveIntEnv("ELASTIC_IAC_DRIFT_CONCURRENCY", 4, log);
```

- [ ] **Step 4: Replace the fleet-apply ticker budget/interval reads (~line 11126-11127)**

Before:
```typescript
		const budgetMs = Number(process.env.IAC_FLEET_APPLY_TICKER_BUDGET_MS ?? "40000");
		const intervalMs = Number(process.env.IAC_FLEET_APPLY_TICKER_INTERVAL_MS ?? "10000");
```

After:
```typescript
		const budgetMs = readPositiveMsEnv("IAC_FLEET_APPLY_TICKER_BUDGET_MS", 40000, log);
		const intervalMs = readPositiveMsEnv("IAC_FLEET_APPLY_TICKER_INTERVAL_MS", 10000, log);
```

- [ ] **Step 5: Replace the second `IAC_PIPELINE_POLL_INTERVAL_MS`/`IAC_PIPELINE_POLL_BUDGET_MS` call site (~line 11121-11122)**

Before:
```typescript
		const budgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
		const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
```

After:
```typescript
		const budgetMs = readPositiveMsEnv("IAC_PIPELINE_POLL_BUDGET_MS", 90000, log);
		const intervalMs = readPositiveMsEnv("IAC_PIPELINE_POLL_INTERVAL_MS", 10000, log);
```

Note: confirm the exact line numbers with `grep -n "Number(process.env" packages/agent/src/iac/nodes.ts` before editing, since line numbers may have shifted slightly from this plan's authoring snapshot.

- [ ] **Step 6: Verify no raw `Number(process.env` reads remain for these vars**

Run: `grep -n "Number(process.env.IAC_\|Number(process.env.ELASTIC_IAC_DRIFT_CONCURRENCY" packages/agent/src/iac/nodes.ts`
Expected: no output (all replaced).

- [ ] **Step 7: Typecheck, lint, and run the iac node test suite**

Run: `bun run typecheck && bun run lint && bun run --filter '@devops-agent/agent' test`
Expected: no errors; existing tests for `nodes.ts` (watchPipeline, driftCheck, fleet-apply) still pass unchanged, since all valid-input behavior is identical to before.

- [ ] **Step 8: Commit**

Get explicit user authorization before committing (per this repo's "never commit without explicit user authorization" rule), then:

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-1308: validate IaC poll-budget/interval env vars in nodes.ts"
```

---

### Task 3: Wire helpers into packages/mcp-server-elastic-iac/src/tools/gitlab.ts

**Files:**
- Modify: `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` (4 call sites: lines ~650, ~651, ~662, ~666)

**Interfaces:**
- Consumes: `readPositiveMsEnv`, `readPositiveIntEnv` from `@devops-agent/shared` (Task 1)
- Consumes: existing `log` variable already defined at module scope in this file (`const log = createContextLogger("gitlab");`, line 9) -- no new logger needs to be created.

- [ ] **Step 1: Add the import**

In `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`, this file currently has no import from `@devops-agent/shared`. Add a new import line after the existing `import { z } from "zod";` (line 3):

```typescript
import { readPositiveIntEnv, readPositiveMsEnv } from "@devops-agent/shared";
```

- [ ] **Step 2: Replace the drift poll budget/interval reads (~line 650-651)**

Before:
```typescript
	const DRIFT_POLL_BUDGET_MS = Number(process.env.ELASTIC_IAC_DRIFT_POLL_BUDGET_MS ?? "90000");
	const DRIFT_POLL_INTERVAL_MS = Number(process.env.ELASTIC_IAC_DRIFT_POLL_INTERVAL_MS ?? "5000");
```

After:
```typescript
	const DRIFT_POLL_BUDGET_MS = readPositiveMsEnv("ELASTIC_IAC_DRIFT_POLL_BUDGET_MS", 90000, log);
	const DRIFT_POLL_INTERVAL_MS = readPositiveMsEnv("ELASTIC_IAC_DRIFT_POLL_INTERVAL_MS", 5000, log);
```

- [ ] **Step 3: Replace the fleet-apply poll budget read (~line 662)**

Before:
```typescript
	const FLEET_APPLY_POLL_BUDGET_MS = Number(process.env.ELASTIC_IAC_FLEET_APPLY_POLL_BUDGET_MS ?? "30000");
```

After:
```typescript
	const FLEET_APPLY_POLL_BUDGET_MS = readPositiveMsEnv("ELASTIC_IAC_FLEET_APPLY_POLL_BUDGET_MS", 30000, log);
```

- [ ] **Step 4: Replace the drift-fail-log-tail-bytes read (~line 666)**

Before:
```typescript
	const DRIFT_FAIL_LOG_TAIL_BYTES = Number(process.env.ELASTIC_IAC_DRIFT_FAIL_LOG_TAIL_BYTES ?? "16000");
```

After:
```typescript
	const DRIFT_FAIL_LOG_TAIL_BYTES = readPositiveIntEnv("ELASTIC_IAC_DRIFT_FAIL_LOG_TAIL_BYTES", 16000, log);
```

- [ ] **Step 5: Verify no raw `Number(process.env` reads remain for these vars**

Run: `grep -n "Number(process.env.ELASTIC_IAC" packages/mcp-server-elastic-iac/src/tools/gitlab.ts`
Expected: no output (all replaced).

- [ ] **Step 6: Confirm the package.json dependency already exists**

Run: `grep -n "@devops-agent/shared" packages/mcp-server-elastic-iac/package.json`
Expected: `"@devops-agent/shared": "workspace:*"` already present (confirmed during design investigation) -- no package.json change needed.

- [ ] **Step 7: Typecheck, lint, and run the mcp-server-elastic-iac test suite**

Run: `bun run typecheck && bun run lint && bun run --filter '@devops-agent/mcp-server-elastic-iac' test`
Expected: no errors; existing tests for `gitlab.ts` drift/fleet-apply tools still pass unchanged.

- [ ] **Step 8: Commit**

Get explicit user authorization before committing (per this repo's "never commit without explicit user authorization" rule), then:

```bash
git add packages/mcp-server-elastic-iac/src/tools/gitlab.ts
git commit -m "SIO-1308: validate IaC poll-budget/interval env vars in gitlab.ts"
```

---

### Task 4: Full verification pass and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full verification suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green, no regressions anywhere in the monorepo.

- [ ] **Step 2: Manually verify one invalid-input case end-to-end**

Run:
```bash
IAC_PIPELINE_POLL_INTERVAL_MS=not-a-number bun -e '
import { readPositiveMsEnv } from "./packages/shared/src/env-validation.ts";
const log = { warn: (obj, msg) => console.log("WARN:", msg, obj) };
console.log("result:", readPositiveMsEnv("IAC_PIPELINE_POLL_INTERVAL_MS", 10000, log));
'
```
Expected output:
```text
WARN: invalid env var, falling back to default { name: 'IAC_PIPELINE_POLL_INTERVAL_MS', raw: 'not-a-number', defaultValue: 10000 }
result: 10000
```

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin claude/serene-poitras-ef4473
gh pr create --title "SIO-1308: validate IaC poll-budget/interval env vars with Zod" --body "$(cat <<'EOF'
## Summary
- Adds `readPositiveMsEnv`/`readPositiveIntEnv` shared helpers (Zod-backed, warn-and-fallback on invalid input) to replace raw `Number(process.env.X ?? default)` reads
- Applies them across all 10 poll-budget/interval/count env vars in `packages/agent/src/iac/nodes.ts` and `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`, closing out the CodeRabbit finding from PR #552 consistently rather than just the 2 vars it flagged
- No default values changed; invalid input now logs a warning and falls back instead of silently propagating NaN/0/Infinity into poll loops

## Test plan
- [x] `bun run typecheck && bun run lint && bun run test` all pass
- [x] New unit tests in `packages/shared/src/__tests__/env-validation.test.ts` cover valid/unset/NaN/zero/negative/Infinity/fractional cases for both helpers
- [x] Manual verification of warn-and-fallback behavior via inline bun script

Linear: https://linear.app/siobytes/issue/SIO-1308/add-zod-validation-for-iac-poll-budgetinterval-env-vars

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Move the Linear issue to "In Review"**

Update SIO-1308 status to "In Review" once the PR is open (do not set to "Done" -- that requires explicit user approval per CLAUDE.md, and a merged-PR link auto-transitions it anyway per existing project convention).
