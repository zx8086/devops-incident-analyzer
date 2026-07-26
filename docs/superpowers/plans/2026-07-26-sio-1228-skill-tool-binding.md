# SIO-1228 — bind the union of tools named in active skills

- **Ticket:** https://linear.app/siobytes/issue/SIO-1228 (option 3, the structural fix)
- **Date:** 2026-07-26
- **Base:** `main` @ `55bfa9ef`
- **Branch:** `claude/sio-1228-skill-tool-binding`

## Problem restated from measurement, not from the ticket

The gitlab sub-agent's skill prose names **18 real tools**; action-driven selection was
observed binding 7, 13, 13, 21. Any turn that does not select `code_analysis` leaves
`gitlab_get_file_content` unbound while the system prompt still instructs the model to
call it. The model complies, gets `Tool "X" not found`, the error classifies as
`category: "unknown"` → retryable, and the loop burns to the recursion limit.

Measured union of skill-named tools that exist in each datasource's action map:

| sub-agent | skills | tools named in skill prose |
|---|---|---|
| gitlab-agent | 3 | **18** |
| capella-agent | 3 | **8** (`capella_*`) |
| elastic-agent | 1 | **3** (`elasticsearch_ml_*`) |
| kafka / konnect / atlassian / aws | 0 | 0 |

Two facts that shape the design:

1. **`activeSkills` is a dead seam.** `buildSystemPrompt(agent, activeSkills?)` supports
   filtering, but `prompt-context.ts:157` calls `buildSystemPrompt(subAgent)` with no
   second argument. Every skill is in every sub-agent prompt on every turn. So "active
   skills" is a **static per-agent set**, and the union is computable once per process.
2. **The union fits the budget.** `MAX_TOOLS_PER_AGENT = 25`. Worst case is gitlab at 18,
   and gitlab's 4 existing `RESOLUTION_TOOLS_BY_DATASOURCE` entries are all already inside
   those 18, so the union is 18, not 22. Seven slots remain for action-selected tools.

## Design

Reuse the existing `withResolutionTools` idiom (`sub-agent.ts:797`) — union in, prepend so
the entries survive the `slice(0, MAX_TOOLS_PER_AGENT)`, no-op when nothing is missing.
The difference: the required set is **derived from the skill prose** instead of
hand-maintained, which is what makes the two sources of truth unable to diverge.

Two layers, matching the #477 chokepoint-plus-gate shape:

- **Runtime:** bind the union so the prompt can never promise an unbound tool.
- **Build-time canary:** a test that fails if a skill names a tool the datasource does not
  expose (typo / stale name), and if any agent's union crosses the tool cap.

### Layer 1 — extraction (new, pure, `packages/gitagent-bridge/src/skill-tools.ts`)

```ts
// Tool names in skill prose are consistently backticked snake_case.
const TOOL_TOKEN = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

export function extractSkillToolNames(agent: LoadedAgent, activeSkills?: string[]): string[]
```

Walks local skills then shared skills under the **same active/shadow rules as
`buildSystemPromptParts`** (shared skipped when a local skill shadows the name), collects
backticked snake_case tokens, returns sorted-unique.

Deliberately does **no** validation against a tool universe. False positives (`project_id`,
`group_id`, `code_analysis`) are removed at bind time by intersecting with the tools that
actually exist — the same "stale names are harmless" property `action-tool-maps.md`
already documents for the action map.

Known limitation to record in the doc: a tool named in prose **without** backticks is not
detected. Both gitlab skills backtick consistently; the layer-2 canary cannot catch this
either. Acceptable, documented, not silently assumed.

### Layer 2 — binding (`packages/agent/src/sub-agent.ts`)

```ts
function withSkillPromisedTools(
  selected: StructuredToolInterface[],
  allTools: StructuredToolInterface[],
  dataSourceId: string,
): StructuredToolInterface[]
```

- Resolves the sub-agent via the existing exported `AGENT_NAMES` map (`sub-agent.ts:201`,
  note `couchbase -> capella-agent`).
- Memoizes `extractSkillToolNames` per agent name — skills are static per process.
- Intersects with `allTools` by name, drops names already in `selected`, prepends the rest.
- Best-effort: any throw (manifest unreadable) returns `selected` unchanged, mirroring
  `getActiveSkillNames()`'s `catch { return [] }` at `prompt-context.ts:177`.

