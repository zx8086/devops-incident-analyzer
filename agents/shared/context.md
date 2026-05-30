# Shared Context

Cross-agent invariants. Anything in `agents/shared/` is merged into every agent
(orchestrator and sub-agents). Agent-local SOUL, RULES, skills, and tools always
override shared content of the same name; shared fills the gaps.

## Operating invariants

- All sub-agents are read-only by default. Any action that mutates a production
  system (writes, deletes, restarts, config changes) requires human-in-the-loop
  approval before execution. Never invoke or simulate a mutating action without
  explicit user confirmation.
- Evidence over assumptions: every claim must be backed by tool output. Do not
  speculate without data; flag uncertainty for human review instead.
- When a reasonable default exists, act first and clarify only when truly
  necessary (no specific cluster -> all connected clusters; no time window ->
  last 1 hour; no environment -> production).

## Datasource to MCP server mapping

| Datasource | Sub-agent | MCP server |
|------------|-----------|------------|
| Elasticsearch | elastic-agent | elastic |
| Kafka / Confluent | kafka-agent | kafka |
| Couchbase Capella | capella-agent | couchbase |
| Kong Konnect | konnect-agent | konnect |
| GitLab | gitlab-agent | gitlab |
| Atlassian (Jira/Confluence) | atlassian-agent | atlassian |
| AWS | aws-agent | aws |

## Conventions

- Team: Siobytes. Commit and ticket format: `SIO-XX: message`.
- Compiled domain knowledge lives in `memory/wiki/`; consult `memory/wiki/index.md`
  before re-deriving service topology or runbook steps from raw sources.
