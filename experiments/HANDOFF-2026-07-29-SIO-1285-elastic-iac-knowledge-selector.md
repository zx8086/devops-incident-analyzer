# HANDOFF — SIO-1285: Give elastic-iac a knowledge selector

- **Date**: 2026-07-29
- **Ticket**: [SIO-1285](https://linear.app/siobytes/issue/SIO-1285) — Give elastic-iac a knowledge selector: ~486KB is concatenated into every turn
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Related**: [SIO-640](https://linear.app/siobytes/issue/SIO-640) (the selector this ports), [SIO-1281](https://linear.app/siobytes/issue/SIO-1281) (shipped; surfaced this), [SIO-953](https://linear.app/siobytes/issue/SIO-953) (the Knowledge Tree), [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) (independent)
- **Repo state**: `main` @ `9c001236`
- **Suggested branch**: `sio-1285-elastic-iac-knowledge-selector`
- **Status**: Backlog, not started. Independent of SIO-1282 — either order.

## TL;DR

`buildIacGraph` has no `selectRunbooks` node, so **every** knowledge entry is concatenated into the elastic-iac system prompt on **every** call — measured **498,941 bytes / ~125k tokens across 46 files** on `9c001236`. That includes `_archive/` (archived by definition) and `health-snapshots/` (point-in-time data), and it applies even to `converseIac`, a trivial conversational follow-up.

incident-analyzer solved this in SIO-640: a catalog projection costs ~280 bytes/runbook always-on, and only the LLM's max-3 picks get their full ~6 KB body — roughly **20x lazy loading**. elastic-iac gets none of it.

Success = elastic-iac stops paying for knowledge it is not using on a given turn, with no regression in the ilm-delete / version-upgrade / drift flows.

## Context — how this ticket came to be

Surfaced while grounding the SIO-1281 handover. That ticket argued carefully about whether adding 441 lines (~3.9%) to elastic-iac's prompt was acceptable — while the ~486 KB baseline underneath went unnamed. The baseline is the actual finding.

It also produced a **live worked example of the cost of not having a selector**. Mid-PR, two eu-b2b incident runbooks were "archived" by moving them directly into `knowledge/_archive/`. That does nothing: `_archive/` **is** a declared, loaded category. Both files stayed fully in the prompt and the commit message's "+101 lines rather than +441" claim was wrong. The fix was to nest them one level down (`_archive/eu-b2b-ilm/`), exploiting the fact that `loadKnowledge` does not recurse — see `knowledge/_archive/eu-b2b-ilm/` on `main` and PR [#519](https://github.com/zx8086/devops-incident-analyzer/pull/519).

That "nest it to hide it" trick is a workaround for a missing mechanism. This ticket is the mechanism.

## Where the bodies are buried

### The unconditional concatenation

`packages/gitagent-bridge/src/skill-loader.ts:4-25`:
```ts
function buildKnowledgeSection(knowledge: KnowledgeEntry[]): string {
	const byCategory = new Map<string, KnowledgeEntry[]>();
	for (const entry of knowledge) { /* group */ }

	const sections: string[] = ["## Knowledge Base"];
	for (const [category, entries] of byCategory) {
		sections.push(`### ${heading}`);
		for (const entry of entries) {
			sections.push(`#### ${entry.filename}\n\n${entry.content}`);   // <-- FULL BODY, every entry
		}
	}
	return sections.join("\n\n");
}
```

No filtering of any kind. Reached via `buildSystemPromptParts:123`:
```ts
const knowledge = agent.knowledge.length > 0 ? `\n\n---\n\n${buildKnowledgeSection(agent.knowledge)}` : "";
```

### The four call sites — all pass no filter

All are `buildSystemPrompt(getAgentByName("elastic-iac"))` with **no second argument**:

| File:line | Node | Note |
|---|---|---|
| `packages/agent/src/iac/nodes.ts:926` | `parseIntent` | |
| `packages/agent/src/iac/nodes.ts:1307` | `answerInfo` | |
| `packages/agent/src/iac/nodes.ts:1346` | `converseIac` | **a trivial follow-up turn pays the full 125k tokens** |
| `packages/agent/src/iac/nodes.ts:7148` | `buildMrDescription` | |

### Measured baseline (`9c001236`, post-SIO-1281)

```
playbook           110,237      <- grew from 94,289 when SIO-1281 restored the 14 sections
specs               79,482
issues              73,487
health-snapshots    68,906
cost-plans          67,457
runbooks            60,077
reference           25,863
_archive            13,432
TOTAL              498,941      (~125k tokens, 46 entries)
```

Note the ticket body cites the **pre-merge** 485,666. Use 498,941 — SIO-1281 legitimately added ~13 KB of restored playbook prose.

### The contrast — how incident-analyzer does it

- `packages/agent/src/runbook-selector.ts:97-212` — the selector. Node registered `graph.ts:126`, edged `graph.ts:198-199` (`normalize -> selectRunbooks -> entityExtractor`).
- `packages/agent/src/prompt-context.ts:227-235` — `getRunbookCatalog`, the projection.
- `packages/agent/src/prompt-context.ts:261` — summary capped at **200 chars**.
- `packages/agent/src/runbook-selector.ts:193` — `validPicks.slice(0, 3)`, hard cap of 3 per turn.
- `packages/agent/src/prompt-context.ts:94-99` — the `runbookFilter` tri-state contract:
  ```
  runbookFilter undefined -> no filter (all runbooks present)
  runbookFilter []        -> filter to zero runbooks
  runbookFilter [names]   -> filter to just these filenames
  ```
- `packages/agent/src/aggregator.ts:120` — where it is applied.

### The seam already exists

`packages/agent/src/orchestrator-prompt-assembly.ts:35-43` — `filterAgentRunbooks` already filters `agent.knowledge` and hands a narrowed agent object to the builder, leaving other categories untouched. It is only reachable via `buildOrchestratorPromptParts` (`prompt-context.ts:137`), which the IaC graph never calls.

**So the minimum viable change is not new machinery — it is calling an equivalent filter on the four IaC call sites.**

The graph gate is config-driven, the SIO-640 edge-gate idiom (`packages/agent/src/graph.ts:81`):
```ts
const runbookSelectorEnabled = agent.runbookSelection !== undefined;
```
`agents/elastic-iac/knowledge/index.yaml:16-18` states the current position outright:
> `# No runbook_selection: that wires incident-analyzer's selectRunbooks node, which the IaC graph (buildIacGraph) does not have. The runbooks here are eu-cld incident references, loaded as plain knowledge.`

