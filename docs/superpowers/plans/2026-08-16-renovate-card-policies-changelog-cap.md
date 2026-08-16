# Renovate Card: Affected-Policy Names + Changelog Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real affected-policy names (not just a count) in a new collapsed section on the `renovate_trigger_choice` card, and cap the changelog display to 10 entries with an honest "+N more" note when truncated.

**Architecture:** A new Kibana Fleet API call (`GET /api/fleet/package_policies?kuery=...`) added as a second, independent fetch inside `enrichRenovateTarget`'s existing `if (kibanaConfig)` block — soft-fails to `[]`, never affects the existing `policyCount` stat tile. The changelog cap is a thin post-step applied to `filterChangelogRange`'s output (that function itself is untouched). Both new values (`renovateAffectedPolicies: string[]`, `renovateChangelogTotal: number`) thread through the same 6-layer pattern already proven three times on this card (state → interrupt payload → SSE Zod schema → sse-pump.ts → reducer → card), landing as a new collapsed `<details>` section (policies) and an extended summary line (changelog cap note).

**Tech Stack:** TypeScript (Bun), LangGraph (`@langchain/langgraph`), Svelte 5 runes, Tailwind, native `fetch` against Kibana's Fleet API.

**Spec:** `docs/superpowers/specs/2026-08-16-renovate-card-policies-changelog-cap-design.md`

## Global Constraints

- No new environment variables or credentials — the new Kibana call reuses the existing `kibanaConfig` already resolved by `resolveKibanaConfig(target.deployment)` in `enrichRenovateTarget`.
- The new policy-names fetch is best-effort: on failure, non-2xx, or malformed response, resolve to `[]` — never throw, never affect the existing `policyCount`/`installedVersion` results from the sibling packages-list call.
- Do NOT modify `filterChangelogRange`'s signature, behavior, or existing tests — the cap is applied to its output only, as a separate step.
- Any new state field added to `IacStateType` MUST be added to `TURN_START_RESET` in the same commit — this is the fourth time this exact rule applies to this sub-flow.
- TypeScript strict mode, no `any`.
- Tailwind-only styling in the Svelte card — no custom `<style>` blocks.
- TDD: write the failing test first for every new pure/testable function, watch it fail, then implement.
- Existing `enrichRenovateTarget` tests that mock `global.fetch` with a catch-all `404` fallback (every existing test in that describe block already does this) do NOT need modification — the new `fetchAffectedPolicyNames` call will hit that same fallback and correctly soft-fail to `[]`.

---

### Task 1: `fetchAffectedPolicyNames` pure/testable function

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add the function after `fetchRenovateChangelog`, which currently ends at line 465, before `enrichRenovateTarget` which starts at line 476)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (new `describe("fetchAffectedPolicyNames", ...)` block — this function is not exported per the plan's design, so tests will need to either export it for testing or test it indirectly through `enrichRenovateTarget`. Since `fetchRenovateChangelog` — its direct sibling — is also NOT exported and has no dedicated test file testing it in isolation (it's only exercised via `enrichRenovateTarget`'s own tests, per the existing pattern confirmed at `renovate-integration.test.ts:826-912`), follow that exact same precedent: do NOT export `fetchAffectedPolicyNames`, and do NOT write a dedicated isolated-function test for it. Its behavior is fully covered by Task 2's `enrichRenovateTarget` tests instead.)

**Interfaces:**
- Consumes: native `fetch` (global, mockable in tests), `AbortSignal.timeout` (already used elsewhere in this file).
- Produces:
```typescript
async function fetchAffectedPolicyNames(
	kibanaConfig: { url: string; apiKey: string },
	integration: string,
): Promise<string[]>
```
Not exported. Returns an array of policy names (empty array on any failure/non-2xx/malformed response). Consumed by Task 2 (`enrichRenovateTarget`).

