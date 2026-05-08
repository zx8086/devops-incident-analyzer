# Spec: per-action descriptions for the 5 sibling tool YAMLs

**Date:** 2026-05-09
**Tickets:** SIO-680, SIO-682 (continuation of the kafka-introspect work; reuses originating tickets per memory rule).

## Context

The kafka work (`b2bf369..d777ad6`, pushed) added `action_descriptions` as an optional field on `tool_mapping`, taught `formatActionCatalog()` to emit indented multi-line per-tool when descriptions exist, and populated all 12 actions in `kafka-introspect.yaml`. Today the entity extractor sees:

```
- kafka:
  - consumer_lag — when a consumer group shows rising or sustained message lag (...)
  - topic_throughput — when investigating producer rate (...)
- elastic: search, cluster_health, node_info, index_management, shard_analysis, ingest_pipeline, template_management, alias_management, document_ops, snapshot, diagnostics, cloud_deployment, billing
- couchbase: system_vitals, fatal_requests, slow_queries, expensive_queries, ...
- konnect: api_requests, service_config, route_config, plugin_chain, ...
- gitlab: issues, merge_requests, pipelines, search, code_analysis
- atlassian: incident_correlation, runbook_lookup, jira_query, confluence_query
```

The 5 sibling datasources still hand the LLM a bare comma-separated list. Several actions are genuinely ambiguous from the name alone:

- elastic: `cluster_health` vs `node_info` vs `shard_analysis` vs `diagnostics`; `index_management` vs `template_management` vs `alias_management`; `cloud_deployment` vs `billing`; `document_ops` (writes!).
- couchbase: `fatal_requests` vs `slow_queries` vs `expensive_queries` (failures vs latency vs cost — distinct intents).
- konnect: 3 `*_management` actions (`control_plane_management`, `consumer_management`, `portal_management`) plus `service_config`/`route_config`/`plugin_chain` layered relationships.
- gitlab: `search` (semantic? text?) and `code_analysis` (opaque without context).
- atlassian: `incident_correlation` and `runbook_lookup` are smart composers (build JQL/CQL); `jira_query` and `confluence_query` are direct passthroughs — the distinction matters for tool selection.

This spec extends the SIO-680/682 description work to the remaining 5 YAMLs so every datasource gets the same disambiguation benefit.

## Goal

Add `action_descriptions` to all 5 sibling YAMLs (39 new descriptions total) in one bulk commit. Extend the regression test (renamed from `kafka-introspect-coverage.test.ts` to `tool-yaml-coverage.test.ts`) to assert coverage for all 6 datasources. No code changes — purely YAML data + test data.

## Decisions (locked via brainstorming)

1. **Sequencing:** one bulk commit for all 5 YAMLs.
2. **Authoring:** I draft all 39 descriptions; user reviews in this spec.
3. **Test shape:** extend the existing single test file to cover all 6 datasources, parameterized by facade name.
4. **File rename:** `git mv kafka-introspect-coverage.test.ts → tool-yaml-coverage.test.ts` to reflect the broadened scope. The 10 existing kafka assertions stay in their `describe("kafka-introspect.yaml SIO-680/682 coverage", ...)` block; the 5 new sibling assertions land in a second `describe()` block in the same file.

## Detailed design

### Change 1: `agents/incident-analyzer/tools/elastic-logs.yaml` (13 descriptions)

Append `action_descriptions:` block under `tool_mapping:` (same indent as `action_tool_map:`, after it):

```yaml
  action_descriptions:
    search: when querying logs by service, time window, and search terms (the primary log-search path; covers structured queries, aggregations, and free-text)
    cluster_health: when checking cluster status, node count, shard allocation, or pending tasks at the cluster level
    node_info: when inspecting a specific node's hardware, JVM, thread pools, or per-node disk/memory usage
    index_management: when listing indices, checking index settings, mappings, stats, or rolling over an index pattern
    shard_analysis: when investigating shard distribution, allocation explain, or relocation/initialization issues
    ingest_pipeline: when reading ingest pipeline definitions or simulating pipeline execution against sample documents
    template_management: when reading or updating index/component templates (controls index settings/mappings at creation time)
    alias_management: when reading aliases, alias filters, or routing settings (cross-index views and write-target indirection)
    document_ops: when reading specific documents by ID, counting matches, or running aggregations against a known index (read-only)
    snapshot: when listing snapshot repositories or snapshots, or checking snapshot/restore status
    diagnostics: when running cluster-wide diagnostic commands (allocation explain, hot threads, pending tasks) for deep troubleshooting
    cloud_deployment: when listing or describing Elastic Cloud deployments via the v1 cloud API (read-only deployment metadata)
    billing: when checking Elastic Cloud organization or deployment billing/cost data via the v2 billing API (read-only cost reporting)
```

