# elastic-iac ILM: nested shape + validator + copy-from-reference + cluster de-bias — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the elastic-iac ILM proposer produce CI-valid (nested) policy JSON by basing output on a real repo policy, validating structure before commit, supporting `sourcePolicy` copy-from-reference, and extracting the cluster from the user's words instead of anchoring on `eu-b2b`.

**Architecture:** `proposeIlmChange` stops inventing structure. A copy reads the source policy (already correctly shaped) as the base; a from-scratch create reads a sibling policy in the same cluster's `lifecycle-policies/` dir as a structural template (canonical fallback if none); both merge the LLM's `phasesPatch` overrides on top via the existing shape-agnostic `mergeIlmPhases`. A pure `validateIlmPolicy` (Zod mirroring `modules/lifecycle/variables.tf`) runs after merge and blocks malformed output before the MR. The parseIntent prompt is corrected to the nested shape and de-biased on cluster names.

**Tech Stack:** Bun, TypeScript (strict, no `any`), Zod, LangGraph, `bun:test`, Biome.

**Ticket:** [SIO-931](https://linear.app/siobytes/issue/SIO-931). **Spec:** `docs/superpowers/specs/2026-06-17-iac-ilm-schema-copy-design.md`. **Branch:** `SIO-931-iac-ilm-schema-copy` (off `main`; spec already committed).

---

## Ground-truth shapes (copy these verbatim into fixtures)

Real CI-valid policy (`environments/us-cld/lifecycle-policies/us-default-lifecycle-logs-prod.json`):
```json
{ "name": "us-default-lifecycle-logs-prod",
  "hot": { "priority": 100, "max_age": "7d", "max_primary_shard_size": "10gb", "rollover": true },
  "warm": { "min_age": "6h", "priority": 50, "allocate": { "number_of_replicas": 0 },
            "forcemerge": { "max_num_segments": 1 }, "shrink": { "number_of_shards": 1, "allow_write_after_shrink": false } },
  "cold": { "min_age": "2d", "priority": 25, "allocate": { "number_of_replicas": 0 } },
  "frozen": { "min_age": "7d", "searchable_snapshot": { "snapshot_repository": "found-snapshots", "force_merge_index": true } },
  "delete": { "min_age": "60d", "delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } } }
```

The flat mistakes the validator must reject: `hot.set_priority`, bare `warm.number_of_replicas`, `warm.forcemerge_max_num_segments`, `warm.shrink_number_of_shards`, `cold.number_of_replicas`, `frozen.searchable_snapshot_repository`, `frozen.force_merge_index` (flat), `delete.wait_for_snapshot_policy`.

---

## File structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/agent/src/iac/state.ts` | `sourcePolicy?: string` on `IacRequest` | Modified |
| `packages/agent/src/iac/nodes.ts` | `IntentSchema.sourcePolicy` + normalizer; `validateIlmPolicy` + `CANONICAL_ILM_SHAPE`; `parseRepoTreeFiles`; `proposeIlmChange` copy/template/validate branches; parseIntent ILM instruction (nested + sourcePolicy + cluster rule); rotate example clusters; copy MR summary | Modified |
| `packages/agent/src/iac/ilm-validate.test.ts` | `validateIlmPolicy` tests | Created |
| `packages/agent/src/iac/ilm-copy.test.ts` | copy + template + parseIntent `sourcePolicy` tests | Created |
| `packages/agent/src/iac/ilm-rollout.test.ts` | rewrite the invented-shape (`set_priority`) fixture | Modified |
| `agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md`, `10-quick-reference.md` | align ILM examples to nested repo shape | Modified |

---

## Task 1: `validateIlmPolicy` + `CANONICAL_ILM_SHAPE`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add near `mergeIlmPhases`)
- Test: `packages/agent/src/iac/ilm-validate.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/iac/ilm-validate.test.ts`:

```ts
// agent/src/iac/ilm-validate.test.ts
// SIO-931: the policy JSON the agent writes must match modules/lifecycle/variables.tf (nested
// objects), or CI terraform plan rejects it. validateIlmPolicy is the pre-commit gate.
import { describe, expect, test } from "bun:test";
import { CANONICAL_ILM_SHAPE, validateIlmPolicy } from "./nodes.ts";

const GOOD = {
	name: "us-default-lifecycle-logs-prod",
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: {
		min_age: "6h",
		priority: 50,
		allocate: { number_of_replicas: 0 },
		forcemerge: { max_num_segments: 1 },
		shrink: { number_of_shards: 1, allow_write_after_shrink: false },
	},
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
};

describe("validateIlmPolicy (SIO-931)", () => {
	test("accepts a real nested policy", () => {
		expect(validateIlmPolicy(GOOD).ok).toBe(true);
	});

	test("accepts a sparse policy (delete only)", () => {
		expect(validateIlmPolicy({ name: "x", delete: { min_age: "30d" } }).ok).toBe(true);
	});

	test("rejects flat searchable_snapshot_repository with a nested-fix message", () => {
		const r = validateIlmPolicy({ name: "x", frozen: { min_age: "7d", searchable_snapshot_repository: "found-snapshots" } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("searchable_snapshot");
	});

	test("rejects set_priority", () => {
		const r = validateIlmPolicy({ name: "x", hot: { set_priority: { priority: 100 } } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("priority");
	});

	test("rejects bare number_of_replicas on warm", () => {
		const r = validateIlmPolicy({ name: "x", warm: { min_age: "1d", number_of_replicas: 0 } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("allocate");
	});

	test("rejects flat forcemerge_max_num_segments / shrink_number_of_shards", () => {
		expect(validateIlmPolicy({ name: "x", warm: { min_age: "1d", forcemerge_max_num_segments: 1 } }).ok).toBe(false);
		expect(validateIlmPolicy({ name: "x", warm: { min_age: "1d", shrink_number_of_shards: 1 } }).ok).toBe(false);
	});

	test("rejects flat wait_for_snapshot_policy", () => {
		const r = validateIlmPolicy({ name: "x", delete: { min_age: "60d", wait_for_snapshot_policy: "cloud-snapshot-policy" } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("wait_for_snapshot");
	});

	test("requires searchable_snapshot when frozen is present", () => {
		expect(validateIlmPolicy({ name: "x", frozen: { min_age: "7d" } }).ok).toBe(false);
	});

	test("CANONICAL_ILM_SHAPE is itself valid", () => {
		expect(validateIlmPolicy({ ...CANONICAL_ILM_SHAPE, name: "anything" }).ok).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/ilm-validate.test.ts`
Expected: FAIL — `validateIlmPolicy` / `CANONICAL_ILM_SHAPE` not exported.

- [ ] **Step 3: Implement the validator + canonical shape**

In `packages/agent/src/iac/nodes.ts`, immediately AFTER `mergeIlmPhases` (find its closing `}` via `grep -n 'export function mergeIlmPhases' nodes.ts`), add:

```ts
// SIO-931: a canonical correctly-shaped policy skeleton, mirroring the repo's
// us-default-lifecycle-logs-prod.json. Used as the from-scratch base ONLY when no sibling
// policy exists in the cluster's lifecycle-policies/ dir to copy the shape from.
export const CANONICAL_ILM_SHAPE = {
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: {
		min_age: "1d",
		priority: 50,
		allocate: { number_of_replicas: 0 },
		forcemerge: { max_num_segments: 1 },
		shrink: { number_of_shards: 1, allow_write_after_shrink: false },
	},
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
} as const;

// SIO-931: structural schema mirroring modules/lifecycle/variables.tf. Each phase is optional;
// within a present phase the nested objects are required where the module requires them, and
// .strict() rejects unknown keys so the agent's old flat shape (searchable_snapshot_repository,
// set_priority, bare number_of_replicas, ...) is caught here rather than by CI terraform plan.
const IlmPolicySchema = z
	.object({
		name: z.string(),
		metadata: z.string().optional(),
		hot: z
			.object({
				max_age: z.string().optional(),
				max_size: z.string().optional(),
				max_primary_shard_size: z.string().optional(),
				min_docs: z.number().optional(),
				priority: z.number().optional(),
				rollover: z.boolean().optional(),
			})
			.strict()
			.optional(),
		warm: z
			.object({
				min_age: z.string().optional(),
				priority: z.number().optional(),
				allocate: z.object({ number_of_replicas: z.number() }).strict().optional(),
				forcemerge: z.object({ max_num_segments: z.number() }).strict().optional(),
				shrink: z
					.object({ number_of_shards: z.number(), allow_write_after_shrink: z.boolean().optional() })
					.strict()
					.optional(),
				readonly: z.boolean().optional(),
			})
			.strict()
			.optional(),
		cold: z
			.object({
				min_age: z.string().optional(),
				priority: z.number().optional(),
				allocate: z.object({ number_of_replicas: z.number() }).strict().optional(),
				readonly: z.boolean().optional(),
			})
			.strict()
			.optional(),
		frozen: z
			.object({
				min_age: z.string().optional(),
				searchable_snapshot: z
					.object({ snapshot_repository: z.string(), force_merge_index: z.boolean().optional() })
					.strict(),
			})
			.strict()
			.optional(),
		delete: z
			.object({
				min_age: z.string().optional(),
				delete_searchable_snapshot: z.boolean().optional(),
				wait_for_snapshot: z.object({ policy: z.string() }).strict().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

// Translate the most common flat-shape mistakes into a targeted nested-fix hint, so the blocked
// message tells the user EXACTLY what to change instead of a raw Zod path.
function flatShapeHint(policy: Record<string, unknown>): string | null {
	const phase = (k: string): Record<string, unknown> =>
		(typeof policy[k] === "object" && policy[k] !== null ? policy[k] : {}) as Record<string, unknown>;
	if ("set_priority" in phase("hot") || "set_priority" in phase("warm") || "set_priority" in phase("cold"))
		return "use `priority` (a number) on the phase, not `set_priority`.";
	if ("number_of_replicas" in phase("warm") || "number_of_replicas" in phase("cold"))
		return "set replicas via `allocate: { number_of_replicas }`, not a bare number_of_replicas on the phase.";
	if ("forcemerge_max_num_segments" in phase("warm"))
		return "use nested `forcemerge: { max_num_segments }`, not flat forcemerge_max_num_segments.";
	if ("shrink_number_of_shards" in phase("warm"))
		return "use nested `shrink: { number_of_shards }`, not flat shrink_number_of_shards.";
	if ("searchable_snapshot_repository" in phase("frozen") || "force_merge_index" in phase("frozen"))
		return "use nested `searchable_snapshot: { snapshot_repository, force_merge_index }`, not flat searchable_snapshot_repository / force_merge_index.";
	if ("wait_for_snapshot_policy" in phase("delete"))
		return "use nested `wait_for_snapshot: { policy }`, not flat wait_for_snapshot_policy.";
	return null;
}

// SIO-931: validate a built ILM policy against the repo/module schema BEFORE commit. (Pure.)
export function validateIlmPolicy(policy: unknown): { ok: true } | { ok: false; reason: string } {
	const parsed = IlmPolicySchema.safeParse(policy);
	if (parsed.success) return { ok: true };
	const hint = typeof policy === "object" && policy !== null ? flatShapeHint(policy as Record<string, unknown>) : null;
	const first = parsed.error.issues[0];
	const where = first ? first.path.join(".") || "(root)" : "(unknown)";
	const detail = first ? `${where}: ${first.message}` : "invalid policy structure";
	return { ok: false, reason: hint ? `${detail}. ${hint}` : detail };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/ilm-validate.test.ts`
Expected: PASS (all 9 cases). If "requires searchable_snapshot when frozen present" fails, confirm `frozen.searchable_snapshot` is NOT `.optional()` in the schema.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-validate.test.ts
git commit -m "SIO-931: validateIlmPolicy + CANONICAL_ILM_SHAPE (structural gate)"
```

---

## Task 2: `sourcePolicy` on the request + intent extraction

**Files:**
- Modify: `packages/agent/src/iac/state.ts` (`IacRequest`)
- Modify: `packages/agent/src/iac/nodes.ts` (`IntentSchema`, `parseIntentJson` normalizer)
- Test: `packages/agent/src/iac/ilm-copy.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/iac/ilm-copy.test.ts`:

```ts
// agent/src/iac/ilm-copy.test.ts
// SIO-931: copy-from-reference. parseIntentJson lifts sourcePolicy; proposeIlmChange uses the
// source policy as the (correctly-shaped) base and merges overrides.
import { describe, expect, test } from "bun:test";
import { parseIntentJson } from "./nodes.ts";

describe("parseIntentJson sourcePolicy (SIO-931)", () => {
	test("lifts sourcePolicy + policyName from a copy request", () => {
		const req = parseIntentJson(
			JSON.stringify({ workflow: "ilm-rollout", cluster: "us-cld", policyName: "logs@lifecycle", sourcePolicy: "us-default-lifecycle-logs-prod" }),
		);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.policyName).toBe("logs@lifecycle");
		expect(req.sourcePolicy).toBe("us-default-lifecycle-logs-prod");
	});

	test("sourcePolicy is undefined for a plain change", () => {
		const req = parseIntentJson(JSON.stringify({ workflow: "ilm-rollout", cluster: "us-cld", policyName: "logs", phasesPatch: { delete: { min_age: "60d" } } }));
		expect(req.sourcePolicy).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: FAIL — `req.sourcePolicy` is `undefined` even when provided (not in schema/normalizer).

- [ ] **Step 3: Add `sourcePolicy` to the type**

In `packages/agent/src/iac/state.ts`, in `interface IacRequest`, immediately after the `phasesPatch?` field (search `phasesPatch?: Record`), add:

```ts
	// SIO-931: ilm-rollout "copy/clone/exact copy of <policy>" -- the reference policy filename to
	// read from the SAME cluster's lifecycle-policies/ dir and use as the (correctly-shaped) base.
	sourcePolicy?: string;
```

- [ ] **Step 4: Add `sourcePolicy` to `IntentSchema` + normalizer**

In `packages/agent/src/iac/nodes.ts`, in `IntentSchema` add after the `policyName` field (search `policyName: z.string().nullish()`):

```ts
	sourcePolicy: z.string().nullish(),
```

And in `parseIntentJson`, in the returned object after `policyName: nn(p.policyName),` (line ~159), add:

```ts
					sourcePolicy: nn(p.sourcePolicy),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-copy.test.ts
git commit -m "SIO-931: sourcePolicy field + intent extraction"
```

---

## Task 3: `parseRepoTreeFiles` helper

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add near `parseRepoTreeDirs`)
- Test: `packages/agent/src/iac/ilm-copy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/iac/ilm-copy.test.ts`:

```ts
import { parseRepoTreeFiles } from "./nodes.ts";

describe("parseRepoTreeFiles (SIO-931)", () => {
	test("returns blob names, ignoring trees", () => {
		const tree = `[200] ${JSON.stringify([
			{ name: "basic-lifecycle-logs.json", type: "blob" },
			{ name: "us-default-lifecycle-logs-prod.json", type: "blob" },
			{ name: "subdir", type: "tree" },
		])}`;
		expect(parseRepoTreeFiles(tree)).toEqual(["basic-lifecycle-logs.json", "us-default-lifecycle-logs-prod.json"]);
	});

	test("empty on unparseable", () => {
		expect(parseRepoTreeFiles("[404] not found")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: FAIL — `parseRepoTreeFiles` not exported.

- [ ] **Step 3: Implement it**

In `packages/agent/src/iac/nodes.ts`, immediately AFTER `parseRepoTreeDirs` (ends with `}`), add:

```ts
// SIO-931: file (blob) names from a gitlab_get_repository_tree response, the sibling-policy
// counterpart to parseRepoTreeDirs. Used to pick a structural template for a from-scratch ILM
// policy. (Pure; unit-tested.)
export function parseRepoTreeFiles(toolResult: string): string[] {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return [];
	try {
		const arr = JSON.parse(toolResult.slice(m.index)) as Array<{ name?: unknown; type?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.filter((e) => e.type === "blob" && typeof e.name === "string").map((e) => e.name as string);
	} catch {
		return [];
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-copy.test.ts
git commit -m "SIO-931: parseRepoTreeFiles helper"
```

---

## Task 4: Restructure `proposeIlmChange` — copy / template / validate

This is the core change. `proposeIlmChange` gains a base-resolution step (copy source, or sibling template, or canonical fallback) and a validation gate, before the existing commit/diff logic. The current new-policy line `mergeIlmPhases(JSON.stringify({ name: policy }), patch)` is replaced.

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`proposeIlmChange`, ~lines 1696-1817)
- Test: `packages/agent/src/iac/ilm-copy.test.ts`

- [ ] **Step 1: Write the failing test (copy path + validation)**

Append to `packages/agent/src/iac/ilm-copy.test.ts`. These mock the GitLab tools so the proposer is deterministic:

```ts
import { mock } from "bun:test";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const SOURCE_JSON = JSON.stringify({
	name: "us-default-lifecycle-logs-prod",
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: { min_age: "6h", priority: 50, allocate: { number_of_replicas: 0 }, forcemerge: { max_num_segments: 1 }, shrink: { number_of_shards: 1, allow_write_after_shrink: false } },
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
});
const b64 = (s: string) => `[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;

// Build a getToolsForDataSource mock whose tools return scripted callTool results keyed by tool name.
function mockBridge(byTool: Record<string, (args: Record<string, unknown>) => string>) {
	mock.module("../mcp-bridge.ts", () => ({
		getConnectedServers: () => ["elastic-iac-mcp"],
		getToolsForDataSource: () =>
			Object.keys(byTool).map((name) => ({ name, invoke: async (args: Record<string, unknown>) => byTool[name](args) })),
	}));
}

describe("proposeIlmChange copy path (SIO-931)", () => {
	test("copies the source policy (nested), applies override, passes validation", async () => {
		const committed: { content?: string } = {};
		mockBridge({
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("us-default-lifecycle-logs-prod") ? b64(SOURCE_JSON) : "[404] not found",
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (a) => {
				committed.content = String(a.content);
				return "[201] {}";
			},
		});
		// Re-import after the mock so nodes.ts binds the mocked bridge.
		const { proposeIlmChange } = (await import("./nodes.ts")) as typeof import("./nodes.ts");
		// proposeIlmChange is not exported today -> Step 3 exports it.
		const out = await proposeIlmChange(
			asIacState({}),
			{ workflow: "ilm-rollout", isProd: false, cluster: "us-cld", policyName: "logs@lifecycle", sourcePolicy: "us-default-lifecycle-logs-prod", phasesPatch: { delete: { min_age: "60d" } } },
		);
		expect(out.blockedReason).toBeFalsy();
		const policy = JSON.parse(committed.content ?? "{}");
		expect(policy.name).toBe("logs@lifecycle");
		expect(policy.frozen.searchable_snapshot.snapshot_repository).toBe("found-snapshots");
		expect(policy.warm.allocate.number_of_replicas).toBe(0);
		expect(policy.delete.min_age).toBe("60d");
	});

	test("blocks when the source policy can't be read (404)", async () => {
		mockBridge({ gitlab_get_file_content: () => "[404] not found" });
		const { proposeIlmChange } = await import("./nodes.ts");
		const out = await proposeIlmChange(
			asIacState({}),
			{ workflow: "ilm-rollout", isProd: false, cluster: "us-cld", policyName: "logs@lifecycle", sourcePolicy: "does-not-exist" },
		);
		expect(out.blockedReason).toBeTruthy();
		expect(String(out.messages?.[0]?.content)).toContain("does-not-exist");
	});
});
```

Note: `proposeIlmChange` is currently a private (non-exported) function. Step 3 exports it for testing (other proposers stay private; this one needs a focused test). Per `reference_mock_pollution_own_in_beforeeach`, these `mock.module` calls are scoped to this file; the earlier `describe`s use pure functions that don't load the bridge at call time, so order is safe.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: FAIL — `proposeIlmChange` not exported / copy branch absent.

- [ ] **Step 3: Restructure `proposeIlmChange`**

In `packages/agent/src/iac/nodes.ts`, change the signature `async function proposeIlmChange(` to `export async function proposeIlmChange(`.

Then replace the base-resolution + validation portion. The current code (lines ~1736-1762) is:

```ts
	if (raw.startsWith("[404")) {
		policyCreated = true;
		updated = mergeIlmPhases(JSON.stringify({ name: policy }), patch);
	} else {
		try {
			updated = mergeIlmPhases(extractFileContent(raw), patch);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}

		// No-op guard: ...
		if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
			return { ...unchanged... };
		}
	}
```

Replace it with (copy branch first, then template-or-empty base for create, then the existing modify path; `patch` may be undefined for a pure copy):

```ts
	const patchObj = (patch ?? {}) as Record<string, unknown>;

	// SIO-931 copy-from-reference: the base is the source policy (already correctly shaped). The
	// source must be readable -- a copy of a policy we can't read is never silently downgraded.
	if (req.sourcePolicy) {
		const srcPath = deploymentJsonPath(ilmPolicyTemplate(), cluster, req.sourcePolicy);
		const srcRaw = await callTool("gitlab_get_file_content", { filePath: srcPath });
		if (!isGitlabSuccess(srcRaw)) {
			return {
				blockedReason: `Could not read reference policy '${req.sourcePolicy}' on '${cluster}': ${srcRaw.slice(0, 80)}.`,
				messages: [
					new AIMessage(
						`I couldn't read reference policy '${req.sourcePolicy}' on '${cluster}' (${srcRaw.slice(0, 40)}). Name an existing policy to copy, or specify the phases directly.`,
					),
				],
			};
		}
		// Re-name the source to the target policy, then merge any explicit overrides on top.
		const srcObj = JSON.parse(extractFileContent(srcRaw)) as Record<string, unknown>;
		srcObj.name = policy;
		policyCreated = !isGitlabSuccess(raw); // target is new if it 404s
		updated = mergeIlmPhases(JSON.stringify(srcObj), patchObj);
	} else if (raw.startsWith("[404")) {
		// SIO-931 from-scratch: learn the shape from a sibling policy in this cluster's dir; fall
		// back to the canonical skeleton when the cluster has no lifecycle-policies/ files yet.
		policyCreated = true;
		const dirPath = `environments/${cluster}/lifecycle-policies`;
		const siblings = parseRepoTreeFiles(await callTool("gitlab_get_repository_tree", { path: dirPath })).filter(
			(f) => f.endsWith(".json") && f !== `${policy}.json`,
		);
		const preferred = process.env.ELASTIC_IAC_ILM_TEMPLATE_POLICY
			? `${process.env.ELASTIC_IAC_ILM_TEMPLATE_POLICY}.json`
			: "basic-lifecycle-logs.json";
		const templateFile = siblings.includes(preferred) ? preferred : siblings[0];
		let base: Record<string, unknown> = { name: policy, ...structuredClone(CANONICAL_ILM_SHAPE) };
		if (templateFile) {
			const tplRaw = await callTool("gitlab_get_file_content", {
				filePath: `${dirPath}/${templateFile}`,
			});
			if (isGitlabSuccess(tplRaw)) {
				const tplObj = JSON.parse(extractFileContent(tplRaw)) as Record<string, unknown>;
				tplObj.name = policy;
				base = tplObj;
			} else {
				log.warn({ cluster, templateFile }, "ilm template sibling unreadable; using canonical shape");
			}
		} else {
			log.warn({ cluster }, "no sibling ILM policy to template from; using canonical shape");
		}
		updated = mergeIlmPhases(JSON.stringify(base), patchObj);
	} else {
		try {
			updated = mergeIlmPhases(extractFileContent(raw), patchObj);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}
		if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
			return {
				blockedReason: `Policy '${policy}' on '${cluster}' already has the requested phase values; no change needed.`,
				messages: [
					new AIMessage(
						`No change needed: policy '${policy}' on '${cluster}' already has the requested phase values. I did not open a merge request.`,
					),
				],
			};
		}
	}

	// SIO-931: structural gate -- never commit a policy CI's terraform plan would reject.
	const valid = validateIlmPolicy(JSON.parse(updated.content));
	if (!valid.ok) {
		return {
			blockedReason: `Proposed ILM policy '${policy}' is structurally invalid: ${valid.reason}`,
			messages: [
				new AIMessage(
					`I won't open an MR: the proposed '${policy}' policy doesn't match the repo schema. ${valid.reason}`,
				),
			],
		};
	}
