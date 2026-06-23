# Grounded Gaps + Confidence Cap + IAM Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the incident-analyzer from printing fabricated permission-denial Gaps and unverified confidence scores, and align the committed IAM policy file with the live deployed role.

**Architecture:** Two pure helpers in `aggregator.ts` cross-check Gaps prose against observed `toolErrors{category:"auth"}`; ungrounded permission claims are rewritten to honest "not retrieved" text and trigger the existing 0.59 confidence cap. A repo-only IAM change reverts the policy name to the live-deployed `DevOpsAgentReadOnlyPolicy` and splits the logs statement to match live v6.

**Tech Stack:** TypeScript (strict, no `any`), Bun test, LangGraph aggregator node, AWS IAM JSON policy + bash setup script.

**Linear:** [SIO-1013](https://linear.app/siobytes/issue/SIO-1013) · **Spec:** `docs/superpowers/specs/2026-06-23-grounded-gaps-and-confidence-design.md`

## Global Constraints

- TypeScript strict mode; never use `any` (biome `noExplicitAny: "error"`).
- No emojis in code, logs, comments, or output.
- Named exports preferred.
- Commit format: `SIO-1013: message`. NEVER commit without this being slash-command authorized (it is — this plan executes under authorization).
- Tests colocated next to source (`foo.test.ts` beside `foo.ts`), not in `__tests__/`.
- Run `bun run typecheck`, `bun run lint`, and the relevant `bun test` after every change.
- WORKTREE GOTCHA: this branch runs in `.claude/worktrees/sharp-mccarthy-f7c622`. Use the worktree-relative paths below; do NOT write to the sibling main checkout at `/WebstormProjects/devops-incident-analyzer/...` or git will not see the file.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/agent/src/aggregator.ts` | Add `detectUngroundedBlockers` + `rewriteUngroundedBlockers` pure helpers; wire into the cap in `aggregate()` | Modify |
| `packages/agent/src/aggregator-grounding.test.ts` | Unit tests for the two new pure helpers + the cap wiring | Create |
| `scripts/agentcore/policies/devops-agent-readonly-policy.json` | Split logs into `LogsListUnscoped` + `LogsReadLimitedByName` to match live v6 | Modify |
| `scripts/agentcore/setup-aws-readonly-role.sh` | Revert `POLICY_NAME` default + SIO-858 comment to `DevOpsAgentReadOnlyPolicy` | Modify |
| `packages/mcp-server-aws/src/tools/wrap.ts:82` | Advice string already says `DevOpsAgentReadOnlyPolicy` — verify only | Verify |

---

## Task 1: `detectUngroundedBlockers` pure helper

**Files:**
- Modify: `packages/agent/src/aggregator.ts` (add helper + regex near the existing `extractGapsBulletCount`, ~line 246-269)
- Test: `packages/agent/src/aggregator-grounding.test.ts` (create)

**Interfaces:**
- Consumes: `DataSourceResult` from `@devops-agent/shared` (already importable; fields `toolErrors?: ToolError[]`, each `ToolError` has `category: "auth"|"session"|"transient"|"unknown"`). Reuses module-private `GAPS_HEADING_RE`, `TOP_LEVEL_BULLET_RE`, `ANY_HEADING_RE` already defined at aggregator.ts:250-252.
- Produces: `export function detectUngroundedBlockers(answer: string, results: DataSourceResult[]): { ungrounded: string[] }` — returns the verbatim text of each `## Gaps` bullet that asserts a permission/IAM denial while NO `toolError{category:"auth"}` was observed across `results`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/aggregator-grounding.test.ts`:

```ts
// packages/agent/src/aggregator-grounding.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { detectUngroundedBlockers } from "./aggregator.ts";

const REPORT_TAIL = `## Gaps

- ECS collector application logs (\`/ecs/fargate/open-telemetry-prd-log-group\`) are inaccessible: \`logs:DescribeLogGroups\` and \`logs:StartQuery\` are not permitted for \`DevOpsAgentReadOnly\`. OpAMP WebSocket connection state cannot be confirmed without these logs.
- Three Elasticsearch SQL queries failed during investigation (column resolution, syntax, and index errors). These were retried with alternative query forms.
- No CloudWatch metrics exist for the OTel collector's OTLP ingestion or OpAMP heartbeat.

Confidence: 0.62`;

function result(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "aws", data: {}, status: "success", ...over };
}

describe("detectUngroundedBlockers", () => {
	test("flags an IAM-denial gap when no auth toolError was observed", () => {
		const results = [result({ dataSourceId: "aws", toolErrors: [] })];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("logs:DescribeLogGroups");
	});

	test("does NOT flag when a real auth toolError exists", () => {
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{ toolName: "aws_logs_start_query", category: "auth", message: "AccessDenied", retryable: false },
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		expect(ungrounded).toHaveLength(0);
	});

	test("never flags non-permission gaps (SQL failures, missing metrics)", () => {
		const results = [result({ dataSourceId: "aws", toolErrors: [] })];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		// only the IAM bullet matches; the SQL + CloudWatch bullets must not
		expect(ungrounded.some((u) => u.includes("Elasticsearch SQL"))).toBe(false);
		expect(ungrounded.some((u) => u.includes("CloudWatch metrics"))).toBe(false);
	});

	test("returns empty when there is no Gaps section", () => {
		const { ungrounded } = detectUngroundedBlockers("# Report\n\nAll healthy.\n\nConfidence: 0.9", [
			result({ toolErrors: [] }),
		]);
		expect(ungrounded).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts`
Expected: FAIL — `detectUngroundedBlockers` is not exported from `./aggregator.ts`.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/aggregator.ts`, add an import for the type at the top (the file already imports `redactPiiContent` from `@devops-agent/shared` at line 3 — extend it):

```ts
import { type DataSourceResult, redactPiiContent } from "@devops-agent/shared";
```

Then, immediately after `extractGapsBulletCount` (after line 269), add:

```ts
// SIO-1013: a Gaps bullet asserting a permission/IAM denial must be grounded in an
// observed auth tool error. A real logs:DescribeLogGroups AccessDenied flows
// MCP _error.kind=iam-permission-missing -> tool output text -> sub-agent.ts regex
// (/access denied/i, /forbidden/i) -> toolErrors[{category:"auth"}]. If the gap claims a
// denial but NO auth error exists in any sub-agent's results, the LLM fabricated it.
const PERMISSION_DENIAL_RE =
	/\b(not permitted|access denied|accessdenied|forbidden|iam permission|permission (?:gap|denied|missing)|lacks? permission|logs:[a-z]+)\b/i;

export function detectUngroundedBlockers(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	const authErrorObserved = results.some((r) => (r.toolErrors ?? []).some((e) => e.category === "auth"));
	if (authErrorObserved) return { ungrounded: [] };

	const lines = answer.split("\n");
	let inGapsSection = false;
	const ungrounded: string[] = [];
	for (const line of lines) {
		if (inGapsSection && ANY_HEADING_RE.test(line)) break;
		if (!inGapsSection && GAPS_HEADING_RE.test(line)) {
			inGapsSection = true;
			continue;
		}
		if (inGapsSection && TOP_LEVEL_BULLET_RE.test(line) && PERMISSION_DENIAL_RE.test(line)) {
			ungrounded.push(line);
		}
	}
	return { ungrounded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/aggregator.ts packages/agent/src/aggregator-grounding.test.ts
git commit -m "SIO-1013: detect ungrounded permission-denial gaps in aggregator"
```

---

## Task 2: `rewriteUngroundedBlockers` pure helper

**Files:**
- Modify: `packages/agent/src/aggregator.ts` (add helper after `detectUngroundedBlockers`)
- Test: `packages/agent/src/aggregator-grounding.test.ts` (extend)

**Interfaces:**
- Consumes: the `ungrounded: string[]` output of `detectUngroundedBlockers` (the verbatim bullet lines).
- Produces: `export function rewriteUngroundedBlockers(answer: string, ungrounded: string[]): string` — replaces each flagged bullet line with a neutral honest statement, leaving every other line untouched. Idempotent on an empty `ungrounded` (returns `answer` unchanged).

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/aggregator-grounding.test.ts`:

```ts
import { rewriteUngroundedBlockers } from "./aggregator.ts";

describe("rewriteUngroundedBlockers", () => {
	test("replaces a flagged bullet with an honest 'not retrieved' statement", () => {
		const flagged =
			"- ECS collector application logs (`/ecs/fargate/open-telemetry-prd-log-group`) are inaccessible: `logs:DescribeLogGroups` and `logs:StartQuery` are not permitted for `DevOpsAgentReadOnly`.";
		const answer = `## Gaps\n\n${flagged}\n\nConfidence: 0.62`;
		const out = rewriteUngroundedBlockers(answer, [flagged]);
		expect(out).not.toContain("not permitted for");
		expect(out).toContain("were not retrieved during this investigation");
		expect(out).toContain("Confidence: 0.62"); // other lines untouched
	});

	test("returns answer unchanged when nothing is flagged", () => {
		const answer = "## Gaps\n\n- a real gap\n\nConfidence: 0.9";
		expect(rewriteUngroundedBlockers(answer, [])).toBe(answer);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts`
Expected: FAIL — `rewriteUngroundedBlockers` not exported.

- [ ] **Step 3: Write minimal implementation**

In `aggregator.ts`, after `detectUngroundedBlockers`, add:

```ts
// SIO-1013: replace each ungrounded permission-blocker bullet's fabricated cause with a
// neutral truth. We do not know WHY the data is missing (the tool may simply never have
// been called), so we assert only what is verifiable: the data was not retrieved and the
// access state is unconfirmed. Only the flagged lines change; the rest of the report is
// preserved verbatim.
const UNGROUNDED_BLOCKER_REPLACEMENT =
	"- Some data referenced above were not retrieved during this investigation. No permission error was observed, so the access state is unconfirmed; the relevant read tools may not have been invoked.";

export function rewriteUngroundedBlockers(answer: string, ungrounded: string[]): string {
	if (ungrounded.length === 0) return answer;
	const flagged = new Set(ungrounded);
	return answer
		.split("\n")
		.map((line) => (flagged.has(line) ? UNGROUNDED_BLOCKER_REPLACEMENT : line))
		.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/aggregator.ts packages/agent/src/aggregator-grounding.test.ts
git commit -m "SIO-1013: rewrite ungrounded permission-blocker gaps to honest text"
```

---

## Task 3: Wire grounding into the confidence cap inside `aggregate()`

**Files:**
- Modify: `packages/agent/src/aggregator.ts` (the cap block at lines 342-419)
- Test: `packages/agent/src/aggregator-grounding.test.ts` (extend with an `aggregate()`-level test using the existing LLM mock pattern)

**Interfaces:**
- Consumes: `detectUngroundedBlockers` + `rewriteUngroundedBlockers` (Tasks 1-2), and the existing `TOOL_ERROR_CONFIDENCE_CAP = 0.59`, `rewriteConfidenceInAnswer`, `anyCapTriggered` machinery.
- Produces: when an ungrounded blocker is present, `aggregate()` returns `confidenceScore <= 0.59`, `confidenceCap: 0.59`, a `finalAnswer` whose printed `Confidence:` line is rewritten AND whose flagged Gaps bullet is rewritten.

- [ ] **Step 1: Write the failing test**

Append an `aggregate()`-level test. This needs the LLM mock; mirror the seam from `aggregator.test.ts` (lines 18-46). Add to `aggregator-grounding.test.ts` ABOVE the existing imports of `./aggregator.ts` — bun hoists `mock.module`, but to be safe put the mock at the very top of the file (move it there if the file already imports aggregator). Concretely, create this as a SEPARATE test block in the SAME file but ensure the mock precedes the first `aggregate` import:

```ts
import { mock } from "bun:test";

let mockLlmContent =
	"## Gaps\n\n- ECS collector logs are inaccessible: `logs:DescribeLogGroups` is not permitted for `DevOpsAgentReadOnly`.\n- A second real gap here.\n\nConfidence: 0.62";

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			return { content: mockLlmContent };
		}
	},
}));
```

Then the test:

```ts
import { aggregate } from "./aggregator.ts";
import type { AgentStateType } from "./state.ts";

test("aggregate caps confidence and rewrites text on an ungrounded IAM gap", async () => {
	const state = {
		dataSourceResults: [{ dataSourceId: "aws", data: {}, status: "success", toolErrors: [], messageCount: 5 }],
		targetDataSources: ["aws"],
		normalizedIncident: { affectedServices: [] },
		messages: [],
	} as unknown as AgentStateType;

	const out = await aggregate(state);
	expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
	expect(out.confidenceCap).toBe(0.59);
	expect(out.finalAnswer).not.toContain("not permitted for");
	expect(out.finalAnswer).toContain("were not retrieved");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts -t "aggregate caps confidence"`
Expected: FAIL — `confidenceScore` is `0.62` (uncapped) and `finalAnswer` still says "not permitted for".

- [ ] **Step 3: Write minimal implementation**

In `aggregate()` in `aggregator.ts`, locate the cap block (around lines 372-378):

```ts
	// SIO-709 AC #2: Gaps section with >= 2 bullets triggers the same 0.59 cap.
	const GAPS_BULLET_THRESHOLD = 2;
	const gapsBulletCount = extractGapsBulletCount(answer);
	const gapsCapTriggered = gapsBulletCount >= GAPS_BULLET_THRESHOLD;

	const anyCapTriggered = degradedSubAgents.length > 0 || gapsCapTriggered;
	const cappedScore = anyCapTriggered ? Math.min(confidenceScore, TOOL_ERROR_CONFIDENCE_CAP) : confidenceScore;
```

Replace it with:

```ts
	// SIO-709 AC #2: Gaps section with >= 2 bullets triggers the same 0.59 cap.
	const GAPS_BULLET_THRESHOLD = 2;
	const gapsBulletCount = extractGapsBulletCount(answer);
	const gapsCapTriggered = gapsBulletCount >= GAPS_BULLET_THRESHOLD;

	// SIO-1013: a Gaps bullet claiming a permission/IAM denial with NO observed auth tool
	// error is fabricated. Cap confidence below the HITL gate so a hallucinated blocker
	// can never print a passing score, and rewrite the bullet to honest "not retrieved" text.
	const { ungrounded } = detectUngroundedBlockers(answer, results);
	const ungroundedCapTriggered = ungrounded.length > 0;

	const anyCapTriggered = degradedSubAgents.length > 0 || gapsCapTriggered || ungroundedCapTriggered;
	const cappedScore = anyCapTriggered ? Math.min(confidenceScore, TOOL_ERROR_CONFIDENCE_CAP) : confidenceScore;
```

Then add a warning log next to the two existing cap warnings (after the `gapsCapTriggered` block, ~line 404):

```ts
	if (ungroundedCapTriggered) {
		logger.warn(
			{ ungrounded, cap: TOOL_ERROR_CONFIDENCE_CAP, originalScore: confidenceScore, cappedScore },
			"Aggregator Gaps section claimed a permission blocker with no observed auth tool error; capping confidence",
		);
	}
```

Finally, update the `finalAnswer` line (~line 408) so the ungrounded bullets are rewritten BEFORE the confidence line is synced:

```ts
	// SIO-860: when a cap triggered, rewrite the printed confidence to the capped value.
	// SIO-1013: also rewrite any ungrounded permission-blocker bullets to honest text first.
	const rewrittenForGrounding = ungroundedCapTriggered ? rewriteUngroundedBlockers(answer, ungrounded) : answer;
	const finalAnswer = anyCapTriggered
		? rewriteConfidenceInAnswer(rewrittenForGrounding, cappedScore)
		: rewrittenForGrounding;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/aggregator-grounding.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Run the full aggregator suite to check no regression**

Run: `bun test packages/agent/src/aggregator.test.ts`
Expected: PASS (40 existing tests still green — the new cap only fires on permission-denial language with no auth error, which none of those fixtures contain). If any fail, inspect whether a fixture's Gaps prose accidentally matches `PERMISSION_DENIAL_RE`; if so, that fixture had an ungrounded claim and the test expectation should be updated, not the regex loosened.

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add packages/agent/src/aggregator.ts packages/agent/src/aggregator-grounding.test.ts
git commit -m "SIO-1013: cap confidence on ungrounded permission-blocker gaps"
```

---

## Task 4: Reconcile IAM policy file + setup script to live v6

**Files:**
- Modify: `scripts/agentcore/policies/devops-agent-readonly-policy.json` (logs statement at lines 107-127)
- Modify: `scripts/agentcore/setup-aws-readonly-role.sh` (POLICY_NAME default + SIO-858 comment at lines 24, 35-38)
- Verify: `packages/mcp-server-aws/src/tools/wrap.ts:82` (already correct)

**Interfaces:**
- Consumes: live policy v6 (verified: `LogsListUnscoped` Describe-on-`*` + `LogsReadLimitedByName` read-on-name-scope; attached policy is `DevOpsAgentReadOnlyPolicy`, and NO `DevOpsAgentReadOnlyPermissions` policy exists in the account).
- Produces: a repo policy + script that, when applied, is a no-op against the live role.

- [ ] **Step 1: Split the logs statement in the policy JSON**

In `scripts/agentcore/policies/devops-agent-readonly-policy.json`, replace the single `LogsReadLimitedByName` statement (lines 107-127) with two statements matching live v6. Keep `/bedrock/*` in the name-scoped list (intentional repo-ahead-of-live future-proofing — note it):

```json
		{
			"Sid": "LogsListUnscoped",
			"Effect": "Allow",
			"Action": ["logs:DescribeLogGroups", "logs:DescribeLogStreams"],
			"Resource": "*"
		},
		{
			"Sid": "LogsReadLimitedByName",
			"Effect": "Allow",
			"Action": [
				"logs:GetLogEvents",
				"logs:FilterLogEvents",
				"logs:StartQuery",
				"logs:GetQueryResults",
				"logs:StopQuery"
			],
			"Resource": [
				"arn:aws:logs:*:*:log-group:/aws/*",
				"arn:aws:logs:*:*:log-group:/ecs/*",
				"arn:aws:logs:*:*:log-group:/app/*",
				"arn:aws:logs:*:*:log-group:/platform/*",
				"arn:aws:logs:*:*:log-group:/prod/*",
				"arn:aws:logs:*:*:log-group:/bedrock/*"
			]
		},
```

- [ ] **Step 2: Validate the JSON parses**

Run: `bun -e 'JSON.parse(require("fs").readFileSync("scripts/agentcore/policies/devops-agent-readonly-policy.json","utf8")); console.log("valid JSON")'`
Expected: `valid JSON`.

- [ ] **Step 3: Revert the policy name in the setup script**

In `scripts/agentcore/setup-aws-readonly-role.sh`:

Change line 38 from:
```bash
POLICY_NAME="${POLICY_NAME:-DevOpsAgentReadOnlyPermissions}"
```
to:
```bash
POLICY_NAME="${POLICY_NAME:-DevOpsAgentReadOnlyPolicy}"
```

Change the line 24 default hint and replace the SIO-858 comment block (lines 35-37) with the verified truth:

```bash
# SIO-1013: the live attached managed policy is DevOpsAgentReadOnlyPolicy (verified via
# aws iam list-policies --scope Local 2026-06-23: AttachmentCount 1, default v6). The
# SIO-858 rename to DevOpsAgentReadOnlyPermissions was never deployed and no such policy
# exists in the account, so the default is the real deployed name. Override only if an
# account genuinely differs.
```

- [ ] **Step 4: Verify wrap.ts advice string is already correct**

Run: `grep -n "DevOpsAgentReadOnlyPolicy" packages/mcp-server-aws/src/tools/wrap.ts`
Expected: line 82 already references `DevOpsAgentReadOnlyPolicy` — no change needed. (If it ever says `...Permissions`, fix it to `...Policy`.)

- [ ] **Step 5: Run mcp-server-aws tests (wrap.test.ts asserts the advice string)**

Run: `bun test packages/mcp-server-aws/src/__tests__/wrap.test.ts`
Expected: PASS (the advice-string assertion still matches `DevOpsAgentReadOnlyPolicy`).

- [ ] **Step 6: Commit**

```bash
git add scripts/agentcore/policies/devops-agent-readonly-policy.json scripts/agentcore/setup-aws-readonly-role.sh
git commit -m "SIO-1013: reconcile IAM policy file + setup script to live v6 (DevOpsAgentReadOnlyPolicy)"
```

---

## Task 5: Full verification + PR

- [ ] **Step 1: Full gate**

Run: `bun run typecheck && bun run lint && bun run --filter @devops-agent/agent test && bun test packages/mcp-server-aws/src/__tests__/wrap.test.ts`
Expected: all green.

- [ ] **Step 2: Manual probe — grounding against the real report tail**

Run:
```bash
bun -e '
import("./packages/agent/src/aggregator.ts").then(({ detectUngroundedBlockers }) => {
  const tail = require("fs").readFileSync("/tmp/report-tail.txt","utf8");
  console.log(detectUngroundedBlockers(tail, [{ dataSourceId:"aws", data:{}, status:"success", toolErrors:[] }]));
});'
```
Expected: `{ ungrounded: [ "- ECS collector application logs ... not permitted ..." ] }` (exactly the IAM bullet; not the SQL or CloudWatch bullets).

- [ ] **Step 3: Push + open PR (ready for review, never draft)**

```bash
git push -u origin claude/sharp-mccarthy-f7c622
gh pr create --title "SIO-1013: ground incident-report gaps + cap unverified blockers + reconcile IAM drift" --body "$(cat <<'EOF'
## Summary
The 2026-06-23 BindPlane incident report fabricated an IAM logs-access gap. Verified against live AWS: the DevOpsAgentReadOnly role (policy v6) already grants logs:DescribeLogGroups + StartQuery on /ecs/*, and RoleLastUsed was 35 days stale so no logs tool was ever called.

- Unit 1/2: detectUngroundedBlockers + rewriteUngroundedBlockers ground permission-denial gaps in observed auth toolErrors; ungrounded claims are rewritten to honest text and cap confidence to 0.59.
- Unit 3: align repo IAM policy file + setup script to the live deployed DevOpsAgentReadOnlyPolicy (no production IAM mutation).

Spec: docs/superpowers/specs/2026-06-23-grounded-gaps-and-confidence-design.md
Linear: https://linear.app/siobytes/issue/SIO-1013

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Move SIO-1013 to In Review** (not Done — Done requires explicit user approval).

---

## Self-Review notes

- **Spec coverage:** Goal 1 → Tasks 1-2; Goal 2 → Task 3; Goal 3 → Task 4. All covered.
- **Type consistency:** `detectUngroundedBlockers(answer, results)` and `rewriteUngroundedBlockers(answer, ungrounded)` signatures are used identically in Tasks 1-3. `ToolError.category === "auth"` matches the live enum at agent-state.ts:11.
- **Live-verified premises:** policy v6 statements, `DevOpsAgentReadOnlyPolicy` is the only/attached policy, `wrap.ts:82` advice string — all confirmed before writing this plan.
- **Out of scope (carried from spec):** re-running the incident live; reworking the SIO-709 bullet-count cap; any prod IAM mutation. NOTE the latent observation that the SIO-709 bullet cap did not fire on the real 3-bullet report — flagged for the implementer to glance at but not in a task.
