# Action Tool Maps

> **Targets:** Bun 1.3.9+ | MCP SDK 1.27+ | TypeScript 5.x
> **Last updated:** 2026-04-09

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

**Sub-Agent:** When `queryDataSource()` runs, `selectToolsByAction()` resolves the extracted action names to concrete MCP tool names via `resolveActionTools()` from the gitagent bridge. Only matching tools are passed to the ReAct agent.

---

## Adding Action Maps to New Tools

When creating a new tool YAML for a datasource, follow these steps to add an `action_tool_map`.

### Step 1: List All MCP Tool Names

Start the MCP server and list its registered tools. The tool names are what you will group into action categories.

```bash
# Start the server
bun run packages/mcp-server-elastic/src/index.ts

# List tools via MCP inspector or check the server's tool registration files
# Look in packages/mcp-server-*/src/tools/*/tools.ts for server.tool() calls
```

Alternatively, search the tool registration files directly:

```bash
grep -rh 'server.tool(' packages/mcp-server-elastic/src/tools/ | grep -oP '"[^"]*"' | head -20
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
| `agents/incident-analyzer/tools/elastic-logs.yaml` | Elastic action map: 11 categories, ~78 tools |
| `agents/incident-analyzer/tools/kafka-introspect.yaml` | Kafka action map: 8 categories, 15 base + 15 optional tools |
| `agents/incident-analyzer/tools/couchbase-health.yaml` | Couchbase action map: 8 categories, ~15 tools |
| `agents/incident-analyzer/tools/konnect-gateway.yaml` | Konnect action map: 9 categories, 15 enhanced + proxy tools |
| `agents/incident-analyzer/tools/gitlab-api.yaml` | GitLab action map: CI/CD, merge-request, code-analysis categories (proxy + custom) |
| `agents/incident-analyzer/tools/atlassian-api.yaml` | Atlassian action map: Jira issue search, Confluence pages, ticket metadata (proxy + custom) |
| `packages/agent/src/sub-agent.ts` | `selectToolsByAction()` -- 3-tier fallback selection |
| `packages/agent/src/entity-extractor.ts` | `buildActionCatalog()` -- builds action catalog for the LLM |
| `packages/agent/src/prompt-context.ts` | `getToolDefinitionForDataSource()` -- resolves tool YAML by datasource ID |
| `packages/gitagent-bridge/src/tool-mapping.ts` | `resolveActionTools()`, `getAllActionToolNames()` -- YAML-to-tool-name resolution |
| `packages/gitagent-bridge/src/types.ts` | `ToolDefinitionSchema` -- Zod schema defining `action_tool_map` structure |
| `packages/shared/src/agent-state.ts` | `ExtractedEntitiesSchema` -- includes `toolActions` field |

---

## Fallback Behavior

`selectToolsByAction()` in `sub-agent.ts` implements a 3-tier fallback chain. Each tier activates only when the previous tier fails to produce at least `MIN_FILTERED_TOOLS` (5) tools.

### Tier 1: Extracted Actions

The entity extractor returned `toolActions` for this datasource with specific action categories. `resolveActionTools()` maps those categories to MCP tool names from the YAML.

```
Query: "Show me consumer lag for the payments group"
toolActions: { "kafka": ["consumer_lag"] }
Resolved tools: kafka_list_consumer_groups, kafka_describe_consumer_group, kafka_get_consumer_group_lag
Result: 3 tools (below MIN_FILTERED_TOOLS) -> falls through to tier 2
```

### Tier 2: All Curated Tools

Falls back to all tool names across every action category in the YAML via `getAllActionToolNames()`. This provides the full curated set without action-based narrowing.

```
Query: (continuing from above)
All curated tools for kafka: 30 unique tool names from all 8 categories
Result: 30 tools (capped at MAX_TOOLS_PER_AGENT = 25) -> uses first 25
```

### Tier 3: Hard Cap

If the YAML has no `action_tool_map` or the curated tools produce fewer than 5 matches against the actual MCP tool set, takes the first `MAX_TOOLS_PER_AGENT` (25) tools from the full MCP set.

```
Query: (datasource with no action_tool_map defined)
All MCP tools: 40 tools from the server
Result: first 25 tools (hard cap)
```

### Short-Circuit

If the datasource has `MAX_TOOLS_PER_AGENT` (25) or fewer total MCP tools, no filtering is applied. The full set is passed directly to the ReAct agent.

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
4. Review whether the `MIN_FILTERED_TOOLS` (5) threshold is causing fallback to tier 2

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
