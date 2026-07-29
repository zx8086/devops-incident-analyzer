# HANDOFF — SIO-1280: Harvest the unused Orbit DSL knowledge into gitlab-agent

- **Date**: 2026-07-29
- **Ticket**: [SIO-1280](https://linear.app/siobytes/issue/SIO-1280) — Harvest the unused Orbit DSL knowledge into gitlab-agent (4 zero-coverage facts)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Sibling tickets**: [SIO-1281](https://linear.app/siobytes/issue/SIO-1281), [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — **independent of both**, can be done in any order
- **Repo state**: `main` @ `5b3c796a`
- **Suggested branch**: `sio-1280-orbit-knowledge-harvest`

## TL;DR

Orbit (the GitLab Knowledge Graph) is **already integrated** — 7 MCP tools, wired into the action map, with 3 gitlab-agent skills teaching tool selection. This is a *knowledge* gap, not an integration gap. A separate Claude Code skill at `~/.agents/skills/orbit/` carries hard-won Orbit DSL knowledge, and 4 facts in it have **zero coverage** anywhere in this repo. The sharpest: querying `entity: "Issue"` is **rejected outright** — GitLab work items are the `WorkItem` entity — and nothing warns about it.

Success = the 4 facts land where a gitlab-agent turn will actually see them, without raising the tool-token ratchet.

## Context — how this ticket came to be

Surfaced during SIO-1278 ([PR #517](https://github.com/zx8086/devops-incident-analyzer/pull/517)) when the user asked whether the Orbit skills were being used. An initial answer claimed Orbit was unused; that was **wrong** — the MCP integration is solid. What is unused is the DSL knowledge in the cross-tool skill copy.

A second wrong claim in that session, corrected here so it is not repeated: the harvest was first called impossible on three grounds (tool budget, `references/` not loading, wrong transport). Two of those were false — see "Blockers that are NOT real" below.

## Where the bodies are buried

### What already exists (do not rebuild)

7 Orbit MCP tools, registered in `packages/mcp-server-gitlab/src/tools/orbit/index.ts`:
`gitlab_blast_radius`, `gitlab_cross_project_callers`, `gitlab_recent_deploys`, `gitlab_pipeline_failures`, `gitlab_recent_vulnerabilities`, `gitlab_graph_schema`, `gitlab_orbit_query_graph`.

Wired at `agents/incident-analyzer/tools/gitlab-api.yaml:111-125`. Three skills already teach usage:
- `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md` — Orbit vs semantic search, incl. an `## Orbit Availability` section
- `.../project-resolution/SKILL.md:77-85` — Orbit tools are group-scoped against `pvhcorp`
- `.../code-change-correlation/SKILL.md:45,60-63` — fallback when the Orbit index is unavailable

Existing runbook: `agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md` (already cites `gitlab_graph_schema`, `gitlab_orbit_query_graph`).

### Coverage measured against the repo

| Orbit skill teaches | Repo coverage |
|---|---|
| `Pipeline.source = "merge_request_event"` (parent/child pipeline trap) | Covered — 3 files |
| `HAS_LATEST_DIFF` vs `HAS_DIFF` (undercounts long-lived files) | Covered — 2 files |
| `token_match` / text-token operators | Covered — 2 files |
| **`WorkItem` is the entity — no `Issue` node; `entity: "Issue"` is REJECTED** | **ZERO** |
| **`path_finding` + required `path.max_depth` (max 3), `path.rel_types`** | **ZERO** |
| **`max_hops` / `min_hops` on traversal edges (default 1, max 3)** | **ZERO** |
| **Iteration budget: max 5 attempts, then give up loudly** | **ZERO** |

### The source text (verbatim, from `~/.agents/skills/orbit/SKILL.md`)

Lines 89-95 — traversal depth:
```markdown
- For multi-hop **traversal** edges, set `relationships[].max_hops` (and
  optionally `min_hops`). Default 1, max 3.
- For **path_finding** queries, set `path.max_depth` inside the required
  `path` sub-object. Max 3. `max_hops` does not apply to `path_finding`.
  When endpoints use filters, include `path.rel_types` to bound fan-out;
  path_finding follows edges only in their schema direction.
```

Lines 120-124 — the WorkItem fact:
```markdown
- **GitLab issues, epics, tasks, and incidents are the `WorkItem` entity, not
  `Issue`.** Modern GitLab unifies these under work items, and Orbit follows the
  same model: there is no `Issue` node, so `entity: "Issue"` is rejected. Query
  `WorkItem` for any of them.
```

Lines 126-134 — iteration budget:
```markdown
A single user question should resolve in **at most 5 query attempts**. Tweaking
only `limit`/`columns` is not progress; changing `entity`, relationship type, or
a `filter` is. Validation errors (HTTP 400) count toward the budget. If you
exceed 5 without converging, **give up loudly**: report the shapes you tried,
what failed, and the next step -- do not keep iterating or inflate a partial
answer.
```

Further reference material available under `~/.agents/skills/orbit/references/`: `query_language.md`, `recipes.md`, `reporting.md`, `troubleshooting.md`, `prerequisites.md`, `local_cli.md`, `local_repo_map.md`, `remote_repo_map.md`, `maintaining.md`.

## Blockers that are NOT real (measured)

| Earlier claim | Reality |
|---|---|
| "DSL field names blow the tool budget" | **False.** `TOOL_TOKEN` (`packages/gitagent-bridge/src/skill-tools.ts:19`) is ``/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g`` — it matches only **backticked** tokens, and the budget test counts only names resolving to real tools. gitlab-agent prose already backticks `merged_at`, `project_id`, `path_with_namespace`, `updated_after` at zero cost |
| "`references/` never loads, so the content is lost" | **False.** `knowledge/` is loader-supported (`manifest-loader.ts:116,160-178`) and already hosts the Orbit runbook |
| "Wrong transport (`glab orbit remote` CLI vs MCP)" | **True but shallow.** The 4 facts are properties of the graph schema, not the CLI. Only invocation syntax is CLI-specific |

### The real constraint: measured headroom

```
all backticked snake_case tokens in gitlab-agent prompt prose: 26
tool-like (gitlab_*): 16  / budget 17  => headroom 1
non-tool tokens currently tolerated (free): elasticsearch_search, get_blame,
  get_file_content, list_commits, merged_at, path_with_namespace, project_id,
  query_graph, semantic_query, updated_after
```

Budget maths, `packages/gitagent-bridge/src/skill-tool-coverage.test.ts:20-28`:
```ts
const MAX_TOOLS_PER_AGENT = 25;
const MIN_ACTION_TOOLS = 8;
const PROMPT_TOOL_BUDGET = MAX_TOOLS_PER_AGENT - MIN_ACTION_TOOLS;   // 17
```

`KNOWN_OVERSUBSCRIBED` (`:37-47`) is a **ratchet that may only ever DECREASE**. SIO-1238 already removed gitlab-agent's entry (was 18, now 16). **Do not add it back.**

## The fix (step-by-step)

### Step 1 — The 3 short facts into an existing gitlab-agent skill

Target: `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md` (it already has an `## Orbit Availability` section — add adjacent to it).

Add `WorkItem`-not-`Issue`, `max_hops` default 1/max 3, and the 5-attempt budget.

**Write DSL field names UNBACKTICKED or bold.** `**WorkItem**` and `**max_hops**` are inert; `` `max_hops` `` enters the bind set and eats the single remaining slot. Example phrasing:

```markdown
## Orbit query shape (SIO-1280)
- GitLab issues, epics, tasks and incidents are all the **WorkItem** entity.
  There is no **Issue** node -- a query with entity "Issue" is rejected outright.
- Traversal edges take **max_hops** (default 1, max 3). Path queries use
  **path.max_depth** instead, inside the required **path** object -- **max_hops**
  does not apply there.
- Budget: resolve a question in at most 5 query attempts. Changing only limit or
  columns is not progress; changing the entity, relationship type or a filter is.
  HTTP 400 validation errors count. On exceeding 5, report the shapes tried and
  what failed rather than iterating further or inflating a partial answer.
```

**Prose bans apply here** — this is a sub-agent skill. No "the user asks/mentions/wants", no "offer to", no "wait for confirmation", no "would you like / shall I / let me know / pending direction" (`skill-tool-coverage.test.ts:271-296`). The "give up loudly" wording above is deliberately phrased as *report*, not *ask*.

### Step 2 — `path_finding` + longer DSL reference into the runbook lane

Either extend `agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md`, or add a new runbook. Runbooks are trigger-gated by `selectRunbooks` (SIO-640), so reference-heavy content costs **zero always-on prompt budget**.

**If adding a NEW runbook, it must satisfy the tool-citation validator** (`packages/gitagent-bridge/src/runbook-validator.test.ts` — the validator lives IN the test file):

1. `triggers:` frontmatter is **required** and `.strict()` — only `severity`, `services`, `metrics`, `match` are legal (`packages/gitagent-bridge/src/types.ts:217-224`).
2. A `## All Tools Used Are Read-Only` section is **mandatory**, and its **first non-empty line is parsed as a comma-separated tool list**. Explanatory prose there splits on commas into bogus tool names that then fail the action-map check. Put explanation *after* that line.
3. Every name in it must exist in an `action_tool_map` in `agents/incident-analyzer/tools/*.yaml`, and prose/tail must not drift (`proseOnly`/`tailOnly` buckets).

Working example to copy: `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` (added in PR #517).

Rewrite any query examples as MCP tool calls, not `glab orbit remote query /tmp/q.json`.

### Step 3 — Leave the source skill alone

`~/.agents/skills/orbit/` is the [agentskills.io](https://agentskills.io/home) cross-tool copy (GitLab Duo CLI, Zed, OpenCode read it). Do not delete or edit it. The two Python scripts (`scripts/remote_repo_map.py`) stay out — sub-agents have no shell.

## Files to modify

| File | Change |
|---|---|
| `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md` | +3 facts, unbackticked field names |
| `agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md` **or** a new runbook | `path_finding` + DSL reference |
| `agents/incident-analyzer/tools/gitlab-api.yaml` | Only if a new runbook cites a tool not yet in the action map |

## Verification

```bash
bun run yaml:check && bun run typecheck && bun run lint && bun run test
```

**The critical check — tool-token headroom must not regress:**

```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";import{extractPromptToolNames}from"./packages/gitagent-bridge/src/skill-tools.ts";const g=loadAgent("agents/incident-analyzer").subAgents.get("gitlab-agent");const n=extractPromptToolNames(g);const t=n.filter(x=>x.startsWith("gitlab_"));console.log("tokens:",n.length,"tool-like:",t.length,"/17 headroom",17-t.length);'
```

Expected: `tool-like: 16 /17 headroom 1` (unchanged). If it rises, you backticked a DSL field name.

Confirm no ratchet entry was added:
```bash
grep -n "gitlab-agent" packages/gitagent-bridge/src/skill-tool-coverage.test.ts
```
Expected: only the SIO-1238 comment explaining the entry was REMOVED. No live `"gitlab-agent": N` key.

If a new runbook was added, confirm it loads with triggers parsed:
```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/incident-analyzer");const r=a.knowledge.filter(k=>k.category==="runbooks");console.log("runbooks:",r.length);console.log(r.map(k=>k.filename+" triggers="+JSON.stringify(k.triggers)).join("\n"));'
```
Baseline on `5b3c796a`: 10 runbooks.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Backticking a DSL field name burns the last tool slot | **High** — easy slip | The headroom probe above; write field names bold/unbackticked |
| Tempted to raise `KNOWN_OVERSUBSCRIBED` to go green | Medium | That is the regression the ratchet exists to prevent. Trim prose instead |
| New runbook fails the CSV tail-section rule | Medium | Copy `mcp-tool-audit.md`'s structure; explanation goes AFTER the CSV line |
| Sub-agent prose bans (SIO-1257) | Medium | Phrase "give up loudly" as *report*, never *ask* — a sub-agent has no human to answer it |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing flaky lbug/Kuzu teardown segfault in `knowledge-graph`, not yours |

## Out of scope

- Porting `glab orbit local` / repo-map commands or the Python scripts
- Any change to the 7 Orbit MCP tools or `packages/mcp-server-gitlab/`
- Deleting or editing `~/.agents/skills/orbit/`
- The 3 facts already covered (`merge_request_event`, `HAS_LATEST_DIFF`/`HAS_DIFF`, `token_match`)

## Related code references (already correct — use as patterns)

- `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — conformant runbook incl. the tail-section shape (PR #517)
- `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md:62-87` — the Orbit-vs-semantic table and `## Orbit Availability`, the natural insertion point
- `packages/gitagent-bridge/src/skill-tools.ts:19,66-77` — `TOOL_TOKEN` and why the bind path is deliberately narrow (widening it would prepend 62 tools for aws-agent)
- `packages/mcp-server-gitlab/src/tools/orbit/index.ts:244-251,365` — free `gitlab_graph_schema` vs BILLED `gitlab_orbit_query_graph`

## Memory references

- `reference_gitlab_search_first_and_elastic_loop_guard` — gitlab-agent search-first discipline
- `reference_subagent_tool_budget_calibration` — prompt-name cap 17, `MAX_TOOLS_PER_AGENT=25`
- `reference_sio1228_skill_tool_binding` — how skill prose binds tools; `activeSkills` is dead
- `reference_runbook_tail_section_is_parsed_as_csv` — the CSV tail-section trap and flaky exit 133
- `project_gitlab_orbit_positioning` — Orbit as THE code/SDLC graph
- `reference_sio1237_crossdatasource_procedure_home` — cross-datasource procedures belong in a rule's fetchDirective, not sub-agent prose
