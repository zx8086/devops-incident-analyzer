# Declarative schedules/*.yaml layer for cron-driven jobs

Date: 2026-08-01
Origin: [SIO-1358](https://linear.app/siobytes/issue/SIO-1358/migrate-hardcoded-buncron-jobs-to-a-unified-gitagent-styled-schedules), migrating the 3 hardcoded `Bun.cron` jobs to a GitAgent-styled declarative layer.

## Problem

The repo had 3 hardcoded, hand-wired `Bun.cron` jobs registered directly in `apps/web/src/lib/server/agent.ts`:

1. `iac-reconcile-cron.ts` (SIO-1005) -- `*/30 * * * *`, reconciles proposed elastic-iac memory facts to terminal state via `reconcileAll()`.
2. `kg-topology-cron.ts` (SIO-1104/5a) -- `0 * * * *`, sweeps live topology into the KG via `runTopologySweep()`.
3. `purge-cron.ts` (SIO-1135) -- `0 3 * * *`, purges stale uncurated `Incident` rows via `runUncuratedPurgeSweep()`.

Each file independently re-implemented the same Bun/Node runtime split (`Bun.cron` under Bun; `setInterval` fallback under Node/Vite dev, SIO-1021), a `sweeping` re-entrancy guard emulating Bun.cron's no-overlap guarantee, and its own `scheduleToIntervalMs` cron-to-ms translator. Cadence and enablement lived in a mix of env vars (`IAC_RECONCILE_CRON_SCHEDULE`, `KG_TOPOLOGY_CRON_ENABLED`/`_SCHEDULE`, `KG_PURGE_CRON_ENABLED`/`_SCHEDULE`, the last pair undocumented in `.env.example`) that were unrelated to the repo's own declarative gitagent conventions.

## What "GitAgent-styled" means here

Verified live against [gitagent.sh/docs/schedules](https://gitagent.sh/docs/schedules) (do not assume from memory -- the docs page is a JS-rendered SPA and cannot be read via a plain HTTP fetch):

```yaml
# schedules/daily-standup.yaml (repeat)
id: daily-standup
prompt: "Summarize git commits from the last 24 hours and list open tasks"
cron: "0 9 * * 1-5"
mode: repeat
enabled: true
```
```yaml
# schedules/quarterly-review.yaml (one-time)
id: quarterly-review
prompt: "Generate Q1 performance report"
mode: once
runAt: "2026-04-01T09:00:00Z"
enabled: true
```

Fields: `id`, `prompt`, `cron` (mode `repeat`, default) or `runAt` (mode `once`), `mode`, `enabled`. Files live flat under one `schedules/` directory, version-controlled. There is no `agent:` field -- the spec assumes a single agent per repo, so a schedule just runs "the agent" against `prompt`. It's explicitly prompt/LLM-run-oriented ("Automate agent runs on a cron schedule").

This repo is multi-agent, and none of the 3 existing jobs are LLM prompts -- they're deterministic function calls. Splitting cron-driven work into two systems (a `schedules/` dir for future prompts, plus a separate mechanism for deterministic sweeps) would mean two places to check what's scheduled. Instead: **one `schedules/` directory, one scheduler**, dispatching by target kind:
- `workflow: <name>` -- runs a declared `workflows/*.yaml` via `runWorkflow()`. Used by all 3 migrated jobs today.
- `prompt: "..."` (+ optional `agent: <name>`, since our repo is multi-agent) -- reserved for a future LLM-invocation schedule. Parses today; the scheduler skips it with a warning until a prompt-dispatch handler is wired.

### Non-goal: the existing `WorkflowTriggerSchema` stub

`packages/gitagent-bridge/src/workflow.ts` already has `WorkflowTriggerSchema` parsing `triggers: [{ type: "schedule", cron: "..." }]` on any `workflows/*.yaml` (SIO-848). `packages/skillflow/src/triggers.ts::shouldTrigger()` explicitly defers it: `// schedule triggers are not evaluated here (no scheduler yet)`. This migration does **not** build on that stub -- a schedule trigger buried inside whichever agent owns a given workflow is the scattered shape this design avoids (no single place to see everything that's cron-driven). The stub is left as-is; it's a candidate for later removal as dead code, but that's out of scope here.

## Design

### 1. Top-level `schedules/` directory

`schedules/iac-reconcile-sweep.yaml`, `schedules/kg-topology-sweep.yaml`, `schedules/kg-purge-sweep.yaml` at the repo root (sibling to `agents/`, `packages/`, `apps/`), each with `id`, `mode`, `cron`, `enabled`, `workflow:`.

### 2. Schema + loader: `packages/gitagent-bridge/src/schedule.ts`

`ScheduleDefSchema` (zod, `.strict()`, with a `superRefine` enforcing exactly one of `workflow`/`prompt` and the mode-matching `cron`/`runAt` pair). `loadSchedules(rootDir, onError?)` reads every `schedules/*.yaml`, tolerant of malformed files: a bad file logs (via `onError`) and is skipped, never throws -- unlike `loadWorkflows()`, which throws on a malformed workflow (CI-fail-loud is appropriate there; one broken schedule must never take every other schedule down at boot).

### 3. Scheduler: `packages/skillflow/src/scheduler.ts`

`registerSchedules(schedules, workflows, handlers)` is the single generalized version of the boilerplate previously tripled across the 3 cron files:
- Skip `enabled: false`.
- `mode: "once"` -> a single `setTimeout` fire at `runAt`, unref'd.
- `mode: "repeat"` -> `Bun.cron` under Bun, `setInterval` fallback under Node (SIO-1021 pattern), each with its own `sweeping` re-entrancy guard.
- Canonical `scheduleToIntervalMs` (superset of the 3 old versions: minute-step, every-minute, fixed-minute-of-hour).
- Per-schedule try/catch/log; a bad cron expression or an unresolvable target skips just that one schedule, never blocks boot.
- A `workflow:` target must resolve to a workflow with exactly one `node:`-kind step; the scheduler runs it through the real `runWorkflow()` executor (tracing span, consistent result shape) rather than calling the sweep function bare -- the same pattern already proven in production by `packages/agent/src/resolve-identifiers-workflow-handlers.ts` (SIO-1353/1354). Multi-step scheduled workflows are out of scope: skipped with a warning, never partially run.

### 4. One-step workflow files

Each schedule's `workflow:` names a one-step `node:` workflow, placed with its owning agent per the existing convention: `agents/elastic-iac/workflows/reconcile-sweep.yaml`, `agents/incident-analyzer/workflows/kg-topology-sweep.yaml`, `agents/incident-analyzer/workflows/kg-purge-sweep.yaml`. These carry `triggers: [{ type: manual }]` (so they're also directly runnable, e.g. for testing) but no schedule-type trigger -- the `schedules/*.yaml` entry is what turns cron on.

### 5. Wiring

`apps/web/src/lib/server/schedules.ts` replaces the 3 deleted cron files (`iac-reconcile-cron.ts`, `kg-topology-cron.ts`, `purge-cron.ts`). It loads `schedules/*.yaml` + the relevant `workflows/*.yaml`, binds each workflow's `node:` target to the sweep function it already called (`reconcileAll`, `runTopologySweep`, `runUncuratedPurgeSweep`), filters out any schedule whose backend precondition isn't met, and calls `registerSchedules`. `startSchedules()` is called once from `agent.ts` in place of the 3 old `start*Cron()` calls.

`apps/web` has no direct `@devops-agent/skillflow` dependency; `registerSchedules`/`ScheduleHandlers` are re-exported through `packages/agent/src/index.ts` (same pattern as the existing SIO-1134 knowledge-graph re-export: "apps/web has no direct X dependency -- access goes through here").

### KISS: one source of truth for cadence AND enablement

Each schedule's cadence and on/off state live ONLY in its `schedules/<id>.yaml` file. No env-var override for either:
- Cadence: `IAC_RECONCILE_CRON_SCHEDULE`, `KG_TOPOLOGY_CRON_SCHEDULE`, `KG_PURGE_CRON_SCHEDULE` -- **removed**.
- Enablement: `KG_TOPOLOGY_CRON_ENABLED`, `KG_PURGE_CRON_ENABLED` -- **removed**. `enabled: true/false` in the YAML is the one human-editable control.

Backend/dependency availability (does a KG store exist to write to?) is NOT a second on/off switch -- it's a precondition the scheduler checks silently at registration time, using the existing `KNOWLEDGE_GRAPH_ENABLED` / `LIVE_MEMORY_BACKEND` (which describe what's configured, not whether this specific schedule should run). `topologyCronEnabled()` (`packages/agent/src/kg-topology.ts`) and `purgeCronEnabled()` (`packages/agent/src/kg-retention.ts`) were refactored to drop their `*_CRON_ENABLED` half and become pure backend-availability checks (`isKnowledgeGraphEnabled(env)`); this also fixed an inconsistency where `runTopologySweep()` internally self-guarded on the OLD `topologyCronEnabled()` (including the cron-only flag), which would have blocked a manual/workflow-triggered run outside the scheduler even when the KG backend was fully configured. `reconcileEnabled()` (`packages/agent/src/iac/reconcile.ts`) was already backend-only (`selectedBackend() === "agent-memory" || isKnowledgeGraphEnabled()`) and needed no change.

**This is a breaking config change.** Any deployment currently tuning cadence or enablement via the 5 removed env vars must switch to editing the corresponding `schedules/<id>.yaml`.

## Files changed

| File | Change |
|---|---|
| `packages/gitagent-bridge/src/schedule.ts` (new) | `ScheduleDefSchema` + `loadSchedules()` |
| `packages/gitagent-bridge/src/index.ts` | Export new symbols |
| `packages/skillflow/src/scheduler.ts` (new) | `registerSchedules()`, canonical `scheduleToIntervalMs()` |
| `packages/skillflow/src/index.ts` | Export new symbols |
| `packages/agent/src/index.ts` | Re-export `registerSchedules`/`ScheduleHandlers`/`RegisteredSchedule` (apps/web has no direct skillflow dep) |
| `packages/agent/src/kg-topology.ts` | `topologyCronEnabled()` drops its `KG_TOPOLOGY_CRON_ENABLED` half |
| `packages/agent/src/kg-retention.ts` | `purgeCronEnabled()` drops its `KG_PURGE_CRON_ENABLED` half |
| `schedules/iac-reconcile-sweep.yaml`, `kg-topology-sweep.yaml`, `kg-purge-sweep.yaml` (new) | The 3 schedules |
| `agents/elastic-iac/workflows/reconcile-sweep.yaml`, `agents/incident-analyzer/workflows/{kg-topology,kg-purge}-sweep.yaml` (new) | One-step `node:` workflows |
| `apps/web/src/lib/server/schedules.ts` (new) | Loader + registration, replaces the 3 deleted cron files |
| `apps/web/src/lib/server/agent.ts` | Replace 3 `start*Cron()` calls with 1 `startSchedules()` |
| `apps/web/src/lib/server/{iac-reconcile,kg-topology,purge}-cron.ts` (deleted) | Superseded |
| `.env.example` | Removed the 5 vars listed above; added `KG_UNCURATED_RETENTION_DAYS` (pre-existing undocumented gap) |
| `docs/configuration/environment-variables.md`, `docs/architecture/knowledge-graph.md` | Updated to describe the schedule layer |

## Verification

```bash
bun run typecheck
bun run lint
bun run test
bun run --filter '@devops-agent/gitagent-bridge' test
bun run --filter '@devops-agent/skillflow' test
bun run --filter '@devops-agent/agent' test
bun run --filter '@devops-agent/web' test
```

Manual:
1. `schedules/kg-topology-sweep.yaml` with `enabled: true` + `KNOWLEDGE_GRAPH_ENABLED=true` -> schedule registers at the expected cadence.
2. `enabled: false` -> skipped as disabled.
3. `enabled: true` without `KNOWLEDGE_GRAPH_ENABLED` -> skipped for the missing backend precondition.
4. A short cron in the YAML actually fires and logs completion, proving the YAML-declared schedule reaches a real `Bun.cron` registration end-to-end.
5. `/health` still reports correctly.
6. Zero remaining references to the 5 removed env vars repo-wide (docs, code, `.env.example`).
