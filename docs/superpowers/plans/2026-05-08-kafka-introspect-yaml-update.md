# kafka-introspect.yaml SIO-680/682 Coverage Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `agents/incident-analyzer/tools/kafka-introspect.yaml` so its `action_tool_map` covers all 55 max tools the kafka MCP server can register (15 base + 8 SR reads + 7 ksqlDB + 4 Connect reads + 5 Connect writes/destructive + 3 SR writes + 4 SR destructive + 9 REST Proxy = 55), organized into 12 component-aligned actions with full coverage including destructive ops. Also fix the one-line stale descriptor in `docs/development/action-tool-maps.md:172`.

**Architecture:** Two-file change. The YAML is the gitagent definition consumed at orchestrator startup by `packages/gitagent-bridge` to populate the kafka-agent's curated tool catalog. Sub-agent action selection uses tier-1 (action-resolved tools), then tier-2 (`getAllActionToolNames()` returns the full curated set) — the new actions widen tier-1 reach so common Connect / REST Proxy / SR-write asks no longer fall through to tier-2 truncation. Annotation flip (`read_only: false`, `requires_confirmation: true`) and `version: 1.0.0 → 2.0.0` mark the breaking semantic shift.

**Tech Stack:** YAML (orchestrator definitions), TypeScript (Bun test), Zod (`packages/gitagent-bridge/src/types.ts` validation), `js-yaml` (loader), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-08-kafka-introspect-yaml-update-design.md` (commit `813dad0`).

---

## Task 1: Add a regression test that asserts post-update tool coverage

This test goes in *first* and *fails* against the current YAML. After Task 2 lands the YAML changes, this test passes. That's the TDD discipline for a YAML-only change: the test pins the curated catalog's exact shape so any future regression (someone deletes an action, an MCP tool gets renamed, etc.) is caught.

**Files:**
- Create: `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts`:

```typescript
// packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "./index.ts";
import { getAllActionToolNames, getAvailableActions } from "./tool-mapping.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("kafka-introspect.yaml SIO-680/682 coverage", () => {
	test("declares 12 component-aligned actions", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		const actions = getAvailableActions(kafka!);
		expect(actions).toEqual([
			"consumer_lag",
			"topic_throughput",
			"dlq_messages",
			"cluster_info",
			"describe_topic",
			"schema_registry",
			"schema_management",
			"ksql",
			"connect_status",
			"connect_management",
			"restproxy",
			"write_ops",
		]);
	});

	test("covers all 55 unique MCP tool names across the action map", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const tools = getAllActionToolNames(kafka!);
		expect(tools.length).toBe(55);
	});

	test("includes the SIO-680 Connect read tools under connect_status", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const map = kafka!.tool_mapping!.action_tool_map!;
		expect(map.connect_status).toEqual([
			"connect_get_cluster_info",
			"connect_list_connectors",
			"connect_get_connector_status",
			"connect_get_connector_task_status",
		]);
	});

	test("includes the SIO-682 Connect writes/destructive under connect_management", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const map = kafka!.tool_mapping!.action_tool_map!;
		expect(map.connect_management).toEqual([
			"connect_pause_connector",
			"connect_resume_connector",
			"connect_restart_connector",
			"connect_restart_connector_task",
			"connect_delete_connector",
		]);
	});

	test("includes the SIO-682 sr_* writes/destructive under schema_management", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const map = kafka!.tool_mapping!.action_tool_map!;
		expect(map.schema_management).toEqual([
			"sr_register_schema",
			"sr_check_compatibility",
			"sr_set_compatibility",
			"sr_soft_delete_subject",
			"sr_soft_delete_subject_version",
			"sr_hard_delete_subject",
			"sr_hard_delete_subject_version",
		]);
	});

	test("includes all 9 REST Proxy tools under restproxy", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const map = kafka!.tool_mapping!.action_tool_map!;
		expect(map.restproxy).toEqual([
			"restproxy_list_topics",
			"restproxy_get_topic",
			"restproxy_get_partitions",
			"restproxy_produce",
			"restproxy_create_consumer",
			"restproxy_subscribe",
			"restproxy_consume",
			"restproxy_commit_offsets",
			"restproxy_delete_consumer",
		]);
	});

	test("declares version 2.0.0 and honest annotations", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka!.version).toBe("2.0.0");
		expect(kafka!.annotations?.read_only).toBe(false);
		expect(kafka!.annotations?.requires_confirmation).toBe(true);
	});

	test("declares the new mcp_patterns covering sr_*, connect_*, restproxy_*", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka!.tool_mapping!.mcp_patterns).toEqual([
			"kafka_*",
			"ksql_*",
			"sr_*",
			"connect_*",
			"restproxy_*",
		]);
	});

	test("preserves the existing action enum entries (no regression)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		const map = kafka!.tool_mapping!.action_tool_map!;
		expect(map.consumer_lag).toContain("kafka_list_consumer_groups");
		expect(map.topic_throughput).toContain("kafka_describe_topic");
		expect(map.schema_registry).toContain("kafka_list_schemas");
		expect(map.ksql).toContain("ksql_run_query");
		expect(map.write_ops).toContain("kafka_delete_topic");
	});
});
```

- [ ] **Step 2: Run the test to confirm it fails against the current YAML**

```bash
bun test packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
```

Expected: 9 failures. The first one will be `declares 12 component-aligned actions` reporting the current YAML has 8 actions. The 55-count test reports the current count (~30 unique). This is the failing baseline that proves the test is wired up.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: regression test for kafka-introspect.yaml full coverage

9 assertions pinning the post-SIO-680/682 curated tool catalog: 12
actions, 55 unique tool names, SIO-680 Connect reads under
connect_status, SIO-682 Connect writes/destructive under
connect_management, sr_* writes/destructive under schema_management,
9 REST Proxy tools under restproxy, version 2.0.0, honest annotations,
mcp_patterns covering the new prefixes, and existing kafka-core /
ksql / write_ops entries preserved.

Test fails until the YAML rewrite in the next commit lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rewrite kafka-introspect.yaml

**Files:**
- Modify: `agents/incident-analyzer/tools/kafka-introspect.yaml` (full rewrite)

- [ ] **Step 1: Replace the YAML with the post-SIO-680/682 version**

Open `agents/incident-analyzer/tools/kafka-introspect.yaml` and replace its full contents with:

```yaml
name: kafka-introspect
description: >
  Inspect and (when enabled) manage Kafka cluster state including consumer
  group lag, topic throughput, dead-letter queue contents, schema registry,
  ksqlDB, Kafka Connect, and REST Proxy. Write and destructive tools are
  gated at the MCP server by KAFKA_ALLOW_WRITES / KAFKA_ALLOW_DESTRUCTIVE
  and at the kafka-agent by SOUL.md / RULES.md.
