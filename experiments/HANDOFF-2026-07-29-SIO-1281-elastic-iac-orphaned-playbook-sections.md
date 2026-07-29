# HANDOFF — SIO-1281: Restore the 16 orphaned elastic-iac playbook sub-procedures

- **Date**: 2026-07-29
- **Ticket**: [SIO-1281](https://linear.app/siobytes/issue/SIO-1281) — Restore the 16 orphaned elastic-iac playbook sub-procedures (incomplete promotion)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Sibling tickets**: [SIO-1280](https://linear.app/siobytes/issue/SIO-1280) (Orbit harvest, independent), [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) (OKF spike — **blocked on this one**)
- **Repo state**: `main` @ `5b3c796a` (post [PR #517](https://github.com/zx8086/devops-incident-analyzer/pull/517))
- **Suggested branch**: `sio-1281-restore-elastic-iac-playbook-sections`
- **DO THIS FIRST** — SIO-1282 (OKF migration) must not start until this lands, or it will convert 16 files this ticket deletes.

## TL;DR

16 of 31 skill directories under `agents/elastic-iac/skills/` are missing from `agent.yaml` `skills:`, so they **never load**. They are not abandoned scaffolding: they are playbook sections that were converted into skill files, and the original prose was **deleted from the playbook in the same move**. 14 playbook sections now contain only a one-line pointer. The elastic-iac agent therefore lost ~1,246 lines of operational knowledge it previously had.

Success = the 14 bodies are restored to their playbook sections, the 2 eu-b2b incident runbooks are relocated, the 16 skill dirs are deleted, `_INDEX.md` is repointed, and a drift test exists so this cannot silently recur.

## Context — how this ticket came to be

Found while implementing SIO-1278 ([PR #517](https://github.com/zx8086/devops-incident-analyzer/pull/517)), which converted the MCP tool-audit method into an agent-reachable form. While mapping how skills load, an audit of `agents/*/skills/` against each `agent.yaml` surfaced the 16.

Root mechanism: **local skills are a manifest allowlist, not a directory scan** (`packages/gitagent-bridge/src/manifest-loader.ts:91-103`). The loader iterates the `agent.yaml` list and `existsSync`-checks each name, so an undeclared directory is skipped with no error and no warning — silent in both directions.

Related decision recorded the same day: skills stay [agentskills.io](https://agentskills.io/home) format; runbooks/playbooks move to OKF (see SIO-1282). That split is *why* the fix here is "restore to playbook", not "declare as skills".

## Where the bodies are buried

### The loader mechanism (why they are invisible)

`packages/gitagent-bridge/src/manifest-loader.ts:91-103`:
```ts
const skillsDir = join(agentDir, "skills");
if (isDirectory(skillsDir)) {
	for (const skillName of manifest.skills ?? []) {
		const skillPath = join(skillsDir, skillName, "SKILL.md");
		if (existsSync(skillPath)) {
			const content = readFileSync(skillPath, "utf-8");
			skills.set(skillName, content);
			skillMeta.set(skillName, parseSkillFrontmatter(skillName, content));
		}
	}
}
```

### The hollowed-out playbook sections — exact stub lines on `main`

Each of these 14 lines is the *entire* body of its section now:

| File | Line | Stub |
|---|---|---|
| `knowledge/playbook/3-index-lifecycle-management-ilm.md` | 209 | `_Promoted to skill \`skills/dead-data-stream-cleanup/\`._` |
| " | 243 | `orphan-index-reattachment` |
| " | 268 | `built-in-ilm-policy-revalidation-after-upgrade` |
| " | 294 | `dedicated-ilm-policy-for-high-retention-network-logs-streams` |
| " | 321 | `ilm-rollover-guard-semantics` |
| " | 324 | `empty-retention-fleet-templates-inherit-prod-ilm` |
| " | 364 | `override-index-template-pattern-priority-300` |
| " | 367 | `warmcold-tier-replica-policy` |
| `knowledge/playbook/4-fleet-agent-collection.md` | 48 | `systemprocess-metric-tuning` |
| " | 83 | `clock-skew-ingest-pipeline-custom-pinning` |
| `knowledge/playbook/6-index-and-data-hygiene.md` | 172 | `stream-consolidation-via-reroute-processor` |
| " | 225 | `hot-node-low-watermark-relief-and-single-shard-reshard` |
| `knowledge/playbook/7-infrastructure-and-cost.md` | 79 | `raise-then-downsize-two-step-incident-pattern` |
| `knowledge/playbook/8-operational-governance.md` | 51 | `retention-audit-process` |

All paths relative to `agents/elastic-iac/`.

### The concrete breakage

`knowledge/playbook/3-index-lifecycle-management-ilm.md` around :315-322:
```markdown
-   Do NOT add min_primary_shard_docs or other min_* gate
    conditions --- see §3.12 for why.

-   Net effect on eu-cld (modelled): −51% shard count over 30--45 days.

## §3.12 Sub-procedure: ILM rollover guard semantics --- do not use min\_\* on shared policies
_Promoted to skill `skills/ilm-rollover-guard-semantics/`._
```
§3.11 tells the agent to consult §3.12; §3.12's content exists only in a file that never loads.

### Proof they are playbook content, not skills

Every one of the 16 opens like this (`skills/ilm-rollover-guard-semantics/SKILL.md:1-13`):
```markdown
---
name: ilm-rollover-guard-semantics
description: ILM rollover guard semantics --- do not use min\_\* on shared policies
inputs:
  cluster: { type: string, required: true }
outputs:
  status: { type: string }
---

# Sub-procedure: ILM rollover guard semantics --- do not use min\_\* on shared policies

> Source: Elastic_Optimisation_Playbook_v12 §3.12
```

- Titled `# Sub-procedure:`, citing `> Source: Elastic_Optimisation_Playbook_v12 §X.Y`
- `inputs: {cluster}` / `outputs: {status}` is **byte-identical boilerplate on all 16** — not a real contract
- `dedicated-ilm-policy-...` opens its body with `Symptom:` — runbook prose in skill clothing

Contrast a real working skill (`skills/resize-tier/SKILL.md`): distinct `inputs`/`outputs`, `## Pre-flight`, `## Build the diff`, `## Anti-patterns — refuse to write`. Those are actions performed at a graph stage.

Repo's own criterion, `docs/development/authoring-skills-and-runbooks.md:10-34`: pipeline-stage procedure -> skill; recognizable pattern the LLM matches -> runbook/knowledge.

## The fix (step-by-step)

### Step 1 — Restore the 14 bodies to their playbook sections

For each row in the table above: take the body of `agents/elastic-iac/skills/<name>/SKILL.md` (everything after the frontmatter and after the `> Source:` line), and replace the `_Promoted to skill ..._` stub line with it.

- Preserve content **verbatim** — this is a revert, not a rewrite.
- **Drop the frontmatter** (`name`/`description`/`inputs`/`outputs`). Playbook files have no frontmatter — verified: `head -1` on every `knowledge/playbook/*.md` is an `# N. Title` heading, and none contains `type:`.
- Keep the `> Source: Elastic_Optimisation_Playbook_v12 §X.Y` line only if the surrounding sections do; check the neighbours first.

### Step 2 — Relocate the 2 eu-b2b incident runbooks

`eu-b2b-ilm-change-apply-runbook` (339L) and `eu-b2b-ilm-oom-incident-recovery` (100L) have no playbook §; they came from a docx/md incident source. Move to `agents/elastic-iac/knowledge/runbooks/`, whose `index.yaml` description is *"eu-cld incident runbooks (reference; loaded as plain knowledge)"*.

**DECISION NEEDED — ask the user before doing this.** elastic-iac knowledge is **always-on** (see Risks), so this adds **+439 lines to every elastic-iac turn**. The alternative is `knowledge/_archive/` (which exists and is declared) if they are historical rather than reusable.

### Step 3 — Delete the 16 skill directories

```bash
cd agents/elastic-iac/skills
git rm -r built-in-ilm-policy-revalidation-after-upgrade clock-skew-ingest-pipeline-custom-pinning \
  dead-data-stream-cleanup dedicated-ilm-policy-for-high-retention-network-logs-streams \
  empty-retention-fleet-templates-inherit-prod-ilm eu-b2b-ilm-change-apply-runbook \
  eu-b2b-ilm-oom-incident-recovery hot-node-low-watermark-relief-and-single-shard-reshard \
  ilm-rollover-guard-semantics orphan-index-reattachment \
  override-index-template-pattern-priority-300 raise-then-downsize-two-step-incident-pattern \
  retention-audit-process stream-consolidation-via-reroute-processor \
  systemprocess-metric-tuning warmcold-tier-replica-policy
```
(Adjust for whatever step 2 decides about the two eu-b2b files — move them before deleting.)

### Step 4 — Repoint `knowledge/_INDEX.md`

Lines 74-92 list all 16 as `skills/<name>/SKILL.md`. Repoint each at its restored playbook § or new `runbooks/` path. `_INDEX.md` is human-only and deliberately not loaded into the prompt, but it is the map humans use.

### Step 5 — Fix `resize-tier`'s cross-reference

`agents/elastic-iac/skills/resize-tier/SKILL.md:55` ends with:
> ``See `skills/raise-then-downsize-two-step-incident-pattern/` for the full procedure.``

Repoint to the playbook § (§7.2.3 in `7-infrastructure-and-cost.md`). This is the one live skill citing a dead one.

### Step 6 — Add the drift test (the missing guard)

New test asserting every directory under `agents/*/skills/` is declared in that agent's `agent.yaml`.

**It MUST iterate the directory listing, not the loaded `agent.skills` map** — iterating the loaded map cannot observe an undeclared skill, which is the very thing that goes wrong, so it would pass vacuously. Model on the existing sub-agent equivalent at `packages/gitagent-bridge/src/index.test.ts:94-126` (SIO-1229), which documents this exact trap:

```ts
// This MUST iterate the directory listing, not `agent.subAgents`. Iterating the
// loaded map cannot observe an undeclared agent -- the very thing that goes wrong --
// so it would pass vacuously.
const onDisk = readdirSync(join(AGENTS_DIR, "agents"), { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(join(AGENTS_DIR, "agents", e.name, "agent.yaml")))
	.map((e) => e.name);
expect(onDisk.length).toBeGreaterThan(0);
```

Cover both `agents/incident-analyzer` and `agents/elastic-iac`. Note incident-analyzer's `agent.yaml` uses the plain-string dialect and elastic-iac's uses the GAP `- id:` object form — both normalize via `toIdList` (`packages/gitagent-bridge/src/types.ts:7-15`), so read the loaded manifest rather than parsing YAML by hand.

## Files to modify

| File | Change |
|---|---|
| `agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md` | Restore 8 section bodies |
| `agents/elastic-iac/knowledge/playbook/4-fleet-agent-collection.md` | Restore 2 |
| `agents/elastic-iac/knowledge/playbook/6-index-and-data-hygiene.md` | Restore 2 |
| `agents/elastic-iac/knowledge/playbook/7-infrastructure-and-cost.md` | Restore 1 (§7.2.3) |
| `agents/elastic-iac/knowledge/playbook/8-operational-governance.md` | Restore 1 (§8.3) |
| `agents/elastic-iac/knowledge/runbooks/` | +2 eu-b2b files (pending step-2 decision) |
| `agents/elastic-iac/skills/<16 dirs>/` | **Delete** |
| `agents/elastic-iac/knowledge/_INDEX.md` | Repoint lines 74-92 |
| `agents/elastic-iac/skills/resize-tier/SKILL.md` | Line 55 cross-reference |
| `packages/gitagent-bridge/src/index.test.ts` | New drift test |

## Verification

```bash
bun run yaml:check && bun run typecheck && bun run lint && bun run test
```

Load probe — skills down to 15, playbook knowledge unchanged in file count but larger in bytes:

```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");console.log("skills:",a.skills.size);const kb={};for(const k of a.knowledge)kb[k.category]=(kb[k.category]||0)+1;console.log("knowledge:",JSON.stringify(kb));const pb=a.knowledge.filter(k=>k.category==="playbook").reduce((n,k)=>n+k.content.length,0);console.log("playbook bytes:",pb);'
```

Expected: `skills: 15`. Baseline on `5b3c796a` for comparison: `skills: 15 of 31 on disk`, `knowledge: {"reference":6,"issues":8,"runbooks":6,"specs":4,"cost-plans":6,"playbook":11,"health-snapshots":4,"_archive":1}`.

No stubs remain:
```bash
grep -rn "_Promoted to skill" agents/elastic-iac/ ; echo "exit=$? (1 = clean)"
```

No dangling `_INDEX.md` pointers:
```bash
grep -oE 'skills/[a-z0-9-]+/' agents/elastic-iac/knowledge/_INDEX.md | sort -u | while read p; do [ -d "agents/elastic-iac/$p" ] || echo "DANGLING: $p"; done
```

Drift test actually bites — temporarily create `agents/elastic-iac/skills/zz-canary/SKILL.md`, confirm the test FAILS, then delete it. A drift test that passes with an undeclared dir present is worthless.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Restoring all 16 to `knowledge/` instead of the playbook adds ~1,246 always-on lines | Medium | **elastic-iac has NO `selectRunbooks` node** — its `knowledge/index.yaml` says so explicitly: *"No runbook_selection: that wires incident-analyzer's selectRunbooks node, which the IaC graph (buildIacGraph) does not have."* So elastic-iac knowledge is always-on, NOT trigger-gated. Restoring into `playbook/` (already loaded, 11 files) is the only zero-new-cost option |
| Content loss during the move | Medium | Do it as `git mv`-then-edit where possible; diff the restored section against the deleted SKILL.md body before committing |
| Section numbering drift after edits | Low | Line numbers above are from `5b3c796a`; re-grep `_Promoted to skill` before each edit rather than trusting them |
| Playbook frontmatter mismatch | Low | Playbook files have NO frontmatter — do not carry `inputs`/`outputs` across |
| Drift test breaks unrelated agents | Low | Run it against both agents; incident-analyzer is currently clean (6/6 declared, 7 sub-agents all declared) |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing **flaky** lbug/Kuzu teardown segfault in `knowledge-graph`, NOT your regression. Confirm by looping `bun run --filter '@devops-agent/knowledge-graph' test; echo $?` — see `reference_runbook_tail_section_is_parsed_as_csv` |

## Out of scope

- OKF format conversion (SIO-1282 — explicitly sequenced after this)
- Any change to the 15 working elastic-iac skills beyond `resize-tier:55`
- incident-analyzer skills or runbooks
- The Orbit harvest (SIO-1280)

## Related code references (already correct — use as patterns)

- `packages/gitagent-bridge/src/index.test.ts:94-126` — the SIO-1229 directory-iteration drift test to model step 6 on, including the anti-vacuity comment
- `packages/gitagent-bridge/src/skill-tool-coverage.test.ts:119-206` — loads real agents from disk and iterates `subAgentDirs`; same pattern, different assertion
- `packages/gitagent-bridge/src/types.ts:7-15` — `toIdList` preprocessor normalizing both `skills:` dialects
- `agents/elastic-iac/knowledge/index.yaml` — the SIO-953 Knowledge Tree; categories load `*.md` DIRECTLY under `path` (no recursion)

## Memory references

- `project_two_format_split_skills_agentskills_runbooks_okf` — the skills-vs-OKF decision and why these are playbook content
- `reference_runbook_tail_section_is_parsed_as_csv` — the flaky exit-133 trap, and runbook tail-section rules if anything lands in `runbooks/`
- `reference_sio1228_skill_tool_binding` — `activeSkills` is a dead seam, so every declared skill body is in the prompt unconditionally (the cost argument)
- `reference_sio1229_undeclared_subagents_fixed` — the identical undeclared-in-agent.yaml class of bug, one level up
- `reference_iac_hub` — elastic-iac lessons hub