```

Also relax the early guard that requires a patch: the current `if (!policy || !patch || Object.keys(patch).length === 0)` must allow a pure copy (no patch). Change it to:

```ts
	if (!policy) {
		return {
			blockedReason: "ILM change needs a policy name.",
			messages: [new AIMessage("Cannot propose the change: name the policy to change or create.")],
		};
	}
	if (!req.sourcePolicy && (!patch || Object.keys(patch).length === 0)) {
		return {
			blockedReason: "ILM change needs at least one phase field to change (or a sourcePolicy to copy).",
			messages: [new AIMessage("Cannot propose the change: name a phase field to change, or a policy to copy from.")],
		};
	}
```

(Leave the `fields = Object.keys(patch).join(", ")` line working when `patch` is undefined: change it to `const fields = Object.keys(patchObj).join(", ") || "copy";`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/ilm-copy.test.ts`
Expected: PASS (copy applies override + validates; 404 source blocks).

- [ ] **Step 5: Run the existing ILM tests to catch regressions**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts`
Expected: most PASS; the `set_priority` fixture test (Task 6) may now FAIL because validation rejects it — that's expected and fixed in Task 6. Note which fail; if any OTHER test breaks, stop and re-read.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-copy.test.ts
git commit -m "SIO-931: proposeIlmChange copy/template base + pre-commit validation"
```

