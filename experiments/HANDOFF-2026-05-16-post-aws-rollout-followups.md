# Handover — Post AWS-datasource rollout follow-ups

**Date:** 2026-05-16
**Repo state:** `main` at `2bc8381` — `SIO-767: AgentCore proxy config isolation (#96)`
**SIO-756 epic:** Done (5 phases + post-launch hardening all merged)
**Open follow-ups:** 6 issues across the DevOps Incident Analyzer project (Siobytes team)

This document is self-contained enough to pick up any of the open follow-ups without needing to re-read the AWS-datasource session history. Each section names the issue, the discovery context, the suggested approach, and the related code paths.

---

## Context: how these issues came to be

The 5-phase AWS datasource rollout (SIO-756) added a new datasource to the DevOps Incident Analyzer:

| Phase | PR | Linear | What it shipped |
|---|---|---|---|
| 1 — IAM scaffolding | #91 | SIO-757 | `DevOpsAgentReadOnly` IAM role + 12-statement read-only policy in account 356994971776 |
| 2 — MCP package | #92 | SIO-758 | `packages/mcp-server-aws/` native TypeScript MCP server with 39 tools |
| 3 — AgentCore deploy | #93 | SIO-759 | Deployed runtime `aws_mcp_server-57wIOB35U1` + 7 pre-existing `deploy.sh` bugs fixed |
| 4 — Agent integration | #94 | SIO-760 | `aws-agent` sub-agent wired into supervisor fan-out |
| 5 — Correlation rules | #95 | SIO-761 | 3 prose-matching rules for ecs-degraded / cloudwatch-alarm / kafka-broker-timeout |
| Post-launch hardening | #96 | SIO-767 | `startAgentCoreProxy(config)` refactor — per-handle creds cache, no env-var fallback footgun |

The follow-ups in this document are bugs/gaps surfaced during that work. Each phase's spec and plan live at `docs/superpowers/{specs,plans}/2026-05-15-aws-datasource-phase-*.md` (and `2026-05-16-agentcore-proxy-config-isolation.md` for the SIO-767 refactor) — read those for full architectural context before tackling a related follow-up.

---

## SIO-762 — Fix `mcp-server-elastic` `langsmith/traceable` typecheck failure

**Priority:** Medium · **State:** Todo · **Estimated:** ~30 min

### Problem

`packages/mcp-server-elastic/src/utils/notifications.ts:5` imports `langsmith/traceable` but `langsmith` is not declared as a direct dependency of `mcp-server-elastic`. The import only resolves transitively when bun hoists the dep from `@devops-agent/agent` into the right node_modules location — which it doesn't reliably do (worktree-dependent).

The failure has surfaced repeatedly in Phases 3, 4, 5, and SIO-767. Every PR's CI flagged it; every PR acknowledged it as pre-existing and out of scope.

### Origin

Phase 2 (SIO-758) escape — the `langsmith/traceable` import was added without a corresponding entry in `packages/mcp-server-elastic/package.json`.

### Fix

