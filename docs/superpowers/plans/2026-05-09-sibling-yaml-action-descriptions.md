# Sibling YAML action_descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `action_descriptions` to all 5 sibling tool YAMLs (39 new descriptions across elastic, couchbase, konnect, gitlab, atlassian) so every datasource — not just kafka — gets its actions disambiguated for the entity-extractor LLM.

**Architecture:** YAML-data-only change plus a test infrastructure rename. Each YAML gains an `action_descriptions:` block at the end of `tool_mapping`, mirroring the kafka pattern landed at `35fd8c1`. The existing `kafka-introspect-coverage.test.ts` is renamed to `tool-yaml-coverage.test.ts` (broadened scope) and gains a parameterized second `describe()` block iterating over the 5 sibling facade names.

**Tech Stack:** YAML (orchestrator definitions), TypeScript (Bun test), Zod cross-field check from prior commit `b2bf369` already accepts the new field on each YAML.

**Spec:** `docs/superpowers/specs/2026-05-09-sibling-yaml-action-descriptions-design.md` (commit `cd8d25d`).

---

## Task 1: Rename the coverage test file

The existing kafka-only test file becomes the home for all 6 datasources' coverage assertions. The 5-sibling block lands in Task 3; this task is just the rename so the file's name accurately reflects the broadened scope before any new tests land.

**Files:**
- Rename: `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` → `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts`

- [ ] **Step 1: Rename via `git mv`** (preserves git history via rename detection)

```bash
git mv packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
```

- [ ] **Step 2: Confirm the file is recognized as a rename, not delete+add**

```bash
git status --short
```

Expected output: a single line `R  packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts -> packages/gitagent-bridge/src/tool-yaml-coverage.test.ts`. If you see `D` and `??` lines instead, run `git add -A` and re-check; git's rename detection should fire on a 100%-identical rename.

- [ ] **Step 3: Run the renamed file to confirm tests still pass**

```bash
bun test packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
```

Expected: 10 pass / 0 fail (the existing kafka assertions, unchanged).

- [ ] **Step 4: Update the file header comment**

Open `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts` and replace the very first line:

```typescript
// packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
```

with:

```typescript
// packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
```

- [ ] **Step 5: Confirm the rename + comment update is the only change**

```bash
git status --short && git diff --stat
```

Expected: 1 file renamed, 1 file modified (same file, +1/-1 line for the comment).

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: rename kafka-introspect-coverage.test.ts to tool-yaml-coverage

Rename via git mv (preserves history) ahead of broadening the file's
scope to cover all 6 tool YAMLs in the next commit. The 10 existing
kafka assertions stay verbatim under their `kafka-introspect.yaml
SIO-680/682 coverage` describe() block; the 5 sibling YAML
assertions land in a second describe() block in Task 3.

Header comment updated to match new filename. No test logic changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `action_descriptions` to all 5 sibling YAMLs

Five YAML edits in one commit. Each YAML's new block is appended at the end of file (after the last `action_tool_map` entry), at the same indentation as `action_tool_map:` (2 spaces).

**Files:**
- Modify: `agents/incident-analyzer/tools/elastic-logs.yaml` (append +14 lines)
- Modify: `agents/incident-analyzer/tools/couchbase-health.yaml` (append +9 lines)
- Modify: `agents/incident-analyzer/tools/konnect-gateway.yaml` (append +10 lines)
- Modify: `agents/incident-analyzer/tools/gitlab-api.yaml` (append +6 lines)
- Modify: `agents/incident-analyzer/tools/atlassian-api.yaml` (append +5 lines)

- [ ] **Step 1: Append to `elastic-logs.yaml`**

The current file ends after the `billing:` action's last tool reference (`elasticsearch_billing_get_org_charts`). Append the following block at EOF (must end with a single trailing newline):

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

The 13 keys must match `elastic-logs.yaml`'s existing `action_tool_map` keys exactly (same names, same order — the order matches the schema's `enum` declaration).

- [ ] **Step 2: Append to `couchbase-health.yaml`**

The current file ends after `query_execution:` 4 tool references. Append at EOF:

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

- [ ] **Step 3: Append to `konnect-gateway.yaml`**

The current file ends after `portal_management:` last entry (`get_portal_application`). Append at EOF:

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

- [ ] **Step 4: Append to `gitlab-api.yaml`**

The current file ends after `code_analysis:` last entry (`gitlab_get_repository_tree`). Append at EOF:

```yaml
  action_descriptions:
    issues: when querying GitLab issues, comments, labels, or saved views in a project
    merge_requests: when querying merge requests, their commits/diffs/pipelines/conflicts, or MR notes (the primary code-change correlation path)
    pipelines: when checking CI/CD pipeline status, jobs, or recent pipeline failures for a project
    search: when running global text or semantic search across GitLab projects (issues, MRs, commits, blobs)
    code_analysis: when reading file content, blame, commit diffs, commit listings, or repository tree (custom REST tools, not the proxied search)
```