---

## Task 5: parseIntent ILM instruction — nested shape, sourcePolicy, cluster rule

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (parseIntent `instruction`, lines ~417-425; cluster rule near the top of `instruction`)

No new unit test (LLM prompt; covered by the manual probe). Typecheck only.

- [ ] **Step 1: Rewrite the ILM phasesPatch instruction to the nested shape**

In `packages/agent/src/iac/nodes.ts`, replace the ILM instruction block (the sentence starting "For an ILM lifecycle-policy change" through "so the created file is complete.", ~lines 417-425) with:

```ts
		"For an ILM lifecycle-policy change ('set us-cld 30-days retention to 60 days', 'forcemerge warm to 1 " +
		"segment on eu-cld logs', 'add a delete phase to .alerts-ilm-policy'), set workflow to 'ilm-rollout', cluster " +
		"to the named deployment, policyName to the policy filename VERBATIM (e.g. '30-days@lifecycle', 'logs@lifecycle', " +
		"'.alerts-ilm-policy'). If the user asks to COPY / clone / mirror / 'same as' / 'exact copy of' an existing " +
		"policy, set sourcePolicy to that reference policy's filename VERBATIM and put ONLY the explicit overrides (if " +
		"any) in phasesPatch. Otherwise set phasesPatch to the fields to change. " +
		"phasesPatch uses the repo's NESTED phase shape (top-level keys hot|warm|cold|frozen|delete), matching the " +
		"existing policy JSON files EXACTLY -- e.g. " +
		'{ "hot": { "priority": 100, "max_age": "7d", "max_primary_shard_size": "10gb", "rollover": true }, ' +
		'"warm": { "min_age": "6h", "priority": 50, "allocate": { "number_of_replicas": 0 }, "forcemerge": ' +
		'{ "max_num_segments": 1 }, "shrink": { "number_of_shards": 1 } }, "cold": { "min_age": "2d", "priority": 25, ' +
		'"allocate": { "number_of_replicas": 0 } }, "frozen": { "min_age": "7d", "searchable_snapshot": ' +
		'{ "snapshot_repository": "found-snapshots", "force_merge_index": true } }, "delete": { "min_age": "60d", ' +
		'"delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } } }. ' +
		"CRITICAL nesting rules (the module rejects the flat forms): use `priority` (a number on the phase), NEVER " +
		"`set_priority`; replicas go in `allocate: { number_of_replicas }`, never a bare number_of_replicas; use " +
		"nested `forcemerge: { max_num_segments }`, `shrink: { number_of_shards }`, `searchable_snapshot: " +
		"{ snapshot_repository, force_merge_index }`, and `wait_for_snapshot: { policy }` -- never the flattened " +
		"underscore forms. Durations are strings like '60d'; retention is delete.min_age. Patch ONLY the fields to " +
		"change for an existing policy; for a copy, prefer sourcePolicy over restating every field. " +