Applied at **all four** return paths in `selectToolsByAction` that currently call
`withResolutionTools`, plus the raw-slice fallback — the same "guarantees the invariant on
every path" reasoning as the SIO-1084 comment at `sub-agent.ts:912`.

Final ordering, highest priority first:

```
[resolution extras] ++ [skill-promised extras] ++ [action-selected]   → slice(0, 25)
```

Resolution tools stay at the head so the SIO-1029/1084 A5 invariant is not weakened by
this change.

### Layer 3 — canary test

Sibling to `packages/gitagent-bridge/src/tool-yaml-coverage.test.ts`. For every sub-agent:

1. Every backticked snake_case token in skill prose that **looks like** a tool for that
   datasource (matches the YAML's `mcp_patterns`, e.g. `gitlab_*`) must exist in that
   datasource's `action_tool_map`. Catches typos and tools deleted from the server.
2. `|union| <= MAX_TOOLS_PER_AGENT` per agent, so a future skill author cannot silently
   starve action selection. Currently 18/25 for gitlab — the tightest.

This is the piece that makes the fix structural rather than a one-time patch.

## Files to modify

| File | Change |
|---|---|
| `packages/gitagent-bridge/src/skill-tools.ts` | **new** — `extractSkillToolNames()` |
| `packages/gitagent-bridge/src/index.ts` | export the new function |
| `packages/agent/src/sub-agent.ts` | `withSkillPromisedTools()` + wire into all `selectToolsByAction` return paths |
| `packages/gitagent-bridge/src/skill-tools.test.ts` | **new** — extraction unit tests |
| `packages/agent/src/sub-agent-skill-tool-binding.test.ts` | **new** — binding tests (model on `sub-agent-gitlab-resolution.test.ts`) |
| `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` | **new** — the canary |
| `docs/development/action-tool-maps.md` | document the skill-union layer; also fix the stale `MIN_FILTERED_TOOLS` value (doc says 5, code is 1 since SIO-785 follow-up) |

## Test plan (TDD — red first)

1. `extractSkillToolNames` returns the 18 gitlab names; excludes `project_id` / `group_id`;
   respects local-shadows-shared; returns `[]` for an agent with no skills.
2. Regression: `selectToolsByAction` for gitlab with `toolActions: { gitlab: ["pipelines"] }`
   — asserts `gitlab_get_file_content` **is** bound. This test fails on `main` and is the
   exact reproduction of the ticket.
3. Cap: union never exceeds 25; action-selected tools are not fully starved.
4. No-op: kafka (0 skills) selection is byte-identical to today — guards the SIO-785 DLQ
   regression the `RESOLUTION_TOOLS_BY_DATASOURCE` comment warns about.
5. Best-effort: a throwing manifest returns `selected` unchanged.

## Verification

```bash
bun run typecheck && bun run lint && bun run test
bun run yaml:check
```

The real acceptance gate is the eval, per the ticket: re-run `bun run eval:agent` and
confirm no `Tool "…" not found` errors and no gitlab run hitting its recursion limit.
That costs ~$0.50-1.50 and needs a decision from the user before running.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Forced 18/25 starves action filtering for gitlab | Medium | 7 slots remain; canary fails if a future skill pushes the union past the cap |
| Regex over-matches prose identifiers | High (by design) | Intersection with real `allTools` discards them; asserted in tests |
| Un-backticked tool mention still diverges | Low | Documented limitation; skills backtick consistently today |
| Reintroducing the SIO-785 kafka DLQ regression | Low | kafka has 0 skills → provably no-op; test 4 pins it |

## Out of scope

- Option 1 (making skills action-aware) — needs `activeSkills` wired end-to-end, and
  `project-resolution` names 14 tools spanning most groups, so it would almost never be
  injectable.
- Option 4 (classify `Tool "X" not found` as non-retryable) — a good independent
  hardening, but it treats the symptom; file separately if wanted.
- Collapsing the duplicated `AGENT_NAMES` / `supervisor.ts AGENT_NAMES` table
  (pre-existing debt, flagged at `sub-agent.ts:199`).