- [ ] **Step 1: Implement directly (no isolated failing test — see rationale above; Task 2 provides TDD coverage for this function's behavior)**

Add to `packages/agent/src/iac/nodes.ts`, immediately after `fetchRenovateChangelog`'s closing brace (currently line 465), before the `// Best-effort pre-trigger enrichment...` comment that precedes `enrichRenovateTarget` (currently line 467):

```typescript
// Kibana Fleet package-policies list, filtered by integration package name via kuery. No simpler
// alternative exists -- /api/fleet/epm/packages/{pkgName} and its /stats sibling return package
// metadata/counts only, never individual policy names (verified against the Fleet OpenAPI spec:
// https://www.elastic.co/docs/api/doc/kibana/v9/operation/operation-get-fleet-package-policies).
// Soft-fails to [] on any error/non-2xx -- the existing policyCount stat tile (from the sibling
// packages-list call) must still render even if this second call fails independently.
async function fetchAffectedPolicyNames(
	kibanaConfig: { url: string; apiKey: string },
	integration: string,
): Promise<string[]> {
	try {
		const kuery = `ingest-package-policies.package.name:"${integration}"`;
		const res = await fetch(`${kibanaConfig.url}/api/fleet/package_policies?kuery=${encodeURIComponent(kuery)}`, {
			headers: { Authorization: `ApiKey ${kibanaConfig.apiKey}` },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { items?: unknown };
		const items = Array.isArray(body.items) ? body.items : [];
		return items
			.filter(
				(item): item is { name: string } =>
					typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
			)
			.map((item) => item.name);
	} catch {
		return [];
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/agent && bun run typecheck`
Expected: 0 errors. (No behavioral test yet — this function is unreachable/uncalled until Task 2 wires it in, so there is nothing to exercise. Task 2's tests are this function's real TDD coverage.)

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-XXXX: add fetchAffectedPolicyNames Kibana Fleet helper"
```

---

### Task 2: Wire policy names + changelog cap into `enrichRenovateTarget`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`enrichRenovateTarget`, currently lines 476-558)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend the existing `describe("enrichRenovateTarget (SIO-XXXX)", ...)` block, which starts at line 826)

**Interfaces:**
- Consumes: `fetchAffectedPolicyNames` (Task 1, same file, no import needed).
- Produces: `enrichRenovateTarget`'s return type gains 2 new keys: `renovateAffectedPolicies: string[]`, `renovateChangelogTotal: number` — always present (never `undefined`).

- [ ] **Step 1: Write the failing tests**

Add these 3 new tests to the existing `describe("enrichRenovateTarget (SIO-XXXX)", ...)` block (after its last existing test, before the closing `});`):

```typescript
// Append inside the existing describe("enrichRenovateTarget (SIO-XXXX)", () => { ... }) block,
// after its last existing test.
test("returns affected policy names from a successful package_policies call", async () => {
	process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
	process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
	global.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("/api/fleet/epm/packages?")) {
			return Response.json({
				items: [
					{
						name: "elastic_agent",
						version: "2.9.4",
						installationInfo: { version: "2.8.0" },
						packagePoliciesInfo: { count: 2 },
					},
				],
			});
		}
		if (url.includes("/api/fleet/package_policies?")) {
			return Response.json({
				items: [
					{ name: "eu-onboarding-agent-policy-1", package: { name: "elastic_agent", version: "2.9.4" } },
					{ name: "eu-onboarding-agent-policy-2", package: { name: "elastic_agent", version: "2.9.4" } },
				],
				total: 2,
				page: 1,
				perPage: 20,
			});
		}
		return new Response("Not Found", { status: 404 });
	}) as unknown as typeof fetch;

	const out = await enrichRenovateTarget(baseState() as IacStateType);

	expect(out.renovateAffectedPolicies).toEqual(["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"]);
});

test("returns empty affected policies when the package_policies call fails (soft-fail, does not affect policyCount)", async () => {
	process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
	process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
	global.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("/api/fleet/epm/packages?")) {
			return Response.json({
				items: [
					{
						name: "elastic_agent",
						version: "2.9.4",
						installationInfo: { version: "2.8.0" },
						packagePoliciesInfo: { count: 24 },
					},
				],
			});
		}
		// package_policies call falls through to 404 (not explicitly mocked)
		return new Response("Not Found", { status: 404 });
	}) as unknown as typeof fetch;

	const out = await enrichRenovateTarget(baseState() as IacStateType);

	expect(out.renovateAffectedPolicies).toEqual([]);
	expect(out.renovatePolicyCount).toBe(24);
	expect(out.blockedReason).toBeUndefined();
});

