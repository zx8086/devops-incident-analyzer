# Renovate Trigger Card Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the `renovate_trigger_choice` approval card with the currently-installed integration version, target version, count of affected Fleet agent policies, and a version-range changelog — all sourced from data already reachable via existing credentials, with zero new environment variables.

**Architecture:** A new best-effort node, `enrichRenovateTarget`, runs between `resolveRenovateMarker` and `renovateTriggerGate` in the `renovate-integration-update` sub-flow. It calls Kibana's Fleet API (reusing the existing `ELASTIC_<DEPLOYMENT>_URL`/`_API_KEY` env vars, with the Kibana URL derived by a `.es.` → `.kb.` hostname substitution) for installed-version/target-version/policy-count, and fetches `elastic/integrations`' per-package `changelog.yml` via `raw.githubusercontent.com` (no auth) for the changelog. Both calls fail independently and silently — the node never blocks the turn or the approval gate. Four new state fields carry the enrichment through the existing SSE/reducer/card pipeline that `marker`/`line`/`message` already use.

**Tech Stack:** TypeScript (Bun), LangGraph (`@langchain/langgraph`), Svelte 5 runes, Tailwind, the `yaml` package (already a workspace dependency) for changelog parsing, native `fetch` for both external calls (no new SDK/dependency).

**Spec:** `docs/superpowers/specs/2026-08-16-renovate-trigger-card-enrichment-design.md`

## Global Constraints

- No new environment variables. Reuse `ELASTIC_<DEPLOYMENT>_URL` / `ELASTIC_<DEPLOYMENT>_API_KEY` for both Elasticsearch (already used) and Kibana (new use) — derive the Kibana URL via `.es.` → `.kb.` hostname substitution; do not hardcode a `KIBANA_*` variable.
- Every new external call (Kibana Fleet, GitHub raw changelog) is best-effort: on failure, log at `warn` via `log.warn(...)`, return no enrichment fields, and NEVER set `blockedReason` — the approval gate must always be reachable, per the spec's explicit "best-effort" decision.
- `packages/agent/src/iac/nodes.ts` never imports MCP-server-side code (`mcp-server-elastic`, `mcp-server-elastic-iac`) — the deployment-id-to-env-var-suffix logic (`id.toUpperCase().replace(/-/g, "_")`) is small enough to duplicate inline, matching this file's own `renovateProjectId()` precedent ("read inside the node, not module scope").
- All 4 new state fields (`renovateInstalledVersion`, `renovateTargetVersion`, `renovatePolicyCount`, `renovateChangelog`) MUST be added to `TURN_START_RESET` in the same commit that adds them to `state.ts` — PR #663's round-1 Greptile finding was exactly a field left out of `TURN_START_RESET` leaking stale data across turns. Do not repeat that bug.
- TypeScript strict mode, no `any`. Zod for any new runtime-validated boundary (the SSE event schema addition).
- Tailwind-only styling in the Svelte card — no custom `<style>` blocks.
- TDD: write the failing test first for every pure helper, watch it fail, then implement.

---

### Task 1: `parseRenovateTargetVersion` + `compareSemver` pure helpers

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add both functions near `buildRenovateGateMessage`, around line 415 — after the existing renovate helpers, before `renovateTriggerGate`)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (append new `describe` blocks at the end of the file, after the existing `describe("TURN_START_RESET (renovate-integration-update fields)", ...)` block)

**Interfaces:**
- Consumes: nothing new — `parseRenovateTargetVersion` takes the same `marker.line` string shape already used by `buildRenovateGateMessage` (e.g. `" - [ ] <!-- unschedule-branch=renovate/eu-onboarding-elastic_agent -->chore(deps): [eu-onboarding] elastic_agent to v2.9.4"`).
- Produces: `parseRenovateTargetVersion(line: string): string | null` — the target version WITHOUT the `v` prefix (e.g. `"2.9.4"`), or `null` if the line doesn't match the expected `to vX.Y.Z` suffix. `compareSemver(a: string, b: string): number` — standard comparator (negative if `a < b`, 0 if equal, positive if `a > b`), used by Task 2's `filterChangelogRange`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to packages/agent/src/iac/renovate-integration.test.ts, after the existing
// describe("TURN_START_RESET (renovate-integration-update fields)", ...) block.
import { compareSemver, parseRenovateTargetVersion } from "./nodes.ts";

describe("parseRenovateTargetVersion", () => {
	test("parses the target version from a real dashboard line", () => {
		const line =
			" - [ ] <!-- unschedule-branch=renovate/eu-onboarding-elastic_agent -->chore(deps): [eu-onboarding] elastic_agent to v2.9.4";
		expect(parseRenovateTargetVersion(line)).toBe("2.9.4");
	});

	test("parses a version with only major.minor (no patch)", () => {
		const line = " - [ ] <!-- unschedule-branch=x -->chore(deps): [eu-b2b] system to v2.22";
		expect(parseRenovateTargetVersion(line)).toBe("2.22");
	});

	test("returns null when the line has no 'to vX.Y.Z' suffix", () => {
		expect(parseRenovateTargetVersion("chore(deps): bump something")).toBeNull();
	});

	test("returns null for an empty string", () => {
		expect(parseRenovateTargetVersion("")).toBeNull();
	});
});

