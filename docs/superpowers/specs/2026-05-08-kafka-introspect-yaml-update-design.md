# Spec: kafka-introspect.yaml — full coverage for SIO-680/682 surface

**Date:** 2026-05-08
**Tickets:** reuses SIO-680, SIO-682 (no new Linear issue per memory rule — gitagent definition is part of the same delivery as the MCP tools).

## Context

SIO-680 added Kafka Connect to the Kafka MCP server. SIO-682 added Confluent Platform write tooling: 5 Kafka Connect write/destructive tools, 7 Schema Registry write/destructive tools (`sr_*` prefix), and 9 REST Proxy tools. The MCP server now registers 15 base + up to 40 gated tools (15-55 range).

The orchestrator's curated action map at `agents/incident-analyzer/tools/kafka-introspect.yaml` predates both tickets. It still claims `version: 1.0.0`, declares `read_only: true`, and maps only the 30 pre-SIO-680 tools. As a result:

- The kafka-agent's tier-1 action selection cannot resolve any Connect/REST Proxy/sr_* tool — those fall through to tier-2 (all curated tools) or tier-3 (all MCP tools, capped at 25), losing the precision the action map is meant to provide.
- The YAML's `read_only: true` annotation is wrong by intent now: SIO-682 deliberately ships destructive tooling, gated at the MCP and at the agent.
- `docs/development/action-tool-maps.md:172` describes the YAML as "8 categories, 15 base + 15 optional tools", which is a doc-vs-YAML drift that should be fixed in the same change.

## Goal

Update `agents/incident-analyzer/tools/kafka-introspect.yaml` so its `action_tool_map` covers all 55 max tools the kafka MCP can register, organized component-aligned, with honest annotations. Update the one-line YAML descriptor in `docs/development/action-tool-maps.md` in the same commit.

## Decisions (locked via brainstorming)

1. **Scope:** Full coverage including destructive tools. Runtime gating at the MCP server (`KAFKA_ALLOW_DESTRUCTIVE`) and the agent (kafka-agent SOUL/RULES) remains the enforcement layer; the YAML is the curated catalog.
2. **Action shape:** Component-aligned — each new component contributes 1-2 actions named after the component (e.g. `connect_status` for reads, `connect_management` for writes/destructive). 12 actions total (was 8).
3. **Annotations:** `read_only: false`, `requires_confirmation: true`, `version: 2.0.0` (semantic-breaking shift in tool surface).
4. **Doc drift:** Fix `docs/development/action-tool-maps.md:172` in the same commit.

## Detailed design

### File 1: `agents/incident-analyzer/tools/kafka-introspect.yaml`

**Top-level metadata changes:**

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
  # unchanged shape; only the action enum grows
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
    # consumer_group, topic, max_messages unchanged
  required: [action]
annotations:
  requires_confirmation: true
  read_only: false
  cost: low
```

**`tool_mapping.mcp_patterns`** grows to include the new prefixes (the regex fallback for tools not explicitly listed):

```yaml
tool_mapping:
  mcp_server: kafka
  mcp_patterns:
    - "kafka_*"
    - "ksql_*"
    - "sr_*"
    - "connect_*"
    - "restproxy_*"
```

**`tool_mapping.action_tool_map`** — full final shape (12 actions, 55 unique tool references with the kafka_describe_topic / kafka_get_topic_offsets / kafka_list_topics dups in describe_topic preserved as-is):

```yaml
  action_tool_map:
    # --- existing kafka-core actions, unchanged ---
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

    # --- existing Schema Registry reads (8 legacy kafka_*_schema_* tools), unchanged ---
    schema_registry:
      - kafka_list_schemas
      - kafka_get_schema
      - kafka_get_schema_versions
      - kafka_check_compatibility
      - kafka_get_schema_config
      - kafka_register_schema
      - kafka_set_schema_config
      - kafka_delete_schema_subject

    # --- NEW: SIO-682 SR writes + destructive (sr_* prefix; 7 tools) ---
    schema_management:
      - sr_register_schema
      - sr_check_compatibility
      - sr_set_compatibility
      - sr_soft_delete_subject
      - sr_soft_delete_subject_version
      - sr_hard_delete_subject
      - sr_hard_delete_subject_version

    # --- existing ksqlDB action, unchanged ---
    ksql:
      - ksql_get_server_info
      - ksql_list_streams
      - ksql_list_tables
      - ksql_list_queries
      - ksql_describe
      - ksql_run_query
      - ksql_execute_statement

    # --- NEW: SIO-680 Kafka Connect reads (4 tools) ---
    connect_status:
      - connect_get_cluster_info
      - connect_list_connectors
      - connect_get_connector_status
      - connect_get_connector_task_status

    # --- NEW: SIO-682 Kafka Connect writes + destructive (5 tools) ---
    connect_management:
      - connect_pause_connector
      - connect_resume_connector
      - connect_restart_connector
      - connect_restart_connector_task
      - connect_delete_connector

    # --- NEW: SIO-682 REST Proxy reads + writes (9 tools) ---
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

    # --- existing kafka-core writes + destructive, unchanged ---
    write_ops:
      - kafka_produce_message
      - kafka_create_topic
      - kafka_alter_topic_config
      - kafka_delete_topic
      - kafka_reset_consumer_group_offsets
