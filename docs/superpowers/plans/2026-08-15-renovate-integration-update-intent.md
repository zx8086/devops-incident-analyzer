# Renovate Integration-Update Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `renovate-integration-update` intent to the elastic-iac LangGraph so a user request like "update prometheus on eu-b2b" resolves to a live Dependency Dashboard entry, gets operator approval, triggers SIO-1470's two GitLab tools (tick checkbox + play schedule), and polls for and reports the resulting MR.

**Architecture:** One new LangGraph intent with a 5-node sub-flow (`extractRenovateTarget` → `resolveRenovateMarker` → `renovateTriggerGate` → `triggerRenovateUpdate` → `watchRenovateMr` → shared `teardown`), mirroring the existing `detectFleetUpgrade`/`fleetUpgradeGate`/`applyFleetUpgrade` shape exactly. One new MCP tool (`gitlab_list_merge_requests_by_source_branch`) and one new pure helper (`parseDashboardEntries`) in `mcp-server-elastic-iac`. One cross-datasource tool-lookup addition (`findGitlabProxyTool`) so the elastic-iac graph can call the native `gitlab_get_issue` proxy tool for dashboard discovery, mirroring the existing `getToolsForDataSource("knowledge-graph")` precedent in `infoTools()`.

**Tech Stack:** TypeScript (strict, no `any`), Bun test, Zod, LangGraph (`@langchain/langgraph`), Biome.

**Spec:** `docs/superpowers/specs/2026-08-15-renovate-integration-update-intent-design.md`

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- No emojis in code, logs, comments, or output.
- Zod for all runtime validation, no `.default()` in config schemas.
- File headers: single-line relative path comment only (e.g. `// src/tools/gitlab.ts`).
- Comments: remove JSDoc restating names/obvious returns; keep business-logic "why" comments and ticket references.
- Every new MCP tool in `mcp-server-elastic-iac` MUST be added to `tool-classification.ts`'s `READ_ONLY_TOOLS` or `WRITE_TOOLS` or the module throws at load (fail-fast guard, `tool-classification.ts:91-98`).
- Run `bun run typecheck`, `bun run lint`, and relevant `bun test` after every task.
- TDD: write the failing test first for every pure function; LLM-invoking nodes are covered only via their pure helper functions, per this codebase's established convention (`classify.test.ts` tests `intentFromText`/`resolvePipelinePollBudgetMs`, never mocks `createLlm`).
- No changes to `DATASOURCE_TO_MCP_SERVER` (`packages/agent/src/mcp-bridge.ts:434-445`) — cross-datasource access goes through a second `getToolsForDataSource(...)` call, not a mapping edit.
- No changes to the existing `fleet-integration` gitops workflow (`proposeFleetIntegration`, `nodes.ts:4037-4150`) — out of scope per the spec.

---

## Task 1: `parseDashboardEntries` pure helper in `mcp-server-elastic-iac`

**Files:**
- Modify: `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`
- Test: `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts`

**Interfaces:**
- Produces: `export function parseDashboardEntries(description: string): Array<{ marker: string; line: string }>` — used by Task 6 (`resolveRenovateMarker`).
- Produces: shared regex constant (name it `DASHBOARD_CHECKBOX_LINE_RE`) factored out of `tickDashboardCheckboxes`, reused by both functions.

The current `tickDashboardCheckboxes` (`gitlab.ts:87-98`) has its marker-extraction regex inlined:
```ts
const match = line.match(/^(\s*-\s*\[) \](\s*<!--\s*unschedule-branch=(.*?)\s*-->)/);
```
Factor this into a shared module-level constant so `parseDashboardEntries` reuses the exact same extraction logic rather than a second hand-copied regex that could drift.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts`, after the existing `tickDashboardCheckboxes` describe block:

```ts
import { parseDashboardEntries } from "./gitlab.ts";

