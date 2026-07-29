# HANDOFF — OKF migration: what remains

- **Date**: 2026-07-29
- **Tickets**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) (spike, delivered) · [SIO-1287](https://linear.app/siobytes/issue/SIO-1287) · [SIO-1288](https://linear.app/siobytes/issue/SIO-1288)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Repo state**: `main` @ `b72674e3`
- **Spec**: `docs/superpowers/specs/2026-07-29-okf-runbook-alignment-design.md`
- **Status**: migration substantially DONE. Three gaps remain, one of them a real correctness hole.

## TL;DR

OKF v0.2 adoption is **complete for content**: all **53** loaded knowledge files across both agents carry `type:` frontmatter, and the whole migration cost **zero prompt bytes** (elastic-iac 485,959 and incident-analyzer 78,671, byte-identical to pre-migration).

What remains is not more conversion. It is three follow-ups:

1. **A correctness gap** — lifecycle fields are dropped for every non-runbook category, so `status: deprecated` on a playbook/issue/spec is silently ignored. **Verified by execution.**
2. `tools:` frontmatter (SIO-1288) is live but **0 of 53** files use it.
3. Two cosmetic Q1 leftovers: no bundle-root `index.md`, and `_INDEX.md` still present.

## What shipped (do not redo)

| Commit | PR | What |
|---|---|---|
| `a6200c93` | #528 | Widened `RunbookFrontmatterSchema` for OKF (the blocker) |
| `72e7d40a` | #531 | incident-analyzer's 10 runbooks converted |
| `fdc03cd9` | #529 | **SIO-1287**: lifecycle fields respected in runbook selection |
| `d9746438` | #530 | **SIO-1288**: validator extracted to a module; `tools:` frontmatter accepted |
| `41f2db4b` | #532 | Frontmatter stripped for ALL categories + whole-line delimiter fix |
| `b72674e3` | #533 | elastic-iac's 41 files + incident-analyzer's 2 deferrals |

Measured coverage on `b72674e3`:

```
incident-analyzer  12 entries | withFrontmatter 12 | withType 12 | withTools 0
  runbooks 10, systems-map 1, slo-policies 1
elastic-iac        41 entries | withFrontmatter 41 | withType 41 | withTools 0
  reference 6, issues 8, runbooks 6, specs 4, cost-plans 6, playbook 11
```

Prompt sizes, unchanged by the migration: elastic-iac **485,959** (gitops 357,844 / converse 154,237 / info 485,959), incident-analyzer **78,671**.

## Gap 1 — lifecycle fields are dropped for non-runbook categories (REAL)

**This is the one that matters.** SIO-1287 made `status: deprecated` binding for runbook selection. It does not work anywhere else, because the lifecycle fields never reach the entry.

`packages/gitagent-bridge/src/manifest-loader.ts:393` returns them:
```ts
return { triggers: validated.triggers, status: validated.status, staleAfter: validated.stale_after, body };
```

But `stripFrontmatter` — added by #532 for all other categories — takes only the body (`:339-349`):
```ts
function stripFrontmatter(content: string, filePath: string): string {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
	try {
		const { body } = parseRunbookFrontmatter(content);   // <-- status/staleAfter discarded
		return body;
	} catch (err) { /* warn, return content unchanged */ }
}
```

**Reproduced.** Set `status: deprecated` on `agents/elastic-iac/knowledge/issues/unknown.md` (already labelled "deprecated — see cross-cluster.md" in its H1, so it is the natural first real user of this field):

```
entry status: undefined
DEPRECATED file still in gitops prompt: true
```

Two things are wrong: the entry's `status` is `undefined` rather than `"deprecated"`, and the content still reaches the prompt.

### The fix

Two parts, and the second is the one that is easy to miss.

**(a) Thread the fields through.** Change `stripFrontmatter` to return the parsed record, not just a string, and have both call sites (`manifest-loader.ts:225` in the index.yaml path, and `makeKnowledgeEntry` at `:329`) attach `status`/`staleAfter` to the `KnowledgeEntry`. Keep the tolerant catch: on a parse failure, return the content unstripped with no lifecycle fields.

**(b) Make the IaC selector act on them.** `packages/agent/src/iac/knowledge-selector.ts` reads no frontmatter at all — grep for `status` there returns only `"pipeline-status"`, an intent name. It filters by **category**, so it needs a per-entry exclusion pass before `filterAgentKnowledge`, mirroring `filterCatalogByLifecycle` (`packages/agent/src/runbook-selector.ts:371`).

**Copy SIO-1287's two decisions rather than reinventing them:**
- `status: deprecated` is **binding**; a past `stale_after` is **advisory** (warn, keep). The rationale is in `fdc03cd9`'s message: a mis-set date silently starving selection is worse than stale-but-present guidance.
- Preserve the `"emptied"` escape hatch — if every entry in a category is deprecated, pass the full set through rather than starve the prompt. Same principle as SIO-1285's fallbacks.

**Ordering is load-bearing** for the same reason SIO-1287 documents: lifecycle exclusion must run BEFORE category selection, or a deprecated file in a selected category survives.

## Gap 2 — `tools:` frontmatter is live but unused

SIO-1288 (`d9746438`) extracted the validator to `packages/gitagent-bridge/src/runbook-validator.ts` (410 lines) and added a **dual-read**: `tools:` frontmatter is the source of truth when present, falling back to the prose tail section (`runbook-validator.ts:202`, `:238`).

**0 of 53 files declare `tools:`**, so every runbook still validates via the prose tail. The conformance gate passes: **70 pass / 0 fail** over all 16 runbooks.

This is a clean migration path with no deadline. The tail section stays authoritative until a file opts in. Worth doing because the prose parsing is fragile — SIO-1278's gotcha was explanatory prose in that section splitting on commas into bogus tool names (`reference_runbook_tail_section_is_parsed_as_csv`).

Suggested order: convert the 10 incident-analyzer runbooks first (they have real tool citations), leave elastic-iac's 6 (eu-cld incident write-ups, historical prose) until someone edits them anyway.

## Gap 3 — Q1 leftovers (cosmetic)

The spec decided `_INDEX.md` over OKF's `index.md`. Two consequences were never actioned:

- **No bundle-root `index.md`** exists for either agent. OKF wants one carrying `okf_version: 0.2` — the one place frontmatter is legal on a listing file. It costs **zero prompt bytes** (`knowledge/` is not a registered category, same reason `_INDEX.md` is not loaded — pinned by `elastic-iac-load.test.ts:64`). Purely a conformance marker.
- **`agents/elastic-iac/knowledge/_INDEX.md` still exists** and is now partly redundant. My amendment (#526) noted retiring it in the migration; that never happened. It is human-only and not loaded, so this is housekeeping, not correctness.

If Q1 is ever revisited: adopting `index.md` per directory was **measured at +3,997 bytes / +0.82%** — affordable, so the decision rests on conformance-vs-inertia, not cost.

## Verification

```bash
bun run yaml:check && bun run typecheck && bun run lint
bun test packages/gitagent-bridge/src/ && bun test packages/agent/src/
```
Baseline on `b72674e3`: gitagent-bridge **326 pass / 0 fail**, agent **3290 pass / 0 fail**.

The production conformance gate specifically:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```
Baseline: **70 pass / 0 fail** over all 16 runbooks in the real `agents/` tree.

Coverage + prompt-size probe (assert the EXACT numbers, not "smaller"):
```bash
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";for(const d of ["agents/incident-analyzer","agents/elastic-iac"]){const a=loadAgent(d);console.log(d,"entries",a.knowledge.length,"prompt",buildSystemPrompt(a).length,"leaks",a.knowledge.filter(k=>k.content.trimStart().startsWith("---")).length);}'
```
Expected: `12 / 78671 / 0` and `41 / 485959 / 0`.

Gap 1 repro (should FAIL today, pass after the fix):
```bash
# set status: deprecated on agents/elastic-iac/knowledge/issues/unknown.md, then:
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";import{filterAgentKnowledge,selectCategories}from"./packages/agent/src/iac/knowledge-selector.ts";const a=loadAgent("agents/elastic-iac");console.log("status:",a.knowledge.find(k=>k.filename==="unknown.md").status);console.log("in prompt:",buildSystemPrompt(filterAgentKnowledge(a,selectCategories("gitops",a.knowledgeSelection))).includes("deprecated — see cross-cluster"));'
```
Today: `status: undefined`, `in prompt: true`. After: `status: deprecated`, `in prompt: false`. **Restore the file afterwards.**

**Worktree caveat**: a freshly created `git worktree` has no dependency links (`bun -e` fails on `yaml`), and `/tmp` is outside the repo tree. Measure from a prepared worktree and confirm with `git diff --stat origin/main -- <paths>`.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Fixing Gap 1 starves a prompt by excluding too much | Medium | Copy SIO-1287's `"emptied"` escape hatch; lifecycle exclusion must precede category selection |
| `stale_after` treated as binding | Medium | It is **advisory** by decision (`fdc03cd9`). Warn, keep. Do not re-litigate without reading that rationale |
| Threading fields through breaks the tolerant path | Medium | The catch in `stripFrontmatter` must still return content unstripped with no lifecycle fields — a bad block in a playbook must not throw |
| A new `index.yaml` key is silently stripped | **Certain if the schema field is omitted** | `KnowledgeIndexSchema` is a plain `z.object`; add the field AND a probe asserting it loaded |
| CI green is not sufficient evidence | **Observed 4x this session** | Flaky `packages/shared` OAuth tests (33/0, 32/1, 31/2 across identical runs), plus CodeRabbit reporting `pass` while rate-limited or skipped for a non-default base. Verify underneath the checks |
| Parallel duplication | **Observed 2x** | The spec was written twice, and the schema widening was tracked as both SIO-1282 and SIO-1286. **Claim the Linear issue before starting** |

## Out of scope

- **`SKILL.md`** — stays agentskills.io by decision.
- **KG / agent-memory wiki** — verified separate. One latent coupling: `packages/knowledge-graph/src/migrate.ts:11-12` hardcodes `SEED_DEPENDENCIES` and cites `systems-map/service-dependencies.md` **in a comment only**. No file read, so nothing breaks mechanically, but the seed data drifts from the doc it claims to derive from.
- **Prompt-cost work** — SIO-1285, shipped. Build on it.
- **Re-opening Q1 on cost grounds** — measured at +0.82%; cost is not the argument.

## Related code references

- `packages/gitagent-bridge/src/manifest-loader.ts:339-349` — `stripFrontmatter`, **where Gap 1 lives**
- `packages/gitagent-bridge/src/manifest-loader.ts:393` — the parse that already returns `status`/`staleAfter`
- `packages/gitagent-bridge/src/manifest-loader.ts:23-33` — `KnowledgeEntry`, already typed for the fields
- `packages/agent/src/runbook-selector.ts:371` — `filterCatalogByLifecycle`, the pattern to mirror
- `packages/agent/src/iac/knowledge-selector.ts` — the IaC selector; reads no frontmatter today
- `packages/gitagent-bridge/src/runbook-validator.ts:202,238` — SIO-1288's `tools:` dual-read
- `packages/gitagent-bridge/src/elastic-iac-load.test.ts:64` — pins `_INDEX.md` as not-loaded
- `packages/gitagent-bridge/src/types.ts:274-288` — the widened schema

## Memory references

- `reference_sio1282_okf_blocker_verified` — the `.strict()` blocker, proven by execution
- `project_two_format_split_skills_agentskills_runbooks_okf` — the decision and OKF v0.2 field list
- `reference_sio1285_iac_knowledge_selector` — why the IaC selector keys on intent; the silent-strip schema hazard
- `reference_runbook_tail_section_is_parsed_as_csv` — why `tools:` frontmatter beats the prose tail
- `reference_archive_category_is_loaded_nest_to_exclude` — loader does not recurse
- `reference_worktree_web_server_replay_env` — live-replay recipe if a behavioural check is needed
