# Action Tool Maps

> **Targets:** Bun 1.3.9+ | MCP SDK 1.30.0 | TypeScript 5.x
> **Last updated:** 2026-09-30

The action-driven tool selection system reduces the number of MCP tools passed to each sub-agent's ReAct loop. Without filtering, sub-agents receive 15-80 tools from their connected MCP server, which risks exceeding the LLM's context window and degrades tool selection accuracy. Action tool maps solve this by grouping MCP tools into named action categories in the tool YAML, then selecting only the categories relevant to the user's query.

Developers need to maintain action tool maps when adding new MCP tools or modifying existing servers. This guide covers the YAML structure, the runtime selection flow, and troubleshooting.

---

## Architecture

```
Tool YAML (action_tool_map)
    |
    v
Entity Extractor (buildActionCatalog -> LLM -> toolActions)
    |
    v
Sub-Agent (selectToolsByAction -> resolveActionTools -> filtered tools)
    |
    v
ReAct Agent (LLM with 5-25 tools instead of 15-80)
```

**Tool YAML:** Each datasource has a tool YAML in `agents/incident-analyzer/tools/` containing an `action_tool_map` that groups MCP tool names by purpose. The `input_schema.properties.action.enum` array lists all valid action categories.

**Entity Extractor:** At query time, `buildActionCatalog()` reads all tool YAMLs and builds a catalog string listing available actions per datasource. This catalog is appended to the extraction prompt. The LLM returns a `toolActions` record mapping datasource IDs to action arrays (e.g., `{ "elastic": ["search", "cluster_health"] }`).

