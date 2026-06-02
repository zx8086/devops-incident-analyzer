# SIO-880 ilm-rollout GitOps Proposer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ilm-rollout` branch to the Elastic IaC GitOps proposer so a natural-language ILM change edits one cluster's lifecycle-policy JSON and opens one merge request, reusing every node downstream of `draftChange`.

**Architecture:** Single-MR-per-invocation, mirroring SIO-873 (version-upgrade) and SIO-879 (tier-resize). A new `proposeIlmChange` node deep-merges a phase patch into `environments/<cluster>/lifecycle-policies/<policy>.json` via the GitLab REST API; `reviewPlan`/`buildMrDescription` gain ILM-aware wiring; a retention reduction surfaces a HIGH-risk warning but is never auto-blocked. No new graph nodes, no new MCP tools, no wave choreography.

**Tech Stack:** TypeScript (strict, no `any`), Bun test, LangGraph `StateGraph`, Zod, the existing `mcp-server-elastic-iac` GitLab tools.

**Spec:** `docs/superpowers/specs/2026-06-02-ilm-rollout-gitops-proposer-design.md`
**Branch:** `sio-880-ilm-rollout-gitops-proposer` off `main`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/agent/src/iac/state.ts` | IaC graph state + `IacRequest` shape | add `phasesPatch` to `IacRequest`; add `retentionChange` annotation |
| `packages/agent/src/iac/nodes.ts` | all IaC nodes + pure helpers | add ILM intent fields, `mergeIlmPhases`, `detectRetentionReduction`, `ilmPolicyTemplate`, `${policy}` in `deploymentJsonPath`, `proposeIlmChange`, `draftChange` route, `branchSlug` descriptor, `reviewPlan` wiring, `buildMrDescription` clause |
| `packages/agent/src/iac/ilm-rollout.test.ts` | ILM unit + node-level tests | new file (per-workflow convention) |
| `.env.example` | env documentation | add `ELASTIC_IAC_ILM_POLICY_TEMPLATE` |
| `agents/elastic-iac/RULES.md` | agent rules (cold-restart to load) | extend rule 8 with the ILM path |

Pure helpers are added to `nodes.ts` alongside `setDeploymentTierSize` (the file already groups the pure read-modify-write helpers there; the spec keeps that convention). Tests go in a dedicated `ilm-rollout.test.ts` rather than growing `version-upgrade.test.ts`.

---

## Task 0: Branch

- [ ] **Step 1: Create the working branch off main**

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
git checkout main && git pull
git checkout -b sio-880-ilm-rollout-gitops-proposer
```

---

## Task 1: `mergeIlmPhases` pure helper (deep-merge a phase patch)

**Files:**
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (create)
- Modify: `packages/agent/src/iac/nodes.ts` (add helper after `setDeploymentTierSize`, ~line 336)

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/iac/ilm-rollout.test.ts`:

```ts
// agent/src/iac/ilm-rollout.test.ts
import { describe, expect, test } from "bun:test";
import { mergeIlmPhases } from "./nodes.ts";

const POLICY = JSON.stringify(
	{
		name: "90-days@lifecycle",
		hot: { max_age: "30d", max_primary_shard_size: "50gb", min_docs: 1, rollover: true },
		warm: { min_age: "2d", forcemerge: { max_num_segments: 1 } },
		cold: { min_age: "30d" },
		delete: { min_age: "90d", delete_searchable_snapshot: true },
	},
	null,
	2,
);