1. Open `packages/mcp-server-elastic/package.json`.
2. Add `"langsmith": "catalog:"` to `dependencies` (the workspace uses bun's catalog feature for shared version pins). If the catalog entry doesn't exist, fall back to `"^0.6.3"` matching the version in `packages/agent/package.json`.
3. Run `bun install` from the repo root.
4. Verify:
   ```bash
   bun run --filter @devops-agent/mcp-server-elastic typecheck
   # Expected: Exited with code 0
   ```
5. Run a full project typecheck to confirm nothing else broke:
   ```bash
   bun run typecheck
   ```

### Verification on a fresh worktree

The bug is reproducible only when `node_modules` haven't hoisted `langsmith` to the right location. To prove the fix works:

```bash
git worktree add /tmp/test-elastic-deps -b test-elastic-deps main
cd /tmp/test-elastic-deps
bun install
bun run --filter @devops-agent/mcp-server-elastic typecheck
# Expected: Exited with code 0
```

If typecheck still fails, the version pin needs adjusting. Check what `@devops-agent/agent` is using.

### Related memory notes

- `reference_bun_hot_does_not_reresolve_modules` — related transitive-dep gotcha
- `reference_first_deploy_to_fresh_account_bugs` — Phase 3 surfaced this and 6 other dormant bugs
- `feedback_verbatim_plan_code_has_bugs` — Phase 2 escapes need spec + biome review before merge

---

## SIO-763 — Fix `engine.agentToDataSourceId` `capella-agent` mapping

**Priority:** Low · **State:** Todo · **Estimated:** ~1 hour

### Problem

`packages/agent/src/correlation/engine.ts:54` derives the datasource ID from a `requiredAgent` value via naive regex:

```typescript
function agentToDataSourceId(agent: string): string {
	return agent.replace(/-agent$/, "");
}
```

This is correct for `elastic-agent → elastic`, `kafka-agent → kafka`, `aws-agent → aws`. But it produces `capella-agent → capella` instead of `couchbase`, which is the actual `DataSourceId` constant.

### Impact today

Low — no existing correlation rule names `capella-agent` as its `requiredAgent`. The bug is latent.

### Impact if not fixed

Any future correlation rule that wants to name capella-agent as the required agent will silently route to a non-existent `capella` datasource, and the `alreadyCovered` idempotency check will misfire. Phase 5's `aws-agent` only worked correctly because its name matches its datasource ID exactly.

### Suggested fix

Replace the regex with an explicit map. The map approach is more readable and explicit:

```typescript
const AGENT_TO_DATASOURCE: Record<string, string> = {
	"elastic-agent": "elastic",
	"kafka-agent": "kafka",
	"capella-agent": "couchbase",
	"konnect-agent": "konnect",
	"gitlab-agent": "gitlab",
	"atlassian-agent": "atlassian",
	"aws-agent": "aws",
};

function agentToDataSourceId(agent: string): string {
	return AGENT_TO_DATASOURCE[agent] ?? agent.replace(/-agent$/, "");
}
```

The fallback preserves current behavior for any agent name not in the explicit map (defensive).

### Tests

Add a unit test file `packages/agent/src/correlation/engine.test.ts` (one doesn't exist yet):

```typescript
import { describe, expect, test } from "bun:test";
// agentToDataSourceId is currently private. Either export it OR test through
// the evaluate() function with rules that name each agent and assert the
// dataSourceId derivation via the resulting alreadyCovered logic.

describe("agentToDataSourceId", () => {
	test("capella-agent maps to couchbase", () => {
		expect(agentToDataSourceId("capella-agent")).toBe("couchbase");
	});

	test("aws-agent maps to aws", () => {
		expect(agentToDataSourceId("aws-agent")).toBe("aws");
	});

	test("elastic-agent maps to elastic", () => {
		expect(agentToDataSourceId("elastic-agent")).toBe("elastic");
	});

	test("kafka-agent maps to kafka", () => {
		expect(agentToDataSourceId("kafka-agent")).toBe("kafka");
	});

	test("konnect-agent maps to konnect", () => {
		expect(agentToDataSourceId("konnect-agent")).toBe("konnect");
	});

	test("gitlab-agent maps to gitlab", () => {
		expect(agentToDataSourceId("gitlab-agent")).toBe("gitlab");
	});

	test("atlassian-agent maps to atlassian", () => {
		expect(agentToDataSourceId("atlassian-agent")).toBe("atlassian");
	});
});
```

Export `agentToDataSourceId` from `engine.ts` to enable direct testing. The existing private status is incidental.

### References

- Discovered during Phase 5 plan-writing (SIO-761). Acknowledged in the spec but explicitly out of scope to keep Phase 5 focused on adding rules.
- `packages/agent/src/correlation/engine.ts:54` — current naive regex
- `packages/shared/src/datasource.ts:46` — canonical `DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian", "aws"]`

---

## SIO-764 — Sub-agent structured-data emission (epic)

**Priority:** Medium · **State:** Backlog · **Estimated:** multi-task epic, brainstorm first

### Problem

Sub-agents currently emit findings as a prose string in `DataSourceResult.data`, not as a structured object. The correlation framework was originally designed (per SIO-681) to read structured fields like `result.data.consumerGroups[].state === "Empty"`, so several rules in `correlationRules` are **dormant against production traffic**:

- `kafka-empty-or-dead-groups`
- `kafka-significant-lag`
- `kafka-dlq-growth`
- `kafka-tool-failures`
- `gitlab-deploy-vs-datastore-runtime` (per the SIO-712 comment in `rules.ts`)

Comments in `packages/agent/src/correlation/rules.ts:36-38` and `:390-395` explicitly call this out:

> "This is the production signal -- unlike getKafkaData which expects structured fields that today's sub-agents do not emit"
>
> "Structured sub-agent output is the unblocking work; not in scope"

### Impact

Dormant rules fire only in tests that hand-construct structured `result.data`. In production they're inert. The SIO-681 enforcement framework's coverage is narrower than the rule count suggests — only the prose-matching rules (SIO-717, SIO-723, SIO-742, SIO-761/Phase 5) actually fire.

### Why this is an epic, not a single ticket

This touches every sub-agent's prompt template, the `DataSourceResult` schema in `packages/shared/src/agent-state.ts`, and every dormant rule. Decompose into at least 6 sub-tasks via brainstorming:

1. **Define a `StructuredFinding` schema per data source.** Each sub-agent emits both the prose summary AND a structured `findings` array. Schema is per-domain (kafka has consumer groups; aws has alarms; couchbase has slow queries; etc.).
2. **Update sub-agent prompts** to produce the structured output alongside prose. The aws-agent's SOUL.md added in Phase 4 (#94) already describes the expected outputs in narrative form — formalize as JSON-schema.
3. **Update `DataSourceResult.data` schema** to support `{ prose, findings }` or migrate to the structured side entirely. Decision: parallel emission first (additive), migrate later (breaking).
4. **Migrate dormant rules** from prose-matching to structured-data reading. Each rule's regex becomes a structured-field lookup.
5. **Migrate live rules** (SIO-717/742/761) to prefer structured signals when available, falling back to prose for backward compat during the transition.
6. **Update tests** across the affected rules — most existing tests hand-construct mock states; those can switch from prose to structured.

### Suggested first step

Brainstorm the epic via `superpowers:brainstorming`. Don't tackle it as a single PR — likely 4–6 PRs over a couple weeks. The first PR defines the schemas; subsequent PRs migrate one rule family at a time.

### Why deferred from prior phases

Phase 5 (SIO-761) shipped 3 prose-matching rules from day one rather than waiting for structured data. Pragmatic — got correlation working without blocking on infrastructure work. But every new rule is implicitly a workaround for this gap.

### Related code

- `packages/agent/src/correlation/rules.ts` — the rules file with both live (prose-matching) and dormant (structured-data) entries
- `packages/shared/src/agent-state.ts:30` — `DataSourceResultSchema` Zod definition with `data: z.unknown()`
- `packages/agent/src/sub-agent.ts:301` — where sub-agent prose ends up in `result.data`

---

## SIO-765 — AWS-specific runbooks for incident-analyzer knowledge base

**Priority:** Medium · **State:** Todo · **Estimated:** ~half day

### Problem

`agents/incident-analyzer/knowledge/runbooks/` contains operational guidance the supervisor uses via the `selectRunbooks` node (see `packages/agent/src/runbook-selector.ts`). Existing runbooks cover Kafka, Elastic, and Couchbase incident shapes:

- `kafka-consumer-lag.md`
- `msk-iam-permissions.md`
- (others — list via `ls agents/incident-analyzer/knowledge/runbooks/`)

No runbooks exist yet for AWS-specific incident patterns. The aws-agent is wired in (Phase 4) and Phase 5 correlation rules ship, but the supervisor has no AWS runbooks to lean on when classifying an AWS-shaped query.

### Suggested initial set (4 runbooks)

Mirror the existing `kafka-consumer-lag.md` structure: 10 numbered steps, explicit tool sequence, error-handling guidance.

1. **`aws-ecs-task-failures.md`** — ECS service degraded, runningCount < desiredCount.
   - Step 1: `aws_ecs_describe_services` (filter to failing service)
   - Step 2: `aws_ecs_describe_tasks` (failing task IDs)
   - Step 3: `aws_logs_describe_log_groups` (find the service's log group)
   - Step 4: `aws_logs_start_query` + `aws_logs_get_query_results` (Insights query for errors)
   - Cross-reference SIO-761's `aws-ecs-degraded-needs-elastic-traces` rule

2. **`aws-cloudwatch-alarm-triage.md`** — Interpreting CloudWatch alarm state.
   - What each `StateValue` means (OK / ALARM / INSUFFICIENT_DATA)
   - When to escalate to AWS Health events
   - Cross-reference SIO-761's `aws-cloudwatch-anomaly-needs-kafka-lag` rule (Kafka/MSK-related alarms)

3. **`aws-iam-permission-troubleshooting.md`** — Interpreting `iam-permission-missing` errors from the MCP server.
   - The error mapper in `packages/mcp-server-aws/src/tools/wrap.ts` classifies AWS errors; `iam-permission-missing` includes the failing action in `error.advice`
   - How to update `DevOpsAgentReadOnlyPolicy` safely
   - Reference Phase 1 / SIO-757 (the role's creation + 12-statement policy)

4. **`aws-msk-broker-unreachable.md`** — Cross-references SIO-761's `kafka-broker-timeout-needs-aws-metrics` rule.
   - Step 1: `aws_cloudwatch_describe_alarms` (MSK-related)
   - Step 2: `aws_ec2_describe_instances` (broker instance health)
   - Step 3: `aws_ec2_describe_security_groups` (recent rule changes)
   - Step 4: Cross-reference `msk-iam-permissions.md` for auth-related causes

### Out of scope (later)

- LangSmith eval dataset for AWS runbook effectiveness (separate ticket)
- Cross-runbook references between the four (sequence after the basics ship)

### Discovered

Phase 5 (SIO-761) merged with correlation rules live but no AWS runbooks for the supervisor's runbook-selection layer. The supervisor currently has no AWS knowledge to pair with the rules.

### Related code + docs

- `packages/agent/src/runbook-selector.ts` — the LLM-driven selector node
- `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md` — reference template (the most production-validated runbook)
- `agents/incident-analyzer/agents/aws-agent/SOUL.md` — high-level approach (Phase 4)
- `agents/incident-analyzer/agents/aws-agent/RULES.md` — drill-down ordering for AWS services (Phase 4)

---

## SIO-766 — Wire `atlassian-agent` into supervisor fan-out

**Priority:** Low · **State:** Todo · **Estimated:** ~2 hours

### Problem

`agents/incident-analyzer/agents/atlassian-agent/` has a complete sub-agent definition (`agent.yaml`, `SOUL.md`, `RULES.md`) and `packages/mcp-server-atlassian/` is a fully built MCP server. Both `supervisor.ts` and `sub-agent.ts` `AGENT_NAMES` tables include `atlassian: "atlassian-agent"`, and `mcp-bridge.ts` wires `atlassianUrl` through.

But:

- `packages/agent/src/state.ts:18` `AgentName` union does **NOT** include `"atlassian-agent"`
- No correlation rule names `atlassian-agent` as its `requiredAgent`
- `ATLASSIAN_MCP_URL_LOCAL` env-var convention (separate from `<SERVER>_MCP_URL` for everyone else) suggests half-finished wiring
- The production URL points at `https://mcp.atlassian.com/v1/mcp` (remote, not localhost)

Net effect: atlassian fans out when entity extraction names "atlassian", but has no role in the SIO-681 correlation framework. The `AgentName` type-level guarantee is missing.

### Suggested tasks

1. **Add `"atlassian-agent"` to `AgentName` union** in `packages/agent/src/state.ts`. This is a one-line change that closes a type-safety gap.

2. **Standardize the env-var name.** Pick one of:
   - `ATLASSIAN_MCP_URL` (matches the rest: `KAFKA_MCP_URL`, `ELASTIC_MCP_URL`, etc.)
   - `ATLASSIAN_MCP_URL_LOCAL` (current, unique to atlassian)

   Recommendation: rename to `ATLASSIAN_MCP_URL`. Update `apps/web/src/lib/server/agent.ts`, `apps/web/src/routes/api/datasources/+server.ts`, and `.env.example` to match.

3. **Decide on correlation rules.** Brainstorm whether atlassian-agent needs any. Possible patterns:
   - "Deployment blocked by Jira ticket in `Wait For Customer`" — gitlab-agent observes a stalled MR, fan out to atlassian-agent to check linked Jira state
   - "Confluence page changed shortly before incident" — when an incident starts shortly after a runbook page edit, surface the diff

   These are speculative. Spec before implementing.

4. **Update the wiring test.** Either extend `packages/agent/src/wiring-aws.test.ts` (Phase 4's test for the AWS plumbing) or create `wiring-all.test.ts` that asserts every sub-agent is plumbed through every layer:
   - `DATA_SOURCE_IDS` (in `@devops-agent/shared`)
   - `AgentName` union (in `state.ts`)
   - `AGENT_NAMES` (in `supervisor.ts` AND `sub-agent.ts`)
   - `DATASOURCE_TO_MCP_SERVER` (in `mcp-bridge.ts`)

### Why deferred from Phase 4

Phase 4's spec (SIO-760) explicitly listed atlassian-agent wiring as out of scope — the goal was AWS, not tidy-up of other partial integrations. Acknowledged then, filed now.

### Related code

- `packages/agent/src/state.ts:18` — `AgentName` union (currently missing `"atlassian-agent"`)
- `apps/web/src/lib/server/agent.ts:46` — reads `process.env.ATLASSIAN_MCP_URL_LOCAL`
- `apps/web/src/routes/api/datasources/+server.ts` — env-presence check + mapping
- `packages/agent/src/wiring-aws.test.ts` — Phase 4 test pattern (5 unit asserts)

---

## SIO-768 — Aggregator fabricates timestamps not present in tool output

**Priority:** Medium · **State:** Todo · **Estimated:** investigation first, then targeted fix

### Problem

During SIO-767 manual validation (real `bun run dev` run, query "How is my AWS landscape?"), the validator flagged:

```
Validation passed with warnings
warnings: [
  "Datasource kafka was queried but not referenced in the answer",
  "Potential fabricated timestamps: 2026-05-16T07:54:00, 2026-05-15T22:48:00,
   2025-10-18T21:13:00, 2026-05-15T22:54:00, 2026-05-15T22:48:00, 2025-10-18T21:13:00"
]
```

The `2025-10-18T21:13:00` timestamp is the smoking gun — 7 months in the past from "now" (2026-05-16) and not in any tool output from the run. The other timestamps cluster around "now-ish" but the validator couldn't trace them to specific tool result fields either.

### Reproduction

- Query: `"How is my AWS landscape ?"` (UI-selected: aws only)
- 15 tool calls observed (cloudformation/ec2/ecs/lambda/sns/dynamodb/cloudwatch/health/elasticache/config/logs), all returned 200 OK through the SigV4 proxy
- Aggregator (model unconfirmed — check `packages/agent/src/aggregator.ts`) consumed the 5876-byte aws-agent prose summary and produced a 5594-byte answer
- The validator's timestamp-fabrication check (see `packages/agent/src/validator.ts`) found 6 ISO-8601-shaped timestamps in the answer that didn't appear in any sub-agent result

### Why it matters

The validator currently treats fabricated timestamps as a **warning** (not a hard fail). For incident analysis this is dangerous:

- An operator reading "the alarm fired at 2025-10-18T21:13:00" would correlate against logs at that timestamp — and find nothing, because the timestamp doesn't exist
- A fabricated future timestamp could mask a real timing signal (e.g., "the EC2 instance stopped at 2026-05-15T22:48:00" when it actually stopped weeks earlier)

The `Validation passed with warnings` state still lets the answer through to the UI. Warnings are not currently surfaced in the chat response.

### Suggested investigation

1. **Identify where the timestamps come from.** Likely candidates:
   - **Aggregator LLM hallucination** (most likely — a gpt-4o-mini-class model fills in plausible-looking timestamps when its prose template asks for "the alarm fired at X" but X wasn't provided)
   - **aws-agent sub-agent prose includes timestamps that the validator misses** (false positive in validation — different ISO formats, slight precision differences)
   - **LangSmith retry / stale context bleed**: an older response from a previous turn bleeding into this turn's context (possible if `investigationFocus` is stale; see SIO-751)

2. **Inspect LangSmith trace** for the run (project: `devops-incident-analyzer`, classify → normalize → entityExtractor → aws-agent → aggregator chain). The aggregator's LLM input + output should reveal whether the timestamps were in the prompt or invented.

3. **Decide validator response:** should fabricated-timestamp warnings escalate to **fail** (forcing a re-aggregation) or **cap confidence** (like SIO-681 does for missing-data gaps at 0.59)? Today it's a warning that doesn't gate.

### Suggested fix shapes (depending on root cause)

**If aggregator hallucination:**
- Tighten the aggregator prompt to forbid inventing timestamps (only quote them verbatim from sub-agent prose, never paraphrase)
- Add a fabricated-timestamp confidence cap in `confidence-gate.ts` (mirrors the SIO-681 missing-data cap)

**If validator false positive:**
- Widen the validator's timestamp-match logic to handle near-duplicate strings (the aws-agent's prose might quote `2026-05-15T22:48` and the aggregator paraphrases to `2026-05-15T22:48:00` — close enough)

**If stale context bleed:**
- Validate that `investigationFocus` is properly reset between turns when the topic shifts (SIO-751)
- Add a regression test that runs two turns with different focuses and asserts the aggregator's answer doesn't contain timestamps from turn 1 when turn 2 has no overlap

### Related code

- `packages/agent/src/validator.ts` — the fabricated-timestamp check
- `packages/agent/src/aggregator.ts` — the LLM call whose output is being validated
- `packages/agent/src/confidence-gate.ts` — where a fabricated-timestamp cap would live (mirror of SIO-681's gaps-bullet cap)

### Discovered

SIO-767 manual validation (2026-05-16). Real AWS query, all 15 tool calls succeeded, all data was present — yet the aggregator produced 6 timestamps that don't trace to any source.

---

## Priority sequencing — my recommendation

If you're picking these up one at a time, this order minimizes blast radius and maximizes feedback signal:

1. **SIO-762** (~30 min) — fix the persistent CI noise from the elastic typecheck failure. Smallest scope, biggest reduction in PR-review distraction. Do this first.

2. **SIO-768** (investigate first, ~half day total) — the timestamp-fabrication is the most operationally dangerous issue. Inspect LangSmith for the SIO-767-validation run first; the root cause determines the fix shape. Spec before implementing.

3. **SIO-765** (~half day) — write the four AWS runbooks. Makes the aws-agent + Phase 5 rules actually useful to the supervisor's `selectRunbooks` node.

4. **SIO-763** (~1 hour) — capella-agent → couchbase mapping fix. Latent today but a footgun for any future couchbase-targeted correlation rule.

5. **SIO-766** (~2 hours) — finish wiring atlassian-agent. Half-done integration that costs less to close than leave open.

6. **SIO-764** (epic, brainstorm first) — sub-agent structured-data emission. Largest scope; deserves its own brainstorming pass before estimation. Don't start until you have time to commit to the multi-PR sequence.

---

## Workflow notes

Each follow-up should:

1. **Get a worktree.** Use `superpowers:using-git-worktrees`:
   ```bash
   git worktree add ../devops-incident-analyzer-sio-<num> -b sio-<num>-<slug> main
   cd ../devops-incident-analyzer-sio-<num>
   bun install
   ```
2. **Set the Linear issue to "In Progress"** before any code lands.
3. **Brainstorm + spec + plan** for anything non-trivial (SIO-764 epic, SIO-765 runbooks, SIO-768 investigation). Skip brainstorming for trivial fixes (SIO-762 one-line dep add).
4. **Push docs to main first** (specs and plans are doc-only, push directly per `feedback_handoff_docs_main_branch` memory).
5. **Subagent-driven execution** for the implementation (`superpowers:subagent-driven-development`).
6. **Move Linear to "In Review"** when PR opens. Never set to "Done" without user approval (per CLAUDE.md).
7. **After merge:** clean up the worktree (`git worktree remove --force`) and delete the local branch.

---

## Important memory notes referenced

- `reference_first_deploy_to_fresh_account_bugs` — Phase 3 found 7 dormant bugs together; pattern of bug-discovery during manual validation
- `feedback_verbatim_plan_code_has_bugs` — review verbatim spec code with biome before committing
- `reference_supervisor_send_shape` — `supervise()` and `enforceCorrelationsRouter` dispatch `Send("queryDataSource", {currentDataSource: id})`, not `Send("<agent-name>")`. Tests assert on `s.args.currentDataSource`.
- `reference_bun_hot_does_not_reresolve_modules` — relevant for SIO-762 reproduction (bun hoisting depends on install state)
- `feedback_handoff_docs_main_branch` — doc-only commits go directly to main, not via PR
- `feedback_plan_authority_over_pattern` — when a reviewer flags "diverges from siblings" but the plan deliberately spec'd the divergence, defend the plan
- `reference_experiments_dir_gitignored` — handover docs in `experiments/` stay local-only

---

## Quick reference: files most often touched

| File | What it does |
|---|---|
| `packages/agent/src/correlation/rules.ts` | All correlation rules |
| `packages/agent/src/correlation/engine.ts` | Engine + `agentToDataSourceId` (SIO-763) |
| `packages/agent/src/state.ts` | `AgentName` union, full `AgentState` |
| `packages/agent/src/supervisor.ts` | `AGENT_NAMES` table + dispatch logic |
| `packages/agent/src/sub-agent.ts` | Second `AGENT_NAMES` table + `queryDataSource` |
| `packages/agent/src/mcp-bridge.ts` | `DATASOURCE_TO_MCP_SERVER` + `McpClientConfig` |
| `packages/agent/src/aggregator.ts` | Aggregator LLM call (SIO-768 root cause likely here) |
| `packages/agent/src/validator.ts` | Validation checks including fabricated timestamps |
| `packages/agent/src/confidence-gate.ts` | HITL threshold + caps (SIO-768 fix likely here) |
| `packages/shared/src/datasource.ts` | `DATA_SOURCE_IDS` canonical list |
| `packages/shared/src/agent-state.ts` | `DataSourceResultSchema`, `ToolErrorSchema` |
| `packages/shared/src/agentcore-proxy.ts` | SigV4 proxy (post-SIO-767 — fully refactored) |
| `apps/web/src/lib/server/agent.ts` | Agent factory + MCP URL wiring |
| `apps/web/src/routes/api/datasources/+server.ts` | Available-datasources endpoint |
| `apps/web/src/lib/components/DataSourceSelector.svelte` | UI dropdown labels |

End of handover.