**Sub-Agent:** When `queryDataSource()` runs, the extracted actions are first unioned with the deterministic keyword passes and the Jev action selector (see [Action Sources](#action-sources-union-never-replacement)), then `selectToolsByAction()` resolves the merged action names to concrete MCP tool names via `resolveActionTools()` from the gitagent bridge. Only matching tools are passed to the ReAct agent.

---

## Adding Action Maps to New Tools

When creating a new tool YAML for a datasource, follow these steps to add an `action_tool_map`.

### Step 1: List All MCP Tool Names

Start the MCP server and list its registered tools. The tool names are what you will group into action categories.

```bash
# Start the server
bun run packages/mcp-server-elastic/src/index.ts

# List tools via MCP inspector or check the server's tool registration files
# Look in packages/mcp-server-*/src/tools/*/tools.ts for server.registerTool() calls
```

Alternatively, search the tool registration files directly (grep for `registerTool`, not the
build-forbidden `server.tool()` sugar — see [Adding MCP Tools](adding-mcp-tools.md)):

```bash
grep -rh 'server.registerTool(' packages/mcp-server-elastic/src/tools/ | grep -oP '"[^"]*"' | head -20
```

### Step 2: Group Tools by Purpose

Organize tool names into action categories based on what a user would ask for. Categories should be mutually intelligible -- a user asking about "cluster health" should not also need "index management" tools.

Guidelines for grouping:
- Keep categories focused: 2-8 tools per category is typical
- A tool can appear in multiple categories if it serves multiple purposes (e.g., `elasticsearch_diagnostics` appears in both `cluster_health` and `diagnostics`)
- Name categories after user-facing operations, not implementation details

### Step 3: Add the `action_tool_map` to `tool_mapping`

Add the map to the tool YAML under `tool_mapping`:

```yaml
tool_mapping:
  mcp_server: my-datasource
  mcp_patterns:
    - "my_prefix_*"
  action_tool_map:
    health_check:
      - my_prefix_get_health
      - my_prefix_get_status
      - my_prefix_ping
    query_analysis:
      - my_prefix_list_queries
      - my_prefix_get_slow_queries
      - my_prefix_explain_query
```

### Step 4: Update the Action Enum

The `input_schema.properties.action.enum` array must list all action categories from the map. The entity extractor uses this enum to constrain its output.

```yaml
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [health_check, query_analysis]
      description: Type of operation to perform
```

### Step 5: Verify the YAML Loads

Run the agent and check the entity extractor logs for the action catalog. The catalog should include your new datasource and its actions.

```bash
# Start the agent with debug logging
LOG_LEVEL=debug bun run packages/agent/src/index.ts

# Send a test query and check logs for:
# "Available actions per datasource:"
# - my-datasource: health_check, query_analysis
```

### `action_descriptions` and `action_keywords`

Each `tool_mapping.action_descriptions` entry is a one-line, LLM-facing hint that completes the sentence "pick this action when ...". The entity extractor (`packages/agent/src/entity-extractor.ts`, `formatActionCatalog`) emits these descriptions in its action catalog so the LLM has explicit selection criteria instead of inferring from bare action names.

| Constraint | Enforcement |
|---|---|
| Optional per action | Absent keys are silently allowed; LLM gets a bare name for those actions |
| Optional per YAML | Whole field can be absent; the YAML's catalog block uses the legacy comma-separated format |
| Keys must be a subset of `action_tool_map` keys | Zod `superRefine` cross-field check in `packages/gitagent-bridge/src/types.ts` |
| Each value is a single non-empty string | Type `Record<string, string>` |

Format change in the catalog when descriptions are present (per-tool decision):

```
- kafka:
  - consumer_lag — when a consumer group shows rising or sustained message lag (...)
  - topic_throughput — when investigating producer rate, consumer rate (...)
- elastic: search_logs, count_documents, ...   (unchanged: no descriptions today)
```

The `- elastic: ...` line above shows the legacy comma-separated fallback for a YAML with no descriptions. No shipped YAML takes that path any more: all seven incident-analyzer tool YAMLs declare a description for every action.

`tool_mapping.action_keywords` is the sibling field: per action, the operator phrases that select it deterministically (`matchActionsByKeywords()` in `packages/gitagent-bridge/src/tool-mapping.ts`). Its keys are held to the same subset-of-`action_tool_map` check as the descriptions.

Since SIO-1864 every one of the 72 actions across the seven YAMLs (atlassian 4, aws 15, couchbase 9, elastic 16, gitlab 6, kafka 13, konnect 9) declares both keywords and a description. Keep that true when adding an action: the description is what the Jev action selector is asked about (description first, keywords appended as extra context, `buildSelectableActions()` in `sub-agent.ts`), and an action with neither is asked about by its bare identifier.

---

## Modifying Existing Action Maps

When adding new MCP tools to an existing server, update the action tool map to include them.

### Adding a Tool to an Existing Category

1. Find the tool YAML for the datasource in `agents/incident-analyzer/tools/`
2. Add the new MCP tool name to the appropriate action category in `action_tool_map`
3. Run typecheck and lint: `bun run typecheck && bun run lint`

```yaml
# Before
action_tool_map:
  cluster_health:
    - elasticsearch_get_cluster_health
    - elasticsearch_get_cluster_stats

# After
action_tool_map:
  cluster_health:
    - elasticsearch_get_cluster_health
    - elasticsearch_get_cluster_stats
    - elasticsearch_get_cluster_allocation  # new tool
```

### Creating a New Category

If no existing category fits the new tool's purpose:

1. Add a new key to `action_tool_map` with the tool names
2. Add the new category name to `input_schema.properties.action.enum`
3. Test that the entity extractor produces the new action for relevant queries

```yaml
input_schema:
  properties:
    action:
      enum: [search, cluster_health, node_info, replication]  # added "replication"

tool_mapping:
  action_tool_map:
    replication:  # new category
      - elasticsearch_get_ccr_stats
      - elasticsearch_get_ccr_follow_info
```

### Removing a Tool

If an MCP tool is removed from the server, remove its name from all action categories in the YAML. Stale names in the map are harmless at runtime (they simply will not match any available tool), but they create noise in logs.

---

## Key Files

| File | Role |
|------|------|
| `agents/incident-analyzer/tools/elastic-logs.yaml` | Elastic action map: 16 categories (incl. `transform_management`, `ml_monitoring`, `cloud_deployment`, `billing`), 117 tools (101 cluster incl. 9 ML anomaly-detection + 4 ES\|QL/async-search + 16 conditional cloud/billing on EC_API_KEY) |
| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 13 categories, 11-61 tools (11 base + up to 50 gated SR + ksqlDB + Connect + REST Proxy; v2.0.0) |
| `agents/incident-analyzer/tools/couchbase-health.yaml` | Couchbase action map: 9 categories, ~43 tools (official Couchbase tools SIO-1107; `search_analysis` added SIO-1823) |
| `agents/incident-analyzer/tools/konnect-gateway.yaml` | Konnect action map: 9 categories, 15 enhanced + proxy tools |
| `agents/incident-analyzer/tools/gitlab-api.yaml` | GitLab action map: CI/CD, merge-request, code-analysis categories (proxy + custom) |
| `agents/incident-analyzer/tools/atlassian-api.yaml` | Atlassian action map: Jira issue search, Confluence pages, ticket metadata (proxy + custom) |
| `packages/agent/src/sub-agent.ts` | `selectToolsByAction()` -- 3-tier fallback selection; `composeBoundTools()` -- the 25-tool budget; `buildPriorityActions()` / `mergeKeywordActions()` -- action union |
| `packages/agent/src/action-selector.ts` | `selectActions()` -- the Jev action selector (SIO-1839) |
| `packages/agent/src/entity-extractor.ts` | `buildActionCatalog()` -- builds action catalog for the LLM |
| `packages/agent/src/prompt-context.ts` | `getToolDefinitionForDataSource()` -- resolves tool YAML by datasource ID |
| `packages/gitagent-bridge/src/tool-mapping.ts` | `resolveActionTools()`, `getAllActionToolNames()` -- YAML-to-tool-name resolution |
| `packages/gitagent-bridge/src/skill-tools.ts` | `extractSkillToolNames()` -- tool names promised by SKILL.md prose (SIO-1228) |
| `packages/gitagent-bridge/src/types.ts` | `ToolDefinitionSchema` -- Zod schema defining `action_tool_map` structure |
| `packages/shared/src/agent-state.ts` | `ExtractedEntitiesSchema` -- includes `toolActions` field |

---

## Fallback Behavior

`selectToolsByAction()` in `sub-agent.ts` implements a 3-tier fallback chain. Each tier activates only when the previous tier fails to produce at least `MIN_FILTERED_TOOLS` (1) tools.

> The floor was lowered from 5 to 1 in the SIO-785 follow-up (2026-05-18) so a narrow action (e.g. `dlq_messages` -> 3 tools) is honored instead of falling through to the all-action fallback.

### Action Sources (union, never replacement)

The action list tier 1 resolves is not the entity extractor's output alone. `queryDataSource()` unions four sources before calling `selectToolsByAction()`:

| Source | Where | Notes |
|---|---|---|
| Extracted actions | `extractedEntities.toolActions[datasource]` | The entity extractor's LLM pick from the action catalog |
| Keyword matches (SIO-738) | `matchActionsByKeywords()` over `action_keywords` | Deterministic; a match in the user's own words |
| Cluster-health inference (SIO-742) | `inferClusterHealthActions()` | Kafka only |
| Jev action selector (SIO-1839) | `selectActions()` in `packages/agent/src/action-selector.ts` | One question per action, asked of the query; an action is included at or above `ACTION_INCLUDE_THRESHOLD` (0.5) |

The selector is additive. Its result is merged with `mergeKeywordActions()`, so a query the keyword passes already handle behaves exactly as before and the model only adds the phrasings they miss. It is gated by `ACTION_SELECTOR_ENABLED` (defaults ON, a kill-switch), self-skips when `TYPESAFE_API_KEY` is unset, makes one request per sub-agent dispatch under a 4 s deadline (`SELECT_DEADLINE_MS`), and returns an empty selection on any failure or incomplete answer, which leaves the keyword passes standing alone. Each successful selection logs `action_selector.selected` with `selected` and `selectedOf`.

Selected actions are deliberately kept out of the keyword list that feeds `narrowOnHighPrecisionIntent()`: a keyword hit such as `dlq_messages` may drop competing ambient actions, and a probabilistic match must never trigger that.

### Tier 1: Extracted Actions

The entity extractor returned `toolActions` for this datasource with specific action categories. `resolveActionTools()` maps those categories to MCP tool names from the YAML.

```
Query: "Show me consumer lag for the payments group"
toolActions: { "kafka": ["consumer_lag"] }
Resolved tools: kafka_list_consumer_groups, kafka_describe_consumer_group, kafka_get_consumer_group_lag
Result: 3 tools (at or above MIN_FILTERED_TOOLS = 1) -> tier 1 is used
```

Tier 1 falls through only when no action was supplied for the datasource or none of the resolved names exists in the runtime MCP tool set.

### Tier 2: All Curated Tools

Falls back to all tool names across every action category in the YAML via `getAllActionToolNames()`. This provides the full curated set without action-based narrowing.

```
Query: (no actions extracted, matched, or selected for kafka)
All curated tools for kafka: 58 unique tool names from all 13 categories
Result: more than MAX_TOOLS_PER_AGENT (25) -> cut by the ordered budget below, not a positional slice
```

### Tier 3: Hard Cap

If the YAML has no `action_tool_map`, or none of the curated names resolves to a runtime tool (fewer than `MIN_FILTERED_TOOLS`, i.e. zero), the selection starts from the first `MAX_TOOLS_PER_AGENT` (25) tools of the full MCP set in registration order. The always-bound tools below are still unioned in; the no-`action_tool_map` path adds the skill-promised tools only, not the resolution set. Every shipped datasource declares an `action_tool_map`, so this tier is a guard, not a normal path.

```
Query: (datasource with no action_tool_map defined)
All MCP tools: 40 tools from the server
Result: first 25 tools (hard cap)
```

### Short-Circuit

If the datasource has `MAX_TOOLS_PER_AGENT` (25) or fewer total MCP tools, no filtering is applied. The full set is passed directly to the ReAct agent.

### Order of the Cut

Tiers 1 and 2 do not "take the first 25". When the selection overflows the budget, two steps decide what survives.

**1. The selected tools are sorted** (`orderByDeclaration()`), strongest evidence first:

| Rank | Key | Source |
|---|---|---|
| 1 | Tool belongs to a priority action | `buildPriorityActions()`: keyword-matched actions (SIO-1781) plus Jev-selected actions (SIO-1839) |
| 2 | Tool belongs to a keyword-matched action | The keyword tier sits above the score tier, so a match in the user's words is never displaced by a selector probability (SIO-1862) |
| 3 | Selector score, descending | The best score among the actions that contribute the tool (SIO-1862); 0 when the selector did not run |
| 4 | YAML declaration order | Position in `action_tool_map` (SIO-1256), so the cut is controlled by the curated file and not by MCP registration order or LLM output order |

Cluster-health-inferred actions are not priority actions; their tools rank by declaration order.

**2. The budget is split between head and tail** (`composeBoundTools()`). The head is every resolution tool, then every skill-promised tool (see below); the tail is the sorted selection with head duplicates removed. Up to `MIN_ACTION_TOOLS` (8) slots are reserved for the tail, taken from the head when the head alone would fill the budget (SIO-1234): `actionQuota = min(tail, max(8, 25 - head))`, `headQuota = min(head, 25 - actionQuota)`. Below the cap this is a plain concatenation.

### Why 25, and the Truncation Log

`MAX_TOOLS_PER_AGENT` was introduced in SIO-626 as a context-overflow guard. SIO-1240 documented that what it buys today is tool-selection quality (a small, relevant belt), that this purpose has never been measured at any value, and that it must not be raised on context-window grounds alone. `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` holds its own copy of the constant and enforces the derived prompt-name budget (25 - 8 = 17), so both must move together.

Since SIO-1767 the cut is no longer silent. Whenever a quota actually drops a tool, `composeBoundTools()` logs `tool budget truncated the bound set` at info level with `dataSourceId`, `max`, `minAction`, `requested`, `bound`, `droppedHead`, `droppedTail` and `droppedNames` (head drops first, then tail; the list is capped at 30 names and flagged with `droppedNamesTruncated`, while the two counts stay exact). A composition that fits logs nothing. This line, not the `filtered` flag on the `Creating ReAct agent with tools` log, is how to tell that the cap cut something: `filtered` is true on every path where the server has more than 25 tools.

---

## Always-Bound Tools (union before the cap)

Two sets are unioned into the selection on **every** tier before the `MAX_TOOLS_PER_AGENT` budget is applied, and placed at the head. Order is `[resolution] ++ [skill-promised] ++ [action-selected]`. Since SIO-1234 every required tool is promoted to the head (not only the ones missing from the selection), and the head yields slots to the selection only when it would leave fewer than `MIN_ACTION_TOOLS` (8) for it; see [Order of the Cut](#order-of-the-cut).

### Resolution tools (SIO-1029 / SIO-1084)

`RESOLUTION_TOOLS_BY_DATASOURCE` in `sub-agent.ts` -- each datasource's "where to look" enumerator (e.g. `gitlab_search`), so a loose service name is always resolvable to a real identifier regardless of the selected action. Hand-maintained. Kafka is deliberately absent: force-including `kafka_list_topics` crowds out the specialized DLQ tools (the SIO-785 regression).

### Skill-promised tools (SIO-1228)

Sub-agent `SKILL.md` prose names the tools it instructs the model to call, and **every skill body is in the system prompt on every turn** -- `buildSubAgentPrompt` calls `buildSystemPrompt` with no `activeSkills` filter. Action selection binds only the groups the entity extractor picked, so before this fix a turn that missed the matching group left the prompt promising an unbound tool. The model complied, got `Tool "X" not found` (classified `unknown` -> retryable), and burned ReAct iterations to the recursion limit.

`extractSkillToolNames()` (`packages/gitagent-bridge/src/skill-tools.ts`) scans skill bodies for backticked `snake_case` tokens; `selectToolsByAction` unions those that exist in the runtime tool set.

- The extractor **deliberately over-matches** -- prose identifiers like `project_id` are collected too. Intersecting with the real tool list at the bind site discards them, so an unresolvable name is inert (same property as a stale name in the action map).
- **Limitation:** a tool named *without* backticks is not detected and can still diverge. Every skill in the repo backticks tool names today.
- The set includes **shared** skills (`agents/shared/skills/`), which every agent inherits, under the same local-shadows-shared rule the prompt builder uses.
- `getSkillToolNames()` mirrors `buildSubAgentPrompt`'s fallback exactly, including for `atlassian-agent` / `aws-agent`, which have directories but are **not** declared in the orchestrator's `agents:` map and therefore run on the *root* agent's prompt.

Measured against the shipped manifests (raw names -> names that resolve to a real tool):

| sub-agent | raw names | bound | effect |
|---|---|---|---|
| gitlab-agent | 28 | **18** | `gitlab_get_file_content` was unbound on every narrow action; now bound (7-10 tools -> 19-21, within the cap) |
| capella-agent | 9 | 8 | |
| elastic-agent | 6 | 4 | |
| kafka / konnect / atlassian / aws | 1 | **0** | inherit only the shared `cite-sources` skill, which names `elasticsearch_search` -- not a tool on their servers, so provably inert. This is what keeps the SIO-785 kafka DLQ behaviour unchanged. |

`packages/gitagent-bridge/src/skill-tool-coverage.test.ts` is the build-time canary: it fails if a skill names a tool absent from the datasource's action map, or if any agent's union exceeds `MAX_TOOLS_PER_AGENT`. It loads through the **root** agent, because loading a sub-agent directory standalone resolves `sharedRoot` to a non-existent path and would silently skip shared skills.

Because gitlab forces 18 of 25 slots, action-driven narrowing is substantially weaker for that agent -- an accepted trade: binding what the prompt actually promises beats binding an arbitrary slice while the prompt over-promises.

---

## Troubleshooting

### "prompt is too long" Error

The sub-agent's prompt exceeds the LLM's context window, typically caused by too many tools.

1. Check tool count in the sub-agent logs: look for `toolCount` and `totalTools` in the "Creating ReAct agent with tools" log line
2. Verify `action_tool_map` covers the relevant tools -- if uncovered, the fallback chain may pass all tools
3. Check if action categories are too broad (more than 15 tools in a single category)
4. Consider splitting large categories into smaller, more focused ones

### Entity Extractor Not Producing toolActions

The LLM is not returning action categories for the datasource.

1. Check entity extractor logs for the action catalog: search for "Available actions per datasource"
2. Verify `buildActionCatalog()` includes your datasource -- it only includes tools with a defined `action_tool_map`
3. Verify the tool YAML loads correctly: `getAgent().tools` should include your tool definition
4. Test with an explicit query that names the datasource and operation type

### Sub-Agent Using Too Many Tools

The filtered tool set is larger than expected.

1. Check if the entity extractor returned too many action categories for the datasource
2. Verify action categories are not overlapping excessively (same tools in multiple categories)
3. Check `MAX_TOOLS_PER_AGENT` (25) -- even filtered results are capped at this limit
4. Tier 2 is reached only when tier 1 resolved zero runtime tools (`MIN_FILTERED_TOOLS` is 1); check the `Augmented toolActions via keyword match` and `action_selector.selected` logs to see which source added the actions

### An Expected Tool Is Missing From the Belt

1. Search the logs for `tool budget truncated the bound set` and read `droppedNames` (SIO-1767). No such line means the budget did not drop it: the action was never selected
2. If it was dropped, the fix is ordering, not the cap: give the action a keyword that matches the operator's phrasing (priority rank 1-2), or move its tools earlier in `action_tool_map` (rank 4)

### Action Category Not Matching

The entity extractor returns actions that do not exist in the YAML.

1. Verify the action name in `toolActions` matches a key in `action_tool_map` exactly (case-sensitive)
2. Check that `input_schema.properties.action.enum` includes the action category
3. Look for `unmatchedActions` in the `resolveActionTools()` return value

---

## Cross-References

- [Agent Pipeline](../architecture/agent-pipeline.md) -- full pipeline architecture including the Tool Selection section
- [Adding MCP Tools](./adding-mcp-tools.md) -- how to add new tools to MCP servers
- [Gitagent Bridge](../architecture/gitagent-bridge.md) -- YAML manifest loading and tool resolution
- [MCP Integration](../architecture/mcp-integration.md) -- MCP server connections and tool scoping
- [Environment Variables](../configuration/environment-variables.md) -- feature gate configuration

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-09 | Initial version |
| 2026-04-23 | Added `gitlab-api.yaml` and `atlassian-api.yaml` action maps; updated tool counts to reflect 6-server reality |
| 2026-07-26 | SIO-1228: documented the always-bound union (resolution + skill-promised tools); corrected `MIN_FILTERED_TOOLS` from 5 to 1 |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window): fixed the tier examples that still assumed a floor of 5 (floor is 1); replaced "first 25" with the real ordered cut (priority actions SIO-1781, selector scores SIO-1862, declaration order SIO-1256, head/tail budget SIO-1234); added the Jev action selector as an additive action source (SIO-1839), full keyword and description coverage (SIO-1864), the truncation log (SIO-1767) and the rationale for 25 (SIO-1240); category counts elastic 15 -> 16, kafka 12 -> 13 |
