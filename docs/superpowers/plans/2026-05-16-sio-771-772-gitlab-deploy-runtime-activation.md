# Activate gitlab-deploy-vs-datastore-runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant `gitlab-deploy-vs-datastore-runtime` correlation rule by wiring a `gitlab_list_merge_requests` MCP tool, a `couchbase_get_longest_running_queries`-with-`lastExecutionTime` change, two new extractors, and helper migration. Closes SIO-771 and SIO-772 (konnect side intentionally deferred).

**Architecture:** Three new typed slots (`gitlabFindings`, `couchbaseFindings`, plus the existing `kafkaFindings`) on `DataSourceResult`. Two new pure-function extractors (`extractors/gitlab.ts`, `extractors/couchbase.ts`) registered in `extract-findings.ts`. Existing kafka extractor backported to Zod for uniformity. Couchbase tool switched from markdown-rendering to JSON-emitting response so the extractor receives parseable data. Helper migration in `rules.ts` swaps `result.data` casts for typed-slot reads.

**Tech Stack:** Bun workspace monorepo, LangGraph, Zod v4 (CLAUDE.md mandates Zod for all runtime validation), `@modelcontextprotocol/sdk`, `couchbase` Node SDK, GitLab REST API.

**Spec:** `docs/superpowers/specs/2026-05-16-sio-771-772-gitlab-deploy-runtime-activation-design.md` (bundled in commit 1 of this PR).

