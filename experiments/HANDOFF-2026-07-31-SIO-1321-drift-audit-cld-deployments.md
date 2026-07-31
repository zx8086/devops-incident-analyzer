# Handover: drift audit + reconcile for eu-cld, ap-cld, us-cld (SIO-1321)

**Date**: 2026-07-31
**Ticket**: [SIO-1321](https://linear.app/siobytes/issue/SIO-1321/elastic-iac-drift-audit-reconcile-for-eu-cld-ap-cld-us-cld)
**Parent/related**: [SIO-1310](https://linear.app/siobytes/issue/SIO-1310/elastic-iac-per-request-scoped-live-drift-check-for-the-edited-stack) (merged, PR #554), blockers [SIO-1315](https://linear.app/siobytes/issue/SIO-1315/elastic-iac-reconcile-to-live-blocked-for-aggregatenested-layout), [SIO-1317](https://linear.app/siobytes/issue/SIO-1317/elastic-iac-guard-component-template-deletes-against-index-template), [SIO-1319](https://linear.app/siobytes/issue/SIO-1319/elastic-iac-reconcile-to-json-marker-merge-produced-a-no-op-child)
**Repo state**: main at or after `7a48a09f` (SIO-1310 merge); this doc committed on main
**Branch**: none needed in THIS repo — the work is operational (drive the running agent; MRs land in the remote GitOps repo on `agent/*` branches)
**Target repo**: `pvhcorp/dhco/observability/observability-elastic-iac` (gitlab.com, project id `82850717`)

## TL;DR

Run the per-stack live drift audit for eu-cld, ap-cld, and us-cld — the same procedure that
converged eu-b2b on 2026-07-31 — walk the reconcile gates with the operator, and converge what is
convergeable. Success = a full drift report per deployment (every stack assessed or its planError
explained), operator-approved MRs merged+applied for convergeable drift, and blocked items
attributed to their tickets. The eu-b2b pass took one working session and surfaced three reusable
defect classes (SIO-1315/1317/1319); expect the same classes here and do NOT rediscover them.

## Context — how this came to be

SIO-1310 (PR #554, merged 2026-07-31) closed the maker-lane live-parity gap: every elastic-iac
edit request now triggers a scoped CI drift check. The same session then ran the full eu-b2b
audit (7 drifted stacks found), walked the gates, and converged cluster-defaults, dataviews,
ingest-pipelines, and index-templates via MRs !363-!368 — hitting three systemic snags on the way,
each now ticketed. eu-cld, ap-cld, us-cld have never had this treatment. The full saga's memory
file is `reference_sio1310_edit_drift_check.md` (see Memory references).

## Prerequisites (verify before starting)

1. Web server on :5173 running CURRENT main (must include the SIO-1310 merge `7a48a09f`). If the
   dev server predates it, cold-restart (`bun run dev` from `apps/web`); `--hot` does not
   re-resolve workspace deps.
2. elastic-iac MCP on :9086 (check `lsof -nP -iTCP:9086 -sTCP:LISTEN`); its
   `ELASTIC_IAC_GITLAB_TOKEN` must be Maintainer on project 82850717 (drift-check triggers
   pipelines on protected main).
3. CI runner headroom: each audit fans ~15-20 plan pipelines (concurrency 4). Run ONE deployment
   at a time; under congestion stacks planError with "did not finish within the poll budget" —
   that is congestion, not drift.

## The procedure (verified end-to-end on eu-b2b)

### 1. Audit one deployment

```bash
curl -sS -X POST http://localhost:5173/api/agent/stream -H "Content-Type: application/json" \
  -d '{"agentName":"elastic-iac","messages":[{"role":"user","content":"Check eu-cld for drift"}],"threadId":"drift-audit-eucld-<date>"}' \
  --max-time 1800 -o /tmp/drift-eucld.sse
```

~10 min. The stream carries `iac_pipeline_progress` per stack, one `iac_drift_report`, then
pauses at the first `iac_reconcile_choice` gate. planError semantics: trigger-lock / failed
pipeline / poll timeout = stack NOT assessed (never a false "no drift"); drift-check job exit 42
in GitLab = drift FOUND (by design), not an infra failure.

### 2. Parse the stream — SSE events span MULTIPLE data: lines

Join `data:` frames until the blank-line delimiter before `json.loads`, or you will silently drop
gate/result events (this exact bug cost one wasted 20-pipeline round on eu-b2b):

```python
buf, evs = [], []
for line in open(path):
    if line.startswith("data:"): buf.append(line[5:].strip())
    elif not line.strip() and buf:
        try: evs.append(json.loads("".join(buf)))
        except Exception: pass
        buf = []
```

### 3. Walk the gates (operator decides per stack)

One direction per POST; the response carries the result + the NEXT gate. Persist every response
to a file. Key the direction off `gate["stack"]`, never off positional order:

```bash
curl -sS -X POST http://localhost:5173/api/agent/iac/resume -H "Content-Type: application/json" \
  -d '{"threadId":"<same threadId>","direction":"reconcile-to-json"}' --max-time 240
```

Directions: `reconcile-to-live` (write live values into repo JSON — only offered when
liveReconcilable), `reconcile-to-json` (marker MR re-asserting repo), `skip`. Skips emit NO
result event. Thread ends with `{"type":"done"}` + a per-stack summary message.

### 4. Direction guidance (from the eu-b2b pass)

- **Live AHEAD of repo** (e.g. integration versions newer live): reconcile-to-live adopts them.
  reconcile-to-json here would DOWNGRADE live at apply — do not.
- **Repo AHEAD of live** (merged-never-applied creates): reconcile-to-json, then merge + manual
  apply.
- **synthetics stack** source-hash drift: neither direction — that is a SYNTH_PUSH decision
  (separate flow, pushes repo->live).

## Known blockers — do NOT rediscover these

1. **SIO-1315 — reconcile-to-live BLOCKS on three stacks' layouts** (fail-safe, no writes):
   `security` (single aggregate `security.json` roles map), `agent-policies` (per-POLICY files,
   drift keys compose policy+integration), `fleet-integrations` (single aggregate
   `integrations.json`). Same layouts exist on every deployment. Until SIO-1315 lands, live-ahead
   drift on these three can only be reported, not adopted.
2. **SIO-1319 — reconcile-to-json marker MRs can generate a NO-OP child** ("No deployment/stack
   changes detected"). After ANY marker MR merges, VERIFY a plan/apply actually spawned:
   `gitlab_get_merge_commit_apply_result {sha: <full merge sha>}` (MCP :9086). Workaround that is
   PROVEN to map: a whitespace-only touch MR on a file under `environments/<dep>/<stack>/`
   (eu-b2b precedent: MR !368, one extra trailing newline -> `plan:eu-b2b:dataviews` with the
   pending creates).
3. **SIO-1317 — component-template deletes**: before proposing ANY delete of an
   `elasticstack_elasticsearch_component_template`, check which index templates compose it
   (`GET _index_template` via elastic MCP :9080 with `x-elastic-deployment: <dep>` header) — ES
   hard-rejects referenced deletes AFTER merge, wedging the stack (repo file gone, destroy
   forever failing) until a manual `terraform state rm`. Also: never declare repo overrides on
   `*@settings` templates whose live copy has `metadata.managed: true` (x-pack reasserts them);
   and when two index templates share a pattern, compare `priority` before reasoning about which
   hook wins (eu-b2b: stock `...querylog@template` prio 250 beat Fleet `...querylog` prio 200).
4. **index-templates stack JSON files must share an IDENTICAL attribute set** (Terraform map
   unification over `jsondecode`): keys `name, index_patterns, composed_of, priority,
   ignore_missing_component_templates, data_stream, settings` — `settings` as an OBJECT (use
   `{"index":{"lifecycle":{"name":...}}}` shape), not null/absent.
5. **Verify operator merges/applies via the API before rerunning an audit** — three times on
   eu-b2b a "merged and applied" had not landed (`GET /merge_requests/<iid>` state +
   `gitlab_get_merge_commit_apply_result`). An audit rerun without that check wastes ~20
   pipelines.
6. **The `state rm` recipe** (if a wedge happens anyway), from a checkout of the GitOps repo:
   `task init STACK=<stack> DEPLOYMENT=<dep>` then
   `cd stacks/<stack> && terraform state rm '<resource address>'`. State names are
   `<dep>-<stack>` in GitLab's HTTP backend. It does NOT work from the agent monorepo.

## Deployment-specific notes

- **us-cld**: the 9.4.4 version-drift saga (SIO-1196) is RESOLVED — live == repo == 9.4.4 since
  2026-07-24. If version drift reappears, use the version-upgrade three-way check attribution
  before touching anything.
- **deployments stack**: ONE shared Terraform state across all 10 clusters; its drift check can
  sit behind a state lock for up to ~30 min and applies for hours. Expect planErrors under lock;
  "Re-check" later rather than treating as failure.
- **eu-cld/ap-cld/us-cld monitor clusters** (`*-cld-monitor`) are separate deployments — out of
  scope here unless the operator extends.
- Each deployment's stack set is SPARSE (only dirs under `environments/<dep>/` exist; the
  `deployments` stack is added implicitly).

## eu-b2b end state (2026-07-31 ~19:00Z, for reference)

Converged: cluster-defaults create (!363 apply), ingest-pipelines (!364), dataviews 5 creates
(!368 touch MR after !365's marker no-op'd), index-templates `querylog-override` (!367).
Attempted & rolled forward: !366 (querylog @settings delete) half-applied — @custom created, ES
rejected the @settings delete (SIO-1317 discovery); remediated via the priority-300 override
template (!367) + a `terraform state rm` of the @settings resource (operator-run; if the final
audit still shows cluster-defaults drift, the state rm may need re-verification). Remaining known
eu-b2b tail: SIO-1315 stacks (agent-policies 2 live-ahead updates, security 6, fleet-integrations
3 + 1 create) and the synthetics push decision. The session's final confirmation audit was in
flight at handover time (thread `drift-final-eub2b-20260731`) — check its outcome or re-run.

## Verification

Baseline repo checks (no code changes expected in this repo; run once to confirm a healthy
checkout): `bun run typecheck && bun run lint && bun run test`

Per-deployment operational verification: the audit's drift report (all stacks assessed), MR plan
outputs read before merge (expected add/change/destroy counts stated in each MR description),
`gitlab_get_merge_commit_apply_result` returning `applyStatus: "success"` per merge, and a final
re-audit showing the converged stacks clean.

## Out of scope

- Fixing SIO-1315/1317/1319 themselves (each has its own ticket).
- SIO-1311 (stale docs), SIO-1312/1313 (synthetics add-to-source lane).
- Monitor-cluster deployments; nightly drift scheduling (deliberately not enabled).

## Related code references

- `packages/agent/src/iac/nodes.ts` — `detectDrift` (~9370), `driftCheckStack` (~9240),
  `reconcileGate` (~9530), `openReconcileMr` (~9050), `applyEditDriftCheck` (~6600, SIO-1310).
- `apps/web/src/routes/api/agent/iac/resume/+server.ts` — resume payload
  (`{threadId, direction|decision|answer|approve}` — exactly one).
- MCP write primitives (used for direct MRs when a workflow lacks a create path):
  `gitlab_create_branch`, `gitlab_commit_files` (atomic, actions create/update/delete),
  `gitlab_create_merge_request` (`source_branch`/`target_branch`, NOT `branch`).

## Memory references

`reference_sio1310_edit_drift_check` (the full saga: audit map, gate-walk recipes, SSE parsing
gotcha, querylog collision, wedge + state rm), `reference_driftcheck_main_pipeline_permission`
(Maintainer token + tool timeouts), `reference_synthetics_drift_subflow`,
`reference_worktree_web_server_replay_env` (server + curl recipes),
`reference_pr_merge_no_branch_protection_and_worktree_gh_quirk` (direct-to-main doc commits),
`reference_iac_hub`.