test("caps the changelog to 10 entries and reports the pre-cap total", async () => {
	process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
	process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
	const versions = Array.from({ length: 15 }, (_, i) => `2.${15 - i}.0`); // newest-first, 15 entries
	const changelogYaml = versions
		.map((v) => `- version: "${v}"\n  changes:\n    - description: "Change for ${v}"\n      type: enhancement`)
		.join("\n");
	global.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("/api/fleet/epm/packages?")) {
			return Response.json({
				items: [
					{
						name: "elastic_agent",
						version: "2.15.0",
						installationInfo: { version: "2.0.0" },
						packagePoliciesInfo: { count: 1 },
					},
				],
			});
		}
		if (url.includes("raw.githubusercontent.com")) {
			return new Response(changelogYaml, { status: 200 });
		}
		return new Response("Not Found", { status: 404 });
	}) as unknown as typeof fetch;

	const out = await enrichRenovateTarget(baseState() as IacStateType);

	expect(out.renovateChangelog).toHaveLength(10);
	expect(out.renovateChangelogTotal).toBe(15);
});
```

Note for the implementer: `baseState()` (defined at line 835-843) uses `renovateTarget: { deployment: "eu-onboarding", integration: "elastic_agent" }` and `renovateMarker.line` naming `elastic_agent to v2.9.4` — the third test's mocked target version (`2.15.0`, from the Kibana call) will override this via the existing `resolvedTargetVersion` logic (the Kibana `match.version` takes precedence when found), so the changelog range filter runs against `installedVersion: "2.0.0"` to `resolvedTargetVersion: "2.15.0"`, which is why all 15 mocked entries fall in range.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "affected polic|caps the changelog"`
Expected: FAIL — `out.renovateAffectedPolicies` is `undefined` (not yet a key on the return object), and `out.renovateChangelog` has 15 entries, not capped to 10 (`renovateChangelogTotal` also `undefined`).

- [ ] **Step 3: Implement**

In `packages/agent/src/iac/nodes.ts`, inside `enrichRenovateTarget` (currently lines 476-558):

First, add the new `let` declaration alongside the existing ones (currently lines 482-484):

```typescript
	const targetVersion = parseRenovateTargetVersion(marker.line);
	let installedVersion: string | null = null;
	let policyCount: number | null = null;
	let affectedPolicies: string[] = [];
	let resolvedTargetVersion = targetVersion;
```

Next, add the new sequential fetch inside the existing `if (kibanaConfig) { ... }` block (currently lines 486-535), as a new statement immediately after the existing `try/catch` closes (after line 534's closing `}` for the `catch` block, still inside the outer `if (kibanaConfig)` braces, before that block's own closing `}` on line 535):

```typescript
	const kibanaConfig = resolveKibanaConfig(target.deployment);
	if (kibanaConfig) {
		try {
			// ...existing fetch + parsing for policyCount/installedVersion, UNCHANGED, lines 488-524...
		} catch (error) {
			// ...existing catch block, UNCHANGED, lines 525-533...
		}
		// NEW: second, independent Kibana call for policy names. Runs regardless of whether the
		// first call found a match (fetchAffectedPolicyNames soft-fails to [] on its own if the
		// package doesn't exist / query fails -- no need to gate this on `match` above).
		affectedPolicies = await fetchAffectedPolicyNames(kibanaConfig, target.integration);
	}
```

Next, add the cap constant near the top of the file-level scope where other module constants live, OR as a local constant just above its use inside `enrichRenovateTarget` — place it as a `const` immediately before the `Promise.all` call (simplest, keeps it colocated with its only use site):

Replace the existing `Promise.all` block (currently lines 537-548):

```typescript
	const [changelog, renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
		(async () =>
			resolvedTargetVersion
				? filterChangelogRange(
						await fetchRenovateChangelog(target.integration),
						installedVersion,
						resolvedTargetVersion,
					)
				: [])(),
		recallDeploymentKgChanges(target.deployment),
		recallPriorRenovateTriggers(target.deployment, marker.marker),
	]);
```

with:

```typescript
	const CHANGELOG_DISPLAY_CAP = 10;
	let changelogTotal = 0;
	const [changelog, renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
		(async () => {
			if (!resolvedTargetVersion) return [];
			const filtered = filterChangelogRange(
				await fetchRenovateChangelog(target.integration),
				installedVersion,
				resolvedTargetVersion,
			);
			changelogTotal = filtered.length;
			return filtered.slice(0, CHANGELOG_DISPLAY_CAP);
		})(),
		recallDeploymentKgChanges(target.deployment),
		recallPriorRenovateTriggers(target.deployment, marker.marker),
	]);
```

