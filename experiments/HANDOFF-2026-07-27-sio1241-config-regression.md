# HANDOFF — SIO-1241 report quality: the cause was CONFIG, not the five defects

- **Date**: 2026-07-27
- **Supersedes the framing of**: `experiments/HANDOFF-2026-07-27-live-replay-defects.md`
- **Parent**: [SIO-1241](https://linear.app/siobytes/issue/SIO-1241) — report-quality defects
- **Tickets shipped**: [SIO-1256](https://linear.app/siobytes/issue/SIO-1256), [SIO-1257](https://linear.app/siobytes/issue/SIO-1257), [SIO-1258](https://linear.app/siobytes/issue/SIO-1258), [SIO-1259](https://linear.app/siobytes/issue/SIO-1259), [SIO-1260](https://linear.app/siobytes/issue/SIO-1260), [SIO-1262](https://linear.app/siobytes/issue/SIO-1262)
- **Still open**: [SIO-1261](https://linear.app/siobytes/issue/SIO-1261)
- **Repo state**: `main` @ `8f39beb8`, all six merged, working tree clean
- **PRs**: [#498](https://github.com/zx8086/devops-incident-analyzer/pull/498), [#499](https://github.com/zx8086/devops-incident-analyzer/pull/499), [#500](https://github.com/zx8086/devops-incident-analyzer/pull/500), [#502](https://github.com/zx8086/devops-incident-analyzer/pull/502), [#503](https://github.com/zx8086/devops-incident-analyzer/pull/503), [#504](https://github.com/zx8086/devops-incident-analyzer/pull/504)

## TL;DR

The previous handover listed five independent defects. **That framing was wrong.** The real cause
was two configuration changes that landed between the good run and the bad one, neither measured
against the other. [DEVOPS-1405](https://pvhcorp.atlassian.net/browse/DEVOPS-1405) (2026-07-25) is a
24KB, five-datasource incident report; two days later the same agent scored 0.45 and gitlab returned
44 characters.

Restoring the config took confidence **0.45 → 0.78** with zero truncations — on plain `origin/main`,
before any of the five defect fixes. All six tickets are merged. What remains is operational:
**restart the agent, watch the cost, and run one real incident.**

## Context — how this came to be

A live replay on 2026-07-27 17:29 (run `cbada913-d22f-4618-826b-0c4c38fd8956`) produced a poor
report. The handover written from it catalogued five defects and proposed five fixes. Those fixes
were built and merged, and they are all real — but they were treating symptoms.

The question that should have been asked first is *what changed between the run that worked and the
run that did not*. `git log --since --until` answers it in minutes:

| | DEVOPS-1405 (2026-07-25 20:01) | defect run (2026-07-27 17:29) |
|---|---|---|
| sub-agent model | `claude-sonnet-4-6` (inherited from root) | **`claude-haiku-4-5`** |
| ReAct cycle | 2 super-steps | **3** |
| gitlab reasoning turns | ~12 | **~8** |

Two commits did it:

- **SIO-1235** (`aaad8eec`, 07-27 00:11) correctly fixed dead config — the seven sub-agent manifests
  declared `claude-haiku-4-5` and it had never taken effect since the original scaffold. Fixing it
  moved every specialist OFF the root model (then Sonnet 4.6) and ONTO Haiku 4.5.
- **SIO-1250** (`86a47956`, 07-27 15:15 — **2h14m before the bad run**) installed `preModelHook`.
  It is a graph NODE, so a cycle became three super-steps and every sub-agent silently lost a third
  of its turns.

Neither was a bug. Both were unmeasured against the DEVOPS-1405 baseline.

## The evidence

A/B on plain `origin/main`, no defect fixes, same query and estates:

| Arm | gitlab | Truncations |
|---|---|---|
| Haiku 4.5 + limit 24 | **truncated**, 44–152 bytes reached the aggregator | 1 |
| Sonnet 4.6 + limit 36 | **no truncation**, 6188 chars | **0** |

Verification run after SIO-1262 landed: **confidence 0.78**, elastic 9290 / kafka 6930 / gitlab 7893
/ aws 11128 + 11021 chars, zero truncations, zero deferrals, zero tool-not-found.

## Where the bodies were buried

**`packages/agent/src/llm.ts:427`** — `subAgent` is the sole `TOOL_BINDING_ROLE`, and that branch
returns the primary unwrapped because `RunnableWithFallbacks` cannot `bindTools()`:

```ts
const TOOL_BINDING_ROLES: ReadonlySet<LlmRole> = new Set(["subAgent"]);
// ...
if (TOOL_BINDING_ROLES.has(role)) {
    logger.info({ role, ... }, "LLM model selected");
    return primary;          // <- any `fallback:` in a sub-agent manifest is DEAD CONFIG
}
```

**`packages/agent/src/llm.ts` (light tier)** — before SIO-1262 this BORROWED elastic-agent's manifest
model. Moving the specialists would have repriced every cheap high-frequency role by side effect. It
now names its own model (`LIGHT_TIER_MODEL = claude-haiku-4-5`).

**`packages/agent/src/sub-agent.ts`** — `RECURSION_LIMIT_BY_DATASOURCE`. The sizing comment said *"a
ReAct cycle is two of them"* and the numbers were derived as `2 x turns + 1`. Measured node sets:

```
without preModelHook: ["__start__","tools","agent"]
with    preModelHook: ["__start__","tools","pre_model_hook","agent"]
```

Every node is a super-step, so a cycle is three. gitlab's `24` was annotated as buying "~11 LLM
turns" and was buying 8.

## What shipped

| Ticket | PR | Change |
|---|---|---|
| SIO-1262 | #503 | **The actual fix.** Specialists → `claude-sonnet-4-6` (probed), recursion limits x1.5, light tier decoupled, inert fallback removed |
| SIO-1256 | #498 | `aws_ecs_list_tasks` fell off the 25-tool cap because the tail was ordered by MCP registration order; `orderByDeclaration` + permutation-invariance test |
| SIO-1257 | #499 | Sub-agents had no non-interactive contract; `SUB_AGENT_NON_INTERACTIVE_PREAMBLE` + prose fixes + ratchet test |
| SIO-1258 | #500 | gitlab re-resolved the project before every scoped call; STEP 0 honours the focus-block id |
| SIO-1259 | #504 | Loop guard ignored short "no results" PROSE (the in-repo gitlab template) |
| SIO-1260 | #502 | Truncation synthesis + final-turn reservation |

Note #504 replaces #501: GitHub auto-closed #501 when #500 merged and deleted its base branch. **A
closed PR whose base branch no longer exists can be neither reopened nor retargeted** — retarget the
child BEFORE merging the parent next time.

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
git checkout main && git pull
bun install
bun run typecheck && bun run lint && bun run test
bun run yaml:check
```

Expected: typecheck clean, 3204 pass in `packages/agent`, 296 in `packages/gitagent-bridge`, 0 fail.

Config spot-checks:

```bash
grep -h "preferred:" agents/incident-analyzer/agents/gitlab-agent/agent.yaml   # claude-sonnet-4-6
grep -A3 "gitlab: 36" packages/agent/src/sub-agent.ts                          # 36/36/36
```

Live replay recipe: `reference_worktree_web_server_replay_env`. Assertions that matter — zero
`truncated at recursion limit`, zero `pending direction`, zero `raw_output_count_mismatch`,
confidence well above 0.45.

## What is NOT done

1. **The agent is not deployed.** CI (`.github/workflows/ci.yml`) is typecheck/lint/yaml/test only —
   there is no deploy job. `scripts/agentcore/deploy.sh` ships **MCP servers**, not the agent, and
   `apps/web` has no Dockerfile. **The running instance keeps the old model and budgets until it is
   restarted.** This is the single step between "merged" and "actually better".
2. **Cost is unvalidated.** Sonnet 4.6 is ~3x Haiku per token and ~40% slower (slowest sub-agent 135s
   vs 94s); token volume itself only rose 9%. Judge from a real invoice. Reverting is one line per
   manifest plus the limits.
3. **One incident, one query.** The 0.78 is a single data point on a replay of the same question.
   Run a fresh incident before trusting it.
4. **[SIO-1261](https://linear.app/siobytes/issue/SIO-1261) is open and now higher-stakes.**
   `probeGitlab` (`packages/agent/src/resolve-identifiers.ts`) calls `gitlab_search` with
   `scope: "projects"` and **no `group_id`**, contradicting project-resolution's "group-scoped
   search, never global" rule. SIO-1258 made the focus-block id AUTHORITATIVE, so a wrong id now
   means investigating the wrong repository rather than wasting a call.
5. **Six Linear tickets sit in "In Review"** — SIO-1256/1257/1258/1259/1260/1262. Not moved to Done
   without explicit approval.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| 3x LLM spend is unacceptable | **Medium** | One line per manifest reverts it; decide from a real invoice, not a guess |
| Raised limits let a runaway burn budget | Low | SIO-1232's loop guard still enforces; SIO-1246 made it reachable for non-bespoke tools |
| Recursion limits tuned further on one replay | Medium | Do NOT. They were scaled to restore *intended* turn counts, not fixed empirically |
| Someone re-adds a `fallback:` to a sub-agent manifest | Medium | Dead config — see `llm.ts:427`. The manifests now say why |
| Light tier re-coupled to a specialist manifest | Medium | `llm.tier.test.ts` pins the DECOUPLING, not borrow-equality |
| A future model bump repeats this | **High** | Run `bun run model:probe -- <model> --discover --report` first; the gate refuses unprobed models, and it caught three wrong values in the sonnet-4-6 placeholder |

## Out of scope

- Re-litigating SIO-1235 or SIO-1250. Both were correct changes; the gap was measurement.
- Raising `MAX_TOOLS_PER_AGENT` from 25.
- Cumulative-with-decay for the loop guard (noted on SIO-1259, deliberately not built).
- Making the tool-binding path consume fallbacks — a real architectural change, not a drive-by.

## Related code references

- `packages/agent/src/llm.ts` — `TOOL_BINDING_ROLES`, `LIGHT_TIER_MODEL`, `resolveRoleModelConfig`
- `packages/agent/src/sub-agent.ts` — `RECURSION_LIMIT_BY_DATASOURCE`, `shouldReserveFinalTurn`,
  `orderByDeclaration`, `buildBoundToolsBlock`
- `packages/gitagent-bridge/src/model-registry.ts` — the probe gate that refuses unprobed models
- `docs/reference/model-probes/claude-sonnet-4-6.md` — the probe report produced for this work
- `packages/agent/src/sub-agent-belt-ordering.test.ts` — permutation invariance for the tool belt
- `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` — the prose ratchet
  (`bun run yaml:check` cannot see `.md` files; this is the only build-time guard on agent prose)

## Memory references

`reference_sio1241_live_replay_defect_wave` (corrected to lead with the config framing),
`reference_subagent_missing_tool_is_action_group_gap` (extended with the cap-slice cause),
`reference_sio1213_model_facts_measured`, `reference_worktree_web_server_replay_env`,
`reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`,
`feedback_validate_every_claim_against_source`

## The lesson worth keeping

When output quality regresses, **diff the configuration between the run that worked and the run that
did not, before accepting any defect list as the problem statement.** Five PRs were built on a
framing that ten minutes of `git log` would have corrected.