describe("compareSemver", () => {
	test("orders a lower version before a higher one", () => {
		expect(compareSemver("2.8.0", "2.9.4")).toBeLessThan(0);
	});

	test("orders a higher version after a lower one", () => {
		expect(compareSemver("2.9.4", "2.8.0")).toBeGreaterThan(0);
	});

	test("returns 0 for equal versions", () => {
		expect(compareSemver("2.9.4", "2.9.4")).toBe(0);
	});

	test("compares patch versions correctly (numeric, not lexical)", () => {
		// Lexical comparison would wrongly order "2.9.10" before "2.9.9" -- must compare numerically.
		expect(compareSemver("2.9.9", "2.9.10")).toBeLessThan(0);
	});

	test("treats a missing patch component as 0", () => {
		expect(compareSemver("2.22", "2.22.1")).toBeLessThan(0);
		expect(compareSemver("2.22.0", "2.22")).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "parseRenovateTargetVersion|compareSemver"`
Expected: FAIL — `parseRenovateTargetVersion is not a function` / `compareSemver is not a function`.

- [ ] **Step 3: Implement both functions**

Add to `packages/agent/src/iac/nodes.ts`, immediately after `buildRenovateGateMessage` (after line 415, before `renovateTriggerGate` at line 419):

```typescript
// The dashboard line's title always ends "... to vX.Y[.Z]" (Renovate's own generated format,
// live-verified across every entry in the Elastic Fleet & Agent Dependency Dashboard this
// session -- e.g. "chore(deps): [eu-onboarding] elastic_agent to v2.9.4"). Extracts just the
// version, without the "v" prefix, for use as the changelog range's upper bound. (Pure; unit-tested.)
export function parseRenovateTargetVersion(line: string): string | null {
	const match = line.match(/\bto\s+v(\d+(?:\.\d+){1,2})\s*$/);
	return match?.[1] ?? null;
}

// Numeric (not lexical) semver comparison for filterChangelogRange -- a missing component
// (e.g. "2.22" vs "2.22.1") is treated as 0. Deliberately minimal: no pre-release/build-metadata
// handling, since every version this sub-flow compares (Renovate dashboard targets, Kibana
// installationInfo.version, changelog.yml entries) is a plain X.Y[.Z] release. (Pure; unit-tested.)
export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "parseRenovateTargetVersion|compareSemver"`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add parseRenovateTargetVersion + compareSemver pure helpers"
```

---

### Task 2: `filterChangelogRange` pure helper

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add near the Task 1 helpers)
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `compareSemver` from Task 1.
- Produces:
```typescript
export interface ChangelogEntry {
	version: string;
	changes: Array<{ description: string; type: string; link?: string }>;
}
export function filterChangelogRange(
	entries: ChangelogEntry[],
	installedVersion: string | null,
	targetVersion: string,
): ChangelogEntry[]
```
Filters `entries` (assumed already newest-first, matching `changelog.yml`'s own source order — see Task 4) to those where `installedVersion < entry.version <= targetVersion`. When `installedVersion` is `null` (Kibana lookup unavailable), returns only the entry exactly matching `targetVersion` (0 or 1 entries) — the spec's documented degraded fallback, since a range can't be computed without a lower bound.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to packages/agent/src/iac/renovate-integration.test.ts
import { type ChangelogEntry, filterChangelogRange } from "./nodes.ts";

describe("filterChangelogRange", () => {
	const entries: ChangelogEntry[] = [
		{ version: "2.9.4", changes: [{ description: "Add system.cpu.cores", type: "enhancement" }] },
		{ version: "2.9.3", changes: [{ description: "Fix X", type: "bugfix" }] },
		{ version: "2.9.1", changes: [{ description: "Fix Y", type: "bugfix" }] },
		{ version: "2.8.1", changes: [{ description: "Fix Z", type: "bugfix" }] },
		{ version: "2.8.0", changes: [{ description: "Initial", type: "enhancement" }] },
	];

	test("returns every entry strictly above installed and up to and including target", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.4");
		expect(result.map((e) => e.version)).toEqual(["2.9.4", "2.9.3", "2.9.1", "2.8.1"]);
	});

	test("excludes the installed version itself", () => {
		const result = filterChangelogRange(entries, "2.8.1", "2.9.4");
		expect(result.map((e) => e.version)).not.toContain("2.8.1");
	});

	test("excludes versions above the target", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.1");
		expect(result.map((e) => e.version)).toEqual(["2.9.1", "2.8.1"]);
	});

	test("returns an empty array when installed already equals target", () => {
		expect(filterChangelogRange(entries, "2.9.4", "2.9.4")).toEqual([]);
	});

	test("falls back to only the target version's own entry when installedVersion is null", () => {
		const result = filterChangelogRange(entries, null, "2.9.3");
		expect(result.map((e) => e.version)).toEqual(["2.9.3"]);
	});

	test("returns an empty array when installedVersion is null and the target has no matching entry", () => {
		expect(filterChangelogRange(entries, null, "3.0.0")).toEqual([]);
	});

	test("preserves newest-first order from the input", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.4");
		for (let i = 1; i < result.length; i++) {
			expect(compareSemverForTest(result[i - 1].version, result[i].version)).toBeGreaterThanOrEqual(0);
		}
	});
});

// Local helper for the ordering assertion above -- avoids re-exporting compareSemver just for the test.
function compareSemverForTest(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "filterChangelogRange"`
Expected: FAIL — `filterChangelogRange is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/agent/src/iac/nodes.ts`, immediately after `compareSemver`:

```typescript
export interface ChangelogEntry {
	version: string;
	changes: Array<{ description: string; type: string; link?: string }>;
}

// Filters a package's changelog.yml entries (already newest-first, matching the source file's
// own order -- see fetchRenovateChangelog) to the range the operator is actually upgrading
// through: strictly above the installed version, up to and including the target. When
// installedVersion is unknown (Kibana lookup skipped/failed/never-installed), the range can't
// be computed -- falls back to showing only the target version's own entry (the spec's
// documented degraded behavior, not the default). (Pure; unit-tested.)
export function filterChangelogRange(
	entries: ChangelogEntry[],
	installedVersion: string | null,
	targetVersion: string,
): ChangelogEntry[] {
	if (installedVersion === null) {
		return entries.filter((e) => compareSemver(e.version, targetVersion) === 0);
	}
	return entries.filter(
		(e) => compareSemver(e.version, installedVersion) > 0 && compareSemver(e.version, targetVersion) <= 0,
	);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "filterChangelogRange"`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add filterChangelogRange pure helper"
```

---

### Task 3: State fields + `TURN_START_RESET`

**Files:**
- Modify: `packages/agent/src/iac/state.ts` (add 4 fields after `renovateTriggerAtIso` at line 799)
- Modify: `packages/agent/src/iac/nodes.ts` (add the same 4 fields to `TURN_START_RESET`, after `renovateTriggerAtIso: ""` at line 1307)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend the existing `describe("TURN_START_RESET (renovate-integration-update fields)", ...)` block — do not create a new describe block, this is the established home for this exact assertion)

**Interfaces:**
- Produces: 4 new fields on `IacStateType`, consumed by Task 4 (`enrichRenovateTarget` writes them) and Task 6 (the card reads them via the SSE/reducer chain).

```typescript
renovateInstalledVersion: string | null;   // e.g. "2.8.0", null if unknown/never-installed
renovateTargetVersion: string | null;      // e.g. "2.9.4", null if not parsed
renovatePolicyCount: number | null;        // e.g. 64, null if Kibana lookup unavailable
renovateChangelog: ChangelogEntry[];       // [] if unavailable; ChangelogEntry from Task 2
```

- [ ] **Step 1: Write the failing test**

First read the CURRENT full `TURN_START_RESET` test to extend it correctly:

```bash
grep -n "TURN_START_RESET (renovate-integration-update fields)" -A 30 packages/agent/src/iac/renovate-integration.test.ts
```

Then edit that existing `test(...)` block (do not add a new one) so its expected object includes the 4 new fields at their reset values:

```typescript
// Inside the existing describe("TURN_START_RESET (renovate-integration-update fields)", ...)
// block, extend the existing test's expected object (do not duplicate the describe block):
test("resets all 10 renovate-integration-update fields", () => {
	expect(TURN_START_RESET).toMatchObject({
		renovateTarget: null,
		renovateCandidates: [],
		renovateMarker: null,
		renovateTriggerApproved: null,
		renovateIssueIid: null,
		renovateMrUrl: "",
		renovateTriggerAtIso: "",
		renovateInstalledVersion: null,
		renovateTargetVersion: null,
		renovatePolicyCount: null,
		renovateChangelog: [],
	});
});
```

(Read the actual existing test first and adapt this to its real current shape/name rather than assuming — the test may already assert via multiple smaller expectations rather than one `toMatchObject`; extend whichever shape is actually there so the diff is additive, not a rewrite.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: FAIL — the actual `TURN_START_RESET` object is missing the 4 new keys, so `toMatchObject` fails (or a property-existence assertion fails, depending on the existing test's exact shape).

- [ ] **Step 3: Add the state fields**

In `packages/agent/src/iac/state.ts`, immediately after line 799 (`renovateTriggerAtIso: Annotation<string>({ reducer: last, default: () => "" }),`):

```typescript
	// SIO-XXXX: pre-trigger enrichment for the renovate_trigger_choice card (installed/target
	// version, affected-policy count, and a version-range changelog), set by enrichRenovateTarget.
	// All four are best-effort -- null/[] when Kibana or the GitHub changelog fetch is unavailable,
	// never a signal that anything went wrong (the card degrades to today's plain marker/line text).
	renovateInstalledVersion: Annotation<string | null>({ reducer: last, default: () => null }),
	renovateTargetVersion: Annotation<string | null>({ reducer: last, default: () => null }),
	renovatePolicyCount: Annotation<number | null>({ reducer: last, default: () => null }),
	renovateChangelog: Annotation<Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>>({
		reducer: last,
		default: () => [],
	}),
```

- [ ] **Step 4: Add the same 4 fields to `TURN_START_RESET`**

In `packages/agent/src/iac/nodes.ts`, immediately after line 1307 (`renovateTriggerAtIso: "",`), before the closing `} as const;`:

```typescript
	renovateInstalledVersion: null,
	renovateTargetVersion: null,
	renovatePolicyCount: null,
	renovateChangelog: [] as Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>,
```

(Follow the exact same cast pattern the file already uses for `renovateCandidates: [] as Array<{ marker: string; line: string }>` at line 1302 — an array-typed field inside an `as const` object needs its own cast, since `as const` on the whole object would make a bare `[]` a readonly tuple, incompatible with the mutable state annotation type. This is the identical gotcha PR #663 already hit once for `renovateCandidates`; do not rediscover it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd packages/agent && bun run typecheck` (or from repo root: `bun run typecheck` — expect `@devops-agent/agent: Exited with code 0`; the pre-existing unrelated `mcp-server-couchbase` TS7031 errors are not this task's concern, per prior sessions' established baseline).
Expected: 0 errors for `@devops-agent/agent`.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add renovate card enrichment state fields + TURN_START_RESET"
```

---

### Task 4: `enrichRenovateTarget` node

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add the new node function after `resolveRenovateMarker`, before `buildRenovateGateMessage` — i.e. after line 409, before line 411)
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `state.renovateTarget` (`{deployment, integration}`, set by `extractRenovateTarget`), `state.renovateMarker` (`{marker, line}`, set by `resolveRenovateMarker`), `parseRenovateTargetVersion`/`compareSemver`/`filterChangelogRange`/`ChangelogEntry` from Tasks 1–2.
- Produces: `export async function enrichRenovateTarget(state: IacStateType): Promise<Partial<IacStateType>>` returning some/none of `{renovateInstalledVersion, renovateTargetVersion, renovatePolicyCount, renovateChangelog}` — NEVER `blockedReason`, NEVER throws (all failures caught internally).
- Also produces two small internal (non-exported) helpers used only by this node — `resolveKibanaConfig(deployment: string): {url: string; apiKey: string} | null` and `fetchRenovateChangelog(integration: string): Promise<ChangelogEntry[]>` — kept internal since neither has an existing test-worthy pure-logic shape on its own (both are thin I/O wrappers); their behavior is exercised through `enrichRenovateTarget`'s own tests below via mocked `fetch`.

- [ ] **Step 1: Write the failing tests**

These tests mock global `fetch` (this repo's established pattern for testing external-call nodes — confirm by checking an existing example, e.g. grep `mock(global.fetch` or similar in a sibling `*.test.ts` file, and match its exact mocking style before writing these). Read one such example first:

```bash
grep -rln "global.fetch\|globalThis.fetch" packages/agent/src/iac/*.test.ts | head -3
```

Then write (adapting the mock style to match whatever that grep turns up):

```typescript
// Append to packages/agent/src/iac/renovate-integration.test.ts
import { enrichRenovateTarget } from "./nodes.ts";

describe("enrichRenovateTarget (SIO-XXXX)", () => {
	const ORIGINAL_FETCH = globalThis.fetch;
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		process.env = { ...ORIGINAL_ENV };
	});

	function baseState(): Partial<IacStateType> {
		return {
			renovateTarget: { deployment: "eu-onboarding", integration: "elastic_agent" },
			renovateMarker: {
				marker: "renovate/eu-onboarding-elastic_agent",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-onboarding-elastic_agent -->chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			},
		};
	}

	test("returns installed/target/policyCount from a successful Kibana call, changelog empty when GitHub call not mocked to succeed", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		globalThis.fetch = (async (url: string) => {
			if (url.includes("/api/fleet/epm/packages/")) {
				return new Response(
					JSON.stringify({ version: "2.9.4", installationInfo: { version: "2.8.0" }, packagePoliciesInfo: { count: 24 } }),
					{ status: 200 },
				);
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion).toBe("2.8.0");
		expect(out.renovateTargetVersion).toBe("2.9.4");
		expect(out.renovatePolicyCount).toBe(24);
		expect(out.renovateChangelog).toEqual([]);
		expect(out.blockedReason).toBeUndefined();
	});

	test("also returns a filtered changelog when the GitHub fetch succeeds", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		const changelogYaml = [
			'- version: "2.9.4"',
			"  changes:",
			'    - description: "Add system.cpu.cores"',
			"      type: enhancement",
			'- version: "2.8.0"',
			"  changes:",
			'    - description: "Initial"',
			"      type: enhancement",
		].join("\n");
		globalThis.fetch = (async (url: string) => {
			if (url.includes("/api/fleet/epm/packages/")) {
				return new Response(
					JSON.stringify({ version: "2.9.4", installationInfo: { version: "2.8.0" }, packagePoliciesInfo: { count: 24 } }),
					{ status: 200 },
				);
			}
			if (url.includes("raw.githubusercontent.com")) {
				return new Response(changelogYaml, { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateChangelog).toEqual([
			{ version: "2.9.4", changes: [{ description: "Add system.cpu.cores", type: "enhancement" }] },
		]);
	});

	test("degrades cleanly when ELASTIC_<DEPLOYMENT>_URL is unset for this deployment", async () => {
		delete process.env.ELASTIC_EU_ONBOARDING_URL;
		delete process.env.ELASTIC_EU_ONBOARDING_API_KEY;
		globalThis.fetch = (async () => new Response("should not be called", { status: 500 })) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.renovatePolicyCount ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana call errors (network failure)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		globalThis.fetch = (async () => {
			throw new Error("connection reset");
		}) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana call returns a non-2xx status", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the changelog fetch 404s (package not found)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		globalThis.fetch = (async (url: string) => {
			if (url.includes("/api/fleet/epm/packages/")) {
				return new Response(JSON.stringify({ version: "2.9.4", installationInfo: { version: "2.8.0" } }), { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion).toBe("2.8.0"); // Kibana part still succeeded
		expect(out.renovateChangelog).toEqual([]); // changelog part degraded independently
		expect(out.blockedReason).toBeUndefined();
	});

	test("derives the Kibana URL from ELASTIC_<DEPLOYMENT>_URL via .es. -> .kb. substitution", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		let calledUrl = "";
		globalThis.fetch = (async (url: string) => {
			if (url.includes("/api/fleet/epm/packages/")) {
				calledUrl = url;
				return new Response(JSON.stringify({ version: "2.9.4" }), { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		await enrichRenovateTarget(baseState() as IacStateType);

		expect(calledUrl.startsWith("https://eu-onboarding.kb.eu-central-1.aws.cloud.es.io")).toBe(true);
	});

	test("returns no enrichment (all null/[]) when renovateTarget is missing", async () => {
		const out = await enrichRenovateTarget({ renovateMarker: baseState().renovateMarker } as IacStateType);
		expect(out).toEqual({});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "enrichRenovateTarget"`
Expected: FAIL — `enrichRenovateTarget is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/agent/src/iac/nodes.ts`, after `resolveRenovateMarker` (after line 409), before `buildRenovateGateMessage`:

```typescript
// Resolves this deployment's existing Elasticsearch env-var pair and derives the Kibana URL
// from it (.es. -> .kb. hostname substitution -- live-verified across 9 of this repo's 10
// configured deployments this session, spanning 3 different Elastic Cloud domain suffixes).
// The SAME ELASTIC_<DEPLOYMENT>_API_KEY authenticates against both Elasticsearch and Kibana
// (also live-verified) -- no separate Kibana credential exists or is needed. null when the
// deployment has no ELASTIC_<DEPLOYMENT>_URL configured, or its hostname doesn't contain ".es."
// to substitute (an unexpected shape -- degrade rather than guess).
function resolveKibanaConfig(deployment: string): { url: string; apiKey: string } | null {
	const suffix = deployment.toUpperCase().replace(/-/g, "_");
	const esUrl = process.env[`ELASTIC_${suffix}_URL`];
	const apiKey = process.env[`ELASTIC_${suffix}_API_KEY`];
	if (!esUrl || !apiKey) return null;
	if (!esUrl.includes(".es.")) return null;
	return { url: esUrl.replace(".es.", ".kb."), apiKey };
}

// elastic/integrations' per-package changelog.yml, fetched via raw.githubusercontent.com --
// no auth needed (public repo), no gh-CLI subprocess dependency (this file has never shelled
// out to an external CLI; a raw-content HTTP GET is a strictly better fit for a server-side
// node than depending on a local `gh` install). Returns [] on any failure (404 for an
// integration with no changelog.yml, network error, malformed YAML) -- best-effort, this
// function never throws. (Not exported: a thin I/O wrapper, exercised via enrichRenovateTarget's
// own mocked-fetch tests rather than in isolation.)
async function fetchRenovateChangelog(integration: string): Promise<ChangelogEntry[]> {
	try {
		const res = await fetch(
			`https://raw.githubusercontent.com/elastic/integrations/main/packages/${integration}/changelog.yml`,
		);
		if (!res.ok) return [];
		const text = await res.text();
		const parsed = parseYaml(text);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(e): e is ChangelogEntry =>
					typeof e === "object" && e !== null && typeof e.version === "string" && Array.isArray(e.changes),
			)
			.map((e) => ({
				version: e.version,
				changes: e.changes
					.filter((c: unknown): c is { description: string; type: string; link?: string } => typeof (c as { description?: unknown })?.description === "string")
					.map((c: { description: string; type?: string; link?: string }) => ({
						description: c.description,
						type: typeof c.type === "string" ? c.type : "unknown",
						...(typeof c.link === "string" && { link: c.link }),
					})),
			}));
	} catch {
		return [];
	}
}

// Best-effort pre-trigger enrichment for the renovate_trigger_choice card: currently-installed
// version, target version, affected-policy count (all from one Kibana Fleet call, reusing the
// existing ELASTIC_<DEPLOYMENT>_URL/_API_KEY -- see resolveKibanaConfig), and a version-range
// changelog (from elastic/integrations on GitHub, no credential needed -- see
// fetchRenovateChangelog). Inserted between resolveRenovateMarker and renovateTriggerGate;
// reached only when hasSingleRenovateMatch routed here (graph.ts). NEVER sets blockedReason and
// NEVER throws -- every external call is independently wrapped so a Kibana failure does not
// suppress a working changelog fetch or vice versa, and any failure degrades the card to
// today's plain marker/line text rather than blocking the approval gate.
export async function enrichRenovateTarget(state: IacStateType): Promise<Partial<IacStateType>> {
	const target = state.renovateTarget;
	const marker = state.renovateMarker;
	if (!target || !marker) return {};

	const targetVersion = parseRenovateTargetVersion(marker.line);
	let installedVersion: string | null = null;
	let policyCount: number | null = null;
	let resolvedTargetVersion = targetVersion;

	const kibanaConfig = resolveKibanaConfig(target.deployment);
	if (kibanaConfig) {
		try {
			const res = await fetch(
				`${kibanaConfig.url}/api/fleet/epm/packages/${encodeURIComponent(target.integration)}?withPackagePoliciesCount=true`,
				{ headers: { Authorization: `ApiKey ${kibanaConfig.apiKey}`, "kbn-xsrf": "true" } },
			);
			if (res.ok) {
				const body = (await res.json()) as {
					version?: unknown;
					installationInfo?: { version?: unknown };
					packagePoliciesInfo?: { count?: unknown };
				};
				if (typeof body.installationInfo?.version === "string") installedVersion = body.installationInfo.version;
				if (typeof body.packagePoliciesInfo?.count === "number") policyCount = body.packagePoliciesInfo.count;
				if (!resolvedTargetVersion && typeof body.version === "string") resolvedTargetVersion = body.version;
			} else {
				log.warn(
					{ deployment: target.deployment, integration: target.integration, status: res.status },
					"enrichRenovateTarget: Kibana Fleet call returned non-2xx; continuing without installed-version enrichment",
				);
			}
		} catch (error) {
			log.warn(
				{ deployment: target.deployment, integration: target.integration, error: error instanceof Error ? error.message : String(error) },
				"enrichRenovateTarget: Kibana Fleet call failed; continuing without installed-version enrichment",
			);
		}
	}

	const changelog = resolvedTargetVersion
		? filterChangelogRange(await fetchRenovateChangelog(target.integration), installedVersion, resolvedTargetVersion)
		: [];

	return {
		renovateInstalledVersion: installedVersion,
		renovateTargetVersion: resolvedTargetVersion,
		renovatePolicyCount: policyCount,
		renovateChangelog: changelog,
	};
}
```

`nodes.ts` already imports from `"yaml"` (line 18: `import { isMap, parseDocument } from "yaml";`), but only `parseDocument`/`isMap` — used elsewhere in this file specifically for round-trip-preserving edits (`resolveUserSettingsKey` et al., where comment/formatting fidelity matters because that YAML gets written back). This changelog fetch only reads and discards, so use the simpler value-only `parse` instead (the same function `skill-manifest.ts`/`wiki/page.ts` already use for plain reads) — extend the existing import line to `import { isMap, parse as parseYaml, parseDocument } from "yaml";` rather than adding a second, separate `"yaml"` import statement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "enrichRenovateTarget"`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the full renovate test file + typecheck**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts && bun run typecheck`
Expected: all tests pass, 0 typecheck errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add enrichRenovateTarget best-effort enrichment node"
```

---

### Task 5: Wire `enrichRenovateTarget` into `graph.ts`

**Files:**
- Modify: `packages/agent/src/iac/graph.ts`

**Interfaces:**
- Consumes: `enrichRenovateTarget` from Task 4 (import alongside the existing `extractRenovateTarget`/`resolveRenovateMarker`/`renovateTriggerGate`/`triggerRenovateUpdate` imports at the top of the file, around line 29-47).
- Produces: an updated conditional edge — `resolveRenovateMarker` now routes to `enrichRenovateTarget` (not directly to `renovateTriggerGate`) on a single match; `enrichRenovateTarget` then always proceeds to `renovateTriggerGate` (unconditional edge, since this node never blocks).

- [ ] **Step 1: Add the node registration**

In `packages/agent/src/iac/graph.ts`, the import block (lines 25-48) is alphabetically sorted. Insert `enrichRenovateTarget,` between `detectSyntheticsDrift,` (line 26) and `explainDrift,` (line 27):
```typescript
	detectSyntheticsDrift,
	draftChange,
	enrichRenovateTarget,
	explainDrift,
	extractRenovateTarget,
```

Add the node registration after `.addNode("resolveRenovateMarker", resolveRenovateMarker)` (after line 182):
```typescript
		.addNode("enrichRenovateTarget", enrichRenovateTarget)
```

- [ ] **Step 2: Update the conditional edge**

Replace the existing edge at lines 337-341:
```typescript
		// Exactly one dashboard match -> the approval gate; 0 or 2+ -> teardown (the
		// disambiguation/no-match message is already set on state.messages).
		.addConditionalEdges(
			"resolveRenovateMarker",
			(s) => (hasSingleRenovateMatch(s.renovateCandidates) ? "renovateTriggerGate" : "teardown"),
			["renovateTriggerGate", "teardown"],
		)
```
with:
```typescript
		// Exactly one dashboard match -> enrichRenovateTarget (best-effort pre-gate context);
		// 0 or 2+ -> teardown (the disambiguation/no-match message is already set on
		// state.messages).
		.addConditionalEdges(
			"resolveRenovateMarker",
			(s) => (hasSingleRenovateMatch(s.renovateCandidates) ? "enrichRenovateTarget" : "teardown"),
			["enrichRenovateTarget", "teardown"],
		)
		// enrichRenovateTarget never blocks -- always proceeds to the approval gate.
		.addEdge("enrichRenovateTarget", "renovateTriggerGate")
```

- [ ] **Step 3: Verify the graph compiles and existing renovate tests still pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts && bun test src/iac/ && bun run typecheck`
Expected: all pass (the full `iac/` suite, not just the renovate file, since `graph.ts` is shared across every intent).

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/iac/graph.ts
git commit -m "SIO-XXXX: wire enrichRenovateTarget between resolveRenovateMarker and renovateTriggerGate"
```

---

### Task 6: Emit enrichment on the `renovate_trigger_choice` interrupt

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`renovateTriggerGate`, lines 419-440 — add the 4 new fields to the `interrupt({...})` payload)

**Interfaces:**
- Consumes: `state.renovateInstalledVersion`, `state.renovateTargetVersion`, `state.renovatePolicyCount`, `state.renovateChangelog` (all set by `enrichRenovateTarget` in Task 4, now guaranteed to run first per Task 5's graph edge).
- Produces: an extended interrupt payload — Task 7 updates the Zod schema that validates this shape, Task 8 updates the reducer/card that consumes it.

- [ ] **Step 1: Write the failing test**

The existing `describe("renovateTriggerGate interrupt round-trip (SIO-1471)", ...)` block already exercises this node via a real interrupt/resume round-trip. Add ONE new test to that existing block (do not create a new describe) that asserts the enrichment fields appear on the interrupt payload:

```typescript
// Inside the existing describe("renovateTriggerGate interrupt round-trip (SIO-1471)", ...) block:
test("interrupt payload carries the enrichment fields set by enrichRenovateTarget", async () => {
	const compiled = buildMiniGateGraph();
	const config = { configurable: { thread_id: `t-renovate-enrichment-${Date.now()}` } };
	const inputState = {
		requestId: "req-1",
		renovateMarker: marker,
		renovateInstalledVersion: "2.8.0",
		renovateTargetVersion: "2.9.4",
		renovatePolicyCount: 24,
		renovateChangelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	};

	await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

	// LangGraph's getState() returns a StateSnapshot whose .tasks[N].interrupts[N] array holds
	// each paused task's Interrupt objects; Interrupt.value is exactly the object passed to
	// interrupt({...}) inside the node (confirmed against @langchain/langgraph's own type
	// definitions: PregelTaskDescription.interrupts: Interrupt[], Interrupt<Value>.value?: Value).
	// This graph has exactly one node that can pause, so tasks[0].interrupts[0] is unambiguous.
	const after = await compiled.getState(config);
	const interruptValue = after.tasks[0]?.interrupts[0]?.value as Record<string, unknown> | undefined;
	expect(interruptValue).toMatchObject({
		installedVersion: "2.8.0",
		targetVersion: "2.9.4",
		policyCount: 24,
		changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "enrichment fields set by enrichRenovateTarget"`
Expected: FAIL (payload missing the new fields).

- [ ] **Step 3: Implement**

In `packages/agent/src/iac/nodes.ts`, update `renovateTriggerGate` (lines 419-427):

```typescript
export function renovateTriggerGate(state: IacStateType): Partial<IacStateType> {
	const marker = state.renovateMarker;
	if (!marker) return { renovateTriggerApproved: false };
	const choice = interrupt({
		type: "renovate_trigger_choice",
		marker: marker.marker,
		line: marker.line,
		message: buildRenovateGateMessage(marker),
		// SIO-XXXX: pre-trigger enrichment from enrichRenovateTarget -- best-effort, any/all may
		// be null/[] when Kibana or the changelog fetch was unavailable for this deployment.
		installedVersion: state.renovateInstalledVersion,
		targetVersion: state.renovateTargetVersion,
		policyCount: state.renovatePolicyCount,
		changelog: state.renovateChangelog,
	}) as { approve?: boolean };
	// ... rest of the function unchanged
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: full file passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: surface enrichment fields on the renovate_trigger_choice interrupt payload"
```

---

### Task 7: Shared SSE event schema

**Files:**
- Modify: `packages/shared/src/agent-state.ts` (the `renovate_trigger_choice` object in `StreamEventSchema`, lines 1238-1244)
- Create: `packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts` — this repo's established convention for schema-shape tests (confirmed: `packages/shared/src/__tests__/agent-state.tool-error-recovery.test.ts` and `agent-state.aws-atlassian.test.ts` both live in `__tests__/`, named `agent-state.<topic>.test.ts`, and test individual schemas via `describe(SchemaName, ...)` + `Schema.safeParse({...})` — the same pattern this task follows against `StreamEventSchema` directly, since the `renovate_trigger_choice` object isn't separately exported).

**Interfaces:**
- Produces: `StreamEventSchema`'s `renovate_trigger_choice` variant gains 4 new OPTIONAL fields (optional because a stale/older backend build could theoretically omit them, and Zod validation must not reject a valid-but-older payload shape).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts
import { describe, expect, test } from "bun:test";
import { StreamEventSchema } from "../agent-state.ts";

describe("StreamEventSchema renovate_trigger_choice enrichment fields", () => {
	test("accepts the event with all 4 enrichment fields present", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "renovate/eu-onboarding-elastic_agent",
			line: "chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			message: "This will tick...",
			installedVersion: "2.8.0",
			targetVersion: "2.9.4",
			policyCount: 24,
			changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement", link: "https://x" }] }],
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts the event with all 4 enrichment fields absent (older/degraded payload)", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts null for installedVersion/targetVersion/policyCount (Kibana lookup unavailable)", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
			installedVersion: null,
			targetVersion: null,
			policyCount: null,
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects a changelog entry missing the required description field", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
			changelog: [{ version: "2.9.4", changes: [{ type: "enhancement" }] }],
		});
		expect(parsed.success).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: FAIL — the first two tests fail because the schema doesn't recognize the new keys yet under `.strict()`-adjacent Zod behavior, or more precisely: check whether `StreamEventSchema`'s object variants use `.strict()`/`.strip()`/default (Zod v4 default strips unknown keys silently rather than rejecting — if so, tests 1 and 3 may currently PASS by silently dropping the new fields, which is itself the wrong behavior this task fixes). Before proceeding, run the tests and read the actual failure/pass output rather than assuming — if test 1 passes today because Zod strips unknown keys, add an explicit assertion `expect(parsed.data?.installedVersion).toBe("2.8.0")` (not just `.success`) to make the RED state real: the data is present in test 1's input but stripped from `parsed.data` until Step 3 adds the fields to the schema.

- [ ] **Step 3: Update the schema**

In `packages/shared/src/agent-state.ts`, replace lines 1238-1244:

```typescript
	// SIO-XXXX: renovate-integration-update trigger sub-flow. The single operator
	// approve/decline gate (renovateTriggerGate), surfaced with the thread's id. No
	// dedicated result event -- the turn just ends with a final message. installedVersion/
	// targetVersion/policyCount/changelog are pre-trigger enrichment from enrichRenovateTarget --
	// all optional/best-effort, absent when Kibana or the GitHub changelog lookup failed for
	// this deployment (the card degrades to the plain marker/line text in that case).
	z.object({
		type: z.literal("renovate_trigger_choice"),
		threadId: z.string(),
		marker: z.string(),
		line: z.string(),
		message: z.string(),
		installedVersion: z.string().nullable().optional(),
		targetVersion: z.string().nullable().optional(),
		policyCount: z.number().nullable().optional(),
		changelog: z
			.array(
				z.object({
					version: z.string(),
					changes: z.array(
						z.object({
							description: z.string(),
							type: z.string(),
							link: z.string().optional(),
						}),
					),
				}),
			)
			.optional(),
	}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Typecheck**

Run: `cd packages/shared && bun run typecheck` (or repo root `bun run typecheck`, checking `@devops-agent/shared: Exited with code 0`).
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/agent-state.ts packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: extend renovate_trigger_choice SSE schema with enrichment fields"
```

---

### Task 8: `sse-pump.ts` + `agent-reducer.ts` — thread enrichment through to the store

**Files:**
- Modify: `apps/web/src/lib/server/sse-pump.ts` (the `renovate_trigger_choice` branch, lines 891-899)
- Modify: `apps/web/src/lib/stores/agent-reducer.ts` (the `RenovateTriggerChoice` interface at lines 310-315, and the `renovate_trigger_choice` reducer case at lines 828-838)
- Create: `apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts` — no reducer test file exists in this repo today (confirmed: `find apps/web/src -iname "*agent-reducer*test*"` returns nothing), so this is a new file, not an extension. This is the ONE new test file this plan creates from scratch; it's justified because `applyStreamEvent` (the reducer function, `apps/web/src/lib/stores/agent-reducer.ts:502`) is a plain, easily-testable pure function despite operating on Svelte-adjacent types — the "thinner store coverage" gap this repo has applies to `.svelte.ts` rune-based modules (untestable outside a component context), not to this plain reducer function, which has no such barrier.

**Interfaces:**
- Consumes: the raw SSE event object (`obj.installedVersion`, etc., from Task 7's schema) in `sse-pump.ts`.
- Produces: `RenovateTriggerChoice` interface gains 4 new optional fields; the reducer case populates them from the incoming event.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts
import { describe, expect, test } from "bun:test";
import { applyStreamEvent, initialReducerState } from "./agent-reducer.ts";

describe("applyStreamEvent renovate_trigger_choice enrichment fields", () => {
	test("populates the enrichment fields when present", () => {
		const event = {
			type: "renovate_trigger_choice" as const,
			threadId: "t1",
			marker: "renovate/eu-onboarding-elastic_agent",
			line: "chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			message: "This will tick...",
			installedVersion: "2.8.0",
			targetVersion: "2.9.4",
			policyCount: 24,
			changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
		};
		const result = applyStreamEvent(initialReducerState(), event);
		expect(result.renovateTriggerChoice?.installedVersion).toBe("2.8.0");
		expect(result.renovateTriggerChoice?.targetVersion).toBe("2.9.4");
		expect(result.renovateTriggerChoice?.policyCount).toBe(24);
		expect(result.renovateTriggerChoice?.changelog).toHaveLength(1);
	});

	test("tolerates missing enrichment fields (older/degraded payload)", () => {
		const event = {
			type: "renovate_trigger_choice" as const,
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
		};
		const result = applyStreamEvent(initialReducerState(), event);
		expect(result.renovateTriggerChoice?.installedVersion).toBeUndefined();
		expect(result.renovateTriggerChoice?.changelog).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bun run test src/lib/stores/agent-reducer.renovate-enrichment.test.ts` (per this repo's established convention — web tests run only via the package script `bun run test`, which wraps `bunx svelte-kit sync && bun test --isolate`; a bare `bun test` from repo root does not reach these). This path-filter invocation is confirmed working syntax (verified live this session — it correctly reports "no test files matched" for a nonexistent path rather than erroring on the invocation itself).
Expected: FAIL — `Cannot find module './agent-reducer.ts'` is not the issue (the module exists); the failure is `renovateTriggerChoice?.installedVersion` etc. being `undefined` because the reducer case doesn't populate them yet.

- [ ] **Step 3: Update `RenovateTriggerChoice`**

In `apps/web/src/lib/stores/agent-reducer.ts`, replace lines 306-315 (the `RenovateTriggerChoice` doc comment + interface):

```typescript
// SIO-XXXX: renovate-integration-update trigger sub-flow. The single operator approve/decline
// gate (renovateTriggerGate). No dedicated result event -- the turn just ends with a final
// message, so the card clears via the same optimistic-clear resumeIac uses for fleet/synthetics.
// installedVersion/targetVersion/policyCount/changelog are pre-trigger enrichment from
// enrichRenovateTarget -- optional, absent when Kibana/GitHub lookup failed for this deployment.
export interface RenovateTriggerChoice {
	threadId: string;
	marker: string;
	line: string;
	message: string;
	installedVersion?: string | null;
	targetVersion?: string | null;
	policyCount?: number | null;
	changelog?: Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>;
}
```

- [ ] **Step 4: Update the reducer case**

In `apps/web/src/lib/stores/agent-reducer.ts`, replace lines 826-838:

```typescript
		// SIO-XXXX: renovate-integration-update trigger sub-flow. No dedicated result event --
		// the card is cleared client-side (resumeIac's optimistic clear), not here.
		case "renovate_trigger_choice":
			return {
				...state,
				threadId: event.threadId,
				renovateTriggerChoice: {
					threadId: event.threadId,
					marker: event.marker,
					line: event.line,
					message: event.message,
					installedVersion: event.installedVersion,
					targetVersion: event.targetVersion,
					policyCount: event.policyCount,
					changelog: event.changelog,
				},
			};
```

- [ ] **Step 5: Update `sse-pump.ts`'s emit branch**

In `apps/web/src/lib/server/sse-pump.ts`, replace lines 888-898 (the full `if (obj.type === "renovate_trigger_choice") { ... }` block, comment included):

```typescript
	// SIO-XXXX: the single renovate-integration-update trigger approve/decline gate
	// (renovateTriggerGate). The UI POSTs { approve } to the resume endpoint. installedVersion/
	// targetVersion/policyCount/changelog are pre-trigger enrichment from enrichRenovateTarget --
	// best-effort, so each is independently defensive-parsed (a null/missing value degrades the
	// card, it never breaks the event).
	if (obj.type === "renovate_trigger_choice") {
		send({
			type: "renovate_trigger_choice",
			threadId,
			marker: typeof obj.marker === "string" ? obj.marker : "",
			line: typeof obj.line === "string" ? obj.line : "",
			message: typeof obj.message === "string" ? obj.message : "Trigger this Renovate update?",
			...(typeof obj.installedVersion === "string" && { installedVersion: obj.installedVersion }),
			...(typeof obj.targetVersion === "string" && { targetVersion: obj.targetVersion }),
			...(typeof obj.policyCount === "number" && { policyCount: obj.policyCount }),
			...(Array.isArray(obj.changelog) && obj.changelog.length > 0 && { changelog: obj.changelog }),
		});
		return true;
	}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/web && bun run test && bun run typecheck`
Expected: all pass, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/server/sse-pump.ts apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: thread renovate enrichment fields through sse-pump and the reducer"
```

---

### Task 9: `RenovateTriggerChoiceCard.svelte` — render the enrichment

**Files:**
- Modify: `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte`

**Interfaces:**
- Consumes: the 4 new optional fields on `RenovateTriggerChoice` (Task 8).
- Produces: no new interface — this is the leaf UI consumer.

- [ ] **Step 1: Implement the layout**

Replace the full file content:

```svelte
<script lang="ts">
// apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
import type { RenovateTriggerChoice } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onDecline,
}: {
	prompt: RenovateTriggerChoice;
	disabled?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();

// SIO-XXXX: stat tiles render only when at least one Kibana enrichment value is present --
// best-effort, degrades cleanly to today's plain card when Kibana lookup failed/wasn't
// configured for this deployment.
const hasStats = $derived(
	prompt.installedVersion != null || prompt.targetVersion != null || prompt.policyCount != null,
);
const changelogCount = $derived(prompt.changelog?.length ?? 0);
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="renovate-trigger-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="renovate-trigger-heading" class="text-sm font-semibold text-tommy-navy">
      Trigger Renovate update
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    {#if hasStats}
      <div class="mt-2 grid grid-cols-3 gap-2">
        <div class="rounded-md bg-white/70 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.installedVersion ?? "?"}</p>
          <p class="text-xs text-gray-500">installed</p>
        </div>
        <div class="rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2 text-center">
          <p class="text-lg font-semibold text-tommy-navy">{prompt.targetVersion ?? "?"}</p>
          <p class="text-xs text-tommy-navy/70">target</p>
        </div>
        <div class="rounded-md bg-white/70 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.policyCount ?? "?"}</p>
          <p class="text-xs text-gray-500">affected policies</p>
        </div>
      </div>
    {/if}

    {#if changelogCount > 0}
      <details class="mt-2">
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
          Changelog ({prompt.installedVersion ?? "?"} &rarr; {prompt.targetVersion ?? "?"}, {changelogCount} release{changelogCount === 1 ? "" : "s"})
        </summary>
        <ul class="mt-1 space-y-1.5 text-xs">
          {#each prompt.changelog ?? [] as entry (entry.version)}
            <li>
              <p class="font-medium text-tommy-navy">{entry.version}</p>
              <ul class="ml-3 list-disc space-y-0.5 text-tommy-navy/70">
                {#each entry.changes as change, i (i)}
                  <li>{change.description}</li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Trigger update
      </button>
      <button
        type="button"
        onclick={() => onDecline()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-white text-tommy-navy border border-tommy-navy hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Decline
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500">
      Runs via the schedule-triggered Renovate job (branches/MRs only); apply stays manual.
    </p>
  </div>
</div>
```

- [ ] **Step 2: Verify with the Svelte MCP tools**

Per this repo's CLAUDE.md, `.svelte` file edits should be validated via the `svelte:svelte-code-writer` skill / Svelte MCP server tools (`mcp__plugin_svelte_svelte__svelte-autofixer` or equivalent) before considering the file done. Run the autofixer/validator against this file and fix any reported issues.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
git commit -m "SIO-XXXX: render Renovate card enrichment (installed/target/policies/changelog)"
```

---

### Task 10: Live end-to-end verification

**Files:** none (verification only — no code changes)

**Interfaces:** none.

- [ ] **Step 1: Start the web app**

Check the port first: `lsof -i :5173`. If nothing is listening, start it: `bun run --filter '@devops-agent/web' dev` (background it, or use a separate terminal — track the PID to kill it at the end of this task per the project's mandatory kill-your-own-servers rule).

- [ ] **Step 2: Trigger a real renovate-integration-update turn**

In the running app, ask the elastic-iac agent something like: *"In eu-onboarding, update the elastic_agent integration"* (or another deployment/integration pair known to have a pending Dependency Dashboard entry — check `gh api` or the GitLab UI for a currently-unschedulable entry first if `elastic_agent` on `eu-onboarding` has already been triggered/merged since this session, since !519 already merged it).

- [ ] **Step 3: Confirm the card renders enrichment**

Verify the `renovate_trigger_choice` card shows: installed/target/policy-count stat tiles (matching live Kibana data — cross-check against a direct `curl` to the same Kibana endpoint if anything looks off), and a collapsed "Changelog" section that expands to show real entries in the installed→target range.

- [ ] **Step 4: Confirm graceful degradation**

Temporarily unset (or point at a deliberately-wrong deployment name so `resolveKibanaConfig` returns `null`) and re-trigger a turn for a deployment with no matching `ELASTIC_<DEPLOYMENT>_URL` — confirm the card still renders with Trigger/Decline available and no stat tiles/changelog section (not an error, not a blocked turn).

- [ ] **Step 5: Kill the dev server**

Track the PID from Step 1 and kill it; verify with `lsof -nP -iTCP:5173 -sTCP:LISTEN` that nothing remains listening.

- [ ] **Step 6: Final full-suite verification**

Run from repo root: `bun run typecheck && bun run lint && bun run test`
Expected: `@devops-agent/agent`, `@devops-agent/shared`, `@devops-agent/web` all 0 typecheck errors (the pre-existing unrelated `mcp-server-couchbase` errors are not in scope); lint clean on every file this plan touched; all tests pass.

- [ ] **Step 7: No commit for this task** (verification only)