Finally, update the final `return` statement (currently lines 550-557):

```typescript
	return {
		renovateInstalledVersion: installedVersion,
		renovateTargetVersion: resolvedTargetVersion,
		renovatePolicyCount: policyCount,
		renovateChangelog: changelog,
		renovateRecentChanges,
		renovatePriorTriggers,
		renovateAffectedPolicies: affectedPolicies,
		renovateChangelogTotal: changelogTotal,
	};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "enrichRenovateTarget"`
Expected: PASS, all tests in the describe block (previous count + 3 new).

- [ ] **Step 5: Run the full renovate test file + typecheck**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts && bun run typecheck`
Expected: all tests pass (including the pre-existing tests whose `global.fetch` mocks fall through to a catch-all 404 for the new `/api/fleet/package_policies?` URL — they should be unaffected since `renovateAffectedPolicies` soft-fails to `[]` and none of those tests assert on it), 0 typecheck errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: wire affected-policy names + changelog cap into enrichRenovateTarget"
```

---

### Task 3: State fields + `TURN_START_RESET`

**Files:**
- Modify: `packages/agent/src/iac/state.ts` (add 2 fields after the existing `renovatePriorTriggers` Annotation)
- Modify: `packages/agent/src/iac/nodes.ts` (add the same 2 fields to `TURN_START_RESET`, currently ending at line 1568)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend the existing `describe("TURN_START_RESET (renovate-integration-update fields)", ...)` block, which starts at line 636)

**Interfaces:**
- Produces: 2 new fields on `IacStateType`, consumed by Task 4 (`renovateTriggerGate` reads them into the interrupt payload).

```typescript
renovateAffectedPolicies: string[];  // [] if the Kibana call fails/is unavailable; set by enrichRenovateTarget
renovateChangelogTotal: number;      // 0 if resolvedTargetVersion was never resolved; pre-cap changelog entry count
```

- [ ] **Step 1: Write the failing test**

First, confirm the CURRENT exact field list and count in `packages/agent/src/iac/renovate-integration.test.ts` (it's 13 fields as of this plan's writing — verify against the real file before trusting this number, since this test's field count has changed multiple times before):

```bash
grep -n "resets all .* renovate-integration-update fields" -A 20 packages/agent/src/iac/renovate-integration.test.ts
```

Extend that existing test's expected object (do not duplicate the describe block) to include the 2 new fields at their reset values, and rename the test to reflect the new total (13 + 2 = 15, but VERIFY the real current count first):

```typescript
// Inside the existing describe("TURN_START_RESET (renovate-integration-update fields)", ...)
// block, extend the existing test's expected object and rename it to reflect the new count:
test("resets all 15 renovate-integration-update fields", () => {
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
		renovateRecentChanges: "",
		renovatePriorTriggers: "",
		renovateAffectedPolicies: [],
		renovateChangelogTotal: 0,
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: FAIL — `TURN_START_RESET` is missing the 2 new keys.

- [ ] **Step 3: Add the state fields**

In `packages/agent/src/iac/state.ts`, find the existing `renovatePriorTriggers` Annotation (added by the prior KG/memory-recall plan) and add 2 new fields immediately after its closing `}),`:

```typescript
	// SIO-XXXX: affected-policy names (Kibana Fleet package_policies call) + the pre-cap changelog
	// entry count, so the card can show real policy names in a collapsed section and an honest
	// "+N more releases" note when the changelog display is capped at 10 entries.
	renovateAffectedPolicies: Annotation<string[]>({ reducer: last, default: () => [] }),
	renovateChangelogTotal: Annotation<number>({ reducer: last, default: () => 0 }),
```

- [ ] **Step 4: Add the same 2 fields to `TURN_START_RESET`**

In `packages/agent/src/iac/nodes.ts`, immediately after `renovatePriorTriggers: "",` (currently line 1568), before the closing `} as const;`:

```typescript
	renovateAffectedPolicies: [],
	renovateChangelogTotal: 0,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd packages/agent && bun run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add renovateAffectedPolicies/renovateChangelogTotal state fields + TURN_START_RESET"
