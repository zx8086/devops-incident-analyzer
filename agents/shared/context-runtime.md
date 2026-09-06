# Shared Context (analyzer runtime)

Analyzer runtime facts merged into every in-process agent after the portable
context above. Never exported to a Pi persona (SIO-1649): spokes have no MCP
servers and no wiki.

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

## Conventions (analyzer runtime)

- Compiled domain knowledge lives in `memory/wiki/`; consult `memory/wiki/index.md`
  before re-deriving service topology or runbook steps from raw sources.