**Linear:** [SIO-771](https://linear.app/siobytes/issue/SIO-771), [SIO-772](https://linear.app/siobytes/issue/SIO-772)

**Branch:** `sio-771-772-gitlab-deploy-runtime-activation` (off `main` @ `e208df7`)

---

## File Structure (decomposition decisions)

```
packages/shared/src/
  agent-state.ts                                    [modify] add 4 schemas + widen DataSourceResultSchema
  index.ts                                          [modify] re-export new types/schemas

packages/agent/src/
  correlation/extractors/
    kafka.ts                                        [modify] convert hand-rolled guards to Zod (commit 2)
    gitlab.ts                                       [create] new extractor
    gitlab.test.ts                                  [create] new test
    couchbase.ts                                    [create] new extractor
    couchbase.test.ts                               [create] new test
  correlation/rules.ts                              [modify] migrate two helpers, delete inline types
  extract-findings.ts                               [modify] register new extractors

packages/agent/tests/correlation/
  test-helpers.ts                                   [modify] add withGitLabFindings, withCouchbaseFindings
  engine.test.ts                                    [modify] migrate gitlab-deploy-vs-datastore-runtime tests

packages/mcp-server-gitlab/src/tools/
  code-analysis/list-merge-requests.ts              [create] new tool
  code-analysis-registry.ts                         [modify] register tool, bump count 5 -> 6
packages/mcp-server-gitlab/src/gitlab-client/
  index.ts                                          [modify] add listMergeRequests method

packages/mcp-server-couchbase/src/tools/queryAnalysis/
  analysisQueries.ts                                [modify] add MAX(requestTime) AS lastExecutionTime
  queryAnalysisUtils.ts                             [modify] add executeAnalysisQueryStructured helper
  getLongestRunningQueries.ts                       [modify] switch to structured helper
packages/mcp-server-couchbase/tests/
  queryAnalysis.test.ts                             [modify] update assertions for JSON shape

docs/superpowers/specs/
  2026-05-16-sio-771-772-gitlab-deploy-runtime-activation-design.md  [exists, bundle in commit 1]
```

**Boundaries:**
- Each extractor module is self-contained: one file, one tool's parse logic, file-private row schemas.
- Findings *shape* lives in `@devops-agent/shared` (cross-package contract); tool-output *parsing* lives in the agent package (consumer-side).
- The couchbase JSON-response helper is colocated with the existing markdown helper — same file, sibling export. Tools choose which to use.

---

## Branch + Linear setup (do once before Task 1)

- [ ] **Move SIO-771 + SIO-772 to In Progress in Linear** (per CLAUDE.md: status before code).

- [ ] **Branch off main:**

```bash
git checkout main && git pull origin main
git checkout -b sio-771-772-gitlab-deploy-runtime-activation
```

- [ ] **Stash any unrelated WIP** so this branch only carries SIO-771/772 changes:

```bash
git stash push -m "WIP-unrelated" -- .gitignore packages/mcp-server-couchbase/src/types/mcp.d.ts scripts/agentcore/policies/
```

(Reapply with `git stash pop` after the branch is fully pushed and the PR is open.)

---

## Commit 1 — Schemas + spec

### Task 1: Add the 4 finding/row schemas to `@devops-agent/shared`

**Files:**
- Modify: `packages/shared/src/agent-state.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1.1: Add the GitLab + Couchbase schemas + types to `agent-state.ts`**

In `packages/shared/src/agent-state.ts`, after the existing `KafkaFindingsSchema` block (line 34 area), add:

```typescript
// SIO-771: mirrors GitLab REST /merge_requests response fields the
// gitlab-deploy-vs-datastore-runtime rule consumes. snake_case matches the
// upstream API exactly so the extractor stays a pass-through validator.
export const GitLabMergedRequestSchema = z.object({
	id: z.union([z.number(), z.string()]),
	project_id: z.number().int().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	merged_at: z.string().optional(),
	web_url: z.string().optional(),
});
export type GitLabMergedRequest = z.infer<typeof GitLabMergedRequestSchema>;

export const GitLabFindingsSchema = z.object({
	mergedRequests: z.array(GitLabMergedRequestSchema).optional(),
});
export type GitLabFindings = z.infer<typeof GitLabFindingsSchema>;

// SIO-772: rows emitted by n1qlLongestRunningQueries + lastExecutionTime column.
export const CouchbaseSlowQuerySchema = z.object({
	statement: z.string(),
	avgServiceTime: z.string().optional(),
	lastExecutionTime: z.string().optional(),
	queries: z.number().int().optional(),
});
export type CouchbaseSlowQuery = z.infer<typeof CouchbaseSlowQuerySchema>;

export const CouchbaseFindingsSchema = z.object({
	slowQueries: z.array(CouchbaseSlowQuerySchema).optional(),
});
export type CouchbaseFindings = z.infer<typeof CouchbaseFindingsSchema>;
```

- [ ] **Step 1.2: Widen `DataSourceResultSchema` with the two new optional slots**

Find the existing `kafkaFindings: KafkaFindingsSchema.optional()` line (around `agent-state.ts:68`) and add two siblings beside it:

```typescript
	kafkaFindings: KafkaFindingsSchema.optional(),
	gitlabFindings: GitLabFindingsSchema.optional(),
	couchbaseFindings: CouchbaseFindingsSchema.optional(),
```

- [ ] **Step 1.3: Re-export from `packages/shared/src/index.ts`**

Find the existing `KafkaFindings` / `KafkaFindingsSchema` re-export (around line 17-18) and add siblings:

```typescript
	type GitLabFindings,
	GitLabFindingsSchema,
	type GitLabMergedRequest,
	GitLabMergedRequestSchema,
	type CouchbaseFindings,
	CouchbaseFindingsSchema,
	type CouchbaseSlowQuery,
	CouchbaseSlowQuerySchema,
	type KafkaFindings,
	KafkaFindingsSchema,
```

(Keep types and schemas alphabetical to satisfy Biome's import sorter, per memory `reference_biome_type_before_value_imports`.)

- [ ] **Step 1.4: Typecheck**

```bash
bun run --filter @devops-agent/shared typecheck
```

Expected: `Exited with code 0`.

- [ ] **Step 1.5: Run shared package tests** (sanity check — schemas often have implicit consumers in shared/__tests__)

```bash
bun run --filter @devops-agent/shared test 2>&1 | tail -10
```

Expected: 0 fail.

- [ ] **Step 1.6: Commit (with the spec)**

```bash
git add packages/shared/src/agent-state.ts \
        packages/shared/src/index.ts \
        docs/superpowers/specs/2026-05-16-sio-771-772-gitlab-deploy-runtime-activation-design.md
git commit -m "$(cat <<'EOF'
SIO-771/772: add GitLabFindings + CouchbaseFindings schema slots

Phase A (SIO-764, PR #101) introduced KafkaFindingsSchema and the
kafkaFindings slot on DataSourceResult. The ticket descriptions for
SIO-771/772 assumed Phase A had also added gitlab/couchbase slots, but
it had not -- so the schema work lands here as commit 1 of the
gitlab-deploy-vs-datastore-runtime activation. snake_case field names
match the GitLab REST API exactly (the rule's existing helpers read
merged_at, title, description, id directly), so the extractor stays a
pass-through validator instead of a renamer.

Spec for the full activation work lives at
docs/superpowers/specs/2026-05-16-sio-771-772-gitlab-deploy-runtime-activation-design.md
and is included here so the design rationale lands alongside its first
implementation step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 2 — Convert kafka extractor to Zod (uniformity)

### Task 2: Rewrite `extractors/kafka.ts` using Zod `safeParse`

**Files:**
- Modify: `packages/agent/src/correlation/extractors/kafka.ts`

CLAUDE.md says "Zod for all runtime validation". Phase A's extractor uses hand-rolled `isRecord` + `typeof` guards. Convert before adding the two new Zod-based siblings so all three extractors share one pattern. Tests pass unchanged because the parse decisions are semantically identical.

- [ ] **Step 2.1: Rewrite the extractor**

Replace the entire content of `packages/agent/src/correlation/extractors/kafka.ts` with:

```typescript
// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

// SIO-771/772: file-private schemas describe the **tool output** shape (what
// the kafka MCP returns), not the **finding** shape (which lives in
// @devops-agent/shared). Each tool's parser is owned by this extractor.

const ListConsumerGroupsRowSchema = z.object({ id: z.string(), state: z.string() });
const ListConsumerGroupsWrapperSchema = z.object({ groups: z.array(z.unknown()) });

const GetConsumerGroupLagSchema = z.object({ groupId: z.string(), totalLag: z.number() });

const ListDlqTopicsRowSchema = z.object({
	name: z.string(),
	totalMessages: z.number(),
	recentDelta: z.number().nullable(),
});

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
	const dlqTopics: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") {
			const wrapper = ListConsumerGroupsWrapperSchema.safeParse(o.rawJson);
			if (!wrapper.success) continue;
			for (const g of wrapper.data.groups) {
				const parsed = ListConsumerGroupsRowSchema.safeParse(g);
				if (!parsed.success) continue;
				const existing = byId.get(parsed.data.id) ?? { id: parsed.data.id };
				existing.state = parsed.data.state;
				byId.set(parsed.data.id, existing);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const parsed = GetConsumerGroupLagSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			const existing = byId.get(parsed.data.groupId) ?? { id: parsed.data.groupId };
			existing.totalLag = parsed.data.totalLag;
			byId.set(parsed.data.groupId, existing);
		} else if (o.toolName === "kafka_list_dlq_topics") {
			if (!Array.isArray(o.rawJson)) continue;
			for (const t of o.rawJson) {
				const parsed = ListDlqTopicsRowSchema.safeParse(t);
				if (parsed.success) dlqTopics.push(parsed.data);
			}
		}
	}

	const findings: KafkaFindings = {};
	if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
	if (dlqTopics.length > 0) findings.dlqTopics = dlqTopics;
	return findings;
}
```

- [ ] **Step 2.2: Run existing extractor tests — they MUST pass unchanged**

```bash
bun test packages/agent/src/correlation/extractors/kafka.test.ts 2>&1 | tail -10
```

Expected: 8 pass / 0 fail (same set that existed pre-rewrite).

If any test fails: the Zod schemas likely have a `passthrough()` or field constraint mismatch with the hand-rolled checks. Read the failing fixture, adjust the schema to match, re-run. Do NOT modify the test fixtures.

- [ ] **Step 2.3: Typecheck**

```bash
bun run --filter @devops-agent/agent typecheck
```

Expected: `Exited with code 0`.

- [ ] **Step 2.4: Commit**

```bash
git add packages/agent/src/correlation/extractors/kafka.ts
git commit -m "$(cat <<'EOF'
SIO-771/772: convert kafka extractor to Zod for uniformity

CLAUDE.md says "Zod for all runtime validation". Phase A's extractor
used hand-rolled isRecord + typeof guards as an outlier from that
rule. Convert before adding the two new Zod-based siblings (gitlab,
couchbase) so all three extractors share one pattern.

File-private row schemas describe the tool-output shape; finding
shapes stay in @devops-agent/shared. The parse decisions are
semantically identical to the hand-rolled version -- existing 8
fixture tests in extractors/kafka.test.ts pass unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 3 — GitLab tool + extractor

### Task 3: Add `listMergeRequests` to the GitLab REST client

**Files:**
- Modify: `packages/mcp-server-gitlab/src/gitlab-client/index.ts`

The existing `list-commits.ts` tool calls `client.listCommits(project_id, opts)`. Mirror that. First, find how `listCommits` is implemented in the REST client so the new method is symmetric.

- [ ] **Step 3.1: Read the existing client interface**

```bash
grep -n 'listCommits\|listMergeRequests\|class GitLabRestClient\|async list' packages/mcp-server-gitlab/src/gitlab-client/index.ts | head -20
```

If `listCommits` is in a separate file (`commits.ts`, etc.), follow the same layout for `merge-requests.ts`.

- [ ] **Step 3.2: Add `listMergeRequests` method**

Add a sibling method to whatever class/object exports `listCommits`. Body sketch:

```typescript
async listMergeRequests(
	projectId: number,
	opts: { state?: "merged" | "opened" | "closed" | "all"; updated_after?: string; per_page?: number } = {},
): Promise<unknown[]> {
	const params: Record<string, string | number> = { state: opts.state ?? "merged", per_page: opts.per_page ?? 20 };
	if (opts.updated_after) params.updated_after = opts.updated_after;
	const url = `/projects/${projectId}/merge_requests`;
	const result = await this.request<unknown[]>("GET", url, { params });
	return result;
}
```

(Adapt to whatever HTTP helper the client uses — `this.request`, `axios.get`, etc. The pattern must match `listCommits`.)

- [ ] **Step 3.3: Typecheck**

```bash
bun run --filter @devops-agent/mcp-server-gitlab typecheck
```

Expected: `Exited with code 0`.

### Task 4: Add the `gitlab_list_merge_requests` MCP tool

**Files:**
- Create: `packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts`
- Modify: `packages/mcp-server-gitlab/src/tools/code-analysis-registry.ts`

- [ ] **Step 4.1: Create the tool file**

`packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts`:

```typescript
// src/tools/code-analysis/list-merge-requests.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

// SIO-771: numeric project_id is required -- URL-encoded paths 404 against
// /api/v4 endpoints. See memory: reference_gitlab_internal_vs_public.
const ListMergeRequestsParams = z.object({
	project_id: z.number().int().describe("Numeric GitLab project ID. URL-encoded paths return 404 against /api/v4."),
	state: z
		.enum(["merged", "opened", "closed", "all"])
		.optional()
		.default("merged")
		.describe("MR state filter; default 'merged' for the deploy-vs-runtime correlation use case."),
	updated_after: z
		.string()
		.optional()
		.describe("ISO-8601 timestamp; only return MRs updated after this (server-side filter)."),
	per_page: z.number().int().min(1).max(100).optional().default(20).describe("Pagination size (1-100, default 20)."),
});

export function registerListMergeRequestsTool(server: McpServer, client: GitLabRestClient): void {
	server.tool(
		"gitlab_list_merge_requests",
		"List merge requests for a GitLab project. Defaults to state=merged for the deploy-vs-datastore-runtime correlation flow. Use updated_after to bound the result set by recency.",
		ListMergeRequestsParams.shape,
		async (args) => {
			return traceToolCall("gitlab_list_merge_requests", async () => {
				const params = ListMergeRequestsParams.parse(args);
				const result = await client.listMergeRequests(params.project_id, {
					state: params.state,
					updated_after: params.updated_after,
					per_page: params.per_page,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			});
		},
	);
}
```

- [ ] **Step 4.2: Register the tool**

In `packages/mcp-server-gitlab/src/tools/code-analysis-registry.ts`:

```typescript
// src/tools/code-analysis-registry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import { registerGetBlameTool } from "./code-analysis/get-blame.js";
import { registerGetCommitDiffTool } from "./code-analysis/get-commit-diff.js";
import { registerGetFileContentTool } from "./code-analysis/get-file-content.js";
import { registerGetRepositoryTreeTool } from "./code-analysis/get-repository-tree.js";
import { registerListCommitsTool } from "./code-analysis/list-commits.js";
import { registerListMergeRequestsTool } from "./code-analysis/list-merge-requests.js";

export function registerCodeAnalysisTools(server: McpServer, restClient: GitLabRestClient): number {
	registerGetFileContentTool(server, restClient);
	registerGetBlameTool(server, restClient);
	registerGetCommitDiffTool(server, restClient);
	registerListCommitsTool(server, restClient);
	registerGetRepositoryTreeTool(server, restClient);
	registerListMergeRequestsTool(server, restClient);
	return 6;
}
```

- [ ] **Step 4.3: Typecheck + run gitlab MCP tests**

```bash
bun run --filter @devops-agent/mcp-server-gitlab typecheck
bun run --filter @devops-agent/mcp-server-gitlab test 2>&1 | tail -10
```

Expected: typecheck clean. Test suite: 0 fail (no tests reference the new tool yet). If the test command errors because the package has no `tests/` directory (`packages/mcp-server-gitlab/tests` doesn't exist on `main`), skip — the tool's regression coverage will come via the agent-side extractor tests.

### Task 5: Create the GitLab extractor

**Files:**
- Create: `packages/agent/src/correlation/extractors/gitlab.ts`
- Create: `packages/agent/src/correlation/extractors/gitlab.test.ts`

- [ ] **Step 5.1: Write the failing test first** (TDD)

Create `packages/agent/src/correlation/extractors/gitlab.test.ts`:

```typescript
// packages/agent/src/correlation/extractors/gitlab.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractGitLabFindings } from "./gitlab.ts";

describe("extractGitLabFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "gitlab_list_commits", rawJson: [] }];
		expect(extractGitLabFindings(outputs)).toEqual({});
	});

	test("maps gitlab_list_merge_requests bare-array response to mergedRequests[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "gitlab_list_merge_requests",
				rawJson: [
					{
						id: 153,
						project_id: 42,
						title: "Fix OFFSET regression in styles-v3",
						description: "Reverts to LIMIT-only paging in product_search",
						merged_at: "2026-04-22T09:14:33.000Z",
						web_url: "https://gitlab.com/example/styles-v3/-/merge_requests/153",
					},
				],
			},
		];
		const findings = extractGitLabFindings(outputs);
		expect(findings.mergedRequests).toHaveLength(1);
		expect(findings.mergedRequests?.[0]?.id).toBe(153);
		expect(findings.mergedRequests?.[0]?.merged_at).toBe("2026-04-22T09:14:33.000Z");
	});

	test("ignores malformed entries (missing required id) and keeps valid siblings", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "gitlab_list_merge_requests",
				rawJson: [
					{ title: "no id here" },
					{ id: 99, title: "valid sibling" },
				],
			},
		];
		const findings = extractGitLabFindings(outputs);
		expect(findings.mergedRequests).toHaveLength(1);
		expect(findings.mergedRequests?.[0]?.id).toBe(99);
	});

	test("ignores non-array rawJson (e.g. upstream error string)", () => {
		const outputs: ToolOutput[] = [{ toolName: "gitlab_list_merge_requests", rawJson: "503 upstream error" }];
		expect(extractGitLabFindings(outputs)).toEqual({});
	});
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