### Change 2: `agents/incident-analyzer/tools/couchbase-health.yaml` (8 descriptions)

```yaml
  action_descriptions:
    system_vitals: when checking cluster-wide CPU, memory, disk, and replication health (the primary cluster-state path)
    fatal_requests: when investigating queries that hit fatal errors (timeouts, OOM, malformed responses) -- not slow queries, true failures
    slow_queries: when investigating queries above the slow-query threshold by elapsed time (latency outliers, not failures)
    expensive_queries: when investigating queries with high resource cost (memory, CPU, scan size) -- can be fast OR slow
    index_analysis: when reading GSI/secondary index definitions, advisor recommendations, or index stats
    node_status: when checking individual cluster node status (services running, version, uptime) -- not cluster-wide health
    document_ops: when reading specific documents by key from a known bucket/scope/collection (read-only K/V access)
    query_execution: when running an N1QL SELECT query (read-only; the compliance layer rejects mutations)
```

### Change 3: `agents/incident-analyzer/tools/konnect-gateway.yaml` (9 descriptions)

```yaml
  action_descriptions:
    api_requests: when querying request analytics (request rates, latency percentiles, status code distribution) for a service or route over a time window
    service_config: when inspecting a Kong service definition (host, port, protocol, retries, timeouts) -- the upstream target
    route_config: when inspecting a Kong route definition (path, methods, hosts) -- the request matching layer that points at a service
    plugin_chain: when listing or inspecting plugins applied to a service, route, consumer, or globally (auth, rate-limit, transform, etc.)
    data_plane_health: when checking data plane node health, version, and connection status to the control plane
    certificate_status: when reading TLS certificates, SNIs, or certificate expiry/validity
    control_plane_management: when listing or inspecting control planes and group membership (Konnect orgs and CP groupings)
    consumer_management: when listing or inspecting Kong consumers, their credentials, or group memberships (read-only)
    portal_management: when reading developer portal configuration, published APIs, or developer registrations
```

### Change 4: `agents/incident-analyzer/tools/gitlab-api.yaml` (5 descriptions)

```yaml
  action_descriptions:
    issues: when querying GitLab issues, comments, labels, or saved views in a project
    merge_requests: when querying merge requests, their commits/diffs/pipelines/conflicts, or MR notes (the primary code-change correlation path)
    pipelines: when checking CI/CD pipeline status, jobs, or recent pipeline failures for a project
    search: when running global text or semantic search across GitLab projects (issues, MRs, commits, blobs)
    code_analysis: when reading file content, blame, commit diffs, commit listings, or repository tree (custom REST tools, not the proxied search)
```

### Change 5: `agents/incident-analyzer/tools/atlassian-api.yaml` (4 descriptions)

```yaml
  action_descriptions:
    incident_correlation: when looking for Jira incident tickets correlated with a service over a time window (composes JQL filtered by ATLASSIAN_INCIDENT_PROJECTS)
    runbook_lookup: when searching Confluence pages for service-specific runbooks or operational documentation
    jira_query: when running an explicit JQL query against Jira (direct, not the smart incident-correlation composer)
    confluence_query: when running an explicit CQL query against Confluence (direct, not the smart runbook-lookup composer)
```

### Change 6: rename + extend test file

**Step A — rename:** `git mv packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts packages/gitagent-bridge/src/tool-yaml-coverage.test.ts`. Preserves git history via rename detection. The 10 existing kafka assertions stay verbatim inside their `describe("kafka-introspect.yaml SIO-680/682 coverage", ...)` block.

**Step B — extend:** append a second `describe()` block at the bottom of the renamed file:

```typescript
describe("sibling tool YAMLs action_descriptions coverage (SIO-680/682 follow-up)", () => {
	const SIBLING_FACADES = [
		"elastic-search-logs",
		"couchbase-cluster-health",
		"konnect-api-gateway",
		"gitlab-api",
		"atlassian-api",
	] as const;

	for (const facadeName of SIBLING_FACADES) {
		test(`${facadeName} declares action_descriptions for every action_tool_map key`, () => {
			const agent = loadAgent(AGENTS_DIR);
			const tool = agent.tools.find((t) => t.name === facadeName);
			expect(tool).toBeDefined();
			if (!tool) return;
			const map = tool.tool_mapping?.action_tool_map;
			const descriptions = tool.tool_mapping?.action_descriptions;
			expect(map).toBeDefined();
			expect(descriptions).toBeDefined();
			if (!map || !descriptions) return;
			const actionKeys = Object.keys(map);
			for (const action of actionKeys) {
				expect(descriptions[action]).toBeDefined();
				expect((descriptions[action] ?? "").length).toBeGreaterThan(20);
			}
			expect(Object.keys(descriptions).length).toBe(actionKeys.length);
		});
	}
});
```