```

---

### Task 4: Surface both fields on the interrupt payload

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`renovateTriggerGate`, currently lines 666-695)

**Interfaces:**
- Consumes: `state.renovateAffectedPolicies`, `state.renovateChangelogTotal` (Task 3).
- Produces: an extended interrupt payload — Task 5 updates the Zod schema, Task 6 updates the reducer/sse-pump.

- [ ] **Step 1: Write the failing test**

The existing test `"interrupt payload carries the enrichment fields set by enrichRenovateTarget"` (in `describe("renovateTriggerGate interrupt round-trip (SIO-1471)", ...)`, currently at line 109 of `renovate-integration.test.ts`) already asserts on the 6 existing enrichment fields. Extend THAT SAME test (do not add a new one) to also assert the 2 new fields:

```typescript
// Inside the existing test "interrupt payload carries the enrichment fields set by
// enrichRenovateTarget", extend BOTH the inputState object and the toMatchObject assertion:
const inputState = {
	requestId: "req-1",
	renovateMarker: marker,
	renovateInstalledVersion: "2.8.0",
	renovateTargetVersion: "2.9.4",
	renovatePolicyCount: 24,
	renovateChangelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	renovateRecentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
	renovatePriorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
	renovateAffectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
	renovateChangelogTotal: 23,
};

// ...

expect(interruptValue).toMatchObject({
	installedVersion: "2.8.0",
	targetVersion: "2.9.4",
	policyCount: 24,
	changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
	priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
	affectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
	changelogTotal: 23,
});
```

Read the actual existing test first (it's at `renovate-integration.test.ts:109-140`) and extend its real current structure — do not assume the surrounding code matches this snippet exactly beyond the 2 new field additions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "carries the enrichment fields"`
Expected: FAIL — the interrupt payload is missing `affectedPolicies`/`changelogTotal`.

- [ ] **Step 3: Implement**

In `packages/agent/src/iac/nodes.ts`, update `renovateTriggerGate`'s `interrupt({...})` call (currently lines 669-682):

```typescript
	const choice = interrupt({
		type: "renovate_trigger_choice",
		marker: marker.marker,
		line: marker.line,
		message: buildRenovateGateMessage(marker),
		// SIO-XXXX: pre-trigger enrichment from enrichRenovateTarget -- best-effort, any/all may
		// be null/[]/0 when Kibana, the changelog fetch, KG, or agent-memory were unavailable.
		installedVersion: state.renovateInstalledVersion,
		targetVersion: state.renovateTargetVersion,
		policyCount: state.renovatePolicyCount,
		changelog: state.renovateChangelog,
		recentChanges: state.renovateRecentChanges,
		priorTriggers: state.renovatePriorTriggers,
		affectedPolicies: state.renovateAffectedPolicies,
		changelogTotal: state.renovateChangelogTotal,
	}) as { approve?: boolean };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: full file passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: surface affected-policy names + changelog total on the renovate_trigger_choice interrupt payload"
```

---

### Task 5: Shared SSE event schema

**Files:**
- Modify: `packages/shared/src/agent-state.ts` (the `renovate_trigger_choice` object in `StreamEventSchema`, currently ending at line 1268)
- Test: `packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts` (extend the EXISTING file — do not create a new file)

**Interfaces:**
- Produces: `StreamEventSchema`'s `renovate_trigger_choice` variant gains 2 new optional fields.

- [ ] **Step 1: Write the failing tests**

Add these 2 new tests to the existing describe block in `agent-state.renovate-enrichment.test.ts`, after its last existing test (currently line 78-87):