```bash
bun test packages/agent/src/correlation/extractors/gitlab.test.ts 2>&1 | tail -10
```

Expected: FAIL (module `./gitlab.ts` not found).

- [ ] **Step 5.3: Write the extractor**

Create `packages/agent/src/correlation/extractors/gitlab.ts`:

```typescript
// packages/agent/src/correlation/extractors/gitlab.ts
import type { GitLabFindings, GitLabMergedRequest, ToolOutput } from "@devops-agent/shared";
import { GitLabMergedRequestSchema } from "@devops-agent/shared";

export function extractGitLabFindings(outputs: ToolOutput[]): GitLabFindings {
	const mergedRequests: GitLabMergedRequest[] = [];

	for (const o of outputs) {
		if (o.toolName !== "gitlab_list_merge_requests") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const mr of o.rawJson) {
			const parsed = GitLabMergedRequestSchema.safeParse(mr);
			if (parsed.success) mergedRequests.push(parsed.data);
		}
	}

	return mergedRequests.length > 0 ? { mergedRequests } : {};
}
```

- [ ] **Step 5.4: Run the test to verify it passes**

```bash
bun test packages/agent/src/correlation/extractors/gitlab.test.ts 2>&1 | tail -10
```

Expected: 4 pass / 0 fail.

- [ ] **Step 5.5: Commit (gitlab tool + extractor together)**