```

- [ ] **Step 2: Add the cluster-extraction rule**

In the same `instruction`, find the opening sentence (starts "Extract the requested Elastic Cloud IaC change as a single strict JSON object with keys:"). Immediately AFTER the keys list and before the first "For a..." block, the instruction already explains fields. Add this sentence right after the "isProd (true only if the user explicitly named a production cluster)" clause (search `isProd (true only if`):

```ts
		"Extract `cluster` ONLY from the deployment the user names in this request; NEVER default to a cluster that " +
		"appears only in these instruction examples. If the user names no cluster, set clarification to ask which " +
		"deployment. " +
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: PASS (string edits only).

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-931: parseIntent ILM nested shape + sourcePolicy + cluster-only rule"
```

---

## Task 6: De-bias example clusters + fix the invented-shape test fixture

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (capabilityMessage + parseIntent examples)
- Modify: `packages/agent/src/iac/ilm-rollout.test.ts` (the `set_priority` fixture)

- [ ] **Step 1: Rotate example cluster names**

In `packages/agent/src/iac/nodes.ts`, vary the cluster in the example strings so `eu-b2b` no longer dominates. Apply these specific swaps (leave the workflow semantics identical):
- `capabilityMessage()` bullets (~lines 231-241): change the ILM example to `us-cld`, the SLO example to `ap-cld`, the alert example to `eu-cld`, the dataview example to `us-cld`, the cluster-defaults example to `ap-cld`, the space example to `eu-cld` (leave tier-resize, security, topology, dashboards on their current cluster). The point is a mix, not a specific assignment — ensure at least 4 distinct clusters appear.
- parseIntent `instruction` examples (~lines 415-468): similarly vary — e.g. tier-resize keep `eu-b2b`, ilm `us-cld`, fleet-integration `eu-cld`, slo `ap-cld`, alerting `eu-cld`, dataview `us-cld`, cluster-default `ap-cld`, space `eu-cld`.

(Exact wording is flexible; the test is `grep -c '"eu-b2b"' nodes.ts` drops substantially and `us-cld`/`ap-cld`/`eu-cld` each appear at least once in the prompt strings.)

- [ ] **Step 2: Verify the spread**

Run: `grep -oE '(eu-b2b|us-cld|ap-cld|eu-cld)' packages/agent/src/iac/nodes.ts | sort | uniq -c`
Expected: all four clusters present; `eu-b2b` no longer the overwhelming majority.

- [ ] **Step 3: Fix the invented-shape test fixture**

In `packages/agent/src/iac/ilm-rollout.test.ts`, find the test using `set_priority` (search `set_priority`). It asserts `mergeIlmPhases` merges a `hot.set_priority` patch. Replace the patch + assertion to use the nested `priority` shape:

```ts
	test("captures undefined previous for a newly added nested leaf", () => {
		const { previous } = mergeIlmPhases(POLICY, { hot: { priority: 50 } });
		expect((previous as { hot: { priority?: unknown } }).hot.priority).toBeUndefined();
	});
```

(If the original test name/body differs, preserve its intent — a leaf absent in POLICY → `previous` undefined — but use `priority`, not `set_priority`. Confirm `POLICY` has no `hot.priority` so the assertion holds.)

- [ ] **Step 4: Run the ILM tests**

Run: `bun test packages/agent/src/iac/ilm-rollout.test.ts packages/agent/src/iac/ilm-validate.test.ts packages/agent/src/iac/ilm-copy.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/ilm-rollout.test.ts
git commit -m "SIO-931: de-bias example clusters; fix invented-shape ILM fixture"
```

---

## Task 7: Copy-aware MR / review summary

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`buildMrDescription` ILM line ~3286 + branchSlug/review summary ~3259)

No new unit test (string composition; covered indirectly). Typecheck + existing tests.

- [ ] **Step 1: Name the clone in the MR description**

In `packages/agent/src/iac/nodes.ts`, in `buildMrDescription`, find the `req?.workflow === "ilm-rollout"` context line (search `ILM policy '${req?.policyName}'`). Change it to mention the source when present:

```ts
				req?.workflow === "ilm-rollout"
					? `ILM policy '${req?.policyName}' ${req?.sourcePolicy ? `EXACT COPY of '${req.sourcePolicy}'` : state.policyCreated ? "CREATE (new lifecycle-policy file for an untracked/unmanaged policy, onboarding it into IaC)" : "phase change"}: ${JSON.stringify(req?.phasesPatch ?? {})}.${state.retentionChange ? ` Retention REDUCED ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}`
					: "",
```