5 new tests (one per facade, generated by the for-loop). Total tests in the renamed file: 10 + 5 = 15.

## Coverage matrix

| YAML | Facade name | Actions | New descriptions |
|---|---|---|---|
| `elastic-logs.yaml` | `elastic-search-logs` | 13 | 13 |
| `couchbase-health.yaml` | `couchbase-cluster-health` | 8 | 8 |
| `konnect-gateway.yaml` | `konnect-api-gateway` | 9 | 9 |
| `gitlab-api.yaml` | `gitlab-api` | 5 | 5 |
| `atlassian-api.yaml` | `atlassian-api` | 4 | 4 |
| **Total** | | **39** | **39** |

`kafka-introspect.yaml` (12 actions) is already populated; the renamed test file's existing kafka block continues to pin those independently. Combined post-merge state: 6 datasources, 51 actions, 51 descriptions.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Description text drifts from underlying MCP tool prompts | Same as kafka work: descriptions target *action selection* (which intent picks this), not *tool execution* (how to call this). Different audiences, no overlap. |
| Inflated entity-extractor system prompt | 39 new lines × ~120 chars ≈ 4.7k chars added to the prompt (kafka added ~1.3k). Combined ~6k added. Well within typical 4-8k baseline + 200k+ context windows. Confirmed acceptable in the kafka spec. |
| One YAML's wording is wrong → bulk commit needs full rework | Spec review (this doc) catches that before implementation. Any specific wording can be flagged in spec review and rewritten before the implementation plan. |
| Renaming the test file breaks references | The file is referenced only by `bun test` glob patterns and by historical commit messages. `grep -rn "kafka-introspect-coverage" .` confirms zero source-code or CI-config references. The original file's git history follows the rename via `git log --follow`. |
| All 5 YAMLs must pass yamllint after the change | `bun run yaml:check` runs against `agents/`; the kafka YAML's `action_descriptions:` block already passes, so the same indentation pattern (4-space child entries under 2-space `action_descriptions:`) is known-good. |
| Schema's superRefine cross-field check could reject a typo | The Zod check rejects keys absent from `action_tool_map`. If a description targets a non-existent action key, the YAML load fails fast at `loadAgent()` time, which the test in §Change 6 will surface immediately. |

## Out of scope

- Top-level `description`, `input_schema.action.description`, `prompt_template`, `related_tools` updates in any sibling YAML (none reach the entity extractor; same out-of-scope decision as kafka).
- Adding new actions or removing existing ones from any sibling YAML.
- Renaming actions to be self-disambiguating (e.g. `search` → `log_search`) — would invalidate downstream prompt templates and runbook references.
- Updating `docs/development/action-tool-maps.md` further — the kafka commit at `d777ad6` already documents the field; per-YAML examples would be redundant.
- Cross-YAML refactoring (consolidating overlapping actions, splitting omnibus actions like elastic's `document_ops`).
- LLM behavioural eval — no eval harness exists; building one is its own ticket.

## Verification

```bash
# YAML schema validation -- must reject any typo or absent action key
bun run yaml:check

# All 6 datasources covered: 142 baseline + 5 new sibling tests = 147
bun run --filter '@devops-agent/gitagent-bridge' test

# Renamed file is the only test file touched; kafka assertions still 10/10
bun test packages/gitagent-bridge/src/tool-yaml-coverage.test.ts

# Format checks
bun run typecheck && bun run lint && bun run yaml:check

# Manual smoke -- ALL 6 datasources should now use indented format
bun -e "
  import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
  import { formatActionCatalog } from './packages/agent/src/entity-extractor.ts';
  const out = formatActionCatalog(loadAgent('agents/incident-analyzer').tools);
  const datasources = ['kafka', 'elastic', 'couchbase', 'konnect', 'gitlab', 'atlassian'];
  for (const ds of datasources) {
    const indented = out.includes('- ' + ds + ':\n  - ');
    console.log(ds + ' indented:', indented);
  }
"
# Expected: all 6 print "indented: true"
```

## Commit shape

Single commit reusing `SIO-680,SIO-682:` prefix. Files touched:

- `agents/incident-analyzer/tools/elastic-logs.yaml` (+15 lines)
- `agents/incident-analyzer/tools/couchbase-health.yaml` (+10 lines)
- `agents/incident-analyzer/tools/konnect-gateway.yaml` (+11 lines)
- `agents/incident-analyzer/tools/gitlab-api.yaml` (+7 lines)
- `agents/incident-analyzer/tools/atlassian-api.yaml` (+6 lines)
- `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` → `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts` (rename via `git mv`)
- The renamed file gains a second `describe()` block (+~30 lines)

Per memory rule, doc/definition sync reuses originating tickets — no new Linear issue.