```bash
git add packages/mcp-server-gitlab/src/gitlab-client/ \
        packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts \
        packages/mcp-server-gitlab/src/tools/code-analysis-registry.ts \
        packages/agent/src/correlation/extractors/gitlab.ts \
        packages/agent/src/correlation/extractors/gitlab.test.ts
git commit -m "$(cat <<'EOF'
SIO-771: add gitlab_list_merge_requests tool + extractor

Adds the missing MCP tool that lets the gitlab-agent fetch merged MRs
for a project, feeding the gitlab-deploy-vs-datastore-runtime
correlation rule. Tool args mirror the GitLab REST API (numeric
project_id per memory reference_gitlab_internal_vs_public, state /
updated_after / per_page passthrough). Response is the raw GitLab REST
JSON serialised by the existing list-commits pattern, parsed by
tryParseJson on the agent side.

The new extractor uses GitLabMergedRequestSchema.safeParse to validate
each entry; malformed entries drop silently (schema enforces the only
required field, id). Module is the same pure-function shape as kafka's
extractor post-rewrite (commit 2).

Bumps registerCodeAnalysisTools return count 5 -> 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 4 — Couchbase tool/extractor + rule activation

### Task 6: Add the structured-response helper in couchbase MCP

**Files:**
- Modify: `packages/mcp-server-couchbase/src/tools/queryAnalysis/queryAnalysisUtils.ts`

- [ ] **Step 6.1: Add `executeAnalysisQueryStructured`**

Append to `packages/mcp-server-couchbase/src/tools/queryAnalysis/queryAnalysisUtils.ts`:

```typescript
/**
 * SIO-772: machine-readable sibling of executeAnalysisQuery for tools whose
 * output feeds correlation extractors. Returns ToolResponse with a bare-JSON
 * text payload (no markdown rendering, no Limit Application section). The
 * agent's tryParseJson(String(m.content)) parses it into ToolOutput.rawJson
 * as the raw rows array.
 *
 * Use this instead of executeAnalysisQuery when the consumer is structural
 * (extractFindings node, sub-agent reasoning) rather than human (CLI render).
 */