```typescript
// Append inside the existing describe("StreamEventSchema renovate_trigger_choice enrichment
// fields", () => { ... }) block, after its last existing test.
test("accepts affectedPolicies and changelogTotal when present", () => {
	const parsed = StreamEventSchema.safeParse({
		type: "renovate_trigger_choice",
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
		affectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
		changelogTotal: 23,
	});
	expect(parsed.success).toBe(true);
	if (parsed.success && parsed.data.type === "renovate_trigger_choice") {
		expect(parsed.data.affectedPolicies).toEqual(["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"]);
		expect(parsed.data.changelogTotal).toBe(23);
	}
});

test("still accepts the event when affectedPolicies/changelogTotal are absent (older/degraded payload)", () => {
	const parsed = StreamEventSchema.safeParse({
		type: "renovate_trigger_choice",
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
	});
	expect(parsed.success).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: the FIRST new test fails on the data-presence assertions (`parsed.data.affectedPolicies`/`changelogTotal` are `undefined` because Zod's `.strip()` behavior silently drops unrecognized keys) — not just on `.success`, which would remain `true` either way. This is the same RED-state gotcha this exact schema hit before (SIO-1472's `recentChanges`/`priorTriggers` addition) — the explicit data-presence check is what makes the RED state real.

- [ ] **Step 3: Update the schema**

In `packages/shared/src/agent-state.ts`, inside the `renovate_trigger_choice` object (currently ending at line 1268, right before the closing `}),`), add two more fields right after the existing `priorTriggers: z.string().optional(),` line:

```typescript
		// SIO-1472: KG change-history + prior-trigger memory recall, mirroring the fleet-upgrade
		// gate's recentChanges/priorUpgrades fields (this sub-flow's own twin of that same pattern).
		recentChanges: z.string().optional(),
		priorTriggers: z.string().optional(),
		// SIO-XXXX: real affected-policy names (from a second Kibana Fleet call) + the pre-cap
		// changelog entry count, so the card can render a policy-names section and an honest
		// "+N more releases" note.
		affectedPolicies: z.array(z.string()).optional(),
		changelogTotal: z.number().optional(),
	}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: PASS, all 8 tests (6 existing + 2 new).

- [ ] **Step 5: Typecheck**

Run: `cd packages/shared && bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/agent-state.ts packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: extend renovate_trigger_choice SSE schema with affectedPolicies/changelogTotal"
```

---

### Task 6: `sse-pump.ts` + `agent-reducer.ts` — thread both fields through to the store

**Files:**
- Modify: `apps/web/src/lib/server/sse-pump.ts` (the `renovate_trigger_choice` emit branch, currently lines 900-915; the `emitIacInterrupt` local `obj` type literal, currently lines 746-754)
- Modify: `apps/web/src/lib/stores/agent-reducer.ts` (the `RenovateTriggerChoice` interface, currently lines 312-325; the `renovate_trigger_choice` reducer case, currently lines 838-854)
- Test: `apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts` (extend the EXISTING file — do not create a new file)

**Interfaces:**
- Consumes: the raw SSE event object's `obj.affectedPolicies`/`obj.changelogTotal` (from Task 5's schema) in `sse-pump.ts`.
- Produces: `RenovateTriggerChoice` interface gains 2 new optional fields; the reducer case populates them.

**Important note on the `obj` type literal in `sse-pump.ts`:** both `affectedPolicies?: unknown` and `changelogTotal?: unknown` are genuinely NEW field names — no reuse conflict with any existing field in this type literal (confirmed: the closest name, `versionCrosstab`, is unrelated; `policyCount`/`changelog` already exist as separate, differently-named fields). Simply add both as new lines.

- [ ] **Step 1: Write the failing tests**

Add these 2 new tests to the existing describe block in `agent-reducer.renovate-enrichment.test.ts`, after its last existing test (currently line 53-64):

```typescript
// Append inside the existing describe("applyStreamEvent renovate_trigger_choice enrichment
// fields", () => { ... }) block, after its last existing test.
test("populates affectedPolicies and changelogTotal when present", () => {
	const event = {
		type: "renovate_trigger_choice" as const,
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
		affectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
		changelogTotal: 23,
	};
	const result = applyStreamEvent(initialReducerState(), event);
	expect(result.renovateTriggerChoice?.affectedPolicies).toEqual([
		"eu-onboarding-agent-policy-1",
		"eu-onboarding-agent-policy-2",
	]);
	expect(result.renovateTriggerChoice?.changelogTotal).toBe(23);
});

test("tolerates missing affectedPolicies/changelogTotal (older/degraded payload)", () => {
	const event = {
		type: "renovate_trigger_choice" as const,
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
	};
	const result = applyStreamEvent(initialReducerState(), event);
	expect(result.renovateTriggerChoice?.affectedPolicies).toBeUndefined();
	expect(result.renovateTriggerChoice?.changelogTotal).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bun run test src/lib/stores/agent-reducer.renovate-enrichment.test.ts`