version: 2.0.0
input_schema:
  type: object
  properties:
    action:
      type: string
      enum:
        - consumer_lag
        - topic_throughput
        - dlq_messages
        - cluster_info
        - describe_topic
        - schema_registry
        - schema_management
        - ksql
        - connect_status
        - connect_management
        - restproxy
        - write_ops
      description: Type of Kafka inspection or management operation
    consumer_group:
      type: string
      description: Consumer group ID (required for consumer_lag)
    topic:
      type: string
      description: Topic name (required for topic_throughput, dlq_messages, describe_topic)
    max_messages:
      type: integer
      default: 10
      description: Maximum messages to return for DLQ inspection
  required: [action]
output_schema:
  type: object
  properties:
    action: { type: string }
    data: { type: object }
    timestamp: { type: string }
annotations:
  requires_confirmation: true
  read_only: false
  cost: low

prompt_template: >
  Inspect Kafka cluster state for incident diagnosis.
  {{#if datasources}}Available data sources: {{datasources}}.{{/if}}
  {{#if compliance_tier}}Compliance tier: {{compliance_tier}} -- all queries are logged.{{/if}}

related_tools:
  - "Use elastic-search-logs to check if consumer lag correlates with application error spikes"
  - "Use couchbase-cluster-health to check if database slowness is causing Kafka backpressure"
  - "Use konnect-api-requests to check if upstream API errors are generating DLQ messages"
  - "Use gitlab-pipeline-jobs to correlate Connect connector restarts and REST Proxy producer changes with recent deploys"

tool_mapping:
  mcp_server: kafka
  mcp_patterns:
    - "kafka_*"
    - "ksql_*"
    - "sr_*"
    - "connect_*"
    - "restproxy_*"
  action_tool_map:
    consumer_lag:
      - kafka_list_consumer_groups
      - kafka_describe_consumer_group
      - kafka_get_consumer_group_lag
    topic_throughput:
      - kafka_list_topics
      - kafka_describe_topic
      - kafka_get_topic_offsets
    dlq_messages:
      - kafka_consume_messages
      - kafka_get_message_by_offset
    cluster_info:
      - kafka_get_cluster_info
      - kafka_describe_cluster
    describe_topic:
      - kafka_describe_topic
      - kafka_get_topic_offsets
      - kafka_list_topics
    schema_registry:
      - kafka_list_schemas
      - kafka_get_schema
      - kafka_get_schema_versions
      - kafka_check_compatibility
      - kafka_get_schema_config
      - kafka_register_schema
      - kafka_set_schema_config
      - kafka_delete_schema_subject
    schema_management:
      - sr_register_schema
      - sr_check_compatibility
      - sr_set_compatibility
      - sr_soft_delete_subject
      - sr_soft_delete_subject_version
      - sr_hard_delete_subject
      - sr_hard_delete_subject_version
    ksql:
      - ksql_get_server_info
      - ksql_list_streams
      - ksql_list_tables
      - ksql_list_queries
      - ksql_describe
      - ksql_run_query
      - ksql_execute_statement
    connect_status:
      - connect_get_cluster_info
      - connect_list_connectors
      - connect_get_connector_status
      - connect_get_connector_task_status
    connect_management:
      - connect_pause_connector
      - connect_resume_connector
      - connect_restart_connector
      - connect_restart_connector_task
      - connect_delete_connector
    restproxy:
      - restproxy_list_topics
      - restproxy_get_topic
      - restproxy_get_partitions
      - restproxy_produce
      - restproxy_create_consumer
      - restproxy_subscribe
      - restproxy_consume
      - restproxy_commit_offsets
      - restproxy_delete_consumer
    write_ops:
      - kafka_produce_message
      - kafka_create_topic
      - kafka_alter_topic_config
      - kafka_delete_topic
      - kafka_reset_consumer_group_offsets
```

- [ ] **Step 2: Run yamllint**

```bash
bun run yaml:check
```

Expected: PASS — no errors. If `yamllint` reports indentation or document-start issues, match the surrounding files (`elastic-logs.yaml`, `couchbase-health.yaml`) for the canonical style. The `.yamllint.yml` at the repo root governs the rules.

- [ ] **Step 3: Run the regression test from Task 1**

```bash
bun test packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
```

Expected: PASS — all 9 assertions green. If the `length === 55` assertion fails, run this diagnostic to find the discrepancy:

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
import { getAllActionToolNames } from './packages/gitagent-bridge/src/tool-mapping.ts';
const a = loadAgent('agents/incident-analyzer');
const k = a.tools.find(t => t.name === 'kafka-introspect');
const all = getAllActionToolNames(k);
console.log('count:', all.length);
console.log('tools:', all.sort().join('\n'));
"
```

Compare the printed list to the spec's tool count math table (`docs/superpowers/specs/2026-05-08-kafka-introspect-yaml-update-design.md`). Likely a typo in a tool name — fix in the YAML, re-run.

- [ ] **Step 4: Run the existing gitagent-bridge test suite to confirm no regression**

```bash
bun run --filter '@devops-agent/gitagent-bridge' test
```

Expected: PASS — including the existing `loads all 8 tool definitions`, `kafka-introspect contains kafka_list_topics`, and runbook-validator tests. Pay attention to `runbook-validator.test.ts` — if any test was implicitly depending on the old 8-action set, it will fail with a clear assertion error and needs targeted fixing in a follow-up commit.

- [ ] **Step 5: Run the full repo typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS. The change is YAML-only, so typecheck shouldn't be affected, but the test file added in Task 1 must compile cleanly.

- [ ] **Step 6: Commit the YAML rewrite**

```bash
git add agents/incident-analyzer/tools/kafka-introspect.yaml
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: kafka-introspect.yaml v2.0.0 -- full SIO-680/682 coverage

Updates the kafka-agent's curated tool catalog to cover all 55 max
tools the kafka MCP server can register (15 base + 8 SR reads + 7
ksqlDB + 4 Connect reads + 5 Connect writes/destructive + 3 SR writes
+ 4 SR destructive + 9 REST Proxy).

Action map grows from 8 to 12 component-aligned actions:
- schema_management (NEW): 7 sr_* writes/destructive
- connect_status (NEW):    4 connect_* reads
- connect_management (NEW): 5 connect_* writes/destructive
- restproxy (NEW):         9 restproxy_* tools (3 reads + 6 writes)
- existing 8 actions unchanged: consumer_lag, topic_throughput,
  dlq_messages, cluster_info, describe_topic, schema_registry, ksql,
  write_ops

Annotation flip (read_only: true -> false, requires_confirmation:
false -> true) and version bump 1.0.0 -> 2.0.0 mark the breaking
semantic shift -- destructive tools are now part of the curated set
(runtime gating still enforced at the MCP via KAFKA_ALLOW_DESTRUCTIVE
and at the agent via SOUL/RULES).

mcp_patterns gains sr_*, connect_*, restproxy_* as the regex fallback
for tools not explicitly mapped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix the docs/development/action-tool-maps.md descriptor

**Files:**
- Modify: `docs/development/action-tool-maps.md:172`

- [ ] **Step 1: Update the table-row descriptor**

Open `docs/development/action-tool-maps.md` and change line 172 from:

```markdown
| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 8 categories, 15 base + 15 optional tools |
```

to:

```markdown
| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 12 categories, 15-55 tools (15 base + up to 40 gated SR + ksqlDB + Connect + REST Proxy; v2.0.0) |
```

- [ ] **Step 2: Verify the doc-drift grep is now clean**

```bash
grep -n "8 categories\|15 base + 15 optional" docs/development/action-tool-maps.md
```

Expected: only one match remains — line 207's "30 unique tool names from all 8 categories" inside the Tier-2 *example walkthrough*. That line is hypothetical, not a current-state claim, and is intentionally out of scope per the spec.

- [ ] **Step 3: Commit the doc fix**

```bash
git add docs/development/action-tool-maps.md
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: sync action-tool-maps.md kafka descriptor to v2.0.0

The table-row descriptor for kafka-introspect.yaml had been frozen at
"8 categories, 15 base + 15 optional tools" since before SIO-680
added Connect and SIO-682 added REST Proxy + sr_* writes/destructive.
Bumps to "12 categories, 15-55 tools" matching the YAML's new shape.

The Tier-2 example walkthrough at line 207 ("30 unique tool names
from all 8 categories") is unchanged -- it walks through a
hypothetical tier-2 fallback, not a current-state claim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final cross-check before push

- [ ] **Step 1: Re-run the full test + lint sweep**

```bash
bun run typecheck && bun run lint && bun run yaml:check && bun test packages/gitagent-bridge/
```

Expected: PASS on all four. If any step fails, stop — diagnose and fix in place rather than pushing a broken state.

- [ ] **Step 2: Inspect the three commits**

```bash
git log origin/main..HEAD --stat
```

Expected: 3 commits in this order — regression test, YAML rewrite, doc descriptor — total ~140 lines added across `kafka-introspect-coverage.test.ts` (new), `kafka-introspect.yaml` (rewrite), `action-tool-maps.md` (1 line). No other files touched.

- [ ] **Step 3: Push (await user authorization)**

The user must explicitly authorize `git push`. Do not push autonomously. When authorized:

```bash
git push origin main
```

---

## Verification (manual smoke after merge)

These are not automated and are documented for the human reviewer to run if they want to confirm end-to-end behaviour:

1. **Tier-1 resolution**: spin the kafka MCP with `CONNECT_ENABLED=true CONNECT_URL=...` and ask the agent something Connect-specific (e.g. "what's the status of connectors on cluster X?"). The kafka sub-agent should now resolve `toolActions: { kafka: ["connect_status"] }` and call the 4 `connect_get_*` tools, not fall through to the tier-2 25-tool cap.

2. **Pattern fallback**: introduce a hypothetical `sr_get_subjects_v2` tool name in the MCP that's NOT in the action map. Confirm it's still picked up via the new `sr_*` pattern in `mcp_patterns`, so the regex fallback handles tool surface drift between MCP and YAML.

3. **Annotation surface**: the gitagent-bridge schema validation in `packages/gitagent-bridge/src/types.ts:79-83` should accept the new annotation values. Existing audit-log consumers (if any) reading the `read_only` annotation will now see `false` for kafka-introspect — confirm nothing fires unintentionally.

## Out of scope

- Updating `kafka-agent/agent.yaml` or kafka-agent SOUL.md/RULES.md — write/destructive enforcement remains at the MCP and existing kafka-agent rules.
- Refactoring `docs/development/action-tool-maps.md` line 207 example walkthrough.
- Splitting `kafka-introspect.yaml` into separate read/admin YAMLs.
- Pushing to remote — last step requires explicit user authorization per repo guardrails.
