# Handover: `deployments` stack drift-check planError

## Header block

- **Date**: 2026-06-04 (updated 2026-06-04 with the Option-B resolution — see "Resolution" below)
- **Ticket**: [SIO-904](https://linear.app/siobytes/issue/SIO-904) (Option B implemented, PR #204, In Review) + [SIO-905](https://linear.app/siobytes/issue/SIO-905) (the real root cause — elastic-iac CI missing EC credentials — cross-team follow-up). Related context ticket: [SIO-903](https://linear.app/siobytes/issue/SIO-903) (the UI progress-pill fix from the same drift run; merged, PR #203).
- **Related tickets**: [SIO-887](https://linear.app/siobytes/issue/SIO-887) (introduced the planError classification), [SIO-878](https://linear.app/siobytes/issue/SIO-878) (`classifyPipelineFailure`), [SIO-891](https://linear.app/siobytes/issue/SIO-891) / [SIO-892](https://linear.app/siobytes/issue/SIO-892) / [SIO-893](https://linear.app/siobytes/issue/SIO-893) (gitlab.com migration + runner/permission chain that this stack is sensitive to).
- **Repo state**: branch `main`, HEAD `15ee1ed` ("SIO-903: add IaC drift sub-flow nodes to StreamingProgress IAC_NODES (#203)").
- **Suggested branch (only if a code change lands here)**: `sio-XXX-deployments-planerror-diagnostics`.
- **GitOps target repo**: `pvhcorp/dhco/observability/observability-elastic-iac` on `https://gitlab.com` (project id `82850717`). The drift-check CI lives THERE; this repo only orchestrates it.

## Resolution (added 2026-06-04 — read this first)

Option B was implemented (SIO-904, PR #204) and the real root cause was found via a live test.

1. **Option B shipped** — the MCP now greps the **full** job trace for the state-lock signature (new pure `traceHasStateLock()` in `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`) and returns a structured `stateLocked` boolean; the failure-log tail was bumped 4000 → 16000 bytes (`ELASTIC_IAC_DRIFT_FAIL_LOG_TAIL_BYTES`). Agent side: `parseDriftCheckResult` surfaces it and `classifyPipelineFailure(log, stateLocked?)` prefers it over the substring scan (fallback intact). So a lock whose signature scrolled out of the tail is no longer misclassified.

2. **The actual cause of THIS planError was NOT a state lock.** Cold-restarted the MCP and called `gitlab_get_drift_check_result` against the original failed pipeline `2577636962` (job `14702757586`, `plan:eu-b2b:deployments`). Result: `status: failed`, `stateLocked: false` (correctly — no lock signature anywhere in the full trace), and the larger tail finally captured the real error the old 4000-byte tail had been hiding:

   ```
   Error: Unable to create api Client config
     with provider["registry.terraform.io/elastic/ec"], on providers.tf line 4
   authwriter: one of apikey or username and password must be specified
   ```

   i.e. the `deployments` drift-check plan job is missing its **EC (Elastic Cloud) provider credentials** in the elastic-iac CI. A genuine credential/CI error, not lock contention. Tracked as **[SIO-905](https://linear.app/siobytes/issue/SIO-905)** for the elastic-iac repo owner (set/scope `EC_API_KEY` for the drift-check job). The SIO-904 behavior is exactly right here: only a real lock flips `stateLocked` true; a genuine plan error keeps the generic "review the job log" message AND now surfaces the real cause in the tail.

The TL;DR and investigation below are preserved as the original record; note the "most often state-lock" framing was the *prior assumption* — for `eu-b2b` the live cause turned out to be missing EC credentials (SIO-905).

## TL;DR

When a user runs an IaC drift audit on a deployment (e.g. "check eu-b2b for drift"), the `deployments` stack frequently comes back as a planError: `deployments (Drift-check pipeline failed. The plan job failed for another reason -- review the job log.)`. This is **diagnostics working as designed, not an agent bug**: the `deployments` stack shares one Terraform state across all ~10 clusters in a deployment, so its `drift-check-on-demand` CI pipeline genuinely fails on GitLab (most often state-lock contention from a concurrent MR/apply, sometimes a real plan error). The agent polls the pipeline, sees `status: "failed"` with no report, fetches the last 4000 bytes of the job trace, and — when that tail does not contain a recognizable state-lock signature — falls through to the generic "review the job log" hint. **Success = the user understands the cause is in the GitLab job log, and (optionally) we improve detection so the common state-lock case stops surfacing as the scary generic message.** No code change is strictly required; any change that does land is most valuable on the *detection* side (`classifyPipelineFailure`) and on the elastic-iac CI repo.

## Context — how this ticket came to be

On 2026-06-04 the user ran two drift audits on `eu-b2b` (runIds `a543a656…` and `6d92265d…`) and asked two questions: (1) why the `deployments` planError, and (2) why the UI progress pills had disappeared. (2) was a real regression and is fixed (SIO-903, PR #203, merged `15ee1ed`). (1) was investigated and found to be expected behavior — but it is confusing enough in the UI that it deserves a written record and a decision on whether to improve the detection. This handover captures (1) so a fresh session can either explain it to a stakeholder or implement a detection improvement without re-deriving the whole flow.

The drift flow itself is the SIO-882 per-stack drift-detection + reconcile feature (see `docs/architecture/agent-pipeline.md` for the pipeline, and memory `reference_synthetics_drift_subflow` / `reference_driftcheck_main_pipeline_permission` for prior gotchas).

## Where the bodies are buried

### Agent side — where planError is produced

`packages/agent/src/iac/nodes.ts` — `driftCheckStack()` (the per-stack worker called by `detectDrift`). The relevant non-success branch, lines **2461-2481**:

```ts
if (result.status !== "success" || !result.report) {
  // SIO-887: distinguish a real failure (classify the job trace tail -- state-lock vs plan
  // error) from a pipeline that simply did not reach terminal within the poll budget...
  const reason =
    result.status === "failed" || result.status === "canceled"
      ? `Drift-check pipeline ${result.status}. ${classifyPipelineFailure(result.failureLog)}`
      : result.status !== "success"
        ? "Drift-check did not finish within the poll budget (possible state-lock contention); use Re-check to retry."
        : "The drift-check produced no report.";
  log.warn({ deployment, stack, pipelineId: trig.pipelineId, status: result.status, hasReport: Boolean(result.report) },
    "iac drift: drift-check not authoritative (planError)");
  ...
  return { ...base, planError: true, planErrorReason: reason };
}
```

The classifier, `packages/agent/src/iac/nodes.ts:1132-1143`:

```ts
// SIO-878: classify a failed plan job's log into a human-readable cause hint. The
// deployments stack shares one Terraform state across all 10 clusters, so concurrent
// MRs contend on a single state lock -- the most common, recoverable failure. (Pure.)
export function classifyPipelineFailure(planLog: string): string {
  const lower = planLog.toLowerCase();
  if (lower.includes("error acquiring the state lock") || lower.includes("already locked")) {
    return ( "Likely cause: a Terraform state-lock on the shared deployments stack ..." );
  }
  if (!planLog || planLog.startsWith("[")) return "The plan job log was not available to diagnose the failure.";
  return "The plan job failed for another reason -- review the job log.";  // <-- the message the user saw
}
```

**This generic branch (line 1142) is exactly what fired.** It means: pipeline failed, and the 4000-byte trace tail did NOT contain `error acquiring the state lock` / `already locked`, and was non-empty (so not the "log unavailable" branch either).

### MCP side — where the failure log comes from

`packages/mcp-server-elastic-iac/src/tools/gitlab.ts`:

- `DRIFT_FAIL_LOG_TAIL_BYTES = 4000` — line **367**. Only the last 4000 bytes of the job trace are returned. **This is the prime suspect for the misclassification**: if the `Error: Error acquiring the state lock` line is more than 4000 bytes from the end of the trace (Terraform prints a lot after the lock error — retries, the full lock-info block, CI teardown), the signature scrolls out of the tail and `classifyPipelineFailure` never sees it.
- Failure-trace fetch — lines **434-441**: `GET {base}/api/v4/projects/{project}/jobs/{jobId}/trace`, sliced to the last 4000 bytes, returned as `failureLog`.
- Terminal-status poll — lines **390-408**; `isTerminal` covers `success|failed|canceled|skipped` (line 368).
- Report artifact — lines **409-428**: `GET .../jobs/{jobId}/artifacts/drift-report.json`; CI job name from `ELASTIC_IAC_DRIFT_JOB_NAME ?? "drift-check-on-demand"` (line 409). Plan-job naming is `plan:<deployment>:<stack>` (see `gitlab.test.ts:75-77`).
- Return shape — line **458**: `{ pipelineId, jobId, status, report, ...(failureLog && { failureLog }) }`.

`gitlab_trigger_drift_check` (same file): sets pipeline variables `DRIFT_CHECK=true`, `STACK`, `DEPLOYMENT` (lines 332-336) on ref `main` (line 323, `ELASTIC_IAC_DRIFT_PIPELINE_REF ?? "main"`). A **409 at trigger time** is mapped to `status: "locked"` (lines 339-350) — note this is the only lock path the agent treats as a clean "Apply in progress" (handled separately at `nodes.ts:2438-2452`). A lock that occurs *during the plan job* (after the pipeline started) does NOT come back as 409 — it comes back as a failed pipeline, and that is the case in scope here.

### From the runtime log (2026-06-04, runId `a543a656…`)

```
iac drift: pipeline triggered ... stack:"deployments" pipelineId:2577636962
iac drift: drift-check not authoritative (planError) ... status:"failed" hasReport:false
   (the MCP fetched failureBytes:4000 for this job)
iac drift: audit complete ... planError:["deployments"]
```

So: pipeline `2577636962` reached `failed`, 4000 bytes of trace were captured, and the classifier returned the generic message.

## The fix (decision tree, step-by-step)

There are three independent things a follow-up session can do. **None is strictly required** — option A may be the whole job.

### Option A — Explain only (no code). Most likely the right call.
1. Open the failed job in GitLab: pipeline `2577636962` (or the current failing one), job `plan:eu-b2b:deployments`, in `pvhcorp/dhco/observability/observability-elastic-iac`.
2. Read the trace. Expect one of:
   - `Error: Error acquiring the state lock` → a concurrent `deployments` MR/apply held the lock. Recoverable: wait for the holder to finish, or force-unlock in GitLab, then Re-check. (The shared state across all clusters makes this the common case.)
   - A genuine Terraform plan error (provider auth, a malformed `_deployments/*.json`, an EC API error) → fix at source / in the elastic-iac repo.
3. Report which it was. Done.

### Option B — Improve detection (small change in THIS repo).
The misclassification is "state lock present, but signature scrolled out of the 4000-byte tail." Two cheap, low-risk levers, in `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`:
- Bump `DRIFT_FAIL_LOG_TAIL_BYTES` (line 367) to e.g. `16000`, OR fetch the trace and grep the WHOLE body for the lock signature (return a boolean `stateLocked` field) rather than only tailing it. Returning a structured `stateLocked: true` is cleaner than widening the tail and re-grepping downstream.
- If a structured field is added, update `classifyPipelineFailure` (`nodes.ts:1132`) to prefer it over substring-matching the tail, and update `driftCheckStack` (`nodes.ts:2466`) to pass it through.
- Add/adjust unit tests: `packages/agent/src/iac/*.test.ts` for `classifyPipelineFailure`, and `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts` for the trace-grep path. **Watch the kafka-style tool-count canaries are NOT relevant here, but the elastic-iac live-API tests in gitlab.test.ts may be pre-existing-red — stash-and-compare (memory `reference_main_preexisting_test_lint_failures`).**

### Option C — Reduce contention (elastic-iac CI repo, NOT this codebase).
Serialize `deployments` drift-checks (CI `resource_group:` on the plan job) or split the monolithic shared state. Out of scope for this repo; raise with whoever owns `observability-elastic-iac`.

## Verification

For any code change (Option B):

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint && bun run test
# Targeted:
bun run --filter '@devops-agent/agent' test
bun run --filter '@devops-agent/mcp-server-elastic-iac' test
```

Manual end-to-end probe (proves the actual classification on a real failed pipeline):

```bash
# 1. Confirm the failure is reproducible and read the live trace tail the agent sees.
#    Restart the elastic-iac MCP cold first (config is process-cached): lsof -i :9086 then restart.
# 2. Drive a drift audit via the agent stream and watch the deployments outcome:
curl -N -X POST http://localhost:5173/api/agent/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"check eu-b2b for drift"}],"dataSources":[],"agentName":"elastic-iac"}' \
  | grep -E 'deployments|planError|state lock'
```

Expected after an Option-B fix on a state-locked run: the `deployments` line reads the state-lock hint (recoverable / Re-check) instead of "failed for another reason." On a genuine plan error it should still read the generic message — that is correct.

## Files to modify (only if Option B is chosen)

| File | Change |
|------|--------|
| `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` | Grep the full trace for the lock signature and return `stateLocked`, or raise `DRIFT_FAIL_LOG_TAIL_BYTES` (line 367) |
| `packages/agent/src/iac/nodes.ts` | `classifyPipelineFailure` (line 1132) prefer the structured flag; `driftCheckStack` (line 2466) pass it through |
| `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts` | Cover the new trace-grep / `stateLocked` path |
| `packages/agent/src/iac/*.test.ts` | Cover the classifier preferring the flag |

## Workflow

Branch off `main` BEFORE the first commit (`sio-XXX-...`); commit `SIO-XXX: message`; PR ready-for-review (never draft); In Progress → In Review → Done only with explicit user approval. Cold-restart the elastic-iac MCP after any config/tool change (process-cached). Commit message via HEREDOC ending with the `Co-Authored-By` trailer.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Widening the tail still misses the signature (Terraform prints lock-info far from EOF) | Medium | Grep the FULL trace body, don't just enlarge the tail |
| A "failed" pipeline is a real plan error, not a lock — must NOT be relabeled as recoverable | Medium | Only set `stateLocked` on a positive signature match; default stays generic |
| elastic-iac live-API tests in `gitlab.test.ts` are pre-existing red | Medium | Stash-and-compare against `main`; note in PR, don't fix unrelated (memory `reference_main_preexisting_test_lint_failures`) |
| MCP config is process-cached; editing without cold restart shows stale behavior | High | `lsof -i :9086`, kill, restart (memory `reference_agent_knowledge_cached_per_process` analogue) |
| `deployments` 409-at-trigger vs lock-during-plan are different paths | High | 409 → `status:"locked"` handled at `nodes.ts:2438`; this ticket is the during-plan case (`status:"failed"`) |

## Out of scope

- The SIO-903 UI progress-pill fix (done, merged).
- The synthetics `Skipped ... 0.json` message — separate, SIO-901 skip-on-unreadable working as designed.
- Restructuring the elastic-iac shared `deployments` Terraform state (Option C — different repo/owner).
- The gitlab.com migration runner/permission chain (SIO-891/892/893 — already resolved).

## Related code references (already-correct patterns)

- `packages/agent/src/iac/nodes.ts:2438-2452` — the 409 / `status:"locked"` clean-path (reference for how a recoverable lock is surfaced; contrast with the during-plan failure this ticket covers).
- `packages/mcp-server-elastic-iac/src/config.ts:129-130` — base URL + project resolution (`ELASTIC_IAC_GITLAB_BASE_URL`, `ELASTIC_IAC_GITLAB_PROJECT`).
- `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts:75-77` — plan-job naming `plan:<deployment>:<stack>`.

## Memory references

- `reference_driftcheck_main_pipeline_permission` — the 3-layer drift-check failure chain (Maintainer on protected `main`, runner tags, MCP tool timeout) that the deployments stack is also subject to.
- `reference_elastic_iac_migrated_to_gitlab_com` — gitlab.com migration + `ELASTIC_IAC_GITLAB_BASE_URL` landmine.
- `reference_synthetics_drift_subflow` — sibling drift sub-flow + CI contract (SIO-902).
- `project_elastic_iac_gitops_proposer_model` — the agent proposes via MR; CI owns plan/apply (so the failure is genuinely on the CI side).
- `reference_agent_knowledge_cached_per_process` — cold-restart requirement for elastic-iac changes.
- `reference_main_preexisting_test_lint_failures` — stash-and-compare before blaming your change for red tests.