describe("mergeIlmPhases", () => {
	test("replaces a scalar leaf and captures the previous value", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		const parsed = JSON.parse(content) as { delete: { min_age: string; delete_searchable_snapshot: boolean } };
		expect(parsed.delete.min_age).toBe("60d");
		// sibling fields in the patched phase are preserved
		expect(parsed.delete.delete_searchable_snapshot).toBe(true);
		expect(previous).toEqual({ delete: { min_age: "90d" } });
	});

	test("deep-merges a nested object without clobbering siblings", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { warm: { forcemerge: { max_num_segments: 2 } } });
		const parsed = JSON.parse(content) as { warm: { min_age: string; forcemerge: { max_num_segments: number } } };
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(parsed.warm.min_age).toBe("2d"); // untouched sibling preserved
		expect(previous).toEqual({ warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("applies a multi-phase patch in one call", () => {
		const { content, previous } = mergeIlmPhases(POLICY, {
			delete: { min_age: "60d" },
			warm: { forcemerge: { max_num_segments: 2 } },
		});
		const parsed = JSON.parse(content) as { delete: { min_age: string }; warm: { forcemerge: { max_num_segments: number } } };
		expect(parsed.delete.min_age).toBe("60d");
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(previous).toEqual({ delete: { min_age: "90d" }, warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("preserves 2-space indent and a trailing newline", () => {
		const { content } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "delete": {');
	});

	test("records undefined in previous for a leaf the policy did not have", () => {
		const { previous } = mergeIlmPhases(POLICY, { hot: { max_age: "30d", set_priority: { priority: 50 } } });
		expect((previous as { hot: { set_priority?: unknown } }).hot.set_priority).toBeUndefined();
	});

	test("throws on non-object JSON", () => {
		expect(() => mergeIlmPhases("[]", { delete: { min_age: "60d" } })).toThrow();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts`
Expected: FAIL — `mergeIlmPhases is not a function` (export missing).

- [ ] **Step 3: Implement `mergeIlmPhases`**

In `packages/agent/src/iac/nodes.ts`, immediately after `setDeploymentTierSize` (it ends at the line with `return { content: ... previousSize, previousMax };`, ~line 336), add:

```ts
// SIO-880: read-modify-write an ILM lifecycle-policy JSON by deep-merging a nested phase
// patch (top-level keys are phases: hot/warm/cold/delete). Recurses into nested objects
// (e.g. warm.forcemerge), replaces scalars/arrays/null. Captures the pre-merge value of
// every touched leaf into `previous` (a sparse mirror of the patch) for the diff +
// retention check; a leaf the policy lacked records `undefined`. Preserves 2-space indent
// + trailing newline. Throws on non-object JSON. (Pure; unit-tested.)
export function mergeIlmPhases(
	json: string,
	patch: Record<string, unknown>,
): { content: string; previous: Record<string, unknown> } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("ILM policy JSON is not an object");
	}
	const isPlainObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);

	const previous: Record<string, unknown> = {};
	const merge = (target: Record<string, unknown>, p: Record<string, unknown>, prev: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(p)) {
			const current = target[key];
			if (isPlainObject(value)) {
				if (!isPlainObject(current)) target[key] = {};
				const prevChild: Record<string, unknown> = {};
				prev[key] = prevChild;
				merge(target[key] as Record<string, unknown>, value, prevChild);
			} else {
				prev[key] = current; // may be undefined if the policy lacked this leaf
				target[key] = value;
			}
		}
	};
	merge(parsed as Record<string, unknown>, patch, previous);
	return { content: `${JSON.stringify(parsed, null, 2)}\n`, previous };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: mergeIlmPhases deep-merge helper for ILM policy JSON

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `detectRetentionReduction` pure helper

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add helper after `mergeIlmPhases`)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/src/iac/ilm-rollout.test.ts` (add `detectRetentionReduction` to the existing import from `./nodes.ts`):

```ts
import { detectRetentionReduction } from "./nodes.ts"; // merge into the existing import line

describe("detectRetentionReduction", () => {
	test("flags a shorter delete.min_age as a reduction", () => {
		const r = detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "30d" } });
		expect(r).toEqual({ from: "90d", to: "30d" });
	});

	test("returns null when retention increases", () => {
		expect(detectRetentionReduction({ delete: { min_age: "30d" } }, { delete: { min_age: "60d" } })).toBeNull();
	});

	test("compares across units (48h is shorter than 3d)", () => {
		const r = detectRetentionReduction({ delete: { min_age: "3d" } }, { delete: { min_age: "48h" } });
		expect(r).toEqual({ from: "3d", to: "48h" });
	});

	test("returns null when the patch does not touch delete.min_age", () => {
		expect(detectRetentionReduction({ warm: { min_age: "2d" } }, { warm: { min_age: "1d" } })).toBeNull();
	});

	test("returns null on an unparseable duration", () => {
		expect(detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "forever" } })).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts`
Expected: FAIL — `detectRetentionReduction is not a function`.

- [ ] **Step 3: Implement `detectRetentionReduction`**

In `nodes.ts`, after `mergeIlmPhases`, add:

```ts
// SIO-880: parse an Elastic time string ("30d", "48h", "90m", "30s") to seconds. Returns
// null for an unrecognized unit/format. ms/micros/nanos are not ILM min_age units.
function durationToSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const m = value.match(/^(\d+)\s*(d|h|m|s)$/);
	if (!m) return null;
	const n = Number(m[1]);
	const unit = m[2];
	const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
	return n * mult;
}

// SIO-880: compare old vs new delete.min_age. Returns the from/to descriptor when the new
// retention is strictly shorter (irreversible data loss = HIGH risk), else null. (Pure.)
export function detectRetentionReduction(
	previous: Record<string, unknown>,
	patch: Record<string, unknown>,
): { from: string; to: string } | null {
	const prevDelete = previous.delete;
	const patchDelete = patch.delete;
	if (typeof prevDelete !== "object" || prevDelete === null) return null;
	if (typeof patchDelete !== "object" || patchDelete === null) return null;
	const from = (prevDelete as { min_age?: unknown }).min_age;
	const to = (patchDelete as { min_age?: unknown }).min_age;
	const fromS = durationToSeconds(from);
	const toS = durationToSeconds(to);
	if (fromS === null || toS === null) return null;
	return toS < fromS ? { from: from as string, to: to as string } : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: detectRetentionReduction helper (delete.min_age, cross-unit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: ILM intent fields (state + schema + parse + planner)

**Files:**
- Modify: `packages/agent/src/iac/state.ts:5-20` (`IacRequest`)
- Modify: `packages/agent/src/iac/nodes.ts:47-59` (`IntentSchema`), `:63-91` (`parseIntentJson`), `:149-160` (planner instruction)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `ilm-rollout.test.ts` (add `parseIntentJson` to the import):

```ts
describe("parseIntentJson — ilm-rollout", () => {
	test("extracts workflow/cluster/policyName/phasesPatch with no clarification", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
			phasesPatch: { delete: { min_age: "60d" } },
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.policyName).toBe("30-days@lifecycle");
		expect(req.phasesPatch).toEqual({ delete: { min_age: "60d" } });
		expect(req.clarification).toBeUndefined();
	});

	test("normalizes an explicit-null phasesPatch to undefined", () => {
		const raw = JSON.stringify({ workflow: "ilm-rollout", cluster: "eu-b2b", policyName: "logs", phasesPatch: null });
		const req = parseIntentJson(raw);
		expect(req.phasesPatch).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "ilm-rollout"`
Expected: FAIL — `phasesPatch` is `undefined` in the first test (schema drops the unknown key) — assertion mismatch.

- [ ] **Step 3a: Add `phasesPatch` to `IacRequest`**

In `state.ts`, inside the `IacRequest` interface, after the `policyName?: string;` line (currently `:10`), add:

```ts
	// SIO-880: nested phase patch for an ilm-rollout change, e.g.
	// { warm: { forcemerge: { max_num_segments: 1 } }, delete: { min_age: "60d" } }.
	phasesPatch?: Record<string, unknown>;
```

- [ ] **Step 3b: Add `phasesPatch` to `IntentSchema`**

In `nodes.ts`, in `IntentSchema` (`:47-59`), after the `policyName: z.string().nullish(),` line, add:

```ts
	phasesPatch: z.record(z.string(), z.unknown()).nullish(),
```

- [ ] **Step 3c: Carry `phasesPatch` through `parseIntentJson`**

In `nodes.ts`, in the object returned from `parseIntentJson` (`:72-84`), after the `policyName: nn(p.policyName),` line, add:

```ts
						phasesPatch: nn(p.phasesPatch) as Record<string, unknown> | undefined,
```

- [ ] **Step 3d: Add the ilm-rollout planner clause**

In `nodes.ts`, in `parseIntent`'s `instruction` string (`:149-160`), after the tier-resize sentence (`...newSizeGb and/or newMaxGb as plain GB integers.`), insert:

```ts
		"For an ILM lifecycle-policy change ('set eu-b2b 30-days retention to 60 days', 'forcemerge warm to 1 " +
		"segment on eu-cld logs'), set workflow to 'ilm-rollout', cluster to the named deployment, policyName to the " +
		"policy filename VERBATIM (e.g. '30-days@lifecycle', 'logs', 'eu-default-lifecycle-logs-prod'), and phasesPatch " +
		"to a nested object containing ONLY the phase fields to change (top-level keys are phases hot|warm|cold|delete; " +
		"durations are strings like '60d'; retention is delete.min_age). " +
```

(Insert as a new string literal concatenated into the existing `instruction` chain — keep the `+` concatenation style.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "ilm-rollout"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @devops-agent/agent typecheck
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: ILM intent fields (phasesPatch) + planner clause

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Path resolution — `${policy}` + `ilmPolicyTemplate`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:341-343` (`deploymentJsonPath`), `:370-372` (add `ilmPolicyTemplate`)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `ilm-rollout.test.ts` (add `deploymentJsonPath` to the import):

```ts
describe("deploymentJsonPath — ${policy} substitution", () => {
	test("substitutes both cluster and policy, preserving @ and . in the filename", () => {
		const path = deploymentJsonPath(
			"environments/${cluster}/lifecycle-policies/${policy}.json",
			"eu-b2b",
			"30-days@lifecycle",
		);
		expect(path).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
	});

	test("still works for a cluster-only template (back-compat)", () => {
		expect(deploymentJsonPath("environments/_deployments/${cluster}.json", "ap-cld")).toBe(
			"environments/_deployments/ap-cld.json",
		);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "policy"`
Expected: FAIL — `deploymentJsonPath` takes 2 args; the 3-arg call leaves `${policy}` unsubstituted.

- [ ] **Step 3a: Generalize `deploymentJsonPath`**

In `nodes.ts`, replace the current `deploymentJsonPath` (`:341-343`):

```ts
export function deploymentJsonPath(template: string, cluster: string): string {
	return template.replace(/\$\{cluster\}/g, cluster);
}
```

with:

```ts
// Resolve a per-deployment/per-policy JSON path from a configured template. ${cluster}
// and ${policy} are literal placeholders (config, not JS template literals). The policy
// filename is substituted verbatim (it legitimately contains '@' and '.').
export function deploymentJsonPath(template: string, cluster: string, policy?: string): string {
	let out = template.replace(/\$\{cluster\}/g, cluster);
	if (policy !== undefined) out = out.replace(/\$\{policy\}/g, policy);
	return out;
}
```

- [ ] **Step 3b: Add `ilmPolicyTemplate`**

In `nodes.ts`, immediately after `deploymentJsonTemplate()` (ends ~line 372), add:

```ts
// SIO-880: agent-side path template for ILM lifecycle-policy JSON. ${cluster}/${policy}
// are literal placeholders. Lazy process.env read (no module-scope Bun.env; the web app
// runs Vite SSR where a top-level Bun.env reference throws "Bun is not defined").
function ilmPolicyTemplate(): string {
	return process.env.ELASTIC_IAC_ILM_POLICY_TEMPLATE ?? "environments/${cluster}/lifecycle-policies/${policy}.json";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "policy"`
Expected: PASS. (`ilmPolicyTemplate` is unused until Task 6 — that is fine; do not export it.)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: deploymentJsonPath gains \${policy}; add ilmPolicyTemplate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `branchSlug` descriptor for ilm-rollout

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:348-357` (`branchSlug`)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `ilm-rollout.test.ts` (add `branchSlug` to the import; `IacRequest` is a type import — add `import type { IacRequest } from "./state.ts";`):

```ts
describe("branchSlug — ilm-rollout", () => {
	test("uses policyName as the descriptor and slugs @/.", () => {
		const req: IacRequest = {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
		};
		// slug lowercases and replaces non-[a-z0-9-] runs with a single '-'
		expect(branchSlug(req)).toBe("eu-b2b-30-days-lifecycle-ilm-rollout");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "branchSlug"`
Expected: FAIL — descriptor falls through to `req.tier ?? req.resource` (undefined) so the policy name is missing from the slug.

- [ ] **Step 3: Add the ilm-rollout descriptor branch**

In `nodes.ts`, in `branchSlug` (`:348-357`), replace the `descriptor` line:

```ts
	const descriptor = req.workflow === "version-upgrade" ? req.version : (req.tier ?? req.resource);
```

with:

```ts
	const descriptor =
		req.workflow === "version-upgrade"
			? req.version
			: req.workflow === "ilm-rollout"
				? req.policyName
				: (req.tier ?? req.resource);
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "branchSlug"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: branchSlug uses policyName for ilm-rollout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `retentionChange` state + `proposeIlmChange` node + `draftChange` route

**Files:**
- Modify: `packages/agent/src/iac/state.ts:62-105` (add `retentionChange` annotation)
- Modify: `packages/agent/src/iac/nodes.ts` (add `proposeIlmChange` after `proposeTierResize`, ~line 497; add route in `draftChange` `:501-505`)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append node-level tests)

- [ ] **Step 1: Add the `retentionChange` annotation (no test — state shape)**

In `state.ts`, inside `IacState = Annotation.Root({ ... })`, after the `failureHint` annotation (`:98`), add:

```ts
	// SIO-880: when an ilm-rollout reduces delete.min_age, the from/to surfaced as a
	// HIGH-risk line in the review card + MR body (data deletion is irreversible).
	retentionChange: Annotation<{ from: string; to: string } | null>({ reducer: last, default: () => null }),
```

- [ ] **Step 2: Write the failing node-level tests**

Append to `ilm-rollout.test.ts`. This mirrors how `version-upgrade.test.ts` exercises a proposer by mocking the tool layer. `proposeIlmChange` is not exported (it is a node-level function); test it through `draftChange`, which IS reachable, by mocking `getToolsForDataSource` so `callTool` resolves. Use Bun's `mock.module` on `../mcp-bridge.ts`:

```ts
import { mock } from "bun:test";

// Build a fake tool set so callTool() inside nodes.ts resolves against our stubs.
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
		getToolsForDataSource_unused: undefined,
	}));
}

describe("draftChange -> proposeIlmChange", () => {
	test("happy path: edits the policy JSON, commits, sets precheckPassed + diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "30-days@lifecycle", delete: { min_age: "30d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () => `[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: "30-days@lifecycle",
				phasesPatch: { delete: { min_age: "60d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
		expect(result.proposedDiff).toContain('"min_age"');
		expect(result.retentionChange).toBeNull(); // 30d -> 60d is an INCREASE, not a reduction
	});

	test("blocks with a clear message when phasesPatch is empty", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "ilm-rollout" as const, isProd: false, cluster: "eu-b2b", policyName: "logs" },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("phase field");
	});

	test("blocks when the policy file 404s", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => "[404] {\"message\":\"404 File Not Found\"}" });
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: "no-such-policy",
				phasesPatch: { delete: { min_age: "60d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("no such policy");
	});

	test("sets retentionChange when retention is reduced", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "90-days@lifecycle", delete: { min_age: "90d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () => `[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-cld",
				policyName: "90-days@lifecycle",
				phasesPatch: { delete: { min_age: "30d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.retentionChange).toEqual({ from: "90d", to: "30d" });
	});
});
```

> Note on mock pollution (memory `reference_mock_pollution_own_in_beforeeach`): `mock.module` is process-global + last-wins. Each test calls `mockTools(...)` fresh and re-imports `./nodes.ts`, so the stub is re-asserted per test. Keep the `mockTools` call as the first line of each test body.

- [ ] **Step 3: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "proposeIlmChange"`
Expected: FAIL — `draftChange` has no ilm-rollout route; it falls through to the legacy terraform path and calls `git_create_branch` (no `retentionChange`/`proposedFilePath` set as asserted).

- [ ] **Step 4a: Implement `proposeIlmChange`**

In `nodes.ts`, immediately after `proposeTierResize` (ends ~line 497, the line `	}` closing the function before `// Draft the change.`), add:

```ts
// SIO-880: ilm-rollout via the GitOps proposer -- deep-merge a phase patch into the
// cluster's lifecycle-policy JSON and open an MR via the API. Mirrors proposeTierResize.
async function proposeIlmChange(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const policy = req.policyName ?? "";
	const patch = req.phasesPatch;

	if (!policy || !patch || Object.keys(patch).length === 0) {
		return {
			blockedReason: "ILM change needs a policy name and at least one phase field to change.",
			messages: [new AIMessage("Cannot propose the change: name the policy and at least one phase field to change.")],
		};
	}

	const filePath = deploymentJsonPath(ilmPolicyTemplate(), cluster, policy);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// A missing policy file comes back as a 4xx from the GitLab files API.
	if (raw.startsWith("[4")) {
		return {
			blockedReason: `No such policy '${policy}' on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(`Cannot propose the change: no such policy '${policy}' on '${cluster}'. Check the policy filename.`),
			],
		};
	}

	let updated: { content: string; previous: Record<string, unknown> };
	try {
		updated = mergeIlmPhases(extractFileContent(raw), patch);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	const retentionChange = detectRetentionReduction(updated.previous, patch);

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const fields = Object.keys(patch).join(", ");
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: ILM ${policy} (${fields})`,
	});
	const committed = !commit.startsWith("[4") && !commit.startsWith("[5");

	// Human diff: one -/+ pair per touched leaf, walking the previous mirror against patch.
	const diffLines: string[] = [`${filePath} (ILM ${policy})`];
	const walk = (prev: Record<string, unknown>, p: Record<string, unknown>, prefix: string): void => {
		for (const [key, value] of Object.entries(p)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const prevChild = (prev[key] ?? {}) as Record<string, unknown>;
				walk(prevChild, value as Record<string, unknown>, path);
			} else {
				diffLines.push(`- "${path}": ${JSON.stringify(prev[key])}\n+ "${path}": ${JSON.stringify(value)}`);
			}
		}
	};
	walk(updated.previous, patch, "");

	return {
		branch,
		proposedFilePath: filePath,
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		retentionChange,
	};
}
```

- [ ] **Step 4b: Route ilm-rollout in `draftChange`**

In `nodes.ts`, in `draftChange` (`:501-505`), after the `if (req.workflow === "tier-resize") return proposeTierResize(state, req);` line, add:

```ts
	if (req.workflow === "ilm-rollout") return proposeIlmChange(state, req);
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "proposeIlmChange"`
Expected: PASS (4 node-level tests).

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @devops-agent/agent typecheck
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: proposeIlmChange node + draftChange route + retentionChange state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `reviewPlan` wiring (config-edit + ILM risks + descriptor)

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:526-582` (`reviewPlan`)
- Test: `packages/agent/src/iac/ilm-rollout.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `ilm-rollout.test.ts`:

```ts
describe("reviewPlan — ilm-rollout", () => {
	const baseState = (retentionChange: { from: string; to: string } | null) => ({
		iacRequest: {
			workflow: "ilm-rollout" as const,
			isProd: false,
			cluster: "eu-cld",
			policyName: "90-days@lifecycle",
			phasesPatch: { delete: { min_age: retentionChange?.to ?? "120d" } },
		},
		branch: "agent/eu-cld-90-days-lifecycle-ilm-rollout-20260602",
		proposedDiff: "diff",
		precheckPassed: true,
		retentionChange,
	});

	test("marks the review kind config-edit and skips local terraform", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState(null) as any);
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.plan).toContain("CI computes the Terraform plan");
	});

	test("adds the always-on ILM phase-transition risk", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState(null) as any);
		expect(result.risks?.some((r) => r.includes("force-merge") || r.includes("rolls over"))).toBe(true);
	});

	test("prepends a HIGH retention-reduction risk when retention is reduced", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState({ from: "90d", to: "30d" }) as any);
		expect(result.risks?.[0]).toContain("Retention REDUCED 90d->30d");
		expect(result.risks?.[0]).toContain("irrecoverable");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "reviewPlan"`
Expected: FAIL — `isConfigEdit` does not include ilm-rollout (kind is "terraform" and it tries `terraform_validate`); no ILM risks.

- [ ] **Step 3a: Add ilm-rollout to `isConfigEdit`**

In `nodes.ts`, in `reviewPlan` (`:532`), replace:

```ts
	const isConfigEdit = isUpgrade || req?.workflow === "tier-resize";
```

with:

```ts
	const isConfigEdit = isUpgrade || req?.workflow === "tier-resize" || req?.workflow === "ilm-rollout";
```

- [ ] **Step 3b: Replace the existing ilm-rollout risk line and add the retention HIGH line**

In `nodes.ts`, in the risks block (`:546-557`), the current ilm-rollout risk is:

```ts
	if (req?.workflow === "ilm-rollout")
		risks.push("ILM phase change can pull frozen data in and cause force-merge load.");
```

Replace it with:

```ts
	if (req?.workflow === "ilm-rollout") {
		risks.push(
			"ILM phase change can trigger force-merge load / frozen pull-in; transitions take effect as each index rolls over, not immediately.",
		);
		// SIO-880: a retention REDUCTION is irreversible data loss -- surface as HIGH (first).
		if (state.retentionChange) {
			risks.unshift(
				`Retention REDUCED ${state.retentionChange.from}->${state.retentionChange.to}; data deleted at apply is irrecoverable -- confirm the IR/issue reference before merge.`,
			);
		}
	}
```

- [ ] **Step 3c: Add the ilm-rollout descriptor**

In `nodes.ts`, in the `descriptor` ternary (`:566-570`), it currently ends:

```ts
			: (req?.tier ?? req?.resource ?? "change");
```

Replace that final branch with:

```ts
			: req?.workflow === "ilm-rollout"
				? `${req?.policyName ?? "?"}: ${Object.keys(req?.phasesPatch ?? {}).join(", ") || "change"}`
				: (req?.tier ?? req?.resource ?? "change");
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts -t "reviewPlan"`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @devops-agent/agent typecheck
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-880: reviewPlan ILM wiring (config-edit, risks, HIGH retention reduction)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `buildMrDescription` ILM clause

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:627-663` (`buildMrDescription`)
- Test: covered by the live e2e in Task 10 (this node calls the LLM; the deterministic part is the context string + categoryRisk, asserted indirectly). No new unit test — `buildMrDescription` has no existing unit coverage and mocking the LLM here adds no value over the e2e.

- [ ] **Step 1: Add the ilm-rollout context clause**

In `nodes.ts`, in `buildMrDescription`, in the `context` array (`:632-646`), after the tier-resize clause (the line ending `...max -> ${req.newMaxGb}g\`` : "",`), add:

```ts
				req?.workflow === "ilm-rollout"
					? `ILM policy '${req?.policyName}' phase change: ${JSON.stringify(req?.phasesPatch ?? {})}.${state.retentionChange ? ` Retention REDUCED ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}`
					: "",
```

- [ ] **Step 2: Set the ILM category/risk**

In `nodes.ts`, in `buildMrDescription`, replace the `categoryRisk` line (`:649-650`):

```ts
		const categoryRisk =
			req?.workflow === "tier-resize" ? "Category tier-resize, Risk MEDIUM" : "Category version-bump, Risk LOW";
```

with:

```ts
		const categoryRisk =
			req?.workflow === "ilm-rollout"
				? `Category ilm, Risk ${state.retentionChange ? "HIGH" : "MEDIUM"}`
				: req?.workflow === "tier-resize"
					? "Category tier-resize, Risk MEDIUM"
					: "Category version-bump, Risk LOW";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full iac suite (regression)**

Run: `bun test packages/agent/src/iac`
Expected: PASS (all existing + new ILM tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-880: buildMrDescription ILM clause + category/risk (HIGH on reduction)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Docs — `.env.example` + RULES.md

**Files:**
- Modify: `.env.example:171`
- Modify: `agents/elastic-iac/RULES.md:14`

- [ ] **Step 1: Add the env var to `.env.example`**

In `.env.example`, after the `# ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE=...` line (`:171`), add:

```bash
# SIO-880: agent-side path template for ILM lifecycle-policy JSON (${cluster}/${policy} literal placeholders)
# ELASTIC_IAC_ILM_POLICY_TEMPLATE=environments/${cluster}/lifecycle-policies/${policy}.json
```

- [ ] **Step 2: Extend RULES.md rule 8**

In `agents/elastic-iac/RULES.md`, rule 8 (`:14`) currently ends:

> ...a tier resize is `elasticsearch.<tier>.size` / `.max_size` (string `"<N>g"`; reduce `size` before `max_size`, and `max_size >= size`).

Append to that sentence:

```
 An ILM change edits the lifecycle-policy JSON `environments/<deployment>/lifecycle-policies/<policy>.json` (top-level phase keys hot/warm/cold/delete; retention is `delete.min_age`); reducing retention is irreversible data loss and is surfaced as HIGH risk for the human to confirm.
```

- [ ] **Step 3: yaml:check + commit**

```bash
bun run yaml:check
git add .env.example agents/elastic-iac/RULES.md
git commit -m "SIO-880: document ELASTIC_IAC_ILM_POLICY_TEMPLATE + RULES.md ILM path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full verification + live e2e

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + lint + yaml + tests**

```bash
bun run typecheck && bun run lint && bun run yaml:check && bun test packages/agent/src/iac
```
Expected: all green. (If `bun run lint` flags type-import ordering, fix per memory `reference_biome_type_before_value_imports` — `type` imports before value imports.)

- [ ] **Step 2: Cold-restart the web server (agent + graph changes need it)**

```bash
lsof -i :5173 -sTCP:LISTEN -t | xargs -r kill
bun run --filter @devops-agent/web dev &
# wait for "Local: http://localhost:5173"
```
(Per memory `reference_agent_knowledge_cached_per_process` + `reference_bun_hot_does_not_reresolve_modules`: `bun --hot` does not reload `agents/elastic-iac/**` or new graph nodes; a cold restart is mandatory.)

- [ ] **Step 3: Live ILM change against a NON-PROD policy**

In the UI: switch to the Elastic IaC agent. Send (pick a real non-prod policy from `environments/gl-testing/lifecycle-policies/` or a dev policy):

> set gl-testing 30-days@lifecycle retention to 60 days

Expected: a plan-review card with `kind: config-edit`, the JSON diff `- "delete.min_age": "30d"` / `+ "delete.min_age": "60d"`, Risk MEDIUM (increase, not a reduction), and "CI computes the plan on the MR". Approve -> live ticker -> final shows MR link + pipeline status + plan + approval.

- [ ] **Step 4: Live retention-REDUCTION sanity check (do NOT approve)**

Send:

> set gl-testing 30-days@lifecycle retention to 7 days

Expected: the review card shows Risk HIGH and a "Retention REDUCED 30d->7d ... irrecoverable" risk line as the FIRST risk. **Reject it** (this is only to confirm the HIGH-risk surfacing).

- [ ] **Step 5: Test-MR hygiene — close the MR + delete the branch**

For the MR opened in Step 3 (read the iid from the final message / `gitlab_list_agent_merge_requests`):

```bash
TOKEN=$(grep "^ELASTIC_IAC_GITLAB_TOKEN=" .env | cut -d= -f2-)
BASE=https://gitlab.siobytes.cloud
PROJ=$(printf 'siobytes/elastic-iac' | jq -sRr @uri)
# close the MR
curl -s -X PUT "$BASE/api/v4/projects/$PROJ/merge_requests/<iid>?state_event=close" -H "PRIVATE-TOKEN: $TOKEN" >/dev/null
# delete the branch (url-encode agent/...)
BR=$(printf 'agent/gl-testing-30-days-lifecycle-ilm-rollout-<date>' | jq -sRr @uri)
curl -s -X DELETE "$BASE/api/v4/projects/$PROJ/repository/branches/$BR" -H "PRIVATE-TOKEN: $TOKEN" >/dev/null
```

Confirm `main`'s `gl-testing/lifecycle-policies/30-days@lifecycle.json` is untouched.

- [ ] **Step 6: Kill the dev server**

```bash
lsof -i :5173 -sTCP:LISTEN -t | xargs -r kill
```

---

## Task 11: PR

- [ ] **Step 1: Push + open the PR**

```bash
git push -u origin sio-880-ilm-rollout-gitops-proposer
gh pr create --base main --title "SIO-880: ilm-rollout via the GitOps proposer (single-MR, phase patch)" --body "$(cat <<'EOF'
Closes the elastic-iac GitOps proposer arc. ilm-rollout now edits the cluster's
lifecycle-policy JSON (`environments/<cluster>/lifecycle-policies/<policy>.json`)
and opens one MR via the GitLab API, mirroring SIO-873/SIO-879. Single-MR per
invocation (no wave choreography); general phase patch via mergeIlmPhases;
modify-only with verify-exists resolution; a retention reduction is surfaced as
HIGH risk but never auto-blocked.

Spec: docs/superpowers/specs/2026-06-02-ilm-rollout-gitops-proposer-design.md
Plan: docs/superpowers/plans/2026-06-02-sio-880-ilm-rollout-gitops-proposer.md

- [x] typecheck / lint / yaml:check / bun test packages/agent/src/iac
- [x] live e2e on gl-testing (retention increase) + HIGH-risk reduction surfacing
- [x] test MR closed + branch deleted; main policy JSON untouched

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Move SIO-880 to In Review**

(Done via Linear after the PR is open — leave it In Progress until the PR exists; never set Done without user approval.)

---

## Notes for the implementer

- **TDD discipline:** every Task 1-7 step writes the test first, watches it fail, then implements. Task 8 is the one exception (LLM-backed node, covered by e2e) — it is explicitly called out.
- **No `any`:** the only `as any` casts are partial-state test stubs, each with a `biome-ignore: SIO-880` comment (the project allows this for test stubs per CLAUDE.md). Production code uses `Record<string, unknown>` + narrowing.
- **No new MCP tools:** verified during design — the `propose` action in `agents/elastic-iac/tools/elastic-iac.yaml` already maps `gitlab_get_file_content` / `gitlab_create_branch` / `gitlab_commit_file`. No tool-count canaries to bump.
- **Cold restart** before any UI test (Task 10 Step 2).
- **Memory refs:** `reference_elastic_iac_ilm_policy_json_shape`, `project_elastic_iac_gitops_proposer_model`, `reference_mock_pollution_own_in_beforeeach`, `reference_agent_knowledge_cached_per_process`, `reference_bun_hot_does_not_reresolve_modules`, `reference_no_module_scope_bun_env_in_agent`, `reference_biome_type_before_value_imports`.