### The asymmetry that makes this non-trivial

incident-analyzer selects among **runbooks** keyed on **incident signals** (`triggers:` frontmatter — severity, services, metrics). elastic-iac's largest categories are `playbook` (110 KB), `specs` (79 KB) and `issues` (73 KB), which are consulted by **workflow** (ilm-delete, version-upgrade, drift-reconcile, synthetics...) rather than by severity.

Measured on `main`: **elastic-iac has 6 runbooks and `withTriggers: 0`** — not one of them declares triggers. A direct port of the trigger-matching selector would have nothing to match on. The selection key here likely needs to be `state.iacRequest.workflow`, not `triggers`.

## The fix (step-by-step)

Staged so each step is independently shippable and independently revertable.

### Step 1 — Exclude `_archive/` unconditionally (pure win, ~13 KB)

`_archive/index.md` is a traceability list of superseded docx filenames. It has no operational value in a prompt.

Cheapest correct version: drop the `_archive` category from `agents/elastic-iac/knowledge/index.yaml` so the loader never picks it up. The directory stays in git; only the prompt loses it. Confirm `agent.yaml` does not separately declare it (it is listed there too — check both).

Verify: `_archive` disappears from the category map and total drops ~13.4 KB.

### Step 2 — Decide on `health-snapshots/` (~69 KB)

Four point-in-time cluster health reports. Dated snapshots go stale, and a stale snapshot in the prompt is worse than none — the agent may reason from figures that no longer hold.

Options, in preference order:
1. Drop from the prompt; have the agent fetch live health via its Elastic tools when needed.
2. Keep only the most recent per cluster.
3. Leave as-is if a specific flow depends on them — but say which, in the ticket.

Grep for consumers before deciding: `grep -rn "health-snapshot" packages/agent/src/iac/`.

### Step 3 — The real selector

Two shapes; pick one and record why.

**3a. Category-level filter keyed on workflow (simpler).** A pure function `categoriesForWorkflow(workflow: string): string[]`, applied via a `filterAgentKnowledge` helper modelled on `filterAgentRunbooks`, at the four `buildSystemPrompt` call sites. An ilm-delete turn probably needs `playbook` + `reference`, not `cost-plans` + `health-snapshots`. Deterministic, no extra LLM call, no new node.

**3b. Per-file selector node (mirrors SIO-640).** Add a `runbook_selection:`-equivalent block to `knowledge/index.yaml`, build a catalog projection, add a node to `buildIacGraph`. Finer-grained, but costs an LLM round-trip per turn and needs the workflow-vs-triggers question answered first.

**Recommendation: start with 3a.** It is deterministic, testable without model calls, and captures most of the win. `converseIac` in particular should probably carry *no* knowledge at all — it is a conversational reply, not an IaC decision.

Whichever you pick, keep `buildSystemPrompt`'s existing signature working for callers that pass no filter, so nothing else in the repo changes behaviour.

### Step 4 — Fix the stale doc

`docs/development/authoring-skills-and-runbooks.md:32` says:
> `| Prompt presence | Only when listed in the manifest | Every registered entry, always on |`