```

**`related_tools`** — add one entry; existing 3 stay:

```yaml
related_tools:
  - "Use elastic-search-logs to check if consumer lag correlates with application error spikes"
  - "Use couchbase-cluster-health to check if database slowness is causing Kafka backpressure"
  - "Use konnect-api-requests to check if upstream API errors are generating DLQ messages"
  - "Use gitlab-pipeline-jobs to correlate Connect connector restarts and REST Proxy producer changes with recent deploys"
```

### File 2: `docs/development/action-tool-maps.md`

One-line table-row edit:

```diff
-| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 8 categories, 15 base + 15 optional tools |
+| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 12 categories, 15-55 tools (15 base + up to 40 gated SR + ksqlDB + Connect + REST Proxy; v2.0.0) |
```

The `30 unique tool names` claim at line 207 is inside a Tier-2 *example* block describing the fallback's behaviour — unchanged because it walks through a hypothetical YAML state, not the current one. (If we ever rewrite that walkthrough, that's a separate doc edit.)

## Tool count math

| Component | Reads | Writes | Destructive | Subtotal |
|---|---|---|---|---|
| kafka-core | 10 | 3 | 2 | 15 |
| Schema Registry (legacy + sr_*) | 8 | 3 | 4 | 15 |
| ksqlDB | 7 | — | — | 7 |
| Kafka Connect | 4 | 3 | 2 | 9 |
| REST Proxy | 3 | 6 | — | 9 |
| **Total** | **32** | **15** | **8** | **55** |

YAML coverage: 3 + 3 + 2 + 2 + 3 + 8 + 7 + 7 + 4 + 5 + 9 + 5 = 58 tool references across 12 actions. Of those 58, three are intentional dups between `topic_throughput` and `describe_topic` (`kafka_describe_topic`, `kafka_get_topic_offsets`, `kafka_list_topics`), so unique tool count = **55** — exact match with the MCP server max. To be reconfirmed during implementation by running `getAllActionToolNames()` against the new YAML and asserting `length === 55`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Annotation flip (`read_only: true → false`) breaks any UI/audit consumer reading the field | Code search confirms `read_only` annotation is read in `gitagent-bridge` schema validation only (advisory). No runtime branching observed. To verify in implementation: `grep -rn "read_only" packages/`. |
| `version: 2.0.0` bump breaks a version-pinned consumer | gitagent-bridge does not gate on version today (`packages/gitagent-bridge/src/types.ts` accepts any string). Verify by grep before bumping. |
| Sub-agent's `MAX_TOOLS_PER_AGENT = 25` truncates the catalog at tier-2 | Acceptable — the action map is designed precisely so tier-1 stays under the cap. With 12 single-purpose actions, tier-1 always returns 2-9 tools per resolved action. Tier-2 only fires if extraction returns no matching actions, which is the existing behaviour. |
| Existing `kafka_*_schema_*` legacy SR tools are deprecated by `sr_*` and the YAML now references both | Both still register in the MCP server (verified `packages/mcp-server-kafka/src/tools/schema/tools.ts:11-78`). Keeping both lets existing Linear playbooks continue to work; an eventual deprecation of `kafka_*_schema_*` is a follow-up. |

## Out of scope

- Changes to `packages/agent/` (entity extractor, sub-agent.ts) — the action catalog is pulled at runtime from the YAML; no code change needed.
- Changes to kafka-agent SOUL.md / RULES.md — the agent's own write-gating logic is enforced by `KAFKA_ALLOW_*`-aware tool selection at the MCP, not by the action map.
- Splitting into separate `kafka-introspect.yaml` (read) + `kafka-admin.yaml` (write) files — flagged but rejected; would need orchestrator wiring changes outside this scope.
- Refreshing `docs/development/action-tool-maps.md:207` example walkthrough — it's a hypothetical, not a current-state claim.
- Updating `kafka-agent/agent.yaml` if it embeds tool counts — to verify during implementation; if there's a stale `15 base + 15 optional` reference in the agent YAML, update in the same commit.

## Verification

```bash
# YAML schema validation
bun run yaml:check

# Type check (no impact expected; sanity)
bun run typecheck

# Gitagent-bridge tests — assert facadeToMcp / mcpToFacade still resolve
bun run --filter '@devops-agent/gitagent-bridge' test

# Manual: kafka-agent tier-1 should now resolve connect_status
# Spin the kafka MCP with CONNECT_ENABLED=true and ask the agent
# "what's the status of connectors on cluster X?" — entity extractor
# should emit toolActions: { kafka: ["connect_status"] }, and the
# resolved tool set should be the 4 connect_get_* tools.

# Re-run the doc-drift greps to confirm action-tool-maps.md fix landed
grep -n "8 categories\|15 base + 15 optional" docs/development/action-tool-maps.md
# expect: zero matches on line 172; the unrelated walkthrough at line 207 unchanged
```

## Commit shape

Single commit:
- `agents/incident-analyzer/tools/kafka-introspect.yaml` — full YAML rewrite.
- `docs/development/action-tool-maps.md` — one-line table-row edit.

Commit message prefix: `SIO-680,SIO-682:` (doc/definition sync, reuses originating tickets per memory rule).