export async function executeAnalysisQueryStructured(
	bucket: Bucket,
	queryString: string,
	parameters?: Record<string, unknown>,
): Promise<ToolResponse> {
	const hasParameters = parameters !== undefined && Object.keys(parameters).length > 0;
	const cluster = bucket.cluster;
	const result = hasParameters
		? await cluster.query(queryString, { parameters })
		: await cluster.query(queryString);
	const rows = await result.rows;
	return { content: [{ type: "text", text: JSON.stringify(rows) }] };
}
```

- [ ] **Step 6.2: Typecheck**

```bash
bun run --filter @devops-agent/mcp-server-couchbase typecheck
```

Expected: `Exited with code 0`.

### Task 7: Add `lastExecutionTime` to `n1qlLongestRunningQueries`

**Files:**
- Modify: `packages/mcp-server-couchbase/src/tools/queryAnalysis/analysisQueries.ts`

- [ ] **Step 7.1: Add the MAX(requestTime) column**

Find the existing `n1qlLongestRunningQueries` (`analysisQueries.ts:44-56`) and update to:

```typescript
export const n1qlLongestRunningQueries: string = `
SELECT statement,
    DURATION_TO_STR(avgServiceTime) AS avgServiceTime,
    MAX(requestTime) AS lastExecutionTime,
    COUNT(1) AS queries
FROM system:completed_requests
WHERE UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))
ORDER BY avgServiceTime DESC;
`;
```

- [ ] **Step 7.2: Grep for other consumers of the constant**

```bash
grep -rn 'n1qlLongestRunningQueries' packages/mcp-server-couchbase/src/ packages/mcp-server-couchbase/tests/
```

If only `getLongestRunningQueries.ts` consumes it, no further action. If any prompts/runbooks reference the row shape (unlikely — they're agent-facing prose), update accordingly.

### Task 8: Switch `getLongestRunningQueries` to the structured helper

**Files:**
- Modify: `packages/mcp-server-couchbase/src/tools/queryAnalysis/getLongestRunningQueries.ts`

- [ ] **Step 8.1: Replace `executeAnalysisQuery` import + call**

```typescript
/* src/tools/queryAnalysis/getLongestRunningQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { n1qlLongestRunningQueries } from "./analysisQueries";
import { executeAnalysisQueryStructured } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_longest_running_queries",
		"Get the longest running queries based on service time. Returns bare JSON array of {statement, avgServiceTime, lastExecutionTime, queries} -- machine-readable for correlation extractors.",
		{
			limit: z.number().optional().describe("Optional limit for the number of results to return"),
			min_time_ms: z.number().optional().describe("Minimum execution time in milliseconds to include"),
		},
		async ({ limit, min_time_ms }) => {
			logger.info({ limit, min_time_ms }, "Getting longest running queries");

			let query = n1qlLongestRunningQueries;

			if (min_time_ms && min_time_ms > 0) {
				query = query.replace(
					"LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))",
					`LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))
           HAVING avgServiceTime >= ${min_time_ms}000000`,
				);
			}

			if (limit && limit > 0) {
				if (query.includes("LIMIT")) {
					query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
				} else {
					query = `${query.replace(";", "")} LIMIT ${limit};`;
				}
			}

			return executeAnalysisQueryStructured(bucket, query);
		},
	);
};
```

- [ ] **Step 8.2: Update existing tests**

```bash
grep -n 'capella_get_longest_running_queries\|getLongestRunningQueries' packages/mcp-server-couchbase/tests/*.ts
```

For any test that asserts the response was markdown-formatted (look for `responseText`, `# Longest Running Queries`, markdown headings, or `Query Execution Details`), switch the assertion to: response `content[0].text` parses as JSON and yields an array of `{statement, avgServiceTime, lastExecutionTime?, queries}` shapes. If `queryAnalysis.test.ts` exists and asserts markdown, update it; if there are no such assertions, no change needed.

- [ ] **Step 8.3: Typecheck + run couchbase MCP tests**

```bash
bun run --filter @devops-agent/mcp-server-couchbase typecheck
bun run --filter @devops-agent/mcp-server-couchbase test 2>&1 | tail -15
```

Expected: typecheck clean. Test suite: 0 fail. If a markdown-format test fails, update it per step 8.2.

### Task 9: Create the couchbase extractor

**Files:**
- Create: `packages/agent/src/correlation/extractors/couchbase.ts`
- Create: `packages/agent/src/correlation/extractors/couchbase.test.ts`

- [ ] **Step 9.1: Write the failing test**

Create `packages/agent/src/correlation/extractors/couchbase.test.ts`:

```typescript
// packages/agent/src/correlation/extractors/couchbase.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractCouchbaseFindings } from "./couchbase.ts";

describe("extractCouchbaseFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "capella_get_fatal_requests", rawJson: [] },
		];
		expect(extractCouchbaseFindings(outputs)).toEqual({});
	});

	test("maps capella_get_longest_running_queries bare-array response to slowQueries[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{
						statement: "SELECT * FROM bucket WHERE k = $1 OFFSET 100000",
						avgServiceTime: "2.3s",
						lastExecutionTime: "2026-05-07T11:42:00.000Z",
						queries: 17,
					},
					{
						statement: "SELECT meta(b).id FROM bucket b",
						avgServiceTime: "1.1s",
						lastExecutionTime: "2026-05-06T19:00:00.000Z",
						queries: 4,
					},
				],
			},
		];
		const findings = extractCouchbaseFindings(outputs);
		expect(findings.slowQueries).toHaveLength(2);
		expect(findings.slowQueries?.[0]?.statement).toContain("OFFSET");
		expect(findings.slowQueries?.[0]?.lastExecutionTime).toBe("2026-05-07T11:42:00.000Z");
	});

	test("ignores malformed entries (missing required statement) and keeps valid siblings", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{ avgServiceTime: "1.0s", queries: 1 },
					{ statement: "valid one", queries: 2 },
				],
			},
		];
		const findings = extractCouchbaseFindings(outputs);
		expect(findings.slowQueries).toHaveLength(1);
		expect(findings.slowQueries?.[0]?.statement).toBe("valid one");
	});

	test("ignores non-array rawJson (defensive against unexpected response shapes)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "capella_get_longest_running_queries", rawJson: "upstream returned markdown" },
		];
		expect(extractCouchbaseFindings(outputs)).toEqual({});
	});
});
```

- [ ] **Step 9.2: Run to verify it fails**

```bash
bun test packages/agent/src/correlation/extractors/couchbase.test.ts 2>&1 | tail -10
```

Expected: FAIL (module `./couchbase.ts` not found).

- [ ] **Step 9.3: Write the extractor**

Create `packages/agent/src/correlation/extractors/couchbase.ts`:

```typescript
// packages/agent/src/correlation/extractors/couchbase.ts
import type { CouchbaseFindings, CouchbaseSlowQuery, ToolOutput } from "@devops-agent/shared";
import { CouchbaseSlowQuerySchema } from "@devops-agent/shared";

export function extractCouchbaseFindings(outputs: ToolOutput[]): CouchbaseFindings {
	const slowQueries: CouchbaseSlowQuery[] = [];

	for (const o of outputs) {
		if (o.toolName !== "capella_get_longest_running_queries") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const q of o.rawJson) {
			const parsed = CouchbaseSlowQuerySchema.safeParse(q);
			if (parsed.success) slowQueries.push(parsed.data);
		}
	}

	return slowQueries.length > 0 ? { slowQueries } : {};
}
```

- [ ] **Step 9.4: Run the test to verify it passes**

```bash
bun test packages/agent/src/correlation/extractors/couchbase.test.ts 2>&1 | tail -10
```

Expected: 4 pass / 0 fail.

### Task 10: Register both new extractors in `extract-findings.ts`

**Files:**
- Modify: `packages/agent/src/extract-findings.ts`

- [ ] **Step 10.1: Add imports + map entries**

Replace the file with:

```typescript
// agent/src/extract-findings.ts
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractCouchbaseFindings } from "./correlation/extractors/couchbase.ts";
import { extractGitLabFindings } from "./correlation/extractors/gitlab.ts";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:extract-findings");

const EXTRACTORS: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
	kafka: (r) => ({ kafkaFindings: extractKafkaFindings(r.toolOutputs ?? []) }),
	gitlab: (r) => ({ gitlabFindings: extractGitLabFindings(r.toolOutputs ?? []) }),
	couchbase: (r) => ({ couchbaseFindings: extractCouchbaseFindings(r.toolOutputs ?? []) }),
};

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const dataSourceResults = state.dataSourceResults.map((r) => {
		const extractor = EXTRACTORS[r.dataSourceId];
		if (!extractor) return r;
		try {
			return { ...r, ...extractor(r) };
		} catch (err) {
			logger.warn(
				{ dataSourceId: r.dataSourceId, error: err instanceof Error ? err.message : String(err) },
				"extractFindings failed",
			);
			return r;
		}
	});
	return { dataSourceResults };
}
```

- [ ] **Step 10.2: Typecheck**

```bash
bun run --filter @devops-agent/agent typecheck
```

Expected: `Exited with code 0`.

### Task 11: Migrate `getGitLabMergedRequests` + `getDatastoreSlowQueries` helpers in `rules.ts`

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts`

- [ ] **Step 11.1: Delete the inline interfaces + import from shared**

In `packages/agent/src/correlation/rules.ts`, find lines 449-460:

```typescript
interface GitLabMergedRequest {
	id: number | string;
	title?: string;
	description?: string;
	merged_at?: string;
}

interface DatastoreSlowQuery {
	statement?: string;
	lastExecutionTime?: string;
	serviceTime?: number;
}
```

Delete those two interfaces. Update the import block at the top of the file to add the canonical types:

```typescript
import type { CouchbaseSlowQuery, GitLabMergedRequest, ToolError } from "@devops-agent/shared";
```

(The `DatastoreSlowQuery` rename to `CouchbaseSlowQuery` is intentional — the konnect side is dead in this iteration; calling the type "Datastore" implied a polymorphism that no longer holds.)

Replace any remaining `DatastoreSlowQuery` references in `rules.ts` with `CouchbaseSlowQuery`.

- [ ] **Step 11.2: Rewrite `getGitLabMergedRequests`**

Find the existing function (lines 490-495) and replace with:

```typescript
// SIO-771: reads result.gitlabFindings.mergedRequests, populated by
// extractGitLabFindings from the gitlab_list_merge_requests tool. Pre-SIO-771
// this cast result.data to a typed object that production never wrote --
// dormant since SIO-712.
function getGitLabMergedRequests(state: AgentStateType): GitLabMergedRequest[] {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "gitlab");
	if (!result || result.status !== "success") return [];
	return result.gitlabFindings?.mergedRequests ?? [];
}
```

- [ ] **Step 11.3: Rewrite `getDatastoreSlowQueries`**

Find the existing function (lines 497-502) and replace with:

```typescript
// SIO-772: couchbase reads the typed sibling populated by extractCouchbaseFindings.
// SIO-771/772 intentionally defers the konnect side -- no extractor wired this
// iteration. Returns [] for konnect, which makes the rule's konnect iteration a
// no-op without removing the branch (future konnect work activates it).
function getDatastoreSlowQueries(state: AgentStateType, dataSourceId: "couchbase" | "konnect"): CouchbaseSlowQuery[] {
	if (dataSourceId === "konnect") return [];
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "couchbase");
	if (!result || result.status !== "success") return [];
	return result.couchbaseFindings?.slowQueries ?? [];
}
```

- [ ] **Step 11.4: Update the dormancy comment**

Find the existing block at lines 483-489 and replace with:

```typescript
// SIO-771/772: gitlab + couchbase sides now wired -- this rule fires in
// production when a recent merged MR shares a distinctive token with a
// post-merge couchbase slowQuery statement. konnect side intentionally
// deferred until a real consumer arrives (see SIO-773 deferral policy).
```

- [ ] **Step 11.5: Typecheck**

```bash
bun run --filter @devops-agent/agent typecheck
```

Expected: `Exited with code 0`.

### Task 12: Add `withGitLabFindings` + `withCouchbaseFindings` test helpers

**Files:**
- Modify: `packages/agent/tests/correlation/test-helpers.ts`

- [ ] **Step 12.1: Append the helpers**

After the existing `withKafkaToolErrors` helper (the one SIO-769 added):

```typescript
// SIO-771/772: build gitlab/couchbase results with typed-finding siblings
// populated, mirroring the pattern from withKafkaFindings. Used by the
// gitlab-deploy-vs-datastore-runtime engine tests.
export function withGitLabFindings(state: AgentStateType, gitlabFindings: GitLabFindings): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{
				dataSourceId: "gitlab",
				status: "success",
				data: "prose summary placeholder",
				duration: 100,
				gitlabFindings,
			} as never,
		],
	};
}

export function withCouchbaseFindings(state: AgentStateType, couchbaseFindings: CouchbaseFindings): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{
				dataSourceId: "couchbase",
				status: "success",
				data: "prose summary placeholder",
				duration: 100,
				couchbaseFindings,
			} as never,
		],
	};
}
```

Update the top-of-file import block to add the two new types:

```typescript
import type { CouchbaseFindings, GitLabFindings, KafkaFindings, ToolError } from "@devops-agent/shared";
```

- [ ] **Step 12.2: Typecheck**

```bash
bun run --filter @devops-agent/agent typecheck
```

Expected: `Exited with code 0`.

### Task 13: Migrate gitlab-deploy-vs-datastore-runtime engine tests

**Files:**
- Modify: `packages/agent/tests/correlation/engine.test.ts`

- [ ] **Step 13.1: Locate the existing tests**

```bash
grep -n 'gitlab-deploy-vs-datastore-runtime\|gitlab_list_merge_requests\|mergedRequests\|slowQueries' packages/agent/tests/correlation/engine.test.ts
```

The existing tests likely use a `withGitLabResult` or hand-built `result.data` shape. Read the affected `describe` block and surrounding setup.

- [ ] **Step 13.2: Migrate fixture-building to the new helpers**

For each test that constructs a gitlab result with `mergedRequests`, change from the old pattern (e.g. `withGitLabResult(state, { mergedRequests: [...] })` or inline `dataSourceResults` build) to:

```typescript
const state = withGitLabFindings(baseState(), {
	mergedRequests: [
		{
			id: 153,
			project_id: 42,
			title: "Fix OFFSET regression in styles-v3",
			description: "Reverts to LIMIT-only paging",
			merged_at: "2026-04-22T09:14:33.000Z",
		},
	],
});
```

For couchbase fixtures similarly:

```typescript
const stateWithDatastore = withCouchbaseFindings(state, {
	slowQueries: [
		{
			statement: "SELECT * FROM bucket WHERE OFFSET 100000",
			lastExecutionTime: "2026-05-07T11:42:00.000Z",
			avgServiceTime: "2.3s",
		},
	],
});
```

If any test specifically exercised the konnect branch, it now expects no firing (since `getDatastoreSlowQueries(state, "konnect")` always returns `[]`). Update the assertion to `expect(rule?.status).toBe("satisfied")` for those cases, OR delete the konnect-specific test with a comment pointing at SIO-773.

Update the `import` line for `test-helpers` to add the new helpers:

```typescript
import { baseState, withCouchbaseFindings, withElasticResult, withGitLabFindings, withKafkaFindings, withKafkaResult, withKafkaToolErrors } from "./test-helpers";
```

- [ ] **Step 13.3: Run the engine tests**

```bash
bun test packages/agent/tests/correlation/engine.test.ts 2>&1 | tail -15
```

Expected: 0 fail. Test count may go up or down depending on whether konnect tests were deleted.

### Task 14: Final verification + commit 4

- [ ] **Step 14.1: Workspace typecheck**

```bash
bun run typecheck 2>&1 | tail -15
```

Expected: all packages exit 0.

- [ ] **Step 14.2: Run all affected package tests**

```bash
bun run --filter @devops-agent/shared test 2>&1 | tail -5
bun run --filter @devops-agent/mcp-server-couchbase test 2>&1 | tail -5
bun run --filter @devops-agent/mcp-server-gitlab test 2>&1 | tail -5
bun run --filter @devops-agent/agent test 2>&1 | tail -5
```

Expected: 0 fail across all four. If `mcp-server-konnect` fails (pre-existing missing `KONNECT_ACCESS_TOKEN`), that's unrelated.

- [ ] **Step 14.3: Stage + commit 4**

```bash
git add packages/mcp-server-couchbase/src/tools/queryAnalysis/analysisQueries.ts \
        packages/mcp-server-couchbase/src/tools/queryAnalysis/queryAnalysisUtils.ts \
        packages/mcp-server-couchbase/src/tools/queryAnalysis/getLongestRunningQueries.ts \
        packages/mcp-server-couchbase/tests/ \
        packages/agent/src/correlation/extractors/couchbase.ts \
        packages/agent/src/correlation/extractors/couchbase.test.ts \
        packages/agent/src/extract-findings.ts \
        packages/agent/src/correlation/rules.ts \
        packages/agent/tests/correlation/test-helpers.ts \
        packages/agent/tests/correlation/engine.test.ts

git commit -m "$(cat <<'EOF'
SIO-772: add lastExecutionTime + couchbase extractor; activate rule

Three coupled changes that together activate the
gitlab-deploy-vs-datastore-runtime correlation rule end-to-end:

1. capella_get_longest_running_queries returns lastExecutionTime
   (MAX(requestTime) per statement group) so the rule's post-merge
   filter has a comparison anchor.
2. The tool's response shape switches from markdown-rendering
   executeAnalysisQuery to a new bare-JSON executeAnalysisQueryStructured
   sibling, so the agent's tryParseJson(String(m.content)) parses it
   into ToolOutput.rawJson as the raw rows array (rather than as the
   unparseable markdown string the agent saw previously).
3. extractCouchbaseFindings reads that array, validates via
   CouchbaseSlowQuerySchema.safeParse, and populates the typed
   couchbaseFindings.slowQueries[] sibling on DataSourceResult.

Helper migration in rules.ts:
- getGitLabMergedRequests now reads gitlabFindings.mergedRequests
- getDatastoreSlowQueries reads couchbaseFindings.slowQueries for the
  couchbase side; returns [] for konnect (deferred per SIO-773 policy)
- Inline GitLabMergedRequest / DatastoreSlowQuery interfaces deleted
  in favour of @devops-agent/shared canonical types
- DatastoreSlowQuery renamed CouchbaseSlowQuery to match the
  one-datastore-this-iteration scope

The rule's konnect iteration branch is left intact; it's a no-op
without removing it, and future konnect activation just needs an
extractor.

Engine tests migrated from hand-built result.data objects to
withGitLabFindings / withCouchbaseFindings helpers.

Verification: bun run typecheck clean workspace-wide. Agent test
suite: full pass. Couchbase MCP suite: full pass after switching
markdown-shape assertions to JSON-shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Push + PR

### Task 15: Push branch and open PR

- [ ] **Step 15.1: Push**

```bash
git push -u origin sio-771-772-gitlab-deploy-runtime-activation
```

- [ ] **Step 15.2: Open PR** (template below — adapt to actual verification numbers from `bun run test`):

```bash
gh pr create --title "SIO-771/772: activate gitlab-deploy-vs-datastore-runtime rule" --body "$(cat <<'EOF'
## Summary

Closes the last SIO-764 sidecar: activates the gitlab-deploy-vs-datastore-runtime correlation rule by wiring the missing MCP tool + extractor for the gitlab side, switching the couchbase longest-running-queries tool from markdown to JSON response shape, adding the lastExecutionTime column the rule needs as a comparison anchor, and migrating the rule's helpers from result.data casts to typed-finding reads.

Four logical commits:

1. **Schemas + spec** — adds `GitLabFindingsSchema`, `CouchbaseFindingsSchema` (+ row schemas) to `@devops-agent/shared`, widens `DataSourceResultSchema` with the two new optional slots, and bundles the design spec for the work.
2. **Kafka extractor → Zod** — converts the Phase A extractor from hand-rolled `isRecord`/`typeof` guards to Zod `safeParse` to match CLAUDE.md's "Zod for all runtime validation" rule and unify the pattern across all three extractors.
3. **GitLab tool + extractor** — new `gitlab_list_merge_requests` MCP tool (numeric `project_id` per memory, GitLab REST passthrough), new `extractGitLabFindings` module + tests.
4. **Couchbase tool change + extractor + rule activation** — adds `MAX(requestTime) AS lastExecutionTime` to the existing SQL, swaps `executeAnalysisQuery` for a new bare-JSON `executeAnalysisQueryStructured` helper, new `extractCouchbaseFindings` + tests, helper migration in `rules.ts`, engine test migration.

## Scope decisions

- **Konnect side deferred.** The rule's konnect iteration becomes a no-op (helper returns `[]` for konnect) until a real consumer arrives. Aligns with SIO-773's per-datasource deferral policy. The rule still fires end-to-end on gitlab + couchbase data, which is the more common production case.
- **Couchbase tool repurposed to JSON.** `capella_get_longest_running_queries` previously emitted markdown via `executeAnalysisQuery` — unparseable by the agent's `tryParseJson`. New `executeAnalysisQueryStructured` sibling emits bare JSON; the markdown helper stays for tools whose only consumer is human CLI rendering.
- **Kafka extractor uniformly Zod.** Phase A's hand-rolled extractor was the project's outlier from the "Zod for all runtime validation" rule. Backported in commit 2 so all three extractors land with one pattern.

## Test plan

- [x] `bun run typecheck` — all 13 workspace packages exit 0
- [x] `bun run --filter @devops-agent/shared test` — 0 fail
- [x] `bun run --filter @devops-agent/mcp-server-gitlab test` — 0 fail
- [x] `bun run --filter @devops-agent/mcp-server-couchbase test` — 0 fail
- [x] `bun run --filter @devops-agent/agent test` — 0 fail
- [x] `bun test packages/agent/src/correlation/extractors/` — kafka (8), gitlab (4), couchbase (4) all pass
- [x] `bun test packages/agent/tests/correlation/engine.test.ts` — full pass

Optional probes (deferred — require live infra): GitLab MR list against a project; couchbase longest-running query JSON shape; LangSmith integration replay on a styles-v3-style scenario.

## Notes for reviewer

- Pre-existing lint pollution on `main` (4 unrelated formatting/import errors in couchbase types + 2 policy JSONs) not touched.
- `@devops-agent/mcp-server-konnect` test suite fails from missing `KONNECT_ACCESS_TOKEN` — unrelated env-config issue.

Closes SIO-771, closes SIO-772.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 15.3: Move both Linear tickets to In Review**

Update SIO-771 and SIO-772 status to "In Review" with the PR URL linked.

- [ ] **Step 15.4: Restore unrelated WIP**

```bash
git stash pop
```

(If stash conflicts arise on `.gitignore` / policy JSONs, resolve manually — the stashed changes are unrelated to this PR.)

---

## Self-review checklist (run after writing the plan, before handing off)

**Spec coverage:**
- [x] `GitLabFindingsSchema` + `CouchbaseFindingsSchema` + types added (Task 1)
- [x] Kafka extractor backported to Zod (Task 2)
- [x] `gitlab_list_merge_requests` tool registered (Task 4)
- [x] `extractGitLabFindings` extractor + tests (Task 5)
- [x] `lastExecutionTime` added to SQL (Task 7)
- [x] `executeAnalysisQueryStructured` helper + `getLongestRunningQueries` switch (Tasks 6 + 8)
- [x] `extractCouchbaseFindings` extractor + tests (Task 9)
- [x] Both extractors registered in `extract-findings.ts` (Task 10)
- [x] `getGitLabMergedRequests`, `getDatastoreSlowQueries` migrated; inline types deleted (Task 11)
- [x] `withGitLabFindings`, `withCouchbaseFindings` test helpers (Task 12)
- [x] Engine tests migrated (Task 13)
- [x] Verification + PR (Tasks 14 + 15)

**Type consistency:**
- `CouchbaseSlowQuery` (not `DatastoreSlowQuery`) used in `rules.ts` and shared schemas — consistent across Tasks 1, 11, 12.
- `mergedRequests` (camelCase, plural) on `GitLabFindings`; `merged_at` (snake_case) on the row — matches Task 1 schema and the rule's existing reads.
- `slowQueries` on `CouchbaseFindings`; `lastExecutionTime` on the row — matches Task 1 schema and rule's existing reads.

**Placeholder scan:** No TBD / TODO / "implement later" / "handle edge cases" without explicit code. Tasks 3 and 8 contain "verify during implementation" notes for things that genuinely require reading existing code, with concrete commands.