- [ ] **Step 2: Typecheck + full ILM tests**

Run: `bun run --filter @devops-agent/agent typecheck && bun test packages/agent/src/iac/`
Expected: typecheck PASS; all IaC tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-931: MR description names an ILM copy as an exact clone"
```

---

## Task 8: Align playbook ILM examples to the nested shape

**Files:**
- Modify: `agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md`
- Modify: `agents/elastic-iac/knowledge/playbook/10-quick-reference.md`

These knowledge files are loaded into the agent's system prompt and currently show ES-native / invented shapes (`set_priority`, `actions.allocate`). They reinforce the wrong shape.

- [ ] **Step 1: Replace the example JSON blocks**

In both files, find the ILM policy JSON examples (search `set_priority` and `"actions"`). Replace each example body with the repo nested shape (the same block from Task 5 / the spec's ground-truth policy). Keep the surrounding prose; only swap the JSON so it matches `environments/<cluster>/lifecycle-policies/*.json`. Do NOT invent new fields — mirror `us-default-lifecycle-logs-prod.json`.

- [ ] **Step 2: Verify no invented-shape tokens remain in the examples**

Run: `grep -nE "set_priority|searchable_snapshot_repository|forcemerge_max_num_segments|shrink_number_of_shards|wait_for_snapshot_policy" agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md agents/elastic-iac/knowledge/playbook/10-quick-reference.md`
Expected: no matches in the JSON example blocks (prose mentions of the live-ES action names in explanatory text are fine if clearly labelled as the ES API shape; prefer removing them to avoid confusion).

- [ ] **Step 3: Commit**

```bash
git add agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md agents/elastic-iac/knowledge/playbook/10-quick-reference.md
git commit -m "SIO-931: align playbook ILM examples to the nested repo shape"
```

---

## Task 9: Full verification + memory correction + PR

- [ ] **Step 1: Full gate**

Run: `bun run typecheck && bun run lint && bun test packages/agent/src/iac/`
Expected: typecheck all packages exit 0; lint exit 0; all IaC tests PASS. (Repo-wide `bun test` has pre-existing `.svelte` harness failures per `reference_fresh_worktree_no_workspace_symlinks` — scope the test run to `packages/agent/src/iac/` for this ticket, or stash-compare if running the whole suite.)

- [ ] **Step 2: Manual probe (the real acceptance test)**

With the worktree web server + IaC MCP (:9086) up:
```bash
curl -sN localhost:<port>/api/agent/stream -H 'content-type: application/json' -d '{
  "agentName":"elastic-iac","threadId":"sio931-probe",
  "messages":[{"role":"user","content":"On us-cld, replace the logs@lifecycle ILM policy with an exact copy of us-default-lifecycle-logs-prod, keeping delete.min_age at 60d."}]
}' | grep -E 'classified|intent|cluster|sourcePolicy'
```
Expected (web logs): `classified IaC intent ... intent:"gitops"`, parsed cluster `us-cld`, `sourcePolicy` `us-default-lifecycle-logs-prod`; the review card shows a fully nested policy. Approve → MR opens → optionally confirm CI `terraform plan` succeeds (the definitive proof the schema is now correct).

- [ ] **Step 3: Correct the stale memory**

Update `~/.claude/projects/.../memory/reference_elastic_iac_ilm_policy_json_shape.md`: the phases are NESTED objects (hot.priority, warm.allocate.number_of_replicas, warm.forcemerge.max_num_segments, warm.shrink.number_of_shards, cold.allocate.number_of_replicas, frozen.searchable_snapshot.{snapshot_repository,force_merge_index}, delete.wait_for_snapshot.policy), NOT a "flat phase DSL". Cite SIO-931 + the module variables.tf. Add a one-line note that validateIlmPolicy now enforces this pre-commit.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin SIO-931-iac-ilm-schema-copy
```
Open a PR (ready for review, NEVER draft) targeting `main`, body summarizing A/B/C/D, linking SIO-931 + the spec + the CI failure job, and noting the manual probe result. Move SIO-931 to In Review (never Done without user approval).

---

## Self-review notes

- **Spec coverage:** Part A (Task 4 copy/template/canonical base + Task 5 prompt shape), Part B (Task 1 validator + Task 4 pre-commit call), Part C (Task 2 field/extraction + Task 4 copy branch + Task 7 MR summary), Part D (Task 5 cluster rule + Task 6 example rotation). Playbook alignment (Task 8). Memory correction + verification (Task 9). All spec sections mapped.
- **Type consistency:** `validateIlmPolicy(policy: unknown): {ok:true}|{ok:false;reason}`, `CANONICAL_ILM_SHAPE`, `parseRepoTreeFiles`, `sourcePolicy?` — names identical across Tasks 1-7. `proposeIlmChange` exported in Task 4 and used by its test. `patchObj` introduced in Task 4 replaces all `patch` uses in the touched region.
- **Placeholder scan:** every code step shows real code; the two prompt-only tasks (5, 8) give exact search anchors + the full replacement text / shape. No "TBD"/"handle errors" placeholders.
- **Known-gotcha guards:** mock scoping note (Task 4, ref `reference_mock_pollution_own_in_beforeeach`); scope test run to iac dir to avoid the pre-existing `.svelte` harness fails (Task 9, ref `reference_fresh_worktree_no_workspace_symlinks`); the existing `set_priority` fixture will fail after validation lands and is fixed in the same PR (Task 4 Step 5 → Task 6 Step 3).