- [ ] **Step 5: Append to `atlassian-api.yaml`**

The current file ends after `confluence_query:` 2 tool references. Append at EOF:

```yaml
  action_descriptions:
    incident_correlation: when looking for Jira incident tickets correlated with a service over a time window (composes JQL filtered by ATLASSIAN_INCIDENT_PROJECTS)
    runbook_lookup: when searching Confluence pages for service-specific runbooks or operational documentation
    jira_query: when running an explicit JQL query against Jira (direct, not the smart incident-correlation composer)
    confluence_query: when running an explicit CQL query against Confluence (direct, not the smart runbook-lookup composer)
```

- [ ] **Step 6: Run yamllint**

```bash
bun run yaml:check
```

Expected: PASS. If yamllint reports indentation errors, the most likely cause is mixed tabs and spaces — the YAMLs use 2-space indent throughout, and `action_descriptions:` itself sits at 2 spaces, with its children at 4 spaces. Match the surrounding `action_tool_map:` block exactly.

- [ ] **Step 7: Confirm Zod schema accepts every YAML's new block**

The schema's superRefine cross-field check (landed at `1bb90b3`) rejects any `action_descriptions` key absent from `action_tool_map`. Confirm by running `loadAgent()` against the real agent:

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
try {
  const agent = loadAgent('agents/incident-analyzer');
  console.log('loaded', agent.tools.length, 'tools');
  for (const t of agent.tools) {
    if (!t.tool_mapping?.action_descriptions) continue;
    const map = t.tool_mapping.action_tool_map ?? {};
    const descKeys = Object.keys(t.tool_mapping.action_descriptions);
    const mapKeys = new Set(Object.keys(map));
    const orphaned = descKeys.filter(k => !mapKeys.has(k));
    console.log(t.name + ':', descKeys.length, 'descriptions,', orphaned.length, 'orphaned keys');
  }
} catch (e) {
  console.error('LOAD FAILED:', e.message);
  process.exit(1);
}
"
```

Expected output:
```
loaded 8 tools
kafka-introspect: 12 descriptions, 0 orphaned keys
elastic-search-logs: 13 descriptions, 0 orphaned keys
couchbase-cluster-health: 8 descriptions, 0 orphaned keys
konnect-api-gateway: 9 descriptions, 0 orphaned keys
gitlab-api: 5 descriptions, 0 orphaned keys
atlassian-api: 4 descriptions, 0 orphaned keys
```

If any line shows `> 0 orphaned keys`, a description targets an action key that doesn't exist in the corresponding `action_tool_map` — fix the typo before proceeding.

If `LOAD FAILED:` appears, the Zod superRefine rejected the YAML. The error message lists the offending facade name and key path — fix that key in the YAML.

- [ ] **Step 8: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS. The YAMLs aren't TypeScript so typecheck won't touch them; lint shouldn't be affected either.

- [ ] **Step 9: Commit**

```bash
git add agents/incident-analyzer/tools/elastic-logs.yaml \
        agents/incident-analyzer/tools/couchbase-health.yaml \
        agents/incident-analyzer/tools/konnect-gateway.yaml \
        agents/incident-analyzer/tools/gitlab-api.yaml \
        agents/incident-analyzer/tools/atlassian-api.yaml
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: action_descriptions for the 5 sibling tool YAMLs

39 new LLM-facing descriptions across elastic (13), couchbase (8),
konnect (9), gitlab (5), atlassian (4) -- each starts with "when" so
it reads as a selection criterion in the entity extractor's catalog.

Explicitly distinguishes overlapping pairs:
- elastic: cluster_health vs node_info vs shard_analysis vs
  diagnostics; index_management vs template_management vs
  alias_management; cloud_deployment (v1) vs billing (v2)
- couchbase: fatal_requests (true failures) vs slow_queries (latency
  outliers) vs expensive_queries (high cost, can be fast OR slow)
- konnect: 3 *_management actions (control_plane, consumer, portal)
  plus the layered service_config / route_config / plugin_chain
- atlassian: smart composers (incident_correlation, runbook_lookup)
  vs direct passthroughs (jira_query, confluence_query)

Combined post-merge state: 6 datasources, 51 actions, 51 descriptions
all reaching the entity extractor via formatActionCatalog's indented
multi-line format.

Coverage assertion lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend `tool-yaml-coverage.test.ts` with the 5 sibling assertions

**Files:**
- Modify: `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts` (append a second `describe()` block at EOF)

- [ ] **Step 1: Add the failing test block**

Open `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts`. The file currently ends with the closing `});` of the kafka `describe()` block (around line 165). Add the following at the very end of the file, after that closing `});`:

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