describe("parseDashboardEntries", () => {
	test("extracts marker+line pairs for every checkbox line", () => {
		const body =
			"## Awaiting Schedule\n\n" +
			" - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4\n" +
			" - [ ] <!-- unschedule-branch=renovate/ap-cld-cisco_ftd -->chore(deps): [ap-cld] cisco_ftd to v3.13.10\n";

		expect(parseDashboardEntries(body)).toEqual([
			{
				marker: "renovate/eu-b2b-prometheus",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
			},
			{
				marker: "renovate/ap-cld-cisco_ftd",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-cisco_ftd -->chore(deps): [ap-cld] cisco_ftd to v3.13.10",
			},
		]);
	});

	test("also extracts an already-ticked line (marker extraction is independent of checkbox state)", () => {
		const body = " - [x] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): prometheus\n";
		expect(parseDashboardEntries(body)).toEqual([
			{ marker: "renovate/eu-b2b-prometheus", line: " - [x] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): prometheus" },
		]);
	});

	test("empty array when the body has no marker lines", () => {
		expect(parseDashboardEntries("## Awaiting Schedule\n\nNothing pending.\n")).toEqual([]);
		expect(parseDashboardEntries("")).toEqual([]);
	});

	test("skips lines with no unschedule-branch marker (e.g. the bulk-trigger line)", () => {
		const body =
			" - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): prometheus\n" +
			" - [ ] <!-- create-all-awaiting-schedule-prs -->Create all awaiting schedule MRs at once\n";
		expect(parseDashboardEntries(body)).toEqual([
			{ marker: "renovate/eu-b2b-prometheus", line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): prometheus" },
		]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/mcp-server-elastic-iac && bun test src/tools/gitlab.test.ts`
Expected: FAIL with `SyntaxError: Export named 'parseDashboardEntries' not found in module`.

- [ ] **Step 3: Factor out the shared regex constant and implement `parseDashboardEntries`**

In `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`, replace the `tickDashboardCheckboxes` function (`gitlab.ts:81-98`) with:

```ts
// Shared by tickDashboardCheckboxes and parseDashboardEntries: matches a Dependency
// Dashboard checkbox line and captures [1]="- [ or - [x] prefix-with-bracket-open",
// [2]=full HTML comment span, [3]=the marker itself.
const DASHBOARD_CHECKBOX_LINE_RE = /^(\s*-\s*\[)[ x](\s*<!--\s*unschedule-branch=(.*?)\s*-->)/;

// Renovate on-demand MR automation: flip "- [ ]" to "- [x]" on Dependency Dashboard
// lines whose unschedule-branch=<marker> HTML comment exactly matches one of the
// requested markers. The board is fully regenerated every Renovate run, so matching
// must key on the stable marker, never on line position. Idempotent (an already-ticked
// line is left as-is) and a non-matching marker leaves the body unchanged.
// (Pure; unit-tested.)
export function tickDashboardCheckboxes(description: string, markers: string[]): string {
	const markerSet = new Set(markers);
	return description
		.split("\n")
		.map((line) => {
			const match = line.match(/^(\s*-\s*\[) \](\s*<!--\s*unschedule-branch=(.*?)\s*-->)/);
			const marker = match?.[3];
			if (!match || marker === undefined || !markerSet.has(marker)) return line;
			return line.replace(`${match[1]} ]`, `${match[1]}x]`);
		})
		.join("\n");
}

// Parses the Dependency Dashboard issue body into {marker, line} pairs, one per
// checkbox line carrying an unschedule-branch=<marker> HTML comment (checked or
// unchecked -- marker extraction is independent of checkbox state). Used to resolve a
// free-text deployment+integration name to the live marker string before calling
// gitlab_unschedule_renovate_branches -- never construct/guess a marker, always match
// against what the board actually contains this run. Lines with no marker comment
// (e.g. the create-all-awaiting-schedule-prs bulk-trigger line) are skipped.
// (Pure; unit-tested.)
export function parseDashboardEntries(description: string): Array<{ marker: string; line: string }> {
	const entries: Array<{ marker: string; line: string }> = [];
	for (const line of description.split("\n")) {
		const match = line.match(DASHBOARD_CHECKBOX_LINE_RE);
		const marker = match?.[3];
		if (marker !== undefined) entries.push({ marker, line });
	}
	return entries;
}
```

Note: `tickDashboardCheckboxes` keeps its own inline regex (matching only unchecked `- [ ]` lines, since it's the flip operation) rather than reusing `DASHBOARD_CHECKBOX_LINE_RE` (which matches both checked/unchecked for parsing) — do not "simplify" `tickDashboardCheckboxes` to use the shared constant, its semantics differ (it must NOT match an already-`[x]` line the way its own tests assert).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mcp-server-elastic-iac && bun test src/tools/gitlab.test.ts`
Expected: PASS, all tests including the pre-existing `tickDashboardCheckboxes` suite (regression check — its behavior must be unchanged).

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/mcp-server-elastic-iac && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/mcp-server-elastic-iac/src/tools/gitlab.ts packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-elastic-iac/src/tools/gitlab.ts packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts
git commit -m "SIO-XXXX: add parseDashboardEntries pure helper for Renovate marker resolution"
```

---

## Task 2: `gitlab_list_merge_requests_by_source_branch` MCP tool

**Files:**
- Modify: `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`
- Modify: `packages/mcp-server-elastic-iac/src/tools/tool-classification.ts`
- Modify: `packages/mcp-server-elastic-iac/src/__tests__/tools-list-snapshot.json` (regenerated, not hand-edited)

**Interfaces:**
- Produces: MCP tool `gitlab_list_merge_requests_by_source_branch(sourceBranch: string)` — called from Task 8 (`watchRenovateMr`) via the existing `callTool` helper in `nodes.ts`.

This tool has no pure-helper logic to TDD (it's a thin `gitlabFetch` passthrough, same as `gitlab_get_pipeline`/`gitlab_get_merge_request`, neither of which has a dedicated unit test) — write it directly, then verify via the classification fail-fast guard and the regenerated snapshot.

- [ ] **Step 1: Add the tool registration**

In `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`, insert immediately after `gitlab_list_agent_merge_requests` (the closing `);` at what is currently line 1633, right before the closing `}` of `registerGitlabTools`):

```ts
	// Renovate on-demand MR automation: gitlab_list_agent_merge_requests is hardcoded to
	// labels=agent-generated (gitlab_create_merge_request's own default label set) -- a
	// Renovate-authored MR never carries that label, so watchRenovateMr needs its own
	// lookup by exact source branch. Read-only.
	server.registerTool(
		"gitlab_list_merge_requests_by_source_branch",
		{
			description:
				"List merge requests by exact source branch name, any state, newest first. Used to detect a " +
				"Renovate-created MR after gitlab_play_pipeline_schedule triggers a run (Renovate MRs are not " +
				"labeled agent-generated, so gitlab_list_agent_merge_requests cannot find them). Read-only.",
			inputSchema: {
				sourceBranch: z.string().describe("Exact source branch name, e.g. 'renovate/eu-b2b-prometheus'."),
			},
			annotations: iacToolAnnotations("gitlab_list_merge_requests_by_source_branch"),
		},
		async ({ sourceBranch }) =>
			text(
				await gitlabFetch(
					gitlabBaseUrl,
					token,
					`/projects/${project}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&order_by=created_at&sort=desc&per_page=5`,
				),
			),
	);
```

- [ ] **Step 2: Classify the tool**

In `packages/mcp-server-elastic-iac/src/tools/tool-classification.ts`, add `"gitlab_list_merge_requests_by_source_branch"` to the `READ_ONLY_TOOLS` set (`tool-classification.ts:12-51`), next to `"gitlab_list_agent_merge_requests"`.

- [ ] **Step 3: Verify the fail-fast guard passes and the snapshot test fails as expected**

Run: `cd packages/mcp-server-elastic-iac && bun test`
Expected: the new tool's registration succeeds (no `SIO-1417` unclassified-tool throw); `tools-list-snapshot.test.ts` FAILS with a diff showing the new tool name in `Received` but not `Expected` — this is the expected/correct failure, confirming the tool is live and its surface changed.

- [ ] **Step 4: Regenerate the snapshot**

Run: `cd packages/mcp-server-elastic-iac && REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot`
Then verify the diff is additive-only:
```bash
git diff --stat src/__tests__/tools-list-snapshot.json
```
Expected: only new lines added (the new tool's entry), no existing tool's hash changed.

- [ ] **Step 5: Run the full package test suite**

Run: `cd packages/mcp-server-elastic-iac && bun test`
Expected: all tests pass, including the now-regenerated snapshot test.

- [ ] **Step 6: Typecheck and lint**

Run: `cd packages/mcp-server-elastic-iac && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/mcp-server-elastic-iac/src/tools/gitlab.ts packages/mcp-server-elastic-iac/src/tools/tool-classification.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-elastic-iac/src/tools/gitlab.ts packages/mcp-server-elastic-iac/src/tools/tool-classification.ts packages/mcp-server-elastic-iac/src/__tests__/tools-list-snapshot.json
git commit -m "SIO-XXXX: add gitlab_list_merge_requests_by_source_branch tool"
```

---

## Task 3: New `renovate-integration-update` intent value

**Files:**
- Modify: `packages/agent/src/iac/state.ts`

**Interfaces:**
- Produces: `IacIntent` now includes `"renovate-integration-update"` — consumed by Task 4 (classifier), Task 9 (graph routing).
- Produces: new state fields on `IacState` for the sub-flow, mirroring the `fleetUpgrade*` fields (`state.ts:764-770`):
  - `renovateTarget: Annotation<{ deployment: string; integration: string } | null>`
  - `renovateMarker: Annotation<{ marker: string; line: string } | null>`
  - `renovateCandidates: Annotation<Array<{ marker: string; line: string }>>` (the 2+-match disambiguation list)
  - `renovateTriggerApproved: Annotation<boolean | null>`
  - `renovateIssueIid: Annotation<number | null>`
  - `renovateMrUrl: Annotation<string>`

- [ ] **Step 1: Add the intent value**

In `packages/agent/src/iac/state.ts`, modify `INTENT_VALUES` (currently `state.ts:44-53`):

```ts
export const INTENT_VALUES = [
	"info",
	"gitops",
	"gitops-amend",
	"pipeline-status",
	"drift",
	"synthetics-drift",
	"fleet-upgrade",
	"renovate-integration-update",
	"converse",
] as const;
```

- [ ] **Step 2: Add the sub-flow state fields**

In `packages/agent/src/iac/state.ts`, immediately after the `fleetApplyPipelineId` field (the last line of the fleet-upgrade block, currently `state.ts:774`), add:

```ts
	// Renovate on-demand MR automation sub-flow. renovateTarget holds the extracted
	// {deployment, integration} pair; renovateCandidates holds every dashboard entry
	// matched by resolveRenovateMarker (0, 1, or 2+ -- exactly 1 proceeds to the gate,
	// else the turn ends with a disambiguation/no-match message); renovateMarker is the
	// single resolved match once disambiguation succeeds; renovateTriggerApproved is the
	// operator's gate decision; renovateIssueIid is the discovered Dependency Dashboard
	// issue iid (read once per turn, not persisted cross-turn -- the issue is
	// rediscovered by title every turn per the original handover's stability warning);
	// renovateMrUrl is the resulting Renovate MR link once watchRenovateMr finds it.
	renovateTarget: Annotation<{ deployment: string; integration: string } | null>({
		reducer: last,
		default: () => null,
	}),
	renovateCandidates: Annotation<Array<{ marker: string; line: string }>>({ reducer: last, default: () => [] }),
	renovateMarker: Annotation<{ marker: string; line: string } | null>({ reducer: last, default: () => null }),
	renovateTriggerApproved: Annotation<boolean | null>({ reducer: last, default: () => null }),
	renovateIssueIid: Annotation<number | null>({ reducer: last, default: () => null }),
	renovateMrUrl: Annotation<string>({ reducer: last, default: () => "" }),
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/agent && bun run typecheck`
Expected: errors in `nodes.ts`/`graph.ts` are expected at this point (they don't reference the new fields yet, so this step should actually PASS cleanly — `state.ts` alone compiles). If it fails, the failure must be confined to `state.ts` itself (e.g. a typo), not downstream files.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/iac/state.ts
git commit -m "SIO-XXXX: add renovate-integration-update intent and sub-flow state fields"
```

---

## Task 4: Classifier prompt bucket for `renovate-integration-update`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts`
- Test: `packages/agent/src/iac/classify.test.ts`

**Interfaces:**
- Consumes: `IacIntent` from Task 3 (already includes `"renovate-integration-update"`).
- Produces: `classifyIacIntent`'s LLM prompt now includes the new bucket; the reply-parsing helper `intentFromText` (`nodes.ts`, tested in `classify.test.ts`) must recognize the literal string `"renovate-integration-update"` as a valid intent.

First check whether `intentFromText` needs a code change or already generically maps any string matching an `IacIntent` value — read it before assuming.

- [ ] **Step 1: Read `intentFromText`'s current implementation**

```bash
grep -n "^export function intentFromText" -A 20 packages/agent/src/iac/nodes.ts
```

If it does simple substring/keyword matching per intent (like the `synthetics-drift`-vs-`drift` tiebreak the existing test suite shows), it needs an explicit new branch. If it does a generic `INTENT_VALUES.includes(...)` check, no change is needed there — only the prompt text changes. Write the failing test first regardless (Step 2), since either way the exact behavior needs a test.

- [ ] **Step 2: Write the failing test**

Add to `packages/agent/src/iac/classify.test.ts`, in the `describe("intentFromText", ...)` block:

```ts
test("maps renovate-integration-update replies", () => {
	expect(intentFromText("renovate-integration-update")).toBe("renovate-integration-update");
});
```

- [ ] **Step 3: Run test to verify it fails (or passes for the wrong reason)**

Run: `cd packages/agent && bun test src/iac/classify.test.ts`
If `intentFromText` already generically handles any `INTENT_VALUES` member, this may PASS immediately — in that case, skip to Step 5 (no code change needed for `intentFromText` itself), but still complete Step 6 (the prompt text) since the LLM never emits this string without prompt guidance.
If it FAILS (falls through to a default like `"info"`), proceed to Step 4.

- [ ] **Step 4: Add the `intentFromText` branch if needed**

Only if Step 3 failed: add a branch for `"renovate-integration-update"` following the exact pattern of the existing intent branches in `intentFromText` (read the surrounding branches first to match the exact conditional style — likely an `includes()` check against the lowercased reply text).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/classify.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the classifier prompt bucket**

In `packages/agent/src/iac/nodes.ts`, modify `classifyIacIntent`'s `sys` prompt string (currently `nodes.ts:798-829`). Insert a new bucket immediately after the existing `'fleet-upgrade'` bucket (ends `"...set workflow to 'fleet-upgrade', cluster to the named deployment, and version to the target agent version string. " +` at what is currently `nodes.ts:809`) and before the `'drift'` bucket:

```ts
		"- 'renovate-integration-update': a request to update a Fleet INTEGRATION PACKAGE (e.g. prometheus, " +
		"cisco_ftd, system, a specific Elastic Agent integration) to its latest available version on a deployment -- " +
		"'update prometheus on eu-b2b', 'bump the cisco_ftd integration for ap-cld', 'get the latest system integration " +
		"on us-cld', 'update the fleet-server integration'. This is the DEFAULT classification for ANY integration-" +
		"package update request, whether or not the user names a target version -- Fleet integrations only ever " +
		"install the latest registry version, so naming an explicit version does not change the classification. This " +
		"is NOT a deployment/cluster version change (that's 'gitops') and NOT a Fleet AGENT BINARY upgrade (that's " +
		"'fleet-upgrade'). The tell: the thing being updated is a named integration/package the deployment ingests " +
		"data through, not the cluster itself or the enrolled agents.\n" +
```

And update the final one-word enumeration line (currently `nodes.ts:828`):

```ts
		"Reply with ONLY one word: 'info', 'gitops', 'fleet-upgrade', 'renovate-integration-update', 'drift', " +
		"'synthetics-drift', 'pipeline-status', or 'converse'. " +
```

- [ ] **Step 7: Run the full classify test suite**

Run: `cd packages/agent && bun test src/iac/classify.test.ts`
Expected: PASS, no regressions to the existing intent-mapping tests.

- [ ] **Step 8: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/nodes.ts packages/agent/src/iac/classify.test.ts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/classify.test.ts
git commit -m "SIO-XXXX: add renovate-integration-update classifier bucket"
```

---

## Task 5: `findGitlabProxyTool` cross-datasource lookup + `extractRenovateTarget` node

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts`
- Test: create `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `getToolsForDataSource` from `../mcp-bridge.ts` (already imported in `nodes.ts:22`).
- Produces: `function findGitlabProxyTool(name: string): StructuredToolInterface | undefined` — consumed by Task 6 (`resolveRenovateMarker`).
- Produces: `export async function extractRenovateTarget(state: IacStateType): Promise<Partial<IacStateType>>` — a new graph node, consumed by Task 9 (graph wiring).
- Produces: `export function parseRenovateTargetJson(raw: string): { deployment: string; integration: string } | null` — the pure JSON-parsing half of `extractRenovateTarget`, split out for TDD per this codebase's `parseIntentJson`/`parseIntent` precedent (`nodes.ts:333`).

This task creates the new test file `renovate-integration.test.ts` that Tasks 6-8 will also add to.

- [ ] **Step 1: Write the failing test for `parseRenovateTargetJson`**

Create `packages/agent/src/iac/renovate-integration.test.ts`:

```ts
// agent/src/iac/renovate-integration.test.ts
import { describe, expect, test } from "bun:test";
import { parseRenovateTargetJson } from "./nodes.ts";

// Renovate on-demand MR automation: extractRenovateTarget's LLM call returns a JSON
// object with deployment+integration; parseRenovateTargetJson validates and normalizes
// it, returning null on malformed/incomplete output so the node can clarify instead of
// silently guessing.
describe("parseRenovateTargetJson", () => {
	test("parses a well-formed extraction", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":"prometheus"}')).toEqual({
			deployment: "eu-b2b",
			integration: "prometheus",
		});
	});

	test("null when deployment is missing", () => {
		expect(parseRenovateTargetJson('{"integration":"prometheus"}')).toBeNull();
	});

	test("null when integration is missing", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b"}')).toBeNull();
	});

	test("null when either field is an empty string", () => {
		expect(parseRenovateTargetJson('{"deployment":"","integration":"prometheus"}')).toBeNull();
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":""}')).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseRenovateTargetJson("not json")).toBeNull();
	});

	test("tolerates surrounding prose (extracts the JSON block)", () => {
		expect(
			parseRenovateTargetJson('Here is the extraction: {"deployment":"ap-cld","integration":"cisco_ftd"} done.'),
		).toEqual({ deployment: "ap-cld", integration: "cisco_ftd" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: FAIL with `SyntaxError: Export named 'parseRenovateTargetJson' not found`.

- [ ] **Step 3: Implement `findGitlabProxyTool`, `parseRenovateTargetJson`, and `extractRenovateTarget`**

In `packages/agent/src/iac/nodes.ts`, add immediately after `findTool`/`callTool` (currently `nodes.ts:158-173`):

```ts
// Renovate on-demand MR automation: the native GitLab MCP's get_issue tool is not in
// mcp-server-elastic-iac's own tool set (that server has no issue-read tool) -- it
// belongs to the separately-routed "gitlab" data source (gitlab-mcp), reached today only
// by the main incident-analyzer graph. Cross-datasource read, following the exact
// precedent infoTools() already establishes with getToolsForDataSource("knowledge-graph")
// (nodes.ts:1313): no DATASOURCE_TO_MCP_SERVER change, no new connection (gitlab-mcp and
// elastic-iac-mcp are already independently connected in apps/web's runtime).
function findGitlabProxyTool(name: string): StructuredToolInterface | undefined {
	return getToolsForDataSource("gitlab").find((t) => t.name === name);
}

async function callGitlabProxyTool(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = findGitlabProxyTool(name);
	if (!tool) return `[${name} unavailable - gitlab server not connected]`;
	try {
		const res = await tool.invoke(args);
		return typeof res === "string" ? res : JSON.stringify(res);
	} catch (err) {
		return `[${name} error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

const RenovateTargetSchema = z.object({
	deployment: z.string().nullish(),
	integration: z.string().nullish(),
});

// Extract the LLM's JSON reply into {deployment, integration}, or null when either field
// is missing/empty (the node clarifies rather than guessing). Mirrors parseIntentJson's
// extract+validate split (nodes.ts:333). (Pure; unit-tested.)
export function parseRenovateTargetJson(raw: string): { deployment: string; integration: string } | null {
	const extracted = extractJsonBlock(raw);
	if (!extracted) return null;
	try {
		const parsed = RenovateTargetSchema.safeParse(JSON.parse(sanitizeJsonControlChars(extracted)));
		if (!parsed.success) return null;
		const { deployment, integration } = parsed.data;
		if (!deployment || !integration) return null;
		return { deployment, integration };
	} catch {
		return null;
	}
}

// Extract {deployment, integration} from the request via a small structured-output LLM
// call, matching the parseIntent/IntentSchema pattern (a JSON-instruction prompt +
// zod-validated parse) rather than classifyIacIntent's bare one-word call, since this
// extracts two named fields. On extraction failure, ends the turn with a clarifying
// message instead of proceeding with a guessed/partial target.
export async function extractRenovateTarget(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const llm = createLlm("iacPlanner", AGENT);
	const sys =
		"Extract the requested Fleet integration update as a single strict JSON object with keys: " +
		"deployment (the named deployment/cluster, e.g. 'eu-b2b') and integration (the named integration " +
		"package alias, e.g. 'prometheus', 'cisco_ftd', 'system'). If either is not named in the request, " +
		"set that key to null.";
	const res = await llm.invoke([new SystemMessage(sys), new HumanMessage(query)]);
	const target = parseRenovateTargetJson(extractTextFromContent(res.content));
	if (!target) {
		return {
			blockedReason: "Could not identify the deployment and/or integration to update.",
			messages: [
				new AIMessage(
					"I couldn't tell which deployment and integration to update. Name both, e.g. 'update prometheus on eu-b2b'.",
				),
			],
		};
	}
	return { renovateTarget: target };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts`
Expected: no errors. `z`, `HumanMessage`, `SystemMessage`, `AIMessage`, `createLlm`, `extractJsonBlock`, `sanitizeJsonControlChars`, `extractTextFromContent`, `getToolsForDataSource`, `StructuredToolInterface` are all already imported in `nodes.ts` (verified: lines 12-33) — no new imports needed.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add extractRenovateTarget node and findGitlabProxyTool cross-datasource lookup"
```

---

## Task 6: `resolveRenovateMarker` node + `hasSingleRenovateMatch` predicate

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts`
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `state.renovateTarget` from Task 5; the native `gitlab_search`/`gitlab_get_issue` proxy tools via `findGitlabProxyTool`/`callGitlabProxyTool` from Task 5. Does NOT import Task 1's `parseDashboardEntries` (that lives in `mcp-server-elastic-iac`, a separate package `nodes.ts` cannot import from) — see the "Important correction" note below for why this task defines its own local equivalent instead.
- Produces: `export async function resolveRenovateMarker(state: IacStateType): Promise<Partial<IacStateType>>` — consumed by Task 9 (graph wiring).
- Produces: `export function filterDashboardMatches(entries: Array<{marker: string; line: string}>, deployment: string, integration: string): Array<{marker: string; line: string}>` — pure matching logic, unit-tested.
- Produces: `export function hasSingleRenovateMatch(candidates: Array<{marker: string; line: string}>): boolean` — conditional-edge predicate for Task 9, mirroring `hasApplicableFleetUpgrade`'s role (`nodes.ts:11215`).
- Produces: `function renovateProjectId(): string` — the GitLab project id/path supplied to the native proxy tool calls (they resolve project client-side, unlike `mcp-server-elastic-iac`'s own tools which resolve it server-side).
- Produces: `parseFirstIssueIid(raw: string): number | null` and `parseIssueDescription(raw: string): string` — pure response parsers for the native proxy tools' JSON shapes.

**Important correction from the spec:** `parseDashboardEntries` (Task 1) lives in `packages/mcp-server-elastic-iac`, a separate package from `packages/agent` where this node lives. `nodes.ts` cannot import it directly — it only ever consumes MCP tools' string output via `callTool`/`callGitlabProxyTool`, never imports server-side code. So `resolveRenovateMarker` needs its own copy of the parsing logic, OR (better) the matching/filtering logic operates on the raw description text via a locally-defined equivalent. Re-implementing `parseDashboardEntries`'s regex a second time in `nodes.ts` would violate DRY across packages with no shared module between them today.

Resolve this by keeping `parseDashboardEntries`'s marker-extraction regex logic in `nodes.ts` too (a second small pure function, `parseRenovateDashboardEntries`, same regex, same shape) — this mirrors how the codebase already accepts some cross-package duplication at MCP boundaries (the agent package parses tool-response JSON shapes that mirror, but don't import, the MCP server's internal types, e.g. `parseNewestPipeline`/`parseLatestAgentMr` in `nodes.ts` parse GitLab API JSON shapes independently of `mcp-server-elastic-iac`'s own internal helpers). Do NOT attempt a shared package for one regex — that's disproportionate infrastructure for a 3-line pattern.

- [ ] **Step 1: Write the failing tests**

Add to `packages/agent/src/iac/renovate-integration.test.ts`:

```ts
import { filterDashboardMatches, hasSingleRenovateMatch, parseRenovateDashboardEntries } from "./nodes.ts";

describe("parseRenovateDashboardEntries", () => {
	test("extracts marker+line pairs", () => {
		const body =
			" - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4\n";
		expect(parseRenovateDashboardEntries(body)).toEqual([
			{
				marker: "renovate/eu-b2b-prometheus",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
			},
		]);
	});

	test("empty array on a body with no marker lines", () => {
		expect(parseRenovateDashboardEntries("nothing here")).toEqual([]);
	});
});

describe("filterDashboardMatches", () => {
	const entries = [
		{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		{ marker: "renovate/ap-cld-prometheus", line: "chore(deps): [ap-cld] prometheus to v1.24.4" },
		{ marker: "renovate/eu-b2b-cisco_ftd", line: "chore(deps): [eu-b2b] cisco_ftd to v3.13.10" },
	];

	test("returns the single entry matching both deployment and integration (case-insensitive)", () => {
		expect(filterDashboardMatches(entries, "eu-b2b", "PROMETHEUS")).toEqual([
			{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		]);
	});

	test("returns multiple entries when the integration alone matches across deployments", () => {
		expect(filterDashboardMatches(entries, "", "prometheus")).toHaveLength(2);
	});

	test("empty array when nothing matches", () => {
		expect(filterDashboardMatches(entries, "us-cld", "netskope")).toEqual([]);
	});
});

describe("hasSingleRenovateMatch (graph-edge predicate)", () => {
	test("true for exactly one candidate", () => {
		expect(hasSingleRenovateMatch([{ marker: "renovate/eu-b2b-prometheus", line: "x" }])).toBe(true);
	});
	test("false for zero candidates", () => {
		expect(hasSingleRenovateMatch([])).toBe(false);
	});
	test("false for 2+ candidates (ambiguous)", () => {
		expect(
			hasSingleRenovateMatch([
				{ marker: "renovate/eu-b2b-prometheus", line: "x" },
				{ marker: "renovate/ap-cld-prometheus", line: "y" },
			]),
		).toBe(false);
	});
});

import { parseFirstIssueIid, parseIssueDescription } from "./nodes.ts";

// gitlab_search (scope: work_items) response shape: an array of GitLab search-result
// objects. Only the numeric `iid` field is needed here.
describe("parseFirstIssueIid", () => {
	test("returns the iid of the first result", () => {
		const raw = JSON.stringify([{ iid: 11, title: "Elastic Fleet & Agent Dependency Dashboard" }]);
		expect(parseFirstIssueIid(raw)).toBe(11);
	});

	test("null on an empty array (no dashboard issue found)", () => {
		expect(parseFirstIssueIid("[]")).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseFirstIssueIid("not json")).toBeNull();
	});

	test("null when the first result has no numeric iid", () => {
		expect(parseFirstIssueIid(JSON.stringify([{ title: "no iid here" }]))).toBeNull();
	});
});

// gitlab_get_issue response shape: a single issue object with a `description` field.
describe("parseIssueDescription", () => {
	test("returns the description field", () => {
		const raw = JSON.stringify({ iid: 11, description: "## Awaiting Schedule\n\n - [ ] ..." });
		expect(parseIssueDescription(raw)).toBe("## Awaiting Schedule\n\n - [ ] ...");
	});

	test("empty string when description is missing", () => {
		expect(parseIssueDescription(JSON.stringify({ iid: 11 }))).toBe("");
	});

	test("empty string on malformed JSON", () => {
		expect(parseIssueDescription("not json")).toBe("");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: FAIL with `SyntaxError: Export named 'filterDashboardMatches' not found` (and similarly for the other new exports: `hasSingleRenovateMatch`, `parseRenovateDashboardEntries`, `parseFirstIssueIid`, `parseIssueDescription`).

- [ ] **Step 3: Implement the pure functions and the node**

In `packages/agent/src/iac/nodes.ts`, add after `extractRenovateTarget` (from Task 5):

```ts
// Mirrors mcp-server-elastic-iac's parseDashboardEntries (gitlab.ts) -- duplicated rather
// than shared across the package boundary (nodes.ts never imports MCP-server-side code;
// it only consumes tool string output). Same regex, same shape.
const RENOVATE_DASHBOARD_LINE_RE = /^(\s*-\s*\[)[ x](\s*<!--\s*unschedule-branch=(.*?)\s*-->)/;

export function parseRenovateDashboardEntries(description: string): Array<{ marker: string; line: string }> {
	const entries: Array<{ marker: string; line: string }> = [];
	for (const line of description.split("\n")) {
		const match = line.match(RENOVATE_DASHBOARD_LINE_RE);
		const marker = match?.[3];
		if (marker !== undefined) entries.push({ marker, line });
	}
	return entries;
}

// Deterministic substring match (never LLM-assisted -- exactness matters more than
// phrasing flexibility here) against the live marker strings. Case-insensitive,
// matching findPipelineScheduleId's precedent (mcp-server-elastic-iac/gitlab.ts).
// (Pure; unit-tested.)
export function filterDashboardMatches(
	entries: Array<{ marker: string; line: string }>,
	deployment: string,
	integration: string,
): Array<{ marker: string; line: string }> {
	const dep = deployment.toLowerCase();
	const pkg = integration.toLowerCase();
	return entries.filter((e) => {
		const m = e.marker.toLowerCase();
		return (dep === "" || m.includes(dep)) && (pkg === "" || m.includes(pkg));
	});
}

// Graph-edge predicate: exactly one match proceeds to the approval gate; 0 or 2+ ends
// the turn with a disambiguation/no-match message. (Pure; unit-tested.)
export function hasSingleRenovateMatch(candidates: Array<{ marker: string; line: string }>): boolean {
	return candidates.length === 1;
}

// gitlab_search (scope: work_items) response: an array of result objects. Defensive
// parse -- malformed/empty input returns null rather than throwing, matching
// parseNewestPipeline/parseLatestAgentMr's style elsewhere in this file. (Pure; unit-tested.)
export function parseFirstIssueIid(raw: string): number | null {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const first = parsed[0] as { iid?: unknown };
		return typeof first.iid === "number" ? first.iid : null;
	} catch {
		return null;
	}
}

// gitlab_get_issue response: a single issue object with a `description` field.
// (Pure; unit-tested.)
export function parseIssueDescription(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { description?: unknown };
		return typeof parsed.description === "string" ? parsed.description : "";
	} catch {
		return "";
	}
}

// The Renovate IaC target repo (observability-elastic-iac). Fixed per the original
// Renovate handover's scope ("use the project we currently use" -- confirmed during
// brainstorming): mcp-server-elastic-iac's own config already targets exactly this repo
// via ELASTIC_IAC_GITLAB_PROJECT/_PROJECT_ID (mcp-server-elastic-iac/src/config.ts:126,131),
// but that config is server-side and not reachable from packages/agent. The native
// gitlab_get_issue/gitlab_search proxy tools need a project id/path supplied by the
// CALLER (verified live: gitlab_get_issue's schema requires both `id` and `issue_iid`),
// so this small mirror read is unavoidable -- read directly via process.env inside the
// function body (nodes.ts has no existing helper for a non-numeric env value; this
// follows the same "read inside the node, not module scope" discipline every
// readPositiveMsEnv call in this file already follows).
function renovateProjectId(): string {
	return process.env.ELASTIC_IAC_GITLAB_PROJECT_ID ?? "82850717";
}

// Discovers the Dependency Dashboard issue by title (never hardcoded -- its iid has
// already changed once when the title changed, per the original handover), fetches its
// description via the native gitlab_get_issue proxy tool, and resolves the extracted
// {deployment, integration} target to a live marker. Exactly one match -> renovateMarker
// set, proceeds to the approval gate. 0 or 2+ matches -> renovateCandidates set (possibly
// empty), the turn ends with a disambiguation/no-match message (routed by
// hasSingleRenovateMatch in graph.ts).
export async function resolveRenovateMarker(state: IacStateType): Promise<Partial<IacStateType>> {
	const target = state.renovateTarget;
	if (!target) return { renovateCandidates: [] };

	const projectId = renovateProjectId();
	// gitlab_search's project_id accepts a numeric id or URL-encoded path (verified live
	// against the native tool's schema); scope "work_items" covers issues.
	const searchRes = await callGitlabProxyTool("gitlab_search", {
		scope: "work_items",
		search: "Dependency Dashboard",
		project_id: projectId,
	});
	const issueIid = parseFirstIssueIid(searchRes);
	if (issueIid === null) {
		return {
			renovateCandidates: [],
			messages: [new AIMessage("I couldn't find the Dependency Dashboard issue to check for pending updates.")],
		};
	}

	// gitlab_get_issue requires BOTH `id` (project) and `issue_iid` (verified live against
	// the native tool's schema -- issue_iid alone is not sufficient, a common mistake when
	// assuming the elastic-iac-mcp tool shapes, which resolve project server-side).
	const issueRes = await callGitlabProxyTool("gitlab_get_issue", { id: projectId, issue_iid: issueIid });
	const description = parseIssueDescription(issueRes);
	const entries = parseRenovateDashboardEntries(description);
	const candidates = filterDashboardMatches(entries, target.deployment, target.integration);

	if (candidates.length === 1) {
		return { renovateIssueIid: issueIid, renovateMarker: candidates[0], renovateCandidates: candidates };
	}
	if (candidates.length === 0) {
		return {
			renovateCandidates: [],
			messages: [
				new AIMessage(
					`No pending Renovate update found for '${target.integration}' on '${target.deployment}'. It may already be up to date, or the name may not match — check the Dependency Dashboard.`,
				),
			],
		};
	}
	return {
		renovateCandidates: candidates,
		messages: [
			new AIMessage(
				`Multiple pending updates match '${target.integration}' on '${target.deployment}': ${candidates.map((c) => c.marker).join(", ")}. Be more specific.`,
			),
		],
	};
}
```

`parseFirstIssueIid` and `parseIssueDescription` are two small new pure helpers needed to parse the native proxy tools' JSON response shapes — write these too, following the exact defensive-parse style of `parseNewestPipeline`/`parseLatestAgentMr` elsewhere in `nodes.ts` (read one of those first for the exact style: JSON.parse in a try/catch, type-guard each field, return null on any mismatch rather than throwing). Add their own unit tests to `renovate-integration.test.ts` covering: well-formed response, empty/no-results response, malformed JSON.

Both proxy-tool call shapes below are verified against the live `mcp-server-gitlab` tool schemas (fetched this session, not guessed): `gitlab_search` requires `scope`+`search` (`project_id` optional but supplied here to scope the search); `gitlab_get_issue` requires BOTH `id` (project) and `issue_iid` — a bare `issue_iid` fails schema validation. `renovateProjectId()` supplies the project id these calls need, mirroring `mcp-server-elastic-iac`'s own `ELASTIC_IAC_GITLAB_PROJECT_ID` default (`82850717`) since `packages/agent` has no existing access to that server-side config.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add resolveRenovateMarker node and dashboard-matching helpers"
```

---

## Task 7: `renovateTriggerGate` and `triggerRenovateUpdate` nodes

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts`
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `state.renovateMarker`, `state.renovateIssueIid` from Task 6.
- Produces: `export function renovateTriggerGate(state: IacStateType): Partial<IacStateType>` — consumed by Task 9.
- Produces: `export async function triggerRenovateUpdate(state: IacStateType): Promise<Partial<IacStateType>>` — consumed by Task 9.
- Produces: `export function buildRenovateGateMessage(marker: {marker: string; line: string}): string` — pure message-building, unit-tested (mirrors `buildFleetGateMessage`, referenced at `nodes.ts:11596`).

- [ ] **Step 1: Write the failing test for the pure message builder**

Add to `packages/agent/src/iac/renovate-integration.test.ts`:

```ts
import { buildRenovateGateMessage } from "./nodes.ts";

describe("buildRenovateGateMessage", () => {
	test("names the exact marker and describes the trigger", () => {
		const msg = buildRenovateGateMessage({
			marker: "renovate/eu-b2b-prometheus",
			line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
		});
		expect(msg).toContain("renovate/eu-b2b-prometheus");
		expect(msg).toContain("chore(deps): [eu-b2b] prometheus to v1.24.4");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: FAIL with `SyntaxError: Export named 'buildRenovateGateMessage' not found`.

- [ ] **Step 3: Implement the three functions**

In `packages/agent/src/iac/nodes.ts`, add after `resolveRenovateMarker` (Task 6):

```ts
// (Pure; unit-tested.)
export function buildRenovateGateMessage(marker: { marker: string; line: string }): string {
	const cleanLine = marker.line.replace(/^\s*-\s*\[[ x]\]\s*<!--.*?-->\s*/, "").trim();
	return `This will tick '${marker.marker}' (${cleanLine || marker.line.trim()}) and trigger an off-schedule Renovate run. Proceed?`;
}

// Single operator approve/decline interrupt, matching fleetUpgradeGate's role
// (nodes.ts:11591) exactly. Only reached when hasSingleRenovateMatch routed here.
export function renovateTriggerGate(state: IacStateType): Partial<IacStateType> {
	const marker = state.renovateMarker;
	if (!marker) return { renovateTriggerApproved: false };
	const choice = interrupt({
		type: "renovate_trigger_choice",
		marker: marker.marker,
		line: marker.line,
		message: buildRenovateGateMessage(marker),
	}) as { approve?: boolean };
	return { renovateTriggerApproved: choice?.approve === true };
}

// Calls the two SIO-1470 tools in sequence: tick the checkbox, then play the schedule.
// A schedule-triggered Renovate run only ever creates branches/MRs -- apply:* stays
// when: manual -- so this cannot deploy anything.
export async function triggerRenovateUpdate(state: IacStateType): Promise<Partial<IacStateType>> {
	const marker = state.renovateMarker;
	const issueIid = state.renovateIssueIid;
	if (!marker || issueIid === null) return {};

	await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: triggered" });

	const tickRes = await callTool("gitlab_unschedule_renovate_branches", {
		issueIid,
		markers: [marker.marker],
	});
	if (!isGitlabSuccess(tickRes)) {
		return {
			blockedReason: `Could not tick the dashboard checkbox: ${tickRes.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot trigger the update: ticking the Dependency Dashboard checkbox failed.")],
		};
	}

	const playRes = await callTool("gitlab_play_pipeline_schedule", { descriptionContains: "Renovate" });
	if (!isGitlabSuccess(playRes)) {
		return {
			blockedReason: `Could not play the Renovate schedule: ${playRes.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot trigger the update: playing the Renovate pipeline schedule failed.")],
		};
	}

	return {};
}
```

Check `isGitlabSuccess` is already imported/available in `nodes.ts` (it's used at `proposeFleetIntegration`, `nodes.ts:4065`, so it should be in scope already — confirm via grep, do not re-declare it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add renovateTriggerGate and triggerRenovateUpdate nodes"
```

---

## Task 8: `watchRenovateMr` node

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts`
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `state.renovateMarker` from Task 6; `gitlab_list_merge_requests_by_source_branch` tool from Task 2.
- Produces: `export async function watchRenovateMr(state: IacStateType): Promise<Partial<IacStateType>>` — consumed by Task 9.
- Produces: `export function parseFirstOpenMrUrl(raw: string): string | null` — pure response parser, unit-tested.

- [ ] **Step 1: Write the failing test for the pure parser**

Add to `packages/agent/src/iac/renovate-integration.test.ts`:

```ts
import { parseFirstOpenMrUrl } from "./nodes.ts";

describe("parseFirstOpenMrUrl", () => {
	test("returns the web_url of the first MR in the array", () => {
		const raw = JSON.stringify([
			{ iid: 42, web_url: "https://gitlab.example/x/-/merge_requests/42", state: "opened" },
		]);
		expect(parseFirstOpenMrUrl(raw)).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	test("null on an empty array", () => {
		expect(parseFirstOpenMrUrl("[]")).toBeNull();
	});

	test("null on malformed/error response", () => {
		expect(parseFirstOpenMrUrl("[404] not found")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: FAIL with `SyntaxError: Export named 'parseFirstOpenMrUrl' not found`.

- [ ] **Step 3: Implement `parseFirstOpenMrUrl` and `watchRenovateMr`**

In `packages/agent/src/iac/nodes.ts`, add after `triggerRenovateUpdate` (Task 7):

```ts
// (Pure; unit-tested.)
export function parseFirstOpenMrUrl(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const first = parsed[0] as { web_url?: unknown };
		return typeof first.web_url === "string" ? first.web_url : null;
	} catch {
		return null;
	}
}

// Bounded poll loop for the Renovate-created MR, reusing watchPipeline's exact shape
// (nodes.ts:7838-7861: same env-configurable interval/budget, same dispatchCustomEvent
// mid-loop emission) but polling for MR EXISTENCE by source branch rather than an
// existing pipeline's terminal status.
export async function watchRenovateMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const marker = state.renovateMarker;
	if (!marker) return {};

	const budgetMs = readPositiveMsEnv("IAC_PIPELINE_POLL_BUDGET_MS", 90000, log);
	const intervalMs = readPositiveMsEnv("IAC_PIPELINE_POLL_INTERVAL_MS", 10000, log);
	const deadline = Date.now() + budgetMs;
	const sourceBranch = marker.marker;

	while (Date.now() < deadline) {
		const listRes = await callTool("gitlab_list_merge_requests_by_source_branch", { sourceBranch });
		const mrUrl = parseFirstOpenMrUrl(listRes);
		if (mrUrl) {
			await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: MR created" });
			return {
				renovateMrUrl: mrUrl,
				messages: [new AIMessage(`Renovate opened the update MR: ${mrUrl}`)],
			};
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	return {
		messages: [
			new AIMessage(
				`Triggered the Renovate run for '${sourceBranch}', but no MR has appeared yet. Ask me to check again in a minute.`,
			),
		],
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add watchRenovateMr node"
```

---

## Task 9: Wire the sub-flow into `graph.ts`

**Files:**
- Modify: `packages/agent/src/iac/graph.ts`
- Test: `packages/agent/src/iac/graph.test.ts`

**Interfaces:**
- Consumes: all 5 node functions from Tasks 5-8 (`extractRenovateTarget`, `resolveRenovateMarker`, `renovateTriggerGate`, `triggerRenovateUpdate`, `watchRenovateMr`) plus `hasSingleRenovateMatch` from Task 6.

- [ ] **Step 1: Write the failing structural test**

Add to `packages/agent/src/iac/graph.test.ts`, in the `describe("buildIacGraph", ...)` block:

```ts
test("graph contains the renovate-integration-update sub-flow nodes", async () => {
	const graph = await buildIacGraph({ checkpointerType: "memory" });
	const nodeNames = Object.keys(graph.getGraph().nodes);
	expect(nodeNames).toContain("extractRenovateTarget");
	expect(nodeNames).toContain("resolveRenovateMarker");
	expect(nodeNames).toContain("renovateTriggerGate");
	expect(nodeNames).toContain("triggerRenovateUpdate");
	expect(nodeNames).toContain("watchRenovateMr");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/graph.test.ts`
Expected: FAIL — `nodeNames` does not contain `"extractRenovateTarget"` etc.

- [ ] **Step 3: Wire the nodes and edges**

In `packages/agent/src/iac/graph.ts`:

1. Add the 6 new names to the import block from `./nodes.ts` (currently `graph.ts:16-44`):
```ts
	extractRenovateTarget,
	hasSingleRenovateMatch,
	renovateTriggerGate,
	resolveRenovateMarker,
	triggerRenovateUpdate,
	watchRenovateMr,
```
(insert alphabetically into the existing sorted import list).

2. Add `"renovate-integration-update"` to `intentTarget` (currently `graph.ts:98-113`):
```ts
	const intentTarget = (s: typeof IacState.State) =>
		s.intent === "gitops"
			? "parseIntent"
			: s.intent === "gitops-amend"
				? "amendChange"
				: s.intent === "fleet-upgrade"
					? "detectFleetUpgrade"
					: s.intent === "renovate-integration-update"
						? "extractRenovateTarget"
						: s.intent === "synthetics-drift"
							? "detectSyntheticsDrift"
							: s.intent === "drift"
								? "detectDrift"
								: s.intent === "pipeline-status"
									? "watchPipeline"
									: s.intent === "converse"
										? "converseIac"
										: "answerInfo";
```

3. Add `"extractRenovateTarget"` to `INTENT_TARGETS` (currently `graph.ts:115-124`):
```ts
	const INTENT_TARGETS = [
		"parseIntent",
		"amendChange",
		"detectFleetUpgrade",
		"extractRenovateTarget",
		"detectSyntheticsDrift",
		"detectDrift",
		"answerInfo",
		"watchPipeline",
		"converseIac",
	] as const;
```

4. Register the 5 new nodes (in the `.addNode(...)` chain, after the `detectFleetUpgrade`/`fleetUpgradeGate`/`applyFleetUpgrade` block, currently `graph.ts:159-165`):
```ts
		// Renovate on-demand MR automation sub-flow. extractRenovateTarget parses the
		// {deployment, integration} pair; resolveRenovateMarker discovers the Dependency
		// Dashboard issue and matches it to a live marker (0/2+ matches end the turn with
		// a message, no gate); renovateTriggerGate holds the single operator approve/
		// decline interrupt; triggerRenovateUpdate ticks the checkbox + plays the
		// schedule; watchRenovateMr polls for the resulting MR.
		.addNode("extractRenovateTarget", extractRenovateTarget)
		.addNode("resolveRenovateMarker", resolveRenovateMarker)
		.addNode("renovateTriggerGate", renovateTriggerGate)
		.addNode("triggerRenovateUpdate", triggerRenovateUpdate)
		.addNode("watchRenovateMr", watchRenovateMr)
```

5. Wire the edges (after the existing fleet-upgrade edges, currently ending at `graph.ts:309` `.addEdge("applyFleetUpgrade", "teardown")`):
```ts
		// extractRenovateTarget can block (clarify) before resolving -- blockedReason -> END.
		.addConditionalEdges("extractRenovateTarget", (s) => (s.blockedReason ? END : "resolveRenovateMarker"), [
			"resolveRenovateMarker",
			END,
		])
		// Exactly one dashboard match -> the approval gate; 0 or 2+ -> teardown (the
		// disambiguation/no-match message is already set on state.messages).
		.addConditionalEdges("resolveRenovateMarker", (s) => (hasSingleRenovateMatch(s.renovateCandidates) ? "renovateTriggerGate" : "teardown"), [
			"renovateTriggerGate",
			"teardown",
		])
		// Operator approval routes to the trigger or to teardown (declined).
		.addConditionalEdges("renovateTriggerGate", (s) => (s.renovateTriggerApproved ? "triggerRenovateUpdate" : "teardown"), [
			"triggerRenovateUpdate",
			"teardown",
		])
		// triggerRenovateUpdate can block (a tick/play API failure) before watching -- blockedReason -> teardown.
		.addConditionalEdges("triggerRenovateUpdate", (s) => (s.blockedReason ? "teardown" : "watchRenovateMr"), [
			"watchRenovateMr",
			"teardown",
		])
		.addEdge("watchRenovateMr", "teardown")
```

Note: unlike `detectFleetUpgrade`'s straight `.addEdge("applyFleetUpgrade", "teardown")` (no block-check, since `applyFleetUpgrade` has no failure early-return), `triggerRenovateUpdate` DOES set `blockedReason` on both its API-failure paths (Task 7, lines setting `blockedReason` on a failed tick or a failed schedule-play) — its edge must stay conditional, not a plain `.addEdge`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full `packages/agent` test suite**

Run: `cd packages/agent && bun test`
Expected: all tests pass, including every pre-existing `iac/*.test.ts` file (no regressions to the existing intent routing).

- [ ] **Step 6: Typecheck and lint**

Run: `cd packages/agent && bun run typecheck && cd /path/to/repo/root && bunx biome check packages/agent/src/iac/graph.ts packages/agent/src/iac/graph.test.ts`
Expected: no errors.

- [ ] **Step 7: Verify the node count matches CLAUDE.md's convention**

Per CLAUDE.md's "verified node count" discipline for the main graph, confirm and note the new elastic-iac graph's total node count (this plan adds 5 nodes to whatever the pre-change count was) — run:
```bash
grep -c "\.addNode(" packages/agent/src/iac/graph.ts
```
If CLAUDE.md documents an elastic-iac node count anywhere, this is the point to update it (search `CLAUDE.md` for "elastic-iac" node-count mentions — if none exist, no update needed, this is a note for future documentation hygiene, not a blocking step).

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/iac/graph.ts packages/agent/src/iac/graph.test.ts
git commit -m "SIO-XXXX: wire renovate-integration-update sub-flow into the elastic-iac graph"
```

---

## Task 10: End-to-end manual verification against the live GitLab project

**Files:** none (verification only, no code changes).

This task has no automated test — it is the "confirm every claim against the real source" discipline this repo requires before considering agent-authored GitLab automation done, per the original Renovate handover's own working principle and this session's precedent of live-verifying against the real `observability-elastic-iac` repo before writing the spec.

- [ ] **Step 1: Boot the stack locally**

```bash
lsof -i :9086  # confirm mcp-server-elastic-iac is not already running on another process
cd packages/mcp-server-elastic-iac && bun run dev &
cd apps/web && bun run dev &
```

- [ ] **Step 2: Drive a real turn**

Via the web UI (or the SSE curl recipe from project memory, `reference_agent_stream_curl_endpoint`), send: "update <a package known to have a pending entry on the live Dependency Dashboard> on <deployment>" — pick a real pending entry from the live issue #11 body (re-fetch it first via `gitlab_get_repository_tree`/issue read to confirm current pending entries, since the dashboard changes over time).

- [ ] **Step 3: Verify each stage**

- Classifier routes to `renovate-integration-update` (check server logs for `"classified IaC intent"` with `intent: "renovate-integration-update"`).
- `resolveRenovateMarker` finds exactly one candidate matching the real marker.
- The gate message shows the exact real dashboard line.
- Approve the gate.
- `triggerRenovateUpdate` succeeds (verify via a direct GitLab check that the checkbox is now ticked and the schedule was played — `gh`/GitLab UI, or the same live-check pattern used earlier in this session).
- `watchRenovateMr` eventually reports the real MR URL (or the "still running, ask again" message if it exceeds the poll budget — in which case, ask again in a follow-up turn and confirm it resolves).

- [ ] **Step 4: Verify the 0-match and 2+-match paths**

Send a request naming a deployment+integration pair with NO pending dashboard entry — confirm the "no pending update found" message, not a silent wrong pick. If a real 2+-match scenario exists on the live board (e.g. the same package name might not recur across deployments in the current board — construct an artificial ambiguous phrasing that matches 2+ real markers by integration name alone, e.g. omit the deployment) — confirm the disambiguation message lists the real candidate markers.

- [ ] **Step 5: Kill all locally-started processes**

```bash
lsof -nP -iTCP:9086 -sTCP:LISTEN  # find the PID(s) you started
kill <PID>
lsof -nP -iTCP:9086 -sTCP:LISTEN  # confirm empty
lsof -nP -iTCP:5173 -sTCP:LISTEN  # web dev server port, confirm empty after kill
```

Per CLAUDE.md's mandatory rule: every service started this session must be killed and the port emptiness proven before the task is considered complete.

- [ ] **Step 6: Report findings**

No commit for this task (verification only). If any stage failed, return to the relevant earlier task, fix, and re-verify — do not report the feature complete without a real, live, successful end-to-end run.

---

## Final Verification (after all tasks)

```bash
bun run typecheck
bun run lint
cd packages/agent && bun test
cd packages/mcp-server-elastic-iac && bun test
```

Expected: all green, no regressions to any existing test in either package.
