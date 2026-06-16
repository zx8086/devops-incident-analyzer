# HANDOFF — SIO-913 follow-up: repo-side "all-agents" selector gap (found by live smoke-test)

- **Date:** 2026-06-16
- **Ticket:** [SIO-913](https://linear.app/siobytes/issue/SIO-913) (parent [SIO-911](https://linear.app/siobytes/issue/SIO-911)). Agent side merged (PR #207 `65b151a`); repo side merged (elastic-iac MR !146 `628cfd6`). **This is a follow-up bug, not the original feature.**
- **Target repo for the fix:** `observability-elastic-iac` (gitlab.com `pvhcorp/dhco/observability/observability-elastic-iac`, id 82850717). Local checkout: `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/`.
- **Suggested branch (in elastic-iac):** `fix/sio-913-fleet-upgrade-all-agents-default`

## TL;DR

A live preview smoke-test (`POST /api/agent/stream` → "upgrade the Fleet agents on gl-testing to 9.4.2") drove the full agent→CI round-trip correctly, but the **preview CI job failed** with:

```
ERROR: exactly one of --selector / --policy / --agent-ids is required
```

Root cause: `scripts/fleet-bulk-upgrade.sh` **hard-requires a selector** (one of `--selector`/`--policy`/`--agent-ids`), but the agent's "upgrade ALL agents" request sends **none** (only `DEPLOYMENT` + `VERSION`). The CI job passes `${SELECTOR:+--selector=...}` which expands to nothing when `SELECTOR` is unset, so the script aborts before producing `fleet-upgrade-report.json`.

The agent handled it gracefully (no crash; the user saw *"Fleet-upgrade preview for gl-testing could not be completed: produced no report"*), but the round-trip can't succeed until the repo supports an **all-agents** preview/apply.

Fix (chosen): **repo-side** — default to ALL enrolled agents when no selector is supplied. The agent side stays as-is (it intentionally omits SELECTOR for "all agents").

## Evidence (exact lines)

**The failure** — pipeline `2603694156` (status `success` because of `allow_failure: exit_codes:[2]`), job `fleet-upgrade-preview-on-demand` = **failed**, trace line 25:
```
ERROR: exactly one of --selector / --policy / --agent-ids is required
...
cat: can't open 'fleet-upgrade-report.json': No such file or directory
----- exit code: 2 -----
WARNING: fleet-upgrade-report.json: no matching files.
```

**The script's selector requirement** — `scripts/fleet-bulk-upgrade.sh` (current origin/main):
```bash
# (~line 177, in validate args, full/preview flow)
selector_count=0
[[ -n "$SELECTOR"  ]] && selector_count=$((selector_count+1))
[[ -n "$POLICY"    ]] && selector_count=$((selector_count+1))
[[ -n "$AGENT_IDS" ]] && selector_count=$((selector_count+1))
if [[ "$selector_count" -ne 1 ]]; then
  echo "ERROR: exactly one of --selector / --policy / --agent-ids is required" >&2
  ... usage; exit 2
fi
```
The count is then `GET /api/fleet/agents?kuery=$SELECTOR&perPage=0` (`.total`), and the `bulk_upgrade` body uses `agents: <kuery-or-id-array>`.

**The CI invocation** — `.gitlab-ci.yml` `fleet-upgrade-preview-on-demand` (~line 523):
```yaml
bash "$CI_PROJECT_DIR/scripts/fleet-bulk-upgrade.sh" \
  --deployment="$DEPLOYMENT" --version="$VERSION" \
  ${SELECTOR:+--selector="$SELECTOR"} \
  ${POLICY:+--policy="$POLICY"} \
  ...
  --preview-only --report-file fleet-upgrade-report.json
```
`${SELECTOR:+...}` → empty when SELECTOR unset → no selector reaches the script. (Arg parsing itself is fine: lines 129-132 split `--opt=value`.)

**The agent side (intentional, do NOT change):** `gitlab_trigger_fleet_upgrade_preview` sends only `DEPLOYMENT` + `VERSION` (+ optional `ROLLOUT_SECONDS`/`SELECTOR`). The user's request was "upgrade ALL agents", so omitting SELECTOR is correct.

## The fix (repo-side, step-by-step)

In `scripts/fleet-bulk-upgrade.sh`, change the selector requirement from "exactly one" to "at most one; default to all enrolled agents when none given" — for the preview/upgrade flow only (NOT `--status`/`--verify`, which take an actionId).

1. Replace the `selector_count -ne 1` hard error with:
   ```bash
   if [[ "$selector_count" -gt 1 ]]; then
     echo "ERROR: at most one of --selector / --policy / --agent-ids" >&2
     usage; exit 2
   fi
   if [[ "$selector_count" -eq 0 ]]; then
     # SIO-913: no selector => ALL enrolled agents (the agent's "upgrade all agents" path).
     SELECTOR="$ALL_AGENTS_KUERY"
   fi
   ```
2. Define `ALL_AGENTS_KUERY` as a match-all that BOTH the count endpoint (`/api/fleet/agents?kuery=`) AND `bulk_upgrade`'s `agents` field accept. **VERIFY against the live Fleet API before committing** — candidate forms (pick the one that resolves the full active-agent count on gl-testing with zero 400s):
   - empty string `""` (Fleet returns all agents for an empty kuery on the count endpoint), with the `bulk_upgrade` body using `agents: "*"` when SELECTOR is the all-agents sentinel; OR
   - a wildcard KQL such as `status:*` or `active:true`.
   The cleanest is likely: keep the count kuery empty (all), and special-case the POST body to send `agents: "*"` (Fleet's documented "all agents" form) when the all-agents sentinel is active. Confirm the exact accepted form with a manual curl (see Verification).
3. The `selector` field in `fleet-upgrade-report/v1` should reflect what was used (e.g. `"*"` or `"(all enrolled agents)"`) so the agent's preview card is truthful. The agent's `parseFleetUpgradeReport` reads `selector` as a plain string — any value is fine.
4. Respect `--max-agents` (default 500): an all-agents upgrade on a big deployment will exceed it. The existing over-cap error path already emits a report with `error/error_reason` — the agent surfaces that. Consider a higher CI default for the fleet jobs, or document that `MAX_AGENTS` must be raised for fleet-wide upgrades.

## Verification (repo side)

1. Local dry-run, all-agents preview on the sandbox:
   ```bash
   cd ~/Documents/Claude/Projects/Elastic\ Infrastructure\ Management\ IaC
   bash scripts/fleet-bulk-upgrade.sh --deployment gl-testing --version 9.4.2 --preview-only --report-file /tmp/r.json
   jq '{mode, resolved_count, version_available, selector, upgradeable_crosstab, error}' /tmp/r.json
   ```
   Expect: `mode:"preview"`, `resolved_count` > 0 (gl-testing's enrolled agents), `version_available:true`, `error:null`, exit 0, zero writes.
2. Manual Fleet count probe to confirm the all-agents kuery (token + endpoint from `environments/gl-testing/.../local.tfvars` — never echo the key):
   ```bash
   curl -fsS -H "Authorization: ApiKey $KEY" -H "kbn-xsrf: true" \
     "$KIBANA/api/fleet/agents?kuery=&perPage=0" | jq .total   # all agents
   ```
3. Trigger the preview pipeline via the GitLab API and confirm the `fleet-upgrade-report.json` artifact uploads with `resolved_count` populated:
   ```bash
   curl -s -X POST -H "PRIVATE-TOKEN: $PAT" \
     "https://gitlab.com/api/v4/projects/82850717/pipeline" \
     -d 'ref=main' -d 'variables[][key]=FLEET_UPGRADE_PREVIEW' -d 'variables[][value]=true' \
     -d 'variables[][key]=DEPLOYMENT' -d 'variables[][value]=gl-testing' \
     -d 'variables[][key]=VERSION' -d 'variables[][value]=9.4.2'
   ```

## Then: re-run the agent smoke-test to close SIO-913

After the repo fix merges, re-run (no agent change needed):
```bash
curl -s -N -X POST http://localhost:5173/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"elastic-iac","messages":[{"role":"user","content":"upgrade the Fleet agents on gl-testing to 9.4.2"}]}'
```
Expect a `fleet_upgrade_preview_report` SSE event with a real `resolvedCount` + `crosstab`, then the operator approval gate (`fleet_upgrade_choice` interrupt) — NOT "produced no report". Only then mark SIO-913 Done. (Cold-restart the web + elastic-iac MCP servers from a checkout at the merged main first — see note below.)

## Note: server staleness (bit this verification)

The running dev servers were started before the SIO-912/913 merges and ran STALE code (the IaC MCP on :9086 still exposed the SIO-912-deleted `git_*`/`terraform_validate` tools and none of the fleet tools). Had to `git pull` the main checkout to `65b151a` and cold-restart `bun run dev` (memory `reference_bun_hot_does_not_reresolve_modules` / `reference_agent_knowledge_cached_per_process`). After restart, the live tools/list confirmed all 4 fleet tools present and the deleted tools gone. **Always cold-restart from a merged-main checkout before a cross-repo live test.**

## Out of scope
- Agent-side changes (the agent's omit-SELECTOR-for-all-agents behavior is correct).
- The live APPLY path (do not run a live bulk_upgrade without operator sign-off).

## Memory references
`reference_fleet_upgrade_subflow` (the contract + sub-flow), `reference_driftcheck_main_pipeline_permission` (runner/timeout), `reference_bun_hot_does_not_reresolve_modules`, `project_elastic_iac_agent_proposes_gitops_disposes`.