The leading blank line separates the new `describe()` from the closing `});` of the kafka block (visual hygiene; not load-bearing).

- [ ] **Step 2: Run the new tests to confirm they pass**

After Task 2 landed all 5 YAML blocks, the new tests should pass on first run:

```bash
bun test packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
```

Expected: 15 pass / 0 fail (10 existing kafka + 5 new sibling).

If any sibling test fails, the most likely cause is a mismatch between the description keys and the `action_tool_map` keys in that YAML — the test asserts `Object.keys(descriptions).length === actionKeys.length`, so missing or extra description entries fail loudly. Fix the YAML in Task 2's commit (amend if not yet pushed; otherwise add a follow-up commit). Do NOT loosen the test.

- [ ] **Step 3: Run the full gitagent-bridge suite**

```bash
bun run --filter '@devops-agent/gitagent-bridge' test
```

Expected: 147 pass / 0 fail (142 baseline from the kafka work + 5 new sibling tests).

- [ ] **Step 4: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: extend tool-yaml-coverage with 5 sibling YAML assertions

Adds a second describe() block parameterized over the 5 sibling
facade names (elastic-search-logs, couchbase-cluster-health,
konnect-api-gateway, gitlab-api, atlassian-api). Each assertion
verifies action_descriptions is defined, contains exactly one
non-empty (>20-char) entry per action_tool_map key, and the key
counts match.

Total tests in tool-yaml-coverage.test.ts: 15 (10 kafka-specific +
5 sibling). Total gitagent-bridge suite: 147 (142 baseline + 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final cross-check before push

- [ ] **Step 1: Re-run the full validation sweep**

```bash
bun run typecheck && bun run lint && bun run yaml:check && bun test packages/gitagent-bridge/ && bun test packages/agent/src/entity-extractor.test.ts
```

Expected: PASS on all five. If any step fails, stop and diagnose rather than pushing a broken state.

- [ ] **Step 2: End-to-end smoke — confirm ALL 6 datasources use indented format**

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
import { formatActionCatalog } from './packages/agent/src/entity-extractor.ts';
const out = formatActionCatalog(loadAgent('agents/incident-analyzer').tools);
const datasources = ['kafka', 'elastic', 'couchbase', 'konnect', 'gitlab', 'atlassian'];
let allIndented = true;
for (const ds of datasources) {
  const indented = out.includes('- ' + ds + ':\n  - ');
  console.log(ds + ' indented:', indented);
  if (!indented) allIndented = false;
}
if (!allIndented) {
  console.error('FAIL: at least one datasource still uses flat format');
  process.exit(1);
}
console.log('OK: all 6 datasources use indented format');
"
```

Expected output: all 6 lines show `indented: true`, then `OK`.

- [ ] **Step 3: Inspect the three commits**

```bash
git log origin/main..HEAD --stat
```

Expected: 3 commits in this order — rename, YAML bulk, test extension. Total ~110 lines added across 5 YAMLs (+14+9+10+6+5 = 44) + ~25 lines added to tool-yaml-coverage.test.ts. Plus the rename (no line delta).

- [ ] **Step 4: Push (await user authorization)**

The user must explicitly authorize `git push`. Do not push autonomously. When authorized:

```bash
git push origin main
```

---

## Verification (manual smoke after merge)

Not automated, documented for the human reviewer:

1. **Live entity-extractor system prompt check**: enable LangSmith tracing locally (`LANGSMITH_API_KEY=...`), submit any query through the agent, fetch the resulting trace, and verify the `extractEntities` system prompt now contains the indented multi-line format for ALL 6 datasources (not just kafka).

2. **Action-selection drift sanity**: pick 3-5 deliberately-ambiguous queries that previously hit miss cases (e.g. "billing for our cloud deployment", "slow vs failing queries on couchbase", "what plugins are on this route") and confirm the entity extractor returns the *intended* action (`billing` vs `cloud_deployment`, `slow_queries` vs `fatal_requests`, `plugin_chain` vs `route_config`). No automated harness exists for this — manual qualitative check.

3. **Sibling YAML loads in production**: confirm the agent boots cleanly against the bundled `agents/incident-analyzer/` after the deploy. The Zod superRefine check would fail-fast if any description key were misaligned, so a successful boot is sufficient evidence.

## Out of scope

- Top-level `description`, `input_schema.action.description`, `prompt_template`, `related_tools` updates in any sibling YAML (none reach the entity extractor; same out-of-scope decision as kafka).
- Adding new actions or removing existing ones from any sibling YAML.
- Renaming actions to be self-disambiguating.
- Updating `docs/development/action-tool-maps.md` further (the kafka commit at `d777ad6` already documents the field).
- Cross-YAML refactoring.
- LLM behavioural eval harness.
- Pushing to remote — last step requires explicit user authorization per repo guardrails.