**True for elastic-iac, false for incident-analyzer** since SIO-640. The doc is dated `2026-04-10` (`:4`) and never mentions `runbook_selection`, `selectRunbooks`, or the 3-runbook cap; `:132` still says "any new file is picked up on the next agent load" with no cost note. Correct it to describe both agents, and add whatever this ticket changes.

## Files to modify

| File | Change |
|---|---|
| `agents/elastic-iac/knowledge/index.yaml` | Drop `_archive` (step 1); any selection config (step 3) |
| `agents/elastic-iac/agent.yaml` | Drop `_archive` from the knowledge list if declared there too |
| `packages/agent/src/orchestrator-prompt-assembly.ts` | Generalise `filterAgentRunbooks` -> `filterAgentKnowledge`, or add alongside |
| `packages/agent/src/iac/nodes.ts` | Pass the filter at `:926`, `:1307`, `:1346`, `:7148` |
| `packages/agent/src/iac/graph.ts` | Only if step 3b (a new node) |
| `docs/development/authoring-skills-and-runbooks.md` | Fix `:32` and `:132` |
| `packages/agent/src/iac/*.test.ts` | Cover the filter; assert `converseIac` carries less than `parseIntent` |

## Verification

```bash
bun run yaml:check && bun run typecheck && bun run lint && bun run test
```

Baseline probe — run BEFORE and AFTER, and put both numbers in the PR:

```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");const by={};let tot=0;for(const k of a.knowledge){by[k.category]=(by[k.category]||0)+k.content.length;tot+=k.content.length;}console.log(JSON.stringify(by,null,1));console.log("TOTAL",tot,"entries",a.knowledge.length);'
```

Expected before: `TOTAL 498941 entries 46`. After step 1: ~485,509, `_archive` absent, entries 45.

Per-call-site measurement (the number that actually matters — build the prompt each node really sends):

```bash
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");console.log("full prompt bytes:",buildSystemPrompt(a).length);'
```

Behavioural check — the flows must still work. Replay a live turn per SIO-1281's recipe (`reference_worktree_web_server_replay_env`): copy `MAIN/.env`, start the web server, and run one ilm-delete and one version-upgrade turn. Confirm the agent still cites playbook sections it needs. **A prompt that got smaller but lost §3.12 is a regression, not a win.**

Regression guard worth adding: assert `converseIac`'s prompt is strictly smaller than `parseIntent`'s.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Filtering out a category a workflow silently depends on | **High** — the real risk | Replay each workflow live before merging. Start with `_archive` only (nothing can depend on it) and stage the rest |
| Dropping `health-snapshots` breaks a cost/health flow | Medium | Grep `packages/agent/src/iac/` for consumers first; if any, keep and note why |
| `_archive` declared in two places (`agent.yaml` + `index.yaml`) | Medium | Check both; a stale entry in either re-imports the cost |
| Per-file selector adds an LLM round-trip to every IaC turn | Medium | Prefer 3a (deterministic) unless 3a measurably under-selects |
| Trigger-based port fails silently — elastic-iac runbooks have **withTriggers: 0** | **High if 3b chosen** | Verified on `main`: none of the 6 declare triggers. Key on workflow instead |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing flaky lbug/Kuzu teardown segfault in `knowledge-graph`, not yours |

## Out of scope

- OKF format migration (SIO-1282 — independent; touches frontmatter, not selection)
- Any change to incident-analyzer's existing selector
- Re-litigating where the eu-b2b files live (settled in SIO-1281)
- The `_archive/eu-b2b-ilm/` nesting — once a real filter exists, revisit whether nesting is still needed, but do not undo it in this ticket

## Related code references (already correct — use as patterns)

- `packages/agent/src/orchestrator-prompt-assembly.ts:35-43` — `filterAgentRunbooks`, the exact seam to generalise
- `packages/agent/src/runbook-selector.ts:97-212` — the SIO-640 selector, incl. `narrowCatalogByTriggers` at `:322-344` (three modes: `noop` / `narrowed` / `fallback` — note fallback sends the FULL catalog)
- `packages/agent/src/prompt-context.ts:227-263` — catalog projection and the 200-char cap
- `packages/agent/src/graph.ts:81` — the config-driven edge gate idiom
- `packages/agent/src/iac/graph-knowledge.ts:237-256` — `memoryEnrichIac`; note it lands on the **review card** (`nodes.ts:7047`), NOT the prompt. Do not confuse the two lanes

## Memory references

- `reference_elastic_iac_always_on_knowledge_486kb` — **the primary one**; the full measurement and the incident-analyzer contrast
- `reference_archive_category_is_loaded_nest_to_exclude` — why `_archive/` loads and how nesting evades it
- `reference_iac_hub` — elastic-iac lessons hub
- `reference_sio1228_skill_tool_binding` — `activeSkills` is a dead seam, so skill bodies are unconditional too (the same class of problem, one layer up)
- `reference_worktree_web_server_replay_env` — the live-replay recipe for the behavioural check
