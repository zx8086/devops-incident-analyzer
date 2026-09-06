# HANDOFF 2026-09-06: pi-fleet program (pi-coms on the gitagent bridge, one codebase)

| Field | Value |
|---|---|
| Date | 2026-09-06 |
| Program | pi-fleet: pi-coms hub, spoke agents and console onboarded onto the gitagent definition and release layer of this repo, one codebase, one hub per environment |
| Tickets (execution order) | Phase 0 [SIO-1635](https://linear.app/siobytes/issue/SIO-1635) (In Progress), Phase 0b [SIO-1654](https://linear.app/siobytes/issue/SIO-1654), Phase 1 [SIO-1649](https://linear.app/siobytes/issue/SIO-1649), Phase 1b [SIO-1653](https://linear.app/siobytes/issue/SIO-1653), Phase 2a [SIO-1650](https://linear.app/siobytes/issue/SIO-1650), Phase 2b [SIO-1652](https://linear.app/siobytes/issue/SIO-1652), Phase 3 [SIO-1651](https://linear.app/siobytes/issue/SIO-1651). All Backlog except SIO-1635. No parent epic. Project: DevOps Incident Analyzer |
| Report (merged) | `docs/architecture/pi-fleet-gitagent-feasibility.md`, PR #689, squash `6c935bb2` |
| Repo state | `main` at `e8629826` (this repo); pi-coms `main` at `275cf6d` (`/Users/Simon.Owusu@Tommy.com/WebstormProjects/pi-coms`) |
| Open PR | #682 (SIO-1635 analyzer side), branch `claude/pi-agent-devops-incident-0378d5`, head `9a2fe74e`, 15 commits behind main, not merged |
| Suggested branches | `claude/sio-1635-phase0-hub-map`, then `claude/sio-1654-pi-coms-subtree` |

## TL;DR

Status 2026-09-06: Phase 0b merged (PR #690, squash `7847dfbf`, SIO-1654 Done); PR #682 merged (`e004441c`); Phase 0 code merged (PR #691, squash `4caddf23`) following `docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md`. Still open after #691: the `@devops-agent/pi-coms/contracts` import in the analyzer (one workspace dependency in `packages/agent/package.json`, needs approval), one `incident-analyzer` hub token per environment, the dev-bucket publish and host convergence, archiving the pi-coms repo. Phase 1 (SIO-1649) merged the same day (PR #692, squash `fc5d96cb`) per `docs/superpowers/plans/2026-09-06-pi-fleet-phase-1.md`: `agents/pi-fleet/` definitions, bridge exporter and version gate, `agent-release.yml`, bundle carries `vendor/pi-fleet/`. Phase 1b (SIO-1653) tooling merged the same day (PR #693, squash `41523088`) per `docs/superpowers/plans/2026-09-06-pi-fleet-phase-1b.md`: manifest, `just fleet` CLI, adopt mode, rendered roots, S3 backend; nothing applied to AWS (user-run with the real `deploy/fleet.yaml`). Next: SIO-1650 (Phase 2a).

The feasibility work is finished and merged. Verdict: gitagent can own the definition, versioning and release of the pi-coms spoke and console personas, never their execution; spokes stay Pi Coding Agent processes on per-account EC2 hosts and the hub stays the transport. Three user decisions shape everything: one codebase (pi-coms moves into this monorepo as `packages/pi-coms/`), no cross-environment access (a dev hub for dev spokes, a production hub in eu-shared-services-prd for prd spokes), and the monitor's dependencies stay in a nested non-workspace package. Nothing is implemented yet; the next session starts with Phase 0 (land PR #682, widen the two-agent assumptions, per-environment hub map) or Phase 0b (the subtree move), whichever the user approves first. Every phase needs explicit approval of its issue before code is written.

## Context: how this came to be

The user asked on 2026-09-06 whether pi-coms (a hub-and-spoke fleet of read-only AWS agents, one per account, built on the Pi Coding Agent CLI) could be integrated into the incident analyzer by implementing its agents and console through the gitagent bridge, using the unused gitagent capabilities (agent versioning, tagged releases, CI for agents), so that both share knowledge, skills and memory and can run side by side, in sequence, or after each other ("two inspectors": the analyzer on historical data, the pi agent live). A read-only survey of both repos and the gitagent (OpenGAP) spec produced the report above. Follow-up questions in the same session added the fleet inbox node (Phase 2b), the manifest-driven fleet deploy (Phase 1b), the per-environment hub rule, the one-codebase decision and the nested-dependencies decision. Prior integration: SIO-1635 built `verify-with-pi` and `investigate-with-pi` action cards on the analyzer's action lane (PR #682, open) and documented the analyzer as a hub service principal on the pi-coms side (PR #91, merged). Its handover is `experiments/HANDOFF-2026-09-05-SIO-1635.md`.

## Feasibility summary (self-contained)

**What exists.** The analyzer's `agents/` tree holds gitagent definitions (agent.yaml, SOUL/RULES/DUTIES, tools, skills, knowledge, root-only memory and hooks) compiled by `packages/gitagent-bridge`; any `agents/<name>/` loads by name with no code change (`packages/agent/src/prompt-context.ts:31`, `packages/agent/src/paths.ts:53`). `agent.yaml` `version` and `spec_version` are parsed and never read anywhere; CI has no tag trigger. Sub-agents are in-process ReAct runnables dispatched from two hard-coded `AGENT_NAMES` tables gated on MCP tool counts. pi-coms is a single Bun repo: a hub (`scripts/coms-net-server.ts`, HTTP plus SSE plus bearer, directory auth in SSM, sqlite mailbox, single instance), a Pi extension (`extensions/coms-net.ts`), a deterministic monitor, per-account Terraform roots under `deploy/accounts/`, an S3 fleet bundle (`deploy/publish-fleet.sh`) with State Manager convergence, and a hand-distilled spoke persona `deploy/AGENTS-spoke.md` copied to `AGENTS.override.md` at boot. The console is a Pi TUI session whose role is chosen by file precedence. `GET /v1/mailbox` is a non-destructive read-many listing open to any authenticated peer.

**What maps.** Identity, invariants, investigation discipline, reporting standards, skills (same agentskills.io SKILL.md standard) and runbooks port cleanly; tool-mechanics rules do not (aws-agent RULES names 41 MCP tool tokens that do not exist on a spoke), so the spoke RULES are authored fresh. Versioning, tagged releases and CI are gitagent patterns, not runtime code: making `version` load-bearing plus a tag-triggered validate-and-export job realises them.

**What does not.** Spokes as in-process sub-agents (remote processes, per-account IAM, instance-role Bedrock); a `pi` entry in `AGENT_NAMES` (tool-count gate, fan-out budget, blends live into historical); live Agent Memory access from spokes (new cross-account trust edge, separate design).

**Decisions of record.** One codebase (pi-coms becomes `packages/pi-coms/`, fleet bundle built from the subtree, operators install from the local checkout path, analyzer imports the hub contract from the package). No cross-environment access (hubs per environment, per-environment buckets and token directories, the analyzer selects the hub from the estate suffix `-dev`, `-stg`, `-prd`). Monitor dependencies stay in `packages/pi-coms/scripts/package.json`, nested and non-workspace. Hub replies and inbox bodies never reach an LLM prompt; only structured fields do. Exports are allowlist-only (never `memory/`, hooks, learned skills, or any file with a 12-digit account id).

**Effort.** Phase 0: 1 to 2 d. 0b: 2 to 4 d. 1: 4 to 6 d. 1b: 6 to 9 d. 2a: 1 to 2 d. 2b: 2 to 3 d. 3: 3 to 4 d. Roughly 19 to 30 days.

## Where the bodies are buried

**Phase 0, analyzer side (on `origin/claude/pi-agent-devops-incident-0378d5`, PR #682):**

`packages/agent/src/memory-backend.ts:82-90` on main, the two-agent assumption a third agent silently falls through:

```ts
export function resolveUserId(agentName: string): string {
	return agentName === "elastic-iac" ? "elastic-iac" : "incident-analyzer";
}
function resolveRole(agentName: string): string {
	return agentName === "elastic-iac" ? "iac-maker" : "incident-correlator";
}
```

`packages/agent/src/action-tools/pi-coms-client.ts` on the #682 branch: `PI_COMS_SENDER_NAME_PREFIX = "incident-analyzer"` at line 53 with `senderNameFor` at 56 (hard-wired prefix), `register` 120, `listAgents` 135, `send` 145, `private async heartbeat()` 164, `awaitReply` 181, `deregister` 208, no `mailbox()`. `packages/agent/src/action-tools/pi-verifier.ts`: `isPiComsConfigured` 68, `resolvePiComsConfig` 99 (belongs next to the client), `resolvePiTarget` 132, `runHubTask` 292 (register in try, deregister in finally), `executePiVerify` 341, `executePiInvestigate` 389. `packages/shared/src/config.ts:47` `PiComsConfigSchema` (single hub: `serverUrl`, `authToken`, `project`, `fallbackTarget`, `estateAgentMap`, two timeouts; defaults live in the resolver, never `.default()`).

**Phase 0b, pi-coms side (pi-coms `main` at `275cf6d`):**

Root `package.json`: name `pi-coms`, version `0.1.0`, `"pi": {"extensions": ["./extensions/coms-net.ts"]}`, peer deps only on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`. `scripts/package.json`: nine `@aws-sdk/client-*` packages plus `zod`, installed only by the bundle build. `deploy/publish-fleet.sh:28-35`:

```bash
(cd "$STAGE" && bun install --frozen-lockfile --production --omit=peer)
(cd "$STAGE/scripts" && bun install --frozen-lockfile --production)
echo "$VERSION" > "$STAGE/.bundle-version"
aws s3 cp "$STAGE.tar.gz" "s3://$BUCKET/fleet/bundle.tar.gz" "${PROFILE_ARGS[@]}"
printf '%s' "$VERSION" | aws s3 cp - "s3://$BUCKET/fleet/version" "${PROFILE_ARGS[@]}"
```

`deploy/bootstrap/agent-bootstrap.sh:173-175` (persona copy) and `:446` (`herdr agent start ... --cname --purpose`). This repo's root `package.json` `workspaces.packages` is `["packages/*", "apps/*"]`, so `packages/pi-coms` joins automatically once present; the nested `scripts/package.json` is not matched by that glob and must stay that way.

**Phase 1:** `packages/gitagent-bridge/src/skill-loader.ts:75` `buildSystemPromptParts` (section order to reuse; never `buildSubAgentSystemPrompt` at 174, its preamble breaks a spoke), `types.ts:86` `version` required and unread, `manifest-loader.ts:81` `loadAgent`, `agents/shared/context.md:20-40` (datasource-to-MCP table that must not reach a spoke), one account id at `agents/incident-analyzer/knowledge/aws/runbooks/aws-iam-permission-troubleshooting.md:51`.

**Phase 2b:** pi-coms `scripts/coms-net-server.ts:1408` `handleInbox` (reads open to every authenticated peer; `since` cursor on ULID ids; `limit` capped at 100); `scripts/coms-net-monitor.ts:41` `REPORT_TO` default `laptop` (docs assume `ops`, confirm the fleet value).

**Phase 3:** `packages/skillflow/src/resolvers.ts:59` `MissingHandlerError` for `agent`, `node`, `graph` kinds; handlers registered today only for `skill` and `tool` (`packages/agent/src/incident-close-workflow-handlers.ts:117`, `resolve-identifiers-workflow-handlers.ts:165`).

## The work, step by step (first two phases in full; the rest by issue)

**Phase 0 (SIO-1635, needs the user's smoke test through the corp hub tunnel first; see the 2026-09-05 handover for the token and tunnel gotchas):**

1. Rebase PR #682 onto main (15 behind) and merge on the user's explicit go-ahead (Greptile skips org-wide, SIO-1642).
2. `memory-backend.ts`: replace both ternaries with a `Record<string, {userId, role}>` and an explicit unknown-agent branch (throw or log, decide with the user).
3. `pi-coms-client.ts`: constructor option `senderPrefix` (default `incident-analyzer`), make `heartbeat` public, add `mailbox(name, {limit, since})` calling `GET /v1/mailbox?project=&name=&limit=&since=`, move `resolvePiComsConfig` in from `pi-verifier.ts`.
4. Per-environment hubs: `PiComsConfigSchema` gains `hubs: Record<"dev"|"stg"|"prd", {serverUrl, authToken, project, fallbackTarget}>` fed by `PI_COMS_HUBS` (JSON) with the single-hub variables as a one-entry fallback; `environmentForEstate(estate)` from the name suffix, unknown suffix is a readable card error; `proposePiVerification` groups by environment; both execute paths build the client for the estate's hub; one `incident-analyzer` principal per hub (`just token-create incident-analyzer "incident-analyzer-*" service <profile>` on each hub account).
5. Tests: client (fetch mocked at the network boundary), verifier, executor, mitigation; assert a prd estate never registers on the dev hub.

**Phase 0b (SIO-1654):**

1. `git subtree add --prefix packages/pi-coms https://github.com/zx8086/pi-coms.git main --squash` (ask the user: squash or full history).
2. Rename the package to `@devops-agent/pi-coms`; keep `keywords: ["pi-package"]` and the `pi` manifest; leave `scripts/package.json` nested and non-workspace; add a major-version parity test between its AWS SDK clients and `packages/mcp-server-aws/package.json`.
3. Align Biome and tsconfig; include the package in root `typecheck` and `lint`; tests run as `cd packages/pi-coms && bun test`.
4. Extend `.github/workflows/ci.yml` with the pi-coms steps (`bun test`, `bun build extensions/coms-net.ts --external '*' --outfile /dev/null`, `bash -n` over deploy scripts, `terraform fmt -check -recursive packages/pi-coms/deploy`).
5. Root `justfile` delegating to `packages/pi-coms/justfile` (`just coms`, `just token-create`, `just hub-tunnel` keep their names).
6. `publish-fleet.sh`: stage `git archive HEAD packages/pi-coms` with the prefix stripped, produce a standalone lockfile for the staged tree, call the Phase 1 exporter into `vendor/pi-fleet/` (no-op until Phase 1 lands), stamp `.bundle-version`, upload per environment.
7. `packages/pi-coms/contracts/`: hub wire types and the verdict and investigation Zod schemas; `packages/shared/src/pi-coms-types.ts` re-exports; extension and hub import relatively.
8. Operator install `pi install <checkout>/packages/pi-coms -l`; docs moved or indexed; package-local CLAUDE.md and AGENTS.md kept; root CLAUDE.md gets a pi-coms section (ports, the hub kill rule).
9. Publish once to the dev bucket, converge a dev host, confirm the daily digest carries the new bundle SHA; only then archive the pi-coms repo read-only.

**Phases 1, 1b, 2a, 2b, 3:** the Linear issues carry full steps, acceptance criteria and risks; the report's "Phased plan" section is the narrative.

## Verification

```bash
bun run typecheck && bun run lint && bun run test      # root; run tests per package if the root runner crashes mid-suite
cd packages/agent && bun test --isolate                # non-isolated shows 15 pre-existing iac mock-pollution fails
cd packages/shared && bun test
cd apps/web && bun run test
cd packages/pi-coms && bun test                        # after Phase 0b; 31 files, 7 spawn the real hub in a temp HOME
```

Manual probes: local hub `just coms-net-server` plus `just coms laptop` for the cards and the pane; `curl -H "Authorization: Bearer $T" "$HUB/v1/mailbox?project=default&name=ops&limit=5"` for the inbox node; `curl $HUB/v1/agents` after a `pi-coms-update` to see `persona=pi-fleet-vX.Y.Z` in `purpose`. Kill every hub and peer you start by PID and prove `lsof -nP -iTCP:<port> -sTCP:LISTEN` is empty.

## Files to modify (first two phases)

| File | Change |
|---|---|
| `packages/agent/src/memory-backend.ts` | name map replaces the two ternaries |
| `packages/agent/src/action-tools/pi-coms-client.ts` | sender prefix option, public heartbeat, `mailbox()`, config resolver moved in |
| `packages/agent/src/action-tools/pi-verifier.ts` | hub selection by estate environment, cards grouped by environment |
| `packages/shared/src/config.ts`, `.env.example` | `hubs` map, `PI_COMS_HUBS` |
| `package.json` (root) | nothing if the workspace glob suffices; any edit needs explicit approval |
| `packages/pi-coms/**` (new, subtree) | rename, contracts dir, publish script, justfile delegation |
| `.github/workflows/ci.yml`, `justfile` (root, new) | pi-coms steps and recipe delegation |
| `docs/README.md`, `CLAUDE.md`, `docs/code-review-bakeoff.md` | index rows, pi-coms section, ledger rows per PR |

## Workflow

Branch off `main` per phase; commit format `SIO-XXXX: message` for code, `docs:` for documentation; never put the issue id of a planning-only PR in its title, branch or commit subject (Linear links and closes it on merge; happened on #689's first push). PRs ready for review, never draft; both review bots triaged and a ledger row appended; merges only on the user's explicit per-PR go-ahead while Greptile skips. Linear: In Progress on start, In Review with the PR, Done only with user approval; a merged PR linked to an issue flips it to Done by itself. Commit message template (HEREDOC, terminator `MSG`):

```bash
git commit -F - <<'MSG'
SIO-1654: move pi-coms into packages/pi-coms (git subtree, nested monitor deps)

<what and why>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Trust-policy edit on a prd `DevOpsAgentReadOnly` clobbers the analyzer | Medium | adopt mode merges statements; prd plan-only; per-account approval |
| Environment bleed (prd estate or spoke reaching the dev hub) | Medium | mandatory `env`; preflight refuses mismatches; analyzer errors on unknown suffix |
| Bundle from a workspace subtree resolves deps differently | Medium | standalone lockfile in staging; smoke a dev host first |
| Laptop console install pulls the AWS SDK again | Low if nested stays nested | never move monitor deps into the manifest Pi reads |
| Portal credentials expire mid-deploy | High | idempotent per-account steps; preflight stops with the expired list |
| Inbox bodies or hub replies reach a prompt | Medium | structured fields only; tests assert no body text in the aggregator context |
| Greptile skips every review | Certain until SIO-1642 is fixed | merge only on explicit instruction |

## Out of scope

Replacing Pi on the spokes; a third analyzer graph (2c, deferred); live Agent Memory access from spokes; automatic refresh of portal credentials; hub protocol changes; gitagent `dependencies`, `extends`, `config/<env>.yaml` in the bridge.

## Related code references

`apps/web/src/lib/server/agent.ts:161-165` (two-graph precedent and its nine two-way sites); `packages/gitagent-bridge/src/shared-merge.ts:59` (shared context and skills merge); `packages/agent/src/action-tools/slack-notifier.ts:17-26` (action-tool config idiom); `packages/shared/src/agent-memory.ts:354` (env resolver idiom, no `.default()`); pi-coms `docs/integrations/incident-analyzer.md` (service principal contract), `docs/architecture/monitoring.md` (mailbox semantics), `deploy/token-admin.sh` (principal tokens), `deploy/accounts/eu-oit-dev/main.tf` (a spoke root to template from).

## Memory references

`feedback_one_codebase_pi_coms_in_monorepo`, `feedback_no_cross_environment_access`, `project_pi_fleet_gitagent_feasibility`, `reference_sio1635_pi_coms_hub_client_gotchas`, `reference_greptile_skips_docs_only_prs`, `reference_linear_pr_link_auto_transitions_to_done`, `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`, `feedback_repo_is_public_sanitize_before_commit`, `reference_agent_memory_backend_seam`, `reference_sio1347_skill_spec_gate`, `feedback_never_create_linear_done`, `feedback_no_direct_push_to_main`.
