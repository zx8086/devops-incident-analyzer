# pvh-elastic-iac-agent — starter

A git-native agent (GitAgent Protocol / GAP layout) that accepts plain-English requests for PVH Elastic Cloud IaC changes and turns them into a reviewed, MR-gated Terraform change.

## What it does

User says: *"Downsize eu-b2b warm tier to 8 GB per zone, reason: Wave 2b after observation."*

Agent does:

1. `validate-cluster-state` on eu-b2b (live API).
2. `resize-tier` skill builds the Terraform diff with the correct Current-then-Max ordering.
3. `pre-check-gl-testing` runs plan + apply against the single-node sandbox.
4. `open-mr` creates the GitLab MR with risks, rollback, and pre-check evidence.
5. Posts the MR URL. Stops. Human approves and triggers apply.

## Layout

```
agent.yaml                       # Manifest (skills, tools, repo, SOD)
SOUL.md                          # Identity / persona / refusals
RULES.md                         # Must-always / must-never / conditional
DUTIES.md                        # Permitted vs forbidden actions

skills/
  resize-tier/SKILL.md
  add-ilm-policy/SKILL.md
  pre-check-gl-testing/SKILL.md
  open-mr/SKILL.md
  validate-cluster-state/SKILL.md

workflows/
  tier-resize.yaml               # SkillsFlow: NL → MR
  ilm-rollout.yaml               # Wave-style multi-cluster rollout

tools/
  gitlab.yaml                    # MCP schema + allow/deny per SOD
  elastic.yaml
  terraform.yaml
  bash.yaml

knowledge/
  iac-repo-map.md                # Repo path, project ID, branches
  stack-modules.md               # Module shapes, template priorities
  cluster-inventory.md           # Per-cluster purpose + gotchas
  conventions.md                 # Local lore (autoscaling order, frozen capacity, etc.)

hooks/
  bootstrap.md                   # Read memory + verify MCPs + check main CI
  teardown.md                    # Update dailylog + in-flight context

memory/
  runtime/context.md             # In-flight MRs, recently shipped
```

## The five primitives the agent uses

| Primitive | What it is | Where it lives |
|---|---|---|
| **Skills** | Reusable capability with a contract (inputs/outputs) — the smallest agent action | `skills/*/SKILL.md` |
| **Tools** | MCP servers the skills call (GitLab, Elastic, Terraform) | `tools/*.yaml` |
| **Knowledge** | Static reference the agent consults — repo map, conventions, inventory | `knowledge/*.md` |
| **Memory** | Mutable state across sessions — in-flight MRs, dailylog | `memory/runtime/*.md` |
| **SkillFlow** | Deterministic multi-step orchestration chaining skills with `depends_on` + `${{ }}` | `workflows/*.yaml` |

`SOUL.md` is the persona; `RULES.md` is the guardrail; `DUTIES.md` is the SOD policy. The three together replace the monolithic system prompt and let you `git diff` each layer independently.

## How the wiki / playbook plugs in

Your existing register + playbook map cleanly to `knowledge/`:

- **Issue register rows** → `knowledge/reference/cluster-inventory.md` per-cluster gotchas + `memory/runtime/context.md` in-flight items
- **Playbook procedures** → become individual `skills/*/SKILL.md` files (one skill per procedure)
- **Conventions / lore** → `knowledge/reference/conventions.md`
- **Repo map** → `knowledge/reference/iac-repo-map.md`

Pattern: when the playbook adds a procedure, add a skill. When the register adds a recurring issue, add a row to `cluster-inventory.md`. The agent re-reads these on every bootstrap, so updates are zero-deploy.

## Running it (when you wire it up)

The GAP layout is portable. Two reasonable runtimes:

1. **Claude Code / SDK** — `gitagent export --format claude-code` produces `CLAUDE.md` + `.claude/` config. Use as a subagent in this same Cowork session, or invoke directly from CLI.
2. **GitLab CI agent** — a scheduled job clones this repo, runs `gitagent run --adapter system-prompt --workflow tier-resize`, posts results via the GitLab API.

For SOD compliance, run the agent under a service account that **does not have** `Maintainer` on the IaC repo — only `Developer`. That mechanically enforces "no merge, no apply" at the GitLab permission layer in addition to the agent's own refusals.

## Validation

Approach is grounded in:

- **GAP spec** — agent.yaml + SOUL.md + RULES.md + DUTIES.md + skills/ + tools/ + knowledge/ + memory/ + workflows/ + hooks/ matches the open-gitagent reference layout.
- **Your live constraints** (from memory) — gl-testing pre-check mandatory, autoscaling Current-before-Max, `.alerts` gate, frozen capacity caveat, retention-fleet template gotcha, validation scoping, no version-comparison content, plan_history > trackers.
- **SOD** — explicit maker/checker conflict in `agent.yaml` + matching allow/deny lists in `tools/*.yaml` + permission-layer enforcement via GitLab role.

## Next steps

1. Decide the runtime (Claude Code subagent vs CI service).
2. Drop this directory into a new branch of the IaC repo (or a sibling repo).
3. Add real Terraform paths to `knowledge/reference/stack-modules.md` after one `gitlab_get_repository_tree` pass.
4. Run one dry workflow end-to-end against gl-testing only.
5. After 2–3 successful gl-testing pre-checks, allow it on dev clusters.
6. Promote to staging/prod only after CODEOWNERS-approved MRs from the agent show clean diffs over a 2-week window.