Expected: FAIL — `result.renovateTriggerChoice?.affectedPolicies`/`changelogTotal` are `undefined` in the first new test (the reducer doesn't populate them yet).

- [ ] **Step 3: Update `RenovateTriggerChoice`**

In `apps/web/src/lib/stores/agent-reducer.ts`, extend the interface (currently lines 312-325):

```typescript
export interface RenovateTriggerChoice {
	threadId: string;
	marker: string;
	line: string;
	message: string;
	installedVersion?: string | null;
	targetVersion?: string | null;
	policyCount?: number | null;
	changelog?: Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>;
	// SIO-1472: KG change-history + prior-trigger memory recall, mirroring FleetUpgradeChoice's
	// own recentChanges/priorUpgrades fields.
	recentChanges?: string;
	priorTriggers?: string;
	// SIO-XXXX: real affected-policy names + the pre-cap changelog entry count.
	affectedPolicies?: string[];
	changelogTotal?: number;
}
```

- [ ] **Step 4: Update the reducer case**

In `apps/web/src/lib/stores/agent-reducer.ts`, extend the `renovate_trigger_choice` case (currently lines 838-854):

```typescript
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
					recentChanges: event.recentChanges,
					priorTriggers: event.priorTriggers,
					affectedPolicies: event.affectedPolicies,
					changelogTotal: event.changelogTotal,
				},
			};
```

- [ ] **Step 5: Update `sse-pump.ts`'s `obj` type literal and emit branch**

In `apps/web/src/lib/server/sse-pump.ts`, add both new fields to the local type literal (immediately after the existing `priorTriggers?: unknown;` at line 754, before the closing `};`):

```typescript
		installedVersion?: unknown;
		policyCount?: unknown;
		changelog?: unknown;
		priorTriggers?: unknown;
		affectedPolicies?: unknown;
		changelogTotal?: unknown;
	};
```

Then update the `renovate_trigger_choice` emit branch (currently lines 900-915):

```typescript
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
			...(typeof obj.recentChanges === "string" && obj.recentChanges && { recentChanges: obj.recentChanges }),
			...(typeof obj.priorTriggers === "string" && obj.priorTriggers && { priorTriggers: obj.priorTriggers }),
			...(Array.isArray(obj.affectedPolicies) &&
				obj.affectedPolicies.length > 0 && { affectedPolicies: obj.affectedPolicies }),
			...(typeof obj.changelogTotal === "number" && obj.changelogTotal > 0 && { changelogTotal: obj.changelogTotal }),
		});
		return true;
	}
```

Note the `> 0` guard on `changelogTotal` (not just `typeof === "number"`) — a `0` total means "no changelog was computed at all" (e.g. `resolvedTargetVersion` was never resolved), which is the SAME state as the field being absent; omitting it in that case is more consistent with how `policyCount`/`changelog` already avoid sending a meaningless zero/empty value. The `affectedPolicies` guard mirrors `changelog`'s own non-empty-array pattern exactly.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/web && bun run test && bun run typecheck`
Expected: all pass, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/server/sse-pump.ts apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: thread affectedPolicies/changelogTotal through sse-pump and the reducer"
```

---

### Task 7: `RenovateTriggerChoiceCard.svelte` — render the policy-names section + changelog cap note

**Files:**
- Modify: `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte`

**Interfaces:**
- Consumes: `prompt.affectedPolicies`, `prompt.changelogTotal` (Task 6).
- Produces: no new interface — leaf UI consumer.

- [ ] **Step 1: Implement**

The current file (97 lines as of the prior PR #667, since extended to ~125 lines by that PR's KG/memory panels) has this structure: `hasStats`/`changelogCount` derived values (currently around lines 20-24), the stat-tile grid (`{#if hasStats}`), the KG panel, the memory panel, then the Changelog `<details>` block (currently around lines 82-101), then the Trigger/Decline buttons. Read the file's current exact content first — this task's insertion points are relative to whatever the current line numbers are after PR #667 landed, not the original 97-line version.

**Insert 1 — extend the Changelog section's summary + add the truncation note.** Find the existing Changelog `<details>` block:

```svelte
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
```

Replace with (summary text now shows "N of M releases" when `changelogTotal` differs from the displayed count, plus a trailing "+N more" list item when truncated):

```svelte
{#if changelogCount > 0}
  <details class="mt-2">
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
      Changelog ({prompt.installedVersion ?? "?"} &rarr; {prompt.targetVersion ?? "?"}, {changelogCount} of {prompt.changelogTotal ?? changelogCount} release{(prompt.changelogTotal ?? changelogCount) === 1 ? "" : "s"})
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
      {#if prompt.changelogTotal && prompt.changelogTotal > changelogCount}
        <li class="text-tommy-navy/50 italic">
          +{prompt.changelogTotal - changelogCount} more release{prompt.changelogTotal - changelogCount === 1 ? "" : "s"} (see the full changelog on GitHub)
        </li>
      {/if}
    </ul>
  </details>
{/if}
```

When `prompt.changelogTotal` is absent or equal to `changelogCount` (no truncation — older/degraded payload, or genuinely ≤10 releases), the summary reads identically to before this change ("10 of 10 releases") and the "+N more" line never renders.

**Insert 2 — new "Affected policies" collapsed section.** Add immediately after the Changelog `<details>` block's closing `{/if}` (i.e. right before the Trigger/Decline buttons `<div>`):

```svelte
    <!-- SIO-XXXX: real affected-policy names (from a second Kibana Fleet call in
         enrichRenovateTarget), mirroring the Changelog section's own collapsed-list pattern.
         Summary count prefers prompt.policyCount (the original, always-reliable count from the
         existing packages-list call) over the names array's own length, so it stays accurate even
         if the names-fetch and count-fetch briefly disagree (e.g. a policy created between the two
         calls). Gated on presence -- an empty/failed names-fetch yields [] and the section stays
         hidden, never showing an empty "Affected policies (0)" with no rows. -->
    {#if prompt.affectedPolicies && prompt.affectedPolicies.length > 0}
      <details class="mt-2">
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
          Affected policies ({prompt.policyCount ?? prompt.affectedPolicies.length})
        </summary>
        <ul class="mt-1 ml-3 list-disc space-y-0.5 text-xs text-tommy-navy/70">
          {#each prompt.affectedPolicies as name (name)}
            <li>{name}</li>
          {/each}
        </ul>
      </details>
    {/if}
```

- [ ] **Step 2: Verify with the Svelte MCP tools**

Per this repo's CLAUDE.md, `.svelte` file edits should be validated via the Svelte MCP server tools (`mcp__plugin_svelte_svelte__svelte-autofixer` or equivalent) before considering the file done. Run the autofixer/validator against this file and fix any reported issues.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
git commit -m "SIO-XXXX: render affected-policy names section + changelog cap note on the Renovate card"
```

---

### Task 8: Live end-to-end verification

**Files:** none (verification only — no code changes)

**Interfaces:** none.

- [ ] **Step 1: Start the web app**

Check the port first: `lsof -i :5173` (or pick a free port if occupied by another session's dev server — do NOT kill a server you didn't start). Start it: `bun --env-file=<absolute-path-to-main-repo's .env> run dev -- --port <PORT>` from `apps/web`.

- [ ] **Step 2: Trigger a renovate-integration-update turn for an integration with a long changelog**

Use the "Elastic IaC Agent" mode (toggle via the "Switch agent" button in the header, or navigate directly if a URL param exists). Ask e.g. "In the ap-cld deployment, upgrade the System integration" (per the live screenshot that prompted this plan — the `system` integration on `ap-cld` had a visibly long, unbounded changelog). Confirm the card shows:
  - The Changelog section's summary now reads "N of M releases" and lists exactly `min(10, M)` entries, with a "+X more releases" note when M > 10.
  - A new "Affected policies (N)" collapsed section, listing real policy names (not just a count) when expanded.
  - All previously-existing sections (stat tiles, KG panel, memory panel) are unaffected.

- [ ] **Step 3: Confirm graceful degradation for an integration where the policy-names call might fail**

If a deployment/integration is known to be misconfigured or the Fleet API call fails for any reason, confirm the card still renders correctly with the "Affected policies" section simply absent (not an empty/broken section) and the existing stat tile's count still populated.

- [ ] **Step 4: Kill the dev server**

Track the PID from Step 1 and kill it; verify with `lsof -nP -iTCP:<PORT> -sTCP:LISTEN` that nothing remains listening.

- [ ] **Step 5: Final full-suite verification**

Run from repo root: `bun run typecheck && bun run lint && bun run test`
Expected: all packages 0 typecheck errors; lint clean on every file this plan touched; all tests pass.

- [ ] **Step 6: No commit for this task** (verification only)
